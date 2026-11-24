import cron from 'node-cron';
import { pool } from '../../config/db.js';
import TimesheetModel from '../../models/timesheet/timesheet.model.js';
import TimesheetLogModel from '../../models/history/timesheet-log.model.js';
import { calculateDurationFromTimes, formatDurationHHMMSS } from '../../utils/project.utils.js';
import { broadcastTimesheetUpdate } from '../../config/socket.js';

/**
 * AUTO STOP: an ongoing timesheet entry is stopped when its user has left the building.
 *
 *  - ongoing entry  = TIMESHEET row with stop_time empty / "Ongoing"
 *  - user left      = the user has NO open attendance session (exit_at IS NULL, not Expired) and the latest
 *                     attendance exit_at is AFTER the entry started
 *  - stop time      = that exit time (Asia/Kolkata). An entry from an earlier day is capped at 23:59:59 of its own day.
 *
 * A user who is still inside, or who has no attendance scan after the entry started (work from home, manual entry,
 * missing scan), is never touched.
 */

const TZ = 'Asia/Kolkata';
const AUTO_NOTE = 'Auto-stopped: user exited (attendance).';

const FIND_SQL = `
WITH ongoing AS (
    SELECT
        t.id,
        t.user_id,
        t.project_code,
        t.start_time,
        t.notes,
        LOWER(TRIM(COALESCE(NULLIF(TRIM(t.user_name), ''), pd.username))) AS uname,
        CASE
            WHEN t."date"::text ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN to_date(left(t."date"::text, 10), 'YYYY-MM-DD')
            WHEN t."date"::text ~ '^[0-9]{2}-[0-9]{2}-[0-9]{4}$' THEN to_date(t."date"::text, 'DD-MM-YYYY')
            ELSE NULL
        END AS entry_date
    FROM "TIMESHEET" t
    LEFT JOIN personal_details pd ON pd.id = t.user_id
    WHERE (t.stop_time IS NULL OR TRIM(t.stop_time) = '' OR t.stop_time = 'Ongoing')
      AND t.start_time ~ '^[0-9]{1,2}:[0-9]{2}:[0-9]{2}$'
),
cand AS (
    SELECT o.*, ((o.entry_date + o.start_time::time) AT TIME ZONE '${TZ}') AS start_ts
    FROM ongoing o
    WHERE o.entry_date IS NOT NULL AND o.uname IS NOT NULL AND o.uname <> ''
)
SELECT
    c.id, c.user_id, c.project_code, c.start_time, c.notes, c.uname,
    CASE
        WHEN (ex.exit_at AT TIME ZONE '${TZ}')::date = c.entry_date
            THEN to_char(ex.exit_at AT TIME ZONE '${TZ}', 'HH24:MI:SS')
        ELSE '23:59:59'
    END AS stop_time
FROM cand c
CROSS JOIN LATERAL (
    SELECT MAX(s.exit_at) AS exit_at
    FROM attendance_sessions s
    WHERE LOWER(TRIM(s.username)) = c.uname
      AND s.exit_at IS NOT NULL
      AND s.exit_at > c.start_ts
      AND s.exit_at <= NOW()
) ex
WHERE ex.exit_at IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM attendance_sessions s
      WHERE LOWER(TRIM(s.username)) = c.uname
        AND s.exit_at IS NULL
        AND COALESCE(LOWER(s.status), 'inside') <> 'expired'
  )
`;

const isOngoing = (stop) => {
    const v = String(stop ?? '').trim().toLowerCase();
    return v === '' || v === 'ongoing';
};

let running = false;

export async function autoStopTimesheetsForExitedUsers() {
    if (running) return 0;
    running = true;
    let stopped = 0;

    try {
        const { rows } = await pool.query(FIND_SQL);

        for (const row of rows) {
            try {
                // Re-read: the user may have stopped it by hand a moment ago.
                const before = await TimesheetModel.findById(row.id);
                if (!before || !isOngoing(before.stop_time)) continue;

                const dur = calculateDurationFromTimes(row.start_time, row.stop_time);
                // stop must be after start (calculateDurationFromTimes returns 0 otherwise)
                if (!dur.hours && !dur.minutes && !dur.seconds) continue;

                const notes = String(before.notes ?? '').trim()
                    ? `${String(before.notes).trim()}\n${AUTO_NOTE}`
                    : AUTO_NOTE;

                const updated = await TimesheetModel.update(row.id, {
                    stop_time: row.stop_time,
                    duration: formatDurationHHMMSS(dur.hours, dur.minutes, dur.seconds),
                    notes,
                });
                if (!updated) continue;

                stopped += 1;
                broadcastTimesheetUpdate('updated', { source: 'timesheet', id: updated.id, user_id: updated.user_id });

                try {
                    await TimesheetLogModel.create({
                        timesheetId: updated.id,
                        action: 'UPDATE',
                        projectCode: updated.project_code ?? before.project_code ?? null,
                        subjectUserId: updated.user_id ?? before.user_id ?? null,
                        subjectUsername: row.uname,
                        actorUserId: null,
                        actorUsername: 'SYSTEM',
                        oldValue: { stop_time: before.stop_time ?? null, notes: before.notes ?? null },
                        newValue: { stop_time: row.stop_time, notes, message: 'Auto-stopped: user exited (attendance)' },
                    });
                } catch (logErr) {
                    console.error('Auto-stop timesheet log failed:', logErr.message || logErr);
                }

                console.log(`✅ Timesheet ${row.id} auto-stopped at ${row.stop_time} (${row.uname} exited)`);
            } catch (rowErr) {
                console.error(`Auto-stop timesheet ${row.id} failed:`, rowErr.message || rowErr);
            }
        }
    } catch (err) {
        console.error('Auto-stop timesheet error:', err.message || err);
    } finally {
        running = false;
    }

    return stopped;
}

console.log('✅ Auto Stop Timesheet Cron Started');
cron.schedule('* * * * *', () => {
    void autoStopTimesheetsForExitedUsers();
});