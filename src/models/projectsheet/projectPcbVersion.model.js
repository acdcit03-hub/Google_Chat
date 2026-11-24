import { pool } from '../../config/db.js';
import { pickChangedColumns } from '../../utils/audit.utils.js';
import { insertPcbFieldLogs } from './pcbLog.model.js';

const LOGGED_FIELDS = [
    'project_id',
    'project_code',
    'pcb_id',
    'pcb_code',
    'pcb_name',
    'version',
    'status',
    'filemanager_link',
];

async function logVersionChanges(before, after, updatedBy) {
    const changed = pickChangedColumns(before, after, LOGGED_FIELDS);
    if (!changed.columns.length) return;

    await insertPcbFieldLogs({
        pcbId: before.pcb_id,
        pcbCode: before.pcb_code,
        projectId: before.project_id,
        projectPcbVersionId: before.id,
        changed,
        updatedBy,
    });
}

/* ================= CREATE TABLE ================= */
export const initializeProjectPcbVersionTable = async () => {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS project_pcb_version (
            id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            project_id BIGINT NOT NULL,
            project_code VARCHAR(100) NOT NULL,
            pcb_id BIGINT NOT NULL,
            pcb_code VARCHAR(50) NOT NULL,
            pcb_name VARCHAR(100) NOT NULL,
            version VARCHAR(20) NOT NULL,
            status BOOLEAN NOT NULL DEFAULT TRUE,
            filemanager_link TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_project_pcb_version_project_id
            ON project_pcb_version(project_id);

        CREATE INDEX IF NOT EXISTS idx_project_pcb_version_pcb_id
            ON project_pcb_version(pcb_id);

        CREATE INDEX IF NOT EXISTS idx_project_pcb_version_project_code
            ON project_pcb_version(LOWER(TRIM(project_code)));

        CREATE INDEX IF NOT EXISTS idx_project_pcb_version_pcb_code
            ON project_pcb_version(LOWER(TRIM(pcb_code)));

        CREATE INDEX IF NOT EXISTS idx_project_pcb_version_status
            ON project_pcb_version(status);
    `);

    // Allow the same PCB version string on multiple project assignments
    await pool.query(`
        DROP INDEX IF EXISTS uq_project_pcb_version_pcb_version;
    `);

    await pool.query(`
        ALTER TABLE project_pcb_version
            ADD COLUMN IF NOT EXISTS filemanager_link TEXT;
    `);
};

const FILEMANAGER_LINK_SELECT = `
    COALESCE(
        NULLIF(BTRIM(ppv.filemanager_link), ''),
        (
            SELECT '/fileManager/folders/' || i.public_id
            FROM file_manager_items i
            WHERE i.is_deleted = FALSE
              AND i.public_id IS NOT NULL
              AND BTRIM(i.public_id) <> ''
              AND UPPER(BTRIM(COALESCE(i.project_code, ''))) = UPPER(BTRIM(ppv.project_code))
              AND UPPER(BTRIM(COALESCE(i.name, ''))) = UPPER(
                    BTRIM(ppv.project_code) || '_' || BTRIM(ppv.pcb_code)
                  )
            ORDER BY i.id
            LIMIT 1
        )
    ) AS filemanager_link
`;

const SELECT_WITH_PCB_PROCESS = `
    SELECT
        ppv.id,
        ppv.project_id,
        ppv.project_code,
        ppv.pcb_id,
        ppv.pcb_code,
        ppv.pcb_name,
        ppv.version,
        ppv.status,
        ${FILEMANAGER_LINK_SELECT},
        pcb.process_map AS process_map
    FROM project_pcb_version ppv
    LEFT JOIN "PCB" pcb ON pcb.id = ppv.pcb_id
`;

function parseId(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

function toBool(value, fallback = true) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    const s = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on', 'active'].includes(s)) return true;
    if (['0', 'false', 'no', 'n', 'off', 'inactive'].includes(s)) return false;
    return fallback;
}

function normalizeVersion(value) {
    return String(value ?? '')
        .trim()
        .slice(0, 20);
}

function normalizeFileManagerLink(value) {
    if (value == null) return null;
    const text = String(value).trim();
    return text ? text.slice(0, 2000) : null;
}

function readFileManagerLink(data) {
    if (!data || typeof data !== 'object') return undefined;
    if (data.filemanager_link !== undefined) return data.filemanager_link;
    if (data.filemanagerLink !== undefined) return data.filemanagerLink;
    if (data.filemanagerlink !== undefined) return data.filemanagerlink;
    if (data.filemangerlink !== undefined) return data.filemangerlink;
    return undefined;
}

function buildFilters(filters = {}, { tableAlias = 'ppv' } = {}) {
    const {
        project_id,
        project_code,
        pcb_id,
        pcb_code,
        version,
        status,
    } = filters;

    const conditions = [];
    const params = [];
    const col = (name) => (tableAlias ? `${tableAlias}.${name}` : name);

    const pid = parseId(project_id);
    if (pid) {
        params.push(pid);
        conditions.push(`${col('project_id')} = $${params.length}`);
    }

    const pcbId = parseId(pcb_id);
    if (pcbId) {
        params.push(pcbId);
        conditions.push(`${col('pcb_id')} = $${params.length}`);
    }

    if (project_code != null && String(project_code).trim() !== '') {
        params.push(`%${String(project_code).trim()}%`);
        conditions.push(`${col('project_code')} ILIKE $${params.length}`);
    }

    if (pcb_code != null && String(pcb_code).trim() !== '') {
        params.push(`%${String(pcb_code).trim()}%`);
        conditions.push(`${col('pcb_code')} ILIKE $${params.length}`);
    }

    if (version != null && String(version).trim() !== '') {
        params.push(normalizeVersion(version));
        conditions.push(
            `LOWER(TRIM(${col('version')})) = LOWER($${params.length})`,
        );
    }

    if (status !== undefined && status !== null && status !== '') {
        params.push(toBool(status, true));
        conditions.push(`${col('status')} = $${params.length}`);
    }

    const where =
        conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    return { where, params };
}

class ProjectPcbVersionModel {
    static async findAll(filters = {}) {
        const { limit, page, all } = filters;
        const { where, params } = buildFilters(filters, { tableAlias: 'ppv' });

        let query = `
            ${SELECT_WITH_PCB_PROCESS}
            ${where}
            ORDER BY ppv.id DESC
        `;

        if (all !== true && all !== 'true') {
            const actualLimit = Math.min(
                Math.max(parseInt(limit, 10) || 50, 1),
                500,
            );
            const actualPage = Math.max(parseInt(page, 10) || 1, 1);
            const offset = (actualPage - 1) * actualLimit;
            params.push(actualLimit, offset);
            query += ` LIMIT $${params.length - 1} OFFSET $${params.length}`;
        }

        const result = await pool.query(query, params);
        return result.rows;
    }

    static async count(filters = {}) {
        const { where, params } = buildFilters(filters, { tableAlias: '' });

        const result = await pool.query(
            `SELECT COUNT(*)::int AS total FROM project_pcb_version ${where}`,
            params,
        );
        return Number(result.rows[0]?.total) || 0;
    }

    static async findById(id) {
        const rowId = parseId(id);
        if (!rowId) return null;
        const result = await pool.query(
            `
            ${SELECT_WITH_PCB_PROCESS}
            WHERE ppv.id = $1
            LIMIT 1
            `,
            [rowId],
        );
        return result.rows[0] || null;
    }

    static async findByProjectId(projectId, { activeOnly = false } = {}) {
        const pid = parseId(projectId);
        if (!pid) return [];
        const params = [pid];
        // No process_map join — callers load PCB.process_map via /pcbs APIs.
        let query = `
            SELECT
                ppv.id,
                ppv.project_id,
                ppv.project_code,
                ppv.pcb_id,
                ppv.pcb_code,
                ppv.pcb_name,
                ppv.version,
                ppv.status,
                ${FILEMANAGER_LINK_SELECT}
            FROM project_pcb_version ppv
            WHERE ppv.project_id = $1
        `;
        if (activeOnly) {
            query += ` AND ppv.status = TRUE`;
        }
        query += ` ORDER BY ppv.id DESC`;
        const result = await pool.query(query, params);
        return result.rows;
    }

    static async findByPcbId(pcbId, { activeOnly = false } = {}) {
        const id = parseId(pcbId);
        if (!id) return [];
        const params = [id];
        let query = `
            ${SELECT_WITH_PCB_PROCESS}
            WHERE ppv.pcb_id = $1
        `;
        if (activeOnly) {
            query += ` AND ppv.status = TRUE`;
        }
        query += ` ORDER BY ppv.id DESC`;
        const result = await pool.query(query, params);
        return result.rows;
    }

    static async findByPcbAndVersion(pcbId, version) {
        const id = parseId(pcbId);
        const ver = normalizeVersion(version);
        if (!id || !ver) return null;
        const result = await pool.query(
            `
            ${SELECT_WITH_PCB_PROCESS}
            WHERE ppv.pcb_id = $1
              AND LOWER(TRIM(ppv.version)) = LOWER($2)
            LIMIT 1
            `,
            [id, ver],
        );
        return result.rows[0] || null;
    }

    static async create(data = {}) {
        const projectId = parseId(data.project_id);
        const pcbId = parseId(data.pcb_id);
        const projectCode = String(data.project_code ?? '').trim().slice(0, 100);
        const pcbCode = String(data.pcb_code ?? '').trim().slice(0, 50);
        const pcbName = String(data.pcb_name ?? '').trim().slice(0, 100);
        const version = normalizeVersion(data.version);
        const status = toBool(data.status, true);
        const filemanagerLink = normalizeFileManagerLink(readFileManagerLink(data));

        if (!projectId) throw new Error('project_id is required');
        if (!pcbId) throw new Error('pcb_id is required');
        if (!projectCode) throw new Error('project_code is required');
        if (!pcbCode) throw new Error('pcb_code is required');
        if (!pcbName) throw new Error('pcb_name is required');
        if (!version) throw new Error('version is required');

        const result = await pool.query(
            `
            INSERT INTO project_pcb_version (
                project_id,
                project_code,
                pcb_id,
                pcb_code,
                pcb_name,
                version,
                status,
                filemanager_link
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id
            `,
            [
                projectId,
                projectCode,
                pcbId,
                pcbCode,
                pcbName,
                version,
                status,
                filemanagerLink,
            ],
        );
        const createdId = result.rows[0]?.id;
        return createdId ? ProjectPcbVersionModel.findById(createdId) : null;
    }

    static async update(id, data = {}, updatedBy = null) {
        const rowId = parseId(id);
        if (!rowId) return null;

        const current = await ProjectPcbVersionModel.findById(rowId);
        if (!current) return null;

        const projectId =
            data.project_id !== undefined
                ? parseId(data.project_id)
                : Number(current.project_id);
        const pcbId =
            data.pcb_id !== undefined
                ? parseId(data.pcb_id)
                : Number(current.pcb_id);
        const projectCode =
            data.project_code !== undefined
                ? String(data.project_code ?? '').trim().slice(0, 100)
                : current.project_code;
        const pcbCode =
            data.pcb_code !== undefined
                ? String(data.pcb_code ?? '').trim().slice(0, 50)
                : current.pcb_code;
        const pcbName =
            data.pcb_name !== undefined
                ? String(data.pcb_name ?? '').trim().slice(0, 100)
                : current.pcb_name;
        const version =
            data.version !== undefined
                ? normalizeVersion(data.version)
                : current.version;
        const status =
            data.status !== undefined
                ? toBool(data.status, true)
                : Boolean(current.status);
        const incomingLink = readFileManagerLink(data);
        const filemanagerLink =
            incomingLink !== undefined
                ? normalizeFileManagerLink(incomingLink)
                : current.filemanager_link ?? null;

        if (!projectId || !pcbId || !projectCode || !pcbCode || !pcbName || !version) {
            throw new Error('Invalid project_pcb_version update payload');
        }

        await pool.query(
            `
            UPDATE project_pcb_version
            SET
                project_id = $1,
                project_code = $2,
                pcb_id = $3,
                pcb_code = $4,
                pcb_name = $5,
                version = $6,
                status = $7,
                filemanager_link = $8
            WHERE id = $9
            `,
            [
                projectId,
                projectCode,
                pcbId,
                pcbCode,
                pcbName,
                version,
                status,
                filemanagerLink,
                rowId,
            ],
        );
        const updated = await ProjectPcbVersionModel.findById(rowId);
        if (updated) {
            await logVersionChanges(current, updated, updatedBy);
        }
        return updated;
    }

    static async setStatus(id, status, updatedBy = null) {
        const rowId = parseId(id);
        if (!rowId) return null;
        const current = await ProjectPcbVersionModel.findById(rowId);
        if (!current) return null;

        const nextStatus = toBool(status, true);
        await pool.query(
            `
            UPDATE project_pcb_version
            SET status = $1
            WHERE id = $2
            `,
            [nextStatus, rowId],
        );
        const updated = await ProjectPcbVersionModel.findById(rowId);
        if (updated) {
            await logVersionChanges(current, updated, updatedBy);
        }
        return updated;
    }

    static async delete(id) {
        const rowId = parseId(id);
        if (!rowId) return null;
        const result = await pool.query(
            `DELETE FROM project_pcb_version WHERE id = $1 RETURNING id`,
            [rowId],
        );
        return result.rows[0] || null;
    }
}

export default ProjectPcbVersionModel;
