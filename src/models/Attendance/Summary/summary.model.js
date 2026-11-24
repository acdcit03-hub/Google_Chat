import { pool } from "../../../database.js";

/* ================= GET ATTENDANCE SUMMARY ================= */
export const getAttendanceSummaryModel = async ({
    month,
    year,
    username = null,
    name = null,
    employee_id = null,
    department = null,
    category = null,
    work_location = null,
    page = 1,
    limit = 20
}) => {

    page = Number(page) || 1;
    limit = Number(limit) || 20;

    const offset = (page - 1) * limit;

    const monthValue = Number(month);
    const yearValue = Number(year);

    const values = [
        monthValue,
        yearValue
    ];

    let count = 3;

    /* =========================================================
       COUNT QUERY
    ========================================================= */
    let countQuery = `
        SELECT COUNT(DISTINCT pd.id) AS total

        FROM personal_details pd

        INNER JOIN employment_details ed
            ON ed.personal_details_id = pd.id

        /* ================= CATEGORY ================= */
        LEFT JOIN category c
            ON c.id = ed.category

        /* ================= WORK LOCATION ================= */
        LEFT JOIN work_location wl
            ON wl.id = ed.work_location

        /* ================= DEPARTMENT ================= */
        LEFT JOIN department_structure ds
            ON ds.id = ed.department

        /* ================= BOND ================= */
        LEFT JOIN bond_options bo
            ON bo.id = ed.bond

        /* ================= MASTER EMPLOYEE ================= */
        LEFT JOIN master_employee me
            ON me.personal_details_id = pd.id

        /* ================= INACTIVE ================= */
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

        WHERE ed.show_in_attendance = TRUE

        /* ================= STATUS ================= */
        AND (
            LOWER(TRIM(me.status::TEXT)) = 'active'

            OR (
                LOWER(TRIM(me.status::TEXT)) = 'inactive'

                AND LOWER(TRIM(ie.past_status::TEXT)) = 'active'

                AND (
                    ie.inactive_date IS NULL

                    OR MAKE_DATE($2, $1, 1)
                        <= ie.inactive_date::DATE
                )
            )
        )

        /* ================= JOINING DATE ================= */
        AND ed.date_of_joining <= (
            DATE_TRUNC(
                'month',
                MAKE_DATE($2, $1, 1)
            )
            + INTERVAL '1 month'
            - INTERVAL '1 day'
        )::DATE
    `;

    const countValues = [
        monthValue,
        yearValue
    ];

    let countIndex = 3;

    /* =========================================================
       MAIN QUERY
    ========================================================= */
    let query = `
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
            ds.name AS department,

            /* ================= WORK LOCATION ID -> NAME ================= */
            wl.id AS work_location_id,
            wl.location AS work_location,

            /* ================= CATEGORY ID -> NAME ================= */
            c.category_name AS category,

            /* ================= BOND ID -> NAME ================= */
            bo.bond_duration AS bond,

            /* ================= JOINING ================= */
            ed.date_of_joining AS joining_date,

            /* ================= INACTIVE ================= */
            ie.past_status,
            ie.inactive_date,

            /* =================================================
               SHIFT ID -> SHIFT CONFIGURATION
               employment_details.shift_id = shift_configurations.id
            ================================================= */

            sc.shift_name,
            sc.shift_type,
            sc.start_time,
            sc.end_time,

            /* ================= SHIFT DAYS ================= */
            sc.days,

            COALESCE(
                sc.early_leave_count_time,
                0
            )::INT AS early_leave_count_time,

            COALESCE(
                sc.late_arrival_count_time,
                0
            )::INT AS late_arrival_count_time,

            /* ================= PRESENT ================= */
            COALESCE(
                ats.present,
                0
            )::INT AS present,

            /* ================= HALF DAY ================= */
            COALESCE(
                ats.half_day,
                0
            )::INT AS half_day,

            /* ================= LEAVES ================= */
            COALESCE(
                el.full_leave,
                0
            )::INT AS full_leave,

            COALESCE(
                el.half_leave,
                0
            )::INT AS half_leave,

            /* ================= TOTAL MINUTES ================= */
            COALESCE(
                ats.total_minutes,
                0
            )::NUMERIC AS total_minutes,

            /* ================= ATTENDANCE DATES ================= */
            COALESCE(
                ats.attendance_dates,
                ARRAY[]::DATE[]
            ) AS attendance_dates

        FROM personal_details pd

        /* ================= EMPLOYMENT ================= */
        INNER JOIN employment_details ed
            ON ed.personal_details_id = pd.id

        /* ================= CATEGORY ================= */
        LEFT JOIN category c
            ON c.id = ed.category

        /* ================= WORK LOCATION ================= */
        LEFT JOIN work_location wl
            ON wl.id = ed.work_location

        /* ================= DEPARTMENT ================= */
        LEFT JOIN department_structure ds
            ON ds.id = ed.department

        /* ================= BOND ================= */
        LEFT JOIN bond_options bo
            ON bo.id = ed.bond

        /* ================= MASTER EMPLOYEE ================= */
        LEFT JOIN master_employee me
            ON me.personal_details_id = pd.id

        /* ================= INACTIVE ================= */
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

        /* =================================================
           SHIFT CONFIGURATION

           employment_details.shift_id = shift_configurations.id
        ================================================= */

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

        /* ================= ATTENDANCE ================= */
        LEFT JOIN (
        
            SELECT
                username,
        
                /* ================= PRESENT ================= */
                COUNT(DISTINCT entry_at::DATE)
                    FILTER (
                        WHERE status IN (
                            'completed',
                            'inside'
                        )
                    )::INT AS present,
        
                /* ================= HALF DAY ================= */
                COUNT(DISTINCT entry_at::DATE)
                    FILTER (
                        WHERE status = 'half_day'
                    )::INT AS half_day,
        
                /* ================= TOTAL MINUTES ================= */
                COALESCE(
                    SUM(
                        EXTRACT(EPOCH FROM duration)
                    ) / 60.0,
                    0
                )::NUMERIC AS total_minutes,
        
                /* ================= ATTENDANCE DATES ================= */
                ARRAY_REMOVE(
                    ARRAY_AGG(
                        DISTINCT entry_at::DATE
                    ),
                    NULL
                ) AS attendance_dates
        
            FROM attendance_sessions
        
            WHERE EXTRACT(
                    MONTH FROM entry_at
                )::INT = $1
        
            AND EXTRACT(
                    YEAR FROM entry_at
                )::INT = $2
        
            GROUP BY username
        
        ) ats
        
            ON ats.username = pd.username

        /* ================= LEAVES ================= */
        LEFT JOIN LATERAL (
            SELECT
                COUNT(*) FILTER (
                    WHERE LOWER(TRIM(el.leave_type::TEXT)) = 'full day'
                )::INT AS full_leave,
                COUNT(*) FILTER (
                    WHERE LOWER(TRIM(el.leave_type::TEXT)) IN (
                        'morning half leave',
                        'evening half leave'
                    )
                )::INT AS half_leave
            FROM employee_leaves el
            CROSS JOIN LATERAL generate_series(
                GREATEST(
                    el.start_leave_date::date,
                    MAKE_DATE($2::int, $1::int, 1)
                ),
                LEAST(
                    el.end_leave_date::date,
                    (MAKE_DATE($2::int, $1::int, 1)
                        + INTERVAL '1 month' - INTERVAL '1 day')::date
                ),
                INTERVAL '1 day'
            ) AS leave_dates(leave_day)
            WHERE LOWER(TRIM(el.username)) = LOWER(TRIM(pd.username))
              AND el.start_leave_date::date <=
                    (MAKE_DATE($2::int, $1::int, 1)
                        + INTERVAL '1 month' - INTERVAL '1 day')::date
              AND el.end_leave_date::date >= MAKE_DATE($2::int, $1::int, 1)
              AND (
                    (
                        COALESCE(cardinality(sc.days), 0) > 0
                        AND EXISTS (
                            SELECT 1
                            FROM unnest(sc.days) AS shift_days(shift_day)
                            WHERE UPPER(TRIM(shift_day)) = CASE
                                EXTRACT(DOW FROM leave_day)::INT
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
                        AND EXTRACT(DOW FROM leave_day)::INT <> 0
                    )
                    OR EXISTS (
                        SELECT 1
                        FROM holidays h
                        WHERE h.transfer_date = leave_day::date
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
                    WHERE h.holiday_date = leave_day::date
                      AND (
                            h.locations IS NULL
                            OR cardinality(h.locations) = 0
                            OR ed.work_location::TEXT = ANY(h.locations)
                      )
              )
        ) el ON TRUE

        /* ================= ATTENDANCE VISIBILITY ================= */
        WHERE ed.show_in_attendance = TRUE

        /* ================= STATUS FILTER ================= */
        AND (
            LOWER(TRIM(me.status::TEXT)) = 'active'

            OR (
                LOWER(TRIM(me.status::TEXT)) = 'inactive'

                AND LOWER(TRIM(ie.past_status::TEXT)) = 'active'

                AND (
                    ie.inactive_date IS NULL

                    OR MAKE_DATE($2, $1, 1)
                        <= ie.inactive_date::DATE
                )
            )
        )

        /* ================= JOINING DATE FILTER ================= */
        AND ed.date_of_joining <= (
            DATE_TRUNC(
                'month',
                MAKE_DATE($2, $1, 1)
            )
            + INTERVAL '1 month'
            - INTERVAL '1 day'
        )::DATE
    `;

    /* =========================================================
       USERNAME FILTER
    ========================================================= */
    if (username) {

        query += `
            AND pd.username ILIKE $${count}
        `;

        values.push(`%${username}%`);
        count++;

        countQuery += `
            AND pd.username ILIKE $${countIndex}
        `;

        countValues.push(`%${username}%`);
        countIndex++;
    }

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

        countQuery += `
            AND (
                pd.first_name ILIKE $${countIndex}
                OR pd.middle_name ILIKE $${countIndex}
                OR pd.last_name ILIKE $${countIndex}
                OR pd.username ILIKE $${countIndex}

                OR CONCAT_WS(
                    ' ',
                    pd.first_name,
                    pd.middle_name,
                    pd.last_name,
                    pd.username
                ) ILIKE $${countIndex}
            )
        `;

        countValues.push(`%${name}%`);
        countIndex++;
    }

    /* =========================================================
       EMPLOYEE ID FILTER
    ========================================================= */
    if (employee_id) {

        query += `
            AND ed.employment_id ILIKE $${count}
        `;

        values.push(`%${employee_id}%`);
        count++;

        countQuery += `
            AND ed.employment_id ILIKE $${countIndex}
        `;

        countValues.push(`%${employee_id}%`);
        countIndex++;
    }

    /* =========================================================
       DEPARTMENT FILTER
    ========================================================= */
    if (department) {

        query += `
            AND ds.name ILIKE $${count}
        `;

        values.push(`%${department}%`);
        count++;

        countQuery += `
            AND ds.name ILIKE $${countIndex}
        `;

        countValues.push(`%${department}%`);
        countIndex++;
    }

    /* =========================================================
       CATEGORY FILTER
    ========================================================= */
    if (category) {

        query += `
            AND c.category_name ILIKE $${count}
        `;

        values.push(`%${category}%`);
        count++;

        countQuery += `
            AND c.category_name ILIKE $${countIndex}
        `;

        countValues.push(`%${category}%`);
        countIndex++;
    }

    /* =========================================================
       WORK LOCATION FILTER
    ========================================================= */
    const workLocationFilters = Array.isArray(work_location)

        ? work_location
            .map(loc => String(loc).trim())
            .filter(Boolean)

        : String(work_location || "")
            .split(",")
            .map(loc => loc.trim())
            .filter(Boolean);

    const isAllLocation =
        workLocationFilters.some(
            loc => loc.toLowerCase() === "all"
        );

    if (
        !isAllLocation &&
        workLocationFilters.length > 0
    ) {

        query += `
            AND (
                ${workLocationFilters
                .map(
                    (_, index) =>
                        `
                            LOWER(TRIM(wl.location::TEXT))
                            LIKE LOWER(TRIM($${count + index}))
                            `
                )
                .join(" OR ")}
            )
        `;

        values.push(
            ...workLocationFilters.map(
                loc => `%${loc}%`
            )
        );

        count += workLocationFilters.length;

        countQuery += `
            AND (
                ${workLocationFilters
                .map(
                    (_, index) =>
                        `
                            LOWER(TRIM(wl.location::TEXT))
                            LIKE LOWER(TRIM($${countIndex + index}))
                            `
                )
                .join(" OR ")}
            )
        `;

        countValues.push(
            ...workLocationFilters.map(
                loc => `%${loc}%`
            )
        );

        countIndex += workLocationFilters.length;
    }

    /* =========================================================
       PAGINATION
    ========================================================= */
    query += `
        ORDER BY ed.employment_id ASC
        LIMIT $${count}
        OFFSET $${count + 1}
    `;

    values.push(limit);
    values.push(offset);

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

    const total = Number(totalRows[0]?.total || 0);

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

/* ================= EXPORT SUMMARY ================= */
export const getExportSummary = async ({
    month = null,
    year = null,
    date = null,
    username = null,
    work_location = null
}) => {

    const values = [
        date || null,
        month ? Number(month) : null,
        year ? Number(year) : null
    ];

    let count = 4;

    let query = `
        SELECT
            pd.username AS employee_username,
            pd.first_name,
            pd.middle_name,
            pd.last_name,

            /* ================= SHIFT ================= */
            sc.start_time AS shift_start_time,
            sc.end_time AS shift_end_time,
            sc.shift_name,
            sc.shift_type,

            /* ================= WORK LOCATION ================= */
            ed.work_location AS work_location_id,
            wl.location AS work_location,

            /* ================= WORKING TIME ================= */
            epc.working_start_time,
            epc.working_end_time,

            /* ================= HOLIDAYS ================= */
COALESCE(
    (
        SELECT ARRAY_AGG(
            TO_CHAR(
                h.holiday_date,
                'DD-MM-YYYY'
            )
        )
        FROM holidays h
        WHERE
            h.holiday_date IS NOT NULL

            /* Holiday must belong to employee location */
            AND (
                h.locations IS NULL
                OR array_length(h.locations, 1) IS NULL
                OR ed.work_location::TEXT = ANY(h.locations)
            )

            /* Selected month */
            AND h.holiday_date >= MAKE_DATE(
                $3::int,
                $2::int,
                1
            )

            AND h.holiday_date < (
                MAKE_DATE(
                    $3::int,
                    $2::int,
                    1
                )
                + INTERVAL '1 month'
            )::date
    ),
    ARRAY[]::TEXT[]
) AS holiday_dates,

            /* ================= ATTENDANCE ================= */
            CASE
                WHEN ats.entry_at IS NOT NULL THEN
                    TO_CHAR(
                        ats.entry_at AT TIME ZONE 'Asia/Kolkata',
                        'DD-MM-YYYY HH24:MI:SS'
                    )
                ELSE NULL
            END AS entry_at,

            CASE
                WHEN ats.exit_at IS NOT NULL THEN
                    TO_CHAR(
                        ats.exit_at AT TIME ZONE 'Asia/Kolkata',
                        'DD-MM-YYYY HH24:MI:SS'
                    )
                ELSE NULL
            END AS exit_at,

            ats.duration

        FROM personal_details pd

        INNER JOIN employment_details ed
            ON ed.personal_details_id = pd.id

        /* ================= CATEGORY ================= */
        LEFT JOIN category c
            ON c.id = ed.category

        /* ================= WORK LOCATION ================= */
        LEFT JOIN work_location wl
            ON wl.id = ed.work_location

        /* ================= EMPLOYEE ================= */
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

        /* ================= SHIFT ================= */
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

        /* ================= ATTENDANCE ================= */
        LEFT JOIN attendance_sessions ats
            ON ats.username = pd.username

            AND (
                /* ================= DATE EXPORT ================= */
                (
                    $1::date IS NOT NULL
                    AND (
                        ats.entry_at AT TIME ZONE 'Asia/Kolkata'
                    )::date = $1::date
                )

                OR

                /* ================= MONTH EXPORT ================= */
                (
                    $1::date IS NULL

                    AND ats.entry_at >= (
                        MAKE_DATE(
                            $3::int,
                            $2::int,
                            1
                        )::timestamp
                        AT TIME ZONE 'Asia/Kolkata'
                    )

                    AND ats.entry_at < (
                        (
                            MAKE_DATE(
                                $3::int,
                                $2::int,
                                1
                            )
                            + INTERVAL '1 month'
                        )::timestamp
                        AT TIME ZONE 'Asia/Kolkata'
                    )
                )
            )

        WHERE ed.show_in_attendance = TRUE

        /* ================= EMPLOYEE STATUS ================= */
        AND (
            /* ================= ACTIVE ================= */
            LOWER(
                TRIM(
                    me.status::TEXT
                )
            ) = 'active'

            OR

            /* ================= INACTIVE ================= */
            (
                LOWER(
                    TRIM(
                        me.status::TEXT
                    )
                ) = 'inactive'

                AND LOWER(
                    TRIM(
                        COALESCE(
                            ie.past_status::TEXT,
                            ''
                        )
                    )
                ) = 'active'

                AND ie.inactive_date IS NOT NULL

                AND (
                    /* ================= DATE EXPORT ================= */
                    (
                        $1::date IS NOT NULL

                        AND ie.inactive_date::date >=
                            $1::date
                    )

                    OR

                    /* ================= MONTH EXPORT ================= */
                    (
                        $1::date IS NULL

                        AND (
                            EXTRACT(
                                YEAR FROM ie.inactive_date
                            ) > $3

                            OR (

                                EXTRACT(
                                    YEAR FROM ie.inactive_date
                                ) = $3

                                AND EXTRACT(
                                    MONTH FROM ie.inactive_date
                                ) >= $2
                            )
                        )
                    )
                )
            )
        )
    `;

    /* =========================================================
       USERNAME / NAME FILTER
    ========================================================= */
    if (username) {
        query += `
            AND (
                pd.username ILIKE $${count}

                OR pd.first_name ILIKE $${count}

                OR pd.middle_name ILIKE $${count}

                OR pd.last_name ILIKE $${count}

                OR CONCAT_WS(
                    ' ',
                    pd.first_name,
                    pd.middle_name,
                    pd.last_name
                ) ILIKE $${count}
            )
        `;

        values.push(
            `%${username}%`
        );

        count++;
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
            .toLowerCase() !== "nan"
    ) {
        const locationValue = String(work_location).trim();
        const locationId =  Number(locationValue);

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

        } else {
            query += `
                AND LOWER(TRIM(wl.location))
                    = LOWER(TRIM($${count}))
            `;

            values.push(
                locationValue
            );
        }

        count++;
    }

    /* =========================================================
       ORDER
    ========================================================= */
    query += `
        ORDER BY
            pd.username ASC,
            ats.entry_at DESC NULLS LAST,
            ats.id DESC
    `;

    const {
        rows
    } = await pool.query(
        query,
        values
    );

    return {
        rows
    };
};