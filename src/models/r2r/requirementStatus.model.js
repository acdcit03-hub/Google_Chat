import { pool } from '../../config/db.js';

/** Create/verify REQUIREMENT_STATUS table. */
export async function initializeRequirementStatusTable() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS "REQUIREMENT_STATUS" (
            id SERIAL PRIMARY KEY,
            serial_number VARCHAR(50),
            date DATE NOT NULL DEFAULT CURRENT_DATE,
            old_status VARCHAR(100),
            new_status VARCHAR(100),
            time TIME NOT NULL DEFAULT CURRENT_TIME,
            duration INTERVAL,
            username VARCHAR(255),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        ALTER TABLE "REQUIREMENT_STATUS"
        ADD COLUMN IF NOT EXISTS username VARCHAR(255);

        CREATE INDEX IF NOT EXISTS idx_requirement_status_serial_number
            ON "REQUIREMENT_STATUS"(serial_number);
        CREATE INDEX IF NOT EXISTS idx_requirement_status_date
            ON "REQUIREMENT_STATUS"(date);
        CREATE INDEX IF NOT EXISTS idx_requirement_status_created_at
            ON "REQUIREMENT_STATUS"(created_at);
        CREATE INDEX IF NOT EXISTS idx_requirement_status_new_status
            ON "REQUIREMENT_STATUS"(new_status);
        CREATE INDEX IF NOT EXISTS idx_requirement_status_username
            ON "REQUIREMENT_STATUS"(LOWER(TRIM(username)));
    `);
    console.log('✅ REQUIREMENT_STATUS table ready');
}

/**
 * Insert a status transition row.
 * @param {{ serial_number?: string, date?: string, old_status?: string|null, new_status?: string|null, time?: string, duration?: string|null, username?: string|null }} row
 * @param {import('pg').PoolClient | import('pg').Pool} [db]
 */
export async function createRequirementStatus(row = {}, db = pool) {
    const durationValue =
        row.duration == null || row.duration === ''
            ? null
            : typeof row.duration === 'string'
              ? row.duration
              : // node-pg Interval / object → text Postgres can cast
                String(row.duration);

    const username =
        row.username == null || String(row.username).trim() === ''
            ? null
            : String(row.username).trim();

    const result = await db.query(
        `INSERT INTO "REQUIREMENT_STATUS" (
            serial_number, date, old_status, new_status, time, duration, username
         ) VALUES (
            $1,
            COALESCE($2::date, CURRENT_DATE),
            $3,
            $4,
            COALESCE($5::time, CURRENT_TIME),
            CASE
              WHEN $6::text IS NULL OR TRIM($6::text) = '' THEN NULL
              ELSE TRIM($6::text)::interval
            END,
            $7
         )
         RETURNING
            id,
            serial_number,
            date,
            old_status,
            new_status,
            time,
            duration::text AS duration,
            username,
            created_at`,
        [
            row.serial_number ?? null,
            row.date ?? null,
            row.old_status ?? null,
            row.new_status ?? null,
            row.time ?? null,
            durationValue,
            username,
        ],
    );
    return result.rows[0];
}

/**
 * Record a status change. Computes duration from the previous entry for this serial.
 * Skips when new_status is empty or unchanged (case-insensitive).
 * Used for REQUIREMENT.status and qtyreservation_status timeline
 * (e.g. Receive Done → Pending Reserve → Qty Reserved → …).
 * @param {{ serial_number?: string|null, old_status?: string|null, new_status?: string|null, username?: string|null }} params
 * @param {import('pg').PoolClient | import('pg').Pool} [db]
 */
export async function recordRequirementStatusChange(params = {}, db = pool) {
    const serial = String(params.serial_number ?? '').trim();
    const oldStatus = String(params.old_status ?? '').trim() || null;
    const newStatus = String(params.new_status ?? '').trim() || null;
    const username =
        params.username == null || String(params.username).trim() === ''
            ? null
            : String(params.username).trim();

    if (!serial || !newStatus) return null;
    if (
        oldStatus &&
        oldStatus.toLowerCase() === newStatus.toLowerCase()
    ) {
        return null;
    }

    let duration = null;
    try {
        const last = await db.query(
            `SELECT created_at
             FROM "REQUIREMENT_STATUS"
             WHERE serial_number = $1
             ORDER BY created_at DESC, id DESC
             LIMIT 1`,
            [serial],
        );
        if (last.rows[0]?.created_at) {
            // Always return text so INSERT binding works on all hosts/pg versions
            const durationResult = await db.query(
                `SELECT (NOW() - $1::timestamptz)::text AS duration`,
                [last.rows[0].created_at],
            );
            const raw = durationResult.rows[0]?.duration;
            duration =
                raw == null || String(raw).trim() === ''
                    ? null
                    : String(raw).trim();
        }
    } catch (err) {
        console.error('Error computing requirement status duration:', err.message);
    }

    try {
        return await createRequirementStatus(
            {
                serial_number: serial,
                old_status: oldStatus,
                new_status: newStatus,
                duration,
                username,
            },
            db,
        );
    } catch (err) {
        console.error('Error recording requirement status change:', err.message);
        return null;
    }
}

/**
 * Record qtyreservation_status on the same REQUIREMENT_STATUS timeline
 * (after Receive Done when Pending Reserve starts, then later reservation steps).
 * @param {{
 *   serial_number?: string|null,
 *   old_qtyreservation_status?: string|null,
 *   new_qtyreservation_status?: string|null,
 *   fallback_old_status?: string|null,
 *   username?: string|null,
 * }} params
 * @param {import('pg').PoolClient | import('pg').Pool} [db]
 */
export async function recordQtyReservationStatusChange(params = {}, db = pool) {
    const next = String(params.new_qtyreservation_status ?? '').trim();
    if (!next) return null;

    const prevRaw = String(params.old_qtyreservation_status ?? '').trim();
    const fallback = String(params.fallback_old_status ?? '').trim();
    const oldStatus = prevRaw || fallback || null;

    return recordRequirementStatusChange(
        {
            serial_number: params.serial_number,
            old_status: oldStatus,
            new_status: next,
            username: params.username ?? null,
        },
        db,
    );
}

/**
 * Receive Issue is stored only when BOTH requirement status and order_status
 * are "Receive Issue". If the timeline still ends on an earlier status
 * (for example Receive Done), append that step.
 * @param {{ serial_number?: string|null, status?: string|null, order_status?: string|null }} requirement
 * @param {string|null} [username]
 * @param {import('pg').PoolClient | import('pg').Pool} [db]
 */
export async function ensureReceiveIssueStatusHistory(
    requirement = {},
    username = null,
    db = pool,
) {
    const status = String(requirement.status ?? '').trim().toLowerCase();
    const orderStatus = String(requirement.order_status ?? '').trim().toLowerCase();
    if (status !== 'receive issue' || orderStatus !== 'receive issue') {
        return null;
    }

    const serial = String(requirement.serial_number ?? '').trim();
    if (!serial) return null;

    const last = await db.query(
        `SELECT new_status
         FROM "REQUIREMENT_STATUS"
         WHERE serial_number = $1
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
        [serial],
    );
    const lastStatus = String(last.rows[0]?.new_status ?? '').trim();
    if (lastStatus.toLowerCase() === 'receive issue') return null;

    return recordRequirementStatusChange(
        {
            serial_number: serial,
            old_status: lastStatus || null,
            new_status: 'Receive Issue',
            username,
        },
        db,
    );
}

export async function findRequirementStatusBySerial(serialNumber) {
    const serial = String(serialNumber ?? '').trim();
    if (!serial) return [];
    const result = await pool.query(
        `SELECT
            id,
            serial_number,
            date,
            old_status,
            new_status,
            time,
            duration::text AS duration,
            username,
            created_at
         FROM "REQUIREMENT_STATUS"
         WHERE serial_number = $1
         ORDER BY created_at ASC, id ASC`,
        [serial],
    );
    return result.rows;
}

/**
 * List requirement status rows with optional filters.
 * @param {{ serial_number?: string, page?: number, limit?: number }} filters
 */
export async function findRequirementStatuses(filters = {}) {
    const conditions = [];
    const params = [];
    const serial = String(filters.serial_number ?? '').trim();

    if (serial) {
        params.push(serial);
        conditions.push(`serial_number = $${params.length}`);
    }

    const whereClause = conditions.length
        ? `WHERE ${conditions.join(' AND ')}`
        : '';

    const page = Math.max(1, parseInt(filters.page, 10) || 1);
    const limitRaw = parseInt(filters.limit, 10);
    const limit =
        Number.isFinite(limitRaw) && limitRaw > 0
            ? Math.min(limitRaw, 1000)
            : null;
    const offset = limit ? (page - 1) * limit : 0;

    const countResult = await pool.query(
        `SELECT COUNT(*)::int AS count
         FROM "REQUIREMENT_STATUS"
         ${whereClause}`,
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
            id,
            serial_number,
            date,
            old_status,
            new_status,
            time,
            duration::text AS duration,
            username,
            created_at
         FROM "REQUIREMENT_STATUS"
         ${whereClause}
         ORDER BY created_at DESC, id DESC
         ${limitSql}`,
        dataParams,
    );

    return {
        rows: dataResult.rows,
        total,
        page,
        limit: limit ?? total,
    };
}

export default {
    initializeRequirementStatusTable,
    createRequirementStatus,
    recordRequirementStatusChange,
    ensureReceiveIssueStatusHistory,
    recordQtyReservationStatusChange,
    findRequirementStatusBySerial,
    findRequirementStatuses,
};
