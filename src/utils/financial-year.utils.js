import { generateYearCode } from './requirement.utils.js';

/**
 * Current FY (Apr–Mar), same rules as financial-year.controller / project serials.
 */
function getCurrentFinancialYearBounds() {
    const now = new Date();
    const month = now.getMonth() + 1;
    const year = now.getFullYear();

    if (month >= 4) {
        const startYear = year;
        const endYear = year + 1;
        return {
            startYear,
            endYear,
            yearCode: `${startYear}-${String(endYear).slice(-2)}`,
        };
    }

    const startYear = year - 1;
    const endYear = year;
    return {
        startYear,
        endYear,
        yearCode: `${startYear}-${String(endYear).slice(-2)}`,
    };
}

/**
 * True when filter is current FY (dropdown `current-year` or matching year_code).
 */
function isCurrentFinancialYearSelection(financialYear) {
    const raw = String(financialYear ?? '').trim().toLowerCase();
    if (!raw || raw === 'all') return false;
    if (raw === 'current-year' || raw === 'current' || raw === 'currentfy') {
        return true;
    }
    const current = getCurrentFinancialYearBounds();
    const normalized = raw.replace(/\s+/g, '');
    const currentCode = String(current.yearCode).toLowerCase();
    const altCode = `${current.startYear}-${String(current.endYear).slice(-2)}`.toLowerCase();
    return normalized === currentCode || normalized === altCode;
}

/**
 * Parse FY filter into MMYY year shorts for Apr–Mar.
 * e.g. `2026-27` / `current-year` → { startYear: 2026, endYear: 2027, startYearShort: 26, endYearShort: 27, yearCode }
 */
function parseFinancialYearFilter(financialYear) {
    const raw = String(financialYear ?? '').trim();
    if (!raw || raw.toLowerCase() === 'all') return null;

    if (isCurrentFinancialYearSelection(raw)) {
        const current = getCurrentFinancialYearBounds();
        return {
            startYear: current.startYear,
            endYear: current.endYear,
            startYearShort: current.startYear % 100,
            endYearShort: current.endYear % 100,
            yearCode: current.yearCode,
        };
    }

    const m = raw.match(/^(\d{2,4})\s*[-/]\s*(\d{2,4})$/);
    if (!m) return null;

    let startYear = parseInt(m[1], 10);
    let endYear = parseInt(m[2], 10);
    if (m[1].length === 2) startYear += 2000;
    if (m[2].length === 2) endYear += 2000;
    if (!Number.isFinite(startYear) || !Number.isFinite(endYear)) return null;

    // Tolerate `2026-2027` or `26-27`
    if (endYear < startYear) return null;

    return {
        startYear,
        endYear,
        startYearShort: startYear % 100,
        endYearShort: endYear % 100,
        yearCode: `${startYear}-${String(endYear).slice(-2)}`,
    };
}

/**
 * SQL: last-4 MMYY of a code is in FY Apr–Mar.
 * Params: $startIdx = startYearShort (e.g. 26), $endIdx = endYearShort (e.g. 27).
 * Match: Apr–Dec of start year OR Jan–Mar of end year.
 */
function buildCodeMmyyFinancialYearSql(codeExpr, startIdx, endIdx) {
    const mmyy = `RIGHT(TRIM(COALESCE(${codeExpr}, '')), 4)`;
    const mm = `NULLIF(SUBSTRING(${mmyy} FROM 1 FOR 2), '')::int`;
    const yy = `NULLIF(SUBSTRING(${mmyy} FROM 3 FOR 2), '')::int`;
    return `(
      ${mmyy} ~ '^[0-9]{4}$'
      AND (
        (${mm} BETWEEN 4 AND 12 AND ${yy} = $${startIdx})
        OR
        (${mm} BETWEEN 1 AND 3 AND ${yy} = $${endIdx})
      )
    )`;
}

/**
 * Production serial center: `2026-27` → `2627` for `PRD-2627-034`.
 */
function financialYearToProductionCenterCode(fy) {
    if (!fy) return null;
    const a = String(fy.startYearShort ?? fy.startYear % 100).padStart(2, '0').slice(-2);
    const b = String(fy.endYearShort ?? fy.endYear % 100).padStart(2, '0').slice(-2);
    if (!/^\d{2}$/.test(a) || !/^\d{2}$/.test(b)) return null;
    return `${a}${b}`;
}

/**
 * SQL: serial_no center segment equals FY code (param $idx).
 * e.g. PRD-2627-034 → 2627
 */
function buildProductionFinancialYearSql(paramIdx) {
    const center = `UPPER(TRIM(split_part(TRIM(COALESCE(prod.serial_no, '')), '-', 2)))`;
    return `(
      TRIM(COALESCE(prod.serial_no, '')) ~* '^PRD-[0-9]{4}-'
      AND ${center} = UPPER(TRIM($${paramIdx}::text))
    )`;
}

/**
 * Project month/year + project_code MMYY fallback (Apr–Mar).
 * Params: $startIdx/$endIdx = startYearShort / endYearShort.
 */
function buildProjectFinancialYearSql(startIdx, endIdx) {
    const monthExpr = `NULLIF(TRIM(COALESCE(p.month::text, '')), '')::int`;
    const yearExpr = `NULLIF(TRIM(COALESCE(p.year::text, '')), '')::int`;
    const codeMmyy = `RIGHT(TRIM(COALESCE(p.project_code, '')), 4)`;
    const codeMm = `NULLIF(SUBSTRING(${codeMmyy} FROM 1 FOR 2), '')::int`;
    const codeYy = `NULLIF(SUBSTRING(${codeMmyy} FROM 3 FOR 2), '')::int`;

    const fromMonthYear = `(
      ${monthExpr} IS NOT NULL AND ${yearExpr} IS NOT NULL
      AND (
        (${monthExpr} BETWEEN 4 AND 12 AND ${yearExpr} = $${startIdx})
        OR
        (${monthExpr} BETWEEN 1 AND 3 AND ${yearExpr} = $${endIdx})
      )
    )`;

    const fromCode = `(
      ${codeMmyy} ~ '^[0-9]{4}$'
      AND (
        (${codeMm} BETWEEN 4 AND 12 AND ${codeYy} = $${startIdx})
        OR
        (${codeMm} BETWEEN 1 AND 3 AND ${codeYy} = $${endIdx})
      )
    )`;

    return `((${fromMonthYear}) OR (NOT (${monthExpr} IS NOT NULL AND ${yearExpr} IS NOT NULL) AND ${fromCode}))`;
}

/**
 * Map DB financial year to RFQ middle segment (e.g. `2025-26` → `2526`).
 */
function financialYearCodeToSerialSegment(yearCode) {
    const raw = String(yearCode ?? '').trim();
    if (!raw) return null;

    if (/^\d{4}$/.test(raw)) {
        return raw;
    }

    const m = raw.match(/^(\d{2,4})-(\d{2,4})$/);
    if (!m) return null;

    const startShort =
        m[1].length === 4 ? m[1].slice(-2) : m[1].padStart(2, '0').slice(-2);
    const endShort =
        m[2].length === 4 ? m[2].slice(-2) : m[2].padStart(2, '0').slice(-2);
    return `${startShort}${endShort}`;
}

/**
 * Year segment for `RFQ-{yearCode}-{serial}` from financial_years (current FY by date).
 * Falls back to computed FY bounds if no DB row. Other settings values use generateYearCode.
 */
async function resolveRequirementSerialYearCode(dbPool, yearFormat) {
    const format = (yearFormat || 'FINANCIAL_YEAR').toString().trim().toUpperCase();

    if (format !== 'FINANCIAL_YEAR' && format !== 'FY') {
        return generateYearCode(yearFormat);
    }

    const current = getCurrentFinancialYearBounds();

    if (dbPool) {
        try {
            const result = await dbPool.query(
                `SELECT year_code FROM financial_years
                 WHERE start_year = $1 AND end_year = $2
                 ORDER BY is_active DESC NULLS LAST, id DESC
                 LIMIT 1`,
                [current.startYear, current.endYear],
            );
            const fromDb = financialYearCodeToSerialSegment(
                result.rows[0]?.year_code,
            );
            if (fromDb) return fromDb;
        } catch (err) {
            console.warn(
                'resolveRequirementSerialYearCode DB lookup:',
                err.message,
            );
        }
    }

    return (
        financialYearCodeToSerialSegment(current.yearCode) ||
        generateYearCode('CURRENTNEXT')
    );
}

export {
    getCurrentFinancialYearBounds,
    isCurrentFinancialYearSelection,
    parseFinancialYearFilter,
    buildCodeMmyyFinancialYearSql,
    financialYearToProductionCenterCode,
    buildProductionFinancialYearSql,
    buildProjectFinancialYearSql,
    financialYearCodeToSerialSegment,
    resolveRequirementSerialYearCode,
};
