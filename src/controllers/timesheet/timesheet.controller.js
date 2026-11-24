import TimesheetModel from '../../models/timesheet/timesheet.model.js';
import TimesheetLogModel from '../../models/history/timesheet-log.model.js';
import { calculateDurationFromTimes, formatDurationHHMMSS, calculateCommonTime, netTimeByDateFromTimesheets } from '../../utils/project.utils.js';
import { runInParallel, workerPool } from '../../utils/worker.utils.js';
import { broadcastTimesheetUpdate } from '../../config/socket.js';
import { writeAuditLog, pickChangedColumns, getUserIdFromReq, getUsernameFromReq } from '../../utils/audit.utils.js';
import { AppError, wrapController } from '../../middleware/error.middleware.js';
import { pool } from '../../config/db.js';
import { formatDurationHMS } from '../../utils/time.utils.js';
import {
    assertStopAfterStart,
    buildOverlapErrorMessage,
    findOverlappingEntry,
} from '../../utils/timesheetOverlap.utils.js';

const TIMESHEET_LOG_TRACKED_FIELDS = [
    'project_type',
    'project_code',
    'process_name',
    'project_by',
    'notes',
];

/** Parse HH:MM:SS (or H:MM:SS / HH:MM) duration to seconds. */
function durationToSeconds(value) {
    if (value == null || value === '' || value === '-' || value === 'Ongoing') {
        return 0;
    }
    const s = String(value).trim();
    const full = s.match(/^(\d+):(\d{2}):(\d{2})$/);
    if (full) {
        return (
            parseInt(full[1], 10) * 3600 +
            parseInt(full[2], 10) * 60 +
            parseInt(full[3], 10)
        );
    }
    const short = s.match(/^(\d+):(\d{2})$/);
    if (short) {
        return parseInt(short[1], 10) * 3600 + parseInt(short[2], 10) * 60;
    }
    return 0;
}

/** Prefer stored duration; else start/stop. */
function entryDurationSeconds(row) {
    const fromDuration = durationToSeconds(row.duration);
    if (fromDuration > 0) return fromDuration;

    const start = String(row.start_time ?? '').trim();
    const stop = String(row.stop_time ?? '').trim();
    if (!start || !stop || stop.toLowerCase() === 'ongoing') return 0;

    const dur = calculateDurationFromTimes(start, stop);
    return (dur.hours || 0) * 3600 + (dur.minutes || 0) * 60 + (dur.seconds || 0);
}

function formatEntryDuration(row) {
    const secs = entryDurationSeconds(row);
    if (secs > 0) return formatDurationHMS(secs);
    const raw = String(row.duration ?? '').trim();
    return raw || '00:00:00';
}

function normalizeIsoDate(value) {
    return TimesheetModel.toISODate(value);
}

function resolveMaxEndSecondsForDate(dateValue) {
    const iso = normalizeIsoDate(dateValue);
    if (!iso) return 86399;
    const now = new Date();
    const todayIso = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0'),
    ].join('-');
    if (iso !== todayIso) return 86399;
    return now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
}

async function assertNoTimesheetOverlap({
    date,
    userId,
    userName,
    startTime,
    stopTime,
    excludeId,
}) {
    const start = String(startTime ?? '').trim();
    if (!start) return;

    const isoDate = normalizeIsoDate(date);
    if (!isoDate) return;

    const entries = await TimesheetModel.findEntriesForUserOnDate({
        date: isoDate,
        userId,
        userName,
        excludeId,
    });

    const overlap = findOverlappingEntry(
        entries,
        { start_time: start, stop_time: stopTime },
        { excludeId, maxEndSeconds: resolveMaxEndSecondsForDate(isoDate) },
    );

    if (overlap) {
        throw new AppError(buildOverlapErrorMessage(overlap, startTime), 409);
    }
}

/**
 * Map a timesheet row to the worksheet entry shape used in max/all work responses.
 */
function mapWorksheetEntry(r) {
    return {
        id: r.id,
        project_code: String(r.project_code ?? '').trim() || 'OTHER',
        process_name: String(r.process_name ?? '').trim() || 'OTHER',
        start_time: r.start_time ?? null,
        stop_time: r.stop_time ?? null,
        duration: formatEntryDuration(r),
        project_by: String(r.project_by ?? '').trim() || null,
        notes: String(r.notes ?? '').trim() || null,
    };
}

/**
 * All work for one user on one date, grouped by project_code + process.
 * Each group: project_code, process, duration, entry_count, entries.
 */
function buildAllWorkForUserDay(rows) {
    const groups = new Map();

    for (const row of rows || []) {
        const project_code = String(row.project_code ?? '').trim() || 'OTHER';
        const process = String(row.process_name ?? '').trim() || 'OTHER';
        const key = `${project_code}\0${process}`;

        if (!groups.has(key)) {
            groups.set(key, {
                project_code,
                process,
                secs: 0,
                entries: [],
            });
        }

        const group = groups.get(key);
        group.secs += entryDurationSeconds(row);
        group.entries.push(mapWorksheetEntry(row));
    }

    return [...groups.values()]
        .map((group) => ({
            project_code: group.project_code,
            process: group.process,
            duration: formatDurationHMS(Math.max(0, group.secs)),
            entry_count: group.entries.length,
            entries: group.entries,
        }))
        .sort((a, b) => {
            const byProject = a.project_code.localeCompare(
                b.project_code,
                undefined,
                { sensitivity: 'base' },
            );
            if (byProject !== 0) return byProject;
            return a.process.localeCompare(b.process, undefined, {
                sensitivity: 'base',
            });
        });
}

/**
 * For one user on one date:
 * 1) Sum duration by project → pick max project
 * 2) Within that project, sum by process → pick max process
 * 3) Return max_work (top process) + all_work (every entry that day)
 */
function buildMaxWorkForUserDay(rows, date, userName) {
    if (!rows.length) return null;

    const projectTotals = new Map();
    for (const row of rows) {
        const project = String(row.project_code ?? '').trim() || 'OTHER';
        const secs = entryDurationSeconds(row);
        projectTotals.set(project, (projectTotals.get(project) || 0) + secs);
    }

    let maxProject = null;
    let maxProjectSecs = -1;
    for (const [project, secs] of projectTotals) {
        if (secs > maxProjectSecs) {
            maxProjectSecs = secs;
            maxProject = project;
        }
    }
    if (!maxProject) return null;

    const projectRows = rows.filter(
        (r) => (String(r.project_code ?? '').trim() || 'OTHER') === maxProject,
    );

    const processTotals = new Map();
    for (const row of projectRows) {
        const process = String(row.process_name ?? '').trim() || 'OTHER';
        const secs = entryDurationSeconds(row);
        processTotals.set(process, (processTotals.get(process) || 0) + secs);
    }

    let maxProcess = null;
    let maxProcessSecs = -1;
    for (const [process, secs] of processTotals) {
        if (secs > maxProcessSecs) {
            maxProcessSecs = secs;
            maxProcess = process;
        }
    }
    if (!maxProcess) return null;

    const processRows = projectRows.filter(
        (r) => (String(r.process_name ?? '').trim() || 'OTHER') === maxProcess,
    );

    const max_entries = processRows.map(mapWorksheetEntry);

    let dayTotalSecs = 0;
    for (const row of rows) {
        dayTotalSecs += entryDurationSeconds(row);
    }

    return {
        date,
        user_name: userName,
        total_duration: formatDurationHMS(Math.max(0, dayTotalSecs)),
        total_entry_count: rows.length,
        max_work: {
            project_code: maxProject,
            process_name: maxProcess,
            duration: formatDurationHMS(Math.max(0, maxProcessSecs)),
            entries: max_entries,
        },
        all_work: buildAllWorkForUserDay(rows),
    };
}



async function resolveSubjectUsername(row) {
    if (!row) return null;
    const direct = String(row.user_name ?? row.username ?? '').trim();
    if (direct) return direct;

    const userId = row.user_id;
    if (userId == null || userId === '') return null;

    try {
        const userResult = await pool.query(
            'SELECT username FROM personal_details WHERE id = $1 LIMIT 1',
            [parseInt(userId, 10)],
        );
        return userResult.rows[0]?.username
            ? String(userResult.rows[0].username).trim()
            : null;
    } catch (_) {
        return null;
    }
}

class TimesheetController {
    // Optimized: Fetch timesheets with parallel count and data queries
    static async getAllTimesheets(req, res) {
        const {
            user_id, project_code, today, page, limit,
            date, dateStart, dateEnd, type, project, process,
            startTime, stopTime, duration, projectBy, notes, user, sortOrder
        } = req.query;

        const filters = {
            userId: user_id,
            projectCode: project_code,
            date,
            dateStart,
            dateEnd,
            today,
            type,
            project,
            process,
            startTime,
            stopTime,
            duration,
            projectBy,
            notes,
            user,
            page: parseInt(page) || 1,
            limit: parseInt(limit) || 10,
            sortOrder: sortOrder || 'DESC'
        };

        const result = await TimesheetModel.findAll(filters);

        const rows = result.rows || [];
        // Date section: pass through date column as-is so any format (02/12/2025, 02-12-25, etc.) is sent to frontend for display
        const timesheets = rows.map((row) => {
            const r = { ...row };
            const fromDateColumn = r.date;
            if (fromDateColumn != null && fromDateColumn !== '') {
                if (typeof fromDateColumn === 'string') {
                    r.date = fromDateColumn.trim();
                } else if (fromDateColumn instanceof Date) {
                    if (!isNaN(fromDateColumn.getTime())) {
                        r.date = fromDateColumn.toISOString().split('T')[0];
                    } else {
                        r.date = null;
                    }
                } else {
                    try {
                        const d = new Date(fromDateColumn);
                        r.date = !isNaN(d.getTime()) ? d.toISOString().split('T')[0] : null;
                    } catch (_) {
                        r.date = null;
                    }
                }
            } else {
                r.date = null;
            }
            return r;
        });
        const totalCount = result.totalCount || 0;
        const pageNum = parseInt(page) || 1;
        const limitNum = parseInt(limit) || 10;
        const totalPages = Math.ceil(totalCount / limitNum);

        res.json({
            success: true,
            timesheets,
            pagination: {
                currentPage: pageNum,
                totalPages: totalPages,
                totalCount: totalCount,
                limit: limitNum,
                hasNextPage: pageNum < totalPages,
                hasPrevPage: pageNum > 1
            }
        });
    }

    static async getTimesheetById(req, res) {
        const { id } = req.params;
        const timesheet = await TimesheetModel.findById(id);
        if (!timesheet) {
            throw new AppError('Timesheet not found', 404);
        }
        res.json({
            success: true,
            timesheet
        });
    }

    // Optimized: Parallel checks for project validation
    static async createTimesheet(req, res) {
        const {
            project_code, project_id, project_type, category_letter,
            process_name, process_id, start_time, stop_time,
            duration, project_by, user_id, user_name, username, notes, checked_tasks, date,
            task_id, task_serial_number,
            skip_log,
        } = req.body;

        // Use provided date or default to today's date (always YYYY-MM-DD for overlap + storage)
        let dateValue = TimesheetModel.toISODate(date);
        if (!dateValue) {
            const today = new Date();
            dateValue = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        }

        // Automatically calculate duration if start and stop times are provided
        let finalDuration = duration;
        if (start_time && stop_time && stop_time !== 'Ongoing') {
            const dur = calculateDurationFromTimes(start_time, stop_time);
            finalDuration = formatDurationHHMMSS(dur.hours, dur.minutes, dur.seconds);
        }

        // Resolve username to store directly on TIMESHEET (no FK dependency)
        let resolvedUserName =
            String(user_name ?? username ?? '').trim() || null;
        if (!resolvedUserName && user_id != null && user_id !== '') {
            try {
                const userResult = await pool.query(
                    'SELECT username FROM personal_details WHERE id = $1 LIMIT 1',
                    [parseInt(user_id, 10)],
                );
                resolvedUserName = userResult.rows[0]?.username
                    ? String(userResult.rows[0].username).trim()
                    : null;
            } catch (_) {
                resolvedUserName = null;
            }
        }

        // Build timesheet data object, ensuring category and process are included
        const timesheetData = {
            project_code,
            project_id: project_id || null,
            start_time,
            stop_time: stop_time || null,
            duration: finalDuration || null,
            project_by,
            user_id: user_id || null,
            user_name: resolvedUserName,
            notes: notes || '',
            checked_tasks: checked_tasks || '',
            date: dateValue,
            // Links this entry back to the task it was started from (null for
            // manual/break entries that aren't tied to a task).
            task_id: task_id != null && task_id !== '' ? task_id : null,
            task_serial_number: task_serial_number || null
        };

        // Always include category information if provided
        if (category_letter) {
            timesheetData.category_letter = category_letter;
            timesheetData.project_type = project_type || category_letter; // Use category_letter as fallback if project_type not provided
        } else if (project_type) {
            // If only project_type is provided, try to use it
            timesheetData.project_type = project_type;
        }

        // Include process information if provided
        if (process_id) {
            timesheetData.process_id = process_id;
            timesheetData.process_name = process_name || '';
        } else if (process_name) {
            // If only process_name is provided, include it
            timesheetData.process_name = process_name;
        }

        // console.log('[TimesheetController] Creating timesheet with data:', {
        //     category_letter: timesheetData.category_letter,
        //     project_type: timesheetData.project_type,
        //     process_id: timesheetData.process_id,
        //     process_name: timesheetData.process_name
        // });

        await assertNoTimesheetOverlap({
            date: dateValue,
            userId: user_id,
            userName: resolvedUserName,
            startTime: start_time,
            stopTime: stop_time,
        });

        try {
            assertStopAfterStart(start_time, stop_time);
        } catch (err) {
            throw new AppError(err.message, 400);
        }

        // Only one ongoing entry per user per day (same scope the UI uses: today only,
        // so old forgotten rows from earlier days can't block starting a task). Serialised with an in-process per-user lock so two
        // simultaneous start requests can't both pass the check.
        const isOngoingCreate =
            !stop_time || String(stop_time).trim() === '' || String(stop_time).trim().toLowerCase() === 'ongoing';
        let newTimesheet;
        if (isOngoingCreate && (user_id || resolvedUserName)) {
            const lockClient = await pool.connect();
            const lockKey = String(user_id || resolvedUserName);
            try {
                await lockClient.query('SELECT pg_advisory_lock(hashtext($1))', [`timesheet_ongoing_${lockKey}`]);
                const existing = await lockClient.query(
                    `SELECT id FROM "TIMESHEET"
                     WHERE (stop_time IS NULL OR TRIM(stop_time) = '' OR stop_time = 'Ongoing')
                       AND (
                            CASE
                                WHEN "date"::text ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN to_date(left("date"::text, 10), 'YYYY-MM-DD')
                                WHEN "date"::text ~ '^[0-9]{2}-[0-9]{2}-[0-9]{4}$' THEN to_date("date"::text, 'DD-MM-YYYY')
                                ELSE NULL
                            END
                       ) = $3::date
                       AND (($1::int IS NOT NULL AND user_id = $1::int) OR ($1::int IS NULL AND user_name = $2))
                     LIMIT 1`,
                    [user_id ? parseInt(user_id, 10) : null, resolvedUserName, dateValue],
                );
                if (existing.rows.length > 0) {
                    throw new AppError('You already have an ongoing timesheet entry. Stop it before starting a new one.', 409);
                }
                newTimesheet = await TimesheetModel.create(timesheetData);
            } finally {
                try { await lockClient.query('SELECT pg_advisory_unlock(hashtext($1))', [`timesheet_ongoing_${lockKey}`]); } catch (_) {}
                lockClient.release();
            }
        } else {
            newTimesheet = await TimesheetModel.create(timesheetData);
        }

        broadcastTimesheetUpdate('created', { source: 'timesheet', id: newTimesheet.id, user_id: newTimesheet.user_id });

        try {
            if (!skip_log) {
                const subjectUsername = await resolveSubjectUsername(newTimesheet);
                const trackedNewValue = {};
                for (const key of TIMESHEET_LOG_TRACKED_FIELDS) {
                    if (newTimesheet[key] !== undefined) trackedNewValue[key] = newTimesheet[key];
                }

                await TimesheetLogModel.create({
                    timesheetId: newTimesheet.id,
                    action: 'CREATE',
                    projectCode: newTimesheet.project_code ?? null,
                    subjectUserId: newTimesheet.user_id ?? null,
                    subjectUsername,
                    actorUserId: getUserIdFromReq(req),
                    actorUsername: getUsernameFromReq(req),
                    oldValue: null,
                    newValue: trackedNewValue,
                });
            }
        } catch (e) {
            console.error('Timesheet log write failed (timesheet create):', e.message || e);
        }

        try {
            await writeAuditLog(req, {
                action: 'CREATE',
                tableName: 'TIMESHEET',
                tableOfId: newTimesheet.id,
                tableOfColumn: 'ALL',
                oldValue: null,
                newValue: newTimesheet,
            });
        } catch (e) {
            console.error('Audit log write failed (timesheet create):', e.message || e);
        }

        res.status(201).json({
            success: true,
            message: 'Timesheet created successfully',
            timesheet: newTimesheet
        });
    }

    static async bulkCreateTimesheets(req, res) {
        const { entries } = req.body;
        if (!Array.isArray(entries)) {
            throw new AppError('Entries must be an array', 400);
        }
        const { inserted, skipped, errors, errorDetails } = await TimesheetModel.bulkCreate(entries);
        const count = inserted.length;
        if (count > 0) {
            broadcastTimesheetUpdate('created', { source: 'timesheet', bulk: true, count });
        }
        res.status(201).json({
            success: true,
            message: `Imported ${count} entries${errors > 0 ? `, ${errors} failed` : ''}`,
            count,
            results: inserted,
            skipped: skipped || 0,
            errors,
            errorDetails
        });
    }

    // Optimized: Parallel checks for timesheet existence
    static async updateTimesheet(req, res) {
        const { id } = req.params;
        const before = await TimesheetModel.findById(id);
        if (!before) {
            throw new AppError('Timesheet not found', 404);
        }
        const updateData = { ...req.body };
        const skipLog = Boolean(updateData.skip_log);
        delete updateData.skip_log;

        // Automatically calculate duration if start and stop times are provided.
        // Fall back to the existing row's start_time when the update payload
        // (e.g. a "stop timer" request) only sends stop_time — otherwise
        // duration silently stays null even though we know the start_time.
        const effectiveStartTime = updateData.start_time || before.start_time;
        if (effectiveStartTime && updateData.stop_time && updateData.stop_time !== 'Ongoing') {
            const dur = calculateDurationFromTimes(effectiveStartTime, updateData.stop_time);
            updateData.duration = formatDurationHHMMSS(dur.hours, dur.minutes, dur.seconds);
        }

        // Prefer explicit payload date, else stored row date — always as YYYY-MM-DD
        // so DD-MM-YYYY storage (e.g. 03-09-2026) is not read as 2026-03-09.
        const overlapDate =
            normalizeIsoDate(updateData.date ?? before.date) ??
            updateData.date ??
            before.date;
        const overlapUserId = updateData.user_id ?? before.user_id;
        const overlapUserName =
            updateData.user_name ??
            updateData.username ??
            before.user_name ??
            null;
        const overlapStart = updateData.start_time ?? before.start_time;
        const overlapStop =
            updateData.stop_time !== undefined
                ? updateData.stop_time
                : before.stop_time;

        if (overlapStart) {
            await assertNoTimesheetOverlap({
                date: overlapDate,
                userId: overlapUserId,
                userName: overlapUserName,
                startTime: overlapStart,
                stopTime: overlapStop,
                excludeId: id,
            });
        }

        try {
            assertStopAfterStart(overlapStart, overlapStop);
        } catch (err) {
            throw new AppError(err.message, 400);
        }

        const updatedTimesheet = await TimesheetModel.update(id, updateData);
        if (!updatedTimesheet) {
            throw new AppError('Timesheet not found', 404);
        }

        broadcastTimesheetUpdate('updated', { source: 'timesheet', id: updatedTimesheet.id, user_id: updatedTimesheet.user_id });

        let timesheetLogError = null;
        try {
            if (!skipLog) {
                const subjectUsername = await resolveSubjectUsername(
                    updatedTimesheet ?? before,
                );
                const diff = pickChangedColumns(
                    before,
                    updatedTimesheet,
                    TIMESHEET_LOG_TRACKED_FIELDS,
                );

                if (diff.columns.length > 0) {
                    const logRow = await TimesheetLogModel.create({
                        timesheetId: updatedTimesheet.id,
                        action: 'UPDATE',
                        projectCode: updatedTimesheet.project_code ?? before.project_code ?? null,
                        subjectUserId: updatedTimesheet.user_id ?? before.user_id ?? null,
                        subjectUsername,
                        actorUserId: getUserIdFromReq(req),
                        actorUsername: getUsernameFromReq(req),
                        oldValue: diff.oldValue,
                        newValue: diff.newValue,
                    });
                    if (!logRow) {
                        timesheetLogError = 'TimesheetLogModel.create returned null (missing timesheetId or action)';
                        console.error('Timesheet log write skipped (timesheet update):', timesheetLogError);
                    }
                }
            }
        } catch (e) {
            timesheetLogError = e.message || String(e);
            console.error('Timesheet log write failed (timesheet update):', e.stack || e);
        }

        // Audit log (best-effort)
        try {
            const keys = Array.from(new Set([...Object.keys(updateData || {}), 'duration']));
            const patch = pickChangedColumns(before, updatedTimesheet, keys);

            await writeAuditLog(req, {
                action: 'UPDATE',
                tableName: 'TIMESHEET',
                tableOfId: updatedTimesheet.id,
                tableOfColumn: patch.columns.join(','),
                oldValue: patch.oldValue,
                newValue: patch.newValue,
            });
        } catch (e) {
            console.error('Audit log write failed (timesheet update):', e.message || e);
        }

        res.json({
            success: true,
            message: 'Timesheet updated successfully',
            timesheet: updatedTimesheet
        });
    }

    static async deleteTimesheet(req, res) {
        const { id } = req.params;
        const before = await TimesheetModel.findById(id);
        if (!before) {
            throw new AppError('Timesheet not found', 404);
        }

        const deleted = await TimesheetModel.delete(id);
        if (!deleted) {
            throw new AppError('Timesheet not found', 404);
        }

        try {
            const subjectUsername = await resolveSubjectUsername(before);
            const trackedOldValue = {};
            for (const key of TIMESHEET_LOG_TRACKED_FIELDS) {
                if (before[key] !== undefined) trackedOldValue[key] = before[key];
            }

            await TimesheetLogModel.create({
                timesheetId: parseInt(id, 10),
                action: 'DELETE',
                projectCode: before.project_code ?? null,
                subjectUserId: before.user_id ?? null,
                subjectUsername,
                actorUserId: getUserIdFromReq(req),
                actorUsername: getUsernameFromReq(req),
                oldValue: trackedOldValue,
                newValue: null,
            });
        } catch (e) {
            console.error('Timesheet log write failed (timesheet delete):', e.message || e);
        }

        try {
            await writeAuditLog(req, {
                action: 'DELETE',
                tableName: 'TIMESHEET',
                tableOfId: parseInt(id, 10),
                tableOfColumn: 'ALL',
                oldValue: before,
                newValue: null,
            });
        } catch (e) {
            console.error('Audit log write failed (timesheet delete):', e.message || e);
        }

        broadcastTimesheetUpdate('deleted', {
            source: 'timesheet',
            id: parseInt(id, 10)
        });

        return res.json({
            success: true,
            message: 'Timesheet deleted successfully'
        });
    }

    static async getStats(req, res) {
        const {
            user_id, project_code, today,
            date, dateStart, dateEnd, type, project, process,
            startTime, stopTime, duration, projectBy, notes, user
        } = req.query;

        const filters = {
            userId: user_id,
            projectCode: project_code,
            date,
            dateStart,
            dateEnd,
            today,
            type,
            project,
            process,
            startTime,
            stopTime,
            duration,
            projectBy,
            notes,
            user
        };

        const stats = await TimesheetModel.getStats(filters);
        const totalSeconds = stats.totalDurationSeconds || 0;

        res.json({
            success: true,
            stats: {
                totalEntries: stats.totalEntries || 0,
                totalOngoingEntries: stats.totalOngoingEntries || 0,
                totalDuration: {
                    hours: Math.floor(totalSeconds / 3600),
                    minutes: Math.floor((totalSeconds % 3600) / 60),
                    seconds: totalSeconds % 60,
                },
            },
        });
    }

    // Get timesheet summary (total duration and net time) for ALL entries matching filters
    static async getSummary(req, res) {
        const {
            user_id, project_code, today,
            date, dateStart, dateEnd, type, project, process,
            startTime, stopTime, duration, projectBy, notes, user
        } = req.query;

        const filters = {
            userId: user_id,
            projectCode: project_code,
            date,
            dateStart,
            dateEnd,
            today,
            type,
            project,
            process,
            startTime,
            stopTime,
            duration,
            projectBy,
            notes,
            user
        };

        // Calculate summary based on the exact filters (so regular users only see their own total)
        const allTimesheets = await TimesheetModel.getSummary(filters);

        // Use worker threads for parallel calculation of heavy operations
        // This allows simultaneous processing and prevents blocking the main event loop
        let totalDuration, commonTime, netTime;

        try {
            const [totalDurationResult, commonTimeResult, netTimeResult] = await runInParallel([
                {
                    workerFile: 'timesheet-calculations.worker.js',
                    data: {
                        timesheets: allTimesheets,
                        operation: 'calculateTotalDuration'
                    }
                },
                {
                    workerFile: 'timesheet-calculations.worker.js',
                    data: {
                        timesheets: allTimesheets,
                        operation: 'calculateCommonTime'
                    }
                },
                {
                    workerFile: 'timesheet-calculations.worker.js',
                    data: {
                        timesheets: allTimesheets,
                        operation: 'calculateNetTimeByDate'
                    }
                }
            ]);

            // Extract results from worker threads
            totalDuration = totalDurationResult.error
                ? null
                : (totalDurationResult.result || null);

            commonTime = commonTimeResult.error
                ? null
                : (commonTimeResult.result || null);

            netTime = netTimeResult.error
                ? null
                : (netTimeResult.result || null);
        } catch (workerError) {
            console.warn('[Timesheet Summary] Worker thread error, falling back to main thread:', workerError);
            // Fall through to main thread calculation
        }

        // Fallback to main thread calculation if worker threads failed or returned errors
        if (!totalDuration || !commonTime || !netTime) {
            console.log('[Timesheet Summary] Using main thread calculation as fallback');

            // Calculate total duration (sum of all durations)
            let totalDurationSeconds = 0;
            allTimesheets.forEach(ts => {
                if (ts.start_time && ts.stop_time && ts.stop_time !== 'Ongoing') {
                    const dur = calculateDurationFromTimes(ts.start_time, ts.stop_time);
                    totalDurationSeconds += dur.hours * 3600 + dur.minutes * 60 + dur.seconds;
                }
            });

            // Net time = union per date (only same date + overlapping time counts as overlap)
            const netResult = netTimeByDateFromTimesheets(allTimesheets);
            const netHours = netResult.hours || 0;
            const netMinutes = netResult.minutes || 0;
            const netSeconds = netResult.seconds || 0;
            const netTotalSeconds = netHours * 3600 + netMinutes * 60 + netSeconds;

            // Common time = total - net (overlapping portion)
            const commonTotalSeconds = Math.max(0, totalDurationSeconds - netTotalSeconds);
            const commonHours = Math.floor(commonTotalSeconds / 3600);
            const commonMinutes = Math.floor((commonTotalSeconds % 3600) / 60);
            const commonSeconds = commonTotalSeconds % 60;

            const totalHours = Math.floor(totalDurationSeconds / 3600);
            const totalMinutes = Math.floor((totalDurationSeconds % 3600) / 60);
            const totalSeconds = totalDurationSeconds % 60;

            totalDuration = totalDuration || { hours: totalHours, minutes: totalMinutes, seconds: totalSeconds };
            commonTime = commonTime || { hours: commonHours, minutes: commonMinutes, seconds: commonSeconds };
            netTime = netTime || { hours: netHours, minutes: netMinutes, seconds: netSeconds };
        }

        const totalHours = totalDuration.hours || 0;
        const totalMinutes = totalDuration.minutes || 0;
        const totalSeconds = totalDuration.seconds || 0;

        const commonHours = commonTime.hours || 0;
        const commonMinutes = commonTime.minutes || 0;
        const commonSeconds = commonTime.seconds || 0;

        const netHours = netTime.hours || 0;
        const netMinutes = netTime.minutes || 0;
        const netSeconds = netTime.seconds || 0;

        res.json({
            success: true,
            summary: {
                totalDuration: {
                    hours: totalHours || 0,
                    minutes: totalMinutes || 0,
                    seconds: totalSeconds || 0
                },
                commonTime: {
                    hours: commonHours || 0,
                    minutes: commonMinutes || 0,
                    seconds: commonSeconds || 0
                },
                netTime: {
                    hours: netHours || 0,
                    minutes: netMinutes || 0,
                    seconds: netSeconds || 0
                },
                totalEntries: allTimesheets.length
            }
        });
    }

    
    static async getTimesheetLogs(req, res) {
        const {
            timesheet_id, action, project_code,
            subject_user_id, subject_username,
            actor_user_id, actor_username,
            dateStart, dateEnd, page, limit, sortOrder,
        } = req.query;

        const filters = {
            timesheetId: timesheet_id,
            action,
            projectCode: project_code,
            subjectUserId: subject_user_id,
            subjectUsername: subject_username,
            actorUserId: actor_user_id,
            actorUsername: actor_username,
            dateStart,
            dateEnd,
            page: parseInt(page) || 1,
            limit: parseInt(limit) || 10,
            sortOrder: sortOrder || 'DESC',
        };

        const result = await TimesheetLogModel.findAll(filters);
        const totalCount = result.totalCount || 0;
        const pageNum = filters.page;
        const limitNum = filters.limit;
        const totalPages = Math.ceil(totalCount / limitNum);

        res.json({
            success: true,
            logs: result.rows || [],
            pagination: {
                currentPage: pageNum,
                totalPages,
                totalCount,
                limit: limitNum,
                hasNextPage: pageNum < totalPages,
                hasPrevPage: pageNum > 1,
            },
        });
    }

    static async getMaxWork(req, res) {
        const q = req.query || {};
        const start_date =
            normalizeIsoDate(q.start_date ?? q.dateStart ?? q.date_from) ||
            null;
        const end_date =
            normalizeIsoDate(q.end_date ?? q.dateEnd ?? q.date_to) ||
            null;
        const user = String(q.user ?? q.user_name ?? q.username ?? '').trim() || undefined;

        if (!start_date || !end_date) {
            throw new AppError(
                'start_date and end_date are required (YYYY-MM-DD)',
                400,
            );
        }
        if (start_date > end_date) {
            throw new AppError('start_date must be on or before end_date', 400);
        }

        const rows = await TimesheetModel.findAllForMaxWork({
            dateStart: start_date,
            dateEnd: end_date,
            user,
        });

        // date -> user_name -> rows[]
        const byDateUser = new Map();
        for (const row of rows) {
            const date = normalizeIsoDate(row.date);
            if (!date) continue;
            const userName = String(row.user_name ?? '').trim();
            if (!userName) continue;

            if (!byDateUser.has(date)) byDateUser.set(date, new Map());
            const byUser = byDateUser.get(date);
            if (!byUser.has(userName)) byUser.set(userName, []);
            byUser.get(userName).push(row);
        }

        const dates = [...byDateUser.keys()].sort();
        const data = dates.map((date) => {
            const byUser = byDateUser.get(date);
            const userNames = [...byUser.keys()].sort((a, b) =>
                a.localeCompare(b, undefined, { sensitivity: 'base' }),
            );
            const users = userNames
                .map((name) => buildMaxWorkForUserDay(byUser.get(name), date, name))
                .filter(Boolean);
            return { date, users };
        });

        res.json({
            success: true,
            start_date,
            end_date,
            data,
        });
    }

    /**
     * GET /timesheets/max-work-duration-process?project_code=
     * Optional: start_date, end_date, user / user_name
     * All processes for the project with summed duration (and entry counts),
     * optionally limited to one user.
     */
    static async getMaxWorkDurationProcess(req, res) {
        const q = req.query || {};
        const project_code = String(
            q.project_code ?? q.projectCode ?? q.project ?? '',
        ).trim();
        if (!project_code) {
            throw new AppError('project_code is required', 400);
        }

        const start_date =
            normalizeIsoDate(q.start_date ?? q.dateStart ?? q.date_from) ||
            null;
        const end_date =
            normalizeIsoDate(q.end_date ?? q.dateEnd ?? q.date_to) || null;
        const user =
            String(q.user ?? q.user_name ?? q.username ?? '').trim() ||
            undefined;

        if (start_date && end_date && start_date > end_date) {
            throw new AppError('start_date must be on or before end_date', 400);
        }

        const rows = await TimesheetModel.findAllForMaxWorkDuration({
            projectCode: project_code,
            dateStart: start_date || undefined,
            dateEnd: end_date || undefined,
            user,
        });

        const processTotals = new Map();
        for (const row of rows) {
            const process = String(row.process_name ?? '').trim() || 'OTHER';
            const secs = entryDurationSeconds(row);
            const cur = processTotals.get(process) || {
                process_name: process,
                duration_seconds: 0,
                entry_count: 0,
            };
            cur.duration_seconds += secs;
            cur.entry_count += 1;
            processTotals.set(process, cur);
        }

        const processes = [...processTotals.values()]
            .map((p) => ({
                process_name: p.process_name,
                duration: formatDurationHMS(Math.max(0, p.duration_seconds)),
                duration_seconds: p.duration_seconds,
                entry_count: p.entry_count,
            }))
            .sort((a, b) => {
                if (b.duration_seconds !== a.duration_seconds) {
                    return b.duration_seconds - a.duration_seconds;
                }
                return a.process_name.localeCompare(b.process_name, undefined, {
                    sensitivity: 'base',
                });
            });

        const totalSeconds = processes.reduce(
            (sum, p) => sum + p.duration_seconds,
            0,
        );
        const maxProcess = processes[0] || null;

        res.json({
            success: true,
            project_code,
            user_name: user || null,
            start_date: start_date || null,
            end_date: end_date || null,
            total_duration: formatDurationHMS(Math.max(0, totalSeconds)),
            total_duration_seconds: totalSeconds,
            process_count: processes.length,
            entry_count: rows.length,
            max_process: maxProcess
                ? {
                      process_name: maxProcess.process_name,
                      duration: maxProcess.duration,
                      duration_seconds: maxProcess.duration_seconds,
                  }
                : null,
            processes,
        });
    }

    /**
     * GET /timesheets/max-work-duration-users?project_code=
     * Optional: start_date, end_date, process / process_name
     * Users on this project with each user's total work duration
     * (optionally limited to one process).
     */
    static async getMaxWorkDurationUsers(req, res) {
        const q = req.query || {};
        const project_code = String(
            q.project_code ?? q.projectCode ?? q.project ?? '',
        ).trim();
        if (!project_code) {
            throw new AppError('project_code is required', 400);
        }

        const start_date =
            normalizeIsoDate(q.start_date ?? q.dateStart ?? q.date_from) ||
            null;
        const end_date =
            normalizeIsoDate(q.end_date ?? q.dateEnd ?? q.date_to) || null;
        const process_name =
            String(
                q.process ?? q.process_name ?? q.processName ?? '',
            ).trim() || null;

        if (start_date && end_date && start_date > end_date) {
            throw new AppError('start_date must be on or before end_date', 400);
        }

        const rows = await TimesheetModel.findAllForMaxWorkDuration({
            projectCode: project_code,
            dateStart: start_date || undefined,
            dateEnd: end_date || undefined,
            processName: process_name || undefined,
        });

        const userTotals = new Map();
        for (const row of rows) {
            const userName =
                String(row.user_name ?? '').trim() ||
                String(row.project_by ?? '').trim() ||
                'Unknown';
            const key = userName.toLowerCase();
            const secs = entryDurationSeconds(row);
            const cur = userTotals.get(key) || {
                user_name: userName,
                duration_seconds: 0,
                entry_count: 0,
            };
            cur.duration_seconds += secs;
            cur.entry_count += 1;
            userTotals.set(key, cur);
        }

        const users = [...userTotals.values()]
            .map((u) => ({
                user_name: u.user_name,
                duration: formatDurationHMS(Math.max(0, u.duration_seconds)),
                duration_seconds: u.duration_seconds,
                entry_count: u.entry_count,
            }))
            .sort((a, b) => {
                if (b.duration_seconds !== a.duration_seconds) {
                    return b.duration_seconds - a.duration_seconds;
                }
                if (b.entry_count !== a.entry_count) {
                    return b.entry_count - a.entry_count;
                }
                return a.user_name.localeCompare(b.user_name, undefined, {
                    sensitivity: 'base',
                });
            });

        const totalSeconds = users.reduce(
            (sum, u) => sum + u.duration_seconds,
            0,
        );

        res.json({
            success: true,
            project_code,
            process_name,
            start_date: start_date || null,
            end_date: end_date || null,
            total_duration: formatDurationHMS(Math.max(0, totalSeconds)),
            total_duration_seconds: totalSeconds,
            user_count: users.length,
            entry_count: rows.length,
            users,
        });
    }
}

wrapController(TimesheetController, [
    'getAllTimesheets',
    'getTimesheetById',
    'createTimesheet',
    'bulkCreateTimesheets',
    'updateTimesheet',
    'deleteTimesheet',
    'getStats',
    'getSummary',
    'getTimesheetLogs',
    'getMaxWork',
    'getMaxWorkDurationProcess',
    'getMaxWorkDurationUsers',
]);

export default TimesheetController;