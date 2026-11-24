import { pool } from '../../config/db.js';

const SKIP_FIELDS = new Set(['id', 'created_at', 'updated_at']);

export const initializeProjectLogTable = async () => {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS project_log (
            id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            project_id BIGINT NOT NULL,
            project_code VARCHAR(100),
            field_name VARCHAR(100) NOT NULL,
            old_value TEXT,
            new_value TEXT,
            updated_by VARCHAR(100),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_project_log_project_id
            ON project_log(project_id, created_at DESC);
    `);
};

function toLogText(value) {
    if (value == null) return '';
    const text =
        typeof value === 'object' ? JSON.stringify(value) : String(value);
    return text.length > 1000 ? `${text.slice(0, 1000)}…` : text;
}

export async function insertProjectFieldLogs({
    projectId,
    projectCode,
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

    if (!rows.length || !projectId) return [];

    const values = [];
    const placeholders = rows.map((row, index) => {
        const base = index * 6;
        values.push(
            projectId,
            projectCode || null,
            row.field,
            row.oldValue,
            row.newValue,
            updatedBy || null,
        );
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
    });

    const result = await pool.query(
        `
        INSERT INTO project_log (
            project_id,
            project_code,
            field_name,
            old_value,
            new_value,
            updated_by
        )
        VALUES ${placeholders.join(', ')}
        RETURNING id, project_id, project_code, field_name, old_value, new_value, updated_by, created_at
        `,
        values,
    );
    return result.rows;
}

export async function findProjectLogs(projectId) {
    const id = Number(projectId);
    if (!Number.isFinite(id) || id <= 0) return [];
    const result = await pool.query(
        `
        SELECT
            id,
            project_id,
            project_code,
            NULL::text AS pcb_code,
            field_name,
            old_value,
            new_value,
            updated_by,
            created_at,
            'project'::text AS source
        FROM project_log
        WHERE project_id = $1

        UNION ALL

        SELECT
            l.id,
            l.project_id,
            ppv.project_code,
            COALESCE(NULLIF(BTRIM(l.pcb_code), ''), pcb.pcb_code) AS pcb_code,
            'PCB Version - ' || l.field_name AS field_name,
            l.old_value,
            l.new_value,
            l.updated_by,
            l.created_at,
            'pcb_version'::text AS source
        FROM pcb_log l
        LEFT JOIN "PCB" pcb
            ON pcb.id = l.pcb_id
        LEFT JOIN project_pcb_version ppv
            ON ppv.id = l.project_pcb_version_id
        WHERE l.project_id = $1
           OR ppv.project_id = $1
           OR (
                l.project_id IS NULL
                AND l.project_pcb_version_id IS NULL
                AND l.field_name = ANY($2::text[])
                AND EXISTS (
                    SELECT 1
                    FROM project_pcb_version legacy_ppv
                    WHERE legacy_ppv.project_id = $1
                      AND legacy_ppv.pcb_id = l.pcb_id
                )
           )
        ORDER BY created_at DESC, id DESC
        `,
        [
            id,
            [
                'project_id',
                'project_code',
                'pcb_id',
                'pcb_code',
                'pcb_name',
                'version',
                'status',
                'filemanager_link',
            ],
        ],
    );
    return result.rows;
}
