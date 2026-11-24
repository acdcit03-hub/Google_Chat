import { pool } from "../../database.js";

export const getActiveEmployeeMonthlyAttendanceModel = async ({
    month,
    year,
    username,
    work_location = null,
    category = null
}) => {
    try {

        const hasUsername =
            username &&
            String(username).trim() !== "";

        const hasWorkLocation =
            work_location !== null &&
            work_location !== undefined &&
            String(work_location).trim() !== "" &&
            String(work_location).trim().toLowerCase() !== "all" &&
            String(work_location).trim().toLowerCase() !== "nan";

        const hasCategory =
            category !== null &&
            category !== undefined &&
            String(category).trim() !== "" &&
            String(category).trim().toLowerCase() !== "all" &&
            String(category).trim().toLowerCase() !== "nan";

        /* =========================================================
           WORK LOCATION FILTER
        ========================================================= */
        let workLocationFilter = "";

        if (hasWorkLocation) {
            const locationValue = String(work_location).trim();
            const locationId = Number(locationValue);
            if (
                Number.isInteger(locationId) &&
                locationId > 0
            ) {
                workLocationFilter = `
                    AND wl.id = $${hasUsername ? 4 : 3}
                `;

            } else {
                workLocationFilter = `
                    AND LOWER(TRIM(wl.location))
                        = LOWER(TRIM($${hasUsername ? 4 : 3}))
                `;
            }
        }

        /* =========================================================
           CATEGORY FILTER
        ========================================================= */
        let categoryFilter = "";

        if (hasCategory) {
            const categoryValue = String(category).trim();
            const categoryId = Number(categoryValue);

            let categoryParamIndex;

            if (hasUsername) {
                categoryParamIndex = hasWorkLocation ? 5 : 4;
            } else {
                categoryParamIndex = hasWorkLocation ? 4 : 3;
            }

            if (
                Number.isInteger(categoryId) &&
                categoryId > 0
            ) {
                categoryFilter = `
                    AND c.id = $${categoryParamIndex}
                `;

            } else {
                categoryFilter = `
                    AND LOWER(TRIM(c.category_name))
                        = LOWER(TRIM($${categoryParamIndex}))
                `;
            }
        }

        const query = `
            WITH employee_data AS (

                SELECT DISTINCT

                    pd.username,
                    pd.first_name,
                    pd.middle_name,
                    pd.last_name,
                    ed.employment_id

                FROM employment_details ed

                INNER JOIN personal_details pd
                    ON pd.id = ed.personal_details_id

                INNER JOIN master_employee me
                    ON me.personal_details_id = pd.id

                /* ================= CATEGORY ================= */
                LEFT JOIN category c
                    ON c.id = ed.category

                /* ================= WORK LOCATION ================= */
                LEFT JOIN work_location wl
                    ON wl.id = ed.work_location

                WHERE
                    LOWER(TRIM(me.status::text)) = 'active'

                    ${
                        hasUsername
                            ? `
                                AND LOWER(TRIM(pd.username))
                                    = LOWER(TRIM($3))
                              `
                            : ""
                    }

                    ${workLocationFilter}

                    ${categoryFilter}
            ),

            /* =====================================================
               ALL DAYS OF MONTH
            ===================================================== */
            month_dates AS (

                SELECT
                    gs::date AS attendance_date

                FROM generate_series(
                    make_date($2::int, $1::int, 1),
                    (
                        make_date($2::int, $1::int, 1)
                        + INTERVAL '1 month - 1 day'
                    ),
                    INTERVAL '1 day'
                ) gs
            ),

            /* =====================================================
               EVERY ACTIVE EMPLOYEE × EVERY DAY
            ===================================================== */
            employee_dates AS (

                SELECT

                    LOWER(TRIM(e.username)) AS username,

                    e.first_name,
                    e.middle_name,
                    e.last_name,
                    e.employment_id,

                    md.attendance_date

                FROM employee_data e

                CROSS JOIN month_dates md
            ),

            /* =====================================================
               TIMESHEET
            ===================================================== */
            timesheet_data AS (

                SELECT

                    LOWER(TRIM(ts.user_name)) AS username,

                    CASE

                        WHEN TRIM(ts.date::text)
                            ~ '^\\d{2}-\\d{2}-\\d{4}$'

                        THEN TO_DATE(
                            TRIM(ts.date::text),
                            'DD-MM-YYYY'
                        )

                        WHEN TRIM(ts.date::text)
                            ~ '^\\d{4}-\\d{2}-\\d{2}'

                        THEN SUBSTRING(
                            TRIM(ts.date::text)
                            FROM 1 FOR 10
                        )::date

                        ELSE NULL

                    END AS timesheet_date,

                    MIN(ts.id) AS id,

                    MIN(ts.project_code)
                        AS project_code,

                    MIN(ts.project_id)
                        AS project_id,

                    MIN(ts.project_type)
                        AS project_type,

                    MIN(ts.category_letter)
                        AS category_letter,

                    MIN(ts.process_name)
                        AS process_name,

                    MIN(ts.process_id)
                        AS process_id,

                    MIN(ts.start_time)
                        AS start_time,

                    MAX(ts.stop_time)
                        AS stop_time,

                    SUM(

                        CASE

                            WHEN
                                ts.duration IS NULL
                                OR TRIM(ts.duration::text) = ''

                            THEN 0

                            ELSE EXTRACT(
                                EPOCH FROM
                                TRIM(
                                    ts.duration::text
                                )::interval
                            )

                        END

                    ) AS timesheet_seconds,

                    MIN(ts.project_by)
                        AS project_by,

                    MIN(ts.user_id)
                        AS user_id,

                    MIN(ts.notes)
                        AS notes,

                    MIN(ts.created_at)
                        AS created_at,

                    MAX(ts.updated_at)
                        AS updated_at,

                    MIN(ts.checked_tasks)
                        AS checked_tasks,

                    MIN(ts.user_name)
                        AS user_name,

                    MIN(ts.task_id)
                        AS task_id,

                    MIN(ts.task_serial_number)
                        AS task_serial_number

                FROM "TIMESHEET" ts

                WHERE

                    CASE

                        WHEN TRIM(ts.date::text)
                            ~ '^\\d{2}-\\d{2}-\\d{4}$'

                        THEN TO_DATE(
                            TRIM(ts.date::text),
                            'DD-MM-YYYY'
                        )

                        WHEN TRIM(ts.date::text)
                            ~ '^\\d{4}-\\d{2}-\\d{2}'

                        THEN SUBSTRING(
                            TRIM(ts.date::text)
                            FROM 1 FOR 10
                        )::date

                        ELSE NULL

                    END >= make_date(
                        $2::int,
                        $1::int,
                        1
                    )

                    AND

                    CASE

                        WHEN TRIM(ts.date::text)
                            ~ '^\\d{2}-\\d{2}-\\d{4}$'

                        THEN TO_DATE(
                            TRIM(ts.date::text),
                            'DD-MM-YYYY'
                        )

                        WHEN TRIM(ts.date::text)
                            ~ '^\\d{4}-\\d{2}-\\d{2}'

                        THEN SUBSTRING(
                            TRIM(ts.date::text)
                            FROM 1 FOR 10
                        )::date

                        ELSE NULL

                    END < (

                        make_date(
                            $2::int,
                            $1::int,
                            1
                        )
                        + INTERVAL '1 month'

                    )

                    ${
                        hasUsername
                            ? `
                                AND LOWER(
                                    TRIM(ts.user_name)
                                )
                                =
                                LOWER(
                                    TRIM($3)
                                )
                              `
                            : ""
                    }

                GROUP BY

                    LOWER(TRIM(ts.user_name)),

                    CASE

                        WHEN TRIM(ts.date::text)
                            ~ '^\\d{2}-\\d{2}-\\d{4}$'

                        THEN TO_DATE(
                            TRIM(ts.date::text),
                            'DD-MM-YYYY'
                        )

                        WHEN TRIM(ts.date::text)
                            ~ '^\\d{4}-\\d{2}-\\d{2}'

                        THEN SUBSTRING(
                            TRIM(ts.date::text)
                            FROM 1 FOR 10
                        )::date

                        ELSE NULL

                    END
            ),

            /* =====================================================
               ATTENDANCE
            ===================================================== */
            attendance_data AS (

                SELECT

                    LOWER(
                        TRIM(ats.username)
                    ) AS username,

                    ats.entry_at::date
                        AS attendance_date,

                    MIN(ats.entry_at)
                        AS entry_at,

                    MAX(ats.exit_at)
                        AS exit_at,

                    SUM(

                        EXTRACT(
                            EPOCH FROM
                            COALESCE(
                                ats.duration,
                                INTERVAL '0'
                            )
                        )

                    ) AS attendance_seconds

                FROM attendance_sessions ats

                WHERE

                    ats.entry_at::date >=
                    make_date(
                        $2::int,
                        $1::int,
                        1
                    )

                    AND

                    ats.entry_at::date < (

                        make_date(
                            $2::int,
                            $1::int,
                            1
                        )
                        + INTERVAL '1 month'

                    )

                    ${
                        hasUsername
                            ? `
                                AND LOWER(
                                    TRIM(ats.username)
                                )
                                =
                                LOWER(
                                    TRIM($3)
                                )
                              `
                            : ""
                    }

                GROUP BY

                    LOWER(
                        TRIM(ats.username)
                    ),

                    ats.entry_at::date
            ),

            /* =====================================================
               HOLIDAYS
            ===================================================== */
            holiday_data AS (

                SELECT DISTINCT

                    CASE

                        WHEN TRIM(
                            h.holiday_date::text
                        )
                        ~ '^\\d{2}-\\d{2}-\\d{4}$'

                        THEN TO_DATE(
                            TRIM(
                                h.holiday_date::text
                            ),
                            'DD-MM-YYYY'
                        )

                        WHEN TRIM(
                            h.holiday_date::text
                        )
                        ~ '^\\d{4}-\\d{2}-\\d{2}'

                        THEN SUBSTRING(
                            TRIM(
                                h.holiday_date::text
                            )
                            FROM 1 FOR 10
                        )::date

                        ELSE NULL

                    END AS holiday_date,

                    COALESCE(
                        NULLIF(
                            TRIM(
                                h.holiday_name::text
                            ),
                            ''
                        ),
                        'Holiday'
                    ) AS holiday_name

                FROM holidays h

                WHERE

                    CASE

                        WHEN TRIM(
                            h.holiday_date::text
                        )
                        ~ '^\\d{2}-\\d{2}-\\d{4}$'

                        THEN TO_DATE(
                            TRIM(
                                h.holiday_date::text
                            ),
                            'DD-MM-YYYY'
                        )

                        WHEN TRIM(
                            h.holiday_date::text
                        )
                        ~ '^\\d{4}-\\d{2}-\\d{2}'

                        THEN SUBSTRING(
                            TRIM(
                                h.holiday_date::text
                            )
                            FROM 1 FOR 10
                        )::date

                        ELSE NULL

                    END >= make_date(
                        $2::int,
                        $1::int,
                        1
                    )

                    AND

                    CASE

                        WHEN TRIM(
                            h.holiday_date::text
                        )
                        ~ '^\\d{2}-\\d{2}-\\d{4}$'

                        THEN TO_DATE(
                            TRIM(
                                h.holiday_date::text
                            ),
                            'DD-MM-YYYY'
                        )

                        WHEN TRIM(
                            h.holiday_date::text
                        )
                        ~ '^\\d{4}-\\d{2}-\\d{2}'

                        THEN SUBSTRING(
                            TRIM(
                                h.holiday_date::text
                            )
                            FROM 1 FOR 10
                        )::date

                        ELSE NULL

                    END < (

                        make_date(
                            $2::int,
                            $1::int,
                            1
                        )
                        + INTERVAL '1 month'

                    )
            ),

            /* =====================================================
               LEAVE DATA
            ===================================================== */
            leave_data AS (

                SELECT
                    LOWER(
                        TRIM(el.username)
                    ) AS username,

                    leave_day::date AS leave_day,

                    CASE

                        WHEN LOWER(
                            TRIM(
                                COALESCE(
                                    el.leave_type::text,
                                    ''
                                )
                            )
                        ) IN (
                            'full day',
                            'full-day',
                            'fullday',
                            'full day leave'
                        )

                        THEN 'Full Day Leave'

                        WHEN TRIM(
                            COALESCE(
                                el.leave_type::text,
                                ''
                            )
                        ) = ''

                        THEN 'Leave'

                        ELSE TRIM(
                            el.leave_type::text
                        )

                    END AS leave_name

                FROM employee_leaves el

                CROSS JOIN LATERAL generate_series(
                    GREATEST(
                        el.start_leave_date::date,
                        make_date($2::int, $1::int, 1)
                    ),
                    LEAST(
                        el.end_leave_date::date,
                        (
                            make_date($2::int, $1::int, 1)
                            + INTERVAL '1 month'
                            - INTERVAL '1 day'
                        )::date
                    ),
                    INTERVAL '1 day'
                ) AS leave_dates(leave_day)

                LEFT JOIN personal_details pd
                    ON LOWER(TRIM(pd.username)) = LOWER(TRIM(el.username))

                LEFT JOIN employment_details ed
                    ON ed.personal_details_id = pd.id

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

                WHERE el.start_leave_date::date < (
                    make_date($2::int, $1::int, 1)
                    + INTERVAL '1 month'
                )
                  AND el.end_leave_date::date >= make_date(
                    $2::int,
                    $1::int,
                    1
                )
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

                    ${
                        hasUsername
                            ? `
                                AND LOWER(
                                    TRIM(el.username)
                                )
                                =
                                LOWER(
                                    TRIM($3)
                                )
                              `
                            : ""
                    }
            )

            /* =====================================================
               FINAL
            ===================================================== */
            SELECT
                e.username,
                e.first_name,
                e.middle_name,
                e.last_name,

                e.employment_id,

                /* ================= ATTENDANCE ================= */
                a.entry_at,
                a.exit_at,

                CASE

                    WHEN
                        a.attendance_seconds IS NULL

                    THEN NULL

                    ELSE make_interval(
                        secs =>
                            a.attendance_seconds
                    )

                END AS attendance_duration,

                /* ================= TIMESHEET ================= */
                t.id,
                t.project_code,
                t.project_id,
                t.project_type,
                t.category_letter,
                t.process_name,
                t.process_id,

                e.attendance_date AS date,

                t.start_time,
                t.stop_time,

                CASE

                    WHEN
                        t.timesheet_seconds IS NULL

                    THEN NULL

                    ELSE make_interval(
                        secs =>
                            t.timesheet_seconds
                    )

                END AS duration,

                t.project_by,
                t.user_id,
                t.notes,
                t.created_at,
                t.updated_at,
                t.checked_tasks,

                COALESCE(
                    t.user_name,
                    e.username
                ) AS user_name,

                t.task_id,
                t.task_serial_number,

                /* =================================================
                   STATUS
                ================================================= */
                CASE

                    WHEN
                        a.attendance_seconds IS NOT NULL
                        AND a.attendance_seconds > 0

                    THEN NULL

                    WHEN
                        ld.leave_day IS NOT NULL

                    THEN ld.leave_name

                    WHEN
                        hd.holiday_date IS NOT NULL

                    THEN hd.holiday_name

                    WHEN
                        EXTRACT(
                            DOW FROM
                            e.attendance_date
                        ) = 0

                    THEN 'Weekly Off'

                    ELSE NULL

                END AS day_status

            FROM employee_dates e

            LEFT JOIN timesheet_data t
                ON t.username = e.username
                AND t.timesheet_date = e.attendance_date

            LEFT JOIN attendance_data a
                ON a.username = e.username
                AND a.attendance_date = e.attendance_date

            LEFT JOIN holiday_data hd
                ON hd.holiday_date = e.attendance_date

            LEFT JOIN leave_data ld
                ON ld.username = e.username
                AND ld.leave_day = e.attendance_date

            ORDER BY
                e.employment_id ASC,
                e.username ASC,
                e.attendance_date ASC
        `;

        /* =========================================================
           PARAMS
        ========================================================= */
        const params = [
            month,
            year
        ];

        if (hasUsername) {
            params.push(
                String(username).trim()
            );
        }

        if (hasWorkLocation) {
            const locationValue = String(work_location).trim();
            const locationId = Number(locationValue);

            params.push(
                Number.isInteger(locationId) &&
                locationId > 0
                    ? locationId
                    : locationValue
            );
        }

        if (hasCategory) {
            const categoryValue = String(category).trim();
            const categoryId = Number(categoryValue);

            params.push(
                Number.isInteger(categoryId) &&
                categoryId > 0
                    ? categoryId
                    : categoryValue
            );
        }

        const { rows } =
            await pool.query(
                query,
                params
            );

        return rows;

    } catch (error) {
        console.error("GET ACTIVE EMPLOYEE MONTHLY ATTENDANCE MODEL ERROR:", error);
        throw error;
    }
};