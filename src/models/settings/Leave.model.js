import { pool } from "../../database.js";

/* =========================================================
   CREATE LEAVE TABLE
========================================================= */
export const initializeLeaveTable = async () => {
    const query = `
        CREATE TABLE IF NOT EXISTS leave (
            id SERIAL PRIMARY KEY,
            username VARCHAR(255),
            leave_reason TEXT,
            status BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMP
                DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata'),

            updated_at TIMESTAMP
                DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')
        );
    `;

    try {
        await pool.query(query);
        console.log("✅ Leave table initialized successfully");
    } catch (error) {
        console.error("Error initializing leave table:", error);
        throw error;
    }
};

/* =========================================================
   CREATE LEAVE
========================================================= */
export const createLeaveModel = async ({
    username,
    leave_reason,
    status = true
}) => {

    const query = `
        INSERT INTO leave (
            username,
            leave_reason,
            status
        )
        VALUES ($1, $2, $3)
        RETURNING *;
    `;

    const values = [
        username,
        leave_reason || null,
        status
    ];

    const { rows } = await pool.query(
        query,
        values
    );

    return rows[0];
};

/* =========================================================
   GET ALL LEAVES
========================================================= */
export const getAllLeaveModel = async () => {
    const query = `
        SELECT
            id,
            username,
            leave_reason,
            status,
            created_at,
            updated_at
        FROM leave
        ORDER BY created_at DESC
    `;

    const { rows } = await pool.query(query);

    return rows;
};


/* =========================================================
   GET LEAVE BY ID
========================================================= */
export const getLeaveIdModel = async (id) => {
    const query = `
        SELECT
            el.id,
            el.username,

            TO_CHAR(el.start_leave_date, 'YYYY-MM-DD') AS start_leave_date,
            TO_CHAR(el.end_leave_date, 'YYYY-MM-DD') AS end_leave_date,
            TO_CHAR(el.inform_date, 'YYYY-MM-DD') AS inform_date,

            el.medium,
            el.leave_type,

            TO_CHAR(el.leave_start_time, 'HH24:MI') AS leave_start_time,
            TO_CHAR(el.leave_end_time, 'HH24:MI') AS leave_end_time,

            el.description,
            el.reason,

            /* Rejected Reason */
            el.rejected_reason,

            /* Leave Document */
            el.document,

            CASE
                WHEN el.inform_date IS NOT NULL
                     AND el.start_leave_date IS NOT NULL
                 THEN el.start_leave_date::date - el.inform_date::date
                ELSE NULL
            END AS days_before_leave,

            el.status,
            el.leave_policy,
            el.created_at,
            el.updated_at,

            /* Employee Details */
            pd.first_name,
            pd.middle_name,
            pd.last_name,

            /* Category */
            ed.category AS category_id,
            c.category_name AS category,

            /* Work Location */
            ed.work_location AS work_location_id,
            wl.location AS work_location,

            /* Shift */
            ed.shift_id,
            sc.shift_name,
            sc.shift_type,

            /* Employee Status */
            me.status AS employee_status

        FROM employee_leaves el

        LEFT JOIN personal_details pd
            ON LOWER(TRIM(pd.username)) = LOWER(TRIM(el.username))

        LEFT JOIN employment_details ed
            ON ed.personal_details_id = pd.id

        LEFT JOIN master_employee me
            ON me.personal_details_id = pd.id

        LEFT JOIN category c
            ON c.id = ed.category

        LEFT JOIN work_location wl
            ON wl.id = ed.work_location

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

        WHERE el.id = $1

        LIMIT 1
    `;

    const { rows } = await pool.query(query, [id]);

    return rows[0] || null;
};

/* =========================================================
   GET LEAVE BY ID
========================================================= */
export const getLeaveByIdModel = async (id) => {

    const query = `
        SELECT
            id,
            username,
            leave_reason,
            status,
            created_at,
            updated_at
        FROM leave
        WHERE id = $1
    `;

    const { rows } = await pool.query(
        query,
        [id]
    );

    return rows[0] || null;
};

/* =====================================================
   CHECK DUPLICATE LEAVE
===================================================== */
export const checkDuplicateLeaveModel = async (
    leave_reason,
    currentLeaveId = null
) => {

    const reason = String(
        leave_reason || ""
    ).trim();

    /* ================= VALIDATION ================= */

    if (!reason) {
        return false;
    }

    /* ================= DUPLICATE CHECK ================= */

    const { rows } = await pool.query(
        `
        SELECT id
        FROM leave
        WHERE LOWER(TRIM(leave_reason))
            = LOWER(TRIM($1))

        AND (
            $2::INTEGER IS NULL
            OR id <> $2
        )

        LIMIT 1
        `,
        [
            reason,
            currentLeaveId
        ]
    );

    return rows.length > 0;
};

/* =========================================================
   GET LEAVE REASON USAGE
========================================================= */
export const getLeaveReasonUsageModel = async ({
    view = "monthly",
    month = null,
    year = null,
    yearly_filter = null,
    financial_year = null,
    leave_reason = [],
    work_location = [],
    department = [],
    name = null
} = {}) => {
    /* =====================================================
       NORMALIZE VIEW
    ===================================================== */
    const normalizedView =
        String(view)
            .trim()
            .toLowerCase();

    if (
        ![
            "monthly",
            "yearly"
        ].includes(normalizedView)
    ) {
        throw new Error(
            "view must be monthly or yearly"
        );
    }

    let firstDate = null;
    let lastDate = null;
    let numericMonth = null;
    let numericYear = null;
    let financialYear = null;

    /* =====================================================
       MONTHLY
    ===================================================== */
    if (
        normalizedView === "monthly"
    ) {
        numericMonth = Number(month);
        numericYear = Number(year);

        if (
            !Number.isInteger(numericMonth) ||
            numericMonth < 1 ||
            numericMonth > 12
        ) {
            throw new Error(
                "Invalid month"
            );
        }

        if (
            !Number.isInteger(numericYear) ||
            numericYear < 2000
        ) {
            throw new Error(
                "Invalid year"
            );
        }

        firstDate =
            `${numericYear}-${String(
                numericMonth
            ).padStart(2, "0")}-01`;

        const lastDateResult =
            await pool.query(
                `
                SELECT
                    TO_CHAR(
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

    /* =====================================================
       YEARLY
    ===================================================== */
    else {
        const filter =
            String(yearly_filter || "")
                .trim()
                .toLowerCase();

        /* =================================================
           CALENDAR / JOINING YEAR
        ================================================= */
        if (
            filter === "joining_date"
        ) {
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

        /* =================================================
           FINANCIAL YEAR
        ================================================= */
        else if (
            filter === "financial_year"
        ) {
            financialYear =
                String(financial_year || "")
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

            const startYear = Number(financialYearMatch[1]);
            const endPart = financialYearMatch[2];

            let endYear;

            if (
                endPart.length === 2
            ) {
                endYear = Number(`${String(startYear).slice(0, 2)}${endPart}`);
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

    /* =====================================================
       NORMALIZE LEAVE REASON FILTER
    ===================================================== */
    let leaveReasonFilter = [];

    if (Array.isArray(leave_reason)) {
        leaveReasonFilter =
            leave_reason
                .flatMap(item =>
                    String(item)
                        .split(",")
                        .map(value =>
                            value.trim()
                        )
                )
                .filter(Boolean)
                .filter(
                    value =>
                        value.toLowerCase() !== "all"
                );
    }

    leaveReasonFilter = [
        ...new Set(
            leaveReasonFilter.map(
                value =>
                    value.toLowerCase()
            )
        )
    ];

    /* =====================================================
       NORMALIZE WORK LOCATION FILTER
    ===================================================== */
    let workLocationFilter = [];

    if (Array.isArray(work_location)) {
        workLocationFilter =
            work_location
                .flatMap(item =>
                    String(item)
                        .split(",")
                        .map(value =>
                            value.trim()
                        )
                )
                .filter(Boolean)
                .filter(
                    value =>
                        value.toLowerCase() !== "all" &&
                        value.toLowerCase() !== "nan"
                );
    }

    workLocationFilter = [
        ...new Set(workLocationFilter)
    ];

    /* =====================================================
       RESOLVE WORK LOCATION IDs
    ===================================================== */
    const workLocationIds = [];
    const workLocationNames = [];

    for (
        const value of workLocationFilter
    ) {
        const numericValue = Number(value);

        if (
            Number.isInteger(numericValue) &&
            numericValue > 0
        ) {
            workLocationIds.push(
                numericValue
            );

        } else {
            workLocationNames.push(
                value.toLowerCase()
            );
        }
    }

    /* =====================================================
       FIND LOCATION IDs FROM LOCATION NAMES
    ===================================================== */
    if (
        workLocationNames.length > 0
    ) {
        const locationResult =
            await pool.query(
                `
                SELECT id
                FROM work_location
                WHERE LOWER(TRIM(location))
                    = ANY($1::text[])
                `,
                [
                    workLocationNames
                ]
            );


        workLocationIds.push(
            ...locationResult.rows.map(
                row => Number(row.id)
            )
        );
    }

    /* =====================================================
       UNIQUE WORK LOCATION IDs
    ===================================================== */
    const uniqueWorkLocationIds = [
        ...new Set(
            workLocationIds.filter(
                id =>
                    Number.isInteger(id) &&
                    id > 0
            )
        )
    ];

    const departmentValues = Array.isArray(department)
        ? department
            .flatMap(item => String(item).split(","))
            .map(value => value.trim())
            .filter(value => value && value.toLowerCase() !== "all")
        : String(department || "")
            .split(",")
            .map(value => value.trim())
            .filter(value => value && value.toLowerCase() !== "all");

    const departmentIds = [];
    const departmentNames = [];

    for (const value of departmentValues) {
        const departmentId = Number(value);

        if (Number.isInteger(departmentId) && departmentId > 0) {
            departmentIds.push(departmentId);
        } else {
            departmentNames.push(value.toLowerCase());
        }
    }

    if (departmentNames.length > 0) {
        const departmentResult = await pool.query(
            `
                SELECT id
                FROM department_structure
                WHERE LOWER(TRIM(name::TEXT)) = ANY($1::text[])
            `,
            [departmentNames]
        );

        departmentIds.push(
            ...departmentResult.rows.map(row => Number(row.id))
        );
    }

    const uniqueDepartmentIds = [...new Set(departmentIds)];

    const nameFilter = Array.isArray(name)
        ? name.flatMap(item => String(item).split(","))
        : String(name || "").split(",");
    const uniqueNames = [...new Set(
        nameFilter
            .map(value => value.trim())
            .filter(Boolean)
    )];

    /* =====================================================
       BUILD CONDITIONS
    ===================================================== */
    const conditions = [];

    conditions.push(
        `LOWER(TRIM(me.status::TEXT)) = 'active'`
    );

    /* =====================================================
       DATE FILTER
    ===================================================== */
    conditions.push(
        `
            el.start_leave_date <= $2::date
            AND el.end_leave_date >= $1::date
        `
    );

    const queryParams = [
        firstDate,
        lastDate
    ];

    /* =====================================================
       LEAVE REASON FILTER
    ===================================================== */
    if (
        leaveReasonFilter.length > 0
    ) {
        queryParams.push(
            leaveReasonFilter
        );

        conditions.push(
            `
                LOWER(TRIM(l.leave_reason))
                    = ANY($${queryParams.length}::text[])
            `
        );
    }

    /* =====================================================
       WORK LOCATION
    ===================================================== */
    if (
        uniqueWorkLocationIds.length > 0
    ) {
        queryParams.push(
            uniqueWorkLocationIds
        );

        conditions.push(
            `
                ed.work_location =
                    ANY($${queryParams.length}::integer[])
            `
        );
    }

    if (uniqueDepartmentIds.length > 0) {
        queryParams.push(uniqueDepartmentIds);
        conditions.push(
            `ed.department = ANY($${queryParams.length}::integer[])`
        );
    }

    if (uniqueNames.length > 0) {
        const nameConditions = uniqueNames.map((nameValue) => {
            queryParams.push(`%${nameValue}%`);
            const nameParam = `$${queryParams.length}::text`;

            return `(
                LOWER(TRIM(COALESCE(pd.first_name, ''))) LIKE LOWER(${nameParam})
                OR LOWER(TRIM(COALESCE(pd.middle_name, ''))) LIKE LOWER(${nameParam})
                OR LOWER(TRIM(COALESCE(pd.last_name, ''))) LIKE LOWER(${nameParam})
                OR LOWER(TRIM(COALESCE(el.username, ''))) LIKE LOWER(${nameParam})
                OR LOWER(TRIM(CONCAT_WS(
                    ' ', pd.first_name, pd.middle_name, pd.last_name
                ))) LIKE LOWER(${nameParam})
            )`;
        });

        conditions.push(`(${nameConditions.join(" OR ")})`);
    }

    /* =====================================================
       FINAL QUERY
    ===================================================== */
    const query = `
        SELECT
            l.id AS leave_id,
            l.leave_reason,
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
            el.leave_start_time,
            el.leave_end_time,
            el.reason,
            el.description,
            el.rejected_reason,
            el.document,
            el.status,
            el.leave_policy,
            el.created_by,
            el.created_at,
            el.updated_at,

            /* ================================
               EMPLOYEE DETAILS
            ================================= */
                pd.first_name,
                pd.middle_name,
                pd.last_name,
                pd.image,

            ed.work_location AS work_location_id,

            ed.department AS department_id,

            ds.name AS department,

            wl.location AS work_location

        FROM employee_leaves el

        LEFT JOIN leave l
            ON LOWER(
                TRIM(el.reason)
            )
            =
            LOWER(
                TRIM(l.leave_reason)
            )

        /* =================================================
           FIND EMPLOYEE
        ================================================= */
        LEFT JOIN personal_details pd
            ON LOWER(
                TRIM(pd.username)
            )
            =
            LOWER(
                TRIM(el.username)
            )

        LEFT JOIN employment_details ed
            ON ed.personal_details_id =
                pd.id

        LEFT JOIN department_structure ds
            ON ds.id = ed.department

        INNER JOIN master_employee me
            ON me.personal_details_id = pd.id

        LEFT JOIN work_location wl
            ON wl.id =
                ed.work_location

        WHERE
            ${conditions.join("\nAND ")}

        ORDER BY
            l.id ASC,
            el.start_leave_date ASC,
            el.id ASC
    `;

    /* =====================================================
       EXECUTE
    ===================================================== */
    const {
        rows
    } = await pool.query(
        query,
        queryParams
    );

     /* =====================================================
         GROUP LEAVES BY EMPLOYEE, THEN REASON
     ===================================================== */
    const groupedData = {};

    for (const row of rows) {
        const usernameKey =
            String(row.username)
                .trim()
                .toLowerCase();

        if (!groupedData[usernameKey]) {
            groupedData[usernameKey] = {
                username: row.username,
                first_name: row.first_name,
                middle_name: row.middle_name,
                last_name: row.last_name,
                image: row.image,
                name: [
                    row.first_name,
                    row.middle_name,
                    row.last_name
                ]
                    .filter(Boolean)
                    .join(" "),
                work_location_id: row.work_location_id,
                work_location: row.work_location,
                leave_reasons: {}
            };
        }

        const employee = groupedData[usernameKey];
        const reasonName = String(row.leave_reason || row.reason || "").trim();
        const reasonKey = `${row.leave_id ?? "other"}_${reasonName.toLowerCase()}`;

        if (!employee.leave_reasons[reasonKey]) {
            employee.leave_reasons[reasonKey] = {
                leave_id: row.leave_id,
                leave_reason: reasonName,
                count: 0,
                leaves: []
            };
        }

        employee.leave_reasons[reasonKey].leaves.push({
            leave_id: row.leave_id,
            leave_reason: row.leave_reason,
            id: row.id,
            username: row.username,
            start_leave_date: row.start_leave_date,
            end_leave_date: row.end_leave_date,
            inform_date: row.inform_date,
            inform_medium: row.medium,
            leave_type: row.leave_type,
            leave_start_time: row.leave_start_time,
            leave_end_time: row.leave_end_time,
            reason: row.reason,
            description: row.description,
            rejected_reason: row.rejected_reason,
            document: row.document,
            status: row.status,
            leave_policy: row.leave_policy,
            created_by: row.created_by,
            created_at: row.created_at,
            updated_at: row.updated_at,
            work_location_id: row.work_location_id,
            work_location: row.work_location,
            department_id: row.department_id,
            department: row.department
        });

        employee.leave_reasons[reasonKey].count++;
    }

    /* =====================================================
       RETURN RESPONSE
    ===================================================== */
    const employeeData = Object.values(groupedData).map(employee => ({
        ...employee,
        leave_reasons: Object.values(employee.leave_reasons)
    }));

    return {
        view: normalizedView,

        month:
            normalizedView === "monthly"
                ? numericMonth
                : null,

        year:
            normalizedView === "monthly" ||
                (
                    normalizedView === "yearly" &&
                    String(yearly_filter)
                        .trim()
                        .toLowerCase() ===
                    "joining_date"
                )
                ? numericYear
                : null,

        yearly_filter:
            normalizedView === "yearly"
                ? String(yearly_filter)
                    .trim()
                    .toLowerCase()
                : null,

        financial_year:
            normalizedView === "yearly" &&
                String(yearly_filter)
                    .trim()
                    .toLowerCase() ===
                "financial_year"
                ? financialYear
                : null,

        filters: {
            leave_reason: leaveReasonFilter,
            work_location: uniqueWorkLocationIds,
            department: uniqueDepartmentIds,
            name: uniqueNames
        },

        date_range: {
            from: firstDate,
            to: lastDate
        },

        total_count: rows.length,
        data: employeeData
    };
};

/* =========================================================
   UPDATE LEAVE
========================================================= */
export const updateLeaveModel = async ({
    id,
    leave_reason,
    status
}) => {
    const query = `
        UPDATE leave
        SET
            leave_reason = COALESCE($1, leave_reason),
            status = COALESCE($2, status),
            updated_at = CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata'
        WHERE id = $3
        RETURNING
            id,
            username,
            leave_reason,
            status,
            created_at,
            updated_at
    `;

    const values = [
        leave_reason ?? null,
        status ?? null,
        id
    ];

    const { rows } = await pool.query(
        query,
        values
    );

    return rows[0] || null;
};

/* =========================================================
   TOGGLE LEAVE STATUS
========================================================= */
export const toggleLeaveStatusModel = async (id) => {
    const query = `
        UPDATE leave
        SET
            status = NOT status,
            updated_at = CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata'
        WHERE id = $1
        RETURNING
            id,
            username,
            leave_reason,
            status,
            created_at,
            updated_at
    `;

    const { rows } = await pool.query(
        query,
        [id]
    );

    return rows[0] || null;
};
