import { pool } from '../../config/db.js';

const SKIP_FIELDS = new Set(['id', 'created_at', 'updated_at']);

export const initializePcbLogTable = async () => {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS pcb_log (
            id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            pcb_id BIGINT NOT NULL,
            pcb_code VARCHAR(100),
            project_id BIGINT,
            project_pcb_version_id BIGINT,
            field_name VARCHAR(100) NOT NULL,
            old_value TEXT,
            new_value TEXT,
            updated_by VARCHAR(100),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_pcb_log_pcb_id
            ON pcb_log(pcb_id, created_at DESC);

        ALTER TABLE pcb_log
            ADD COLUMN IF NOT EXISTS project_id BIGINT;

        ALTER TABLE pcb_log
            ADD COLUMN IF NOT EXISTS project_pcb_version_id BIGINT;

        CREATE INDEX IF NOT EXISTS idx_pcb_log_project_id
            ON pcb_log(project_id, created_at DESC);
    `);
};

function toLogText(value) {
    if (value == null) return '';
    const text =
        typeof value === 'object' ? JSON.stringify(value) : String(value);
    return text.length > 1000 ? `${text.slice(0, 1000)}…` : text;
}

export async function insertPcbFieldLogs({
    pcbId,
    pcbCode,
    projectId = null,
    projectPcbVersionId = null,
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

    if (!rows.length || !pcbId) return [];

    const values = [];
    const placeholders = rows.map((row, index) => {
        const base = index * 8;
        values.push(
            pcbId,
            pcbCode || null,
            projectId || null,
            projectPcbVersionId || null,
            row.field,
            row.oldValue,
            row.newValue,
            updatedBy || null,
        );
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`;
    });

    const result = await pool.query(
        `
        INSERT INTO pcb_log (
            pcb_id,
            pcb_code,
            project_id,
            project_pcb_version_id,
            field_name,
            old_value,
            new_value,
            updated_by
        )
        VALUES ${placeholders.join(', ')}
        RETURNING id, pcb_id, pcb_code, project_id, project_pcb_version_id,
            field_name, old_value, new_value, updated_by, created_at
        `,
        values,
    );
    return result.rows;
}

export async function findPcbLogs(pcbId) {
    const id = Number(pcbId);
    if (!Number.isFinite(id) || id <= 0) return [];
    const result = await pool.query(
        `
        SELECT
            log.id,
            log.pcb_id,
            log.pcb_code,
            COALESCE(
                version.project_code,
                NULLIF(BTRIM(pcb.project_code), '')
            ) AS project_code,
            log.field_name,
            log.old_value,
            log.new_value,
            log.updated_by,
            log.created_at
        FROM pcb_log log
        LEFT JOIN "PCB" pcb ON pcb.id = log.pcb_id
        LEFT JOIN LATERAL (
            SELECT ppv.project_code
            FROM project_pcb_version ppv
            WHERE ppv.pcb_id = log.pcb_id
              AND (
                    ppv.id = log.project_pcb_version_id
                    OR (
                        log.project_pcb_version_id IS NULL
                        AND (
                            log.project_id IS NULL
                            OR ppv.project_id = log.project_id
                        )
                    )
              )
            ORDER BY
                CASE WHEN ppv.id = log.project_pcb_version_id THEN 0 ELSE 1 END,
                ppv.id DESC
            LIMIT 1
        ) version ON TRUE
        WHERE log.pcb_id = $1
        ORDER BY log.created_at DESC, log.id DESC
        `,
        [id],
    );
    return result.rows;
}
