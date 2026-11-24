import { pool } from '../../config/db.js';

const SKIP_FIELDS = new Set(['id', 'created_at', 'updated_at']);

export const initializeProductionLogTable = async () => {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS production_log (
            id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            production_id BIGINT NOT NULL,
            production_code VARCHAR(100),
            field_name VARCHAR(100) NOT NULL,
            old_value TEXT,
            new_value TEXT,
            updated_by VARCHAR(100),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_production_log_production_id
            ON production_log(production_id, created_at DESC);
    `);
};

function toLogText(value) {
    if (value == null) return '';
    const text =
        typeof value === 'object' ? JSON.stringify(value) : String(value);
    return text.length > 1000 ? `${text.slice(0, 1000)}…` : text;
}

export async function insertProductionFieldLogs({
    productionId,
    productionCode,
    changed,
    updatedBy,
}) {
    const columns = Array.isArray(changed?.columns) ? changed.columns : [];
    const rows = columns
        .map((field) => String(field || '').trim())
        .filter((field) => field && !SKIP_FIELDS.has(field))
        .map((field) => ({
            field,
            oldValue: toLogText(changed.oldValue?.[field]),
            newValue: toLogText(changed.newValue?.[field]),
        }))
        .filter((row) => row.oldValue !== row.newValue);

    if (!rows.length || !productionId) return [];

    const values = [];
    const placeholders = rows.map((row, index) => {
        const base = index * 6;
        values.push(
            productionId,
            productionCode || null,
            row.field,
            row.oldValue,
            row.newValue,
            updatedBy || null,
        );
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
    });

    const result = await pool.query(
        `
        INSERT INTO production_log (
            production_id,
            production_code,
            field_name,
            old_value,
            new_value,
            updated_by
        )
        VALUES ${placeholders.join(', ')}
        RETURNING id, production_id, production_code, field_name, old_value, new_value, updated_by, created_at
        `,
        values,
    );
    return result.rows;
}

export async function findProductionLogs(productionId) {
    const id = Number(productionId);
    if (!Number.isFinite(id) || id <= 0) return [];
    const result = await pool.query(
        `
        SELECT
            id,
            production_id,
            production_code,
            field_name,
            old_value,
            new_value,
            updated_by,
            created_at
        FROM production_log
        WHERE production_id = $1
        ORDER BY created_at DESC, id DESC
        `,
        [id],
    );
    return result.rows;
}
