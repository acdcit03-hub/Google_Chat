import { pool } from "../../database.js";

const MONTH_NAMES = [
    "January", "February", "March", "April",
    "May", "June", "July", "August",
    "September", "October", "November", "December"
];

const formatDuration = (seconds) => {
    const safeSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(safeSeconds / 3600);
    const minutes = Math.floor((safeSeconds % 3600) / 60);
    const remainingSeconds = safeSeconds % 60;

    return [
        String(hours).padStart(2, "0"),
        String(minutes).padStart(2, "0"),
        String(remainingSeconds).padStart(2, "0")
    ].join(":");
};

const durationSeconds = (start, end) => {
    if (!start || !end) return 0;

    const startTime = new Date(`1970-01-01T${String(start).slice(0, 8)}Z`);
    const endTime = new Date(`1970-01-01T${String(end).slice(0, 8)}Z`);

    let difference = (endTime - startTime) / 1000;

    if (difference < 0) difference += 24 * 3600;

    return Math.max(0, difference);
};

export const getMonthlyEmployeeAttendanceReport = async ({
    month,
    year,
    username = null,
    work_location = null
}) => {
    const monthNumber = Number(month);
    const yearNumber = Number(year);

    if (!Number.isInteger(monthNumber) || monthNumber < 1 || monthNumber > 12) {
        throw new Error("month must be between 1 and 12.");
    }

    if (!Number.isInteger(yearNumber) || yearNumber < 2000 || yearNumber > 2100) {
        throw new Error("Invalid year.");
    }

    const result = await pool.query(
        `
        SELECT
            ed.employment_id AS "employmentId",
            LOWER(TRIM(pd.username)) AS username,
            pd.first_name AS "firstName",
            pd.middle_name AS "middleName",
            pd.last_name AS "lastName",

            COALESCE(wl.location, ed.work_location::TEXT) AS work_location,
            ed.work_location AS work_location_id,

            me.status,

            TO_CHAR(
                (a.entry_at AT TIME ZONE 'Asia/Kolkata')::DATE,
                'YYYY-MM-DD'
            ) AS attendance_date,

            TO_CHAR(
                a.entry_at AT TIME ZONE 'Asia/Kolkata',
                'HH24:MI:SS'
            ) AS check_in,

            TO_CHAR(
                a.exit_at AT TIME ZONE 'Asia/Kolkata',
                'HH24:MI:SS'
            ) AS check_out,

            a.status AS session_status,

            COALESCE(
                EXTRACT(EPOCH FROM a.duration),
                CASE
                    WHEN a.entry_at IS NOT NULL AND a.exit_at IS NOT NULL
                    THEN EXTRACT(EPOCH FROM (a.exit_at - a.entry_at))
                    ELSE 0
                END
            ) AS duration_seconds

        FROM master_employee me

        INNER JOIN personal_details pd
            ON LOWER(TRIM(pd.username)) = LOWER(TRIM(me.username))

        INNER JOIN employment_details ed
            ON ed.personal_details_id = pd.id

        LEFT JOIN work_location wl
            ON wl.id = ed.work_location

        LEFT JOIN attendance_sessions a
            ON LOWER(TRIM(a.username)) = LOWER(TRIM(pd.username))
           AND a.entry_at >= (
                make_date($1::INTEGER, $2::INTEGER, 1)::TIMESTAMP
                AT TIME ZONE 'Asia/Kolkata'
           )
           AND a.entry_at < (
                (
                    make_date($1::INTEGER, $2::INTEGER, 1)
                    + INTERVAL '1 month'
                )::TIMESTAMP
                AT TIME ZONE 'Asia/Kolkata'
           )

        WHERE LOWER(TRIM(me.status)) = 'active'
          AND (
              $3::TEXT IS NULL
              OR LOWER(TRIM(pd.username)) = LOWER(TRIM($3))
          )
          AND (
              $4::TEXT IS NULL
              OR ed.work_location::TEXT = $4
              OR LOWER(TRIM(wl.location)) = LOWER(TRIM($4))
          )

        ORDER BY
            LOWER(TRIM(pd.username)),
            a.entry_at,
            a.id
        `,
        [yearNumber, monthNumber, username, work_location]
    );

    const employees = new Map();

    for (const row of result.rows) {
        const employeeKey = row.username;

        if (!employees.has(employeeKey)) {
            employees.set(employeeKey, {
                employmentId: row.employmentId,
                username: row.username,
                firstName: row.firstName,
                middleName: row.middleName,
                lastName: row.lastName,
                work_location: row.work_location,
                work_location_id: row.work_location_id,
                shiftName: null,
                shiftType: null,
                workingStartTime: null,
                workingEndTime: null,
                status: row.status,
                month: MONTH_NAMES[monthNumber - 1],
                year: yearNumber,
                attendance: 0,
                totalHours: "00:00:00",
                totalMinutes: 0,
                totalOvertimeMinutes: 0,
                companyTotalDays: 0,
                companyTotalMinutes: 0,
                dailyRecords: [],
                _days: new Map()
            });
        }

        const employee = employees.get(employeeKey);

        if (!row.attendance_date) continue;

        const date = row.attendance_date;

        if (!employee._days.has(date)) {
            employee._days.set(date, {
                date,
                check_in: null,
                check_out: null,
                working_start_time: employee.workingStartTime,
                working_end_time: employee.workingEndTime,
                is_holiday: false,
                holiday_name: null,
                total_hours: "00:00:00",
                total_minutes: 0,
                sessions: [],
                _seconds: 0
            });
        }

        const day = employee._days.get(date);
        const checkIn = row.check_in;
        const checkOut = row.check_out;

        const seconds = Math.max(
            0,
            Math.floor(Number(row.duration_seconds) || 0)
        );

        if (checkIn && (!day.check_in || checkIn < day.check_in)) {
            day.check_in = checkIn;
        }

        if (checkOut && (!day.check_out || checkOut > day.check_out)) {
            day.check_out = checkOut;
        }

        day._seconds += seconds;

        if (checkIn || checkOut) {
            day.sessions.push({
                check_in: checkIn,
                check_out: checkOut,
                status: row.session_status || "inside",
                total_hours: formatDuration(seconds),
                total_minutes: Math.floor(seconds / 60)
            });
        }
    }

    const output = [];

    for (const employee of employees.values()) {
        const days = [...employee._days.values()].sort(
            (a, b) => a.date.localeCompare(b.date)
        );

        let totalSeconds = 0;

        for (const day of days) {
            day.total_hours = formatDuration(day._seconds);
            day.total_minutes = Math.floor(day._seconds / 60);
            totalSeconds += day._seconds;
            delete day._seconds;
        }

        employee.dailyRecords = days;

        employee.attendance = days.filter(
            (day) => day.sessions.length > 0
        ).length;

        employee.totalMinutes = Math.floor(totalSeconds / 60);
        employee.totalHours = formatDuration(totalSeconds);

        const daysInMonth = new Date(
            yearNumber,
            monthNumber,
            0
        ).getDate();

        let workingDays = 0;

        for (let day = 1; day <= daysInMonth; day++) {
            const weekday = new Date(
                yearNumber,
                monthNumber - 1,
                day
            ).getDay();

            if (weekday !== 0 && weekday !== 6) {
                workingDays++;
            }
        }

        employee.companyTotalDays = workingDays;

        const shiftSeconds = durationSeconds(
            employee.workingStartTime,
            employee.workingEndTime
        );

        employee.companyTotalMinutes =
            Math.floor(shiftSeconds / 60) * workingDays;

        employee.totalOvertimeMinutes = days.reduce(
            (total, day) => {
                const shiftMinutes = Math.floor(shiftSeconds / 60);

                return total + Math.max(
                    0,
                    day.total_minutes - shiftMinutes
                );
            },
            0
        );

        delete employee._days;
        output.push(employee);
    }

    return output;
};