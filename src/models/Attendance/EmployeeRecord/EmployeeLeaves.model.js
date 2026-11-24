import { pool } from "../../../database.js";
import { getPriorDaysRequired } from "../../settings/Leave_prior.model.js";

export const initializeEmployeeLeavesTable = async () => {
    const query = `
        CREATE TABLE IF NOT EXISTS employee_leaves (
            id SERIAL PRIMARY KEY,
            username VARCHAR(255) NOT NULL,
            start_leave_date DATE NOT NULL,
            end_leave_date DATE NOT NULL,
            inform_date DATE,
            leave_type VARCHAR(30) NOT NULL DEFAULT 'Full Day',
            leave_start_time TIME,
            leave_end_time TIME,
            reason TEXT NOT NULL,
            description TEXT NULL,
            rejected_reason TEXT NULL,
            document TEXT NULL,
            status VARCHAR(50) DEFAULT 'Pending',
            leave_policy JSONB DEFAULT '{}'::jsonb,
            created_at TIMESTAMP DEFAULT TIMEZONE(
                'Asia/Kolkata',
                CURRENT_TIMESTAMP
            ),

            updated_at TIMESTAMP DEFAULT TIMEZONE(
                'Asia/Kolkata',
                CURRENT_TIMESTAMP
            ),

            CONSTRAINT unique_employee_leave
            UNIQUE(username, start_leave_date)
        );
    `;

    await pool.query(query);

    await pool.query(`
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'employee_leaves'
                  AND column_name = 'leave_date'
            ) AND NOT EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'employee_leaves'
                  AND column_name = 'start_leave_date'
            ) THEN
                ALTER TABLE public.employee_leaves
                    RENAME COLUMN leave_date TO start_leave_date;
            END IF;

            IF NOT EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'employee_leaves'
                  AND column_name = 'end_leave_date'
            ) THEN
                ALTER TABLE public.employee_leaves
                    ADD COLUMN end_leave_date DATE;
            END IF;
        END $$;
    `);

    await pool.query(`
        UPDATE public.employee_leaves
        SET end_leave_date = start_leave_date
        WHERE end_leave_date IS NULL;
    `);

    await pool.query(`
        ALTER TABLE public.employee_leaves
        ALTER COLUMN end_leave_date SET NOT NULL;
    `);

    /* =========================================================
       ADD COLUMNS TO EXISTING TABLE
    ========================================================= */

    await pool.query(`
        ALTER TABLE public.employee_leaves
        ADD COLUMN IF NOT EXISTS created_by VARCHAR(255);
    `);

    await pool.query(`
        ALTER TABLE public.employee_leaves
        ADD COLUMN IF NOT EXISTS inform_date DATE;
    `);

    await pool.query(`
        ALTER TABLE public.employee_leaves
        ADD COLUMN IF NOT EXISTS status VARCHAR(50)
        DEFAULT 'Pending';
    `);

    await pool.query(`
        ALTER TABLE public.employee_leaves
        ADD COLUMN IF NOT EXISTS leave_policy JSONB
        DEFAULT '{}'::jsonb;
    `);

    await pool.query(`
        ALTER TABLE public.employee_leaves
        ADD COLUMN IF NOT EXISTS medium VARCHAR(50);
    `);

    await pool.query(`
        ALTER TABLE public.employee_leaves
        ADD COLUMN IF NOT EXISTS rejected_reason TEXT;
    `);

    await pool.query(`
        ALTER TABLE public.employee_leaves
        ADD COLUMN IF NOT EXISTS document TEXT;
    `);

    /* =========================================================
       RESET SERIAL SEQUENCE
    ========================================================= */
    await pool.query(`
        SELECT setval(
            pg_get_serial_sequence(
                'employee_leaves',
                'id'
            ),
            COALESCE(
                (SELECT MAX(id) FROM employee_leaves),
                1
            ),
            true
        );
    `);

    console.log("✅ employee_leaves table ready");
};

const calculateLeavePolicy = async ({
    start_leave_date,
    inform_date
}) => {
    const priorDaysRequired = await getPriorDaysRequired();

    let priorDaysGiven = 0;

    if (inform_date && start_leave_date) {
        const informDateMs =
            Date.parse(`${inform_date}T00:00:00Z`);

        const leaveDateMs =
            Date.parse(`${start_leave_date}T00:00:00Z`);

        if (
            !Number.isFinite(informDateMs) ||
            !Number.isFinite(leaveDateMs)
        ) {
            throw new Error(
                "Valid inform_date and start_leave_date are required to calculate leave policy"
            );
        }

        priorDaysGiven = Math.max(
            Math.floor(
                (leaveDateMs - informDateMs) /
                (24 * 60 * 60 * 1000)
            ),
            0
        );
    }

    const isPriorDaysCompliant = priorDaysGiven >= priorDaysRequired;

    return {
        prior_days_required: priorDaysRequired,
        prior_days_given: priorDaysGiven,
        is_prior_days_compliant: isPriorDaysCompliant
    };
};

const normalizeOptionalTime = (value) => {
    if (value === null || value === undefined) {
        return null;
    }

    const normalized = String(value).trim();

    if (
        normalized === "" ||
        normalized.toLowerCase() === "null" ||
        normalized.toLowerCase() === "undefined"
    ) {
        return null;
    }

    return normalized;
};

/* =========================================================
   NORMALIZE DATE
========================================================= */
const normalizeDate = (value) => {

    if (
        value === null ||
        value === undefined ||
        value === ""
    ) {
        return null;
    }

    /* =====================================================
       JAVASCRIPT DATE OBJECT
    ===================================================== */
    if (value instanceof Date) {

        if (Number.isNaN(value.getTime())) {
            return null;
        }

        /* DATE columns from pg + Asia/Kolkata calendar date —
           UTC toISOString() previous-day shift no aave */
        const parts = new Intl.DateTimeFormat("en-CA", {
            timeZone: "Asia/Kolkata",
            year: "numeric",
            month: "2-digit",
            day: "2-digit"
        }).formatToParts(value);
        const part = (type) =>
            parts.find((item) => item.type === type)?.value;

        return `${part("year")}-${part("month")}-${part("day")}`;
    }

    const stringValue =
        String(value).trim();

    if (!stringValue) {
        return null;
    }

    /* =====================================================
       YYYY-MM-DD
    ===================================================== */
    const yyyyMmDdMatch =
        stringValue.match(
            /^(\d{4})-(\d{2})-(\d{2})$/
        );

    if (yyyyMmDdMatch) {
        const [, year, month, day] =
            yyyyMmDdMatch;

        const normalized =
            `${year}-${month}-${day}`;

        return isValidDateBasic(normalized)
            ? normalized
            : null;
    }

    /* =====================================================
       ISO / DATETIME
       Example:
       2026-10-12T00:00:00.000Z
       2026-10-12T05:30:00+05:30
       2026-10-12 00:00:00
    ===================================================== */
    const isoDateMatch =
        stringValue.match(
            /^(\d{4})-(\d{2})-(\d{2})(?:[T\s]|$)/
        );

    if (isoDateMatch) {

        const [
            ,
            year,
            month,
            day
        ] = isoDateMatch;

        const normalized =
            `${year}-${month}-${day}`;

        return isValidDateBasic(normalized)
            ? normalized
            : null;
    }

    /* =====================================================
       DD-MM-YYYY
    ===================================================== */
    const ddMmYyyyMatch =
        stringValue.match(
            /^(\d{2})-(\d{2})-(\d{4})$/
        );

    if (ddMmYyyyMatch) {

        const [
            ,
            day,
            month,
            year
        ] = ddMmYyyyMatch;

        const normalized =
            `${year}-${month}-${day}`;

        return isValidDateBasic(normalized)
            ? normalized
            : null;
    }

    /* =====================================================
       DD/MM/YYYY
    ===================================================== */
    const ddMmYyyySlashMatch =
        stringValue.match(
            /^(\d{2})\/(\d{2})\/(\d{4})$/
        );

    if (ddMmYyyySlashMatch) {

        const [
            ,
            day,
            month,
            year
        ] = ddMmYyyySlashMatch;

        const normalized =
            `${year}-${month}-${day}`;

        return isValidDateBasic(normalized)
            ? normalized
            : null;
    }

    /* =====================================================
       YYYY/MM/DD
    ===================================================== */
    const yyyyMmDdSlashMatch =
        stringValue.match(
            /^(\d{4})\/(\d{2})\/(\d{2})$/
        );

    if (yyyyMmDdSlashMatch) {

        const [
            ,
            year,
            month,
            day
        ] = yyyyMmDdSlashMatch;

        const normalized =
            `${year}-${month}-${day}`;

        return isValidDateBasic(normalized)
            ? normalized
            : null;
    }

    return null;
};


/* =========================================================
   BASIC DATE VALIDATION
========================================================= */
const isValidDateBasic = (dateString) => {

    if (
        !dateString ||
        !/^\d{4}-\d{2}-\d{2}$/.test(dateString)
    ) {
        return false;
    }

    const [
        year,
        month,
        day
    ] = dateString
        .split("-")
        .map(Number);

    const date =
        new Date(
            Date.UTC(
                year,
                month - 1,
                day
            )
        );

    return (
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day
    );
};

/* =========================================================
   VALIDATE DATE
========================================================= */
const isValidDate = (dateString) => {

    if (!dateString) {
        return false;
    }

    return isValidDateBasic(dateString);
};

/* ================= GET DATE RANGE ================= */

const getDatesBetween = (
    startDate,
    endDate
) => {

    const dates = [];

    const current =
        new Date(
            `${startDate}T00:00:00Z`
        );

    const end =
        new Date(
            `${endDate}T00:00:00Z`
        );

    while (
        current <= end
    ) {

        dates.push(
            current
                .toISOString()
                .slice(0, 10)
        );

        current.setUTCDate(
            current.getUTCDate() + 1
        );
    }

    return dates;
};

export const addLeaveModel = async ({
    username,
    start_leave_date,
    end_leave_date = start_leave_date,
    inform_date = null,
    medium = null,
    leave_type,
    leave_start_time = null,
    leave_end_time = null,
    description = null,
    reason,
    status = "Pending",
    rejected_reason = null,
    document = null,
    created_by
}) => {
    const normalizedUsername = String(username || "").trim();
    const normalizedStart = normalizeDate(start_leave_date);
    const normalizedEnd = normalizeDate(end_leave_date);
    const normalizedInformDate = normalizeDate(inform_date);

    if (!normalizedUsername) {
        const error = new Error("username is required");
        error.statusCode = 400;
        throw error;
    }

    if (
        !isValidDate(normalizedStart) ||
        !isValidDate(normalizedEnd) ||
        normalizedStart > normalizedEnd
    ) {
        const error = new Error("A valid leave date range is required");
        error.statusCode = 400;
        throw error;
    }

    if (inform_date && !isValidDate(normalizedInformDate)) {
        const error = new Error("Valid inform_date is required");
        error.statusCode = 400;
        throw error;
    }

    if (!reason || String(reason).trim() === "") {
        const error = new Error("reason is required");
        error.statusCode = 400;
        throw error;
    }

    const existingResult = await pool.query(
        `
            SELECT id
            FROM employee_leaves
            WHERE LOWER(TRIM(username)) = LOWER(TRIM($1))
              AND start_leave_date <= $3::date
              AND end_leave_date >= $2::date
            LIMIT 1
        `,
        [normalizedUsername, normalizedStart, normalizedEnd]
    );

    if (existingResult.rows.length > 0) {
        const error = new Error("Leave already exists in the requested date range");
        error.statusCode = 409;
        error.code = "DUPLICATE_LEAVE";
        throw error;
    }

    const leavePolicy = await calculateLeavePolicy({
        start_leave_date: normalizedStart,
        inform_date: normalizedInformDate
    });

    const query = `
        INSERT INTO employee_leaves (
            username,
            start_leave_date,
            end_leave_date,
            inform_date,
            medium,
            leave_type,
            leave_start_time,
            leave_end_time,
            description,
            reason,
            status,
            leave_policy,
            rejected_reason,
            document,
            created_by
        )
        VALUES (
            $1, $2::date, $3::date, $4::date, $5, $6, $7, $8,
            $9, $10, $11, $12::jsonb, $13, $14, $15
        )
        RETURNING *;
    `;

    const values = [
        normalizedUsername,
        normalizedStart,
        normalizedEnd,
        normalizedInformDate,
        medium,
        leave_type,
        normalizeOptionalTime(leave_start_time),
        normalizeOptionalTime(leave_end_time),
        description,
        reason,
        status || "Pending",
        JSON.stringify(leavePolicy),
        rejected_reason,
        document,
        created_by
    ];

    try {
        const result = await pool.query(
            query,
            values
        );

        return result.rows[0];

    } catch (error) {

        if (
            error.code === "23505" &&
            error.constraint === "unique_employee_leave"
        ) {
            const duplicateError =
                new Error(
                    "Leave already exists for this employee on this date range"
                );

            duplicateError.code = "DUPLICATE_LEAVE";
            duplicateError.statusCode = 409;

            throw duplicateError;
        }

        throw error;
    }
};

export const getLeavesModel = async ({
    username = null,
    name = null,
    date = null,
    startDate = null,
    endDate = null,
    sort = null,
    informDate = null,
    leave_type = null,
    days_before_leave = null,
    medium = null,
    reason = null,
    work_location = null,
    department = null,
    shift_name = null,
    shift_type = null,
    status = null,
    document = null,
    page = 1,
    limit = 20,
    pagination = true
} = {}) => {

    /* =========================================================
       PAGINATION SETTINGS
    ========================================================= */
    const paginationEnabled =
        pagination === true ||
        String(pagination).trim().toLowerCase() === "true";

    let currentPage =
        Number(page);

    let currentLimit =
        Number(limit);

    /* ================= PAGE ================= */
    if (
        !Number.isInteger(currentPage) ||
        currentPage < 1
    ) {
        currentPage = 1;
    }

    /* ================= LIMIT ================= */
    if (
        !Number.isInteger(currentLimit) ||
        currentLimit < 1
    ) {
        currentLimit = 20;
    }

    /* ================= MAX LIMIT ================= */
    if (currentLimit > 100) {
        currentLimit = 100;
    }

    /* ================= OFFSET ================= */
    const offset =
        (currentPage - 1) *
        currentLimit;


    /* =========================================================
       BASE QUERY
    ========================================================= */
    const values = [];
    let count = 1;

    let query = `
        SELECT
            el.id,
            el.username,

            TO_CHAR(
                el.start_leave_date,
                'YYYY-MM-DD'
            ) AS start_leave_date,

            TO_CHAR(
                el.end_leave_date,
                'YYYY-MM-DD'
            ) AS end_leave_date,

            TO_CHAR(
                el.inform_date,
                'YYYY-MM-DD'
            ) AS inform_date,

            el.medium,
            el.leave_type,

            TO_CHAR(
                el.leave_start_time,
                'HH24:MI'
            ) AS leave_start_time,

            TO_CHAR(
                el.leave_end_time,
                'HH24:MI'
            ) AS leave_end_time,

            el.description,
            el.reason,
            el.rejected_reason,
            el.document,
            
            /* ================= DAYS BEFORE LEAVE ================= */
            CASE
                WHEN el.inform_date IS NOT NULL
                     AND el.start_leave_date IS NOT NULL
                THEN
                    (
                        el.start_leave_date::date -
                        el.inform_date::date
                    )
                ELSE NULL
            END AS days_before_leave,

            el.status,
            el.leave_policy,
            el.created_at,
            el.updated_at,

            /* ================= PERSONAL ================= */
            pd.first_name,
            pd.middle_name,
            pd.last_name,

            TRIM(
                CONCAT_WS(
                    ' ',
                    NULLIF(TRIM(pd.first_name), ''),
                    NULLIF(TRIM(pd.middle_name), ''),
                    NULLIF(TRIM(pd.last_name), '')
                )
            )
            || ' (' ||
                UPPER(
                    LEFT(TRIM(COALESCE(el.username, '')), 1) ||
                    LEFT(
                        SPLIT_PART(TRIM(COALESCE(pd.middle_name, '')), ' ', 1),
                        1
                    ) ||
                    LEFT(TRIM(COALESCE(pd.last_name, '')), 1)
                )
            || ')' AS full_name,

            /* ================= CATEGORY ================= */
            ed.category AS category_id,
            c.category_name AS category,

            /* ================= WORK LOCATION ================= */
            ed.work_location AS work_location_id,
            wl.location AS work_location,

            /* ================= SHIFT ================= */
            ed.shift_id AS shift_id,
            sc.shift_name,
            sc.shift_type,
            sc.days AS shift_days,

            /* ================= EMPLOYEE STATUS ================= */
            me.status AS employee_status

        FROM employee_leaves el

        /* =====================================================
           PERSONAL DETAILS
        ===================================================== */
        LEFT JOIN personal_details pd
            ON LOWER(TRIM(pd.username))
             = LOWER(TRIM(el.username))

        /* =====================================================
           EMPLOYMENT DETAILS
        ===================================================== */
        LEFT JOIN employment_details ed
            ON ed.personal_details_id = pd.id

        /* =====================================================
           MASTER EMPLOYEE
        ===================================================== */
        LEFT JOIN master_employee me
            ON me.personal_details_id = pd.id

        LEFT JOIN LATERAL (
            SELECT epc_latest.*
            FROM employee_payroll_config epc_latest
            WHERE epc_latest.username = pd.username
            ORDER BY
                CASE
                    WHEN (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::DATE
                        BETWEEN epc_latest.payroll_start_date
                            AND epc_latest.payroll_end_date
                    THEN 0 ELSE 1
                END,
                epc_latest.payroll_start_date DESC,
                epc_latest.id DESC
            LIMIT 1
        ) epc ON TRUE

        /* =====================================================
           SHIFT
        ===================================================== */
        LEFT JOIN shift_configurations sc
            ON sc.id = ed.shift_id

        /* =====================================================
           CATEGORY
        ===================================================== */
        LEFT JOIN category c
            ON c.id = ed.category

        /* =====================================================
           WORK LOCATION
        ===================================================== */
        LEFT JOIN work_location wl
            ON wl.id = ed.work_location

        /* =====================================================
           DEPARTMENT
        ===================================================== */
        LEFT JOIN department_structure ds
            ON ds.id = ed.department

        WHERE 1 = 1
    `;

    /* =========================================================
       USERNAME FILTER
    ========================================================= */
    if (
        username !== null &&
        username !== undefined &&
        String(username).trim() !== ""
    ) {

        query += `
            AND LOWER(TRIM(el.username))
                LIKE LOWER(TRIM($${count}))
        `;

        values.push(
            `%${String(username).trim()}%`
        );

        count++;
    }

    /* =========================================================
       USERNAME FILTER (EXACT MATCH ONLY)
    ========================================================= */
    if (
        name !== null &&
        name !== undefined &&
        String(name).trim() !== ""
    ) {
        query += `
        AND LOWER(TRIM(COALESCE(el.username, '')))
            = LOWER($${count}::TEXT)
    `;

        values.push(String(name).trim());
        count++;
    }

    /* =========================================================
       LEAVE TYPE FILTER
    ========================================================= */
    if (
        leave_type !== null &&
        leave_type !== undefined &&
        String(leave_type).trim() !== "" &&
        String(leave_type).trim().toLowerCase() !== "all"
    ) {

        query += `
            AND LOWER(TRIM(el.leave_type::TEXT))
                = LOWER(TRIM($${count}::TEXT))
        `;

        values.push(
            String(leave_type).trim()
        );

        count++;
    }

    if (date !== null && date !== undefined && String(date).trim() !== "") {
        query += `
            AND el.start_leave_date::date <= $${count}::date
            AND el.end_leave_date::date >= $${count}::date
            AND (
                (
                    COALESCE(cardinality(sc.days), 0) > 0
                    AND EXISTS (
                        SELECT 1
                        FROM unnest(sc.days) AS shift_days(shift_day)
                        WHERE UPPER(TRIM(shift_day)) = CASE
                            EXTRACT(DOW FROM $${count}::date)::INT
                            WHEN 0 THEN 'SUN'
                            WHEN 1 THEN 'MON'
                            WHEN 2 THEN 'TUE'
                            WHEN 3 THEN 'WED'
                            WHEN 4 THEN 'THU'
                            WHEN 5 THEN 'FRI'
                            WHEN 6 THEN 'SAT'
                        END
                    )
                )
                OR (
                    COALESCE(cardinality(sc.days), 0) = 0
                    AND EXTRACT(DOW FROM $${count}::date)::INT <> 0
                )
                OR EXISTS (
                    SELECT 1
                    FROM holidays h
                    WHERE h.transfer_date = $${count}::date
                      AND (
                            h.locations IS NULL
                            OR cardinality(h.locations) = 0
                            OR ed.work_location::TEXT = ANY(h.locations)
                      )
                )
            )
            AND NOT EXISTS (
                SELECT 1
                FROM holidays h
                WHERE h.holiday_date = $${count}::date
                  AND (
                        h.locations IS NULL
                        OR cardinality(h.locations) = 0
                        OR ed.work_location::TEXT = ANY(h.locations)
                  )
            )
        `;

        values.push(String(date).trim());
        count++;
    }

    /* =========================================================
       START DATE FILTER
    ========================================================= */
    if (
        startDate !== null &&
        startDate !== undefined &&
        String(startDate).trim() !== ""
    ) {
        query += `
            AND el.end_leave_date::date >= $${count}::date
        `;

        values.push(
            String(startDate).trim()
        );

        count++;
    }

    /* =========================================================
       END DATE FILTER
    ========================================================= */
    if (
        endDate !== null &&
        endDate !== undefined &&
        String(endDate).trim() !== ""
    ) {
        query += `
            AND el.start_leave_date::date <= $${count}::date
        `;

        values.push(
            String(endDate).trim()
        );

        count++;
    }

    /* =========================================================
       DAYS BEFORE LEAVE FILTER
    ========================================================= */
    if (
        days_before_leave !== null &&
        days_before_leave !== undefined &&
        String(days_before_leave).trim() !== "" &&
        String(days_before_leave).trim().toLowerCase() !== "all"
    ) {
        const daysBeforeLeave = Number(days_before_leave);

        if (
            Number.isInteger(daysBeforeLeave) &&
            daysBeforeLeave >= 0
        ) {

            query += `
                AND (
                    el.start_leave_date::date -
                    el.inform_date::date
                ) = $${count}
            `;

            values.push(daysBeforeLeave);

            count++;
        }
    }

    /* =========================================================
       MEDIUM FILTER
    ========================================================= */
    if (
        medium !== null &&
        medium !== undefined &&
        String(medium).trim() !== "" &&
        String(medium).trim().toLowerCase() !== "all"
    ) {
        query += `
            AND LOWER(TRIM(el.medium::TEXT))
                = LOWER(TRIM($${count}::TEXT))
        `;
        values.push(
            String(medium).trim()
        );

        count++;
    }

    /* =========================================================
       REASON FILTER
    ========================================================= */
    if (
        reason !== null &&
        reason !== undefined &&
        String(reason).trim() !== ""
    ) {

        query += `
            AND LOWER(TRIM(el.reason::TEXT))
                LIKE LOWER(TRIM($${count}::TEXT))
        `;
        values.push(
            `%${String(reason).trim()}%`
        );

        count++;
    }

    /* =========================================================
       DEPARTMENT FILTER
    ========================================================= */
    if (
        department !== null &&
        department !== undefined &&
        String(department).trim() !== "" &&
        String(department)
            .trim()
            .toLowerCase() !== "all"
    ) {
        const departmentValue = String(department).trim();
        const departmentId = Number(departmentValue);

        if (
            Number.isInteger(departmentId) &&
            departmentId > 0
        ) {
            query += `
                AND ed.department = $${count}
            `;

            values.push(
                departmentId
            );

            count++;

        } else {
            query += `
                AND LOWER(TRIM(ds.name::TEXT))
                    = LOWER(TRIM($${count}::TEXT))
            `;

            values.push(
                departmentValue
            );

            count++;
        }
    }

    /* =========================================================
       START DATE FILTER
    ========================================================= */
    if (
        startDate !== null &&
        startDate !== undefined &&
        String(startDate).trim() !== ""
    ) {

        query += `
            AND el.end_leave_date::date >= $${count}::date
        `;

        values.push(
            String(startDate).trim()
        );

        count++;
    }

    /* =========================================================
       END DATE FILTER
    ========================================================= */
    if (
        endDate !== null &&
        endDate !== undefined &&
        String(endDate).trim() !== ""
    ) {
        query += `
            AND el.start_leave_date::date <= $${count}::date
        `;

        values.push(
            String(endDate).trim()
        );

        count++;
    }

    /* =========================================================
       INFORM DATE FILTER
    ========================================================= */
    if (
        informDate !== null &&
        informDate !== undefined &&
        String(informDate).trim() !== ""
    ) {

        query += `
        AND el.inform_date::date = $${count}::date
    `;

        values.push(
            String(informDate).trim()
        );

        count++;
    }

    /* =========================================================
       STATUS FILTER
    ========================================================= */
    if (
        status !== null &&
        status !== undefined &&
        String(status).trim() !== "" &&
        String(status).trim().toLowerCase() !== "all"
    ) {
        query += `
            AND LOWER(TRIM(el.status::TEXT))
                = LOWER(TRIM($${count}::TEXT))
        `;

        values.push(
            String(status).trim()
        );

        count++;
    }

    /* =========================================================
       DOCUMENT FILTER
       ?document=true  → document attached
       ?document=false → no document
    ========================================================= */
    if (
        document !== null &&
        document !== undefined &&
        String(document).trim() !== "" &&
        String(document).trim().toLowerCase() !== "all"
    ) {
        const documentValue = String(document)
            .trim()
            .toLowerCase();

        if (
            ["true", "yes", "1", "with", "attached"].includes(
                documentValue
            )
        ) {
            query += `
                AND el.document IS NOT NULL
                AND BTRIM(el.document) <> ''
            `;
        } else if (
            ["false", "no", "0", "without", "none"].includes(
                documentValue
            )
        ) {
            query += `
                AND (
                    el.document IS NULL
                    OR BTRIM(el.document) = ''
                )
            `;
        }
    }

    /* =========================================================
       WORK LOCATION FILTER
    ========================================================= */
    if (
        work_location !== null &&
        work_location !== undefined &&
        String(work_location).trim() !== "" &&
        String(work_location)
            .trim()
            .toLowerCase() !== "nan" &&
        String(work_location)
            .trim()
            .toLowerCase() !== "all"
    ) {

        const locationValue = String(work_location).trim();
        const locationId = Number(locationValue);

        if (
            Number.isInteger(locationId) &&
            locationId > 0
        ) {
            query += `
                AND wl.id = $${count}
            `;

            values.push(
                locationId
            );

            count++;

        } else {
            query += `
                AND LOWER(TRIM(wl.location))
                    = LOWER(TRIM($${count}))
            `;

            values.push(
                locationValue
            );

            count++;
        }
    }


    /* =========================================================
       SHIFT NAME FILTER
    ========================================================= */
    if (
        shift_name !== null &&
        shift_name !== undefined &&
        String(shift_name).trim() !== "" &&
        String(shift_name)
            .trim()
            .toLowerCase() !== "all"
    ) {
        const shiftValue = String(shift_name).trim();
        const shiftId = Number(shiftValue);

        if (
            Number.isInteger(shiftId) &&
            shiftId > 0
        ) {
            query += `
                AND sc.id = $${count}
            `;

            values.push(
                shiftId
            );

            count++;

        } else {
            query += `
                AND LOWER(TRIM(sc.shift_name::TEXT))
                    = LOWER(TRIM($${count}::TEXT))
            `;

            values.push(
                shiftValue
            );

            count++;
        }
    }

    /* =========================================================
       SHIFT TYPE FILTER
    ========================================================= */
    if (
        shift_type !== null &&
        shift_type !== undefined &&
        String(shift_type).trim() !== "" &&
        String(shift_type)
            .trim()
            .toLowerCase() !== "all"
    ) {
        query += `
            AND LOWER(TRIM(sc.shift_type::TEXT))
                = LOWER(TRIM($${count}::TEXT))
        `;

        values.push(
            String(shift_type).trim()
        );

        count++;
    }

    /* =========================================================
       MULTIPLE LEAVE SORT
    ========================================================= */
    let orderByParts = [];

    if (
        sort === null ||
        sort === undefined ||
        String(sort).trim() === ""
    ) {
        orderByParts.push("el.id DESC");
    } else {
        const sortValues = String(sort)
            .split(",")
            .map(value => value.trim().toLowerCase())
            .filter(Boolean);

        const allowedSorts = {
            id_asc: "el.id ASC",
            id_desc: "el.id DESC",
            start_leave_date_asc: "el.start_leave_date ASC",
            start_leave_date_desc: "el.start_leave_date DESC",
            created_at_asc: "el.created_at ASC",
            created_at_desc: "el.created_at DESC",
            inform_date_asc: "el.inform_date ASC",
            inform_date_desc: "el.inform_date DESC",
            username_asc: "el.username ASC",
            username_desc: "el.username DESC",
            status_asc: "el.status ASC",
            status_desc: "el.status DESC"
        };

        for (const sortValue of sortValues) {
            if (allowedSorts[sortValue]) {
                if (!orderByParts.includes(allowedSorts[sortValue])) {
                    orderByParts.push(
                        allowedSorts[sortValue]
                    );
                }
            }
        }

        if (orderByParts.length === 0) {
            orderByParts.push("el.id DESC");
        }

        if (
            !orderByParts.some(
                sortPart => sortPart.startsWith("el.id ")
            )
        ) {
            orderByParts.push("el.id DESC");
        }
    }

    query += `
        ORDER BY
            ${orderByParts.join(", ")}
    `;

    /* =========================================================
       COUNT TOTAL RECORDS
    ========================================================= */
    let total = 0;
    if (paginationEnabled) {
        const countQuery = `
            SELECT COUNT(*) AS total
            FROM (
                ${query}
            ) AS filtered_leaves
        `;

        const countResult =
            await pool.query(
                countQuery,
                values
            );

        total =
            Number(
                countResult.rows[0].total
            );
    }

    /* =========================================================
       PAGINATION
    ========================================================= */
    if (paginationEnabled) {
        query += `
            LIMIT $${count}
            OFFSET $${count + 1}
        `;

        values.push(
            currentLimit,
            offset
        );
    }

    /* =========================================================
       GET DATA
    ========================================================= */
    const {
        rows
    } = await pool.query(
        query,
        values
    );

    /* =========================================================
       PAGINATION RESPONSE
    ========================================================= */
    if (!paginationEnabled) {
        return {
            data: rows,
            pagination: {
                enabled: false
            }
        };
    }

    const totalPages =
        Math.ceil(
            total / currentLimit
        );

    return {
        data: rows,
        pagination: {
            enabled: true,
            total,
            page: currentPage,
            limit: currentLimit,
            totalPages
        }
    };
};

export const getLeaveByIdModel = async (id) => {
    const { rows } = await pool.query(
        `
        SELECT *
        FROM employee_leaves
        WHERE id=$1
        `,
        [id]
    );

    return rows[0];
};

/* =========================================================
   GET TODAY LEAVE COUNT + DETAILS
========================================================= */
export const getTodayLeaveModel = async ({
    work_location = null
} = {}) => {

    const values = [];

    let workLocationFilter = "";

    /* =====================================================
       WORK LOCATION FILTER BY NAME
       Example:
       ?work_location=ACDC TECH
    ===================================================== */
    if (
        work_location !== null &&
        work_location !== undefined &&
        String(work_location).trim() !== ""
    ) {

        values.push(String(work_location).trim());

        workLocationFilter = `
            AND LOWER(TRIM(wl.location))
                = LOWER(TRIM($1))
        `;
    }

    const query = `
        SELECT
            el.id,
            el.username,

            TO_CHAR(
                el.start_leave_date,
                'YYYY-MM-DD'
            ) AS start_leave_date,

            TO_CHAR(
                el.end_leave_date,
                'YYYY-MM-DD'
            ) AS end_leave_date,

            TO_CHAR(
                el.inform_date,
                'YYYY-MM-DD'
            ) AS inform_date,

            el.medium,
            el.leave_type,

            TO_CHAR(
                el.leave_start_time,
                'HH24:MI'
            ) AS leave_start_time,

            TO_CHAR(
                el.leave_end_time,
                'HH24:MI'
            ) AS leave_end_time,

            el.reason,
            el.description,
            el.rejected_reason,
            el.document,
            el.status,
            el.leave_policy,
            el.created_at,
            el.updated_at,

            pd.first_name,
            pd.middle_name,
            pd.last_name,

            CONCAT_WS(
                ' ',
                pd.first_name,
                pd.middle_name,
                pd.last_name
            ) AS employee_name,

            ed.category AS category_id,
            c.category_name AS category,

            ed.work_location AS work_location_id,
            wl.location AS work_location,

            ed.shift_id AS shift_id,
            sc.shift_name,
            sc.shift_type,

            me.status AS employee_status

        FROM employee_leaves el

        /* =====================================================
           PERSONAL DETAILS
        ===================================================== */
        LEFT JOIN personal_details pd
            ON LOWER(TRIM(pd.username))
             = LOWER(TRIM(el.username))

        /* =====================================================
           EMPLOYMENT DETAILS
        ===================================================== */
        LEFT JOIN employment_details ed
            ON ed.personal_details_id = pd.id

        /* =====================================================
           MASTER EMPLOYEE
        ===================================================== */
        LEFT JOIN master_employee me
            ON me.personal_details_id = pd.id

        LEFT JOIN LATERAL (
            SELECT epc_latest.*
            FROM employee_payroll_config epc_latest
            WHERE epc_latest.username = pd.username
            ORDER BY
                CASE
                    WHEN (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::DATE
                        BETWEEN epc_latest.payroll_start_date
                            AND epc_latest.payroll_end_date
                    THEN 0 ELSE 1
                END,
                epc_latest.payroll_start_date DESC,
                epc_latest.id DESC
            LIMIT 1
        ) epc ON TRUE

        /* =====================================================
           SHIFT
        ===================================================== */
        LEFT JOIN shift_configurations sc
            ON sc.id = ed.shift_id

        /* =====================================================
           CATEGORY
        ===================================================== */
        LEFT JOIN category c
            ON c.id = ed.category

        /* =====================================================
           WORK LOCATION
        ===================================================== */
        LEFT JOIN work_location wl
            ON wl.id = ed.work_location

        WHERE
            el.start_leave_date::date <= (
                CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata'
            )::date
            AND el.end_leave_date::date >= (
                CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata'
            )::date
            AND LOWER(TRIM(COALESCE(el.status, ''))) IN ('pending', 'approved')

            AND (
                (
                    COALESCE(cardinality(sc.days), 0) > 0
                    AND EXISTS (
                        SELECT 1
                        FROM unnest(sc.days) AS shift_days(shift_day)
                        WHERE UPPER(TRIM(shift_day)) = CASE
                            EXTRACT(DOW FROM (
                                CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata'
                            )::date)::INT
                            WHEN 0 THEN 'SUN'
                            WHEN 1 THEN 'MON'
                            WHEN 2 THEN 'TUE'
                            WHEN 3 THEN 'WED'
                            WHEN 4 THEN 'THU'
                            WHEN 5 THEN 'FRI'
                            WHEN 6 THEN 'SAT'
                        END
                    )
                )
                OR (
                    COALESCE(cardinality(sc.days), 0) = 0
                    AND EXTRACT(DOW FROM (
                        CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata'
                    )::date)::INT <> 0
                )
                OR EXISTS (
                    SELECT 1
                    FROM holidays h
                    WHERE h.transfer_date = (
                        CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata'
                    )::date
                      AND (
                            h.locations IS NULL
                            OR cardinality(h.locations) = 0
                            OR ed.work_location::TEXT = ANY(h.locations)
                      )
                )
            )
            AND NOT EXISTS (
                SELECT 1
                FROM holidays h
                WHERE h.holiday_date = (
                    CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata'
                )::date
                  AND (
                        h.locations IS NULL
                        OR cardinality(h.locations) = 0
                        OR ed.work_location::TEXT = ANY(h.locations)
                  )
            )

            ${workLocationFilter}

        ORDER BY
            el.id DESC
    `;

    const { rows } = await pool.query(query, values);

    return {
        leave_count: rows.length,
        leaves: rows
    };
};

/* =========================================================
   GET UPCOMING LEAVES - NEXT 10 DAYS
========================================================= */
export const getUpcomingLeavesModel = async ({
    username = null,
    status = null,
    work_location = null
} = {}) => {

    const values = [];
    let count = 1;

    let query = `
        SELECT
            el.id,
            el.username,

            TO_CHAR(
                el.start_leave_date,
                'YYYY-MM-DD'
            ) AS start_leave_date,

            TO_CHAR(
                el.end_leave_date,
                'YYYY-MM-DD'
            ) AS end_leave_date,

            TO_CHAR(
                el.inform_date,
                'YYYY-MM-DD'
            ) AS inform_date,

            el.medium,
            el.leave_type,

            TO_CHAR(
                el.leave_start_time,
                'HH24:MI'
            ) AS leave_start_time,

            TO_CHAR(
                el.leave_end_time,
                'HH24:MI'
            ) AS leave_end_time,

            el.description,
            el.reason,
            el.rejected_reason,
            el.document,

            CASE
                WHEN el.inform_date IS NOT NULL
                     AND el.start_leave_date IS NOT NULL
                THEN
                    (
                        el.start_leave_date::date -
                        el.inform_date::date
                    )
                ELSE NULL
            END AS days_before_leave,

            el.status,
            el.leave_policy,
            el.created_at,
            el.updated_at,

            pd.first_name,
            pd.middle_name,
            pd.last_name,

            ed.category AS category_id,
            c.category_name AS category,

            ed.work_location AS work_location_id,
            wl.location AS work_location,

            ed.shift_id AS shift_id,
            sc.shift_name,
            sc.shift_type,

            me.status AS employee_status

        FROM employee_leaves el

        LEFT JOIN personal_details pd
            ON LOWER(TRIM(pd.username))
             = LOWER(TRIM(el.username))

        LEFT JOIN employment_details ed
            ON ed.personal_details_id = pd.id

        LEFT JOIN master_employee me
            ON me.personal_details_id = pd.id

        LEFT JOIN LATERAL (
            SELECT epc_latest.*
            FROM employee_payroll_config epc_latest
            WHERE epc_latest.username = pd.username
            ORDER BY
                CASE
                    WHEN (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::DATE
                        BETWEEN epc_latest.payroll_start_date
                            AND epc_latest.payroll_end_date
                    THEN 0 ELSE 1
                END,
                epc_latest.payroll_start_date DESC,
                epc_latest.id DESC
            LIMIT 1
        ) epc ON TRUE

        LEFT JOIN shift_configurations sc
            ON sc.id = ed.shift_id

        LEFT JOIN category c
            ON c.id = ed.category

        LEFT JOIN work_location wl
            ON wl.id = ed.work_location

        WHERE
            el.end_leave_date::date >
            (
                CURRENT_TIMESTAMP
                AT TIME ZONE 'Asia/Kolkata'
            )::date

            AND el.start_leave_date::date <=
            (
                (
                    CURRENT_TIMESTAMP
                    AT TIME ZONE 'Asia/Kolkata'
                )::date + INTERVAL '10 days'
            )
    `;

    /* =====================================================
       USERNAME FILTER
    ===================================================== */
    if (
        username !== null &&
        username !== undefined &&
        String(username).trim() !== ""
    ) {
        query += `
            AND LOWER(TRIM(el.username))
                = LOWER(TRIM($${count}))
        `;

        values.push(
            String(username).trim()
        );

        count++;
    }

    /* =====================================================
       STATUS FILTER
    ===================================================== */
    if (
        status !== null &&
        status !== undefined &&
        String(status).trim() !== "" &&
        String(status).trim().toLowerCase() !== "all"
    ) {
        query += `
            AND LOWER(TRIM(el.status::TEXT))
                = LOWER(TRIM($${count}::TEXT))
        `;

        values.push(
            String(status).trim()
        );

        count++;
    }

    /* =====================================================
       WORK LOCATION FILTER
       Example:
       ?work_location=ACDC TECH
    ===================================================== */
    if (
        work_location !== null &&
        work_location !== undefined &&
        String(work_location).trim() !== "" &&
        String(work_location).trim().toLowerCase() !== "all"
    ) {
        query += `
            AND LOWER(TRIM(wl.location))
                = LOWER(TRIM($${count}))
        `;

        values.push(
            String(work_location).trim()
        );

        count++;
    }

    query += `
        ORDER BY
            el.start_leave_date ASC,
            el.id ASC
    `;

    const {
        rows
    } = await pool.query(
        query,
        values
    );

    return rows;
};

/* =========================================================
   GET LEAVE STATUS COUNTS
========================================================= */
export const getLeaveStatusCountsModel = async ({
    status = null,
    work_location = null,
    username = null,
    name = null,
    leave_type = null,
    startDate = null,
    endDate = null,
    informDate = null,
    days_before_leave = null,
    medium = null,
    reason = null,
    department = null,
    shift_name = null,
    shift_type = null
} = {}) => {
    const values = [];
    let count = 1;

    let query = `
        SELECT
            LOWER(TRIM(el.status::TEXT)) AS status,
            COUNT(*) AS count

        FROM employee_leaves el

        LEFT JOIN personal_details pd
            ON LOWER(TRIM(pd.username))
                = LOWER(TRIM(el.username))

        LEFT JOIN employment_details ed
            ON ed.personal_details_id = pd.id

        LEFT JOIN work_location wl
            ON wl.id = ed.work_location

        LEFT JOIN department_structure ds
            ON ds.id = ed.department

        LEFT JOIN LATERAL (
            SELECT epc_latest.*
            FROM employee_payroll_config epc_latest
            WHERE epc_latest.username = pd.username
            ORDER BY
                CASE
                    WHEN (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::DATE
                        BETWEEN epc_latest.payroll_start_date
                            AND epc_latest.payroll_end_date
                    THEN 0 ELSE 1
                END,
                epc_latest.payroll_start_date DESC,
                epc_latest.id DESC
            LIMIT 1
        ) epc ON TRUE

        LEFT JOIN shift_configurations sc
            ON sc.id = ed.shift_id

        WHERE
            LOWER(TRIM(el.status::TEXT)) IN (
                'pending',
                'approved',
                'cancelled',
                'rejected'
            )
    `;

    /* =====================================================
       STATUS FILTER
    ===================================================== */
    if (
        status !== null &&
        status !== undefined &&
        String(status).trim() !== "" &&
        String(status).trim().toLowerCase() !== "all"
    ) {

        const statusValue =
            String(status)
                .trim()
                .toLowerCase();

        const allowedStatuses = [
            "pending",
            "approved",
            "cancelled",
            "rejected"
        ];

        if (allowedStatuses.includes(statusValue)) {
            query += `
                AND LOWER(TRIM(el.status::TEXT))
                    = $${count}::TEXT
            `;

            values.push(statusValue);
            count++;
        }
    }

    /* =====================================================
       USERNAME FILTER (same as all-leave)
    ===================================================== */
    if (
        username !== null &&
        username !== undefined &&
        String(username).trim() !== ""
    ) {
        query += `
            AND LOWER(TRIM(el.username))
                LIKE LOWER(TRIM($${count}))
        `;

        values.push(`%${String(username).trim()}%`);
        count++;
    }

    /* =====================================================
       NAME / USERNAME FILTER (same as all-leave)
    ===================================================== */
    if (
        name !== null &&
        name !== undefined &&
        String(name).trim() !== ""
    ) {
        query += `
            AND (
                LOWER(TRIM(COALESCE(pd.first_name, '')))
                    LIKE LOWER(TRIM($${count}::TEXT))
                OR
                LOWER(TRIM(COALESCE(pd.middle_name, '')))
                    LIKE LOWER(TRIM($${count}::TEXT))
                OR
                LOWER(TRIM(COALESCE(pd.last_name, '')))
                    LIKE LOWER(TRIM($${count}::TEXT))
                OR
                LOWER(
                    TRIM(
                        CONCAT_WS(
                            ' ',
                            pd.first_name,
                            pd.middle_name,
                            pd.last_name
                        )
                    )
                )
                    LIKE LOWER(TRIM($${count}::TEXT))
                OR
                LOWER(TRIM(COALESCE(el.username, '')))
                    LIKE LOWER(TRIM($${count}::TEXT))
            )
        `;

        values.push(`%${String(name).trim()}%`);
        count++;
    }

    /* =====================================================
       LEAVE TYPE FILTER (same as all-leave)
    ===================================================== */
    if (
        leave_type !== null &&
        leave_type !== undefined &&
        String(leave_type).trim() !== "" &&
        String(leave_type).trim().toLowerCase() !== "all"
    ) {
        query += `
            AND LOWER(TRIM(el.leave_type::TEXT))
                = LOWER(TRIM($${count}::TEXT))
        `;

        values.push(String(leave_type).trim());
        count++;
    }

    /* =====================================================
       DATE RANGE FILTER (same as all-leave)
    ===================================================== */
    if (
        startDate !== null &&
        startDate !== undefined &&
        String(startDate).trim() !== ""
    ) {
        query += `
            AND el.end_leave_date::date >= $${count}::date
        `;

        values.push(String(startDate).trim());
        count++;
    }

    if (
        endDate !== null &&
        endDate !== undefined &&
        String(endDate).trim() !== ""
    ) {
        query += `
            AND el.start_leave_date::date <= $${count}::date
        `;

        values.push(String(endDate).trim());
        count++;
    }

    /* =====================================================
       INFORM DATE FILTER (same as all-leave)
    ===================================================== */
    if (
        informDate !== null &&
        informDate !== undefined &&
        String(informDate).trim() !== ""
    ) {
        query += `
            AND el.inform_date::date = $${count}::date
        `;

        values.push(String(informDate).trim());
        count++;
    }

    /* =====================================================
       DAYS BEFORE LEAVE FILTER (same as all-leave)
    ===================================================== */
    if (
        days_before_leave !== null &&
        days_before_leave !== undefined &&
        String(days_before_leave).trim() !== "" &&
        String(days_before_leave).trim().toLowerCase() !== "all"
    ) {
        const daysBeforeLeave = Number(days_before_leave);

        if (
            Number.isInteger(daysBeforeLeave) &&
            daysBeforeLeave >= 0
        ) {
            query += `
                AND (
                    el.start_leave_date::date -
                    el.inform_date::date
                ) = $${count}
            `;

            values.push(daysBeforeLeave);
            count++;
        }
    }

    /* =====================================================
       MEDIUM FILTER (same as all-leave)
    ===================================================== */
    if (
        medium !== null &&
        medium !== undefined &&
        String(medium).trim() !== "" &&
        String(medium).trim().toLowerCase() !== "all"
    ) {
        query += `
            AND LOWER(TRIM(el.medium::TEXT))
                = LOWER(TRIM($${count}::TEXT))
        `;

        values.push(String(medium).trim());
        count++;
    }

    /* =====================================================
       REASON FILTER (same as all-leave)
    ===================================================== */
    if (
        reason !== null &&
        reason !== undefined &&
        String(reason).trim() !== ""
    ) {
        query += `
            AND LOWER(TRIM(el.reason::TEXT))
                LIKE LOWER(TRIM($${count}::TEXT))
        `;

        values.push(`%${String(reason).trim()}%`);
        count++;
    }

    /* =====================================================
       DEPARTMENT FILTER (same as all-leave)
    ===================================================== */
    if (
        department !== null &&
        department !== undefined &&
        String(department).trim() !== "" &&
        String(department).trim().toLowerCase() !== "all"
    ) {
        const departmentValue = String(department).trim();
        const departmentId = Number(departmentValue);

        if (
            Number.isInteger(departmentId) &&
            departmentId > 0
        ) {
            query += `
                AND ed.department = $${count}
            `;

            values.push(departmentId);
            count++;
        } else {
            query += `
                AND LOWER(TRIM(ds.name::TEXT))
                    = LOWER(TRIM($${count}::TEXT))
            `;

            values.push(departmentValue);
            count++;
        }
    }

    /* =====================================================
       WORK LOCATION FILTER (same as all-leave)
    ===================================================== */
    if (
        work_location !== null &&
        work_location !== undefined &&
        String(work_location).trim() !== "" &&
        String(work_location).trim().toLowerCase() !== "nan" &&
        String(work_location).trim().toLowerCase() !== "all"
    ) {
        const locationValue = String(work_location).trim();
        const locationId = Number(locationValue);

        if (
            Number.isInteger(locationId) &&
            locationId > 0
        ) {
            query += `
                AND wl.id = $${count}
            `;

            values.push(locationId);
            count++;
        } else {
            query += `
                AND LOWER(TRIM(wl.location))
                    = LOWER(TRIM($${count}))
            `;

            values.push(locationValue);
            count++;
        }
    }

    /* =====================================================
       SHIFT NAME FILTER (same as all-leave)
    ===================================================== */
    if (
        shift_name !== null &&
        shift_name !== undefined &&
        String(shift_name).trim() !== "" &&
        String(shift_name).trim().toLowerCase() !== "all"
    ) {
        const shiftValue = String(shift_name).trim();
        const shiftId = Number(shiftValue);

        if (
            Number.isInteger(shiftId) &&
            shiftId > 0
        ) {
            query += `
                AND sc.id = $${count}
            `;

            values.push(shiftId);
            count++;
        } else {
            query += `
                AND LOWER(TRIM(sc.shift_name::TEXT))
                    = LOWER(TRIM($${count}::TEXT))
            `;

            values.push(shiftValue);
            count++;
        }
    }

    /* =====================================================
       SHIFT TYPE FILTER (same as all-leave)
    ===================================================== */
    if (
        shift_type !== null &&
        shift_type !== undefined &&
        String(shift_type).trim() !== "" &&
        String(shift_type).trim().toLowerCase() !== "all"
    ) {
        query += `
            AND LOWER(TRIM(sc.shift_type::TEXT))
                = LOWER(TRIM($${count}::TEXT))
        `;

        values.push(String(shift_type).trim());
        count++;
    }

    /* =====================================================
       GROUP BY STATUS
    ===================================================== */
    query += `
        GROUP BY
            LOWER(TRIM(el.status::TEXT))
    `;

    const {
        rows
    } = await pool.query(
        query,
        values
    );

    /* =====================================================
       ALWAYS RETURN ALL 4 STATUS COUNTS
    ===================================================== */
    const statusCounts = {
        pending: 0,
        approved: 0,
        cancelled: 0,
        rejected: 0
    };

    rows.forEach((row) => {

        const statusName =
            String(row.status)
                .toLowerCase();

        if (
            Object.prototype.hasOwnProperty.call(
                statusCounts,
                statusName
            )
        ) {
            statusCounts[statusName] =
                Number(row.count || 0);
        }
    });

    return statusCounts;
};

/* =========================================================
   GET PENDING LEAVE COUNT + DATA
========================================================= */
export const getPendingLeaveCountModel = async ({
    work_location = null
} = {}) => {
    const queryParams = [];

    const conditions = [
        `
            LOWER(TRIM(el.status::TEXT)) = 'pending'
        `
    ];

    /* =====================================================
       WORK LOCATION FILTER (same as all-leave)
       name athva id — ?work_location=ACDC TECH / 1
    ===================================================== */
    if (
        work_location !== null &&
        work_location !== undefined &&
        String(work_location).trim() !== "" &&
        String(work_location).trim().toLowerCase() !== "all"
    ) {
        const locationValue = String(work_location).trim();
        const locationId = Number(locationValue);

        if (Number.isInteger(locationId) && locationId > 0) {
            queryParams.push(locationId);
            conditions.push(`
                wl.id = $${queryParams.length}
            `);
        } else {
            queryParams.push(locationValue);
            conditions.push(`
                LOWER(TRIM(wl.location))
                    = LOWER(TRIM($${queryParams.length}))
            `);
        }
    }

    /* =====================================================
       FINAL QUERY
    ===================================================== */
    const query = `
        SELECT
            el.id,
            el.username,

            TO_CHAR(
                el.start_leave_date,
                'YYYY-MM-DD'
            ) AS start_leave_date,

            TO_CHAR(
                el.end_leave_date,
                'YYYY-MM-DD'
            ) AS end_leave_date,

            TO_CHAR(
                el.inform_date,
                'YYYY-MM-DD'
            ) AS inform_date,

            el.medium,
            el.leave_type,

            TO_CHAR(
                el.leave_start_time,
                'HH24:MI'
            ) AS leave_start_time,

            TO_CHAR(
                el.leave_end_time,
                'HH24:MI'
            ) AS leave_end_time,

            el.description,
            el.reason,
            el.rejected_reason,
            el.document,

            CASE
                WHEN el.inform_date IS NOT NULL
                     AND el.start_leave_date IS NOT NULL
                THEN
                    (
                        el.start_leave_date::date -
                        el.inform_date::date
                    )
                ELSE NULL
            END AS days_before_leave,

            el.status,
            el.leave_policy,
            el.created_at,
            el.updated_at,

            pd.first_name,
            pd.middle_name,
            pd.last_name,

            ed.category AS category_id,
            c.category_name AS category,

            ed.work_location AS work_location_id,
            wl.location AS work_location,

            ed.shift_id AS shift_id,
            sc.shift_name,
            sc.shift_type,

            me.status AS employee_status

        FROM employee_leaves el

        LEFT JOIN personal_details pd
            ON LOWER(TRIM(pd.username))
                = LOWER(TRIM(el.username))

        LEFT JOIN LATERAL (
            SELECT
                ed_inner.work_location,
                ed_inner.category,
                ed_inner.personal_details_id
            FROM employment_details ed_inner
            WHERE ed_inner.personal_details_id = pd.id
               OR LOWER(TRIM(ed_inner.username)) =
                  LOWER(TRIM(el.username))
            ORDER BY ed_inner.id DESC
            LIMIT 1
        ) ed ON TRUE

        LEFT JOIN master_employee me
            ON me.personal_details_id = pd.id

        LEFT JOIN LATERAL (
            SELECT epc_latest.*
            FROM employee_payroll_config epc_latest
            WHERE epc_latest.username = pd.username
            ORDER BY
                CASE
                    WHEN (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::DATE
                        BETWEEN epc_latest.payroll_start_date
                            AND epc_latest.payroll_end_date
                    THEN 0 ELSE 1
                END,
                epc_latest.payroll_start_date DESC,
                epc_latest.id DESC
            LIMIT 1
        ) epc ON TRUE

        LEFT JOIN shift_configurations sc
            ON sc.id = ed.shift_id

        LEFT JOIN category c
            ON c.id = ed.category

        LEFT JOIN work_location wl
            ON wl.id = ed.work_location

        WHERE
            ${conditions.join("\nAND ")}

        ORDER BY
            el.start_leave_date ASC,
            el.id ASC
    `;

    const {
        rows
    } = await pool.query(
        query,
        queryParams
    );

    return {
        pending_count: rows.length,
        leaves: rows
    };
};

export const getEmployeeLeaveByYearModel = async (
    year,
    dateMode = "joining"
) => {
    const query = `
        SELECT
            username,
                        start_leave_date,
                        end_leave_date,
            leave_type
        FROM employee_leaves
        WHERE start_leave_date < CASE
                  WHEN $2 = 'financial_year'
                  THEN MAKE_DATE($1::int + 1, 4, 1)
                  ELSE MAKE_DATE($1::int + 1, 1, 1)
              END
          AND end_leave_date >= CASE
                  WHEN $2 = 'financial_year'
                  THEN MAKE_DATE($1::int, 4, 1)
                  ELSE MAKE_DATE($1::int, 1, 1)
              END
    `;

    const { rows } = await pool.query(
        query,
        [year, dateMode]
    );

    return rows;
};

export const updateLeaveStatusModel = async (
    id,
    status,
    rejected_reason = null,
    document = null
) => {
    const { rows } = await pool.query(
        `
            UPDATE employee_leaves
            SET
                status = $1,
                rejected_reason = COALESCE($2, rejected_reason),
                document = COALESCE($3, document),
                updated_at = TIMEZONE(
                    'Asia/Kolkata',
                    CURRENT_TIMESTAMP
                )
            WHERE id = $4
            RETURNING *;
        `,
        [status, rejected_reason, document, id]
    );

    return rows[0];
};

export const getLeaveCalendarModel = async ({
    view = "monthly",
    month = null,
    year = null,
    financial_year = null,
    yearly_filter = null,
    username = null,
    work_location = null,
    department = null,
    shift_name = null,
    shift_type = null
} = {}) => {

    /* ================= NORMALIZE VIEW ================= */
    const normalizedView =
        String(view)
            .trim()
            .toLowerCase();

    if (
        !["monthly", "yearly"].includes(
            normalizedView
        )
    ) {
        throw new Error("view must be monthly or yearly");
    }

    let firstDate = null;
    let lastDate = null;
    let numericMonth = null;
    let numericYear = null;
    let financialYear = null;

    /* ================= MONTHLY DATE RANGE ================= */
    if (normalizedView === "monthly") {
        numericMonth = Number(month);
        numericYear = Number(year);

        if (
            !Number.isInteger(numericMonth) ||
            numericMonth < 1 ||
            numericMonth > 12
        ) {
            throw new Error("Invalid month");
        }

        if (
            !Number.isInteger(numericYear) ||
            numericYear < 2000
        ) {
            throw new Error("Invalid year");
        }

        firstDate =
            `${numericYear}-${String(
                numericMonth
            ).padStart(2, "0")}-01`;

        const lastDateResult =
            await pool.query(
                `
                SELECT TO_CHAR(
                    (
                        DATE_TRUNC(
                            'month',
                            $1::date
                        )
                        + INTERVAL '1 month'
                        - INTERVAL '1 day'
                    )::date,
                    'YYYY-MM-DD'
                ) AS last_date
                `,
                [firstDate]
            );

        lastDate = lastDateResult.rows[0].last_date;

    }

    /* ================= YEARLY ================= */
    else {
        const filter =
            String(yearly_filter || "")
                .trim()
                .toLowerCase();

        /* ================= YEARLY - JOINING DATE ================= */
        if (filter === "joining_date") {
            numericYear = Number(year);
            if (
                !Number.isInteger(numericYear) ||
                numericYear < 2000
            ) {
                throw new Error(
                    "Invalid year"
                );
            }

            firstDate = `${numericYear}-01-01`;
            lastDate = `${numericYear}-12-31`;
        }

        /* ================= YEARLY - FINANCIAL YEAR ================= */
        else if (
            filter === "financial_year"
        ) {
            financialYear =
                String(financial_year)
                    .trim();

            const financialYearMatch =
                financialYear.match(
                    /^(\d{4})-(\d{2}|\d{4})$/
                );

            if (!financialYearMatch) {
                throw new Error(
                    "Invalid financial_year. Use YYYY-YY or YYYY-YYYY"
                );
            }

            const startYear = Number(
                financialYearMatch[1]
            );

            const endPart = financialYearMatch[2];

            let endYear;

            if (endPart.length === 2) {
                endYear =
                    Number(
                        `${String(startYear).slice(0, 2)}${endPart}`
                    );

            } else {
                endYear = Number(endPart);
            }

            if (
                !Number.isInteger(startYear) ||
                !Number.isInteger(endYear) ||
                endYear !== startYear + 1
            ) {
                throw new Error(
                    "Invalid financial_year"
                );
            }

            firstDate = `${startYear}-04-01`;
            lastDate = `${endYear}-03-31`;
        }
        else {
            throw new Error("yearly_filter must be joining_date or financial_year");
        }
    }

    /* ================= EMPLOYEES ================= */
    const employeeValues = [];
    let employeeCount = 1;

    let employeeQuery = `
        SELECT DISTINCT ON (pd.username)

            pd.username,
            pd.first_name,
            pd.middle_name,
            pd.last_name,

            ed.category AS category_id,
            c.category_name AS category,

            ed.work_location AS work_location_id,
            wl.location AS work_location,

            ed.department AS department_id,

            TO_CHAR(
                ed.date_of_joining,
                'YYYY-MM-DD'
            ) AS date_of_joining,

            ed.shift_id AS shift_id,
            sc.shift_name,
            sc.days AS shift_days,

            sc.shift_type,

            me.status AS employee_status

        FROM personal_details pd

        INNER JOIN employment_details ed
            ON ed.personal_details_id = pd.id

        INNER JOIN master_employee me
            ON me.personal_details_id = pd.id

        LEFT JOIN LATERAL (
            SELECT epc_latest.*
            FROM employee_payroll_config epc_latest
            WHERE epc_latest.username = pd.username
            ORDER BY
                CASE
                    WHEN (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::DATE
                        BETWEEN epc_latest.payroll_start_date
                            AND epc_latest.payroll_end_date
                    THEN 0 ELSE 1
                END,
                epc_latest.payroll_start_date DESC,
                epc_latest.id DESC
            LIMIT 1
        ) epc ON TRUE

        LEFT JOIN category c
            ON c.id = ed.category

        LEFT JOIN work_location wl
            ON wl.id = ed.work_location

        LEFT JOIN shift_configurations sc
            ON sc.id = ed.shift_id

        WHERE
            LOWER(
                TRIM(
                    me.status::TEXT
                )
            ) = 'active'
    `;

    /* ================= YEARLY JOINING DATE FILTER ================= */
    if (
        normalizedView === "yearly" &&
        String(yearly_filter)
            .trim()
            .toLowerCase() ===
        "joining_date"
    ) {

        employeeQuery += `
            AND ed.date_of_joining
                BETWEEN $${employeeCount}::date
                AND $${employeeCount + 1}::date
        `;

        employeeValues.push(
            firstDate,
            lastDate
        );

        employeeCount += 2;
    }

    /* ================= USERNAME FILTER ================= */
    if (
        username !== null &&
        username !== undefined &&
        String(username).trim() !== "" &&
        String(username).trim().toLowerCase() !== "all"
    ) {
        const usernameList = Array.isArray(username)
            ? username
            : String(username)
                .split(",")
                .map(value => value.trim())
                .filter(Boolean);

        const validUsernames = usernameList.filter(
            value =>
                String(value).trim() !== "" &&
                String(value).trim().toLowerCase() !== "all"
        );

        if (validUsernames.length > 0) {
            const usernameConditions = [];
            for (const usernameValue of validUsernames) {
                usernameConditions.push(`
                    LOWER(
                        TRIM(pd.username)
                    ) LIKE LOWER(
                        TRIM($${employeeCount})
                    )
                `);

                employeeValues.push(
                    `%${String(usernameValue).trim()}%`
                );

                employeeCount++;
            }

            employeeQuery += `
                AND (
                    ${usernameConditions.join(" OR ")}
                )
            `;
        }
    }

    /* ================= WORK LOCATION FILTER ================= */
    if (
        work_location !== null &&
        work_location !== undefined &&
        String(work_location).trim() !== "" &&
        String(work_location)
            .trim()
            .toLowerCase() !== "all" &&
        String(work_location)
            .trim()
            .toLowerCase() !== "nan"
    ) {
        const locationValue = String(work_location).trim();
        const locationId = Number(locationValue);

        if (
            Number.isInteger(locationId) &&
            locationId > 0
        ) {
            employeeQuery += `
                AND wl.id = $${employeeCount}
            `;

            employeeValues.push(locationId);

        } else {
            employeeQuery += `
                AND LOWER(
                    TRIM(wl.location)
                )
                =
                LOWER(
                    TRIM($${employeeCount})
                )
            `;

            employeeValues.push(
                locationValue
            );
        }

        employeeCount++;
    }

    /* ================= DEPARTMENT FILTER ================= */
    if (
        department !== null &&
        department !== undefined &&
        String(department).trim() !== "" &&
        String(department)
            .trim()
            .toLowerCase() !== "all"
    ) {
        const departmentValue = String(department).trim();
        const departmentId = Number(departmentValue);

        if (
            Number.isInteger(departmentId) &&
            departmentId > 0
        ) {
            employeeQuery += `
                AND ed.department = $${employeeCount}
            `;

            employeeValues.push(
                departmentId
            );

        } else {
            employeeQuery += `
                AND EXISTS (
                    SELECT 1
                    FROM department_structure ds
                    WHERE
                        ds.id = ed.department

                        AND LOWER(
                            TRIM(ds.name::TEXT)
                        )
                        =
                        LOWER(
                            TRIM(
                                $${employeeCount}::TEXT
                            )
                        )
                )
            `;

            employeeValues.push(departmentValue);
        }

        employeeCount++;
    }

    /* ================= SHIFT NAME FILTER ================= */
    if (
        shift_name !== null &&
        shift_name !== undefined &&
        String(shift_name).trim() !== "" &&
        String(shift_name)
            .trim()
            .toLowerCase() !== "all"
    ) {
        const shiftValue = String(shift_name).trim();
        const shiftId = Number(shiftValue);

        if (
            Number.isInteger(shiftId) &&
            shiftId > 0
        ) {
            employeeQuery += `
                AND sc.id = $${employeeCount}
            `;

            employeeValues.push(shiftId);

        } else {
            employeeQuery += `
                AND LOWER(
                    TRIM(sc.shift_name::TEXT)
                )
                =
                LOWER(
                    TRIM(
                        $${employeeCount}::TEXT
                    )
                )
            `;

            employeeValues.push(
                shiftValue
            );
        }

        employeeCount++;
    }

    /* ================= SHIFT TYPE FILTER ================= */
    if (
        shift_type !== null &&
        shift_type !== undefined &&
        String(shift_type).trim() !== "" &&
        String(shift_type)
            .trim()
            .toLowerCase() !== "all"
    ) {
        employeeQuery += `
            AND LOWER(
                TRIM(sc.shift_type::TEXT)
            )
            =
            LOWER(
                TRIM(
                    $${employeeCount}::TEXT
                )
            )
        `;

        employeeValues.push(
            String(shift_type).trim()
        );

        employeeCount++;
    }

    /* ================= ORDER ================= */
    employeeQuery += `
        ORDER BY
            pd.username,
            pd.id DESC
    `;

    const employeeResult =
        await pool.query(
            employeeQuery,
            employeeValues
        );

    const employees = employeeResult.rows;

    /* ================= NO EMPLOYEES ================= */
    if (!employees.length) {
        return {
            view: normalizedView,
            month:
                normalizedView === "monthly"
                    ? numericMonth
                    : null,

            year:
                normalizedView === "monthly"
                    ? numericYear
                    : String(yearly_filter)
                        .toLowerCase() ===
                        "joining_date"
                        ? numericYear
                        : null,

            yearly_filter:
                normalizedView === "yearly"
                    ? String(yearly_filter)
                        .toLowerCase()
                    : null,

            financial_year:
                normalizedView === "yearly" &&
                    String(yearly_filter)
                        .toLowerCase() ===
                    "financial_year"
                    ? financialYear
                    : null,

            date_range: {
                from: firstDate,
                to: lastDate
            },

            total_employees: 0,
            summary: {
                present: 0,
                absent: 0,
                leave: 0,
                holiday: 0
            },

            data: []
        };
    }

    /* ================= USERNAME LIST ================= */
    const usernames =
        employees.map(
            employee =>
                employee.username
        );

    /* ================= HOLIDAYS ================= */
    const holidayResult = await pool.query(
        `
            SELECT
                id,
                holiday_name,
                TO_CHAR(holiday_date, 'YYYY-MM-DD') AS holiday_date,
                TO_CHAR(transfer_date, 'YYYY-MM-DD') AS transfer_date,
                locations
            FROM holidays
            WHERE holiday_date BETWEEN $1::date AND $2::date
               OR transfer_date BETWEEN $1::date AND $2::date
            ORDER BY COALESCE(transfer_date, holiday_date), id
        `,
        [firstDate, lastDate]
    );

    const holidaysByDate = new Map();
    const transferHolidaysByDate = new Map();

    const addHolidayToDateMap = (map, date, holiday) => {
        if (!date) {
            return;
        }

        if (!map.has(date)) {
            map.set(date, []);
        }

        map.get(date).push(holiday);
    };

    for (const holiday of holidayResult.rows) {
        addHolidayToDateMap(
            holidaysByDate,
            holiday.holiday_date,
            holiday
        );
        addHolidayToDateMap(
            transferHolidaysByDate,
            holiday.transfer_date,
            holiday
        );
    }

    /* ================= ATTENDANCE ================= */
    const attendanceQuery = `
        SELECT DISTINCT ON (
            ats.username,
            ats.entry_at::date
        )

            ats.id AS attendance_id,
            ats.username,
            TO_CHAR(
                ats.entry_at::date,
                'YYYY-MM-DD'
            ) AS attendance_date,

            ats.entry_at,
            ats.exit_at,
            ats.status

        FROM attendance_sessions ats

        WHERE
            ats.username = ANY($1::text[])

            AND ats.entry_at::date
                BETWEEN $2::date
                AND $3::date

        ORDER BY
            ats.username,
            ats.entry_at::date,
            ats.entry_at DESC,
            ats.id DESC
    `;

    const attendanceResult =
        await pool.query(
            attendanceQuery,
            [
                usernames,
                firstDate,
                lastDate
            ]
        );

    /* ================= ATTENDANCE MAP ================= */
    const attendanceMap = new Map();

    for (
        const row
        of attendanceResult.rows
    ) {
        const attendanceDate =
            String(
                row.attendance_date
            ).slice(0, 10);

        const key = `${row.username}_${attendanceDate}`;

        let status = "Absent";

        if (
            row.status === "completed" ||
            row.status === "inside"
        ) {
            status = "Present";
        }

        attendanceMap.set(
            key,
            {
                attendance_id: row.attendance_id,
                status,
                entry_at: row.entry_at,
                exit_at: row.exit_at
            }
        );
    }

    /* ================= LEAVES ================= */
    const leaveQuery = `
        SELECT

            id,
            username,
            TO_CHAR(
                start_leave_date,
                'YYYY-MM-DD'
            ) AS start_leave_date,

            TO_CHAR(
                end_leave_date,
                'YYYY-MM-DD'
            ) AS end_leave_date,

            TO_CHAR(
                inform_date,
                'YYYY-MM-DD'
            ) AS inform_date,

            medium,
            leave_type,
            leave_start_time,
            leave_end_time,
            reason,
            description,
            rejected_reason,
            document,
            status,
            leave_policy,
            created_at,
            updated_at,
            created_by

        FROM employee_leaves

        WHERE
            username = ANY($1::text[])

            AND start_leave_date <= $3::date
            AND end_leave_date >= $2::date

        ORDER BY
            start_leave_date ASC,
            id ASC
    `;

    const leaveResult =
        await pool.query(
            leaveQuery,
            [
                usernames,
                firstDate,
                lastDate
            ]
        );

    /* ================= LEAVE MAP ================= */
    const leaveMap = new Map();
    const employeesByUsername = new Map(
        employees.map(employee => [employee.username, employee])
    );

    for (
        const row
        of leaveResult.rows
    ) {
        const employee = employeesByUsername.get(row.username);
        if (!employee) {
            continue;
        }

        const rangeStart = String(row.start_leave_date).slice(0, 10);
        const rangeEnd = String(row.end_leave_date).slice(0, 10);
        const visibleStart = rangeStart < firstDate ? firstDate : rangeStart;
        const visibleEnd = rangeEnd > lastDate ? lastDate : rangeEnd;

        for (const calendarDate of getDatesBetween(visibleStart, visibleEnd)) {
            const weekday = new Date(`${calendarDate}T00:00:00Z`).getUTCDay();
            const weekdayName = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][weekday];
            const shiftDays = Array.isArray(employee.shift_days)
                ? employee.shift_days.map(day => String(day).trim().toUpperCase())
                : [];
            const isWeeklyOff = shiftDays.length > 0
                ? !shiftDays.includes(weekdayName)
                : weekday === 0;
            const isHoliday = (holidaysByDate.get(calendarDate) || [])
                .some(holiday => {
                    const locations = Array.isArray(holiday.locations)
                        ? holiday.locations.map(String)
                        : [];
                    return locations.length === 0 || locations.includes(
                        String(employee.work_location_id)
                    );
                });

            if (isWeeklyOff || isHoliday) {
                continue;
            }

            const key = `${row.username}_${calendarDate}`;

            leaveMap.set(key, {
                ...row,
                start_leave_date: rangeStart,
                end_leave_date: rangeEnd,
                calendar_date: calendarDate
            });
        }
    }

    /* ================= DATE LIST ================= */
    const dateResult =
        await pool.query(
            `
            SELECT
                TO_CHAR(
                    gs::date,
                    'YYYY-MM-DD'
                ) AS calendar_date

            FROM generate_series(
                $1::date,
                $2::date,
                INTERVAL '1 day'
            ) gs

            ORDER BY
                gs::date
            `,
            [
                firstDate,
                lastDate
            ]
        );

    const dates =
        dateResult.rows.map(
            row =>
                row.calendar_date
        );

    /* ================= BUILD CALENDAR ================= */
    const calendar = [];

    let totalPresent = 0;
    let totalAbsent = 0;
    let totalLeave = 0;
    let totalHoliday = 0;

    const today =
        new Intl.DateTimeFormat(
            "en-CA",
            {
                timeZone: "Asia/Kolkata",
                year: "numeric",
                month: "2-digit",
                day: "2-digit"
            }
        ).format(new Date());

    /* ================= MONTHLY GROUP OBJECT ================= */
    const yearlyMonths = {};
    const weekdayNames = [
        "SUN",
        "MON",
        "TUE",
        "WED",
        "THU",
        "FRI",
        "SAT"
    ];

    /* =========================================================
       LOOP ALL DATES
    ========================================================= */
    for (
        const date
        of dates
    ) {
        const dayEmployees = [];
        let dayPresent = 0;
        let dayAbsent = 0;
        let dayLeave = 0;
        let dayHoliday = 0;
        const dayHolidays = new Map();
        const dayTransferHolidays = new Map();

        const isFutureDate = date > today;
        const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
        const weekdayName = weekdayNames[weekday];

        /* ================= LOOP EMPLOYEES ================= */
        for (
            const employee
            of employees
        ) {
            /* ================= JOINING DATE CHECK ================= */
            if (
                normalizedView === "yearly" &&
                String(yearly_filter)
                    .trim()
                    .toLowerCase() === "joining_date"
            ) {
                const joiningDate =
                    employee.date_of_joining
                        ? String(employee.date_of_joining).slice(0, 10)
                        : null;

                if (
                    joiningDate &&
                    date < joiningDate
                ) {
                    continue;
                }
            }

            const key = `${employee.username}_${date}`;
            const attendance = attendanceMap.get(key);
            const matchesEmployeeLocation = holiday => {
                const locations = Array.isArray(holiday.locations)
                    ? holiday.locations.map(String)
                    : [];

                return locations.length === 0 || locations.includes(
                    String(employee.work_location_id)
                );
            };
            const holidays = (holidaysByDate.get(date) || [])
                .filter(matchesEmployeeLocation);
            const transferHolidays = (transferHolidaysByDate.get(date) || [])
                .filter(matchesEmployeeLocation);
            const isHoliday = holidays.length > 0;
            const shiftDays = Array.isArray(employee.shift_days)
                ? employee.shift_days.map(day => String(day).trim().toUpperCase())
                : [];
            const isWeeklyOff =
                transferHolidays.length === 0 &&
                (
                    shiftDays.length > 0
                        ? !shiftDays.includes(weekdayName)
                        : weekday === 0
                );
            const leave = isHoliday || isWeeklyOff
                ? null
                : leaveMap.get(key);

            for (const holiday of holidays) {
                dayHolidays.set(holiday.id, holiday);
            }

            for (const holiday of transferHolidays) {
                dayTransferHolidays.set(holiday.id, holiday);
            }

            /* ================= FUTURE DATE ================= */
            if (isFutureDate) {
                if (
                    leave ||
                    isHoliday ||
                    transferHolidays.length > 0 ||
                    isWeeklyOff
                ) {
                    if (leave) {
                        dayLeave++;
                    }

                    if (isHoliday) {
                        dayHoliday++;
                    }

                    dayEmployees.push({
                        firstname: employee.first_name,
                        middlename: employee.middle_name,
                        lastname: employee.last_name,
                        username: employee.username,

                        name: [
                            employee.first_name,
                            employee.middle_name,
                            employee.last_name
                        ]
                            .filter(Boolean)
                            .join(" "),

                        status: leave
                            ? "Leave"
                            : isHoliday
                                ? "Holiday"
                                : isWeeklyOff
                                    ? "Weekly Off"
                                    : "Working Day Override",
                        ...(leave ? { leave: { ...leave } } : {})
                    });
                }

                continue;
            }

            /* ================= PAST / TODAY ================= */
            let status;

            /* ================= PRESENT ON HOLIDAY ================= */
            if (
                isHoliday &&
                attendance?.status === "Present"
            ) {
                status = "Present";
                dayPresent++;
            }

            /* ================= LEAVE ================= */
            else if (leave) {
                status = "Leave";
                dayLeave++;
            }

            /* ================= HOLIDAY ================= */
            else if (isHoliday) {
                status = "Holiday";
            }

            /* ================= PRESENT ================= */
            else if (
                attendance &&
                attendance.status === "Present"
            ) {
                status = "Present";
                dayPresent++;
            }

            /* ================= WEEKLY OFF ================= */
            else if (isWeeklyOff) {
                status = "Weekly Off";
            }

            /* ================= ABSENT ================= */
            else {
                status = "Absent";
                dayAbsent++;
            }

            if (isHoliday) {
                dayHoliday++;
            }

            /* ================= EMPLOYEE DATA ================= */
            const employeeData = {
                username: employee.username,
                firstname: employee.first_name,
                middlename: employee.middle_name,
                lastname: employee.last_name,
                name: [
                    employee.first_name,
                    employee.middle_name,
                    employee.last_name
                ]
                    .filter(Boolean)
                    .join(" "),

                status
            };

            /* ================= LEAVE DETAILS ================= */
            if (
                status === "Leave"
            ) {
                employeeData.leave = {
                    ...leave
                };
            }

            /* ================= ATTENDANCE DETAILS ================= */
            if (
                status === "Present" &&
                attendance
            ) {
                employeeData.attendance_id = attendance.attendance_id;
                employeeData.entry_at = attendance.entry_at;
                employeeData.exit_at = attendance.exit_at;
            }
            if (!isHoliday || status !== "Absent") {
                dayEmployees.push(employeeData);
            }
        }

        /* =====================================================
           TOTALS
        ===================================================== */
        totalPresent += dayPresent;
        totalAbsent += dayAbsent;
        totalLeave += dayLeave;
        totalHoliday += dayHoliday;

        /* ================= GET MONTH NUMBER FROM DATE ================= */
        const dateParts = date.split("-");
        const dateYear = Number(dateParts[0]);
        const dateMonth = Number(dateParts[1]);

        /* ================= MONTH NAME ================= */
        const monthName =
            new Intl.DateTimeFormat(
                "en-US",
                {
                    month: "long"
                }
            ).format(
                new Date(
                    Date.UTC(
                        dateYear,
                        dateMonth - 1,
                        1
                    )
                )
            );


        /* =============== YEARLY VIEW =============== */
        if (
            normalizedView === "yearly"
        ) {
            const monthKey = `${dateYear}-${String(dateMonth).padStart(2, "0")}`;

            /* ========= CREATE MONTH OBJECT ========= */
            if (
                !yearlyMonths[monthKey]
            ) {
                yearlyMonths[monthKey] = {
                    month: monthName,
                    month_no: dateMonth,
                    year: dateYear,
                    day: {}
                };
            }

            /* ================= ADD DATE INSIDE MONTH ================= */
            yearlyMonths[
                monthKey
            ].day[date] = {
                present: dayPresent,
                absent: dayAbsent,
                leave: dayLeave,
                holiday: dayHoliday,
                holidays: [...dayHolidays.values()],
                transfer_holidays: [...dayTransferHolidays.values()],
                employees: dayEmployees
            };

        } else {
            /* =================== MONTHLY VIEW =================== */
            calendar.push({
                date,
                present: dayPresent,
                absent: dayAbsent,
                leave: dayLeave,
                holiday: dayHoliday,
                holidays: [...dayHolidays.values()],
                transfer_holidays: [...dayTransferHolidays.values()],
                employees: dayEmployees
            });
        }
    }

    /* =========================================================
       YEARLY MONTH ARRAY
    ========================================================= */
    const yearlyCalendar =
        Object.values(
            yearlyMonths
        ).sort(
            (a, b) => {
                if (
                    a.year !== b.year
                ) {
                    return (
                        a.year - b.year
                    );
                }

                return (
                    a.month_no - b.month_no
                );
            }
        );

    return {
        view: normalizedView,
        month:
            normalizedView === "monthly"
                ? new Intl.DateTimeFormat(
                    "en-US",
                    {
                        month: "long"
                    }
                ).format(
                    new Date(
                        Date.UTC(
                            numericYear,
                            numericMonth - 1,
                            1
                        )
                    )
                )
                : null,

        month_no:
            normalizedView === "monthly"
                ? numericMonth
                : null,

        year:
            normalizedView === "monthly"
                ? numericYear
                : String(yearly_filter)
                    .toLowerCase() ===
                    "joining_date"
                    ? numericYear
                    : null,

        yearly_filter:
            normalizedView === "yearly"
                ? String(yearly_filter)
                    .toLowerCase()
                : null,

        financial_year:
            normalizedView === "yearly" &&
                String(yearly_filter)
                    .toLowerCase() ===
                "financial_year"
                ? financialYear
                : null,

        date_range: {
            from: firstDate,
            to: lastDate
        },
        total_employees: employees.length,
        summary: {
            present: totalPresent,
            absent: totalAbsent,
            leave: totalLeave,
            holiday: totalHoliday
        },
        data:
            normalizedView === "yearly"
                ? yearlyCalendar
                : calendar
    };
};

export const updateLeaveModel = async (
    id,
    {
        username,
        start_leave_date,
        end_leave_date,
        inform_date,
        medium,
        leave_type,
        leave_start_time,
        leave_end_time,
        description,
        reason,
        status,
        rejected_reason,
        document
    }
) => {
    /* =========================================================
       NORMALIZE DATES
    ========================================================= */
    const normalizedStartDate = normalizeDate(start_leave_date);
    const normalizedEndDate = normalizeDate(end_leave_date);
    const normalizedInformDate = normalizeDate(inform_date);

    if (
        !isValidDate(normalizedStartDate) ||
        !isValidDate(normalizedEndDate) ||
        normalizedStartDate > normalizedEndDate
    ) {
        const error = new Error("A valid leave date range is required");
        error.statusCode = 400;
        throw error;
    }

    /* inform_date optional — create API ni jem; aapyu hoy to j validate */
    if (
        inform_date !== undefined &&
        inform_date !== null &&
        String(inform_date).trim() !== "" &&
        !isValidDate(normalizedInformDate)
    ) {
        const error = new Error("Valid inform_date is required");
        error.statusCode = 400;
        throw error;
    }

    const overlappingLeave = await pool.query(
        `
            SELECT id
            FROM employee_leaves
            WHERE id <> $1
              AND LOWER(TRIM(username)) = LOWER(TRIM($2))
              AND start_leave_date <= $4::date
              AND end_leave_date >= $3::date
            LIMIT 1
        `,
        [
            id,
            username,
            normalizedStartDate,
            normalizedEndDate
        ]
    );

    if (overlappingLeave.rows.length > 0) {
        const error = new Error("Leave already exists in the requested date range");
        error.statusCode = 409;
        error.code = "DUPLICATE_LEAVE";
        throw error;
    }

    const leavePolicy = await calculateLeavePolicy({
        start_leave_date: normalizedStartDate,
        inform_date: normalizedInformDate,
        leave_type
    });

    const { rows } = await pool.query(
        `
        UPDATE employee_leaves
        SET
            username = $1,
            start_leave_date = $2,
            end_leave_date = $3,
            inform_date = $4,
            medium = $5,
            leave_type = $6,
            leave_start_time = $7::time,
            leave_end_time = $8::time,
            description = $9,
            reason = $10,
            status = $11,
            rejected_reason = $12,
            document = $13,
            leave_policy = $14::jsonb,
            updated_at = TIMEZONE(
                'Asia/Kolkata',
                CURRENT_TIMESTAMP
            )
        WHERE id = $15

        RETURNING *;
        `,
        [
            username,
            normalizedStartDate,
            normalizedEndDate,
            normalizedInformDate,
            medium || null,
            leave_type,
            normalizeOptionalTime(leave_start_time),
            normalizeOptionalTime(leave_end_time),
            description,
            reason,
            status,
            rejected_reason || null,
            document || null,
            JSON.stringify(leavePolicy),
            id
        ]
    );

    return rows[0];
};

export const deleteLeaveModel = async (id) => {
    const { rows } = await pool.query(
        `
        DELETE FROM employee_leaves
        WHERE id=$1
        RETURNING *;
        `,
        [id]
    );

    return rows[0];
};