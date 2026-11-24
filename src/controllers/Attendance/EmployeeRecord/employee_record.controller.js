import { getIO } from "../../../config/socket.js";
import { getAllHolidaysModel, getHolidaysByYearModel } from "../../../models/Attendance/Calendar/holiday.model.js";
import { getEmployeeAttendanceRecordModel, getYearlyAttendanceSummaryModel } from "../../../models/Attendance/EmployeeRecord/employee_record.model.js";
import { getEmployeeLeaveByYearModel, getLeavesModel } from "../../../models/Attendance/EmployeeRecord/EmployeeLeaves.model.js";
import { calculateShiftMinutes } from "../Summary/summary.controller.js";

/* =====================================================
   NORMALIZE DATE WITHOUT TIMEZONE SHIFT
===================================================== */
const normalizeDateKey = (value) => {

    if (!value) {
        return null;
    }

    // Already YYYY-MM-DD
    if (
        typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(value)
    ) {
        return value;
    }

    // PostgreSQL date/timestamp string
    if (typeof value === "string") {

        const match = value.match(
            /^(\d{4})-(\d{2})-(\d{2})/
        );

        if (match) {
            return `${match[1]}-${match[2]}-${match[3]}`;
        }
    }

    // JS Date / other date value
    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return null;
    }

    return [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, "0"),
        String(date.getDate()).padStart(2, "0")
    ].join("-");
};

const getDateKeysInRange = (startDate, endDate) => {
    const dates = [];
    const cursor = new Date(`${startDate}T00:00:00Z`);
    const end = new Date(`${endDate}T00:00:00Z`);

    while (cursor <= end) {
        dates.push(cursor.toISOString().slice(0, 10));
        cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    return dates;
};
/* ================= FORMAT DURATION ================= */

const formatDuration = (duration) => {

    if (duration === null || duration === undefined) {
        return null;
    }

    let totalSeconds = 0;

    /* PostgreSQL interval */
    if (typeof duration === "string") {

        const match = duration.match(
            /^(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$/
        );

        if (match) {

            const hours = Number(match[1]);
            const minutes = Number(match[2]);
            const seconds = Number(match[3]);

            totalSeconds =
                (hours * 3600) +
                (minutes * 60) +
                seconds;
        }
    }

    /* Numeric seconds */
    else if (typeof duration === "number") {

        totalSeconds = Math.floor(duration);
    }

    /* Already formatted object */
    else if (typeof duration === "object") {

        return {
            hours: Number(duration.hours || 0),
            minutes: Number(duration.minutes || 0),
            seconds: Number(duration.seconds || 0)
        };
    }

    const hours = Math.floor(totalSeconds / 3600);

    const minutes = Math.floor(
        (totalSeconds % 3600) / 60
    );

    const seconds = totalSeconds % 60;

    return {
        hours,
        minutes,
        seconds
    };
};

/* ================= GET EMPLOYEE ATTENDANCE RECORD ================= */
export const getEmployeeAttendanceRecord = async (req, res) => {
    try {

        const {
            from,
            to,
            startDate,
            endDate,
            name,
            department,
            category,
            shift_type,
            work_location,
            status,
            page = 1,
            limit = 20
        } = req.query;

        const { username } = req.params;

        const fromDate = startDate || from;
        const toDate = endDate || to;

        /* =========================================================
           DATE RANGE VALIDATION - MAXIMUM 90 DAYS
        ========================================================= */

        const start = new Date(fromDate);
        const end = new Date(toDate);

        if (
            Number.isNaN(start.getTime()) ||
            Number.isNaN(end.getTime())
        ) {
            return res.status(400).json({
                success: false,
                message: "Invalid start date or end date"
            });
        }

        if (end < start) {
            return res.status(400).json({
                success: false,
                message: "End date cannot be before start date"
            });
        }

        /* =========================================================
           MAXIMUM 90 DAYS
        ========================================================= */

        const differenceInDays =
            Math.floor(
                (end.getTime() - start.getTime()) /
                (1000 * 60 * 60 * 24)
            ) + 1;

        if (differenceInDays > 90) {
            return res.status(400).json({
                success: false,
                message: "Date range cannot be more than 90 days",
                maxDays: 90,
                selectedDays: differenceInDays
            });
        }

        const result = await getEmployeeAttendanceRecordModel({
            startDate: fromDate,
            endDate: toDate,
            name,
            username,
            department,
            shift_type,
            work_location,
            category,
            status,
            page: Number(page),
            limit: Number(limit)
        });

        const rows = result.rows;
        const pagination = result.pagination;

        /* ================= GET LEAVES ================= */
        const leaveResult = await getLeavesModel({
            username,
            startDate: fromDate,
            endDate: toDate,
            pagination: false
        });
        const leaves = Array.isArray(leaveResult?.data)
            ? leaveResult.data
            : [];

        const leaveMap = {};

        leaves.forEach((leave) => {

            if (!leaveMap[leave.username]) {
                leaveMap[leave.username] = {};
            }

            const leaveStart = normalizeDateKey(leave.start_leave_date);
            const leaveEnd = normalizeDateKey(leave.end_leave_date);

            if (!leaveStart || !leaveEnd) {
                return;
            }

            const visibleStart = leaveStart < normalizeDateKey(fromDate)
                ? normalizeDateKey(fromDate)
                : leaveStart;
            const visibleEnd = leaveEnd > normalizeDateKey(toDate)
                ? normalizeDateKey(toDate)
                : leaveEnd;

            for (const calendarDate of getDateKeysInRange(visibleStart, visibleEnd)) {
                leaveMap[leave.username][calendarDate] = {
                    reason: leave.reason,
                    description: leave.description,
                    rejected_reason: leave.rejected_reason,
                    document: leave.document,
                    leave_type: leave.leave_type,
                    start_leave_date: leaveStart,
                    end_leave_date: leaveEnd
                };
            }
        });

        /* ================= GET HOLIDAYS ================= */
        const holidays = await getAllHolidaysModel();

        const employees = {};

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        /* ================= BUILD EMPLOYEE ================= */
        rows.forEach((row) => {

            const key = row.employment_id;

            if (!employees[key]) {

                employees[key] = {
                    employment_id: row.employment_id,
                    username: row.username,
                    first_name: row.first_name,
                    middle_name: row.middle_name,
                    last_name: row.last_name,
                    employee_name: [
                        row.first_name,
                        row.middle_name,
                        row.last_name
                    ].filter(Boolean).join(" "),
                    image: row.image,
                    location_id: row.work_location_id,
                    work_location: row.work_location,
                    category: row.category,
                    shift_type: row.shift_type,
                    shift_days: Array.isArray(row.shift_days)
                        ? row.shift_days
                        : [],

                    shift_time:
                        row.shift_start_time && row.shift_end_time
                            ? `${row.shift_start_time} - ${row.shift_end_time}`
                            : null,

                    late_arrival_count_time:
                        row.late_arrival_count_time ?? 0,

                    early_leave_count_time:
                        row.early_leave_count_time ?? 0,
                    joining_date: row.date_of_joining,
                    inactive_date: row.inactive_date,
                    attendance: {}
                };
            }

            /* ================= PRESENT / HALF DAY ================= */
            if (row.entry_at) {
                const date = row.entry_at.toLocaleDateString("en-CA", {
                    timeZone: "Asia/Kolkata"
                });

                const duration = formatDuration(row.duration);

                switch (row.status) {

                    case "completed":
                    case "inside":

                        employees[key].attendance[date] = {
                            status: "P",
                            attendance_time_status: row.attendance_time_status,
                            duration
                        };

                        break;

                    case "half_day":

                        employees[key].attendance[date] = {
                            status: "HD",
                            attendance_time_status: row.attendance_time_status,
                            duration
                        };

                        break;

                    case "expired":
                    default:

                        employees[key].attendance[date] = {
                            status: "A",
                            attendance_time_status: row.attendance_time_status,
                            duration
                        };

                        break;
                }
            }

        });

        /* ================= FILL ATTENDANCE ================= */

        Object.values(employees).forEach((emp) => {

            const joiningDate = new Date(emp.joining_date);
            joiningDate.setHours(0, 0, 0, 0);

            const inactiveDate = emp.inactive_date
                ? new Date(emp.inactive_date)
                : null;

            if (inactiveDate) {
                inactiveDate.setHours(0, 0, 0, 0);
            }

            for (
                let d = new Date(start);
                d <= end;
                d.setDate(d.getDate() + 1)
            ) {

                const dateStr = d.toISOString().split("T")[0];

                const current = new Date(dateStr);
                current.setHours(0, 0, 0, 0);

                /* ================= BEFORE JOINING ================= */

                if (current < joiningDate) {
                    emp.attendance[dateStr] = {
                        status: "NM",
                        duration: null
                    };
                    continue;
                }

                /* ================= EXISTING ATTENDANCE ================= */

                const existingAttendance =
                    emp.attendance[dateStr];

                /*
                 * IMPORTANT:
                 * Attendance is an object:
                 *
                 * {
                 *    status: "P",
                 *    duration: {...}
                 * }
                 */

                if (
                    existingAttendance?.status === "P" ||
                    existingAttendance?.status === "HD"
                ) {
                    continue;
                }

                /* ================= HOLIDAY ================= */

                const holiday = holidays.find(h => {

                    if (h.holiday_date !== dateStr) {
                        return false;
                    }

                    /*
                     * No location restriction
                     */
                    if (
                        !h.locations ||
                        h.locations.length === 0
                    ) {
                        return true;
                    }

                    /*
                     * Holiday locations may come as:
                     *
                     * [1]
                     * ["1"]
                     * "{1}"
                     */

                    const holidayLocations = Array.isArray(h.locations)
                        ? h.locations.map(Number)
                        : String(h.locations)
                            .replace(/[{}]/g, "")
                            .split(",")
                            .map(Number)
                            .filter(Number.isFinite);

                    return holidayLocations.includes(
                        Number(emp.location_id)
                    );
                });

                if (holiday) {

                    emp.attendance[dateStr] = {
                        status: holiday.transfer_date
                            ? "WO"
                            : "H",
                        duration: null
                    };

                    continue;
                }

                /* ================= WEEKLY OFF ================= */

                const weekdayNames = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
                const configuredShiftDays = emp.shift_days
                    .map(day => String(day).trim().toUpperCase());
                const isTransferredWeeklyOff = holidays.some(h => {
                    if (h.transfer_date !== dateStr) {
                        return false;
                    }

                    if (!h.locations || h.locations.length === 0) {
                        return true;
                    }

                    const holidayLocations = Array.isArray(h.locations)
                        ? h.locations.map(Number)
                        : String(h.locations)
                            .replace(/[{}]/g, "")
                            .split(",")
                            .map(Number)
                            .filter(Number.isFinite);

                    return holidayLocations.includes(Number(emp.location_id));
                });
                const isWeeklyOff = !isTransferredWeeklyOff && (
                    configuredShiftDays.length > 0
                    ? !configuredShiftDays.includes(weekdayNames[current.getDay()])
                    : current.getDay() === 0
                );

                if (isWeeklyOff) {
                    emp.attendance[dateStr] = {
                        status: "WO",
                        duration: null
                    };
                    continue;
                }

                /* ================= LEAVE ================= */

                if (leaveMap[emp.username]?.[dateStr]) {

                    if (
                        inactiveDate &&
                        current > inactiveDate
                    ) {
                        emp.attendance[dateStr] = "-";
                        continue;
                    }

                    if (current >= today) {

                        const leave =
                            leaveMap[emp.username][dateStr];

                        let status = "FL";

                        switch (
                        (leave.leave_type || "").toLowerCase()
                        ) {

                            case "morning":
                            case "morning half leave":
                                status = "ML";
                                break;

                            case "evening":
                            case "evening half leave":
                                status = "EL";
                                break;

                            default:
                                status = "FL";
                        }

                        emp.attendance[dateStr] = {
                            status,
                            reason: leave.reason,
                            description: leave.description,
                            duration: null
                        };

                    } else {

                        emp.attendance[dateStr] = {
                            status: "A",
                            duration: null
                        };
                    }

                    continue;
                }

                /* ================= AFTER INACTIVE ================= */

                if (
                    inactiveDate &&
                    current > inactiveDate
                ) {
                    emp.attendance[dateStr] = "-";
                    continue;
                }

                /* ================= ABSENT / NOT MARKED ================= */

                emp.attendance[dateStr] = {
                    status: current <= today
                        ? "A"
                        : "NM",
                    duration: null
                };
            }
        });

        /* ================= SOCKET ================= */
        const io = getIO();

        if (io) {
            io.emit("attendance:record", {
                success: true,
                data: Object.values(employees)
            });
        }

        return res.status(200).json({
            success: true,
            data: Object.values(employees),
            pagination
        });

    } catch (error) {
        console.error("EMPLOYEE RECORD ERROR :", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* =========================================================
   HOLIDAY LOCATION MATCH
========================================================= */
const isHolidayForEmployee = (holiday, row) => {

    /* No location restriction = applicable to all employees */
    if (
        !holiday.locations ||
        holiday.locations.length === 0
    ) {
        return true;
    }

    const employeeLocationId =
        Number(row.work_location_id);

    if (!Number.isInteger(employeeLocationId)) {
        return false;
    }

    let holidayLocations = [];

    if (Array.isArray(holiday.locations)) {

        holidayLocations =
            holiday.locations;

    } else {

        holidayLocations =
            String(holiday.locations)
                .replace(/[{}]/g, "")
                .split(",")
                .map(value => value.trim())
                .filter(Boolean);
    }

    return holidayLocations.some(
        location =>
            Number(location) ===
            employeeLocationId
    );
};

/* ================= GET YEARLY ATTENDANCE SUMMARY ================= */
export const getYearlyAttendanceSummary = async (req, res) => {
    try {
        const {
            year,
            month,
            name,
            username,
            department,
            shift_type,
            work_location,
            category,
            date_mode = "joining",
            page = 1,
            limit = 20
        } = req.query;

        /* =========================================================
           YEAR VALIDATION
        ========================================================= */
        if (!year) {
            return res.status(400).json({
                success: false,
                message: "Year is required"
            });
        }

        /* =========================================================
           DATE MODE VALIDATION
        ========================================================= */
        const normalizedDateMode =
            String(date_mode)
                .trim()
                .toLowerCase();

        if (
            ![
                "joining",
                "financial_year"
            ].includes(normalizedDateMode)
        ) {
            return res.status(400).json({
                success: false,
                message: "date_mode must be joining or financial_year"
            });
        }

        /* =========================================================
           GET ATTENDANCE
        ========================================================= */
        const rows = await getYearlyAttendanceSummaryModel({
            year,
            month,
            name,
            username,
            department,
            category,
            shift_type,
            work_location,
            date_mode: normalizedDateMode
        });

        /* =========================================================
           HOLIDAYS
        ========================================================= */
        let holidays = [];

        try {
            holidays = await getHolidaysByYearModel(year);
        } catch (err) {
            console.log("Holiday error:", err.message);
        }

        /* =========================================================
           LEAVES
        ========================================================= */
        let leaveRows = [];

        try {
            leaveRows = await getEmployeeLeaveByYearModel(
                year,
                normalizedDateMode
            );
        } catch (err) {
            console.log("Leave error:", err.message);
        }

        /* =========================================================
           EMPLOYEES
        ========================================================= */
        const employees = {};
        rows.forEach((row) => {
            const key = row.employment_id || row.username;

            if (!employees[key]) {
                employees[key] = {
                    employment_id: row.employment_id,
                    username: row.username,
                    first_name: row.first_name,
                    middle_name: row.middle_name,
                    last_name: row.last_name,

                    employee_name:
                        (
                            row.employee_name ||
                            ""
                        ).trim(),

                    image: row.image,
                    work_location: row.work_location,
                    category: row.category,
                    location_id: row.work_location_id,
                    shift_days: Array.isArray(row.shift_days)
                        ? row.shift_days
                        : [],
                    date_of_joining: row.date_of_joining,
                    inactive_date: row.inactive_date,
                    months: [],

                    yearly_total: {
                        present: 0,
                        absent: 0,
                        full_leave: 0,
                        half_leave: 0,
                        company_holiday: 0,
                        total_minutes: 0,
                        company_total_minutes: 0
                    }
                };
            }

            /* =====================================================
               FIND MONTH
            ===================================================== */
            let monthData = employees[key].months.find(
                m =>
                    m.month_no ===
                    Number(row.month_no) &&
                    m.calendar_year ===
                    Number(row.calendar_year)
            );

            /* =====================================================
               MONTH DAYS
            ===================================================== */
            const monthDays =
                new Date(
                    Number(row.calendar_year),
                    Number(row.month_no),
                    0
                ).getDate();

            /* =====================================================
               ATTENDANCE TOTAL
            ===================================================== */
            const totalSeconds =
                Number(
                    row.total_seconds || 0
                );

            const totalMinutes =
                Math.round(
                    totalSeconds / 60
                );

            const totalHours = totalMinutes / 60;

            /* =====================================================
               WEEKLY OFF
            ===================================================== */
            let weeklyOffCount = 0;
            const shiftDays = Array.isArray(row.shift_days)
                ? row.shift_days.map(day => String(day).trim().toUpperCase())
                : [];

            for (
                let i = 1;
                i <= monthDays;
                i++
            ) {

                const date =
                    new Date(
                        Number(
                            row.calendar_year
                        ),
                        Number(
                            row.month_no
                        ) - 1,
                        i
                    );

                const dateKey = `${row.calendar_year}-${String(row.month_no).padStart(2, "0")}-${String(i).padStart(2, "0")}`;
                const transferredWeeklyOff = holidays.some(h =>
                    normalizeDateKey(h.transfer_date) === dateKey &&
                    isHolidayForEmployee(h, row)
                );
                const weekdayName = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][date.getDay()];
                const isWeeklyOff = !transferredWeeklyOff && (
                    shiftDays.length > 0
                        ? !shiftDays.includes(weekdayName)
                        : date.getDay() === 0
                );

                if (isWeeklyOff) {
                    weeklyOffCount++;
                }
            }

            /* =====================================================
   HOLIDAY COUNT
===================================================== */

            const currentMonthKey =
                `${row.calendar_year}-${String(
                    row.month_no
                ).padStart(2, "0")}`;

            const transferredWeeklyOffForDate = (dateKey) => holidays.some(h =>
                normalizeDateKey(h.transfer_date) === dateKey &&
                isHolidayForEmployee(h, row)
            );

            const holidayDates = new Set();

            holidays.forEach((h) => {

                if (!h.holiday_date) {
                    return;
                }

                const holidayDate =
                    normalizeDateKey(
                        h.holiday_date
                    );

                if (!holidayDate) {
                    return;
                }

                /* ================= MONTH ================= */

                if (
                    !holidayDate.startsWith(
                        currentMonthKey
                    )
                ) {
                    return;
                }

                /* ================= JOINING DATE ================= */

                if (
                    normalizedDateMode === "joining" &&
                    row.date_of_joining
                ) {

                    const joiningDate =
                        normalizeDateKey(
                            row.date_of_joining
                        );

                    if (
                        joiningDate &&
                        holidayDate < joiningDate
                    ) {
                        return;
                    }
                }

                /* ================= INACTIVE DATE ================= */

                if (row.inactive_date) {

                    const inactiveDate =
                        normalizeDateKey(
                            row.inactive_date
                        );

                    if (
                        inactiveDate &&
                        holidayDate > inactiveDate
                    ) {
                        return;
                    }
                }

                /* ================= LOCATION ================= */

                if (
                    !isHolidayForEmployee(
                        h,
                        row
                    )
                ) {
                    return;
                }

                /* =================================================
                   SUNDAY IS ALREADY WEEKLY OFF
                   DON'T COUNT IT AS COMPANY HOLIDAY
                ================================================= */

                const holidayDateObject = new Date(`${holidayDate}T00:00:00Z`);
                const weekdayName = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][holidayDateObject.getUTCDay()];
                if (shiftDays.length > 0
                    ? !shiftDays.includes(weekdayName)
                    : holidayDateObject.getUTCDay() === 0) {
                    return;
                }

                holidayDates.add(
                    holidayDate
                );
            });

            const actualHolidayCount =
                holidayDates.size;

            /* =====================================================
               COMPANY WORKING DAYS
            ===================================================== */
            const companyWorkingDays =
                Math.max(
                    monthDays -
                    weeklyOffCount -
                    actualHolidayCount,
                    0
                );

            /* =====================================================
               FINAL ABSENT
            ===================================================== */
            const finalAbsent =
                Math.max(
                    companyWorkingDays -
                    Number(
                        row.present || 0
                    ) -
                    Number(
                        row.half_day || 0
                    ),
                    0
                );

            /* =====================================================
               SHIFT MINUTES
            ===================================================== */
            const shiftMinutes =
                calculateShiftMinutes(
                    row.start_time,
                    row.end_time
                );

            const companyTotalMinutes = companyWorkingDays * shiftMinutes;

            const companyHours =
                Math.floor(
                    companyTotalMinutes / 60
                );

            const companyMinutes = companyTotalMinutes % 60;

            /* =====================================================
               CREATE MONTH
            ===================================================== */
            if (!monthData) {
                const day = {};

                const inactiveDate =
                    row.inactive_date
                        ? new Date(
                            row.inactive_date
                        )
                        : null;

                if (inactiveDate) {
                    inactiveDate.setHours(
                        0,
                        0,
                        0,
                        0
                    );
                }

                const joiningDate =
                    row.date_of_joining
                        ? new Date(
                            row.date_of_joining
                        )
                        : null;

                if (joiningDate) {
                    joiningDate.setHours(
                        0,
                        0,
                        0,
                        0
                    );
                }

                for (
                    let i = 1;
                    i <= monthDays;
                    i++
                ) {
                    const currentDate =
                        new Date(
                            Number(
                                row.calendar_year
                            ),
                            Number(
                                row.month_no
                            ) - 1,
                            i
                        );

                    currentDate.setHours(
                        0,
                        0,
                        0,
                        0
                    );

                    const dateKey =
                        `${row.calendar_year}-${String(
                            row.month_no
                        ).padStart(
                            2,
                            "0"
                        )}-${String(i).padStart(
                            2,
                            "0"
                        )}`;

                    /* ================= AFTER INACTIVE ================= */
                    if (
                        inactiveDate &&
                        currentDate >
                        inactiveDate
                    ) {
                        day[dateKey] = {
                            status: "-"
                        };
                        continue;
                    }

                    /* ================= BEFORE JOINING ================= */
                    if (
                        normalizedDateMode ===
                        "joining" &&
                        joiningDate &&
                        currentDate <
                        joiningDate
                    ) {
                        day[dateKey] = {
                            status: "-"
                        };
                        continue;
                    }

                    day[dateKey] = {
                        status: "absent"
                    };
                }

                monthData = {
                    month:
                        String(
                            row.month ||
                            ""
                        ).trim(),

                    month_no:
                        Number(
                            row.month_no
                        ),

                    calendar_year:
                        Number(
                            row.calendar_year
                        ),

                    total_days: companyWorkingDays,
                    calendar_days: monthDays,
                    weekly_off: weeklyOffCount,

                    present:
                        Number(
                            row.present || 0
                        ),

                    absent: finalAbsent,
                    company_holiday: actualHolidayCount,
                    total_hours: `${totalHours.toFixed(2)} h`,
                    total_minutes: totalMinutes,
                    company_total_hours:
                        `${companyHours}h ${String(
                            companyMinutes
                        ).padStart(
                            2,
                            "0"
                        )}m`,

                    company_total_minutes: companyTotalMinutes,

                    attendance_percentage:
                        `${(
                            companyWorkingDays === 0
                                ? 0
                                : (
                                    Number(
                                        row.present || 0
                                    ) /
                                    companyWorkingDays
                                ) * 100
                        ).toFixed(2)}%`,

                    full_leave: 0,
                    half_leave: 0,
                    day
                };

                employees[key]
                    .months
                    .push(
                        monthData
                    );

                /* ================= YEARLY TOTAL ================= */
                employees[key]
                    .yearly_total
                    .present +=
                    Number(
                        row.present || 0
                    );

                employees[key]
                    .yearly_total
                    .absent +=
                    finalAbsent;

                employees[key]
                    .yearly_total
                    .company_holiday +=
                    actualHolidayCount;

                employees[key]
                    .yearly_total
                    .total_minutes +=
                    totalMinutes;

                employees[key]
                    .yearly_total
                    .company_total_minutes +=
                    companyTotalMinutes;
            }

            /* =====================================================
               ATTENDANCE
            ===================================================== */
            if (
                row.attendance_date
            ) {
                const attendanceDate =
                    normalizeDateKey(
                        row.attendance_date
                    );

                if (
                    attendanceDate
                ) {
                    const seconds =
                        Number(
                            row.duration_seconds ||
                            0
                        );

                    if (
                        monthData.day[
                            attendanceDate
                        ]?.status !== "-"
                    ) {
                        const existingDay =
                            monthData.day[
                            attendanceDate
                            ] || {
                                status: "absent"
                            };

                        monthData.day[
                            attendanceDate
                        ] = {
                            ...existingDay,
                            status: row.attendance_status || "present",
                            entry_at: row.entry_at || null,
                            exit_at: row.exit_at || null,

                            duration: {
                                hours:
                                    Math.floor(
                                        seconds /
                                        3600
                                    ),

                                minutes:
                                    Math.floor(
                                        (
                                            seconds %
                                            3600
                                        ) / 60
                                    ),

                                seconds: seconds % 60
                            }
                        };
                    }
                }
            }

            /* =====================================================
               LEAVE
            ===================================================== */
            leaveRows
                .filter(
                    leave =>
                        String(leave.username || "")
                            .trim()
                            .toLowerCase() ===
                        String(row.username || "")
                            .trim()
                            .toLowerCase()
                )
                .forEach((leave) => {
                    const leaveStart = normalizeDateKey(
                        leave.start_leave_date
                    );
                    const leaveEnd = normalizeDateKey(
                        leave.end_leave_date
                    );

                    if (!leaveStart || !leaveEnd) {
                        return;
                    }

                    const monthKey =
                        `${row.calendar_year}-${String(row.month_no).padStart(2, "0")}`;
                    const monthStart = `${monthKey}-01`;
                    const [monthYear, monthNumber] = monthKey.split("-").map(Number);
                    const monthEnd = new Date(
                        Date.UTC(monthYear, monthNumber, 0)
                    ).toISOString().slice(0, 10);
                    const visibleStart = leaveStart < monthStart
                        ? monthStart
                        : leaveStart;
                    const visibleEnd = leaveEnd > monthEnd
                        ? monthEnd
                        : leaveEnd;

                    if (visibleStart > visibleEnd) {
                        return;
                    }

                    getDateKeysInRange(visibleStart, visibleEnd).forEach(
                        (leaveDate) => {

                        /* ================= YEAR ================= */
                        if (
                            normalizedDateMode ===
                            "joining"
                        ) {
                            if (
                                !leaveDate.startsWith(
                                    `${year}-`
                                )
                            ) {
                                return;
                            }

                        } else {
                            const fyStart = `${year}-04-01`;
                            const fyEnd = `${Number(year) + 1}-04-01`;

                            if (
                                leaveDate <
                                fyStart ||
                                leaveDate >=
                                fyEnd
                            ) {
                                return;
                            }
                        }

                        /* ================= JOINING ================= */
                        if (
                            normalizedDateMode ===
                            "joining" &&
                            row.date_of_joining
                        ) {

                            const joiningDate =
                                normalizeDateKey(
                                    row.date_of_joining
                                );

                            if (
                                joiningDate &&
                                leaveDate <
                                joiningDate
                            ) {
                                return;
                            }
                        }

                        /* ================= INACTIVE ================= */
                        if (
                            row.inactive_date
                        ) {
                            const inactiveDate =
                                normalizeDateKey(
                                    row.inactive_date
                                );

                            if (
                                inactiveDate &&
                                leaveDate >
                                inactiveDate
                            ) {
                                return;
                            }
                        }

                        const weekday = new Date(`${leaveDate}T00:00:00Z`).getUTCDay();
                        const weekdayName =
                            ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][weekday];
                        const isHoliday = holidays.some(h =>
                            normalizeDateKey(h.holiday_date) === leaveDate &&
                            isHolidayForEmployee(h, row)
                        );
                        const isTransferredWeeklyOff = holidays.some(h =>
                            normalizeDateKey(h.transfer_date) === leaveDate &&
                            isHolidayForEmployee(h, row)
                        );
                        const isWeeklyOff = !isTransferredWeeklyOff && (
                            shiftDays.length > 0
                                ? !shiftDays.includes(weekdayName)
                                : weekday === 0
                        );

                        if (isHoliday || isWeeklyOff) {
                            return;
                        }

                        /* ================= LEAVE TYPE ================= */
                        const leaveType =
                            String(
                                leave.leave_type ||
                                ""
                            )
                                .trim()
                                .toLowerCase();

                        const isHalfLeave =
                            leaveType.includes(
                                "half"
                            ) ||
                            leaveType ===
                            "morning" ||
                            leaveType ===
                            "evening" ||
                            leaveType.includes(
                                "half-day"
                            ) ||
                            leaveType.includes(
                                "half day"
                            );

                        const leaveStatus =
                            isHalfLeave
                                ? "half_leave"
                                : "full_leave";

                        const existingDay =
                            monthData.day[
                            leaveDate
                            ];

                        monthData.day[
                            leaveDate
                        ] = {
                            status: leaveStatus,
                            leave_type: leave.leave_type || null,
                            reason: leave.reason || null,
                            description: leave.description || null,

                            ...(existingDay?.entry_at
                                ? {
                                    entry_at:
                                        existingDay.entry_at
                                }
                                : {}),

                            ...(existingDay?.exit_at
                                ? {
                                    exit_at:
                                        existingDay.exit_at
                                }
                                : {}),

                            ...(existingDay?.duration
                                ? {
                                    duration:
                                        existingDay.duration
                                }
                                : {})
                        };
                    });
                });

            /* =====================================================
               RECALCULATE LEAVE
            ===================================================== */
            let fullLeaveCount = 0;
            let halfLeaveCount = 0;

            Object.values(
                monthData.day
            ).forEach(
                (day) => {
                    if (
                        day.status === "full_leave"
                    ) {
                        fullLeaveCount++;
                    }

                    if (
                        day.status === "half_leave"
                    ) {
                        halfLeaveCount++;
                    }
                }
            );

            monthData.full_leave = fullLeaveCount;
            monthData.half_leave = halfLeaveCount;

            /* =====================================================
   HOLIDAY
===================================================== */

            holidays.forEach((h) => {

                if (!h.holiday_date) {
                    return;
                }

                const holidayDate =
                    normalizeDateKey(
                        h.holiday_date
                    );

                if (!holidayDate) {
                    return;
                }

                /* ================= MONTH ================= */

                if (
                    !holidayDate.startsWith(
                        currentMonthKey
                    )
                ) {
                    return;
                }

                /* ================= JOINING ================= */

                if (
                    normalizedDateMode === "joining" &&
                    row.date_of_joining
                ) {

                    const joiningDate =
                        normalizeDateKey(
                            row.date_of_joining
                        );

                    if (
                        joiningDate &&
                        holidayDate < joiningDate
                    ) {
                        return;
                    }
                }

                /* ================= INACTIVE ================= */

                if (row.inactive_date) {

                    const inactiveDate =
                        normalizeDateKey(
                            row.inactive_date
                        );

                    if (
                        inactiveDate &&
                        holidayDate > inactiveDate
                    ) {
                        return;
                    }
                }

                /* ================= LOCATION ================= */

                if (
                    !isHolidayForEmployee(
                        h,
                        row
                    )
                ) {
                    return;
                }

                const existingDay =
                    monthData.day[
                    holidayDate
                    ];

                /* ================= LEAVE ================= */

                if (
                    existingDay?.status === "full_leave" ||
                    existingDay?.status === "half_leave"
                ) {
                    return;
                }

                /* ================= ATTENDANCE ================= */

                if (
                    existingDay?.entry_at
                ) {
                    return;
                }

                /* ================= BEFORE JOINING / INACTIVE ================= */

                if (
                    existingDay?.status === "-"
                ) {
                    return;
                }

                /* ================= HOLIDAY ================= */

                monthData.day[
                    holidayDate
                ] = {
                    status: "holiday",
                    holiday_name:
                        h.holiday_name || null
                };
            });

            /* =====================================================
               WEEKLY OFF
            ===================================================== */
            const inactiveDate =
                row.inactive_date
                    ? new Date(
                        row.inactive_date
                    )
                    : null;

            if (
                inactiveDate
            ) {
                inactiveDate.setHours(
                    0,
                    0,
                    0,
                    0
                );
            }

            const joiningDate =
                row.date_of_joining
                    ? new Date(
                        row.date_of_joining
                    )
                    : null;

            if (
                joiningDate
            ) {
                joiningDate.setHours(
                    0,
                    0,
                    0,
                    0
                );
            }

            for (
                let i = 1;
                i <= monthDays;
                i++
            ) {
                const date =
                    new Date(
                        Number(
                            row.calendar_year
                        ),
                        Number(
                            row.month_no
                        ) - 1,
                        i
                    );

                date.setHours(
                    0,
                    0,
                    0,
                    0
                );

                if (
                    inactiveDate &&
                    date >
                    inactiveDate
                ) {
                    continue;
                }

                if (
                    normalizedDateMode ===
                    "joining" &&
                    joiningDate &&
                    date <
                    joiningDate
                ) {
                    continue;
                }

                const dateKey =
                    `${row.calendar_year}-${String(
                        row.month_no
                    ).padStart(
                        2,
                        "0"
                    )}-${String(i).padStart(
                        2,
                        "0"
                    )}`;

                /* =====================================================
   WEEKLY OFF
===================================================== */

                const transferredWeeklyOff =
                    transferredWeeklyOffForDate(dateKey);
                const weekdayName =
                    ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][date.getDay()];
                const isWeeklyOff = !transferredWeeklyOff && (
                    shiftDays.length > 0
                        ? !shiftDays.includes(weekdayName)
                        : date.getDay() === 0
                );

                if (
                    isWeeklyOff &&
                    monthData.day[
                    dateKey
                    ] &&
                    monthData.day[
                        dateKey
                    ].status === "absent"
                ) {
                    monthData.day[
                        dateKey
                    ] = {
                        status: "weekly_off"
                    };
                }
            }

            /* =====================================================
               YEARLY LEAVE COUNT
            ===================================================== */
            if (
                !monthData._yearlyLeaveCounted
            ) {
                employees[key]
                    .yearly_total
                    .full_leave +=
                    fullLeaveCount;

                employees[key]
                    .yearly_total
                    .half_leave +=
                    halfLeaveCount;

                monthData._yearlyLeaveCounted = true;
            }
        });

        /* =========================================================
           FINAL EMPLOYEE TOTALS
        ========================================================= */
        const employeeList =
            Object.values(
                employees
            );

        employeeList.forEach(
            (emp) => {
                emp.months.forEach(
                    (month) => {

                        delete month
                            ._yearlyLeaveCounted;
                    }
                );

                const totalMinutes =
                    Number(
                        emp.yearly_total
                            .total_minutes ||
                        0
                    );

                emp.yearly_total.total_hours =
                    `${(
                        totalMinutes / 60
                    ).toFixed(2)} h`;

                const companyTotalMinutes =
                    Math.round(
                        Number(
                            emp.yearly_total
                                .company_total_minutes ||
                            0
                        )
                    );

                const companyHours =
                    Math.floor(
                        companyTotalMinutes /
                        60
                    );

                const companyMinutes =
                    companyTotalMinutes %
                    60;

                emp.yearly_total.company_total_hours =
                    `${companyHours}h ${String(
                        companyMinutes
                    ).padStart(
                        2,
                        "0"
                    )}m`;

                const present =
                    Number(
                        emp.yearly_total
                            .present ||
                        0
                    );

                const absent =
                    Number(
                        emp.yearly_total
                            .absent ||
                        0
                    );

                const workingDays =
                    present +
                    absent;

                const attendancePercentage =
                    workingDays === 0
                        ? 0
                        : (
                            present /
                            workingDays
                        ) * 100;

                emp.yearly_total
                    .attendance_percentage =
                    `${attendancePercentage.toFixed(
                        2
                    )}%`;
            }
        );

        /* =========================================================
           PAGINATION
        ========================================================= */
        const currentPage = Number(page) || 1;
        const perPage = Number(limit) || 20;
        const total = employeeList.length;

        const totalPages =
            Math.ceil(
                total / perPage
            );

        const paginatedEmployees =
            employeeList.slice(
                (
                    currentPage - 1
                ) * perPage,
                currentPage *
                perPage
            );

        const pagination = {
            enabled: true,
            total,
            page: currentPage,
            limit: perPage,
            totalPages
        };

        /* =========================================================
           SOCKET
        ========================================================= */
        const io = getIO();

        if (io) {
            io.emit(
                "attendance:record",
                {
                    success: true,
                    message: "Attendance record updated",
                    data: employeeList
                }
            );
        }

        /* =========================================================
           RESPONSE
        ========================================================= */
        return res.status(200).json({
            success: true,
            message: "Yearly attendance fetched successfully",
            data: paginatedEmployees,
            pagination
        });

    } catch (error) {
        console.log("YEARLY ATTENDANCE ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= GET EMPLOYEE ATTENDANCE RECORD BY USERNAME ================= */
export const getEmployeeAttendanceRecordByUsername = async (req, res) => {
    try {
        const { username } = req.params;

        // Reuse the existing controller by injecting username
        req.query.username = username;

        return getEmployeeAttendanceRecord(req, res);

    } catch (error) {
        console.error("GET ATTENDANCE BY USERNAME ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};