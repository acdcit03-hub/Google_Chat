import { pool } from '../../config/db.js';
import {
    emptyProductionStatusCounts,
    resolveProductionStatusKey,
} from '../../utils/productionStatus.utils.js';
import {
    parseFinancialYearFilter,
    financialYearToProductionCenterCode,
    buildProductionFinancialYearSql,
    isCurrentFinancialYearSelection,
} from '../../utils/financial-year.utils.js';
import { appendScopeCondition } from '../../utils/dataScope.utils.js';

function buildProductionFilterConditions(filters = {}) {
    const {
        status,
        projectCode,
        lotNo,
        pcbCode,
        productionCode,
        projectName,
        preparePerson,
        place,
        serialNoFrom,
        serialNoTo,
        scopeUsernames,
        dispatch_target_date_from,
        dispatch_target_date_to,
        dispatch_date_from,
        dispatch_date_to,
        acdc_target_date_from,
        acdc_target_date_to,
        emble_target_date_from,
        emble_target_date_to,
        completed_date_from,
        completed_date_to,
        financialYear,
    } = filters;

    const conditions = [];
    const params = [];

    const pushILike = (col, value) => {
        const raw = String(value || '').trim();
        if (!raw) return;
        params.push(`%${raw}%`);
        conditions.push(`${col} ILIKE $${params.length}`);
    };

    const varcharDateExpr = (col) => `(
      CASE
        WHEN prod.${col} IS NULL OR TRIM(prod.${col}::text) = '' THEN NULL::date
        WHEN TRIM(prod.${col}::text) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN to_date(TRIM(prod.${col}::text), 'YYYY-MM-DD')
        WHEN TRIM(prod.${col}::text) ~ '^[0-9]{2}-[0-9]{2}-[0-9]{4}$' THEN to_date(TRIM(prod.${col}::text), 'DD-MM-YYYY')
        ELSE NULL::date
      END
    )`;

    const addDateRange = (col, fromVal, toVal) => {
        const from = fromVal && String(fromVal).trim();
        const to = toVal && String(toVal).trim();
        if (!from && !to) return;
        const expr = varcharDateExpr(col);
        if (from) {
            params.push(from);
            conditions.push(`${expr} >= $${params.length}::date`);
        }
        if (to) {
            params.push(to);
            conditions.push(`${expr} <= $${params.length}::date`);
        }
    };

    const serialSeqExpr = `COALESCE(
      NULLIF(substring(TRIM(COALESCE(prod.serial_no, '')) from '(\\d+)$'), '')::int,
      0
    )`;

    const parseSerialSeq = (raw) => {
        const s = String(raw || '').trim();
        if (!s) return null;
        if (/^\d+$/.test(s)) return parseInt(s, 10);
        const m = s.match(/(\d+)$/);
        return m ? parseInt(m[1], 10) : null;
    };

    if (status) {
        params.push(status);
        conditions.push(`prod.status = $${params.length}`);
    }
    if (projectCode) {
        pushILike('prod.project_code', projectCode);
    }
    if (pcbCode) {
        pushILike('prod.pcb_code', pcbCode);
    }
    if (lotNo) {
        pushILike('prod.lot_no', lotNo);
    }
    if (productionCode) {
        pushILike('prod.production_code', productionCode);
    }
    if (projectName) {
        params.push(`%${String(projectName).trim()}%`);
        conditions.push(
            `(p.project_name ILIKE $${params.length} OR prod.project_name ILIKE $${params.length})`,
        );
    }
    if (preparePerson) {
        pushILike('prod.prepare_person', preparePerson);
    }
    appendScopeCondition(conditions, params, {
        scopeUsernames,
        mode: 'exact',
        columnExpr: 'prod.prepare_person',
    });
    if (place) {
        pushILike('prod.place', place);
    }

    const fromSeq = parseSerialSeq(serialNoFrom);
    const toSeq = parseSerialSeq(serialNoTo);
    if (fromSeq != null) {
        params.push(fromSeq);
        conditions.push(`${serialSeqExpr} >= $${params.length}`);
    }
    if (toSeq != null) {
        params.push(toSeq);
        conditions.push(`${serialSeqExpr} <= $${params.length}`);
    }

    addDateRange('dispatch_target_date', dispatch_target_date_from, dispatch_target_date_to);
    addDateRange('dispatch_date', dispatch_date_from, dispatch_date_to);
    addDateRange('acdc_target_date', acdc_target_date_from, acdc_target_date_to);
    addDateRange('emble_target_date', emble_target_date_from, emble_target_date_to);
    addDateRange('production_done_date', completed_date_from, completed_date_to);

    // FY from serial_no center code: PRD-2627-034 → 2627 = 2026-27
    // current-year: ALL current FY + older FY with Pre Production / In Production
    if (financialYear && String(financialYear).trim().toLowerCase() !== 'all') {
        const fy = parseFinancialYearFilter(financialYear);
        const center = financialYearToProductionCenterCode(fy);
        if (center) {
            params.push(center);
            const fySql = buildProductionFinancialYearSql(params.length);
            if (isCurrentFinancialYearSelection(financialYear)) {
                const statusNorm = `regexp_replace(lower(trim(coalesce(prod.status, ''))), '[-_]+', ' ', 'g')`;
                conditions.push(`(
                  (${fySql})
                  OR (
                    ${statusNorm} IN ('pre production', 'in production')
                    AND NOT (${fySql})
                  )
                )`);
            } else {
                conditions.push(fySql);
            }
        }
    }

    return { conditions, params };
}

class ProductionModel {
    // Optimized: Support all filters with parallel count query capability
    static async findAll(filters = {}) {
        const {
            limit, offset, page, all,
            status, projectCode, lotNo, pcbCode, productionCode, financialYear,
            projectName, preparePerson, place,
            serialNoFrom, serialNoTo,
            dispatch_target_date_from, dispatch_target_date_to,
            dispatch_date_from, dispatch_date_to,
            acdc_target_date_from, acdc_target_date_to,
            emble_target_date_from, emble_target_date_to,
            completed_date_from, completed_date_to,
        } = filters;

        const actualLimit = all === 'true' ? 10000 : (parseInt(limit) || 10);
        const actualOffset = (offset !== undefined && !isNaN(offset) && offset >= 0)
            ? offset
            : ((parseInt(page, 10) || 1) - 1) * actualLimit;

        const { conditions, params: baseParams } = buildProductionFilterConditions({
            status,
            projectCode,
            lotNo,
            pcbCode,
            productionCode,
            projectName,
            preparePerson,
            place,
            serialNoFrom,
            serialNoTo,
            dispatch_target_date_from,
            dispatch_target_date_to,
            dispatch_date_from,
            dispatch_date_to,
            acdc_target_date_from,
            acdc_target_date_to,
            emble_target_date_from,
            emble_target_date_to,
            completed_date_from,
            completed_date_to,
            financialYear,
        });

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        let query = `
            SELECT 
                prod.*,
                p.project_name as project_name_from_project
            FROM "PRODUCTION" prod
            LEFT JOIN "PROJECT" p ON prod.project_code = p.project_code
            ${whereClause}
            ORDER BY prod.id DESC
        `;

        // Handle pagination if not fetching all
        if (all !== 'true') {
            query += ` LIMIT $${baseParams.length + 1} OFFSET $${baseParams.length + 2}`;
            baseParams.push(actualLimit, actualOffset);
        }

        const result = await pool.query(query, baseParams);
        return result.rows.map(row => ({
            ...row,
            project_name: row.project_name_from_project || row.project_name || ''
        }));
    }

    // Optimized: Parallel count query
    static async count(filters = {}) {
        const {
            status, projectCode, lotNo, pcbCode, productionCode, financialYear,
            projectName, preparePerson, place,
            serialNoFrom, serialNoTo,
            dispatch_target_date_from, dispatch_target_date_to,
            dispatch_date_from, dispatch_date_to,
            acdc_target_date_from, acdc_target_date_to,
            emble_target_date_from, emble_target_date_to,
            completed_date_from, completed_date_to,
        } = filters;

        const { conditions, params: baseParams } = buildProductionFilterConditions({
            status,
            projectCode,
            lotNo,
            pcbCode,
            productionCode,
            projectName,
            preparePerson,
            place,
            serialNoFrom,
            serialNoTo,
            dispatch_target_date_from,
            dispatch_target_date_to,
            dispatch_date_from,
            dispatch_date_to,
            acdc_target_date_from,
            acdc_target_date_to,
            emble_target_date_from,
            emble_target_date_to,
            completed_date_from,
            completed_date_to,
            financialYear,
        });

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const query = `
            SELECT COUNT(*) as total
            FROM "PRODUCTION" prod
            LEFT JOIN "PROJECT" p ON prod.project_code = p.project_code
            ${whereClause}
        `;

        const result = await pool.query(query, baseParams);
        return parseInt(result.rows[0].total);
    }

    static async getStats(filters = {}) {
        const { financialYear, scopeUsernames } = filters;
        const { conditions, params } = buildProductionFilterConditions({
            status: filters.status,
            projectCode: filters.project_code || filters.projectCode,
            lotNo: filters.lot_no || filters.lotNo,
            pcbCode: filters.pcb_code || filters.pcbCode,
            productionCode: filters.production_code || filters.productionCode,
            projectName: filters.project_name || filters.projectName,
            preparePerson: filters.prepare_person || filters.preparePerson,
            place: filters.place,
            serialNoFrom: filters.serial_no_from || filters.serialNoFrom,
            serialNoTo: filters.serial_no_to || filters.serialNoTo,
            dispatch_target_date_from: filters.dispatch_target_date_from,
            dispatch_target_date_to: filters.dispatch_target_date_to,
            dispatch_date_from: filters.dispatch_date_from,
            dispatch_date_to: filters.dispatch_date_to,
            acdc_target_date_from: filters.acdc_target_date_from,
            acdc_target_date_to: filters.acdc_target_date_to,
            emble_target_date_from: filters.emble_target_date_from,
            emble_target_date_to: filters.emble_target_date_to,
            completed_date_from: filters.completed_date_from,
            completed_date_to: filters.completed_date_to,
            financialYear,
            scopeUsernames,
        });
        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const result = await pool.query(`
            SELECT
                prod.serial_no,
                prod.production_code,
                prod.project_code,
                prod.status
            FROM "PRODUCTION" prod
            LEFT JOIN "PROJECT" p ON prod.project_code = p.project_code
            ${whereClause}
        `, params);

        const rows = result.rows;
        const buckets = emptyProductionStatusCounts();

        for (const row of rows) {
            const statusKey = resolveProductionStatusKey(row.status);
            if (statusKey) buckets[statusKey] += 1;
        }

        return {
            total: rows.length,
            ...buckets,
        };
    }

    static async findById(id) {
        const result = await pool.query('SELECT * FROM "PRODUCTION" WHERE id = $1', [id]);
        return result.rows[0];
    }

    /**
     * Productions for a project_code, returned as rows (caller groups by pcb_code).
     * Optional pcb_code: exact match (case-insensitive) so only that PCB's rows are returned.
     */
    static async findByProjectCodeGroupedReady(projectCode, pcbCode) {
        const code = String(projectCode || '').trim();
        if (!code) {
            return [];
        }

        const pcb = String(pcbCode || '').trim();
        const params = [code];
        let pcbFilter = '';

        if (pcb) {
            params.push(pcb);
            pcbFilter = ` AND LOWER(TRIM(COALESCE(prod.pcb_code, ''))) = LOWER(TRIM($${params.length}))`;
        }

        const result = await pool.query(
            `
            SELECT
                prod.*,
                p.project_name AS project_name_from_project
            FROM "PRODUCTION" prod
            LEFT JOIN "PROJECT" p ON prod.project_code = p.project_code
            WHERE LOWER(TRIM(prod.project_code)) = LOWER(TRIM($1))
            ${pcbFilter}
            ORDER BY
                LOWER(TRIM(COALESCE(prod.pcb_code, ''))),
                prod.id DESC
            `,
            params,
        );

        return result.rows.map((row) => ({
            ...row,
            project_name: row.project_name_from_project || row.project_name || '',
        }));
    }

    static async create(pData) {
        const columns = Object.keys(pData).join(', ');
        const values = Object.values(pData);
        const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');

        const result = await pool.query(`
      INSERT INTO "PRODUCTION" (${columns})
      VALUES (${placeholders})
      RETURNING *
    `, values);
        return result.rows[0];
    }

    static async update(id, pData) {
        const keys = Object.keys(pData).filter(k => k !== 'id');
        if (keys.length === 0) return null;

        const setClause = keys.map((key, i) => `"${key}" = $${i + 1}`).join(', ');
        const params = keys.map(key => pData[key]);
        params.push(id);

        const query = `
      UPDATE "PRODUCTION" 
      SET ${setClause}, updated_at = CURRENT_TIMESTAMP 
      WHERE id = $${params.length} 
      RETURNING *
    `;

        const result = await pool.query(query, params);
        return result.rows[0];
    }

    static async delete(id) {
        const result = await pool.query('DELETE FROM "PRODUCTION" WHERE id = $1 RETURNING id', [id]);
        return result.rows[0];
    }
}

export default ProductionModel;
