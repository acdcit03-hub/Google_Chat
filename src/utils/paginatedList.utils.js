/** Keys that are list pagination/meta, not SQL WHERE filters. */
const LIST_META_KEYS = new Set([
    'limit',
    'offset',
    'page',
    'all',
    'pagination',
    'paginate',
    'financialYear',
]);

function isPaginationOff(value) {
    if (value === false) return true;
    return ['false', '0', 'no'].includes(String(value ?? '').trim().toLowerCase());
}

function stripListMeta(query = {}) {
    const meta = {};
    const filterQuery = {};
    for (const [key, value] of Object.entries(query)) {
        if (LIST_META_KEYS.has(key)) meta[key] = value;
        else filterQuery[key] = value;
    }
    return { meta, filterQuery };
}

function resolvePageWindow(meta = {}) {
    const paginationOff =
        isPaginationOff(meta.pagination) || isPaginationOff(meta.paginate);
    const all =
        paginationOff || meta.all === 'true' || meta.all === true;
    const limit = all ? 10000 : parseInt(meta.limit, 0) || 20;
    const page = Math.max(1, parseInt(meta.page, 10) || 1);
    const offset =
        meta.offset != null && meta.offset !== '' && !Number.isNaN(parseInt(meta.offset, 10))
            ? Math.max(0, parseInt(meta.offset, 0))
            : (page - 1) * limit;
    return { all, paginationOff, limit, page, offset };
}

function paginateRows(rows, meta = {}) {
    const { all, limit, offset, page } = resolvePageWindow(meta);
    if (all) {
        return {
            rows,
            total: rows.length,
            limit,
            offset: 0,
            page: 1,
        };
    }
    const start = Math.max(0, offset);
    const end = Math.min(start + limit, rows.length);
    return {
        rows: rows.slice(start, end),
        total: rows.length,
        limit,
        offset: start,
        page,
    };
}

function buildPaginationPayload(total, limit, offset, page, extras = {}) {
    return {
        total,
        limit,
        offset,
        page,
        totalPages: total > 0 && limit ? Math.ceil(total / limit) : 0,
        hasNextPage: limit ? offset + limit < total : false,
        hasPrevPage: offset > 0,
        ...extras,
    };
}

export {
    stripListMeta,
    resolvePageWindow,
    paginateRows,
    buildPaginationPayload,
    isPaginationOff,
};
