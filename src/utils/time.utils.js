import { pool } from '../config/db.js';

const IST_TIMEZONE = 'Asia/Kolkata';

/** SQL expression: store wall-clock IST (not UTC) into TIMESTAMP columns. */
const IST_SQL_NOW = `TIMEZONE('${IST_TIMEZONE}', CURRENT_TIMESTAMP)`;

/**
 * Current wall-clock time in IST (Asia/Kolkata) as `YYYY-MM-DD HH:mm:ss`.
 * Use for QTY_RESERVATION remove_date / review_date (not UTC ISO).
 */
function nowIstTimestamp() {
  return new Date()
    .toLocaleString('sv-SE', { timeZone: IST_TIMEZONE })
    .replace('T', ' ')
    .slice(0, 19);
}

/**
 * Format a Date / ISO string / IST wall-clock string as `YYYY-MM-DD HH:mm:ss` in IST.
 * Use when serializing TIMESTAMP columns for API responses (node-pg returns Date → JSON uses UTC Z).
 */
function toIstTimestampString(value) {
  if (value == null || value === '') return value;

  const s = String(value).trim();
  if (
    /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s) &&
    !s.endsWith('Z') &&
    !/[+-]\d{2}:?\d{2}$/.test(s)
  ) {
    return s.replace('T', ' ').slice(0, 19);
  }

  const d = value instanceof Date ? value : new Date(s);
  if (Number.isNaN(d.getTime())) return value;

  return d
    .toLocaleString('sv-SE', { timeZone: IST_TIMEZONE })
    .replace('T', ' ')
    .slice(0, 19);
}

/**
 * Helper to convert HH:MM:SS string to seconds
 */
function timeToSeconds(timeStr) {
    if (!timeStr || timeStr === '-' || timeStr === 'Ongoing') return null;
    const match = timeStr.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
    if (!match) return null;
    return parseInt(match[1], 10) * 3600 + parseInt(match[2], 10) * 60 + parseInt(match[3], 10);
}

/**
 * Formats seconds into HHh MMm SSsec or similar
 */
function formatDuration(totalSeconds) {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;

    if (h > 0) return `${h}h ${m}m ${s}sec`;
    if (m > 0) return `${m}m ${s}sec`;
    return `${s}sec`;
}

/**
 * Formats seconds into HH:MM:SS
 */
function formatDurationHMS(totalSeconds) {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    return [h, m, s].map(v => v.toString().padStart(2, '0')).join(':');
}

/**
 * Normalize date to YYYY-MM-DD for grouping (same date = same calendar day)
 */
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

/**
 * Union of intervals [[start,end],...] in seconds.
 */
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

/**
 * Optimized calculation of project totals (O(n log n)).
 * Net time: only same date + overlapping time counts as overlap (union per date, summed).
 */
async function calculateProjectTotals(projectCode) {
    try {
        const result = await pool.query(
            'SELECT start_time, stop_time, date FROM "TIMESHEET" WHERE project_code = $1',
            [projectCode]
        );

        if (result.rows.length === 0) return { workHour: '0h', netTime: '0h' };

        const byDate = new Map();
        let totalSeconds = 0;
        let noDateIndex = 0;

        for (const row of result.rows) {
            const s = timeToSeconds(row.start_time);
            const e = timeToSeconds(row.stop_time);
            if (s !== null && e !== null && e > s) {
                totalSeconds += (e - s);
                const dateKey = normalizeDateKey(row.date) || `__no_date_${noDateIndex++}`;
                if (!byDate.has(dateKey)) byDate.set(dateKey, []);
                byDate.get(dateKey).push([s, e]);
            }
        }

        if (byDate.size === 0) return { workHour: formatDuration(totalSeconds), netTime: '0h' };

        // Net time = sum of union per date (overlap only within same date)
        let netTotalSeconds = 0;
        for (const intervals of byDate.values()) {
            netTotalSeconds += unionSecondsForIntervals(intervals);
        }

        return {
            workHour: formatDuration(totalSeconds),
            netTime: formatDuration(netTotalSeconds)
        };
    } catch (error) {
        console.error('Error in calculateProjectTotals:', error);
        return { workHour: '0h', netTime: '0h' };
    }
}

/**
 * Background update of project totals
 */
function triggerRecalculate(projectCode) {
    if (!projectCode) return;
    setImmediate(async () => {
        const { workHour, netTime } = await calculateProjectTotals(projectCode);
        await pool.query(
            'UPDATE "PROJECT" SET work_hour = $1, net_time = $2, updated_at = CURRENT_TIMESTAMP WHERE project_code = $3',
            [workHour, netTime, projectCode]
        );
    });
}

/**
 * Format common file-manager timestamp fields for API responses (no UTC `Z`).
 */
function withIstTimestamps(row) {
    if (!row || typeof row !== 'object') return row;
    const out = { ...row };
    for (const key of [
        'created_at',
        'updated_at',
        'deleted_at',
        'assigned_at',
        'latest_deleted_at',
    ]) {
        if (Object.prototype.hasOwnProperty.call(out, key) && out[key] != null) {
            out[key] = toIstTimestampString(out[key]);
        }
    }
    return out;
}

export {
    nowIstTimestamp,
    toIstTimestampString,
    withIstTimestamps,
    IST_TIMEZONE,
    IST_SQL_NOW,
    timeToSeconds,
    formatDuration,
    formatDurationHMS,
    calculateProjectTotals,
    triggerRecalculate
};
