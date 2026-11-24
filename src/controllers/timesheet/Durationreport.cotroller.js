import DurationReportModel from '../../models/timesheet/Durationreport.model.js';
import { wrapController, AppError } from '../../middleware/error.middleware.js';
import { formatDurationHMS } from '../../utils/time.utils.js';
import { calculateDurationFromTimes } from '../../utils/project.utils.js';

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

function entryDurationSeconds(row) {
    const fromDuration = durationToSeconds(row.duration);
    if (fromDuration > 0) return fromDuration;

    const start = String(row.start_time ?? '').trim();
    const stop = String(row.stop_time ?? '').trim();
    if (!start || !stop || stop.toLowerCase() === 'ongoing') return 0;

    const dur = calculateDurationFromTimes(start, stop);
    return (dur.hours || 0) * 3600 + (dur.minutes || 0) * 60 + (dur.seconds || 0);
}

function normalizeIsoDate(value) {
    if (value == null || value === '') return null;
    const s = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const dmy = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})$/);
    if (dmy) {
        let y = dmy[3];
        if (y.length === 2) y = `20${y}`;
        return `${y.padStart(4, '0')}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
    }
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    return null;
}


async function sendFilterOptions(field, req, res) {
    const q = req.query || {};
    const clean = (v) => {
        const s = String(v ?? '').trim();
        return s || undefined;
    };
    const dateOrNull = (v, label) => {
        if (clean(v) === undefined) return undefined;
        const iso = normalizeIsoDate(v);
        if (!iso) throw new AppError(`${label} is not a valid date`, 400);
        return iso;
    };

    const dateStart = dateOrNull(q.start_date ?? q.dateStart, 'start_date');
    const dateEnd = dateOrNull(q.end_date ?? q.dateEnd, 'end_date');
    if (dateStart && dateEnd && dateStart > dateEnd) {
        throw new AppError('start_date must be on or before end_date', 400);
    }

    const options = await DurationReportModel.findFilterOptions(field, {
        dateStart,
        dateEnd,
        project: clean(q.project),
        process: clean(q.process),
        user: clean(q.user),
        projectBy: clean(q.project_by ?? q.projectBy),
        projectType: clean(q.project_type ?? q.projectType),
    });

    res.json({
        success: true,
        type: field,
        total: options.length,
        options,
    });
}

class DurationReportController {

    static async getDurationReport(req, res) {
        const {
            start_date: rawStart,
            end_date: rawEnd,
            project,
            process,
            user,
            project_type: rawProjectType,
            projectType: rawProjectTypeCamel,
            project_by: rawProjectBy,
            projectBy: rawProjectByCamel,
        } = req.query || {};
        const projectType = String(rawProjectType ?? rawProjectTypeCamel ?? '').trim();
        const projectBy = String(rawProjectBy ?? rawProjectByCamel ?? '').trim();

        const start_date = normalizeIsoDate(rawStart);
        const end_date = normalizeIsoDate(rawEnd);

        if (!start_date && !end_date) {
            throw new AppError(
                'Provide at least start_date or end_date (YYYY-MM-DD)',
                400,
            );
        }
        if (start_date && end_date && start_date > end_date) {
            throw new AppError('start_date must be on or before end_date', 400);
        }
        const userList = String(user ?? '').trim()
            ? String(user).trim().split(',').map((u) => u.trim()).filter(Boolean)
            : [];
        const userFilter = userList.length ? userList.join('|') : undefined;

        const rows = await DurationReportModel.findForDurationReport({
            dateStart: start_date || undefined,
            dateEnd: end_date || undefined,
            projectCode: project ? String(project).trim() : undefined,
            processName: process ? String(process).trim() : undefined,
            user: userFilter,
            projectType: projectType || undefined,
            projectBy: projectBy || undefined,
        });
        const groups = new Map();

        for (const row of rows) {
            const projectCode = String(row.project_code ?? '').trim() || 'OTHER';
            const processName = String(row.process_name ?? '').trim() || 'OTHER';
            const userName = String(row.user_name ?? '').trim() || 'UNKNOWN';
            const secs = entryDurationSeconds(row);

            const key = `${projectCode}\0${processName}\0${userName}`;
            groups.set(key, (groups.get(key) || 0) + secs);
        }

        let report = [...groups.entries()].map(([key, secs]) => {
            const [projectCode, processName, userName] = key.split('\0');
            return {
                project: projectCode,
                process: processName,
                duration: formatDurationHMS(Math.max(0, secs)),
                user: userName,
            };
        });

    
        if (userList.length > 1) {
            const requiredUsers = new Set(
                userList.map((u) => u.trim().toLowerCase()).filter(Boolean),
            );

            const comboUsers = new Map(); // "project\0process" -> Set of lowercase usernames
            for (const r of report) {
                const comboKey = `${r.project}\0${r.process}`;
                if (!comboUsers.has(comboKey)) comboUsers.set(comboKey, new Set());
                comboUsers.get(comboKey).add(r.user.trim().toLowerCase());
            }

            const commonCombos = new Set(
                [...comboUsers.entries()]
                    .filter(([, usersForCombo]) =>
                        [...requiredUsers].every((u) => usersForCombo.has(u)),
                    )
                    .map(([comboKey]) => comboKey),
            );

            report = report.filter((r) => commonCombos.has(`${r.project}\0${r.process}`));
        }

        report.sort(
            (a, b) =>
                a.project.localeCompare(b.project, undefined, { sensitivity: 'base' }) ||
                a.process.localeCompare(b.process, undefined, { sensitivity: 'base' }) ||
                a.user.localeCompare(b.user, undefined, { sensitivity: 'base' }),
        );

        const totalSeconds = report.reduce(
            (sum, r) => sum + durationToSeconds(r.duration),
            0,
        );

        res.json({
            success: true,
            start_date,
            end_date,
            user: userList.length ? userList : null,
            project: project ? String(project).trim() : null,
            process: process ? String(process).trim() : null,
            project_by: projectBy || null,
            project_type: projectType || null,
            total_duration: formatDurationHMS(Math.max(0, totalSeconds)),
            report,
        });
    }

    /**
     * GET /api/timesheets/filter
     *
     * Response: { success, total_entries, total_duration, data: [...] }
     *
     * type          (optional, legacy) project | process | user - only used together with `value`
     * project       selected project (a|b for many)  \
     * process       selected process (a|b for many)   > exact match, all three can be combined
     * user          selected user    (a|b for many)  /
     * value         legacy: selection for the chosen `type`
     * project_by                  exact match (a|b for many) - who created / owns the project
     * project_type                exact match (a|b for many) - project category / type
     * date                        single day (YYYY-MM-DD or DD-MM-YYYY)
     * start_date, end_date        date range
     * start_time, end_time        HH:MM[:SS]  (end_time also accepts "ongoing")
     * duration                    HH:MM[:SS]  exact
     */
    static async getFilteredTimesheets(req, res) {
        const q = req.query || {};

        const FILTER_TYPES = ['project', 'user'];
        // Default type is "project" when the client does not send one
        const filterType = String(q.type ?? '').trim().toLowerCase() || 'project';
        if (!FILTER_TYPES.includes(filterType)) {
            throw new AppError('type must be one of: project, user', 400);
        }

        const clean = (v) => {
            const s = String(v ?? '').trim();
            return s || undefined;
        };
        const timeOrNull = (v, label, allowOngoing = false) => {
            const s = clean(v);
            if (!s) return undefined;
            if (allowOngoing && s.toLowerCase() === 'ongoing') return 'ongoing';
            if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test(s)) {
                throw new AppError(`${label} must be HH:MM or HH:MM:SS`, 400);
            }
            return s;
        };
        const dateOrNull = (v, label) => {
            if (clean(v) === undefined) return undefined;
            const iso = normalizeIsoDate(v);
            if (!iso) throw new AppError(`${label} is not a valid date`, 400);
            return iso;
        };

        const dateStart = dateOrNull(q.start_date ?? q.dateStart, 'start_date');
        const dateEnd = dateOrNull(q.end_date ?? q.dateEnd, 'end_date');
        if (dateStart && dateEnd && dateStart > dateEnd) {
            throw new AppError('start_date must be on or before end_date', 400);
        }

        const filterArgs = {
            filterType,
            filterValue: clean(q.value),
            project: clean(q.project),
            process: clean(q.process),
            user: clean(q.user),
            projectBy: clean(q.project_by ?? q.projectBy),
            projectType: clean(q.project_type ?? q.projectType),
            date: dateOrNull(q.date, 'date'),
            dateStart,
            dateEnd,
            startTime: timeOrNull(q.start_time ?? q.startTime, 'start_time'),
            endTime: timeOrNull(q.end_time ?? q.endTime, 'end_time', true),
            duration: timeOrNull(q.duration, 'duration'),
        };

        const mapRow = (row, secs) => ({
            id: row.id,
            project: row.project_code,
            process: row.process_name,
            user: row.user_name,
            project_by: row.project_by,
            project_type: row.project_type,
            date: row.date,
            start_time: row.start_time,
            end_time: row.stop_time,
            duration: row.duration || formatDurationHMS(secs),
            notes: row.notes,
        });

        // ---------- SERVER-SIDE PAGING (grouped Report tab) ----------
        // Used when the client sends page / limit (groups per page) and/or group_key.
        //   page, limit  -> which groups (cards) to return        (limit max 100, default 20)
        //   row_limit    -> rows returned inside every group      (max 200, default 5)
        //   group_key + row_page -> only the rows of ONE group (that card's own pagination)
        // Totals (total_entries / total_duration) always cover every filtered row.
        const pagingRequested =
            q.page !== undefined || q.limit !== undefined || q.group_key !== undefined || q.row_page !== undefined;
        if (pagingRequested) {
            const posInt = (v, label, def, max) => {
                if (clean(v) === undefined) return def;
                const n = Number(v);
                if (!Number.isInteger(n) || n < 1) throw new AppError(`${label} must be a positive whole number`, 400);
                return Math.min(n, max);
            };
            const page = posInt(q.page, 'page', 1, 1_000_000);
            const limit = posInt(q.limit, 'limit', 20, 100);
            const rowLimit = posInt(q.row_limit, 'row_limit', 5, 200);
            const rowPage = posInt(q.row_page, 'row_page', 1, 1_000_000);
            const groupKey = clean(q.group_key);

            // 1) light query: every matching row's group + duration fields -> counts and sums per group
            const { rows: statRows } = await DurationReportModel.findByFilter({ ...filterArgs, statsOnly: true });
            const stats = new Map();
            let grandSeconds = 0;
            for (const row of statRows) {
                const secs = entryDurationSeconds(row);
                grandSeconds += secs;
                const projectId = Number(row.project_id) || 0;
                const g = stats.get(row.group_key);
                if (g) {
                    g.entries += 1;
                    g.seconds += secs;
                    if (projectId > g.projectId) g.projectId = projectId;
                } else {
                    stats.set(row.group_key, {
                        entries: 1,
                        seconds: secs,
                        projectId,
                    });
                }
            }
            const allKeys = [...stats.keys()].sort((a, b) =>
                filterType === 'project'
                    ? (stats.get(b).projectId || 0) - (stats.get(a).projectId || 0)
                    : a.localeCompare(b, undefined, { sensitivity: 'base' })
            );

            // 2) which groups belong to this response
            const singleGroup = groupKey !== undefined;
            const totalGroups = allKeys.length;
            const totalPages = Math.max(1, Math.ceil(totalGroups / limit));
            const safePage = Math.min(page, totalPages);
            const pageKeys = singleGroup
                ? allKeys.filter((k) => k === groupKey)
                : allKeys.slice((safePage - 1) * limit, safePage * limit);

            // 3) only the needed rows of those groups
            const rowOffset = singleGroup ? (rowPage - 1) * rowLimit : 0;
            const { rows: pageRows } = await DurationReportModel.findByFilter({
                ...filterArgs,
                groupKeys: pageKeys,
                rowLimit,
                rowOffset,
            });
            const rowsByKey = new Map(pageKeys.map((k) => [k, []]));
            for (const row of pageRows) {
                rowsByKey.get(row.group_key)?.push(mapRow(row, entryDurationSeconds(row)));
            }

            const groups = pageKeys.map((key) => {
                const g = stats.get(key);
                return {
                    key,
                    project_id: g.projectId || null,
                    entries: g.entries,
                    duration: formatDurationHMS(Math.max(0, g.seconds)),
                    row_page: singleGroup ? rowPage : 1,
                    row_limit: rowLimit,
                    row_total_pages: Math.max(1, Math.ceil(g.entries / rowLimit)),
                    rows: rowsByKey.get(key),
                };
            });

            return res.json({
                success: true,
                total_entries: statRows.length,
                total_duration: formatDurationHMS(Math.max(0, grandSeconds)),
                page: safePage,
                limit,
                total_groups: totalGroups,
                total_pages: totalPages,
                groups,
            });
        }

        // ---------- no paging params: original behaviour (all rows) ----------
        const { rows } = await DurationReportModel.findByFilter(filterArgs);

        let totalSeconds = 0;
        const data = rows.map((row) => {
            const secs = entryDurationSeconds(row);
            totalSeconds += secs;
            return mapRow(row, secs);
        });

        // Slim response: only the filtered rows + totals.
        // (Dropdown values come from the separate /filter/projects, /processes, ... APIs.)
        res.json({
            success: true,
            total_entries: data.length,
            total_duration: formatDurationHMS(Math.max(0, totalSeconds)),
            data,
        });
    }
}


DurationReportController.getProjectOptions = (req, res) => sendFilterOptions('project', req, res);
DurationReportController.getProcessOptions = (req, res) => sendFilterOptions('process', req, res);
DurationReportController.getUserOptions = (req, res) => sendFilterOptions('user', req, res);
DurationReportController.getProjectByOptions = (req, res) => sendFilterOptions('project_by', req, res);
DurationReportController.getProjectTypeOptions = (req, res) => sendFilterOptions('project_type', req, res);

wrapController(DurationReportController, [
    'getDurationReport',
    'getFilteredTimesheets',
    'getProjectOptions',
    'getProcessOptions',
    'getUserOptions',
    'getProjectByOptions',
    'getProjectTypeOptions',
]);

export default DurationReportController;