import { pool } from '../../config/db.js';

/**
 * Duration as whole seconds in HH:MM:SS (no fractional part, hours can pass 24: "26:03:04").
 * Works for an interval column or any interval expression; NULL stays NULL.
 */
const durationTextSql = (expr = 'duration') =>
    `make_interval(secs => floor(EXTRACT(EPOCH FROM ${expr}))::double precision)::text`;

/** Create/verify the task_status_history table. */
export async function initializeTaskStatusHistoryTable() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS task_status_history (
            id SERIAL PRIMARY KEY,
            task_id INTEGER NOT NULL,
            date DATE NOT NULL DEFAULT CURRENT_DATE,
            old_status VARCHAR(50),
            new_status VARCHAR(50),
            user_name VARCHAR(255),
            duration INTERVAL,
            reason TEXT,
            created_at TIMESTAMP DEFAULT date_trunc('second', LOCALTIMESTAMP)
        );

        -- Every status change keeps its OWN reason (reject / on hold / stopped / review note), so a
        -- task that is rejected, resubmitted, rejected again and put on hold has one row each time.
        ALTER TABLE task_status_history ADD COLUMN IF NOT EXISTS reason TEXT;

        -- Who performed the status change (user id).
        ALTER TABLE task_status_history ADD COLUMN IF NOT EXISTS performed_by INTEGER;

        -- Lock: once a history row has a reason, it can never be changed or cleared by an UPDATE.
        -- (A row without a reason can still receive one, e.g. the one-time backfill.)
        CREATE OR REPLACE FUNCTION task_status_history_keep_reason() RETURNS trigger AS $$
        BEGIN
            IF OLD.reason IS NOT NULL THEN
                NEW.reason := OLD.reason;
            END IF;
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;

        DROP TRIGGER IF EXISTS trg_task_status_history_keep_reason ON task_status_history;
        CREATE TRIGGER trg_task_status_history_keep_reason
            BEFORE UPDATE ON task_status_history
            FOR EACH ROW EXECUTE PROCEDURE task_status_history_keep_reason();

        -- reason_type is no longer used (the "(Rejected)" label is worked out from old -> new status).
        ALTER TABLE task_status_history DROP COLUMN IF EXISTS reason_type;

        -- Existing tables: new rows get whole seconds (no .9 fraction).
        ALTER TABLE task_status_history
            ALTER COLUMN created_at SET DEFAULT date_trunc('second', LOCALTIMESTAMP);

        CREATE INDEX IF NOT EXISTS idx_task_status_history_task_id
            ON task_status_history(task_id);
        CREATE INDEX IF NOT EXISTS idx_task_status_history_date
            ON task_status_history(date);
        CREATE INDEX IF NOT EXISTS idx_task_status_history_new_status
            ON task_status_history(new_status);
    `);
}

/** Create/verify the task_status_reason table (the reason given when a task goes On Hold / Stopped). */
export async function initializeTaskStatusReasonTable() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS task_status_reason (
            id SERIAL PRIMARY KEY,
            task_id INTEGER NOT NULL,
            task_serial_no VARCHAR(50),
            old_status VARCHAR(50),
            new_status VARCHAR(50),
            reason TEXT NOT NULL,
            updated_by VARCHAR(255),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_task_status_reason_task_id
            ON task_status_reason(task_id);
    `);

    // One-time, safe to repeat: copy old On Hold / Stopped reasons into the matching history row
    // (same task, same new status, saved within 10 seconds of each other).
    try {
        await pool.query(`
            UPDATE task_status_history h
            SET reason = r.reason
            FROM task_status_reason r
            WHERE h.reason IS NULL
              AND r.task_id = h.task_id
              AND LOWER(r.new_status) = LOWER(h.new_status)
              AND ABS(EXTRACT(EPOCH FROM (h.created_at - r.created_at))) <= 10
        `);
    } catch (err) {
        console.error('Backfill of task status history reasons failed:', err.message);
    }

    // One-time, safe to repeat: old rejects (Review -> In Progress with a reason) become
    // "IN PROGRESS (REJECT)". Rows already ending with "(REJECT)" are skipped.
    try {
        await pool.query(`
            UPDATE task_status_history
            SET new_status = new_status || ' (REJECT)'
            WHERE reason IS NOT NULL
              AND LOWER(TRIM(old_status)) = 'review'
              AND LOWER(TRIM(new_status)) IN ('in progress', 'running')
        `);
    } catch (err) {
        console.error('Backfill of rejected status history rows failed:', err.message);
    }
}

/**
 * Save one status reason. Skips when the task id or the reason is empty.
 * @param {{ task_id: number, task_serial_no?: string|null, old_status?: string|null, new_status?: string|null, reason?: string|null, updated_by?: string|null }} params
 * @param {import('pg').PoolClient | import('pg').Pool} [db]
 */
export async function recordTaskStatusReason(params = {}, db = pool) {
    const taskId = params.task_id != null ? parseInt(params.task_id, 10) : null;
    const reason = String(params.reason ?? '').trim();
    if (!taskId || !reason) return null;

    try {
        const result = await db.query(
            `INSERT INTO task_status_reason (
                task_id, task_serial_no, old_status, new_status, reason, updated_by
             ) VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id, task_id, task_serial_no, old_status, new_status, reason, updated_by, created_at`,
            [
                taskId,
                String(params.task_serial_no ?? '').trim() || null,
                String(params.old_status ?? '').trim() || null,
                String(params.new_status ?? '').trim() || null,
                reason,
                String(params.updated_by ?? '').trim() || null,
            ],
        );
        return result.rows[0];
    } catch (err) {
        console.error('Error recording task status reason:', err.message);
        return null;
    }
}

/**
 * Insert one status-transition row.
 * @param {{ task_id: number, date?: string, old_status?: string|null, new_status?: string|null, user_name?: string|null, performed_by?: number|null, duration?: string|null }} row
 * @param {import('pg').PoolClient | import('pg').Pool} [db]
 */
async function createTaskStatusHistory(row = {}, db = pool) {
    const durationValue =
        row.duration == null || row.duration === ''
            ? null
            : typeof row.duration === 'string'
              ? row.duration
              : String(row.duration);

    const result = await db.query(
        `INSERT INTO task_status_history (
            task_id, date, old_status, new_status, user_name, performed_by, duration, reason, created_at
         ) VALUES (
            $1,
            COALESCE($2::date, CURRENT_DATE),
            $3,
            $4,
            $5,
            $8,
            CASE
              WHEN $6::text IS NULL OR TRIM($6::text) = '' THEN NULL
              ELSE TRIM($6::text)::interval
            END,
            $7,
            date_trunc('second', LOCALTIMESTAMP)
         )
         RETURNING
            id,
            task_id,
            date,
            old_status,
            new_status,
            user_name,
            performed_by,
            ${durationTextSql()} AS duration,
            reason,
            created_at`,
        [
            row.task_id,
            row.date ?? null,
            row.old_status ?? null,
            row.new_status ?? null,
            row.user_name ?? null,
            durationValue,
            String(row.reason ?? '').trim() || null,
            row.performed_by ?? null,
        ],
    );
    return result.rows[0];
}

/**
 * Record a task status change. Computes duration from the previous entry for this task.
 * Skips when new_status is empty or unchanged (case-insensitive).
 * @param {{ task_id: number, old_status?: string|null, new_status?: string|null, user_name?: string|null, performed_by?: number|null, reason?: string|null }} params
 * @param {import('pg').PoolClient | import('pg').Pool} [db]
 */
export async function recordTaskStatusChange(params = {}, db = pool) {
    const taskId = params.task_id != null ? parseInt(params.task_id, 10) : null;
    const oldStatus = String(params.old_status ?? '').trim() || null;
    const newStatus = String(params.new_status ?? '').trim() || null;
    const userName = String(params.user_name ?? '').trim() || null;

    if (!taskId || !newStatus) return null;
    if (oldStatus && oldStatus.toLowerCase() === newStatus.toLowerCase()) {
        return null;
    }

    // Time spent in the previous status = now - the previous row's created_at.
    // Calculated INSIDE Postgres on purpose: created_at is a TIMESTAMP (no time zone), and
    // reading it into JavaScript and sending it back shifts it by the Node / database time-zone
    // difference (e.g. +05:30), which made the duration wrong. LOCALTIMESTAMP and created_at
    // (DEFAULT CURRENT_TIMESTAMP) use the same database session time zone, so they always match.
    let duration = null;
    try {
        const result = await db.query(
            // Both ends are cut to whole seconds first (the same way the Time column shows them),
            // so duration equals the difference of the displayed times
            // (11:19:10 -> 11:19:18 = 00:00:08, not 00:00:07 from flooring 7.1s).
            `SELECT ${durationTextSql('GREATEST(date_trunc(\'second\', LOCALTIMESTAMP) - date_trunc(\'second\', created_at), INTERVAL \'0\')')} AS duration
             FROM task_status_history
             WHERE task_id = $1
             ORDER BY created_at DESC, id DESC
             LIMIT 1`,
            [taskId],
        );
        const raw = result.rows[0]?.duration;
        duration = raw == null || String(raw).trim() === '' ? null : String(raw).trim();
    } catch (err) {
        console.error('Error computing task status duration:', err.message);
    }

    try {
        return await createTaskStatusHistory(
            {
                task_id: taskId,
                old_status: oldStatus,
                new_status: newStatus,
                user_name: userName,
                performed_by: params.performed_by == null ? null : parseInt(params.performed_by, 10) || null,
                duration,
                reason: params.reason ?? null,
                // date: new Date().toISOString().split('T')[0],
            },
            db,
        );
    } catch (err) {
        console.error('Error recording task status change:', err.message);
        return null;
    }
}

/**
 * List status-history rows for one task.
 */
export async function findTaskStatusHistoryByTaskId(taskId) {
    const id = parseInt(taskId, 10);
    if (!id) return [];
    const result = await pool.query(
        `SELECT
            id, task_id, date, old_status, new_status, user_name, performed_by,
            ${durationTextSql()} AS duration, reason, created_at
         FROM task_status_history
         WHERE task_id = $1
         ORDER BY created_at ASC, id ASC`,
        [id],
    );
    return result.rows;
}

/**
 * List status-history rows with optional filters + pagination.
 * @param {{ task_id?: number, page?: number, limit?: number }} filters
 */
export async function findTaskStatusHistory(filters = {}) {
    const conditions = [];
    const params = [];

    if (filters.task_id) {
        params.push(parseInt(filters.task_id, 10));
        conditions.push(`task_id = $${params.length}`);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const page = Math.max(1, parseInt(filters.page, 10) || 1);
    const limitRaw = parseInt(filters.limit, 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 1000) : null;
    const offset = limit ? (page - 1) * limit : 0;

    const countResult = await pool.query(
        `SELECT COUNT(*)::int AS count FROM task_status_history ${whereClause}`,
        params,
    );
    const total = countResult.rows[0]?.count ?? 0;

    const dataParams = [...params];
    let limitSql = '';
    if (limit) {
        dataParams.push(limit, offset);
        limitSql = ` LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`;
    }

    const dataResult = await pool.query(
        `SELECT
            id, task_id, date, old_status, new_status, user_name, performed_by,
            ${durationTextSql()} AS duration, reason, created_at
         FROM task_status_history
         ${whereClause}
         ORDER BY created_at DESC, id DESC
         ${limitSql}`,
        dataParams,
    );

    return {
        rows: dataResult.rows,
        total,
        page,
        limit,
    };
}