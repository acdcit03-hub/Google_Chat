// Utility functions for requirement operations

function calculateDaysDifference(dateStr1, dateStr2) {
    try {
        if (!dateStr1 || !dateStr2) {
            return null;
        }

        const str1 = String(dateStr1).trim();
        const str2 = String(dateStr2).trim();

        // Parse dates in dd-mm-yyyy format
        const parseDate = (dateStr) => {
            const parts = dateStr.split('-');
            if (parts.length === 3) {
                const day = parseInt(parts[0], 10);
                const month = parseInt(parts[1], 10) - 1; // Month is 0-indexed
                const year = parseInt(parts[2], 10);
                return new Date(year, month, day);
            }
            return null;
        };

        const date1 = parseDate(str1);
        const date2 = parseDate(str2);

        if (!date1 || !date2 || isNaN(date1.getTime()) || isNaN(date2.getTime())) {
            return null;
        }

        const diffTime = date1.getTime() - date2.getTime();
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        return diffDays;
    } catch (error) {
        console.error('Error calculating days difference:', error);
        return null;
    }
}

function getCurrentDateDDMMYYYY() {
    const now = new Date();
    const day = String(now.getDate()).padStart(2, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const year = now.getFullYear();
    return `${day}-${month}-${year}`;
}

function convertDateToPostgres(dateString) {
    if (!dateString) return null;

    let dateStr = String(dateString).trim();
    if (!dateStr || dateStr === 'null' || dateStr === 'undefined') return null;

    // If already in dd-mm-yyyy format, return as is
    if (dateStr.match(/^\d{2}-\d{2}-\d{4}$/)) {
        return dateStr;
    }

    // Try to parse as date and convert to dd-mm-yyyy
    try {
        const date = new Date(dateStr);
        if (!isNaN(date.getTime())) {
            const day = String(date.getDate()).padStart(2, '0');
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const year = date.getFullYear();
            return `${day}-${month}-${year}`;
        }
    } catch (e) {
        // If parsing fails, return null
    }
    return null;
}

function formatDateToDDMMYYYY(dateString) {
    try {
        if (!dateString) return null;

        let dateStr;
        if (typeof dateString === 'string') {
            dateStr = dateString.trim();
        } else if (dateString instanceof Date) {
            if (isNaN(dateString.getTime())) return null;
            const day = String(dateString.getDate()).padStart(2, '0');
            const month = String(dateString.getMonth() + 1).padStart(2, '0');
            const year = dateString.getFullYear();
            return `${day}-${month}-${year}`;
        } else if (dateString !== null && dateString !== undefined) {
            dateStr = String(dateString).trim();
        } else {
            return null;
        }

        if (typeof dateStr !== 'string' || !dateStr || typeof dateStr.match !== 'function') {
            return null;
        }

        // If already in dd-mm-yyyy format, return as is
        if (dateStr.match(/^\d{2}-\d{2}-\d{4}$/)) {
            return dateStr;
        }
        // If in yyyy-mm-dd format, convert to dd-mm-yyyy
        if (dateStr.match(/^\d{4}-\d{2}-\d{2}$/)) {
            const parts = dateStr.split('-');
            return `${parts[2]}-${parts[1]}-${parts[0]}`;
        }
        // Try to parse as date and convert to dd-mm-yyyy
        const date = new Date(dateStr);
        if (!isNaN(date.getTime())) {
            const day = String(date.getDate()).padStart(2, '0');
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const year = date.getFullYear();
            return `${day}-${month}-${year}`;
        }
    } catch (e) {
        console.error('Error in formatDateToDDMMYYYY:', e, 'Input:', dateString);
        return null;
    }
    return null;
}

function formatRequirementDates(requirement) {
    if (!requirement) return requirement;
    const formatted = { ...requirement };
    try {
        if (formatted.date != null) formatted.date = formatDateToDDMMYYYY(formatted.date);
        if (formatted.target_receive_date != null) formatted.target_receive_date = formatDateToDDMMYYYY(formatted.target_receive_date);
        if (formatted.order_date != null) formatted.order_date = formatDateToDDMMYYYY(formatted.order_date);
        if (formatted.expected_date != null) formatted.expected_date = formatDateToDDMMYYYY(formatted.expected_date);
        if (formatted.receive_date != null) formatted.receive_date = formatDateToDDMMYYYY(formatted.receive_date);
    } catch (error) {
        console.error('Error formatting requirement dates:', error);
    }
    return formatted;
}

/**
 * Fix the sequence for REQUIREMENT table primary key within a transaction
 * Uses session-level advisory lock to prevent race conditions
 */
async function fixRequirementSequenceInTransaction(client) {
    try {
        await client.query('SELECT pg_advisory_lock(12345)');

        const maxResult = await client.query('SELECT MAX("sr.no") FROM "REQUIREMENT"');
        const maxId = maxResult.rows[0].max || 0;

        const seqResult = await client.query(`
            SELECT pg_get_serial_sequence('"REQUIREMENT"', 'sr.no') as sequence_name
        `);

        if (seqResult.rows.length > 0 && seqResult.rows[0].sequence_name) {
            const sequenceName = seqResult.rows[0].sequence_name;
            const currentSeqResult = await client.query(`SELECT last_value FROM ${sequenceName}`);
            const currentSeqValue = currentSeqResult.rows[0]?.last_value || 0;
            const targetValue = Math.max(maxId, currentSeqValue);
            await client.query(`SELECT setval($1, $2, true)`, [sequenceName, targetValue]);
        }

        return true;
    } catch (error) {
        console.error('Error fixing requirement sequence:', error.message);
        return false;
    }
}

/**
 * Generate year code based on format
 * Supports: YYYY, YYMM, YY, or custom format (current year last 2 digits + next year last 2 digits)
 */
function generateYearCode(yearFormat) {
    const now = new Date();
    // Default: current year + next year (2526 style), not YYMM; can be overridden by settings
    const yearFormatUpper = (yearFormat || 'CURRENTNEXT').toString().trim().toUpperCase();

    if (yearFormatUpper === 'YYYY' || yearFormatUpper.includes('YYYY')) {
        return now.getFullYear().toString();
    } else if (yearFormatUpper === 'YYMM' || (yearFormatUpper.includes('YY') && yearFormatUpper.includes('MM'))) {
        const year = now.getFullYear().toString().slice(-2);
        const month = String(now.getMonth() + 1).padStart(2, '0');
        return `${year}${month}`;
    } else if (yearFormatUpper === 'YY') {
        return now.getFullYear().toString().slice(-2);
    } else if (yearFormatUpper === 'CURRENTNEXT' || yearFormatUpper === 'CURRENT+NEXT' || yearFormatUpper === 'YY+YY') {
        // Custom format: current year last 2 digits + next year last 2 digits (e.g., 2526 for 2025->2026)
        const currentYear = now.getFullYear();
        const nextYear = currentYear + 1;
        const currentYearCode = currentYear.toString().slice(-2);
        const nextYearCode = nextYear.toString().slice(-2);
        return `${currentYearCode}${nextYearCode}`;
    } else {
        // Custom format with placeholders
        return yearFormatUpper
            .replace(/YYYY/g, now.getFullYear().toString())
            .replace(/YY/g, now.getFullYear().toString().slice(-2))
            .replace(/MM/g, String(now.getMonth() + 1).padStart(2, '0'))
            .replace(/DD/g, String(now.getDate()).padStart(2, '0'));
    }
}

/** Map legacy client field names to DB column names for create/update. */
function normalizeRequirementBody(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
    const b = { ...body };
    if (!b.requirement_type && b.req_type) b.requirement_type = b.req_type;
    if (!b.project_code && b.proj_code) b.project_code = b.proj_code;
    if (!b.target_receive_date && b.receive_req_date) {
        b.target_receive_date = b.receive_req_date;
    }
    if (!b.require_person_name && b.req_person) {
        b.require_person_name = b.req_person;
    }
    if (!b.requirement_priority && (b.req_priority || b.priority)) {
        b.requirement_priority = b.req_priority || b.priority;
    }
    for (const key of ['quantity', 'order_qty', 'receive_qty', 'price_per_piece']) {
        if (b[key] != null && typeof b[key] === 'string') {
            const n = Number(String(b[key]).trim());
            if (Number.isFinite(n)) b[key] = n;
        }
    }
    return b;
}

export {
    calculateDaysDifference,
    getCurrentDateDDMMYYYY,
    convertDateToPostgres,
    formatDateToDDMMYYYY,
    formatRequirementDates,
    fixRequirementSequenceInTransaction,
    generateYearCode,
    normalizeRequirementBody
};
