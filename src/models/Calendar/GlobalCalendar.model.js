import { pool } from "../../database.js";

/* =========================================================
   NORMALIZE USERNAMES
========================================================= */

const normalizeUsernames = (username = []) => {
    if (!Array.isArray(username)) {
        username = [username];
    }

    return [
        ...new Set(
            username
                .map(item => String(item).trim())
                .filter(Boolean)
                .map(item => item.toLowerCase())
        )
    ];
};


/* =========================================================
   NORMALIZE TYPES
========================================================= */

const normalizeTypes = (types = []) => {
    if (!Array.isArray(types)) {
        types = [types];
    }

    return [
        ...new Set(
            types
                .map(type => String(type).trim().toLowerCase())
                .filter(Boolean)
        )
    ];
};


/* =========================================================
   NORMALIZE WORK LOCATIONS
   Supports:
   2
   "2"
   "ACDC TECH"
   ["2", "3"]
   ["ACDC TECH", "EMBLE PCB"]
========================================================= */

const normalizeWorkLocations = (work_location = []) => {

    if (!Array.isArray(work_location)) {
        work_location = [work_location];
    }

    return [
        ...new Set(
            work_location
                .flatMap(item =>
                    String(item)
                        .split(",")
                        .map(value => value.trim())
                )
                .filter(Boolean)
                .filter(
                    value =>
                        value.toLowerCase() !== "all" &&
                        value.toLowerCase() !== "nan"
                )
        )
    ];
};


/* =========================================================
   RESOLVE WORK LOCATION IDs
   Accepts both ID and location name
========================================================= */

const resolveWorkLocationFilter = async (work_location = []) => {

    const normalized = normalizeWorkLocations(work_location);

    if (normalized.length === 0) {
        return [];
    }

    const ids = [];
    const names = [];

    for (const value of normalized) {

        const numericValue = Number(value);

        if (
            Number.isInteger(numericValue) &&
            numericValue > 0
        ) {
            ids.push(numericValue);
        } else {
            names.push(value);
        }
    }

    /* -----------------------------------------------------
       FIND LOCATION IDs FROM NAMES
    ----------------------------------------------------- */

    if (names.length > 0) {

        const locationResult = await pool.query(
            `
                SELECT id
                FROM work_location
                WHERE LOWER(TRIM(location)) = ANY($1::text[])
            `,
            [
                names.map(name =>
                    name.toLowerCase()
                )
            ]
        );

        ids.push(
            ...locationResult.rows.map(row =>
                Number(row.id)
            )
        );
    }

    return [
        ...new Set(
            ids.filter(
                id =>
                    Number.isInteger(id) &&
                    id > 0
            )
        )
    ];
};


/* =========================================================
   RESOLVE DEPARTMENT IDs
   Accepts both ID and department name
========================================================= */

const resolveDepartmentFilter = async (department = []) => {
    if (!Array.isArray(department)) {
        department = [department];
    }

    const normalized = [
        ...new Set(
            department
                .flatMap(item =>
                    String(item)
                        .split(",")
                        .map(value => value.trim())
                )
                .filter(Boolean)
                .filter(
                    value =>
                        value.toLowerCase() !== "all" &&
                        value.toLowerCase() !== "nan"
                )
        )
    ];

    if (normalized.length === 0) {
        return [];
    }

    const ids = [];
    const names = [];

    for (const value of normalized) {
        const numericValue = Number(value);

        if (
            Number.isInteger(numericValue) &&
            numericValue > 0 &&
            String(numericValue) === value
        ) {
            ids.push(numericValue);
        } else {
            names.push(value);
        }
    }

    if (names.length > 0) {
        const departmentResult = await pool.query(
            `
                SELECT id
                FROM department_structure
                WHERE LOWER(TRIM(name)) = ANY($1::text[])
            `,
            [names.map(name => name.toLowerCase())]
        );

        ids.push(
            ...departmentResult.rows.map(row => Number(row.id))
        );
    }

    return [
        ...new Set(
            ids.filter(
                id => Number.isInteger(id) && id > 0
            )
        )
    ];
};


/* =========================================================
   BUILD DYNAMIC FILTERS
========================================================= */

const buildFilters = ({
    params,
    conditions,
    username,
    workLocationIds,
    departmentIds = [],
    usernameColumn,
    workLocationColumn,
    departmentColumn = null
}) => {

    /* -----------------------------------------------------
       USERNAME FILTER
    ----------------------------------------------------- */

    if (username.length > 0) {

        params.push(username);

        conditions.push(
            `LOWER(TRIM(${usernameColumn})) = ANY($${params.length}::text[])`
        );
    }


    /* -----------------------------------------------------
       WORK LOCATION FILTER
    ----------------------------------------------------- */

    if (workLocationIds.length > 0) {

        params.push(workLocationIds);

        conditions.push(
            `${workLocationColumn} = ANY($${params.length}::integer[])`
        );
    }

    /* -----------------------------------------------------
       DEPARTMENT FILTER
    ----------------------------------------------------- */

    if (
        departmentIds.length > 0 &&
        departmentColumn
    ) {
        params.push(departmentIds);

        conditions.push(
            `${departmentColumn} = ANY($${params.length}::integer[])`
        );
    }
};

/* =========================================================
   DAILY ATTENDANCE COUNTS

   Employee will be counted date-wise only when:

   1. show_in_attendance = TRUE
   2. Employee was joined on or before that date
   3. Employee is active on that date
   4. If employee becomes inactive:
      inactive_date itself is included

   Example:

   joining_date = 15-05-2026
   inactive_date = 01-10-2026

   14-05-2026 -> NOT COUNT
   15-05-2026 -> COUNT
   ...
   30-09-2026 -> COUNT
   01-10-2026 -> COUNT
   02-10-2026 -> NOT COUNT

   Present = unique eligible employees having attendance
   Absent  = eligible employees - present
========================================================= */

const getDailyAttendanceCounts = async ({
    startDate,
    endDate,
    usernameFilter = [],
    workLocationIds = [],
    departmentIds = []
}) => {

    /* =====================================================
       1. GET EMPLOYEES + JOINING / INACTIVE DATE
    ===================================================== */

    const employeeParams = [];
    const employeeConditions = [];

    employeeConditions.push(`
        ed.show_in_attendance = TRUE
    `);


    /* -----------------------------------------------------
       USERNAME FILTER
    ----------------------------------------------------- */

    if (usernameFilter.length > 0) {

        employeeParams.push(usernameFilter);

        employeeConditions.push(`
            LOWER(TRIM(pd.username))
                = ANY($${employeeParams.length}::text[])
        `);
    }


    /* -----------------------------------------------------
       WORK LOCATION FILTER
    ----------------------------------------------------- */

    if (workLocationIds.length > 0) {

        employeeParams.push(workLocationIds);

        employeeConditions.push(`
            ed.work_location
                = ANY($${employeeParams.length}::integer[])
        `);
    }

    /* -----------------------------------------------------
       DEPARTMENT FILTER
    ----------------------------------------------------- */

    if (departmentIds.length > 0) {

        employeeParams.push(departmentIds);

        employeeConditions.push(`
            ed.department
                = ANY($${employeeParams.length}::integer[])
        `);
    }


    const employeeQuery = `
        SELECT DISTINCT
            LOWER(TRIM(pd.username)) AS username,
            pd.username AS username_raw,
            NULLIF(
                TRIM(
                    CONCAT_WS(
                        ' ',
                        NULLIF(TRIM(pd.first_name), ''),
                        NULLIF(TRIM(pd.middle_name), ''),
                        NULLIF(TRIM(pd.last_name), '')
                    )
                ),
                ''
            ) AS full_name,

            ed.date_of_joining::date::text AS joining_date,

            LOWER(TRIM(me.status)) AS employee_status,

            LOWER(
                TRIM(
                    COALESCE(ie.past_status, '')
                )
            ) AS past_status,

            ie.inactive_date::date::text AS inactive_date

        FROM personal_details pd

        INNER JOIN employment_details ed
            ON ed.personal_details_id = pd.id

        INNER JOIN master_employee me
            ON me.personal_details_id = pd.id

        LEFT JOIN inactive_employee ie
            ON LOWER(TRIM(ie.username))
                = LOWER(TRIM(pd.username))

        WHERE
            ${employeeConditions.join("\nAND ")}

        ORDER BY
            LOWER(TRIM(pd.username));
    `;


    const employeeResult = await pool.query(
        employeeQuery,
        employeeParams
    );


    /* =====================================================
       2. GET PRESENT EMPLOYEES PER DATE
    ===================================================== */

    const attendanceParams = [
        startDate,
        endDate
    ];

    const attendanceConditions = [

        `
        (a.entry_at AT TIME ZONE 'Asia/Kolkata')::date
            >= $1::date
        `,

        `
        (a.entry_at AT TIME ZONE 'Asia/Kolkata')::date
            < $2::date
        `
    ];


    /* -----------------------------------------------------
       USERNAME FILTER
    ----------------------------------------------------- */

    if (usernameFilter.length > 0) {

        attendanceParams.push(usernameFilter);

        attendanceConditions.push(`
            LOWER(TRIM(a.username))
                = ANY($${attendanceParams.length}::text[])
        `);
    }


    /* -----------------------------------------------------
       WORK LOCATION FILTER
    ----------------------------------------------------- */

    if (workLocationIds.length > 0) {

        attendanceParams.push(workLocationIds);

        attendanceConditions.push(`
            ed.work_location
                = ANY($${attendanceParams.length}::integer[])
        `);
    }

    if (departmentIds.length > 0) {

        attendanceParams.push(departmentIds);

        attendanceConditions.push(`
            ed.department
                = ANY($${attendanceParams.length}::integer[])
        `);
    }


    const attendanceQuery = `
        SELECT

            TO_CHAR(
                (
                    a.entry_at
                    AT TIME ZONE 'Asia/Kolkata'
                )::date,
                'YYYY-MM-DD'
            ) AS calendar_date,

            LOWER(TRIM(a.username)) AS username

        FROM attendance_sessions a

        INNER JOIN employment_details ed
            ON LOWER(TRIM(ed.username))
                = LOWER(TRIM(a.username))

        INNER JOIN personal_details pd
            ON LOWER(TRIM(pd.username))
                = LOWER(TRIM(a.username))

        WHERE
            ${attendanceConditions.join("\nAND ")}

        GROUP BY
            (
                a.entry_at
                AT TIME ZONE 'Asia/Kolkata'
            )::date,

            LOWER(TRIM(a.username))

        ORDER BY
            calendar_date,
            username;
    `;


    const attendanceResult = await pool.query(
        attendanceQuery,
        attendanceParams
    );


    /* =====================================================
       3. BUILD PRESENT MAP
    ===================================================== */

    const presentMap = {};


    for (const row of attendanceResult.rows) {

        const calendarDate =
            String(row.calendar_date).slice(0, 10);

        const username =
            String(row.username)
                .trim()
                .toLowerCase();


        if (!presentMap[calendarDate]) {
            presentMap[calendarDate] = new Set();
        }


        presentMap[calendarDate].add(username);
    }


    /* =====================================================
       4. BUILD DAILY COUNTS
    ===================================================== */

    const dailyCounts = {};

    const cursor =
        new Date(`${startDate}T00:00:00Z`);

    const endCursor =
        new Date(`${endDate}T00:00:00Z`);


    while (cursor < endCursor) {

        const calendarDate =
            cursor.toISOString().split("T")[0];


        /* =================================================
           GET EMPLOYEES ELIGIBLE ON THIS PARTICULAR DATE
        ================================================= */

        const eligibleEmployees =
            employeeResult.rows.filter(employee => {

                if (!employee.joining_date) {
                    return false;
                }


                const joiningDate =
                    String(employee.joining_date)
                        .slice(0, 10);


                /* -----------------------------------------
                   BEFORE JOINING DATE
                ----------------------------------------- */

                if (calendarDate < joiningDate) {
                    return false;
                }


                /* -----------------------------------------
                   INACTIVE EMPLOYEE
                   
                   inactive_date IS INCLUDED
                ----------------------------------------- */

                if (
                    employee.employee_status === "inactive" &&
                    employee.past_status === "active"
                ) {

                    if (!employee.inactive_date) {
                        return false;
                    }


                    const inactiveDate =
                        String(employee.inactive_date)
                            .slice(0, 10);


                    /*
                       IMPORTANT:

                       <= means inactive_date itself
                       is still counted.
                    */

                    return calendarDate <= inactiveDate;
                }


                /* -----------------------------------------
                   ACTIVE EMPLOYEE
                ----------------------------------------- */

                if (
                    employee.employee_status === "active"
                ) {
                    return true;
                }


                return false;
            });


        /* =================================================
           UNIQUE ELIGIBLE USERNAMES
        ================================================= */

        const eligibleUsernameSet =
            new Set(
                eligibleEmployees.map(employee =>
                    String(employee.username)
                        .trim()
                        .toLowerCase()
                )
            );


        const totalEmployees =
            eligibleUsernameSet.size;


        /* =================================================
           PRESENT
        ================================================= */

        const attendanceUsers =
            presentMap[calendarDate] || new Set();


        let present = 0;


        for (const username of attendanceUsers) {

            if (
                eligibleUsernameSet.has(username)
            ) {
                present++;
            }
        }


        /* =================================================
           ABSENT
        ================================================= */

        const absentUsers = [];

        for (const employee of eligibleEmployees) {
            const usernameKey = String(employee.username || "")
                .trim()
                .toLowerCase();

            if (!usernameKey || attendanceUsers.has(usernameKey)) {
                continue;
            }

            absentUsers.push({
                username: employee.username_raw || employee.username,
                full_name: employee.full_name || null
            });
        }

        const absent = absentUsers.length;


        /* =================================================
           SAVE DAILY COUNT
        ================================================= */

        dailyCounts[calendarDate] = {
            present,
            absent,
            absent_users: absentUsers
        };


        cursor.setUTCDate(
            cursor.getUTCDate() + 1
        );
    }


    return dailyCounts;
};

/* =========================================================
   GET GLOBAL CALENDAR - MONTHLY
========================================================= */

export const getGlobalCalendarModel = async ({
    year,
    month,
    username = [],
    types = [],
    work_location = [],
    department = []
} = {}) => {

    /* =====================================================
       VALIDATION
    ===================================================== */

    year = Number(year);
    month = Number(month);

    if (
        !Number.isInteger(year) ||
        year < 2000 ||
        year > 2100
    ) {
        throw new Error("Invalid year");
    }

    if (
        !Number.isInteger(month) ||
        month < 1 ||
        month > 12
    ) {
        throw new Error("Invalid month");
    }


    /* =====================================================
       NORMALIZE FILTERS
    ===================================================== */
    const usernameFilter = normalizeUsernames(username);
    const typeFilter = normalizeTypes(types);
    const workLocationIds = await resolveWorkLocationFilter(work_location);
    const departmentIds = await resolveDepartmentFilter(department);

    const allowedTypes = [
        "attendance",
        "leave",
        "meeting"
    ];

    const selectedTypes =
        typeFilter.length > 0
            ? typeFilter.filter(type =>
                allowedTypes.includes(type)
            )
            : allowedTypes;


    /* =====================================================
       DATE RANGE
    ===================================================== */

    const startDate =
        `${year}-${String(month).padStart(2, "0")}-01`;

    const endDateObj =
        new Date(
            Date.UTC(year, month, 1)
        );

    const endDate =
        `${endDateObj.getUTCFullYear()}-${String(
            endDateObj.getUTCMonth() + 1
        ).padStart(2, "0")}-01`;


    /* =====================================================
       EVENT MAP
    ===================================================== */

    const eventMap = {};


    const addEvent = (
        calendarDate,
        event
    ) => {

        if (!calendarDate) {
            return;
        }

        if (!eventMap[calendarDate]) {
            eventMap[calendarDate] = [];
        }

        eventMap[calendarDate].push(event);
    };


    /* =====================================================
       ATTENDANCE - DAILY PRESENT / ABSENT COUNT
    ===================================================== */

    if (selectedTypes.includes("attendance")) {

        const attendanceCounts =
            await getDailyAttendanceCounts({
                startDate,
                endDate,
                usernameFilter,
                workLocationIds,
                departmentIds
            });

        for (
            const [calendarDate, counts]
            of Object.entries(attendanceCounts)
        ) {

            addEvent(
                calendarDate,
                {
                    type: "attendance",
                    present: counts.present,
                    absent: counts.absent
                }
            );

            for (const absentUser of counts.absent_users || []) {
                addEvent(calendarDate, {
                    type: "attendance",
                    username: absentUser.username,
                    full_name: absentUser.full_name,
                    status: "absent",
                    entry_at: null,
                    exit_at: null
                });
            }
        }
    }


    /* =====================================================
       HOLIDAY
    ===================================================== */

    const holidayDateSet = new Set();

    {
        const holidayParams = [year, month];
        let holidayLocationSql = "";

        if (workLocationIds.length > 0) {
            holidayParams.push(workLocationIds);
            holidayLocationSql = `
                AND (
                    h.locations IS NULL
                    OR cardinality(h.locations) = 0
                    OR EXISTS (
                        SELECT 1
                        FROM unnest(
                            $${holidayParams.length}::INTEGER[]
                        ) AS wl_id(id)
                        WHERE wl_id.id::TEXT = ANY(h.locations)
                    )
                )
            `;
        }

        const holidayResult = await pool.query(
            `
            SELECT
                h.holiday_name AS name,
                TO_CHAR(h.holiday_date, 'YYYY-MM-DD')
                    AS holiday_date,
                TO_CHAR(h.transfer_date, 'YYYY-MM-DD')
                    AS transfer_date
            FROM holidays h
            WHERE (
                    EXTRACT(YEAR FROM h.holiday_date) = $1
                    AND EXTRACT(MONTH FROM h.holiday_date) = $2
                )
               OR (
                    h.transfer_date IS NOT NULL
                    AND EXTRACT(YEAR FROM h.transfer_date) = $1
                    AND EXTRACT(MONTH FROM h.transfer_date) = $2
                )
              ${holidayLocationSql}
            ORDER BY
                COALESCE(h.transfer_date, h.holiday_date),
                h.id;
            `,
            holidayParams
        );

        for (const row of holidayResult.rows) {
            const holidayDate = row.transfer_date || row.holiday_date;
            if (!holidayDate) continue;

            holidayDateSet.add(String(holidayDate).slice(0, 10));

            addEvent(holidayDate, {
                type: "holiday",
                name: row.name,
                holiday_date: row.holiday_date,
                transfer_date: row.transfer_date
            });
        }
    }


    /* =====================================================
       LEAVE
    ===================================================== */

    if (
        selectedTypes.includes("leave")
    ) {

        const params = [
            startDate,
            endDate
        ];

        const conditions = [
            `
            l.end_leave_date::date >= $1::date
            `,
            `
            l.start_leave_date::date < $2::date
            `
        ];


        buildFilters({
            params,
            conditions,
            username: usernameFilter,
            workLocationIds,
            departmentIds,
            usernameColumn: "l.username",
            workLocationColumn: "ed.work_location",
            departmentColumn: "ed.department"
        });


        const leaveQuery = `
            SELECT
                l.*,
                pd.first_name,
                pd.middle_name,
                pd.last_name,
                CONCAT_WS(
                    ' ',
                    NULLIF(TRIM(pd.first_name), ''),
                    NULLIF(TRIM(pd.middle_name), ''),
                    NULLIF(TRIM(pd.last_name), '')
                ) AS full_name,

                TO_CHAR(
                    leave_day::date,
                    'YYYY-MM-DD'
                ) AS calendar_date

            FROM employee_leaves l

            CROSS JOIN LATERAL generate_series(
                GREATEST(l.start_leave_date::date, $1::date),
                LEAST(l.end_leave_date::date, ($2::date - 1)),
                INTERVAL '1 day'
            ) AS leave_dates(leave_day)

            LEFT JOIN personal_details pd
                ON LOWER(TRIM(pd.username))
                    = LOWER(TRIM(l.username))

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

            WHERE
                ${conditions.join("\nAND ")}
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

            ORDER BY
                leave_day,
                l.username
        `;


        const result =
            await pool.query(
                leaveQuery,
                params
            );


        for (const row of result.rows) {

            addEvent(
                row.calendar_date,
                {
                    type: "leave",
                    username: row.username,
                    first_name: row.first_name,
                    middle_name: row.middle_name,
                    last_name: row.last_name,
                    full_name: row.full_name,
                    status:
                        row.status ||
                        row.leave_status ||
                        null,
                    data: row
                }
            );
        }
    }


    /* =====================================================
       EMPLOYEE MEETING
       Uses employee_meeting table
    ===================================================== */

    if (
        selectedTypes.includes("meeting")
    ) {

        const params = [
            startDate,
            endDate
        ];

        const conditions = [
            `
            m.date::date >= $1::date
            `,
            `
            m.date::date < $2::date
            `
        ];


        buildFilters({
            params,
            conditions,
            username: usernameFilter,
            workLocationIds,
            departmentIds,
            usernameColumn: "m.username",
            workLocationColumn: "m.work_location",
            departmentColumn: "ed_meeting.department"
        });


        const meetingQuery = `
            SELECT
                m.*,

                TO_CHAR(
                    m.date::date,
                    'YYYY-MM-DD'
                ) AS calendar_date,
                (
                    /* Only past: Schedule/empty → true,
                       status updated → false. Future → false. */
                    (
                        CURRENT_TIMESTAMP
                        AT TIME ZONE 'Asia/Kolkata'
                    ) >= (m.date + m.end_time)
                    AND (
                        m.meeting_status IS NULL
                        OR BTRIM(m.meeting_status) = ''
                        OR LOWER(BTRIM(m.meeting_status))
                            IN ('schedule', 'scheduled')
                    )
                ) AS is_pending

            FROM employee_meeting m

            LEFT JOIN personal_details pd_meeting
                ON LOWER(TRIM(pd_meeting.username))
                    = LOWER(TRIM(m.username))

            LEFT JOIN employment_details ed_meeting
                ON ed_meeting.personal_details_id
                    = pd_meeting.id

            WHERE
                ${conditions.join("\nAND ")}

            ORDER BY
                m.date,
                m.start_time,
                m.id
        `;


        const result =
            await pool.query(
                meetingQuery,
                params
            );


        for (const row of result.rows) {
            const formatTime = (value) => {
                if (value == null) return null;
                const text = String(value).trim();
                return text.length >= 5 ? text.slice(0, 5) : text;
            };

            addEvent(
                row.calendar_date,
                {
                    type: "meeting",
                    id: row.id,
                    username: row.username,
                    full_name: null,
                    candidate_full_name: null,
                    candidate_username: null,
                    start_time: formatTime(row.start_time),
                    end_time: formatTime(row.end_time),
                    meeting_status: row.meeting_status,
                    meeting_type: row.meeting_type,
                    is_pending: Boolean(row.is_pending),
                    conduct_person_name:
                        row.conduct_person_name,
                    scheduled_person_name: row.username,
                    note: row.note,
                    work_location: row.work_location,
                    meeting_members: row.meeting_members
                }
            );
        }

        /* Candidate interview meetings (meeting_schedule) */
        const candidateMeetingParams = [startDate, endDate];
        const candidateMeetingConditions = [
            `ms.schedule_date::date >= $1::date`,
            `ms.schedule_date::date < $2::date`,
            /* Reschedule thi cancel thai meeting hide */
            `NOT EXISTS (
                SELECT 1
                FROM meeting_schedule ms_next
                WHERE ms_next.cancelled_meeting_id = ms.id
            )`
        ];

        if (usernameFilter.length > 0) {
            candidateMeetingParams.push(usernameFilter);
            candidateMeetingConditions.push(`
                (
                    LOWER(TRIM(ms.scheduled_person_name))
                        = ANY($${candidateMeetingParams.length}::text[])
                    OR EXISTS (
                        SELECT 1
                        FROM unnest(
                            string_to_array(ms.conduct_person_name, ',')
                        ) AS cp(name)
                        WHERE LOWER(TRIM(cp.name))
                            = ANY($${candidateMeetingParams.length}::text[])
                    )
                )
            `);
        }

        if (workLocationIds.length > 0) {
            candidateMeetingParams.push(workLocationIds);
            candidateMeetingConditions.push(`
                ms.work_location
                    = ANY($${candidateMeetingParams.length}::integer[])
            `);
        }

        if (departmentIds.length > 0) {
            candidateMeetingParams.push(departmentIds);
            candidateMeetingConditions.push(`
                ed_sched.department
                    = ANY($${candidateMeetingParams.length}::integer[])
            `);
        }

        const candidateMeetingResult = await pool.query(
            `
            SELECT
                ms.id,
                ms.scheduled_person_name,
                ms.conduct_person_name,
                ms.meeting_status,
                ms.meeting_type,
                ms.note,
                ms.cancelled_meeting_id,
                COALESCE(
                    NULLIF(BTRIM(ms.meeting_cancelled_reason), ''),
                    NULLIF(BTRIM(ms_prev.meeting_cancelled_reason), ''),
                    NULLIF(BTRIM(ms_prev.note), '')
                ) AS meeting_cancelled_reason,
                TO_CHAR(ms.schedule_date, 'YYYY-MM-DD')
                    AS calendar_date,
                TO_CHAR(ms.start_time, 'HH24:MI') AS start_time,
                TO_CHAR(ms.end_time, 'HH24:MI') AS end_time,
                c.username AS candidate_username,
                TRIM(
                    CONCAT_WS(
                        ' ',
                        c.first_name,
                        c.middle_name,
                        c.last_name
                    )
                ) AS candidate_full_name,
                TRIM(
                    CONCAT_WS(
                        ' ',
                        pd.first_name,
                        pd.middle_name,
                        pd.last_name
                    )
                ) AS full_name,
                (
                    (
                        CURRENT_TIMESTAMP
                        AT TIME ZONE 'Asia/Kolkata'
                    ) >= (ms.schedule_date + ms.end_time)
                    AND (
                        ms.meeting_status IS NULL
                        OR BTRIM(ms.meeting_status) = ''
                        OR LOWER(BTRIM(ms.meeting_status))
                            IN ('schedule', 'scheduled')
                    )
                ) AS is_pending
            FROM meeting_schedule ms
            LEFT JOIN meeting_schedule ms_prev
                ON ms_prev.id = ms.cancelled_meeting_id
            LEFT JOIN candidate c
                ON c.id = ms.candidate_id
            LEFT JOIN personal_details pd
                ON LOWER(TRIM(pd.username))
                    = LOWER(TRIM(ms.scheduled_person_name))
            LEFT JOIN employment_details ed_sched
                ON ed_sched.personal_details_id = pd.id
            WHERE
                ${candidateMeetingConditions.join("\nAND ")}
            ORDER BY
                ms.schedule_date,
                ms.start_time,
                ms.id;
            `,
            candidateMeetingParams
        );

        for (const row of candidateMeetingResult.rows) {
            addEvent(row.calendar_date, {
                type: "meeting",
                id: row.id,
                username: row.scheduled_person_name || null,
                full_name: row.full_name || null,
                candidate_full_name: row.candidate_full_name || null,
                candidate_username: row.candidate_username || null,
                start_time: row.start_time,
                end_time: row.end_time,
                meeting_status: row.meeting_status,
                meeting_type: row.meeting_type || row.meeting_status,
                cancelled_meeting_id: row.cancelled_meeting_id,
                meeting_cancelled_reason: row.meeting_cancelled_reason,
                is_pending: Boolean(row.is_pending),
                conduct_person_name: row.conduct_person_name,
                scheduled_person_name: row.scheduled_person_name,
                note: row.note
            });
        }
    }


    /* =====================================================
       CREATE FULL MONTH CALENDAR
    ===================================================== */

    const calendar = [];

    const cursor = new Date(
        `${startDate}T00:00:00Z`
    );

    const endCursor = new Date(
        `${endDate}T00:00:00Z`
    );


    while (cursor < endCursor) {

        const date =
            cursor.toISOString().split("T")[0];

        const dayOfWeek = cursor.getUTCDay();
        let day_status = "working_day";

        if (holidayDateSet.has(date)) {
            day_status = "holiday";
        } else if (dayOfWeek === 0) {
            day_status = "weekly_off";
        }

        calendar.push({
            date,
            day_status,
            events: eventMap[date] || []
        });

        cursor.setUTCDate(
            cursor.getUTCDate() + 1
        );
    }


    /* =====================================================
       RESPONSE
    ===================================================== */

    const totalEvents =
        calendar.reduce(
            (total, day) =>
                total + day.events.length,
            0
        );


    return {
        view: "monthly",
        year,
        month,
        start_date: startDate,
        end_date: endDate,
        filters: {
            types: selectedTypes
        },

        total_events: totalEvents,
        calendar
    };
};


/* =========================================================
   GET GLOBAL CALENDAR - YEARLY
========================================================= */

export const getGlobalCalendarYearlyModel = async ({
    year,
    username = [],
    types = [],
    work_location = [],
    department = [],
    view = "joining_date"
} = {}) => {

    /* =====================================================
       VALIDATE YEAR
    ===================================================== */

    year = Number(year);

    if (
        !Number.isInteger(year) ||
        year < 2000 ||
        year > 2100
    ) {
        throw new Error("Invalid year");
    }


    /* =====================================================
       VALIDATE VIEW
    ===================================================== */

    const normalizedView =
        String(view)
            .trim()
            .toLowerCase();


    if (
        ![
            "joining_date",
            "financial_year"
        ].includes(normalizedView)
    ) {
        throw new Error(
            "Invalid yearly view. Use joining_date or financial_year"
        );
    }


    /* =====================================================
       NORMALIZE FILTERS
    ===================================================== */
    const usernameFilter = normalizeUsernames(username);
    const typeFilter = normalizeTypes(types);
    const workLocationIds = await resolveWorkLocationFilter( work_location );
    const departmentIds = await resolveDepartmentFilter(department);

    const allowedTypes = [
        "attendance",
        "leave",
        "meeting"
    ];

    const selectedTypes =
        typeFilter.length > 0
            ? typeFilter.filter(type =>
                allowedTypes.includes(type)
            )
            : allowedTypes;


    /* =====================================================
       YEAR DATE RANGE
    ===================================================== */

    let startDate;
    let endDate;


    if (
        normalizedView === "financial_year"
    ) {

        startDate =
            `${year}-04-01`;

        endDate =
            `${year + 1}-04-01`;

    } else {

        startDate =
            `${year}-01-01`;

        endDate =
            `${year + 1}-01-01`;
    }


    /* =====================================================
       EVENT MAP
    ===================================================== */

    const eventMap = {};


    const addEvent = (
        calendarDate,
        event
    ) => {

        if (!calendarDate) {
            return;
        }

        if (!eventMap[calendarDate]) {
            eventMap[calendarDate] = [];
        }

        eventMap[calendarDate].push(event);
    };


    /* =====================================================
   ATTENDANCE
   DAILY PRESENT / ABSENT COUNT
===================================================== */

    if (
        selectedTypes.includes("attendance")
    ) {

        const attendanceCounts =
            await getDailyAttendanceCounts({
                startDate,
                endDate,
                usernameFilter,
                workLocationIds,
                departmentIds
            });


        for (
            const [calendarDate, counts]
            of Object.entries(attendanceCounts)
        ) {

            addEvent(
                calendarDate,
                {
                    type: "attendance",
                    present: counts.present,
                    absent: counts.absent
                }
            );

            for (const absentUser of counts.absent_users || []) {
                addEvent(calendarDate, {
                    type: "attendance",
                    username: absentUser.username,
                    full_name: absentUser.full_name,
                    status: "absent",
                    entry_at: null,
                    exit_at: null
                });
            }
        }
    }


    /* =====================================================
       HOLIDAY
    ===================================================== */

    const holidayDateSet = new Set();

    {
        const holidayParams = [startDate, endDate];
        let holidayLocationSql = "";

        if (workLocationIds.length > 0) {
            holidayParams.push(workLocationIds);
            holidayLocationSql = `
                AND (
                    h.locations IS NULL
                    OR cardinality(h.locations) = 0
                    OR EXISTS (
                        SELECT 1
                        FROM unnest(
                            $${holidayParams.length}::INTEGER[]
                        ) AS wl_id(id)
                        WHERE wl_id.id::TEXT = ANY(h.locations)
                    )
                )
            `;
        }

        const holidayResult = await pool.query(
            `
            SELECT
                h.holiday_name AS name,
                TO_CHAR(h.holiday_date, 'YYYY-MM-DD')
                    AS holiday_date,
                TO_CHAR(h.transfer_date, 'YYYY-MM-DD')
                    AS transfer_date
            FROM holidays h
            WHERE COALESCE(
                    h.transfer_date,
                    h.holiday_date
                )::date >= $1::date
              AND COALESCE(
                    h.transfer_date,
                    h.holiday_date
                )::date < $2::date
              ${holidayLocationSql}
            ORDER BY
                COALESCE(h.transfer_date, h.holiday_date),
                h.id;
            `,
            holidayParams
        );

        for (const row of holidayResult.rows) {
            const holidayDate = row.transfer_date || row.holiday_date;
            if (!holidayDate) continue;

            holidayDateSet.add(String(holidayDate).slice(0, 10));

            addEvent(holidayDate, {
                type: "holiday",
                name: row.name,
                holiday_date: row.holiday_date,
                transfer_date: row.transfer_date
            });
        }
    }


    /* =====================================================
       LEAVE
    ===================================================== */

    if (
        selectedTypes.includes("leave")
    ) {

        const params = [
            startDate,
            endDate
        ];

        const conditions = [
            `
            l.end_leave_date::date >= $1::date
            `,
            `
            l.start_leave_date::date < $2::date
            `
        ];


        buildFilters({
            params,
            conditions,
            username: usernameFilter,
            workLocationIds,
            departmentIds,
            usernameColumn: "l.username",
            workLocationColumn: "ed.work_location",
            departmentColumn: "ed.department"
        });


        const leaveQuery = `
            SELECT
                l.*,
                pd.first_name,
                pd.middle_name,
                pd.last_name,
                CONCAT_WS(
                    ' ',
                    NULLIF(TRIM(pd.first_name), ''),
                    NULLIF(TRIM(pd.middle_name), ''),
                    NULLIF(TRIM(pd.last_name), '')
                ) AS full_name,

                TO_CHAR(
                    leave_day::date,
                    'YYYY-MM-DD'
                ) AS calendar_date

            FROM employee_leaves l

            CROSS JOIN LATERAL generate_series(
                GREATEST(l.start_leave_date::date, $1::date),
                LEAST(l.end_leave_date::date, ($2::date - 1)),
                INTERVAL '1 day'
            ) AS leave_dates(leave_day)

            LEFT JOIN personal_details pd
                ON LOWER(TRIM(pd.username))
                    = LOWER(TRIM(l.username))

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

            WHERE
                ${conditions.join("\nAND ")}
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

            ORDER BY
                leave_day,
                l.username
        `;


        const result =
            await pool.query(
                leaveQuery,
                params
            );


        for (const row of result.rows) {

            addEvent(
                row.calendar_date,
                {
                    type: "leave",
                    username: row.username,
                    first_name: row.first_name,
                    middle_name: row.middle_name,
                    last_name: row.last_name,
                    full_name: row.full_name,
                    status:
                        row.status ||
                        row.leave_status ||
                        null,
                    data: row
                }
            );
        }
    }


    /* =====================================================
       EMPLOYEE MEETING
    ===================================================== */

    if (
        selectedTypes.includes("meeting")
    ) {

        const params = [
            startDate,
            endDate
        ];

        const conditions = [
            `
            m.date::date >= $1::date
            `,
            `
            m.date::date < $2::date
            `
        ];


        buildFilters({
            params,
            conditions,
            username: usernameFilter,
            workLocationIds,
            departmentIds,
            usernameColumn: "m.username",
            workLocationColumn: "m.work_location",
            departmentColumn: "ed_meeting.department"
        });


        const meetingQuery = `
            SELECT
                m.*,

                TO_CHAR(
                    m.date::date,
                    'YYYY-MM-DD'
                ) AS calendar_date,
                (
                    /* Only past: Schedule/empty → true,
                       status updated → false. Future → false. */
                    (
                        CURRENT_TIMESTAMP
                        AT TIME ZONE 'Asia/Kolkata'
                    ) >= (m.date + m.end_time)
                    AND (
                        m.meeting_status IS NULL
                        OR BTRIM(m.meeting_status) = ''
                        OR LOWER(BTRIM(m.meeting_status))
                            IN ('schedule', 'scheduled')
                    )
                ) AS is_pending

            FROM employee_meeting m

            LEFT JOIN personal_details pd_meeting
                ON LOWER(TRIM(pd_meeting.username))
                    = LOWER(TRIM(m.username))

            LEFT JOIN employment_details ed_meeting
                ON ed_meeting.personal_details_id
                    = pd_meeting.id

            WHERE
                ${conditions.join("\nAND ")}

            ORDER BY
                m.date,
                m.start_time,
                m.id
        `;


        const result =
            await pool.query(
                meetingQuery,
                params
            );


        for (const row of result.rows) {
            const formatTime = (value) => {
                if (value == null) return null;
                const text = String(value).trim();
                return text.length >= 5 ? text.slice(0, 5) : text;
            };

            addEvent(
                row.calendar_date,
                {
                    type: "meeting",
                    id: row.id,
                    username: row.username,
                    full_name: null,
                    candidate_full_name: null,
                    candidate_username: null,
                    start_time: formatTime(row.start_time),
                    end_time: formatTime(row.end_time),
                    meeting_status: row.meeting_status,
                    meeting_type: row.meeting_type,
                    is_pending: Boolean(row.is_pending),
                    conduct_person_name: row.conduct_person_name,
                    scheduled_person_name: row.username,
                    note: row.note,
                    work_location: row.work_location,
                    meeting_members: row.meeting_members
                }
            );
        }

        const candidateMeetingParams = [startDate, endDate];
        const candidateMeetingConditions = [
            `ms.schedule_date::date >= $1::date`,
            `ms.schedule_date::date < $2::date`,
            `NOT EXISTS (
                SELECT 1
                FROM meeting_schedule ms_next
                WHERE ms_next.cancelled_meeting_id = ms.id
            )`
        ];

        if (usernameFilter.length > 0) {
            candidateMeetingParams.push(usernameFilter);
            candidateMeetingConditions.push(`
                (
                    LOWER(TRIM(ms.scheduled_person_name))
                        = ANY($${candidateMeetingParams.length}::text[])
                    OR EXISTS (
                        SELECT 1
                        FROM unnest(
                            string_to_array(ms.conduct_person_name, ',')
                        ) AS cp(name)
                        WHERE LOWER(TRIM(cp.name))
                            = ANY($${candidateMeetingParams.length}::text[])
                    )
                )
            `);
        }

        if (workLocationIds.length > 0) {
            candidateMeetingParams.push(workLocationIds);
            candidateMeetingConditions.push(`
                ms.work_location
                    = ANY($${candidateMeetingParams.length}::integer[])
            `);
        }

        if (departmentIds.length > 0) {
            candidateMeetingParams.push(departmentIds);
            candidateMeetingConditions.push(`
                ed_sched.department
                    = ANY($${candidateMeetingParams.length}::integer[])
            `);
        }

        const candidateMeetingResult = await pool.query(
            `
            SELECT
                ms.id,
                ms.scheduled_person_name,
                ms.conduct_person_name,
                ms.meeting_status,
                ms.meeting_type,
                ms.note,
                ms.cancelled_meeting_id,
                COALESCE(
                    NULLIF(BTRIM(ms.meeting_cancelled_reason), ''),
                    NULLIF(BTRIM(ms_prev.meeting_cancelled_reason), ''),
                    NULLIF(BTRIM(ms_prev.note), '')
                ) AS meeting_cancelled_reason,
                TO_CHAR(ms.schedule_date, 'YYYY-MM-DD')
                    AS calendar_date,
                TO_CHAR(ms.start_time, 'HH24:MI') AS start_time,
                TO_CHAR(ms.end_time, 'HH24:MI') AS end_time,
                c.username AS candidate_username,
                TRIM(
                    CONCAT_WS(
                        ' ',
                        c.first_name,
                        c.middle_name,
                        c.last_name
                    )
                ) AS candidate_full_name,
                TRIM(
                    CONCAT_WS(
                        ' ',
                        pd.first_name,
                        pd.middle_name,
                        pd.last_name
                    )
                ) AS full_name,
                (
                    (
                        CURRENT_TIMESTAMP
                        AT TIME ZONE 'Asia/Kolkata'
                    ) >= (ms.schedule_date + ms.end_time)
                    AND (
                        ms.meeting_status IS NULL
                        OR BTRIM(ms.meeting_status) = ''
                        OR LOWER(BTRIM(ms.meeting_status))
                            IN ('schedule', 'scheduled')
                    )
                ) AS is_pending
            FROM meeting_schedule ms
            LEFT JOIN meeting_schedule ms_prev
                ON ms_prev.id = ms.cancelled_meeting_id
            LEFT JOIN candidate c
                ON c.id = ms.candidate_id
            LEFT JOIN personal_details pd
                ON LOWER(TRIM(pd.username))
                    = LOWER(TRIM(ms.scheduled_person_name))
            LEFT JOIN employment_details ed_sched
                ON ed_sched.personal_details_id = pd.id
            WHERE
                ${candidateMeetingConditions.join("\nAND ")}
            ORDER BY
                ms.schedule_date,
                ms.start_time,
                ms.id;
            `,
            candidateMeetingParams
        );

        for (const row of candidateMeetingResult.rows) {
            addEvent(row.calendar_date, {
                type: "meeting",
                id: row.id,
                username: row.scheduled_person_name || null,
                full_name: row.full_name || null,
                candidate_full_name: row.candidate_full_name || null,
                candidate_username: row.candidate_username || null,
                start_time: row.start_time,
                end_time: row.end_time,
                meeting_status: row.meeting_status,
                meeting_type: row.meeting_type || row.meeting_status,
                cancelled_meeting_id: row.cancelled_meeting_id,
                meeting_cancelled_reason: row.meeting_cancelled_reason,
                is_pending: Boolean(row.is_pending),
                conduct_person_name: row.conduct_person_name,
                scheduled_person_name: row.scheduled_person_name,
                note: row.note
            });
        }
    }


    /* =====================================================
       BUILD MONTHS
    ===================================================== */

    const months = [];


    let monthStart;

    if (
        normalizedView === "financial_year"
    ) {
        monthStart = 4;
    } else {
        monthStart = 1;
    }


    for (let i = 0; i < 12; i++) {

        let currentMonth =
            monthStart + i;

        let currentYear =
            year;


        if (currentMonth > 12) {

            currentMonth -= 12;

            currentYear += 1;
        }


        const monthStartDate =
            `${currentYear}-${String(
                currentMonth
            ).padStart(2, "0")}-01`;


        const nextMonth =
            new Date(
                Date.UTC(
                    currentYear,
                    currentMonth,
                    1
                )
            );


        const monthEndDate =
            `${nextMonth.getUTCFullYear()}-${String(
                nextMonth.getUTCMonth() + 1
            ).padStart(2, "0")}-01`;


        const days = [];

        const cursor = new Date(
            `${monthStartDate}T00:00:00Z`
        );

        const endCursor = new Date(
            `${monthEndDate}T00:00:00Z`
        );

        while (cursor < endCursor) {
            const date = cursor.toISOString().split("T")[0];

            const dayOfWeek = cursor.getUTCDay();
            let day_status = "working_day";

            if (holidayDateSet.has(date)) {
                day_status = "holiday";
            } else if (dayOfWeek === 0) {
                day_status = "weekly_off";
            }

            days.push({
                date,
                day_status,
                events: eventMap[date] || []
            });

            cursor.setUTCDate(
                cursor.getUTCDate() + 1
            );
        }

        months.push({
            month: currentMonth,
            year: currentYear,
            start_date: monthStartDate,
            end_date: monthEndDate,
            days
        });
    }

    /* =====================================================
       TOTAL EVENTS
    ===================================================== */
    const totalEvents =
        months.reduce(
            (total, monthData) =>
                total +
                monthData.days.reduce(
                    (monthTotal, day) =>
                        monthTotal +
                        day.events.length,
                    0
                ),
            0
        );

    /* =====================================================
       RESPONSE
    ===================================================== */
    return {
        view: normalizedView,
        year,
        start_date: startDate,
        end_date: endDate,
        filters: {
            types: selectedTypes
        },
        total_events: totalEvents,
        months
    };
};