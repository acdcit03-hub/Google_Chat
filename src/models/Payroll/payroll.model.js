import { pool } from "../../database.js";
import {
    decryptPayrollFields,
    decryptPayrollRows
} from "../../utils/payrollEncryption.js";

const parseMonth = (monthInput) => {
    if (monthInput === undefined || monthInput === null || monthInput === "") {
        return new Date().getMonth() + 1;
    }

    const numericMonth = Number(monthInput);
    if (!Number.isNaN(numericMonth) && numericMonth >= 1 && numericMonth <= 12) {
        return numericMonth;
    }

    const monthNames = [
        "january",
        "february",
        "march",
        "april",
        "may",
        "june",
        "july",
        "august",
        "september",
        "october",
        "november",
        "december"
    ];

    const normalized = String(monthInput).trim().toLowerCase();
    const index = monthNames.indexOf(normalized);
    if (index !== -1) {
        return index + 1;
    }

    const parsed = Date.parse(`${monthInput} 1, 2000`);
    if (!Number.isNaN(parsed)) {
        return new Date(parsed).getMonth() + 1;
    }

    return new Date().getMonth() + 1;
};

export const getPayrollSalaryStatsModel = async ({
    month,
    year,
    work_location,
    category = null
}) => {
    const normalizedLocation =
        work_location == null ||
        String(work_location).trim() === "" ||
        String(work_location).trim().toLowerCase() === "all"
            ? null
            : String(work_location).trim();

    const normalizedCategory =
        category == null ||
        String(category).trim() === "" ||
        String(category).trim().toLowerCase() === "all"
            ? null
            : String(category).trim();

    // =====================================================
    // 1. FETCH UNIQUE PAYROLL RECORD PER EMPLOYEE
    // =====================================================
    const result = await pool.query(
        `
            SELECT DISTINCT ON (LOWER(TRIM(p.username::TEXT)))
                LOWER(TRIM(p.username::TEXT)) AS username,
                p.basic_salary,
                p.net_salary,
                p.salary_status
            FROM payroll p
            INNER JOIN personal_details pd
                ON LOWER(TRIM(pd.username)) =
                   LOWER(TRIM(p.username::TEXT))
            WHERE p.payroll_month = $1::INTEGER
              AND p.payroll_year = $2::INTEGER

              AND (
                  $3::TEXT IS NULL
                  OR EXISTS (
                      SELECT 1
                      FROM employment_details ed
                      INNER JOIN work_location wl
                          ON wl.id = ed.work_location
                      WHERE ed.personal_details_id = pd.id
                        AND (
                            (
                                $3::TEXT ~ '^[0-9]+$'
                                AND wl.id = $3::INTEGER
                            )
                            OR LOWER(TRIM(wl.location)) =
                               LOWER(TRIM($3::TEXT))
                        )
                  )
              )

              AND (
                  $4::TEXT IS NULL
                  OR EXISTS (
                      SELECT 1
                      FROM employment_details ed
                      INNER JOIN category c
                          ON c.id = ed.category
                      WHERE ed.personal_details_id = pd.id
                        AND LOWER(TRIM(c.category_name)) =
                            LOWER(TRIM($4::TEXT))
                  )
              )

            ORDER BY
                LOWER(TRIM(p.username::TEXT)),
                p.updated_at DESC NULLS LAST,
                p.id DESC
        `,
        [month, year, normalizedLocation, normalizedCategory]
    );

    // =====================================================
    // 2. TOTAL ACTIVE EMPLOYEES
    // =====================================================
    const totalEmployeeResult = await pool.query(
        `
            SELECT COUNT(
                DISTINCT LOWER(TRIM(pd.username))
            )::INTEGER AS total_employee
            FROM personal_details pd
            INNER JOIN master_employee me
                ON LOWER(TRIM(me.username)) =
                   LOWER(TRIM(pd.username))
            WHERE LOWER(TRIM(me.status::TEXT)) = 'active'

              AND (
                  $1::TEXT IS NULL
                  OR EXISTS (
                      SELECT 1
                      FROM employment_details ed
                      INNER JOIN work_location wl
                          ON wl.id = ed.work_location
                      WHERE LOWER(TRIM(ed.username)) =
                            LOWER(TRIM(pd.username))
                        AND (
                            (
                                $1::TEXT ~ '^[0-9]+$'
                                AND wl.id = $1::INTEGER
                            )
                            OR LOWER(TRIM(wl.location)) =
                               LOWER(TRIM($1::TEXT))
                        )
                  )
              )

              AND (
                  $2::TEXT IS NULL
                  OR EXISTS (
                      SELECT 1
                      FROM employment_details ed
                      INNER JOIN category c
                          ON c.id = ed.category
                      WHERE LOWER(TRIM(ed.username)) =
                            LOWER(TRIM(pd.username))
                        AND LOWER(TRIM(c.category_name)) =
                            LOWER(TRIM($2::TEXT))
                  )
              )
        `,
        [normalizedLocation, normalizedCategory]
    );

    const totalEmployee = Number(
        totalEmployeeResult.rows[0]?.total_employee || 0
    );

    // =====================================================
    // 3. FETCH SALARY CONFIGURATIONS FOR SELECTED PERIOD
    // =====================================================
    const configBasicSalaryResult = await pool.query(
        `
            SELECT DISTINCT ON (LOWER(TRIM(epc.username)))
                LOWER(TRIM(epc.username)) AS username,
                epc.current_salary AS basic_salary
            FROM employee_payroll_config epc
            INNER JOIN personal_details pd
                ON LOWER(TRIM(pd.username)) =
                   LOWER(TRIM(epc.username))
            WHERE epc.payroll_start_date <= (
                MAKE_DATE($2::INTEGER, $1::INTEGER, 1)
                + INTERVAL '1 month'
                - INTERVAL '1 day'
            )::DATE
              AND epc.payroll_end_date >=
                  MAKE_DATE($2::INTEGER, $1::INTEGER, 1)
              AND epc.current_salary IS NOT NULL

              AND (
                  $3::TEXT IS NULL
                  OR EXISTS (
                      SELECT 1
                      FROM employment_details ed
                      INNER JOIN work_location wl
                          ON wl.id = ed.work_location
                      WHERE ed.personal_details_id = pd.id
                        AND (
                            (
                                $3::TEXT ~ '^[0-9]+$'
                                AND wl.id = $3::INTEGER
                            )
                            OR LOWER(TRIM(wl.location)) =
                               LOWER(TRIM($3::TEXT))
                        )
                  )
              )

              AND (
                  $4::TEXT IS NULL
                  OR EXISTS (
                      SELECT 1
                      FROM employment_details ed
                      INNER JOIN category c
                          ON c.id = ed.category
                      WHERE ed.personal_details_id = pd.id
                        AND LOWER(TRIM(c.category_name)) =
                            LOWER(TRIM($4::TEXT))
                  )
              )

            ORDER BY
                LOWER(TRIM(epc.username)),
                epc.payroll_start_date DESC,
                epc.id DESC
        `,
        [
            month,
            year,
            normalizedLocation,
            normalizedCategory
        ]
    );

    // =====================================================
    // 4. DECRYPT SALARY FIELDS
    // =====================================================
    const payrollRows = decryptPayrollRows(
        result.rows,
        ["basic_salary", "net_salary"]
    );

    const configSalaryRows = decryptPayrollRows(
        configBasicSalaryResult.rows,
        ["basic_salary"]
    );

    // =====================================================
    // 5. BASIC SALARY COUNT AND TOTAL
    // =====================================================
    const basicSalaryRows = configSalaryRows.filter(row =>
        row.basic_salary !== null &&
        row.basic_salary !== undefined &&
        String(row.basic_salary).trim() !== "" &&
        Number.isFinite(Number(row.basic_salary)) &&
        String(row.username || "").trim() !== ""
    );

    const basicSalaryByUsername = new Map();

    for (const row of basicSalaryRows) {
        const username = String(row.username).trim().toLowerCase();

        if (!basicSalaryByUsername.has(username)) {
            basicSalaryByUsername.set(username, row);
        }
    }

    // =====================================================
    // 6. VALID NET SALARY ROWS
    // =====================================================
    const netSalaryRows = payrollRows.filter(row =>
        String(row.username || "").trim() !== "" &&
        row.net_salary !== null &&
        row.net_salary !== undefined &&
        String(row.net_salary).trim() !== "" &&
        Number.isFinite(Number(row.net_salary))
    );

    const netSalaryByUsername = new Map();

    for (const row of netSalaryRows) {
        const username = String(row.username).trim().toLowerCase();

        if (!netSalaryByUsername.has(username)) {
            netSalaryByUsername.set(username, row);
        }
    }

    const basicSalaryCount = basicSalaryByUsername.size;
    const netSalaryCount = netSalaryByUsername.size;

    // Work in integer cents to avoid floating-point sum errors.
    const toCents = value => {
        const amount = Number(value);

        if (!Number.isFinite(amount)) {
            throw new Error(`Invalid salary amount: ${value}`);
        }

        return BigInt(Math.round(amount * 100));
    };

    const totalBasicSalaryCents = [
        ...basicSalaryByUsername.values()
    ].reduce(
        (total, row) => total + toCents(row.basic_salary),
        0n
    );

    // =====================================================
    // 7. STATUS COUNTS AND SAVED NET SALARY TOTALS
    // =====================================================
    const statusMap = new Map();

    for (const row of payrollRows) {
        let statusText = String(
            row.salary_status || "Pending"
        ).trim();

        let statusKey = statusText.toLowerCase();

        if (statusKey === "approved" || statusKey === "approve") {
            statusText = "Pending";
            statusKey = "pending";
        }

        if (!statusMap.has(statusKey)) {
            statusMap.set(statusKey, {
                status: statusText,
                count: 0,
                netSalaryCents: 0n
            });
        }

        const entry = statusMap.get(statusKey);
        entry.count += 1;

        const username = String(row.username || "")
            .trim()
            .toLowerCase();

        // Add only valid saved net salary amounts.
        if (netSalaryByUsername.has(username)) {
            entry.netSalaryCents += toCents(row.net_salary);
        }
    }

    const salaryStatusCounts = {};

    for (const entry of statusMap.values()) {
        const key = entry.status
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "_")
            .replace(/^_+|_+$/g, "");

        salaryStatusCounts[key] = entry.count;
    }

    const totalNetSalaryCents = [
        ...netSalaryByUsername.values()
    ].reduce(
        (total, row) => total + toCents(row.net_salary),
        0n
    );

    const pendingSalaryCents =
        statusMap.get("pending")?.netSalaryCents ?? 0n;

    const paidSalaryCents =
        statusMap.get("paid")?.netSalaryCents ?? 0n;

    // =====================================================
    // 8. RESPONSE
    // =====================================================
    return {
        month: Number(month),
        year: Number(year),
        work_location: normalizedLocation,
        category: normalizedCategory,

        total_employee: totalEmployee,

        basic_salary_count: basicSalaryCount,
        basic_salary: Number(totalBasicSalaryCents) / 100,

        net_salary_count: netSalaryCount,
        net_salary: Number(totalNetSalaryCents) / 100,

        ...salaryStatusCounts,

        pending_salary: Number(pendingSalaryCents) / 100,
        paid_salary: Number(paidSalaryCents) / 100
    };
};


export const getPayrollEmployeesModel = async ({
    month,
    year,
    work_location
}) => {

    const selectedMonth = parseMonth(month);
    const selectedYear = Number(year) || new Date().getFullYear();

    const values = [
        Number(selectedMonth),
        Number(selectedYear)
    ];

    let count = 3;

    let query = `
        SELECT
            /* ================= EMPLOYEE ================= */
            ed.id AS "employeeId",
            ed.employment_id,

            /* ================= SHIFT ================= */
            ed.shift_id,
            sc.shift_name,
            sc.shift_type,
            epc.working_start_time,
            epc.working_end_time,

            /* ================= WORK LOCATION ================= */
            ed.work_location AS work_location_id,
            wl.location AS work_location,

            /* ================= PERSONAL ================= */
            pd.username,
            pd.first_name,
            pd.middle_name,
            pd.last_name,

            /* ================= STATUS ================= */
            me.status,

            /* ================= MONTH / YEAR ================= */
            TO_CHAR(
                MAKE_DATE(
                    $2::INT,
                    $1::INT,
                    1
                ),
                'Month'
            ) AS month,

            $2::INT AS year,

            /* ================= ATTENDANCE ================= */
            COUNT(
                DISTINCT ats.entry_at::date
            ) AS attendance,

            /* ================= TOTAL HOURS ================= */

            (
                COALESCE(
                    ROUND(
                        SUM(
                            EXTRACT(
                                EPOCH FROM
                                COALESCE(ats.duration, INTERVAL '0 second')
                            )
                        ) / 60.0
                    ),
                    0
                )::BIGINT / 60
            )::TEXT
            ||
            ':' ||
            LPAD(
                (
                    COALESCE(
                        ROUND(
                            SUM(
                                EXTRACT(
                                    EPOCH FROM
                                    COALESCE(ats.duration, INTERVAL '0 second')
                                )
                            ) / 60.0
                        ),
                        0
                    )::BIGINT % 60
                )::TEXT,
                2,
                '0'
            )
            ||
            ':00' AS total_hours,
            
            
            /* ================= TOTAL MINUTES ================= */
            
            COALESCE(
                ROUND(
                    SUM(
                        EXTRACT(
                            EPOCH FROM
                            COALESCE(ats.duration, INTERVAL '0 second')
                        )
                    ) / 60.0
                ),
                0
            )::BIGINT AS total_minutes,      

            /* ================= OVERTIME ================= */
            COALESCE(
                GREATEST(

                    FLOOR(
                        EXTRACT(
                            EPOCH FROM SUM(ats.duration)
                        ) / 60
                    )::INT

                    -

                    (
                        COUNT(
                            DISTINCT ats.entry_at::date
                        )

                        *

                        COALESCE(
                            FLOOR(
                                EXTRACT(
                                    EPOCH FROM (
                                        sc.end_time -
                                        sc.start_time
                                    )
                                ) / 60.0
                            )::BIGINT,
                            0
                        )
                    ),

                    0

                ),
                0
            )::INT AS total_overtime_minutes,

            /* =====================================================
               DAILY RECORDS
            ===================================================== */
            (
                SELECT COALESCE(
                    json_agg(
                        day_row
                        ORDER BY day_row.date
                    ),
                    '[]'::json
                )

                FROM (

                    SELECT

                        TO_CHAR(
                            ats2.entry_at
                                AT TIME ZONE 'Asia/Kolkata',
                            'YYYY-MM-DD'
                        ) AS date,

                        MIN(
                            TO_CHAR(
                                ats2.entry_at
                                    AT TIME ZONE 'Asia/Kolkata',
                                'HH24:MI:SS'
                            )
                        ) AS check_in,

                        MAX(
                            TO_CHAR(
                                ats2.exit_at
                                    AT TIME ZONE 'Asia/Kolkata',
                                'HH24:MI:SS'
                            )
                        ) AS check_out,

                        TO_CHAR(
                            sc.start_time,
                            'HH24:MI:SS'
                        ) AS shift_time,

                        /* ================= DAY TOTAL ================= */
                        COALESCE(
                            CONCAT(

                                EXTRACT(
                                    EPOCH FROM
                                    SUM(ats2.duration)
                                )::BIGINT / 3600,

                                ':',

                                LPAD(
                                    (
                                        (
                                            EXTRACT(
                                                EPOCH FROM
                                                SUM(ats2.duration)
                                            )::BIGINT / 60
                                        ) % 60
                                    )::TEXT,
                                    2,
                                    '0'
                                ),

                                ':',

                                LPAD(
                                    (
                                        EXTRACT(
                                            EPOCH FROM
                                            SUM(ats2.duration)
                                        )::BIGINT % 60
                                    )::TEXT,
                                    2,
                                    '0'
                                )

                            ),
                            '0:00:00'
                        ) AS total_hours,

                        COALESCE(
                            FLOOR(
                                EXTRACT(
                                    EPOCH FROM
                                    SUM(ats2.duration)
                                ) / 60
                            )::INT,
                            0
                        ) AS total_minutes,

                        /* ================= OVERTIME ================= */
                        COALESCE(

                            (
                                GREATEST(

                                    FLOOR(
                                        EXTRACT(
                                            EPOCH FROM
                                            SUM(ats2.duration)
                                        ) / 60
                                    )::INT

                                    -

                                    COALESCE(
                                        FLOOR(
                                            EXTRACT(
                                                EPOCH FROM (
                                                    sc.end_time -
                                                    sc.start_time
                                                )
                                            ) / 60.0
                                        )::BIGINT,
                                        0
                                    ),

                                    0

                                ) / 60
                            )::TEXT

                            || ':' ||

                            LPAD(
                                (
                                    GREATEST(

                                        FLOOR(
                                            EXTRACT(
                                                EPOCH FROM
                                                SUM(ats2.duration)
                                            ) / 60
                                        )::INT

                                        -

                                        COALESCE(
                                            FLOOR(
                                                EXTRACT(
                                                    EPOCH FROM (
                                                        sc.end_time -
                                                        sc.start_time
                                                    )
                                                ) / 60.0
                                            )::BIGINT,
                                            0
                                        ),

                                        0

                                    ) % 60
                                )::TEXT,
                                2,
                                '0'
                            )

                            || ':00',

                            '0:00:00'
                        ) AS total_overtime,

                        /* ================= SESSIONS ================= */
                        COALESCE(

                            json_agg(

                                json_build_object(

                                    'check_in',
                                    TO_CHAR(
                                        ats2.entry_at
                                            AT TIME ZONE 'Asia/Kolkata',
                                        'HH24:MI:SS'
                                    ),

                                    'check_out',
                                    TO_CHAR(
                                        ats2.exit_at
                                            AT TIME ZONE 'Asia/Kolkata',
                                        'HH24:MI:SS'
                                    ),

                                    'total_hours',

                                    COALESCE(
                                        CONCAT(

                                            EXTRACT(
                                                EPOCH FROM
                                                ats2.duration
                                            )::BIGINT / 3600,

                                            ':',

                                            LPAD(
                                                (
                                                    (
                                                        EXTRACT(
                                                            EPOCH FROM
                                                            ats2.duration
                                                        )::BIGINT / 60
                                                    ) % 60
                                                )::TEXT,
                                                2,
                                                '0'
                                            ),

                                            ':',

                                            LPAD(
                                                (
                                                    EXTRACT(
                                                        EPOCH FROM
                                                        ats2.duration
                                                    )::BIGINT % 60
                                                )::TEXT,
                                                2,
                                                '0'
                                            )

                                        ),
                                        '0:00:00'
                                    ),

                                    'total_minutes',

                                    COALESCE(
                                        FLOOR(
                                            EXTRACT(
                                                EPOCH FROM
                                                ats2.duration
                                            ) / 60
                                        )::INT,
                                        0
                                    )

                                )

                                ORDER BY ats2.entry_at

                            ),

                            '[]'::json

                        ) AS sessions

                    FROM attendance_sessions ats2

                    WHERE ats2.username = pd.username

                    AND LOWER(
                        ats2.status
                    ) = 'completed'

                    AND EXTRACT(
                        MONTH FROM ats2.entry_at
                    ) = $1

                    AND EXTRACT(
                        YEAR FROM ats2.entry_at
                    ) = $2

                    GROUP BY

                        TO_CHAR(
                            ats2.entry_at
                                AT TIME ZONE 'Asia/Kolkata',
                            'YYYY-MM-DD'
                        ),

                        TO_CHAR(
                            sc.start_time,
                            'HH24:MI:SS'
                        )

                ) day_row

            ) AS daily_records,

            company_schedule.total_days AS company_total_days,
            company_schedule.total_days AS company_full_month_days,
            (
                company_schedule.total_days *
                COALESCE(
                    FLOOR(
                        EXTRACT(
                            EPOCH FROM (sc.end_time - sc.start_time)
                        ) / 60.0
                    )::BIGINT,
                    0
                )
            )::INT AS company_total_minutes,
            (
                company_schedule.total_days *
                COALESCE(
                    FLOOR(
                        EXTRACT(
                            EPOCH FROM (sc.end_time - sc.start_time)
                        ) / 60.0
                    )::BIGINT,
                    0
                )
            )::INT AS company_full_month_minutes

        FROM employment_details ed

        /* ================= PERSONAL ================= */
        LEFT JOIN personal_details pd
            ON pd.id =
               ed.personal_details_id

        /* ================= MASTER ================= */
        INNER JOIN master_employee me
            ON me.personal_details_id =
               pd.id
           AND LOWER(TRIM(me.status::TEXT)) = 'active'

        INNER JOIN LATERAL (
            SELECT epc_latest.*
            FROM employee_payroll_config epc_latest
            WHERE epc_latest.username = pd.username
              /* Selected month ne cover karti config — aje expire
                 hoy to pan te month (e.g. Sep) nu data aave */
              AND epc_latest.payroll_start_date <= (
                    MAKE_DATE($2::INT, $1::INT, 1)
                    + INTERVAL '1 month'
                    - INTERVAL '1 day'
                  )::DATE
              AND epc_latest.payroll_end_date >=
                    MAKE_DATE($2::INT, $1::INT, 1)
            ORDER BY
                epc_latest.payroll_start_date DESC,
                epc_latest.id DESC
            LIMIT 1
        ) epc ON TRUE

        /* ================= WORK LOCATION ================= */
        LEFT JOIN work_location wl
            ON wl.id =
               ed.work_location

        /* ================= SHIFT ================= */
        LEFT JOIN shift_configurations sc
            ON sc.id =
               ed.shift_id

        CROSS JOIN LATERAL (
            SELECT COUNT(*)::INT AS total_days
            FROM generate_series(
                MAKE_DATE($2::INT, $1::INT, 1),
                (
                    MAKE_DATE($2::INT, $1::INT, 1)
                    + INTERVAL '1 month'
                    - INTERVAL '1 day'
                )::DATE,
                INTERVAL '1 day'
            ) AS calendar_day(work_date)
            WHERE (
                CASE
                    WHEN COALESCE(cardinality(sc.days), 0) = 0
                    THEN EXTRACT(DOW FROM calendar_day.work_date) <> 0
                    ELSE (
                        ARRAY[
                            'SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'
                        ]
                    )[EXTRACT(DOW FROM calendar_day.work_date)::INT + 1]
                    = ANY(
                        ARRAY(
                        SELECT UPPER(LEFT(TRIM(day_name), 3))
                        FROM UNNEST(sc.days) AS shift_days(day_name)
                        )
                    )
                END
            )
            AND NOT EXISTS (
                SELECT 1
                FROM holidays h
                WHERE COALESCE(
                    h.transfer_date::DATE,
                    h.holiday_date::DATE
                ) = calendar_day.work_date
                  AND (
                      h.locations IS NULL
                      OR cardinality(h.locations) = 0
                      OR wl.id::TEXT = ANY(h.locations)
                  )
            )
        ) company_schedule

        /* ================= ATTENDANCE ================= */

        LEFT JOIN attendance_sessions ats
            ON ats.username = pd.username

            AND LOWER(
                ats.status
            ) IN (
                'completed',
                'expired'
            )

            AND EXTRACT(
                MONTH FROM ats.entry_at
            ) = $1

            AND EXTRACT(
                YEAR FROM ats.entry_at
            ) = $2

        WHERE 1 = 1
    `;

    /* =========================================================
       WORK LOCATION FILTER
    ========================================================= */
    if (
        work_location !== null &&
        work_location !== undefined &&
        String(work_location).trim() !== "" &&
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

        } else {
            query += `
                AND LOWER(
                    TRIM(wl.location)
                ) ILIKE LOWER(
                    TRIM($${count})
                )
            `;

            values.push(
                `%${locationValue}%`
            );
        }
        count++;
    }

    /* =========================================================
       GROUP BY
    ========================================================= */
    query += `
        GROUP BY

            ed.id,
            ed.employment_id,

            ed.work_location,

            ed.shift_id,
            epc.working_start_time,
            epc.working_end_time,

            sc.id,
            sc.shift_name,
            sc.shift_type,
            sc.start_time,
            sc.end_time,
            company_schedule.total_days,

            wl.id,
            wl.location,

            pd.username,
            pd.first_name,
            pd.middle_name,
            pd.last_name,

            me.status

        ORDER BY
            ed.id;

    `;

    const { rows } = await pool.query(
        query,
        values
    );

    return rows;
};

export const getEmployeeDailyRecordsModel = async ({
    username,
    month,
    year,
    work_location_id
}) => {
    const selectedMonth = Number(month);
    const selectedYear = Number(year);

    const locationId =
        work_location_id
            ? String(work_location_id)
            : null;

    const query = `
        WITH employee_shift AS (

            SELECT
                pd.username,
                ed.work_location,
                epc.working_start_time AS start_time,
                epc.working_end_time
            FROM employment_details ed

            INNER JOIN personal_details pd
                ON pd.id = ed.personal_details_id

            INNER JOIN LATERAL (
                SELECT epc_latest.*
                FROM employee_payroll_config epc_latest
                WHERE epc_latest.username = pd.username
                  /* Selected month ne cover karti config — period
                     aje expire hoy to pan te month nu data aave */
                  AND epc_latest.payroll_start_date <= (
                        MAKE_DATE($3::INT, $2::INT, 1)
                        + INTERVAL '1 month'
                        - INTERVAL '1 day'
                      )::DATE
                  AND epc_latest.payroll_end_date >=
                        MAKE_DATE($3::INT, $2::INT, 1)
                ORDER BY
                    epc_latest.payroll_start_date DESC,
                    epc_latest.id DESC
                LIMIT 1
            ) epc ON TRUE

            WHERE LOWER(
                TRIM(pd.username)
            ) = LOWER(
                TRIM($1)
            )

            LIMIT 1
        ),

        /* =====================================================
           ACTUAL ATTENDANCE DATES
        ===================================================== */
        attendance_dates AS (

            SELECT DISTINCT

                (
                    ats.entry_at
                    AT TIME ZONE 'Asia/Kolkata'
                )::date AS work_date

            FROM attendance_sessions ats

            WHERE LOWER(
                TRIM(ats.username)
            ) = LOWER(
                TRIM($1)
            )

            AND LOWER(
                ats.status
            ) IN (
                'completed',
                'expired'
            )

            AND EXTRACT(
                MONTH FROM
                ats.entry_at
                    AT TIME ZONE 'Asia/Kolkata'
            ) = $2

            AND EXTRACT(
                YEAR FROM
                ats.entry_at
                    AT TIME ZONE 'Asia/Kolkata'
            ) = $3
        ),

        /* =====================================================
           HOLIDAY DATES
        ===================================================== */
        holiday_dates AS (

            SELECT DISTINCT

                COALESCE(
                    h.transfer_date::date,
                    h.holiday_date::date
                ) AS work_date,

                h.holiday_name

            FROM holidays h

            WHERE COALESCE(
                h.transfer_date::date,
                h.holiday_date::date
            ) IS NOT NULL

            AND EXTRACT(
                MONTH FROM COALESCE(
                    h.transfer_date::date,
                    h.holiday_date::date
                )
            ) = $2

            AND EXTRACT(
                YEAR FROM COALESCE(
                    h.transfer_date::date,
                    h.holiday_date::date
                )
            ) = $3

            AND (
                h.locations IS NULL

                OR cardinality(
                    h.locations
                ) = 0

                OR $4 = ANY(
                    h.locations
                )
            )
        ),

        /* =====================================================
           COMBINE ATTENDANCE + HOLIDAY DATES
           
           This means:
           - attendance date appears
           - holiday date appears
           - normal absent date does NOT appear
        ===================================================== */
        all_dates AS (

            SELECT
                work_date
            FROM attendance_dates

            UNION

            SELECT
                work_date
            FROM holiday_dates
        )

        SELECT

            /* =================================================
               DATE
            ================================================= */
            TO_CHAR(
                d.work_date,
                'YYYY-MM-DD'
            ) AS date,

            /* =================================================
               HOLIDAY
            ================================================= */
            CASE
                WHEN h.work_date IS NOT NULL
                THEN true
                ELSE false
            END AS is_holiday,

            h.holiday_name,

            /* =================================================
               SHIFT
            ================================================= */
            TO_CHAR(
                es.start_time,
                'HH24:MI:SS'
            ) AS working_start_time,

            TO_CHAR(
                es.working_end_time,
                'HH24:MI:SS'
            ) AS working_end_time,

            /* =================================================
               ACTUAL ATTENDANCE CHECK-IN
            ================================================= */
            CASE

                /* ---------------------------------------------
                   HOLIDAY WITHOUT ATTENDANCE

                   Use the employee payroll configuration's working time
                --------------------------------------------- */
                WHEN h.work_date IS NOT NULL
                    AND COUNT(ats.id) = 0

                THEN
                    d.work_date + es.start_time

                /* ---------------------------------------------
                   ACTUAL ATTENDANCE
                --------------------------------------------- */
                ELSE
                    MIN(
                        ats.entry_at
                        AT TIME ZONE 'Asia/Kolkata'
                    )

            END AS first_in,

            /* =================================================
               ACTUAL ATTENDANCE CHECK-OUT
            ================================================= */
            CASE

                /* ---------------------------------------------
                   HOLIDAY WITHOUT ATTENDANCE

                   Use employment_details.shift_end_time
                --------------------------------------------- */
                WHEN h.work_date IS NOT NULL
                    AND COUNT(ats.id) = 0

                THEN
                    d.work_date + es.working_end_time

                /* ---------------------------------------------
                   ACTUAL ATTENDANCE
                --------------------------------------------- */

                ELSE
                    MAX(
                        ats.exit_at
                        AT TIME ZONE 'Asia/Kolkata'
                    )

            END AS last_out,

            /* =================================================
               ATTENDANCE EXISTS
            ================================================= */
            CASE
                WHEN COUNT(ats.id) > 0
                THEN true
                ELSE false
            END AS has_attendance,

            /* =================================================
               TOTAL MINUTES
               
               Holiday without attendance:
               working_start_time → shift_end_time
               
               Actual attendance:
               actual attendance duration
            ================================================= */
            CASE

                WHEN h.work_date IS NOT NULL
                     AND COUNT(ats.id) = 0

                THEN

                    GREATEST(

                        FLOOR(
                            EXTRACT(
                                EPOCH FROM (
                                    es.working_end_time -
                                    es.start_time
                                )
                            ) / 60.0
                        )::BIGINT,
                        0

                    )

                ELSE
                    COALESCE(
                        ROUND(
                            SUM(
                                EXTRACT(
                                    EPOCH FROM
                                    COALESCE(
                                        ats.duration,
                                        INTERVAL '0 second'
                                    )
                                )
                            ) / 60.0
                        )::BIGINT,

                        0
                    )
            END AS total_minutes,

            CASE
                WHEN h.work_date IS NOT NULL
                     AND COUNT(ats.id) = 0
                THEN 0
                ELSE GREATEST(
                    COALESCE(
                        FLOOR(
                            EXTRACT(
                                EPOCH FROM SUM(
                                    COALESCE(ats.duration, INTERVAL '0 second')
                                )
                            ) / 60
                        )::INT,
                        0
                    ) - COALESCE(
                        FLOOR(
                            EXTRACT(
                                EPOCH FROM (
                                    es.working_end_time - es.start_time
                                )
                            ) / 60.0
                        )::INT,
                        0
                    ),
                    0
                )
            END AS total_overtime_minutes,

            /* =================================================
               SESSIONS
            ================================================= */
            CASE

                /* =================================================
                   HOLIDAY WITHOUT ATTENDANCE
                ================================================= */
                WHEN h.work_date IS NOT NULL
                     AND COUNT(ats.id) = 0

                THEN

                    json_build_array(

                        json_build_object(

                            'check_in',
                            TO_CHAR(
                                es.start_time,
                                'HH24:MI:SS'
                            ),

                            'check_out',
                            TO_CHAR(
                                es.working_end_time,
                                'HH24:MI:SS'
                            ),

                            'status',
                            'Holiday',

                            'total_hours',

                            CONCAT(

                                FLOOR(
                                    EXTRACT(
                                        EPOCH FROM (
                                            es.working_end_time -
                                            es.start_time
                                        )
                                    ) / 3600
                                )::BIGINT,

                                ':',

                                LPAD(

                                    (
                                        FLOOR(
                                            EXTRACT(
                                                EPOCH FROM (
                                                    es.working_end_time -
                                                    es.start_time
                                                )
                                            ) / 60
                                        )::BIGINT % 60
                                    )::TEXT,

                                    2,

                                    '0'
                                ),

                                ':00'
                            ),

                            'total_minutes',

                            GREATEST(

                                FLOOR(
                                    EXTRACT(
                                        EPOCH FROM (
                                            es.working_end_time -
                                            es.start_time
                                        )
                                    ) / 60.0
                                )::BIGINT,

                                0

                            )

                        )

                    )

                /* =================================================
                   ACTUAL ATTENDANCE
                ================================================= */
                ELSE
                    COALESCE(

                        json_agg(

                            json_build_object(

                                'check_in',

                                TO_CHAR(
                                    ats.entry_at
                                        AT TIME ZONE 'Asia/Kolkata',
                                    'HH24:MI:SS'
                                ),

                                'check_out',

                                CASE

                                    WHEN ats.exit_at IS NULL

                                    THEN NULL

                                    ELSE

                                        TO_CHAR(
                                            ats.exit_at
                                                AT TIME ZONE 'Asia/Kolkata',
                                            'HH24:MI:SS'
                                        )

                                END,

                                'status',
                                ats.status,

                                'total_hours',

                                CONCAT(

                                    FLOOR(
                                        EXTRACT(
                                            EPOCH FROM
                                            COALESCE(
                                                ats.duration,
                                                INTERVAL '0 second'
                                            )
                                        ) / 3600
                                    )::BIGINT,

                                    ':',

                                    LPAD(

                                        (
                                            FLOOR(
                                                EXTRACT(
                                                    EPOCH FROM
                                                    COALESCE(
                                                        ats.duration,
                                                        INTERVAL '0 second'
                                                    )
                                                ) / 60
                                            )::BIGINT % 60
                                        )::TEXT,

                                        2,

                                        '0'
                                    ),

                                    ':',

                                    LPAD(

                                        (
                                            FLOOR(
                                                EXTRACT(
                                                    EPOCH FROM
                                                    COALESCE(
                                                        ats.duration,
                                                        INTERVAL '0 second'
                                                    )
                                                )
                                            )::BIGINT % 60
                                        )::TEXT,

                                        2,

                                        '0'
                                    )

                                ),

                                'total_minutes',

                                COALESCE(

                                    ROUND(
                                        EXTRACT(
                                            EPOCH FROM
                                            COALESCE(
                                                ats.duration,
                                                INTERVAL '0 second'
                                            )
                                        ) / 60
                                    ),

                                    0

                                )::BIGINT

                            )

                            ORDER BY ats.entry_at

                        ),

                        '[]'::json

                    )

            END AS sessions

        FROM all_dates d

        CROSS JOIN employee_shift es

        LEFT JOIN holiday_dates h
            ON h.work_date =
               d.work_date

        LEFT JOIN attendance_sessions ats

            ON LOWER(
                TRIM(ats.username)
            ) = LOWER(
                TRIM($1)
            )

            AND LOWER(
                ats.status
            ) IN (
                'completed',
                'expired'
            )

            AND (
                ats.entry_at
                AT TIME ZONE 'Asia/Kolkata'
            )::date = d.work_date

        WHERE d.work_date <= LEAST(
            (
                MAKE_DATE($3::INT, $2::INT, 1)
                + INTERVAL '1 month'
                - INTERVAL '1 day'
            )::DATE,
            (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::DATE
        )

        GROUP BY
            d.work_date,
            h.work_date,
            h.holiday_name,
            es.username,
            es.start_time,
            es.working_end_time
        ORDER BY
            d.work_date;
    `;

    const { rows } = await pool.query(
        query,
        [
            username,
            selectedMonth,
            selectedYear,
            locationId
        ]
    );

    return rows;
};