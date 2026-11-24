import { pool } from '../config/db.js';

function normalizeUsername(value) {
    return String(value ?? '').trim().toLowerCase();
}

function parseScopeValue(query = {}) {
    return String(
        query.scope ?? query.dataScope ?? query.data_scope ?? query.person_scope ?? 'all',
    )
        .trim()
        .toLowerCase();
}

/** Explicit usernames from query (comma-separated or array) — preferred for department scope. */
function parseUsernamesFromQuery(query = {}) {
    const raw =
        query.usernames ??
        query.scope_usernames ??
        query.scopeUsernames ??
        null;

    if (raw == null || raw === '') return null;

    if (Array.isArray(raw)) {
        const names = raw.map(normalizeUsername).filter(Boolean);
        return names.length ? names : null;
    }

    const names = String(raw)
        .split(',')
        .map(normalizeUsername)
        .filter(Boolean);
    return names.length ? names : null;
}

/**
 * Resolve usernames for me / department scope.
 * Returns null when scope is "all" (no person filter).
 * Returns [] when scope is set but no usernames match.
 */
async function resolveScopeUsernames({ scope, username, department, usernames }) {
    const normalizedScope = String(scope ?? 'all').trim().toLowerCase();
    if (!normalizedScope || normalizedScope === 'all') {
        return null;
    }

    // Prefer explicit list (same set the frontend table uses).
    if (Array.isArray(usernames) && usernames.length > 0) {
        return usernames.map(normalizeUsername).filter(Boolean);
    }

    if (normalizedScope === 'me') {
        const u = normalizeUsername(username);
        return u ? [u] : [];
    }

    if (normalizedScope === 'department') {
        const dept = String(department ?? '').trim();
        if (!dept) {
            const self = normalizeUsername(username);
            return self ? [self] : [];
        }

        const result = await pool.query(
            `SELECT DISTINCT LOWER(TRIM(pd.username)) AS username
             FROM personal_details pd
             INNER JOIN employment_details emp
               ON emp.personal_details_id = pd.id
             WHERE LOWER(TRIM(emp.department)) = LOWER(TRIM($1))
               AND pd.username IS NOT NULL
               AND TRIM(pd.username) <> ''`,
            [dept],
        );

        const names = result.rows
            .map((row) => normalizeUsername(row.username))
            .filter(Boolean);

        const self = normalizeUsername(username);
        if (self && !names.includes(self)) {
            names.push(self);
        }

        return names;
    }

    return null;
}

async function resolveStatsScopeFromQuery(query = {}) {
    const scope = parseScopeValue(query);
    if (!scope || scope === 'all') {
        return { scope: 'all', scopeUsernames: null };
    }

    const explicit = parseUsernamesFromQuery(query);
    const scopeUsernames = await resolveScopeUsernames({
        scope,
        username: query.username ?? query.assign_username ?? query.assignUsername,
        department: query.department,
        usernames: explicit,
    });

    return { scope, scopeUsernames };
}

/**
 * Match comma-separated assigned_users_display the same way as frontend
 * parseAssignUsernames (split on comma, trim each token).
 */
function buildAssignedUsersScopeSql(columnExpr, scopeUsernames, params) {
    if (scopeUsernames == null) return null;
    if (scopeUsernames.length === 0) return 'FALSE';

    // Pass the username array as a single parameter.
    params.push(scopeUsernames);

    // If only one username was requested, use the existing ANY-match (OR semantics).
    if (scopeUsernames.length === 1) {
        return `EXISTS (
            SELECT 1
            FROM unnest(string_to_array(COALESCE(${columnExpr}, ''), ',')) AS token(raw)
            WHERE LOWER(TRIM(token.raw)) = ANY($${params.length}::text[])
        )`;
    }

    // When multiple usernames are provided, require that ALL selected usernames
    // are present in the assigned list (intersection). We count distinct matching
    // tokens and ensure it equals the number of requested usernames.
    return `(
        (
          SELECT COUNT(DISTINCT LOWER(TRIM(token.raw)))
          FROM unnest(string_to_array(COALESCE(${columnExpr}, ''), ',')) AS token(raw)
          WHERE LOWER(TRIM(token.raw)) = ANY($${params.length}::text[])
        ) = cardinality($${params.length}::text[])
    )`;
}

/** Exact match on a single username column (prepare_person, created_by, require_person_name). */
function buildExactUserScopeSql(columnExpr, scopeUsernames, params) {
    if (scopeUsernames == null) return null;
    if (scopeUsernames.length === 0) return 'FALSE';

    params.push(scopeUsernames);
    return `LOWER(TRIM(${columnExpr})) = ANY($${params.length}::text[])`;
}

/** Projects: assigned_users_display OR created_by. */
function buildAssignedOrCreatedScopeSql(
    assignedColumnExpr,
    createdByColumnExpr,
    scopeUsernames,
    params,
) {
    if (scopeUsernames == null) return null;
    if (scopeUsernames.length === 0) return 'FALSE';

    const assignedSql = buildAssignedUsersScopeSql(
        assignedColumnExpr,
        scopeUsernames,
        params,
    );
    const createdSql = buildExactUserScopeSql(
        createdByColumnExpr,
        scopeUsernames,
        params,
    );
    return `(${assignedSql} OR ${createdSql})`;
}

function appendScopeCondition(conditions, params, {
    scopeUsernames,
    mode,
    columnExpr,
    createdByColumnExpr,
}) {
    let sql = null;
    if (mode === 'assigned') {
        sql = buildAssignedUsersScopeSql(columnExpr, scopeUsernames, params);
    } else if (mode === 'assigned_or_created') {
        sql = buildAssignedOrCreatedScopeSql(
            columnExpr,
            createdByColumnExpr || 'p.created_by',
            scopeUsernames,
            params,
        );
    } else {
        sql = buildExactUserScopeSql(columnExpr, scopeUsernames, params);
    }

    if (sql) {
        conditions.push(sql);
    }
}

export {
    parseScopeValue,
    parseUsernamesFromQuery,
    resolveScopeUsernames,
    resolveStatsScopeFromQuery,
    buildAssignedUsersScopeSql,
    buildExactUserScopeSql,
    buildAssignedOrCreatedScopeSql,
    appendScopeCondition,
};
