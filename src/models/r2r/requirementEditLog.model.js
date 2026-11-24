import { pool } from '../../config/db.js';

const SKIP_EDIT_LOG_FIELDS = new Set([
    'updated_at',
    'created_at',
    'sr.no',
    'sr_no',
]);

/**
 * Create/verify REQUIREMENT_EDIT_LOG table.
 * Tracks field-level edits on REQUIREMENT rows.
 */
export async function initializeRequirementEditLogTable() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS "REQUIREMENT_EDIT_LOG" (
            id SERIAL PRIMARY KEY,
            requirement_id INTEGER NOT NULL,
            serial_number VARCHAR(100),
            action VARCHAR(50) DEFAULT 'UPDATE',
            edited_by VARCHAR(255),
            edited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            field_name VARCHAR(255),
            old_value TEXT,
            new_value TEXT,
            CONSTRAINT fk_requirement_edit_log
                FOREIGN KEY (requirement_id)
                REFERENCES "REQUIREMENT"("sr.no")
                ON DELETE CASCADE
        );
    `);

    await pool.query(`
        ALTER TABLE "REQUIREMENT_EDIT_LOG"
        ADD COLUMN IF NOT EXISTS serial_number VARCHAR(100);
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_requirement_edit_log_requirement_id
            ON "REQUIREMENT_EDIT_LOG"(requirement_id);
        CREATE INDEX IF NOT EXISTS idx_requirement_edit_log_serial_number
            ON "REQUIREMENT_EDIT_LOG"(serial_number);
        CREATE INDEX IF NOT EXISTS idx_requirement_edit_log_edited_at
            ON "REQUIREMENT_EDIT_LOG"(edited_at DESC);
        CREATE INDEX IF NOT EXISTS idx_requirement_edit_log_edited_by
            ON "REQUIREMENT_EDIT_LOG"(LOWER(TRIM(edited_by)));
    `);

    console.log('✅ REQUIREMENT_EDIT_LOG table ready');
}

function toEditLogText(value) {
    if (value === undefined || value === null) return null;
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object') {
        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    }
    return String(value);
}

function normalizeForCompare(value) {
    if (value === undefined || value === null) return null;
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object') {
        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed === '' ? null : trimmed;
    }
    return String(value);
}

/**
 * Insert one edit-log row.
 */
export async function addRequirementEditLog(row = {}, db = pool) {
    const requirementId = Number(row.requirement_id);
    if (!Number.isFinite(requirementId) || requirementId <= 0) {
        throw new Error('requirement_id is required');
    }

    const result = await db.query(
        `
        INSERT INTO "REQUIREMENT_EDIT_LOG" (
            requirement_id,
            serial_number,
            action,
            edited_by,
            field_name,
            old_value,
            new_value
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
        `,
        [
            requirementId,
            row.serial_number != null && String(row.serial_number).trim() !== ''
                ? String(row.serial_number).trim()
                : null,
            row.action || 'UPDATE',
            row.edited_by != null ? String(row.edited_by).trim() : null,
            row.field_name != null ? String(row.field_name).trim() : null,
            toEditLogText(row.old_value),
            toEditLogText(row.new_value),
        ],
    );
    return result.rows[0];
}

/**
 * Diff before/after REQUIREMENT rows and insert one log row per changed field.
 */
export async function logRequirementFieldChanges(opts = {}, db = pool) {
    const {
        requirement_id,
        serial_number = null,
        edited_by = null,
        action = 'UPDATE',
        before = {},
        after = {},
        fields = null,
    } = opts;

    const requirementId = Number(requirement_id);
    if (!Number.isFinite(requirementId) || requirementId <= 0) {
        return [];
    }

    const keys = Array.isArray(fields) && fields.length
        ? fields
        : Array.from(
            new Set([
                ...Object.keys(before || {}),
                ...Object.keys(after || {}),
            ]),
        );

    const serial =
        serial_number != null && String(serial_number).trim() !== ''
            ? String(serial_number).trim()
            : (after?.serial_number || before?.serial_number || null);

    const inserted = [];
    for (const field of keys) {
        if (!field || SKIP_EDIT_LOG_FIELDS.has(field)) continue;

        const oldRaw = before?.[field];
        const newRaw = after?.[field];
        const oldNorm = normalizeForCompare(oldRaw);
        const newNorm = normalizeForCompare(newRaw);

        // Skip unchanged
        if (oldNorm === newNorm) continue;

        // Only log real edits: previous value must already exist (not empty → filled)
        if (oldNorm == null) continue;
        // Also skip clear-to-empty noise (optional but keeps "both sides present")
        if (newNorm == null) continue;

        try {
            const row = await addRequirementEditLog(
                {
                    requirement_id: requirementId,
                    serial_number: serial,
                    action,
                    edited_by,
                    field_name: field,
                    old_value: oldRaw,
                    new_value: newRaw,
                },
                db,
            );
            inserted.push(row);
        } catch (err) {
            console.error(
                `REQUIREMENT_EDIT_LOG insert failed (${field}):`,
                err?.message || err,
            );
        }
    }
    return inserted;
}

/**
 * List edit logs with optional filters.
 */
export async function getRequirementEditLogs(filters = {}) {
    const page = Math.max(1, Number(filters.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(filters.limit) || 50));
    const offset = (page - 1) * limit;

    const conditions = [];
    const params = [];

    if (filters.requirement_id != null && filters.requirement_id !== '') {
        params.push(Number(filters.requirement_id));
        conditions.push(`requirement_id = $${params.length}`);
    }
    if (filters.serial_number) {
        params.push(String(filters.serial_number).trim());
        conditions.push(`serial_number ILIKE $${params.length}`);
    }
    if (filters.edited_by) {
        params.push(String(filters.edited_by).trim().toLowerCase());
        conditions.push(`LOWER(TRIM(edited_by)) = $${params.length}`);
    }
    if (filters.field_name) {
        params.push(String(filters.field_name).trim());
        conditions.push(`field_name ILIKE $${params.length}`);
    }

    const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRes = await pool.query(
        `SELECT COUNT(*)::int AS total FROM "REQUIREMENT_EDIT_LOG" ${whereSql}`,
        params,
    );

    params.push(limit, offset);
    const listRes = await pool.query(
        `
        SELECT
            id,
            requirement_id,
            serial_number,
            action,
            edited_by,
            edited_at,
            field_name,
            old_value,
            new_value
        FROM "REQUIREMENT_EDIT_LOG"
        ${whereSql}
        ORDER BY edited_at DESC, id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}
        `,
        params,
    );

    return {
        total: countRes.rows[0]?.total || 0,
        page,
        limit,
        data: listRes.rows,
    };
}

export default {
    initializeRequirementEditLogTable,
    addRequirementEditLog,
    logRequirementFieldChanges,
    getRequirementEditLogs,
};
