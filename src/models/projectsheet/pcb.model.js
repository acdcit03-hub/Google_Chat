import { pool } from '../../config/db.js';
import {
    parseFinancialYearFilter,
    buildCodeMmyyFinancialYearSql,
    getCurrentFinancialYearBounds,
} from '../../utils/financial-year.utils.js';
import { appendScopeCondition } from '../../utils/dataScope.utils.js';

/**
 * Standard project codes: length 15 or 17, no spaces, single word
 * (e.g. 002SRLIGV011024, 034RAECERGV010826).
 */
function isStandardProjectCode(code) {
    const value = String(code ?? '').trim();
    if (!value) return false;
    if (/\s/.test(value)) return false;
    if (value.split(/\s+/).length !== 1) return false;
    return value.length === 15 || value.length === 17;
}

/**
 * Unique Projects: non-standard codes only
 * (anything that is NOT 15/17-char single-word, and not empty).
 */
function isUniqueProjectCode(code) {
    const value = String(code ?? '').trim();
    if (!value) return false;
    return !isStandardProjectCode(value);
}

/** SQL: non-empty project_code that is NOT a standard 15/17-char code. */
const UNIQUE_PROJECT_CODE_SQL = `(
    TRIM(COALESCE(pcb.project_code, '')) <> ''
    AND NOT (
        TRIM(pcb.project_code) !~ '\\s'
        AND CHAR_LENGTH(TRIM(pcb.project_code)) IN (15, 17)
    )
)`;

function buildPcbFilterConditions(filters = {}) {
    const {
        project_code,
        pcb_code,
        project_name,
        created_by,
        financialYear,
        scopeUsernames,
        /** When true, FY uses project_code MMYY (project timeline bulk). Default: pcb_code. */
        fyFromProjectCode = false,
        /** Skip FY entirely (project tab all=true + current-year). */
        skipFinancialYear = false,
        /** One PCB per distinct non-standard (not 15/17) project_code. */
        uniqueProjects = false,
    } = filters;
    const conditions = [];
    const params = [];

    if (project_code) {
        conditions.push(`pcb.project_code ILIKE $${params.length + 1}`);
        params.push(`%${project_code}%`);
    }
    if (pcb_code) {
        conditions.push(`pcb.pcb_code ILIKE $${params.length + 1}`);
        params.push(`%${pcb_code}%`);
    }
    if (project_name) {
        params.push(`%${project_name}%`);
        conditions.push(
            `(p.project_name ILIKE $${params.length} OR pcb.project_name ILIKE $${params.length})`,
        );
    }
    if (created_by) {
        conditions.push(`pcb.created_by ILIKE $${params.length + 1}`);
        params.push(`%${created_by}%`);
    }
    appendScopeCondition(conditions, params, {
        scopeUsernames,
        mode: 'exact',
        columnExpr: 'pcb.created_by',
    });

    // Unique Projects: exclude standard 15/17-char codes; show the rest.
    if (uniqueProjects) {
        conditions.push(UNIQUE_PROJECT_CODE_SQL);
    }

    // FY from last-4 MMYY of pcb_code (e.g. …0426 …0327 for 2026-27)
    if (!skipFinancialYear && financialYear && String(financialYear).trim().toLowerCase() !== 'all') {
        const fy = parseFinancialYearFilter(financialYear);
        if (fy) {
            const startIdx = params.length + 1;
            const endIdx = params.length + 2;
            params.push(fy.startYearShort, fy.endYearShort);
            const codeExpr = fyFromProjectCode
                ? `COALESCE(NULLIF(TRIM(pcb.project_code), ''), pcb.pcb_code)`
                : `pcb.pcb_code`;
            conditions.push(buildCodeMmyyFinancialYearSql(codeExpr, startIdx, endIdx));
        }
    }

    return { conditions, params };
}

class PCBModel {
    // Optimized: Support all filters with parallel count query capability
    static async findAll(filters = {}) {
        const {
            limit, offset, page, all,
            project_code, pcb_code, project_name, created_by, financialYear,
            fyFromProjectCode, skipFinancialYear, uniqueProjects,
        } = filters;

        const actualLimit = all === 'true' ? 10000 : (parseInt(limit) || 10);
        const actualOffset = (offset !== undefined && !isNaN(offset) && offset >= 0)
            ? offset
            : ((parseInt(page, 10) || 1) - 1) * actualLimit;

        const { conditions, params: baseParams } = buildPcbFilterConditions({
            project_code,
            pcb_code,
            project_name,
            created_by,
            financialYear,
            fyFromProjectCode,
            skipFinancialYear,
            uniqueProjects,
        });

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const projectKeyExpr = `LOWER(TRIM(pcb.project_code))`;

        let query;
        if (uniqueProjects) {
            // One PCB per distinct non-standard (not 15/17) project_code.
            query = `
                SELECT * FROM (
                    SELECT DISTINCT ON (${projectKeyExpr})
                        pcb.*,
                        p.project_name as project_name_from_project,
                        p.id as project_id
                    FROM "PCB" pcb
                    LEFT JOIN "PROJECT" p ON pcb.project_code = p.project_code
                    ${whereClause}
                    ORDER BY ${projectKeyExpr}, pcb.id DESC
                ) unique_pcbs
                ORDER BY unique_pcbs.id DESC
            `;
        } else {
            const orderBy = project_code
                ? 'ORDER BY pcb.section_index ASC NULLS LAST, pcb.id DESC'
                : 'ORDER BY pcb.id DESC';

            query = `
                SELECT 
                    pcb.*,
                    p.project_name as project_name_from_project,
                    p.id as project_id
                FROM "PCB" pcb
                LEFT JOIN "PROJECT" p ON pcb.project_code = p.project_code
                ${whereClause}
                ${orderBy}
            `;
        }

        // Handle pagination if not fetching all
        if (all !== 'true') {
            query += ` LIMIT $${baseParams.length + 1} OFFSET $${baseParams.length + 2}`;
            baseParams.push(actualLimit, actualOffset);
        }

        const result = await pool.query(query, baseParams);

        // Ensure project_name is the one from PROJECT table if available
        return result.rows.map(row => ({
            ...row,
            project_name: row.project_name_from_project || row.project_name || ''
        }));
    }

    // Optimized: Parallel count query
    static async count(filters = {}) {
        const {
            project_code, pcb_code, project_name, created_by, financialYear,
            fyFromProjectCode, skipFinancialYear, uniqueProjects,
        } = filters;

        const { conditions, params: baseParams } = buildPcbFilterConditions({
            project_code,
            pcb_code,
            project_name,
            created_by,
            financialYear,
            fyFromProjectCode,
            skipFinancialYear,
            uniqueProjects,
        });

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const countExpr = uniqueProjects
            ? `COUNT(DISTINCT LOWER(TRIM(pcb.project_code)))`
            : `COUNT(*)`;

        const query = `
            SELECT ${countExpr} as total
            FROM "PCB" pcb
            LEFT JOIN "PROJECT" p ON pcb.project_code = p.project_code
            ${whereClause}
        `;

        const result = await pool.query(query, baseParams);
        return parseInt(result.rows[0].total);
    }

    static async findById(id) {
        const result = await pool.query('SELECT * FROM "PCB" WHERE id = $1', [id]);
        return result.rows[0];
    }

    /** Load multiple PCBs by id (order not guaranteed). */
    static async findByIds(ids = []) {
        const clean = [
            ...new Set(
                (Array.isArray(ids) ? ids : [])
                    .map((id) => Number(id))
                    .filter((id) => Number.isFinite(id) && id > 0)
                    .map((id) => Math.trunc(id)),
            ),
        ];
        if (clean.length === 0) return [];
        const result = await pool.query(
            `SELECT * FROM "PCB" WHERE id = ANY($1::bigint[])`,
            [clean],
        );
        return result.rows;
    }

    static async create(pcbData) {
        let { pcb_code, project_id, project_code, project_name, link, pcb_photo, created_by, section_index, process_map } = pcbData;
        const sectionIndex = section_index != null && !isNaN(Number(section_index)) ? parseInt(section_index, 10) : 2;
        let resolvedProjectId =
            project_id != null && !isNaN(Number(project_id)) && Number(project_id) > 0
                ? parseInt(String(project_id), 10)
                : null;

        // Sync project_id / project_name from PROJECT table based on project_code
        if (project_code) {
            const projectResult = await pool.query(
                'SELECT id, project_name FROM "PROJECT" WHERE project_code = $1 LIMIT 1',
                [project_code],
            );
            if (projectResult.rows.length > 0) {
                project_name = projectResult.rows[0].project_name;
                if (resolvedProjectId == null) {
                    resolvedProjectId = projectResult.rows[0].id;
                }
            }
        }

        const result = await pool.query(`
            INSERT INTO "PCB" (pcb_code, project_id, project_code, project_name, link, pcb_photo, created_by, section_index, process_map)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
      RETURNING *
        `, [pcb_code, resolvedProjectId, project_code, project_name, link, pcb_photo, created_by, sectionIndex, JSON.stringify(process_map ?? {})]);
        return result.rows[0];
    }

    static async update(id, pcbData) {
        let { pcb_code, project_id, project_code, project_name, link, pcb_photo, section_index, process_map } = pcbData || {};
        const pid = id != null ? (typeof id === 'number' ? id : parseInt(String(id), 10)) : null;
        if (pid == null || isNaN(pid)) return null;

        let resolvedProjectId =
            project_id !== undefined
                ? (project_id != null && !isNaN(Number(project_id)) && Number(project_id) > 0
                    ? parseInt(String(project_id), 10)
                    : null)
                : undefined;

        if (project_code !== undefined && project_code) {
            const projectResult = await pool.query(
                'SELECT id, project_name FROM "PROJECT" WHERE project_code = $1 LIMIT 1',
                [project_code],
            );
            if (projectResult.rows.length > 0) {
                project_name = projectResult.rows[0].project_name;
                if (resolvedProjectId === undefined || resolvedProjectId == null) {
                    resolvedProjectId = projectResult.rows[0].id;
                }
            }
        }

        const sectionIndexVal = section_index !== undefined && !isNaN(Number(section_index)) ? parseInt(section_index, 10) : undefined;
        const result = await pool.query(`
      UPDATE "PCB" SET
        pcb_code = COALESCE($1, pcb_code),
        project_id = CASE WHEN $2::boolean THEN $3 ELSE project_id END,
        project_code = COALESCE($4, project_code), project_name = COALESCE($5, project_name),
        link = COALESCE($6, link), pcb_photo = COALESCE($7, pcb_photo),
        section_index = COALESCE($8, section_index), updated_at = CURRENT_TIMESTAMP
                , process_map = COALESCE($9::jsonb, process_map)
    WHERE id = $10
      RETURNING *
    `, [
            pcb_code ?? null,
            resolvedProjectId !== undefined,
            resolvedProjectId ?? null,
            project_code ?? null, project_name ?? null, link ?? null, pcb_photo ?? null,
            sectionIndexVal ?? null,
            process_map === undefined ? null : JSON.stringify(process_map ?? {}),
            pid
        ]);
        return result.rows[0];
    }

    static async delete(id) {
        const result = await pool.query('DELETE FROM "PCB" WHERE id = $1 RETURNING id', [id]);
        return result.rows[0];
    }

    static async getStats(filters = {}) {
        const { financialYear, scopeUsernames } = filters;
        const { conditions, params } = buildPcbFilterConditions({
            ...filters,
            scopeUsernames,
            // Stats "total" respects selected FY; currentYear always counted separately below.
            financialYear:
                financialYear && String(financialYear).trim().toLowerCase() !== 'all'
                    ? financialYear
                    : undefined,
        });
        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const result = await pool.query(`
            SELECT
                pcb.pcb_code,
                pcb.project_code
            FROM "PCB" pcb
            LEFT JOIN "PROJECT" p ON pcb.project_code = p.project_code
            ${whereClause}
        `, params);

        const rows = result.rows;
        const currentBounds = getCurrentFinancialYearBounds();
        const currentFyLabel = currentBounds.yearCode;

        let currentYear = 0;
        const projectCodes = new Set();

        for (const row of rows) {
            const projectCode = String(row.project_code ?? '').trim();
            // Unique Projects: non-standard codes only (not 15/17-char).
            if (isUniqueProjectCode(projectCode)) {
                projectCodes.add(projectCode.toLowerCase());
            }

            const pcbCode = String(row.pcb_code ?? '').trim();
            if (pcbCode.length < 4) continue;
            const last4 = pcbCode.slice(-4);
            if (!/^\d{4}$/.test(last4)) continue;
            const mm = parseInt(last4.substring(0, 2), 10);
            const yy = parseInt(last4.substring(2, 4), 10);
            const inCurrent =
                (mm >= 4 && mm <= 12 && yy === currentBounds.startYear % 100) ||
                (mm >= 1 && mm <= 3 && yy === currentBounds.endYear % 100);
            if (inCurrent) currentYear += 1;
        }

        // If stats were already scoped to a FY, currentYear within that set;
        // when no FY filter, recount current FY from all PCBs for the card.
        if (!financialYear || String(financialYear).trim().toLowerCase() === 'all') {
            const fy = parseFinancialYearFilter('current-year');
            if (fy) {
                const curParams = [fy.startYearShort, fy.endYearShort];
                const curSql = `
                    SELECT COUNT(*)::int AS total
                    FROM "PCB" pcb
                    WHERE ${buildCodeMmyyFinancialYearSql('pcb.pcb_code', 1, 2)}
                `;
                const curResult = await pool.query(curSql, curParams);
                currentYear = Number(curResult.rows[0]?.total) || 0;
            }
        }

        return {
            total: rows.length,
            uniqueProjects: projectCodes.size,
            currentYear,
            currentFy: currentFyLabel,
        };
    }
}

export default PCBModel;
