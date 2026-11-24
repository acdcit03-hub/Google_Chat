import { pool } from "../../../database.js";

const buildDepartmentFilter = (department, count) => {
    if (
        department === null ||
        department === undefined ||
        String(department).trim() === "" ||
        String(department).trim().toLowerCase() === "all"
    ) {
        return null;
    }

    const departmentValue = String(department).trim();
    const departmentId = Number(departmentValue);

    if (
        Number.isInteger(departmentId) &&
        departmentId > 0 &&
        String(departmentId) === departmentValue
    ) {
        return {
            sql: ` AND ed.department = $${count}`,
            value: departmentId
        };
    }

    return {
        sql: `
            AND EXISTS (
                SELECT 1
                FROM department_structure ds_filter
                WHERE ds_filter.id = ed.department
                  AND LOWER(TRIM(ds_filter.name)) = LOWER(TRIM($${count}))
            )
        `,
        value: departmentValue
    };
};

/* =========================================================
   GET EMPLOYEE ATTENDANCE RECORD
========================================================= */
export const getEmployeeAttendanceRecordModel = async ({
    startDate,
    endDate,
    name = null,
    username = null,
    department = null,
    category = null,
    shift_type = null,
    work_location = null,
    status = null,
    page = 1,
    limit = 20
}) => {

    const values = [startDate, endDate];
    const countValues = [startDate, endDate];

    page = Number(page) || 1;
    limit = Number(limit) || 20;

    const offset = (page - 1) * limit;

    let count = 3;
    let employeeFilters = "";

    /* =========================================================
       COUNT QUERY
    ========================================================= */

    let countQuery = `
        SELECT COUNT(DISTINCT pd.id) AS total

        FROM employment_details ed

        INNER JOIN personal_details pd
            ON pd.id = ed.personal_details_id

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

        LEFT JOIN master_employee me
            ON me.personal_details_id = pd.id

        /* ================= LATEST INACTIVE ================= */

        LEFT JOIN LATERAL (
            SELECT
                ie.past_status,
                ie.inactive_date,
                ie.created_at
            FROM inactive_employee ie
            WHERE ie.personal_details_id = pd.id
            ORDER BY ie.created_at DESC
            LIMIT 1
        ) ie ON TRUE

        /* ================= CATEGORY ================= */

        LEFT JOIN category c
            ON c.id = ed.category

        /* ================= WORK LOCATION ================= */

        LEFT JOIN work_location wl
            ON wl.id = ed.work_location

        /* ================= SHIFT ================= */

        LEFT JOIN shift_configurations sc
            ON sc.id = ed.shift_id

        /* ================= ATTENDANCE ================= */

        LEFT JOIN (
            SELECT DISTINCT ON (
                username,
                entry_at::date
            )
                username,
                status

            FROM attendance_sessions

            WHERE entry_at::date
                BETWEEN $1::date AND $2::date

            ORDER BY
                username,
                entry_at::date,
                entry_at DESC,
                id DESC

        ) ats
            ON ats.username = pd.username

        WHERE ed.show_in_attendance = TRUE

        AND (
            LOWER(TRIM(me.status::TEXT)) = 'active'

            OR (
                LOWER(TRIM(me.status::TEXT)) = 'inactive'

                AND LOWER(TRIM(ie.past_status::TEXT)) = 'active'

                AND (
                    ie.inactive_date IS NULL
                    OR $1::date <= ie.inactive_date::date
                )
            )
        )

        AND ed.date_of_joining <= $2::date
    `;

    /* =========================================================
       NAME FILTER
    ========================================================= */

    if (name) {

        const condition = `
            AND (
                pd.first_name ILIKE $${count}
                OR pd.middle_name ILIKE $${count}
                OR pd.last_name ILIKE $${count}
                OR pd.username ILIKE $${count}
                OR CONCAT_WS(
                    ' ',
                    pd.first_name,
                    pd.middle_name,
                    pd.last_name,
                    pd.username
                ) ILIKE $${count}
            )
        `;

        employeeFilters += condition;
        countQuery += condition;

        values.push(`%${name}%`);
        countValues.push(`%${name}%`);

        count++;
    }

    /* =========================================================
       USERNAME FILTER
    ========================================================= */

    if (username) {

        const condition = `
            AND pd.username ILIKE $${count}
        `;

        employeeFilters += condition;
        countQuery += condition;

        values.push(`%${username}%`);
        countValues.push(`%${username}%`);

        count++;
    }

    /* =========================================================
       DEPARTMENT FILTER
    ========================================================= */

    const departmentFilter = buildDepartmentFilter(department, count);

    if (departmentFilter) {
        employeeFilters += departmentFilter.sql;
        countQuery += departmentFilter.sql;
        values.push(departmentFilter.value);
        countValues.push(departmentFilter.value);
        count++;
    }

    /* =========================================================
      CATEGORY FILTER

      Supports:
      ?category=1
      ?category=2
      ?category=Employee
      ?category=Intern
      ?category=All
    ======================================================== */

    if (
        category !== null &&
        category !== undefined &&
        String(category).trim() !== ""
    ) {

        const categoryValue = String(category).trim();

        /* ================= IGNORE ALL ================= */

        if (
            categoryValue.toLowerCase() !== "all" &&
            categoryValue.toLowerCase() !== "nan"
        ) {

            const categoryId = Number(categoryValue);

            /* ================= CATEGORY ID ================= */

            if (
                Number.isInteger(categoryId) &&
                categoryId > 0
            ) {

                const condition = `
                    AND c.id = $${count}
                `;

                employeeFilters += condition;
                countQuery += condition;

                values.push(categoryId);
                countValues.push(categoryId);

                count++;

            } else {

                /* ================= CATEGORY NAME ================= */

                const condition = `
                    AND LOWER(TRIM(c.category_name))
                        = LOWER(TRIM($${count}))
                `;

                employeeFilters += condition;
                countQuery += condition;

                values.push(categoryValue);
                countValues.push(categoryValue);

                count++;
            }
        }
    }

    /* =========================================================
       SHIFT TYPE FILTER
    ========================================================= */

    if (
        shift_type !== null &&
        shift_type !== undefined &&
        String(shift_type).trim() !== "" &&
        String(shift_type).trim().toLowerCase() !== "nan"
    ) {

        const shiftTypeId = Number(shift_type);

        if (
            Number.isInteger(shiftTypeId) &&
            shiftTypeId > 0
        ) {

            const condition = `
                AND sc.id = $${count}
            `;

            employeeFilters += condition;
            countQuery += condition;

            values.push(shiftTypeId);
            countValues.push(shiftTypeId);

            count++;
        }
    }

    /* =========================================================
       WORK LOCATION FILTER
    ========================================================= */

    if (
        work_location !== null &&
        work_location !== undefined &&
        String(work_location).trim() !== "" &&
        String(work_location).trim().toLowerCase() !== "nan"
    ) {

        const locationValue = String(work_location).trim();
        const locationId = Number(locationValue);

        if (
            Number.isInteger(locationId) &&
            locationId > 0
        ) {

            const condition = `
                AND wl.id = $${count}
            `;

            employeeFilters += condition;
            countQuery += condition;

            values.push(locationId);
            countValues.push(locationId);

            count++;

        } else {

            const condition = `
                AND LOWER(TRIM(wl.location))
                    = LOWER(TRIM($${count}))
            `;

            employeeFilters += condition;
            countQuery += condition;

            values.push(locationValue);
            countValues.push(locationValue);

            count++;
        }
    }

    /* =========================================================
       STATUS FILTER
    ========================================================= */

    let attendanceStatusCondition = "";

    if (
        status !== null &&
        status !== undefined &&
        String(status).trim() !== ""
    ) {

        const statusFilterParamIndex = count;

        /*
         * IMPORTANT:
         * Frontend status should match FINAL status.
         *
         * Example:
         * Leave
         * Present
         * Half Day
         * Absent
         * NM
         */

        attendanceStatusCondition = `
            WHERE
                CASE

                    WHEN lv.id IS NOT NULL
                        THEN 'Leave'

                    WHEN ats.status IN (
                        'completed',
                        'inside'
                    )
                        THEN 'Present'

                    WHEN ats.status = 'half_day'
                        THEN 'Half Day'

                    WHEN ats.id IS NULL
                         AND $2::date > CURRENT_DATE
                        THEN 'NM'

                    ELSE 'Absent'

                END = $${statusFilterParamIndex}
        `;

        /*
         * COUNT QUERY
         *
         * Need employee leave information here also.
         */

        countQuery += `
            AND (
                CASE

                    WHEN EXISTS (
                        SELECT 1
                        FROM employee_leaves el
                        WHERE LOWER(TRIM(el.username))
                            = LOWER(TRIM(pd.username))
                        AND el.start_leave_date::date <= $2::date
                        AND el.end_leave_date::date >= $1::date
                        AND EXISTS (
                            SELECT 1
                            FROM generate_series(
                                GREATEST(el.start_leave_date::date, $1::date),
                                LEAST(el.end_leave_date::date, $2::date),
                                INTERVAL '1 day'
                            ) AS leave_dates(leave_date)
                            WHERE (
                                (
                                    COALESCE(cardinality(sc.days), 0) > 0
                                    AND EXISTS (
                                        SELECT 1
                                        FROM unnest(sc.days) AS shift_days(shift_day)
                                        WHERE UPPER(TRIM(shift_day)) = CASE
                                            EXTRACT(DOW FROM leave_date)::INT
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
                                    AND EXTRACT(DOW FROM leave_date)::INT <> 0
                                )
                                OR EXISTS (
                                    SELECT 1
                                    FROM holidays h
                                    WHERE h.transfer_date = leave_date::date
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
                                WHERE h.holiday_date = leave_date::date
                                  AND (
                                        h.locations IS NULL
                                        OR cardinality(h.locations) = 0
                                        OR ed.work_location::TEXT = ANY(h.locations)
                                  )
                            )
                        )
                    )
                        THEN 'Leave'

                    WHEN ats.status IN (
                        'completed',
                        'inside'
                    )
                        THEN 'Present'

                    WHEN ats.status = 'half_day'
                        THEN 'Half Day'

                    WHEN ats.username IS NULL
                         AND $2::date > CURRENT_DATE
                        THEN 'NM'

                    ELSE 'Absent'

                END
            ) = $${statusFilterParamIndex}
        `;

        values.push(status);
        countValues.push(status);

        count++;
    }

    /* =========================================================
       PAGINATION
    ========================================================= */

    const limitPlaceholder = `$${count}`;
    const offsetPlaceholder = `$${count + 1}`;

    values.push(limit);
    values.push(offset);

    /* =========================================================
       MAIN QUERY
    ========================================================= */

    const query = `
        WITH attendance_data AS (

            SELECT
                username,
                entry_at::date AS attendance_date,
        
                /*
                 * ===============================
                 * TOTAL DURATION OF ALL SESSIONS
                 * ===============================
                 */
                SUM(
                    COALESCE(duration, INTERVAL '0')
                ) AS duration,
        
                /*
                 * ===============================
                 * LATEST SESSION DETAILS
                 * ===============================
                 */
                (ARRAY_AGG(
                    id
                    ORDER BY entry_at DESC, id DESC
                ))[1] AS id,
        
                (ARRAY_AGG(
                    entry_at
                    ORDER BY entry_at DESC, id DESC
                ))[1] AS entry_at,
        
                (ARRAY_AGG(
                    exit_at
                    ORDER BY entry_at DESC, id DESC
                ))[1] AS exit_at,
        
                (ARRAY_AGG(
                    status
                    ORDER BY entry_at DESC, id DESC
                ))[1] AS status
        
            FROM attendance_sessions
        
            WHERE entry_at::date
                BETWEEN $1::date AND $2::date
        
            GROUP BY
                username,
                entry_at::date
        ),

        filtered_employees AS (

            SELECT

                /* ================= PERSONAL ================= */

                pd.username,
                pd.first_name,
                pd.middle_name,
                pd.last_name,
                COALESCE(
                    NULLIF(BTRIM(pd.image), ''),
                    (
                        SELECT c_image.category_image
                        FROM category c_image
                        WHERE LOWER(TRIM(c_image.category_name)) =
                              LOWER(TRIM(c.category_name))
                          AND c_image.work_location = ed.work_location
                          AND NULLIF(BTRIM(c_image.category_image), '') IS NOT NULL
                        ORDER BY c_image.id DESC
                        LIMIT 1
                    )
                ) AS image,

                /* ================= EMPLOYMENT ================= */

                ed.employment_id,
                ed.rfid,
                ed.department,

                /* ================= CATEGORY ================= */

                ed.category AS category_id,
                c.category_name AS category,

                /* ================= SHIFT ================= */

                ed.shift_id AS shift_type_id,
                sc.shift_type AS shift_type,
                sc.days AS shift_days,
                sc.start_time AS shift_start_time,
                sc.end_time AS shift_end_time,
                sc.late_arrival_count_time,
                sc.early_leave_count_time,

                /* ================= WORK LOCATION ================= */

                ed.work_location AS work_location_id,
                wl.location AS work_location,

                /* ================= DATES ================= */

                ed.date_of_joining,
                ie.inactive_date

            FROM employment_details ed

            INNER JOIN personal_details pd
                ON pd.id = ed.personal_details_id

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

            LEFT JOIN master_employee me
                ON me.personal_details_id = pd.id

            /* ================= LATEST INACTIVE ================= */

            LEFT JOIN LATERAL (
                SELECT
                    ie.past_status,
                    ie.inactive_date,
                    ie.created_at

                FROM inactive_employee ie

                WHERE ie.personal_details_id = pd.id

                ORDER BY ie.created_at DESC

                LIMIT 1
            ) ie ON TRUE

            /* ================= CATEGORY ================= */

            LEFT JOIN category c
                ON c.id = ed.category

            /* ================= WORK LOCATION ================= */

            LEFT JOIN work_location wl
                ON wl.id = ed.work_location

            /* ================= SHIFT ================= */

            LEFT JOIN shift_configurations sc
                ON sc.id = ed.shift_id

            WHERE ed.show_in_attendance = TRUE

            AND (
                LOWER(TRIM(me.status::TEXT)) = 'active'

                OR (
                    LOWER(TRIM(me.status::TEXT)) = 'inactive'

                    AND LOWER(TRIM(ie.past_status::TEXT)) = 'active'

                    AND (
                        ie.inactive_date IS NULL
                        OR $1::date <= ie.inactive_date::date
                    )
                )
            )

            AND ed.date_of_joining <= $2::date

            ${employeeFilters}

            ORDER BY ed.employment_id ASC

            LIMIT ${limitPlaceholder}
            OFFSET ${offsetPlaceholder}
        )

        SELECT

            /* ================= PERSONAL ================= */

            fe.username,
            fe.first_name,
            fe.middle_name,
            fe.last_name,
            fe.image,

            /* ================= EMPLOYMENT ================= */

            fe.employment_id,
            fe.rfid,
            fe.department,

            /* ================= CATEGORY ================= */

            fe.category_id,
            fe.category,

            /* ================= SHIFT ================= */

            fe.shift_type_id,
            fe.shift_type,
            fe.shift_days,
            fe.shift_start_time,
            fe.shift_end_time,
            fe.late_arrival_count_time,
            fe.early_leave_count_time,

            /* ================= WORK LOCATION ================= */

            fe.work_location_id,
            fe.work_location,

            /* ================= DATES ================= */

            fe.date_of_joining,
            fe.inactive_date,

            /* ================= ATTENDANCE ================= */

            ats.id AS attendance_id,
            ats.entry_at,
            ats.exit_at,
            ats.duration AS duration,
            ats.status,

            /* ================= ATTENDANCE TIME STATUS ================= */

            CASE

                /* =====================================================
                   BOTH LATE ARRIVAL + EARLY EXIT
                   ===================================================== */

                WHEN
                    ats.entry_at IS NOT NULL
                    AND ats.exit_at IS NOT NULL
                    AND fe.shift_start_time IS NOT NULL
                    AND fe.shift_end_time IS NOT NULL

                    /* -------- LATE ARRIVAL -------- */
                    AND (
                        (
                            ats.entry_at AT TIME ZONE 'Asia/Kolkata'
                        )::time
                        >
                        (
                            fe.shift_start_time
                            + (
                                COALESCE(
                                    fe.late_arrival_count_time,
                                    0
                                ) * INTERVAL '1 minute'
                            )
                        )::time
                    )

                    /* -------- EARLY EXIT -------- */
                    AND (
                        (
                            ats.exit_at AT TIME ZONE 'Asia/Kolkata'
                        )::time
                        <
                        (
                            fe.shift_end_time
                            - (
                                COALESCE(
                                    fe.early_leave_count_time,
                                    0
                                ) * INTERVAL '1 minute'
                            )
                        )::time
                    )

                THEN 'LA_EE'


                /* =====================================================
                   LATE ARRIVAL ONLY
                   ===================================================== */

                WHEN
                    ats.entry_at IS NOT NULL
                    AND fe.shift_start_time IS NOT NULL

                    AND (
                        (
                            ats.entry_at AT TIME ZONE 'Asia/Kolkata'
                        )::time
                        >
                        (
                            fe.shift_start_time
                            + (
                                COALESCE(
                                    fe.late_arrival_count_time,
                                    0
                                ) * INTERVAL '1 minute'
                            )
                        )::time
                    )

                THEN 'LA'


                /* =====================================================
                   EARLY EXIT ONLY
                   ===================================================== */

                WHEN
                    ats.exit_at IS NOT NULL
                    AND fe.shift_end_time IS NOT NULL

                    AND (
                        (
                            ats.exit_at AT TIME ZONE 'Asia/Kolkata'
                        )::time
                        <
                        (
                            fe.shift_end_time
                            - (
                                COALESCE(
                                    fe.early_leave_count_time,
                                    0
                                ) * INTERVAL '1 minute'
                            )
                        )::time
                    )

                THEN 'EE'


                /* =====================================================
                   ATTENDANCE EXISTS BUT NO LATE / EARLY
                   ===================================================== */

                WHEN
                    ats.entry_at IS NOT NULL
                    OR ats.exit_at IS NOT NULL

                THEN 'On Time'


                /* =====================================================
                   NO ATTENDANCE
                   ===================================================== */

                ELSE NULL

            END AS attendance_time_status,

            /* ================= LEAVE ================= */

            lv.id AS leave_id,
            lv.leave_type,
            lv.leave_start_time,
            lv.leave_end_time,
            lv.description AS leave_description,
            lv.reason AS leave_reason,

            /* ================= FINAL ATTENDANCE STATUS ================= */

            CASE

                /* LEAVE HAS PRIORITY */

                WHEN lv.id IS NOT NULL
                    THEN 'Leave'

                WHEN ats.status IN (
                    'completed',
                    'inside'
                )
                    THEN 'Present'

                WHEN ats.status = 'half_day'
                    THEN 'Half Day'

                WHEN ats.id IS NULL
                     AND $2::date > CURRENT_DATE
                    THEN 'NM'

                WHEN ats.id IS NULL
                     AND $2::date <= CURRENT_DATE
                    THEN 'Absent'

                ELSE 'Absent'

            END AS attendance_status

        FROM filtered_employees fe

        /* ================= ATTENDANCE ================= */
        LEFT JOIN attendance_data ats
            ON LOWER(TRIM(ats.username))
             = LOWER(TRIM(fe.username))

        /* ================= LEAVE ================= */
        LEFT JOIN LATERAL (

            SELECT
                el.id,
                el.leave_type,
                el.start_leave_date,
                el.end_leave_date,
                el.leave_start_time,
                el.leave_end_time,
                el.description,
                el.reason

            FROM employee_leaves el

            WHERE LOWER(TRIM(el.username))
                = LOWER(TRIM(fe.username))

            AND el.start_leave_date::date <= $2::date
            AND el.end_leave_date::date >= $1::date

            AND (
                (
                    ats.entry_at IS NOT NULL
                    AND ats.entry_at::date BETWEEN
                        el.start_leave_date::date
                        AND el.end_leave_date::date
                    AND (
                        (
                            COALESCE(cardinality(fe.shift_days), 0) > 0
                            AND EXISTS (
                                SELECT 1
                                FROM unnest(fe.shift_days) AS shift_days(shift_day)
                                WHERE UPPER(TRIM(shift_day)) = CASE
                                    EXTRACT(DOW FROM ats.entry_at::date)::INT
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
                            COALESCE(cardinality(fe.shift_days), 0) = 0
                            AND EXTRACT(DOW FROM ats.entry_at::date)::INT <> 0
                        )
                        OR EXISTS (
                            SELECT 1
                            FROM holidays h
                            WHERE h.transfer_date = ats.entry_at::date
                              AND (
                                    h.locations IS NULL
                                    OR cardinality(h.locations) = 0
                                    OR fe.work_location_id::TEXT = ANY(h.locations)
                              )
                        )
                    )
                    AND NOT EXISTS (
                        SELECT 1
                        FROM holidays h
                        WHERE h.holiday_date = ats.entry_at::date
                          AND (
                                h.locations IS NULL
                                OR cardinality(h.locations) = 0
                                OR fe.work_location_id::TEXT = ANY(h.locations)
                          )
                    )
                )
                OR (
                    ats.entry_at IS NULL
                    AND EXISTS (
                        SELECT 1
                        FROM generate_series(
                            GREATEST(el.start_leave_date::date, $1::date),
                            LEAST(el.end_leave_date::date, $2::date),
                            INTERVAL '1 day'
                        ) AS leave_dates(leave_date)
                        WHERE (
                            (
                                COALESCE(cardinality(fe.shift_days), 0) > 0
                                AND EXISTS (
                                    SELECT 1
                                    FROM unnest(fe.shift_days) AS shift_days(shift_day)
                                    WHERE UPPER(TRIM(shift_day)) = CASE
                                        EXTRACT(DOW FROM leave_date)::INT
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
                                COALESCE(cardinality(fe.shift_days), 0) = 0
                                AND EXTRACT(DOW FROM leave_date)::INT <> 0
                            )
                            OR EXISTS (
                                SELECT 1
                                FROM holidays h
                                WHERE h.transfer_date = leave_date::date
                                  AND (
                                        h.locations IS NULL
                                        OR cardinality(h.locations) = 0
                                        OR fe.work_location_id::TEXT = ANY(h.locations)
                                  )
                            )
                        )
                        AND NOT EXISTS (
                            SELECT 1
                            FROM holidays h
                            WHERE h.holiday_date = leave_date::date
                              AND (
                                    h.locations IS NULL
                                    OR cardinality(h.locations) = 0
                                    OR fe.work_location_id::TEXT = ANY(h.locations)
                              )
                        )
                    )
                )
            )

            ORDER BY el.start_leave_date ASC, el.id DESC

            LIMIT 1

        ) lv ON TRUE

        ${attendanceStatusCondition}

        ORDER BY
            fe.employment_id ASC,
            COALESCE(
                ats.entry_at::date,
                (
                    SELECT MIN(GREATEST(el2.start_leave_date::date, $1::date))
                    FROM employee_leaves el2
                    WHERE LOWER(TRIM(el2.username))
                        = LOWER(TRIM(fe.username))
                    AND el2.start_leave_date::date <= $2::date
                    AND el2.end_leave_date::date >= $1::date
                )
            ) ASC NULLS LAST
    `;

    /* =========================================================
       EXECUTE
    ========================================================= */

    const [
        { rows },
        { rows: totalRows }
    ] = await Promise.all([
        pool.query(query, values),
        pool.query(countQuery, countValues)
    ]);

    const total =
        Number(totalRows[0]?.total || 0);

    return {
        rows,

        pagination: {
            enabled: true,
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit)
        }
    };
};

/* ================= GET YEARLY ATTENDANCE SUMMARY ================= */
export const getYearlyAttendanceSummaryModel = async ({
    year,
    month = null,
    name = null,
    username = null,
    department = null,
    category = null,
    shift_type = null,
    work_location = null,
    date_mode = "joining"
}) => {

    const selectedYear = Number(year);

    if (!Number.isInteger(selectedYear)) {
        throw new Error("Invalid year");
    }

    const values = [
        selectedYear,
        date_mode
    ];

    let count = 3;

    let query = `
        WITH months AS (

            SELECT
                generate_series(0, 11)::INT AS month_index

        ),

        /* =========================================================
           MONTH DATA

           JOINING:
           Jan -> Dec

           FINANCIAL YEAR:
           Apr -> Mar
        ========================================================= */

        month_data AS (

            SELECT

                month_index,

                CASE
                    WHEN $2 = 'financial_year'
                        THEN EXTRACT(
                            MONTH FROM (
                                MAKE_DATE(
                                    $1::INT,
                                    4,
                                    1
                                )
                                +
                                (
                                    month_index *
                                    INTERVAL '1 month'
                                )
                            )
                        )::INT

                    ELSE month_index + 1
                END AS month_no,

                CASE
                    WHEN $2 = 'financial_year'
                        THEN EXTRACT(
                            YEAR FROM (
                                MAKE_DATE(
                                    $1::INT,
                                    4,
                                    1
                                )
                                +
                                (
                                    month_index *
                                    INTERVAL '1 month'
                                )
                            )
                        )::INT

                    ELSE $1::INT
                END AS calendar_year

            FROM months
        ),

        /* =========================================================
           ATTENDANCE SUMMARY
        ========================================================= */

        attendance_summary AS (

            SELECT

                ats.username,

                EXTRACT(
                    MONTH FROM ats.entry_at
                )::INT AS month_no,

                EXTRACT(
                    YEAR FROM ats.entry_at
                )::INT AS calendar_year,

                COUNT(
                    DISTINCT ats.entry_at::DATE
                )
                FILTER (
                    WHERE ats.status IN (
                        'completed',
                        'inside'
                    )
                ) AS present,

                COUNT(
                    DISTINCT ats.entry_at::DATE
                )
                FILTER (
                    WHERE ats.status = 'half_day'
                ) AS half_day,

                COALESCE(
                    SUM(
                        EXTRACT(
                            EPOCH FROM ats.duration
                        )
                    ),
                    0
                ) AS total_seconds

            FROM attendance_sessions ats

            WHERE

                (
                    $2 = 'joining'

                    AND EXTRACT(
                        YEAR FROM ats.entry_at
                    )::INT = $1
                )

                OR

                (
                    $2 = 'financial_year'

                    AND ats.entry_at >= MAKE_DATE(
                        $1::INT,
                        4,
                        1
                    )

                    AND ats.entry_at < MAKE_DATE(
                        $1::INT + 1,
                        4,
                        1
                    )
                )

            GROUP BY
                ats.username,
                EXTRACT(
                    YEAR FROM ats.entry_at
                )::INT,
                EXTRACT(
                    MONTH FROM ats.entry_at
                )::INT
        ),

        /* =========================================================
           ATTENDANCE DAYS
        ========================================================= */

        attendance_days AS (

            SELECT

                ats.username,

                ats.entry_at::DATE AS attendance_date,

                EXTRACT(
                    YEAR FROM ats.entry_at
                )::INT AS calendar_year,

                EXTRACT(
                    MONTH FROM ats.entry_at
                )::INT AS month_no,

                CASE

                    WHEN ats.status IN (
                        'completed',
                        'inside'
                    )
                        THEN 'present'

                    WHEN ats.status = 'half_day'
                        THEN 'half_day'

                    ELSE 'absent'

                END AS attendance_status,

                ats.entry_at,
                ats.exit_at,

                EXTRACT(
                    EPOCH FROM ats.duration
                )::INT AS duration_seconds

            FROM attendance_sessions ats

            INNER JOIN personal_details pd
                ON LOWER(
                    TRIM(pd.username)
                )
                =
                LOWER(
                    TRIM(ats.username)
                )

            WHERE

                (
                    $2 = 'joining'

                    AND EXTRACT(
                        YEAR FROM ats.entry_at
                    )::INT = $1
                )

                OR

                (
                    $2 = 'financial_year'

                    AND ats.entry_at >= MAKE_DATE(
                        $1::INT,
                        4,
                        1
                    )

                    AND ats.entry_at < MAKE_DATE(
                        $1::INT + 1,
                        4,
                        1
                    )
                )
        ),

        /* =========================================================
           HOLIDAY SUMMARY

           IMPORTANT:
           ed2.work_location = integer

           holidays.locations = text[]

           Therefore compare:
           ed2.work_location::TEXT
           with
           h.locations::TEXT[]
        ========================================================= */

        holiday_summary AS (

            SELECT

                ed2.personal_details_id,

                EXTRACT(
                    YEAR FROM h.holiday_date
                )::INT AS calendar_year,

                EXTRACT(
                    MONTH FROM h.holiday_date
                )::INT AS month_no,

                COUNT(
                    DISTINCT h.holiday_date::DATE
                ) AS company_holiday

            FROM employment_details ed2

            INNER JOIN holidays h

                ON (

                    h.locations IS NULL

                    OR array_length(
                        h.locations,
                        1
                    ) IS NULL

                    OR ed2.work_location::TEXT =
                        ANY(
                            h.locations::TEXT[]
                        )
                )

            WHERE

                (
                    $2 = 'joining'

                    AND EXTRACT(
                        YEAR FROM h.holiday_date
                    )::INT = $1
                )

                OR

                (
                    $2 = 'financial_year'

                    AND h.holiday_date >= MAKE_DATE(
                        $1::INT,
                        4,
                        1
                    )

                    AND h.holiday_date < MAKE_DATE(
                        $1::INT + 1,
                        4,
                        1
                    )
                )

            GROUP BY

                ed2.personal_details_id,

                EXTRACT(
                    YEAR FROM h.holiday_date
                )::INT,

                EXTRACT(
                    MONTH FROM h.holiday_date
                )::INT
        )

        /* =========================================================
           MAIN SELECT
        ========================================================= */

        SELECT

            /* ================= PERSONAL ================= */

            pd.username,

            pd.first_name,

            pd.middle_name,

            pd.last_name,

            COALESCE(
                NULLIF(BTRIM(pd.image), ''),
                (
                    SELECT c_image.category_image
                    FROM category c_image
                    WHERE LOWER(TRIM(c_image.category_name)) =
                          LOWER(TRIM(c.category_name))
                      AND c_image.work_location = ed.work_location
                      AND NULLIF(BTRIM(c_image.category_image), '') IS NOT NULL
                    ORDER BY c_image.id DESC
                    LIMIT 1
                )
            ) AS image,

            CONCAT_WS(
                ' ',
                pd.first_name,
                pd.middle_name,
                pd.last_name
            ) AS employee_name,

            /* ================= EMPLOYMENT ================= */

            ed.employment_id,

            /* ================= DEPARTMENT ================= */

            ed.department,

            /* ================= CATEGORY ================= */

            ed.category AS category_id,

            c.category_name AS category,

            /* ================= WORK LOCATION ================= */

            ed.work_location AS work_location_id,

            wl.location AS work_location,

            /* ================= SHIFT ================= */

            ed.shift_id AS shift_type_id,

            sc.shift_type AS shift_type,
            sc.days AS shift_days,

            sc.start_time,

            sc.end_time,

            /* ================= DATES ================= */

            ed.date_of_joining,

            ie.inactive_date,

            /* ================= MONTH ================= */

            m.month_no,

            m.calendar_year,

            TO_CHAR(
                MAKE_DATE(
                    m.calendar_year,
                    m.month_no,
                    1
                ),
                'Month'
            ) AS month,

            /* ================= ATTENDANCE ================= */

            COALESCE(
                a.present,
                0
            ) AS present,

            COALESCE(
                a.half_day,
                0
            ) AS half_day,

            /* ================= HOLIDAY ================= */

            COALESCE(
                h.company_holiday,
                0
            ) AS company_holiday,

            /* ================= DURATION ================= */

            COALESCE(
                a.total_seconds,
                0
            ) AS total_seconds,

            /* ================= DAILY ATTENDANCE ================= */

            ad.attendance_date,

            ad.attendance_status,

            ad.entry_at,

            ad.exit_at,

            ad.duration_seconds,

            /* ================= ABSENT ================= */

            GREATEST(

                EXTRACT(
                    DAY FROM (
                        DATE_TRUNC(
                            'month',
                            MAKE_DATE(
                                m.calendar_year,
                                m.month_no,
                                1
                            )
                        )
                        +
                        INTERVAL '1 month'
                        -
                        INTERVAL '1 day'
                    )
                )::INT

                -

                COALESCE(
                    a.present,
                    0
                )

                -

                COALESCE(
                    a.half_day,
                    0
                )

                -

                COALESCE(
                    h.company_holiday,
                    0
                ),

                0

            ) AS absent

        FROM employment_details ed

        /* =========================================================
           PERSONAL
        ========================================================= */

        INNER JOIN personal_details pd

            ON pd.id =
                ed.personal_details_id

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

        /* =========================================================
           CATEGORY
        ========================================================= */

        LEFT JOIN category c

            ON c.id =
                ed.category

        /* =========================================================
           WORK LOCATION
        ========================================================= */

        LEFT JOIN work_location wl

            ON wl.id =
                ed.work_location

        /* =========================================================
           MASTER EMPLOYEE
        ========================================================= */

        LEFT JOIN master_employee me

            ON me.personal_details_id =
                pd.id

        /* =========================================================
           LATEST INACTIVE
        ========================================================= */

        LEFT JOIN LATERAL (

            SELECT

                ie.past_status,

                ie.inactive_date,

                ie.created_at

            FROM inactive_employee ie

            WHERE
                ie.personal_details_id =
                    pd.id

            ORDER BY
                ie.created_at DESC

            LIMIT 1

        ) ie ON TRUE

        /* =========================================================
           MONTHS
        ========================================================= */

        CROSS JOIN month_data m

        /* =========================================================
           ATTENDANCE SUMMARY
        ========================================================= */

        LEFT JOIN attendance_summary a

            ON a.username =
                pd.username

            AND a.month_no =
                m.month_no

            AND a.calendar_year =
                m.calendar_year

        /* =========================================================
           ATTENDANCE DAYS
        ========================================================= */

        LEFT JOIN attendance_days ad

            ON ad.username =
                pd.username

            AND ad.month_no =
                m.month_no

            AND ad.calendar_year =
                m.calendar_year

            AND (
                $2 = 'financial_year'

                OR ad.attendance_date >=
                    ed.date_of_joining
            )

            AND (
                ie.inactive_date IS NULL

                OR ad.attendance_date <=
                    ie.inactive_date::DATE
            )

        /* =========================================================
           HOLIDAY SUMMARY

           IMPORTANT:
           Match holiday summary with employee.
        ========================================================= */

        LEFT JOIN holiday_summary h

            ON h.personal_details_id =
                pd.id

            AND h.month_no =
                m.month_no

            AND h.calendar_year =
                m.calendar_year

        /* =========================================================
           SHIFT
        ========================================================= */
        LEFT JOIN shift_configurations sc

            ON sc.id =
                ed.shift_id

        /* =========================================================
           ATTENDANCE VISIBILITY
        ========================================================= */
        WHERE ed.show_in_attendance = TRUE

        /* =========================================================
           ACTIVE / INACTIVE
        ========================================================= */
        AND (

            LOWER(
                TRIM(me.status::TEXT)
            ) = 'active'

            OR (

                LOWER(
                    TRIM(me.status::TEXT)
                ) = 'inactive'

                AND LOWER(
                    TRIM(ie.past_status::TEXT)
                ) = 'active'

                AND (

                    ie.inactive_date IS NULL

                    OR EXTRACT(
                        YEAR FROM ie.inactive_date
                    ) > $1

                    OR (

                        EXTRACT(
                            YEAR FROM ie.inactive_date
                        ) = $1

                        AND m.month_no <= EXTRACT(
                            MONTH FROM ie.inactive_date
                        )
                    )
                )
            )
        )

        /* =========================================================
           DATE MODE
        ========================================================= */

        AND (

            /* ================= JOINING ================= */

            (
                $2 = 'joining'

                AND ed.date_of_joining <= (

                    DATE_TRUNC(
                        'month',
                        MAKE_DATE(
                            m.calendar_year,
                            m.month_no,
                            1
                        )
                    )

                    +
                    INTERVAL '1 month'

                    -
                    INTERVAL '1 day'

                )::DATE
            )

            OR

            /* ================= FINANCIAL YEAR ================= */

            (
                $2 = 'financial_year'

                AND ed.date_of_joining <=
                    MAKE_DATE(
                        $1::INT + 1,
                        3,
                        31
                    )
            )
        )
    `;

    /* =========================================================
       NAME FILTER
    ========================================================= */

    if (name) {

        query += `
            AND (
                pd.first_name ILIKE $${count}

                OR pd.middle_name ILIKE $${count}

                OR pd.last_name ILIKE $${count}

                OR pd.username ILIKE $${count}

                OR CONCAT_WS(
                    ' ',
                    pd.first_name,
                    pd.middle_name,
                    pd.last_name,
                    pd.username
                ) ILIKE $${count}
            )
        `;

        values.push(`%${name}%`);

        count++;
    }

    /* =========================================================
       USERNAME FILTER
    ========================================================= */

    if (username) {

        query += `
            AND pd.username ILIKE $${count}
        `;

        values.push(`%${username}%`);

        count++;
    }

    /* =========================================================
       DEPARTMENT FILTER
    ========================================================= */

    const departmentFilter = buildDepartmentFilter(department, count);

    if (departmentFilter) {
        query += departmentFilter.sql;
        values.push(departmentFilter.value);
        count++;
    }

    /* =========================================================
       CATEGORY FILTER
    ========================================================= */

    if (
        category !== null &&
        category !== undefined &&
        String(category).trim() !== ""
    ) {

        const categoryValue =
            String(category).trim();

        if (
            categoryValue.toLowerCase() !== "all" &&
            categoryValue.toLowerCase() !== "null" &&
            categoryValue.toLowerCase() !== "undefined" &&
            categoryValue.toLowerCase() !== "nan"
        ) {

            const categoryId =
                Number(categoryValue);

            if (
                Number.isInteger(categoryId) &&
                categoryId > 0
            ) {

                query += `
                    AND c.id = $${count}
                `;

                values.push(categoryId);

                count++;

            } else {

                query += `
                    AND LOWER(
                        TRIM(c.category_name)
                    )
                    =
                    LOWER(
                        TRIM($${count})
                    )
                `;

                values.push(categoryValue);

                count++;
            }
        }
    }

    /* =========================================================
       SHIFT TYPE FILTER
    ========================================================= */

    if (
        shift_type !== null &&
        shift_type !== undefined &&
        String(shift_type).trim() !== "" &&
        String(shift_type).trim().toLowerCase() !== "nan"
    ) {

        const shiftTypeId =
            Number(shift_type);

        if (
            Number.isInteger(shiftTypeId) &&
            shiftTypeId > 0
        ) {

            query += `
                AND sc.id = $${count}
            `;

            values.push(shiftTypeId);

            count++;
        }
    }

    /* =========================================================
       WORK LOCATION FILTER
    ========================================================= */

    if (
        work_location !== null &&
        work_location !== undefined &&
        String(work_location).trim() !== "" &&
        String(work_location).trim().toLowerCase() !== "nan"
    ) {

        const locationValue =
            String(work_location).trim();

        const locationId =
            Number(locationValue);

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
                AND LOWER(
                    TRIM(wl.location)
                )
                =
                LOWER(
                    TRIM($${count})
                )
            `;

            values.push(locationValue);

            count++;
        }
    }

    /* =========================================================
       MONTH FILTER
    ========================================================= */

    if (
        month !== null &&
        month !== undefined &&
        String(month).trim() !== ""
    ) {

        const monthValue =
            Number(month);

        if (
            Number.isInteger(monthValue) &&
            monthValue >= 1 &&
            monthValue <= 12
        ) {

            query += `
                AND m.month_no = $${count}
            `;

            values.push(monthValue);

            count++;
        }
    }

    /* =========================================================
       ORDER
    ========================================================= */

    query += `
        ORDER BY
            ed.employment_id,
            m.calendar_year,
            m.month_no,
            ad.attendance_date
    `;

    const {
        rows
    } = await pool.query(
        query,
        values
    );

    return rows;
};