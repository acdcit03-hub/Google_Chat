import { pool } from '../../config/db.js';

const DATE_COL_AS_DATE = `COALESCE(
    CASE
        WHEN t."date" IS NOT NULL AND trim(t."date"::text) ~ '^\\d{1,2}-\\d{1,2}-\\d{4}$' THEN to_date(trim(t."date"::text), 'DD-MM-YYYY')
        WHEN t."date" IS NOT NULL AND trim(t."date"::text) ~ '^\\d{1,2}-\\d{1,2}-\\d{2}$' THEN to_date(trim(t."date"::text), 'DD-MM-YY')
        WHEN t."date" IS NOT NULL AND trim(t."date"::text) ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN (t."date"::text)::date
        ELSE NULL
    END,
    DATE(t.created_at)
)`;

function appendUserFilter(conditions, params, rawUser) {
    const raw = String(rawUser || '').trim();
    if (!raw) return;
    const parts = raw.includes('|')
        ? raw.split('|').map((x) => x.trim()).filter(Boolean)
        : [raw];
    const patterns = parts.map((p) => `%${p}%`);
    params.push(patterns);
    conditions.push(
        `COALESCE(NULLIF(TRIM(t.user_name), ''), pd.username) ILIKE ANY($${params.length})`,
    );
}

function appendProjectTypeFilter(conditions, params, rawProjectType) {
    const raw = String(rawProjectType || '').trim();
    if (!raw) return;
    const parts = raw
        .split(/[|,]/)
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean);
    if (!parts.length) return;
    params.push(parts);
    conditions.push(`LOWER(TRIM(t.project_type)) = ANY($${params.length})`);
}

// Cache time for the per-filter dropdown APIs (see findFilterOptions)
const OPTIONS_CACHE_TTL_MS = 60 * 1000;


const USER_EXPR_SQL = `COALESCE(NULLIF(TRIM(t.user_name), ''), pd.username)`;

const OPTION_FIELDS = {
    project: `t.project_code`,
    process: `t.process_name`,
    user: USER_EXPR_SQL,
    project_by: `t.project_by`,
    project_type: `t.project_type`,
};

function splitLower(raw) {
    return String(raw ?? '')
        .split('|')
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean);
}

/** Exact (case-insensitive) match against one or many "a|b" values. */
function appendExactFilter(conditions, params, expr, raw) {
    const parts = splitLower(raw);
    if (!parts.length) return;
    params.push(parts);
    conditions.push(`LOWER(TRIM(${expr})) = ANY($${params.length})`);
}

// Small cache for the per-filter option APIs: "field + filters" -> { at, rows }
const FILTER_OPTIONS_CACHE = new Map();
const FILTER_OPTIONS_CACHE_MAX = 200;

class DurationReportModel {

    static async findForDurationReport({
        dateStart,
        dateEnd,
        projectCode,
        processName,
        user,
        projectType,
        projectBy,
    } = {}) {
        const params = [];
        const conditions = [];
        if (dateStart) {
            params.push(dateStart);
            conditions.push(`(${DATE_COL_AS_DATE}) >= $${params.length}::date`);
        }
        if (dateEnd) {
            params.push(dateEnd);
            conditions.push(`(${DATE_COL_AS_DATE}) <= $${params.length}::date`);
        }
        appendExactFilter(conditions, params, `COALESCE(t.project_code, '')`, projectCode);
        appendExactFilter(conditions, params, `COALESCE(t.process_name, '')`, processName);
        appendExactFilter(conditions, params, `COALESCE(t.project_by, '')`, projectBy);
        if (user) {
            appendUserFilter(conditions, params, user);
        }
        if (projectType) {
            appendProjectTypeFilter(conditions, params, projectType);
        }

        const whereClause =
            conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';

        const query = `
            SELECT
                t.id,
                t.project_code,
                t.process_name,
                t.start_time,
                t.stop_time,
                t.duration,
                t.project_by,
                COALESCE(NULLIF(TRIM(t.user_name), ''), pd.username) AS user_name,
                (${DATE_COL_AS_DATE})::text AS date
            FROM "TIMESHEET" t
            LEFT JOIN personal_details pd ON t.user_id = pd.id
            ${whereClause}
            ORDER BY
                (${DATE_COL_AS_DATE}) ASC NULLS LAST,
                COALESCE(NULLIF(TRIM(t.user_name), ''), pd.username) ASC NULLS LAST,
                t.id ASC
        `;

        const result = await pool.query(query, params);
        return result.rows;
    }

    static async findFilterOptions(
        field,
        { dateStart, dateEnd, project, process, user, projectBy, projectType } = {},
    ) {
        const expr = OPTION_FIELDS[field];
        if (!expr) throw new Error(`Unknown filter field: ${field}`);

        const filters = { dateStart, dateEnd, project, process, user, projectBy, projectType };
        const cacheKey = `${field}:${JSON.stringify(filters)}`;
        const cached = FILTER_OPTIONS_CACHE.get(cacheKey);
        if (cached && Date.now() - cached.at < OPTIONS_CACHE_TTL_MS) return cached.rows;

        const params = [];
        const conditions = [`NULLIF(TRIM(${expr}), '') IS NOT NULL`];

        if (dateStart) {
            params.push(dateStart);
            conditions.push(`(${DATE_COL_AS_DATE}) >= $${params.length}::date`);
        }
        if (dateEnd) {
            params.push(dateEnd);
            conditions.push(`(${DATE_COL_AS_DATE}) <= $${params.length}::date`);
        }
        if (field !== 'project') appendExactFilter(conditions, params, OPTION_FIELDS.project, project);
        if (field !== 'process') appendExactFilter(conditions, params, OPTION_FIELDS.process, process);
        if (field !== 'user') appendExactFilter(conditions, params, OPTION_FIELDS.user, user);
        if (field !== 'project_by') appendExactFilter(conditions, params, OPTION_FIELDS.project_by, projectBy);
        if (field !== 'project_type') appendExactFilter(conditions, params, OPTION_FIELDS.project_type, projectType);

        const sql =
            field === 'project'
                ? `
            SELECT TRIM(t.project_code) AS value,
                   MAX(p.id) AS project_id,
                   COUNT(*)::int AS entries
            FROM "TIMESHEET" t
            LEFT JOIN personal_details pd ON t.user_id = pd.id
            LEFT JOIN "PROJECT" p
                ON LOWER(TRIM(p.project_code)) = LOWER(TRIM(t.project_code))
            WHERE ${conditions.join(' AND ')}
            GROUP BY TRIM(t.project_code)
            ORDER BY MAX(p.id) DESC NULLS LAST, TRIM(t.project_code) ASC`
                : `
            SELECT TRIM(${expr}) AS value, COUNT(*)::int AS entries
            FROM "TIMESHEET" t
            LEFT JOIN personal_details pd ON t.user_id = pd.id
            WHERE ${conditions.join(' AND ')}
            GROUP BY 1
            ORDER BY 1 ASC`;

        const result = await pool.query(sql, params);

        if (FILTER_OPTIONS_CACHE.size >= FILTER_OPTIONS_CACHE_MAX) FILTER_OPTIONS_CACHE.clear();
        FILTER_OPTIONS_CACHE.set(cacheKey, { at: Date.now(), rows: result.rows });
        return result.rows;
    }

    static async findByFilter({
        filterType = 'project',
        filterValue,
        project,
        process,
        user,
        projectBy,
        projectType,
        date,
        dateStart,
        dateEnd,
        startTime,
        endTime,
        duration,
        // ---- optional server-side paging (used by the grouped Report tab) ----
        // statsOnly : return only (group_key, duration, start_time, stop_time) of every matching row -
        //             tiny rows, used to count / sum each group and the grand total.
        // groupKeys : return only the rows of these groups (keys exactly as statsOnly returned them),
        //             `rowLimit` rows per group starting after `rowOffset` rows.
        statsOnly = false,
        groupKeys,
        rowLimit,
        rowOffset = 0,
    } = {}) {
        const USER_EXPR = `COALESCE(NULLIF(TRIM(t.user_name), ''), pd.username)`;
        const DIMS = {
            project: { expr: `t.project_code`, raw: project },
            process: { expr: `t.process_name`, raw: process },
            user: { expr: USER_EXPR, raw: user },
            project_by: { expr: `t.project_by`, raw: projectBy },
            project_type: { expr: `t.project_type`, raw: projectType },
        };
        // legacy `value` param -> selection of the chosen type
        if (filterValue && DIMS[filterType] && !DIMS[filterType].raw) {
            DIMS[filterType].raw = filterValue;
        }
        const TIME_RE = `'^[0-9]{1,2}:[0-9]{2}(:[0-9]{2})?$'`;

        // skipDim: leave this dimension's own selection out (used for its dropdown options)
        const buildConditions = (skipDim) => {
            const params = [];
            const conditions = [];

            const splitValues = (raw) =>
                String(raw ?? '')
                    .split('|')
                    .map((x) => x.trim())
                    .filter(Boolean);

            for (const [name, { expr, raw }] of Object.entries(DIMS)) {
                if (name === skipDim) continue;
                const parts = splitValues(raw).map((x) => x.toLowerCase());
                if (!parts.length) continue;
                params.push(parts);
                conditions.push(`LOWER(TRIM(${expr})) = ANY($${params.length})`);
            }

            if (date) {
                params.push(date);
                conditions.push(`(${DATE_COL_AS_DATE}) = $${params.length}::date`);
            }
            if (dateStart) {
                params.push(dateStart);
                conditions.push(`(${DATE_COL_AS_DATE}) >= $${params.length}::date`);
            }
            if (dateEnd) {
                params.push(dateEnd);
                conditions.push(`(${DATE_COL_AS_DATE}) <= $${params.length}::date`);
            }

            if (startTime) {
                params.push(startTime);
                conditions.push(
                    `(t.start_time ~ ${TIME_RE} AND t.start_time::time = $${params.length}::time)`,
                );
            }
            if (endTime) {
                if (String(endTime).toLowerCase() === 'ongoing') {
                    conditions.push(
                        `(t.stop_time IS NULL OR TRIM(t.stop_time) = '' OR t.stop_time = 'Ongoing')`,
                    );
                } else {
                    params.push(endTime);
                    conditions.push(
                        `(t.stop_time ~ ${TIME_RE} AND t.stop_time::time = $${params.length}::time)`,
                    );
                }
            }
            if (duration) {
                params.push(duration);
                conditions.push(
                    `(t.duration ~ ${TIME_RE} AND TRIM(t.duration)::interval = $${params.length}::interval)`,
                );
            }

            return { params, conditions };
        };

        const projectJoin =
            filterType === 'project'
                ? `LEFT JOIN LATERAL (
                    SELECT p.id
                    FROM "PROJECT" p
                    WHERE LOWER(TRIM(p.project_code)) = LOWER(TRIM(t.project_code))
                    ORDER BY p.id DESC
                    LIMIT 1
                ) proj ON TRUE`
                : '';
        const FROM = `FROM "TIMESHEET" t LEFT JOIN personal_details pd ON t.user_id = pd.id ${projectJoin}`;
        const projectIdSelect =
            filterType === 'project' ? 'proj.id' : 'NULL::bigint';

        // data rows matching every filter
        const { params, conditions } = buildConditions(null);
        const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
        const rowSql = `
            SELECT
                t.id,
                t.project_code,
                t.process_name,
                t.start_time,
                t.stop_time,
                t.duration,
                t.project_by,
                t.project_type,
                t.notes,
                ${USER_EXPR} AS user_name,
                (${DATE_COL_AS_DATE})::text AS date
            ${FROM}
            ${where}
            ORDER BY (${DATE_COL_AS_DATE}) DESC NULLS LAST,
                CASE WHEN t.start_time ~ ${TIME_RE} THEN t.start_time::time END DESC NULLS LAST,
                t.id DESC`;

        // ---- paged modes (the default mode below is unchanged) ----
        // group key = the grouped column (type = project | process | user), blank -> 'OTHER'
        const groupExpr = DIMS[filterType]
            ? `COALESCE(NULLIF(TRIM(${DIMS[filterType].expr}), ''), 'OTHER')`
            : `'OTHER'`;

        if (statsOnly) {
            const statsResult = await pool.query(
                `SELECT ${groupExpr} AS group_key,
                        ${projectIdSelect} AS project_id,
                        t.duration,
                        t.start_time,
                        t.stop_time
                 ${FROM}${where}`,
                params,
            );
            return { rows: statsResult.rows };
        }

        if (Array.isArray(groupKeys)) {
            if (!groupKeys.length) return { rows: [] };
            const pagedParams = [...params, groupKeys, Number(rowOffset) || 0, (Number(rowOffset) || 0) + Number(rowLimit)];
            const keysIdx = params.length + 1;
            const fromIdx = params.length + 2;
            const toIdx = params.length + 3;
            const pagedWhere = ` WHERE ${[...conditions, `${groupExpr} = ANY($${keysIdx})`].join(' AND ')}`;
            const pagedResult = await pool.query(
                `SELECT * FROM (
                    SELECT
                        t.id,
                        t.project_code,
                        t.process_name,
                        t.start_time,
                        t.stop_time,
                        t.duration,
                        t.project_by,
                        t.project_type,
                        t.notes,
                        ${USER_EXPR} AS user_name,
                        (${DATE_COL_AS_DATE})::text AS date,
                        ${groupExpr} AS group_key,
                        ROW_NUMBER() OVER (
                            PARTITION BY ${groupExpr}
                            ORDER BY (${DATE_COL_AS_DATE}) DESC NULLS LAST,
                                CASE WHEN t.start_time ~ ${TIME_RE} THEN t.start_time::time END DESC NULLS LAST,
                                t.id DESC
                        ) AS rn
                    ${FROM}
                    ${pagedWhere}
                ) ranked
                WHERE rn > $${fromIdx} AND rn <= $${toIdx}
                ORDER BY rn`,
                pagedParams,
            );
            return { rows: pagedResult.rows };
        }

        const rowResult = await pool.query(rowSql, params);
        return { rows: rowResult.rows };
    }
}

export default DurationReportModel;