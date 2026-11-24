import { pool } from "../../../database.js";

export const initializeHolidaysTable = async () => {
    const query = `
        CREATE TABLE IF NOT EXISTS holidays (
            id SERIAL PRIMARY KEY,
            holiday_name VARCHAR(255) NOT NULL,
            holiday_date DATE NOT NULL,
            transfer_date DATE,
            locations TEXT[] DEFAULT ARRAY[]::TEXT[],
            created_by VARCHAR(255),
            created_at TIMESTAMP DEFAULT TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP),
            updated_at TIMESTAMP DEFAULT TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
        );
    `;

    await pool.query(query);

    /* ================= FIX WORK LOCATION ================= */
    const updateQuery = `
        UPDATE holidays ho
        SET locations = ARRAY(
            SELECT wl.id::TEXT
            FROM work_location wl
            WHERE TRIM(UPPER(wl.location::TEXT)) = ANY(
                SELECT TRIM(UPPER(location_name))
                FROM unnest(ho.locations) AS location_name
            )
        )
        WHERE EXISTS (
            SELECT 1
            FROM work_location wl
            WHERE TRIM(UPPER(wl.location::TEXT)) = ANY(
                SELECT TRIM(UPPER(location_name))
                FROM unnest(ho.locations) AS location_name
            )
        );
    `;

    await pool.query(updateQuery);

    await pool.query(`
        SELECT setval(
            pg_get_serial_sequence('holidays', 'id'),
            COALESCE((SELECT MAX(id) FROM holidays), 1),
            true
        );
    `);

    console.log("✅ holidays Table Ready");
};

/* =========================================================
   CONVERT WORK LOCATION NAMES TO IDS
========================================================= */
const getWorkLocationIds = async (locations = []) => {
    if (!Array.isArray(locations) || locations.length === 0) {
        return [];
    }

    const cleanLocations = locations
        .map(location => String(location).trim())
        .filter(Boolean);

    if (cleanLocations.length === 0) {
        return [];
    }

    const query = `
        SELECT
            id,
            location
        FROM work_location
        WHERE LOWER(TRIM(location::TEXT))
            = ANY(
                $1::TEXT[]
            )
    `;

    const values = [
        cleanLocations.map(location =>
            location.toLowerCase()
        )
    ];

    const { rows } = await pool.query(query, values);

    /* ================= CHECK INVALID LOCATIONS ================= */
    const foundLocations = new Set(
        rows.map(row =>
            String(row.location).trim().toLowerCase()
        )
    );

    const invalidLocations = cleanLocations.filter(
        location => !foundLocations.has(location.toLowerCase())
    );

    if (invalidLocations.length > 0) {
        throw new Error(
            `Work location not found: ${invalidLocations.join(", ")}`
        );
    }

    /* ================= RETURN IDS ================= */
    return cleanLocations.map(location => {

        const matched = rows.find(
            row =>
                String(row.location)
                    .trim()
                    .toLowerCase() ===
                location.toLowerCase()
        );

        return String(matched.id);
    });
};

/* ================= CREATE HOLIDAY ================= */
export const createHolidayModel = async (data) => {

    /* ================= LOCATION NAME → ID ================= */
    const locationIds = await getWorkLocationIds(
        data.locations
    );

    const query = `
        INSERT INTO holidays (
            holiday_name,
            holiday_date,
            transfer_date,
            locations,
            created_by
        )
        VALUES ($1, $2, $3, $4, $5)
        RETURNING
            id,
            holiday_name,
            holiday_date::text AS holiday_date,
            transfer_date::text AS transfer_date,
            locations,
            created_by,
            created_at,
            updated_at;
    `;

    const values = [
        data.holiday_name,
        data.holiday_date,
        data.transfer_date || null,
        locationIds,
        data.created_by || null
    ];

    const { rows } = await pool.query(query, values);

    return rows[0];
};

/* ================= GET ALL HOLIDAYS ================= */
export const getAllHolidaysModel = async () => {
    const query = `
        SELECT
            h.id,
            h.holiday_name,
            h.holiday_date::text AS holiday_date,
            h.transfer_date::text AS transfer_date,
            h.locations,

            ARRAY_REMOVE(
                ARRAY_AGG(DISTINCT wl.id),
                NULL
            ) AS location_ids,

            h.created_by,
            h.created_at,
            h.updated_at

        FROM holidays h

        LEFT JOIN work_location wl
            ON wl.location = ANY(h.locations)

        GROUP BY
            h.id

        ORDER BY h.holiday_date ASC;
    `;

    const { rows } = await pool.query(query);
    return rows;
};

/* ================= GET HOLIDAYS BY MONTH ================= */
export const getHolidaysByMonthModel = async (
    year,
    month,
    work_location = null,
    department = null
) => {

    const values = [
        Number(year),
        Number(month)
    ];

    let count = 3;

    let query = `
        SELECT
            h.id,
            h.holiday_name,

            TO_CHAR(
                h.holiday_date,
                'YYYY-MM-DD'
            ) AS holiday_date,

            TO_CHAR(
                h.transfer_date,
                'YYYY-MM-DD'
            ) AS transfer_date,

            h.locations,

            /* ================= LOCATION IDS ================= */
            ARRAY_REMOVE(
                ARRAY_AGG(
                    DISTINCT wl.id
                    ORDER BY wl.id
                ),
                NULL
            ) AS location_ids,

            /* ================= LOCATION NAMES ================= */
            ARRAY_REMOVE(
                ARRAY_AGG(
                    DISTINCT wl.location
                    ORDER BY wl.location
                ),
                NULL
            ) AS location_names

        FROM holidays h

        LEFT JOIN work_location wl
            ON wl.id::TEXT = ANY(h.locations)

        WHERE
        (
            (
                EXTRACT(
                    YEAR FROM h.holiday_date
                ) = $1

                AND

                EXTRACT(
                    MONTH FROM h.holiday_date
                ) = $2
            )

            OR

            (
                h.transfer_date IS NOT NULL

                AND

                EXTRACT(
                    YEAR FROM h.transfer_date
                ) = $1

                AND

                EXTRACT(
                    MONTH FROM h.transfer_date
                ) = $2
            )
        )
    `;

    /* =========================================================
       WORK LOCATION FILTER
    ========================================================= */
    if (
        work_location !== null &&
        work_location !== undefined &&
        String(work_location).trim() !== "" &&
        String(work_location).trim().toLowerCase() !== "nan"
    ) {

        const locationName =
            String(work_location).trim();

        query += `
            AND EXISTS (
                SELECT 1
                FROM work_location wl_filter

                WHERE
                    LOWER(
                        TRIM(
                            wl_filter.location::TEXT
                        )
                    )
                    =
                    LOWER(
                        TRIM(
                            $${count}::TEXT
                        )
                    )

                    AND

                    wl_filter.id::TEXT =
                        ANY(h.locations)
            )
        `;

        values.push(locationName);
        count++;
    }

    /* =========================================================
        DEPARTMENT FILTER
        Holiday is location-based, so verify that the selected
        department has employees at the holiday location.
    ========================================================= */

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
                AND EXISTS (
                    SELECT 1
                    FROM employment_details ed_filter
                    WHERE ed_filter.department = $${count}
                      AND ed_filter.work_location = ANY(
                          SELECT wl_filter.id
                          FROM work_location wl_filter
                          WHERE wl_filter.id::TEXT = ANY(h.locations)
                      )
                )
            `;

            values.push(departmentId);
            count++;

        } else {
            query += `
                AND EXISTS (
                    SELECT 1
                    FROM employment_details ed_filter
                    INNER JOIN department_structure ds_filter
                        ON ds_filter.id = ed_filter.department
                    WHERE LOWER(TRIM(ds_filter.name::TEXT))
                        = LOWER(TRIM($${count}::TEXT))
                      AND ed_filter.work_location = ANY(
                          SELECT wl_filter.id
                          FROM work_location wl_filter
                          WHERE wl_filter.id::TEXT = ANY(h.locations)
                      )
                )
            `;

            values.push(departmentValue);
            count++;
        }
    }

    query += `
        GROUP BY
            h.id

        ORDER BY
            COALESCE(
                h.transfer_date,
                h.holiday_date
            );
    `;

    const { rows } = await pool.query(
        query,
        values
    );

    return rows;
};

/* ================= GET HOLIDAYS BY YEAR ================= */
export const getHolidaysByYearModel = async (year) => {

    const query = `
        SELECT
            id,
            holiday_name,
            holiday_date,
            locations
        FROM holidays
        WHERE EXTRACT(YEAR FROM holiday_date)::INT=$1
        ORDER BY holiday_date
    `;


    const { rows } = await pool.query(
        query,
        [year]
    );


    return rows;
};

/* ================= CHECK DUPLICATE HOLIDAY ================= */
export const checkDuplicateHolidayModel = async ({
    id,
    holiday_name,
    holiday_date,
    locations = []
}) => {

    const locationIds = await getWorkLocationIds(locations);
    const holidayId =
        id === null || id === undefined || String(id).trim() === ""
            ? null
            : Number(id);

    if (
        holidayId !== null &&
        (!Number.isInteger(holidayId) || holidayId < 1)
    ) {
        throw new Error("Holiday id must be a positive integer");
    }

    const query = `
        SELECT
            id,
            holiday_name,
            holiday_date::text AS holiday_date,
            locations
        FROM holidays
        WHERE
            LOWER(TRIM(holiday_name)) =
                LOWER(TRIM($1))

            AND holiday_date = $2::date

            /* EXCLUDE CURRENT HOLIDAY */
            AND ($4::INTEGER IS NULL OR id <> $4::INTEGER)

            AND (
                $3::TEXT[] = '{}'::TEXT[]
                OR EXISTS (
                    SELECT 1
                    FROM unnest(locations) AS existing_location
                    WHERE existing_location = ANY($3::TEXT[])
                )
            )

        LIMIT 1;
    `;

    const { rows } = await pool.query(query, [
        holiday_name,
        holiday_date,
        locationIds,
        holidayId
    ]);

    return rows[0] || null;
};

/* ================= GET TOTAL EMPLOYEES ================= */
export const getEmployeeCountByDateModel = async (
    year,
    month,
    work_location = null,
    shift_name = null,
    shift_type = null,
    username = null,
    department = null
) => {

    const selectedYear = Number(year);
    const selectedMonth = Number(month);

    const startDate = `${selectedYear}-${String(selectedMonth).padStart(2, "0")}-01`;

    const daysInMonth =
        new Date(
            selectedYear,
            selectedMonth,
            0
        ).getDate();

    const endDate = `${selectedYear}-${String(selectedMonth).padStart(2, "0")}-${String(daysInMonth).padStart(2, "0")}`;

    const values = [
        startDate,
        endDate
    ];

    let count = 3;

    let query = `
        WITH calendar_days AS (

            SELECT generate_series(
                $1::date,
                $2::date,
                interval '1 day'
            )::date AS calendar_date
        )

        SELECT

            cd.calendar_date::text AS attendance_date,

            COUNT(DISTINCT pd.id)::INT
                AS total_employees,

            ARRAY_AGG(
                DISTINCT pd.username
                ORDER BY pd.username
            ) FILTER (
                WHERE pd.username IS NOT NULL
            ) AS usernames

        FROM calendar_days cd

        CROSS JOIN personal_details pd

        INNER JOIN employment_details ed
            ON ed.personal_details_id = pd.id

        LEFT JOIN master_employee me
            ON me.personal_details_id = pd.id

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

        LEFT JOIN department_structure ds
            ON ds.id = ed.department

        WHERE
            ed.show_in_attendance = TRUE

            AND (

                LOWER(TRIM(me.status::TEXT))
                    = 'active'

                OR (

                    LOWER(TRIM(me.status::TEXT))
                        = 'inactive'

                    AND LOWER(
                        TRIM(ie.past_status::TEXT)
                    ) = 'active'

                    AND (
                        ie.inactive_date IS NULL

                        OR cd.calendar_date <=
                           ie.inactive_date::date
                    )
                )
            )

            AND ed.date_of_joining <=
                cd.calendar_date
    `;

    /* ================= WORK LOCATION ================= */
    if (
        work_location !== null &&
        work_location !== undefined &&
        String(work_location).trim() !== "" &&
        String(work_location).trim().toLowerCase() !== "nan"
    ) {

        const locationName =
            String(work_location).trim();

        query += `
            AND LOWER(TRIM(wl.location::TEXT))
                =
                LOWER(TRIM($${count}::TEXT))
        `;

        values.push(locationName);
        count++;
    }

    /* ================= DEPARTMENT FILTER ================= */
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

    /* ================= SHIFT NAME ================= */
    if (
        shift_name !== null &&
        shift_name !== undefined &&
        String(shift_name).trim() !== "" &&
        String(shift_name).trim().toLowerCase() !== "all"
    ) {

        query += `
            AND LOWER(TRIM(sc.shift_name::TEXT))
                =
                LOWER(TRIM($${count}::TEXT))
        `;

        values.push(
            String(shift_name).trim()
        );

        count++;
    }

    /* ================= SHIFT TYPE ================= */
    if (
        shift_type !== null &&
        shift_type !== undefined &&
        String(shift_type).trim() !== "" &&
        String(shift_type).trim().toLowerCase() !== "all"
    ) {

        query += `
            AND LOWER(TRIM(sc.shift_type::TEXT))
                =
                LOWER(TRIM($${count}::TEXT))
        `;

        values.push(
            String(shift_type).trim()
        );

        count++;
    }

    /* ================= USERNAME FILTER ================= */
    if (
        username !== null &&
        username !== undefined &&
        String(username).trim() !== "" &&
        String(username).trim().toLowerCase() !== "all"
    ) {
        query += `
            AND LOWER(TRIM(pd.username))
                = LOWER(TRIM($${count}))
        `;
        values.push(
            String(username).trim()
        );

        count++;
    }

    query += `
        GROUP BY
            cd.calendar_date

        ORDER BY
            cd.calendar_date
    `;

    const { rows } =
        await pool.query(
            query,
            values
        );

    return rows;
};

/* ================= GET ATTENDANCE COUNT BY MONTH ================= */
export const getAttendanceCountByDayModel = async (
    year,
    month,
    work_location = null,
    shift_name = null,
    shift_type = null,
    username = null,
    department = null
) => {

    const values = [Number(year), Number(month)];
    let count = 3;

    let query = `
        SELECT
            EXTRACT(
                DAY FROM (
                    ats.entry_at AT TIME ZONE 'Asia/Kolkata'
                )
            )::INT AS day,

            COUNT(DISTINCT LOWER(TRIM(ats.username)))::INT
                AS total_present

        FROM attendance_sessions ats

        INNER JOIN personal_details pd
            ON LOWER(TRIM(pd.username))
             = LOWER(TRIM(ats.username))

        INNER JOIN employment_details ed
            ON ed.personal_details_id = pd.id

        INNER JOIN master_employee me
            ON me.personal_details_id = pd.id

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

        LEFT JOIN department_structure ds
            ON ds.id = ed.department

        WHERE

            EXTRACT(
                YEAR FROM (
                    ats.entry_at AT TIME ZONE 'Asia/Kolkata'
                )
            ) = $1

            AND EXTRACT(
                MONTH FROM (
                    ats.entry_at AT TIME ZONE 'Asia/Kolkata'
                )
            ) = $2

            /* ================= ATTENDANCE ELIGIBILITY ================= */
            AND ed.show_in_attendance = TRUE

            /* ================= EMPLOYEE STATUS ================= */

            AND (
                LOWER(TRIM(me.status::TEXT)) = 'active'

                OR (
                    LOWER(TRIM(me.status::TEXT)) = 'inactive'

                    AND LOWER(TRIM(ie.past_status::TEXT)) = 'active'

                    AND (
                        ie.inactive_date IS NULL
                        OR (
                            ats.entry_at
                            AT TIME ZONE 'Asia/Kolkata'
                        )::date <= ie.inactive_date::date
                    )
                )
            )
    `;

    /* =========================================================
       WORK LOCATION FILTER
       Example: EMBLEPCB
    ========================================================= */

    if (
        work_location !== null &&
        work_location !== undefined &&
        String(work_location).trim() !== "" &&
        String(work_location).trim().toLowerCase() !== "nan"
    ) {

        const locationName = String(work_location).trim();

        query += `
            AND LOWER(TRIM(wl.location::TEXT))
                = LOWER(TRIM($${count}::TEXT))
        `;

        values.push(locationName);
        count++;
    }

    /* ================= DEPARTMENT FILTER ================= */

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

    /* ================= SHIFT NAME ================= */

    if (
        shift_name !== null &&
        shift_name !== undefined &&
        String(shift_name).trim() !== "" &&
        String(shift_name).trim().toLowerCase() !== "all"
    ) {

        query += `
            AND LOWER(TRIM(sc.shift_name::TEXT))
                = LOWER(TRIM($${count}::TEXT))
        `;

        values.push(String(shift_name).trim());
        count++;
    }

    /* =========================================================
       SHIFT TYPE FILTER
    ========================================================= */

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

    /* ================= USERNAME FILTER ================= */

    if (
        username !== null &&
        username !== undefined &&
        String(username).trim() !== "" &&
        String(username).trim().toLowerCase() !== "all"
    ) {
        query += `
        AND LOWER(TRIM(ats.username))
            = LOWER(TRIM($${count}))
    `;

        values.push(
            String(username).trim()
        );

        count++;
    }

    query += `
        GROUP BY
            EXTRACT(
                DAY FROM (
                    ats.entry_at AT TIME ZONE 'Asia/Kolkata'
                )
            )

        ORDER BY
            day
    `;

    const { rows } = await pool.query(query, values);

    return rows;
};

/* ================= GET SHIFT DAYS ================= */
export const getShiftDaysModel = async (shift_name = null) => {
    if (
        !shift_name ||
        String(shift_name).trim() === "" ||
        String(shift_name).trim().toLowerCase() === "all"
    ) {
        return null;
    }

    const query = `
        SELECT
            id,
            shift_name,
            days
        FROM shift_configurations
        WHERE LOWER(TRIM(shift_name))
            = LOWER(TRIM($1))
        LIMIT 1
    `;

    const { rows } = await pool.query(query, [
        String(shift_name).trim()
    ]);

    return rows[0] || null;
};

export const getLeaveCountByDayModel = async (
    year,
    month,
    work_location = null
) => {
    const values = [year, month];
    let count = 3;

    let query = `
        WITH leave_days AS (
            SELECT
                el.username,
                leave_day::date AS calendar_date,
                ed.work_location

            FROM employee_leaves el

            INNER JOIN personal_details pd
                ON pd.username = el.username

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

            LEFT JOIN shift_configurations sc
                ON sc.id = ed.shift_id

            CROSS JOIN LATERAL generate_series(
                GREATEST(
                    el.start_leave_date::date,
                    MAKE_DATE($1::int, $2::int, 1)
                ),
                LEAST(
                    el.end_leave_date::date,
                    (MAKE_DATE($1::int, $2::int, 1)
                        + INTERVAL '1 month' - INTERVAL '1 day')::date
                ),
                INTERVAL '1 day'
            ) AS leave_dates(leave_day)

            WHERE ed.show_in_attendance = TRUE
              AND LOWER(TRIM(me.status)) = 'active'
              AND el.start_leave_date::date <=
                    (MAKE_DATE($1::int, $2::int, 1)
                        + INTERVAL '1 month' - INTERVAL '1 day')::date
              AND el.end_leave_date::date >= MAKE_DATE($1::int, $2::int, 1)
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
        )

        SELECT
            EXTRACT(DAY FROM calendar_date)::INT AS day,
            COUNT(DISTINCT username) AS total_leave

        FROM leave_days
    `;

    if (work_location) {
        query += ` AND work_location = $${count}`;
        values.push(work_location);
        count++;
    }

    query += `
        GROUP BY day
        ORDER BY day
    `;

    const { rows } = await pool.query(query, values);

    return rows;
};

/* ================= GET HOLIDAY BY ID ================= */
export const getHolidayByIdModel = async (id) => {
    const query = `
        SELECT
            h.id,
            h.holiday_name,
            h.holiday_date::text AS holiday_date,
            h.transfer_date::text AS transfer_date,
            h.locations,

            ARRAY_REMOVE(
                ARRAY_AGG(DISTINCT wl.id),
                NULL
            ) AS location_ids,

            h.created_by,
            h.created_at,
            h.updated_at

        FROM holidays h

        LEFT JOIN work_location wl
            ON wl.location = ANY(h.locations)

        WHERE h.id = $1

        GROUP BY h.id;
    `;

    const { rows } = await pool.query(query, [id]);
    return rows[0];
};

/* ================= GET HOLIDAY BY USERNAME ================= */
export const getHolidayByUsernameModel = async (username) => {
    const query = `
        SELECT DISTINCT
            h.id,
            h.holiday_name,
            h.holiday_date::text AS holiday_date,
            h.transfer_date::text AS transfer_date,
            h.locations,

            ed.work_location,
            wl.id AS location_id,
            wl.location AS work_location,

            h.created_by,
            h.created_at,
            h.updated_at

        FROM holidays h

        INNER JOIN employment_details ed
            ON ed.work_location::TEXT = ANY(h.locations)

        INNER JOIN work_location wl
            ON wl.id = ed.work_location

        INNER JOIN personal_details pd
            ON pd.id = ed.personal_details_id

        WHERE LOWER(TRIM(pd.username))
            = LOWER(TRIM($1))

        ORDER BY holiday_date ASC;
    `;

    const { rows } = await pool.query(query, [
        String(username).trim()
    ]);

    return rows;
};

export const getUpcomingHolidaysModel = async ({
    work_location = null
} = {}) => {

    const values = [];
    let count = 1;

    let query = `
        SELECT
            h.id,
            h.holiday_name,

            TO_CHAR(
                h.holiday_date,
                'YYYY-MM-DD'
            ) AS holiday_date,

            TO_CHAR(
                h.transfer_date,
                'YYYY-MM-DD'
            ) AS transfer_date,

            CASE
                WHEN h.transfer_date IS NOT NULL
                     AND h.transfer_date::date >
                         (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date
                     AND h.transfer_date::date <=
                         (
                             (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date
                             + INTERVAL '10 days'
                         )
                THEN TO_CHAR(h.transfer_date, 'YYYY-MM-DD')
                ELSE TO_CHAR(h.holiday_date, 'YYYY-MM-DD')
            END AS display_date,

            CASE
                WHEN h.transfer_date IS NOT NULL
                     AND h.transfer_date::date >
                         (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date
                     AND h.transfer_date::date <=
                         (
                             (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date
                             + INTERVAL '10 days'
                         )
                THEN TO_CHAR(h.holiday_date, 'YYYY-MM-DD')
                ELSE NULL
            END AS display_transfer_from,

            ARRAY(
                SELECT wl.location
                FROM work_location wl
                WHERE wl.id::TEXT = ANY(
                    COALESCE(h.locations, ARRAY[]::TEXT[])
                )
                ORDER BY wl.location
            ) AS locations

        FROM holidays h

        WHERE
            (
                /* ================= ORIGINAL HOLIDAY ================= */

                (
                    h.holiday_date::date >
                    (
                        CURRENT_TIMESTAMP
                        AT TIME ZONE 'Asia/Kolkata'
                    )::date

                    AND h.holiday_date::date <=
                    (
                        (
                            CURRENT_TIMESTAMP
                            AT TIME ZONE 'Asia/Kolkata'
                        )::date + INTERVAL '10 days'
                    )
                )

                OR

                /* ================= TRANSFER HOLIDAY ================= */

                (
                    h.transfer_date IS NOT NULL

                    AND h.transfer_date::date >
                    (
                        CURRENT_TIMESTAMP
                        AT TIME ZONE 'Asia/Kolkata'
                    )::date

                    AND h.transfer_date::date <=
                    (
                        (
                            CURRENT_TIMESTAMP
                            AT TIME ZONE 'Asia/Kolkata'
                        )::date + INTERVAL '10 days'
                    )
                )
            )
    `;

    /* =====================================================
       WORK LOCATION FILTER
    ===================================================== */

    if (
        work_location !== null &&
        work_location !== undefined &&
        String(work_location).trim() !== "" &&
        String(work_location).trim().toLowerCase() !== "all" &&
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
                AND $${count}::TEXT = ANY(
                    COALESCE(h.locations, ARRAY[]::TEXT[])
                )
            `;

            values.push(
                String(locationId)
            );

            count++;

        } else {

            query += `
                AND EXISTS (
                    SELECT 1
                    FROM work_location wl
                    WHERE
                        wl.id::TEXT = ANY(
                            COALESCE(
                                h.locations,
                                ARRAY[]::TEXT[]
                            )
                        )
                        AND LOWER(TRIM(wl.location))
                            = LOWER(TRIM($${count}))
                )
            `;

            values.push(locationValue);

            count++;
        }
    }

    /* =====================================================
       ORDER
    ===================================================== */

    query += `
        ORDER BY
            LEAST(
                CASE
                    WHEN h.holiday_date::date >
                    (
                        CURRENT_TIMESTAMP
                        AT TIME ZONE 'Asia/Kolkata'
                    )::date
                    THEN h.holiday_date::date
                    ELSE NULL
                END,

                CASE
                    WHEN h.transfer_date IS NOT NULL
                         AND h.transfer_date::date >
                         (
                             CURRENT_TIMESTAMP
                             AT TIME ZONE 'Asia/Kolkata'
                         )::date
                    THEN h.transfer_date::date
                    ELSE NULL
                END
            ) ASC,

            h.id ASC
    `;

    const {
        rows
    } = await pool.query(
        query,
        values
    );

    return rows;
};

/* ================= UPDATE HOLIDAYS ================= */
export const updateHolidayModel = async (id, data) => {

    const locationIds =
        data.locations !== undefined &&
            data.locations !== null
            ? await getWorkLocationIds(data.locations)
            : null;

    const query = `
        UPDATE holidays
        SET
            holiday_name = COALESCE($1, holiday_name),
            holiday_date = COALESCE($2::DATE, holiday_date),
            transfer_date = COALESCE($3::DATE, transfer_date),
            locations = COALESCE($4, locations),
            created_by = COALESCE($5, created_by),
            updated_at = TIMEZONE(
                'Asia/Kolkata',
                CURRENT_TIMESTAMP
            )
        WHERE id = $6

        RETURNING
            id,
            holiday_name,
            TO_CHAR(holiday_date, 'YYYY-MM-DD') AS holiday_date,
            TO_CHAR(transfer_date, 'YYYY-MM-DD') AS transfer_date,
            locations,
            created_by,
            created_at,
            updated_at;
    `;

    const values = [
        data.holiday_name ?? null,
        data.holiday_date ?? null,
        data.transfer_date ?? null,
        locationIds,
        data.created_by ?? null,
        id
    ];

    const { rows } = await pool.query(query, values);

    return rows[0];
};

/* ================= DELETE HOLIDAYS ================= */
export const deleteHolidayModel = async (id) => {
    const query = `
        DELETE FROM holidays
        WHERE id = $1
        RETURNING *;
    `;

    const { rows } = await pool.query(query, [id]);
    return rows[0];
};

/* ================= TRANSFER HOLIDAY ================= */
export const transferHolidayModel = async (id, transfer_date, updated_by) => {
    const query = `
        UPDATE holidays
        SET
            holiday_date = $1,
            created_by = COALESCE($2, created_by),
            updated_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
        WHERE id = $3
        RETURNING
            id,
            holiday_name,
            holiday_date::text AS holiday_date,
            locations,
            created_by,
            created_at,
            updated_at;
    `;

    const { rows } = await pool.query(query, [
        transfer_date,
        updated_by || null,
        id
    ]);

    return rows[0];
};
