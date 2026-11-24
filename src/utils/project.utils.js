
import { pool } from '../config/db.js';
import { workerPool } from './worker.utils.js';
import { MAIN_PROCESS_SCOPE, createMainProjectProcessChecked } from './projectProcessChecked.utils.js';

// Helper function to get financial year from project code (MMYY format)
function getFinancialYearFromProjectCode(projectCode) {
    if (!projectCode || projectCode.length < 4) {
        return null;
    }
    try {
        const last4 = projectCode.slice(-4);
        const monthStr = last4.substring(0, 2);
        const yearStr = last4.substring(2, 4);
        const month = parseInt(monthStr, 10);
        const yearShort = parseInt(yearStr, 10);

        if (isNaN(month) || isNaN(yearShort)) {
            return null;
        }

        let fullYear;
        if (yearShort < 50) {
            fullYear = 2000 + yearShort;
        } else {
            fullYear = 1900 + yearShort;
        }

        if (month >= 1 && month <= 12 && fullYear >= 1900 && fullYear <= 2099) {
            let fy;
            if (month >= 4) {
                const nextYear = (fullYear + 1).toString().slice(-2);
                fy = `${fullYear}-${nextYear}`;
            } else {
                const prevYear = (fullYear - 1).toString();
                const currentYearShort = fullYear.toString().slice(-2);
                fy = `${prevYear}-${currentYearShort}`;
            }
            return fy;
        }
    } catch {
        return null;
    }
    return null;
}

// Helper: YYZZ in PRD / serial string (PRD-2425-001 -> 2024-25). No project MMYY dates.
function getFinancialYearFromProductionCode(productionCode) {
    if (!productionCode) return null;
    try {
        const s = String(productionCode).trim();
        const prd = s.match(/PRD-(\d{2})(\d{2})-/i);
        if (prd) {
            return `20${prd[1]}-${prd[2]}`;
        }

        const matchFull = s.match(/PRD-(\d{4})-(\d{2})-/i);
        if (matchFull) {
            return `${matchFull[1]}-${matchFull[2]}`;
        }

        const afterSlash = s.match(/[/\\](\d{2})(\d{2})-\d+/);
        if (afterSlash) {
            return `20${afterSlash[1]}-${afterSlash[2]}`;
        }

        const start = s.match(/^(\d{2})(\d{2})-\d+/);
        if (start) {
            return `20${start[1]}-${start[2]}`;
        }
    } catch (e) {
        return null;
    }
    return null;
}

/** FY from serial_no first, else production_code (same YYZZ rules). Not from project_code. */
function getFinancialYearFromProductionRow(prod) {
    if (!prod) return null;
    const serial = String(prod.serial_no || '').trim();
    if (serial) {
        const fy = getFinancialYearFromProductionCode(serial);
        if (fy) return fy;
    }
    const code = String(prod.production_code || '').trim();
    return code ? getFinancialYearFromProductionCode(code) : null;
}

// Helper function to normalize time format
function normalizeTimeFormat(timeStr) {
    if (!timeStr || timeStr === '0h' || timeStr === '-') {
        return '0h';
    }

    const hourMinPattern = /^(\d+)h\s+(\d+)m$/;
    const match = timeStr.match(hourMinPattern);

    if (match) {
        return `${timeStr} 0sec`;
    }

    const hourOnlyPattern = /^(\d+)h$/;
    const hourMatch = timeStr.match(hourOnlyPattern);
    if (hourMatch) {
        return `${timeStr} 0m 0sec`;
    }

    const minOnlyPattern = /^(\d+)m$/;
    const minMatch = timeStr.match(minOnlyPattern);
    if (minMatch) {
        return `0h ${timeStr} 0sec`;
    }

    return timeStr;
}

// Helper function to format duration as "1h 20m 23sec"
function formatDurationHHMMSS(hours, minutes, seconds) {
    const parts = [];

    if (hours > 0) {
        parts.push(`${hours}h`);
    }

    if (minutes > 0) {
        parts.push(`${minutes}m`);
    }

    if (seconds > 0) {
        parts.push(`${seconds}sec`);
    }

    if (parts.length === 0) {
        return '0h';
    }

    return parts.join(' ');
}

// Helper function to convert time string (HH:MM:SS) to seconds since midnight
function timeToSeconds(timeStr) {
    if (!timeStr || timeStr === '-' || timeStr === 'Ongoing') return null;
    const match = timeStr.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
    if (!match) return null;
    const hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2], 10);
    const seconds = parseInt(match[3], 10);
    return hours * 3600 + minutes * 60 + seconds;
}

// Helper function to calculate duration from start_time and stop_time
function calculateDurationFromTimes(startTime, stopTime) {
    if (!startTime || !stopTime || startTime === '-' || stopTime === '-' || stopTime === 'Ongoing') {
        return { hours: 0, minutes: 0, seconds: 0 };
    }

    const startMatch = startTime.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
    const stopMatch = stopTime.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);

    if (!startMatch || !stopMatch) {
        return { hours: 0, minutes: 0, seconds: 0 };
    }

    const startHours = parseInt(startMatch[1], 10);
    const startMinutes = parseInt(startMatch[2], 10);
    const startSeconds = parseInt(startMatch[3], 10);
    const stopHours = parseInt(stopMatch[1], 10);
    const stopMinutes = parseInt(stopMatch[2], 10);
    const stopSeconds = parseInt(stopMatch[3], 10);

    const startTotalSeconds = startHours * 3600 + startMinutes * 60 + startSeconds;
    const stopTotalSeconds = stopHours * 3600 + stopMinutes * 60 + stopSeconds;

    if (stopTotalSeconds <= startTotalSeconds) {
        return { hours: 0, minutes: 0, seconds: 0 };
    }

    const durationSeconds = stopTotalSeconds - startTotalSeconds;
    const hours = Math.floor(durationSeconds / 3600);
    const minutes = Math.floor((durationSeconds % 3600) / 60);
    const seconds = durationSeconds % 60;

    return { hours, minutes, seconds };
}

// Normalize date to YYYY-MM-DD for grouping (same date = same calendar day)
function normalizeDateKey(dateVal) {
    if (dateVal == null || dateVal === '') return null;
    const s = String(dateVal).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.substring(0, 10);
    const d = new Date(s);
    if (!isNaN(d.getTime())) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    }
    return null;
}

// Compute union of intervals (each [start, end] in seconds); returns total union seconds.
// Used per-date so overlap is only within the same day.
function unionSecondsForIntervals(intervals) {
    if (!intervals || intervals.length === 0) return 0;
    const sorted = intervals.slice().sort((a, b) => a[0] - b[0]);
    let union = 0;
    let start = sorted[0][0];
    let end = sorted[0][1];
    for (let i = 1; i < sorted.length; i++) {
        const [s, e] = sorted[i];
        if (s < end) {
            end = Math.max(end, e);
        } else {
            union += (end - start);
            start = s;
            end = e;
        }
    }
    union += (end - start);
    return union;
}

// Helper function to calculate common/overlapping time between all entries
function calculateCommonTime(timesheets) {
    const intervals = timesheets
        .map((entry) => {
            const start = timeToSeconds(entry.start_time);
            const stop = timeToSeconds(entry.stop_time);
            if (start !== null && stop !== null && stop > start) return [start, stop];
            return null;
        })
        .filter(Boolean);

    if (intervals.length === 0) return { hours: 0, minutes: 0, seconds: 0 };

    const totalSeconds = intervals.reduce((sum, [start, stop]) => sum + (stop - start), 0);

    intervals.sort((a, b) => a[0] - b[0]);

    let unionSeconds = 0;
    let currentStart = intervals[0][0];
    let currentEnd = intervals[0][1];

    for (let i = 1; i < intervals.length; i++) {
        const [nextStart, nextEnd] = intervals[i];
        if (nextStart < currentEnd) {
            currentEnd = Math.max(currentEnd, nextEnd);
        } else {
            unionSeconds += (currentEnd - currentStart);
            currentStart = nextStart;
            currentEnd = nextEnd;
        }
    }
    unionSeconds += (currentEnd - currentStart);

    const totalOverlapSeconds = Math.max(0, totalSeconds - unionSeconds);

    const hours = Math.floor(totalOverlapSeconds / 3600);
    const minutes = Math.floor((totalOverlapSeconds % 3600) / 60);
    const seconds = totalOverlapSeconds % 60;
    return { hours, minutes, seconds };
}

// Helper function to calculate net_time for a project from its timesheets
async function calculateProjectNetTime(projectCode) {
    try {
        const timesheetsResult = await pool.query(
            'SELECT start_time, stop_time, date FROM "TIMESHEET" WHERE project_code = $1',
            [projectCode]
        );

        if (timesheetsResult.rows.length > 0) {
            // Use worker thread for heavy calculation if there are many timesheets
            if (timesheetsResult.rows.length > 50) {
                try {
                    const result = await workerPool.execute('timesheet-calculations.worker.js', {
                        timesheets: timesheetsResult.rows,
                        operation: 'calculateNetTimeByDate'
                    });

                    if (result.success && result.result) {
                        const { hours, minutes, seconds } = result.result;
                        return formatDurationHHMMSS(hours, minutes, seconds);
                    }
                } catch (workerError) {
                    console.warn(`[calculateProjectNetTime] Worker thread error, falling back to main thread:`, workerError);
                }
            }

            // Main thread: group by date; only same date + overlapping time counts as overlap (union per date, summed)
            const byDate = new Map();
            let noDateIndex = 0;
            for (const entry of timesheetsResult.rows) {
                const start = timeToSeconds(entry.start_time);
                const stop = timeToSeconds(entry.stop_time);
                if (start === null || stop === null || stop <= start) continue;
                const dateKey = normalizeDateKey(entry.date) || `__no_date_${noDateIndex++}`;
                if (!byDate.has(dateKey)) byDate.set(dateKey, []);
                byDate.get(dateKey).push([start, stop]);
            }

            let netTotalSeconds = 0;
            for (const intervals of byDate.values()) {
                netTotalSeconds += unionSecondsForIntervals(intervals);
            }

            const netHours = Math.floor(netTotalSeconds / 3600);
            const netMinutes = Math.floor((netTotalSeconds % 3600) / 60);
            const netSecs = netTotalSeconds % 60;

            return formatDurationHHMMSS(netHours, netMinutes, netSecs);
        }

        const projectResult = await pool.query(
            'SELECT net_time FROM "PROJECT" WHERE project_code = $1',
            [projectCode]
        );

        if (projectResult.rows.length > 0 && projectResult.rows[0].net_time) {
            const dbNetTime = projectResult.rows[0].net_time;
            return normalizeTimeFormat(dbNetTime);
        }

        return '0h';
    } catch (error) {
        console.error(`[calculateProjectNetTime] Error calculating net time for project ${projectCode}:`, error);
        return '0h';
    }
}

// Helper function to calculate work_hour for a project from its timesheets
async function calculateProjectWorkHour(projectCode) {
    try {
        const result = await pool.query(
            'SELECT start_time, stop_time FROM "TIMESHEET" WHERE project_code = $1',
            [projectCode]
        );

        if (result.rows.length > 0) {
            let totalSeconds = 0;
            result.rows.forEach((row) => {
                const s = timeToSeconds(row.start_time);
                const e = timeToSeconds(row.stop_time);
                if (s !== null && e !== null && e > s) {
                    totalSeconds += (e - s);
                }
            });

            const h = Math.floor(totalSeconds / 3600);
            const m = Math.floor((totalSeconds % 3600) / 60);
            const s = totalSeconds % 60;
            return formatDurationHHMMSS(h, m, s);
        }

        const proj = await pool.query('SELECT work_hour FROM "PROJECT" WHERE project_code = $1', [projectCode]);
        return proj.rows[0]?.work_hour ? normalizeTimeFormat(proj.rows[0].work_hour) : '0h';
    } catch (error) {
        console.error(`[calculateProjectWorkHour] Error:`, error);
        return '0h';
    }
}

// Helper function to format duration as "HH:MM:SS"
function formatToHMS(hours, minutes, seconds) {
    return [hours, minutes, seconds].map(v => v.toString().padStart(2, '0')).join(':');
}

// Helper function to calculate overlapping time between two time ranges (in seconds)
function calculateOverlap(start1, end1, start2, end2) {
    const overlapStart = Math.max(start1, start2);
    const overlapEnd = Math.min(end1, end2);
    return Math.max(0, overlapEnd - overlapStart);
}

// Helper function to recalculate work_hour and net_time in the background
async function recalculateProjectTotals(projectCode) {
    if (!projectCode) return;

    // Use setImmediate to defer execution and not block the current response
    setImmediate(async () => {
        try {
         
            const startTime = Date.now();

            const workHour = await calculateProjectWorkHour(projectCode);
            const netTime = await calculateProjectNetTime(projectCode);

            await pool.query(
                'UPDATE "PROJECT" SET work_hour = $1, net_time = $2, updated_at = CURRENT_TIMESTAMP WHERE project_code = $3',
                [workHour, netTime, projectCode]
            );

            const duration = Date.now() - startTime;
          
        } catch (error) {
            console.error(`[Totals] Error recalculating totals for ${projectCode}:`, error);
        }
    });
}

// Helper function to auto-mark parent processes as done when all children are done
async function autoMarkParentProcesses(projectId, allCheckedTasks) {
    try {
        // Get project category to find process hierarchy
        const projectResult = await pool.query(
            'SELECT category FROM "PROJECT" WHERE id = $1',
            [projectId]
        );

        if (projectResult.rows.length === 0 || !projectResult.rows[0].category) {
            return allCheckedTasks; // No category, can't determine hierarchy
        }

        const categoryLetter = projectResult.rows[0].category;

        // Get all processes from this category with parent-child relationships
        const categoriesResult = await pool.query(
            `WITH RECURSIVE category_tree AS(
                SELECT id, name, parent_id, letter, 0 as level
                FROM categories
                WHERE letter = $1
                UNION ALL
                SELECT c.id, c.name, c.parent_id, c.letter, ct.level + 1
                FROM categories c
                INNER JOIN category_tree ct ON c.parent_id = ct.id
            )
            SELECT id, name, parent_id, letter FROM category_tree ORDER BY id`,
            [categoryLetter]
        );

        if (categoriesResult.rows.length === 0) {
            return allCheckedTasks; // No processes found
        }

        // Build parent-child map
        const processMap = new Map();
        const childrenMap = new Map(); // parent_id -> [child_ids]

        categoriesResult.rows.forEach(cat => {
            processMap.set(cat.id.toString(), {
                id: cat.id.toString(),
                name: cat.name,
                parent_id: cat.parent_id ? cat.parent_id.toString() : null
            });

            if (cat.parent_id) {
                const parentId = cat.parent_id.toString();
                if (!childrenMap.has(parentId)) {
                    childrenMap.set(parentId, []);
                }
                childrenMap.get(parentId).push(cat.id.toString());
            }
        });

        // First, remove parents that don't have all children checked
        let updatedTasks = [...allCheckedTasks];
        let hasChanges = true;

        // Keep checking until no more changes
        while (hasChanges) {
            hasChanges = false;
            const tasksSet = new Set(updatedTasks);

            // Remove parents that don't have all children checked
            for (const [parentId, childIds] of childrenMap.entries()) {
                if (tasksSet.has(parentId)) {
                    // Check if all children are checked
                    const allChildrenChecked = childIds.length > 0 &&
                        childIds.every((childId) => tasksSet.has(childId));

                    if (!allChildrenChecked) {
                        // Remove parent if not all children are checked
                        updatedTasks = updatedTasks.filter(t => t !== parentId);
                        tasksSet.delete(parentId);
                        hasChanges = true;
                        
                    }
                }
            }

            // Then, add parents that have all children checked
            for (const [parentId, childIds] of childrenMap.entries()) {
                // Skip if parent is already checked
                if (tasksSet.has(parentId)) continue;

                // Check if all children are checked
                const allChildrenChecked = childIds.length > 0 &&
                    childIds.every((childId) => tasksSet.has(childId));

                if (allChildrenChecked) {
                    updatedTasks.push(parentId);
                    tasksSet.add(parentId);
                    hasChanges = true;
                
                }
            }
        }

        return updatedTasks;
    } catch (error) {
        console.error('[Auto - Mark Parent] Error:', error);
        return allCheckedTasks; // Return original on error
    }
}

/** Normalize process IDs from API body (array, JSON string, or comma-separated string). */
function parseProcessIdsToArray(value) {
    if (value == null || value === '') return [];
    if (Array.isArray(value)) {
        return value.map((x) => parseInt(x, 10)).filter((n) => !isNaN(n));
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return [];
        if (trimmed.startsWith('[')) {
            try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) {
                    return parsed.map((x) => parseInt(x, 10)).filter((n) => !isNaN(n));
                }
            } catch {
                /* fall through to comma split */
            }
        }
        return trimmed.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
    }
    const n = parseInt(value, 10);
    return isNaN(n) ? [] : [n];
}

/**
 * Expand selected top-level process IDs to include all descendant child process IDs
 * (same logic as frontend collectProjectProcessIds).
 */
async function expandProcessIdsWithDescendants(categoryLetter, selectedIds) {
    const selectedNum = parseProcessIdsToArray(selectedIds);
    if (selectedNum.length === 0) return [];

    const letter = categoryLetter != null ? String(categoryLetter).trim() : '';
    if (!letter) return selectedNum;

    const rootResult = await pool.query(
        'SELECT id FROM categories WHERE letter = $1 AND parent_id IS NULL LIMIT 1',
        [letter]
    );
    if (rootResult.rows.length === 0) return selectedNum;
    const rootId = rootResult.rows[0].id;

    const treeResult = await pool.query(
        `WITH RECURSIVE category_tree AS (
            SELECT id, parent_id FROM categories WHERE parent_id = $1
            UNION ALL
            SELECT c.id, c.parent_id
            FROM categories c
            INNER JOIN category_tree ct ON c.parent_id = ct.id
        )
        SELECT id, parent_id FROM category_tree`,
        [rootId]
    );
    if (treeResult.rows.length === 0) return selectedNum;

    const childrenMap = new Map();
    treeResult.rows.forEach((row) => {
        if (!childrenMap.has(row.parent_id)) childrenMap.set(row.parent_id, []);
        childrenMap.get(row.parent_id).push(row.id);
    });

    const topLevelIds = treeResult.rows
        .filter((row) => row.parent_id === rootId)
        .map((row) => row.id);

    const collectDescendants = (id, acc) => {
        acc.add(id);
        (childrenMap.get(id) || []).forEach((childId) => collectDescendants(childId, acc));
    };

    const selectedSet = new Set(selectedNum);
    const resultSet = new Set();
    topLevelIds.forEach((topId) => {
        if (selectedSet.has(topId)) collectDescendants(topId, resultSet);
    });

    return resultSet.size > 0 ? Array.from(resultSet) : selectedNum;
}

/** Resolve PCB project_id and expanded process IDs from request payload. */
async function resolvePcbProcessData({ project_code, process_ids }) {
    let category = null;
    let projectId = null;
    if (project_code) {
        const projectResult = await pool.query(
            'SELECT id, category FROM "PROJECT" WHERE project_code = $1 LIMIT 1',
            [project_code]
        );
        if (projectResult.rows.length > 0) {
            category = projectResult.rows[0].category;
            projectId = projectResult.rows[0].id;
        }
    }

    const selectedIds = parseProcessIdsToArray(process_ids);
    const finalIds =
        selectedIds.length > 0
            ? await expandProcessIdsWithDescendants(category, selectedIds)
            : selectedIds;

    return {
        projectId,
        processIdsStr: finalIds.length > 0 ? finalIds.map(String).join(',') : null,
        pcbProcessIds: finalIds
    };
}

/** Merge multiple process ID inputs into a unique sorted array. */
function mergeProcessIdArrays(...values) {
    const set = new Set();
    values.forEach((value) => {
        parseProcessIdsToArray(value).forEach((id) => set.add(id));
    });
    return Array.from(set).sort((a, b) => a - b);
}

/**
 * Keep each PCB process-checked row independent.
 * Never copy one PCB's process list onto other PCBs in the same project.
  * Does not rewrite checked_id — process add/remove must not wipe
 * descendant task checks. Drops leftover empty-scope aggregate rows.
 */
async function syncProjectProcessCheckedTotal(projectId) {
    const pid = parseInt(projectId, 10);
    if (!Number.isFinite(pid) || pid <= 0) return null;

    const projectResult = await pool.query(
        `SELECT id, project_code
         FROM "PROJECT" WHERE id = $1 LIMIT 1`,
        [pid],
    );
    if (projectResult.rows.length === 0) {
        await pool.query(
            'DELETE FROM projects_process_checked WHERE project_id = $1',
            [pid],
        );
        return null;
    }

 

    await pool.query(
        `DELETE FROM projects_process_checked
         WHERE project_id = $1
           AND COALESCE(TRIM(main_or_pcb_id), '') = ''`,
        [pid],
    );

  
    return null;
      
}

/** @deprecated Use syncProjectProcessCheckedTotal — kept for existing call sites. */
async function createProjectProcessChecked(projectId) {
    return syncProjectProcessCheckedTotal(projectId);
}

/** @deprecated Use syncProjectProcessCheckedTotal — kept for existing call sites. */
async function appendProjectProcessChecked(projectId) {
    return syncProjectProcessCheckedTotal(projectId);
}

async function getProjectProcessChecked(projectId, scope = MAIN_PROCESS_SCOPE) {
    if (!projectId) return null;
    const scopeKey = scope == null ? MAIN_PROCESS_SCOPE : String(scope).trim();
    const result = await pool.query(
        `SELECT *
         FROM projects_process_checked
         WHERE project_id = $1
           AND main_or_pcb_id = $2
         LIMIT 1`,
        [projectId, scopeKey || MAIN_PROCESS_SCOPE],
    );
    return result.rows[0] || null;
}

/**
 * Add/remove individual checked process IDs for a project (other checked IDs are kept).
 */
async function updateProjectProcessCheckedIds(
    projectId,
    projectCode,
    { addIds = [], removeIds = [] } = {},
    scope = MAIN_PROCESS_SCOPE,
) {
    if (!projectId) return null;
    const scopeKey = scope == null ? MAIN_PROCESS_SCOPE : String(scope).trim();
    const toAdd = parseProcessIdsToArray(addIds);
    const toRemove = new Set(parseProcessIdsToArray(removeIds));
    if (toAdd.length === 0 && toRemove.size === 0) return null;

    const existing = await pool.query(
        `SELECT id, checked_id, total_process_id
         FROM projects_process_checked
         WHERE project_id = $1
           AND main_or_pcb_id = $2
         LIMIT 1`,
        [projectId, scopeKey || MAIN_PROCESS_SCOPE],
    );

    const current = existing.rows.length > 0
        ? parseProcessIdsToArray(existing.rows[0].checked_id)
        : [];
    const nextSet = new Set(current);
    toRemove.forEach((id) => nextSet.delete(id));
    toAdd.forEach((id) => nextSet.add(id));
    const nextChecked = Array.from(nextSet).sort((a, b) => a - b);

    if (existing.rows.length === 0) {
        if (scopeKey === MAIN_PROCESS_SCOPE) {
            await createMainProjectProcessChecked({
                projectId,
                projectCode,
                processIds: [],
            });
        } else {
            await syncProjectProcessCheckedTotal(projectId);
        }
        const refreshed = await pool.query(
            `SELECT id, checked_id, total_process_id
             FROM projects_process_checked
             WHERE project_id = $1
               AND main_or_pcb_id = $2
             LIMIT 1`,
            [projectId, scopeKey || MAIN_PROCESS_SCOPE],
        );
        if (refreshed.rows.length === 0) return null;
        existing.rows[0] = refreshed.rows[0];
    }

    const result = await pool.query(
        `UPDATE projects_process_checked
         SET checked_id = $1::jsonb,
             project_code = COALESCE($2, project_code),
             updated_at = CURRENT_TIMESTAMP
         WHERE project_id = $3
           AND main_or_pcb_id = $4
         RETURNING *`,
        [
            JSON.stringify(nextChecked),
            projectCode || null,
            projectId,
            scopeKey || MAIN_PROCESS_SCOPE,
        ],
    );
    return result.rows[0] || null;
}

/** Toggle one process ID in projects_process_checked.checked_id. */
async function toggleProjectProcessCheckedId(
    projectId,
    projectCode,
    processId,
    checked,
    scope = MAIN_PROCESS_SCOPE,
) {
    const id = parseInt(processId, 10);
    if (!projectId || isNaN(id)) return null;
    return updateProjectProcessCheckedIds(
        projectId,
        projectCode,
        {
            addIds: checked ? [id] : [],
            removeIds: checked ? [] : [id],
        },
        scope,
    );
}

/**
 * Compute net time from timesheet rows with per-date rule (same date + same time = overlap).
 * Used by timesheet summary API. Rows must have date, start_time, stop_time.
 */
function netTimeByDateFromTimesheets(timesheets) {
    if (!timesheets || timesheets.length === 0) return { hours: 0, minutes: 0, seconds: 0 };
    const byDate = new Map();
    let noDateIndex = 0;
    for (const entry of timesheets) {
        const start = timeToSeconds(entry.start_time);
        const stop = timeToSeconds(entry.stop_time);
        if (start === null || stop === null || stop <= start) continue;
        const dateKey = normalizeDateKey(entry.date) || `__no_date_${noDateIndex++}`;
        if (!byDate.has(dateKey)) byDate.set(dateKey, []);
        byDate.get(dateKey).push([start, stop]);
    }
    let netTotalSeconds = 0;
    for (const intervals of byDate.values()) {
        netTotalSeconds += unionSecondsForIntervals(intervals);
    }
    return {
        hours: Math.floor(netTotalSeconds / 3600),
        minutes: Math.floor((netTotalSeconds % 3600) / 60),
        seconds: netTotalSeconds % 60
    };
}

export {
    getFinancialYearFromProjectCode,
    getFinancialYearFromProductionCode,
    getFinancialYearFromProductionRow,
    normalizeTimeFormat,
    formatDurationHHMMSS,
    formatToHMS,
    timeToSeconds,
    calculateDurationFromTimes,
    calculateOverlap,
    calculateCommonTime,
    netTimeByDateFromTimesheets,
    calculateProjectNetTime,
    calculateProjectWorkHour,
    recalculateProjectTotals,
    autoMarkParentProcesses,
    parseProcessIdsToArray,
    expandProcessIdsWithDescendants,
    resolvePcbProcessData,
    mergeProcessIdArrays,
    syncProjectProcessCheckedTotal,
    createProjectProcessChecked,
    appendProjectProcessChecked,
    getProjectProcessChecked,
    updateProjectProcessCheckedIds,
    toggleProjectProcessCheckedId,
};
