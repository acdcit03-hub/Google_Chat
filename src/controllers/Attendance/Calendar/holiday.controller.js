import { createHolidayModel, deleteHolidayModel, getAllHolidaysModel, getAttendanceCountByDayModel, getHolidayByIdModel, getHolidayByUsernameModel, getHolidaysByMonthModel, getEmployeeCountByDateModel, transferHolidayModel, updateHolidayModel, getShiftDaysModel, checkDuplicateHolidayModel, getUpcomingHolidaysModel } from "../../../models/Attendance/Calendar/holiday.model.js";
import { getLeavesModel } from "../../../models/Attendance/EmployeeRecord/EmployeeLeaves.model.js";
import { addCalendarEditLogModel } from "../../../models/history/calendar_log.model.js";
import { getMeetingScheduleByMonthModel, getMeetingScheduleByUsername } from "../../../models/MeetingSchedule/meetingSchedule.models.js";
import { getIO } from "../../../config/socket.js";

/* =========================================================
   GET CURRENT USER
========================================================= */
const getEditedBy = (req) => {
    return req.headers["x-username"]
        ? String(req.headers["x-username"]).trim()
        : null;
};

export const getDatesInRange = (startDate, endDate) => {
    const dates = [];
    let cursor = new Date(`${startDate}T00:00:00Z`);
    const end = new Date(`${endDate}T00:00:00Z`);

    while (cursor <= end) {
        dates.push(cursor.toISOString().slice(0, 10));

        cursor = new Date(cursor.getTime() + 86400000);
    }

    return dates;
};

const formatLeavePolicy = (value) => {
    let policy = value;

    if (typeof policy === "string") {
        try {
            policy = JSON.parse(policy);
        } catch {
            policy = null;
        }
    }

    return {
        prior_days_given: policy?.prior_days_given ?? null,
        prior_days_required: policy?.prior_days_required ?? null,
        is_prior_days_compliant: policy?.is_prior_days_compliant ?? null
    };
};

/* =========================================================
   CREATE HOLIDAY
========================================================= */
export const createHoliday = async (req, res) => {
    try {

        const editedBy = getEditedBy(req);

        const {
            holiday_name,
            holiday_date,
            transfer_date,
            locations
        } = req.body;

        /* ================= DUPLICATE HOLIDAY VALIDATION ================= */
        const existingHoliday = await checkDuplicateHolidayModel({
            holiday_name,
            holiday_date,
            locations
        });

        if (existingHoliday) {
            return res.status(400).json({
                success: false,
                message: `Holiday already exists: ${existingHoliday.holiday_name} on ${existingHoliday.holiday_date}`,
                data: existingHoliday
            });
        }

        /* ================= CREATE HOLIDAY ================= */
        const data = await createHolidayModel({
            holiday_name,
            holiday_date,
            transfer_date,
            locations,
            created_by: editedBy
        });

        if (!data) {
            return res.status(400).json({
                success: false,
                message: "Holiday could not be created"
            });
        }

        /* ================= FORMAT DATE ================= */
        if (data.holiday_date) {
            data.holiday_date =
                new Date(data.holiday_date)
                    .toISOString()
                    .split("T")[0];
        }

        /* ================= CALENDAR LOG ================= */
        const calendarLog = await addCalendarEditLogModel({
            table_name: "holidays",
            record_id: Number(data.id),
            username: data.created_by || editedBy,
            edited_by: editedBy,
            action: "CREATE",
            field_name: "holidays",
            old_value: null,
            new_value: data,
            calendar_date: data.holiday_date,
            description: `Holiday created: ${data.holiday_name}`
        });

        const io = getIO();
        if (io) {
            io.emit("holiday:created", {
                success: true,
                message: "Holiday created successfully",
                data
            });
        }

        return res.status(201).json({
            success: true,
            message: "Holiday created successfully",
            data,
            calendarLog
        });

    } catch (error) {
        console.error("CREATE HOLIDAY ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= GET HOLIDAYS ================= */
export const getAllHolidays = async (req, res) => {
    try {
        const data = await getAllHolidaysModel();

        return res.status(200).json({
            success: true,
            message: "Holiday fetched successfully",
            data
        });

    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= GET UPCOMING HOLIDAYS ================= */
export const getUpcomingHolidays = async (req, res) => {
    try {
        const {
            work_location
        } = req.query;

        const holidays = await getUpcomingHolidaysModel({
            work_location
        });

        const formatDisplayDate = value => {
            if (!value) {
                return null;
            }

            const [year, month, day] = String(value).slice(0, 10).split("-");
            return `${day}/${month}/${year}`;
        };
        const data = holidays.map(holiday => ({
            id: holiday.id,
            holiday_name: holiday.holiday_name,
            holiday_date: holiday.holiday_date,
            transfer_date: holiday.transfer_date,
            display_date: formatDisplayDate(holiday.display_date),
            display_transfer_from: formatDisplayDate(
                holiday.display_transfer_from
            ),
            locations: holiday.locations
        }));

        return res.status(200).json({
            success: true,
            message: "Upcoming holidays fetched successfully",
            data
        });

    } catch (error) {
        console.error("GET UPCOMING HOLIDAYS ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= GET HOLIDAY BY USERNAME ================= */
export const getHolidayByUsername = async (req, res) => {
    try {
        const { username } = req.params;

        const data = await getHolidayByUsernameModel(username);

        if (data.length === 0) {
            return res.status(404).json({
                success: false,
                message: "No holidays found for this user"
            });
        }

        return res.status(200).json({
            success: true,
            message: "Holidays fetched successfully",
            data
        });

    } catch (error) {
        console.error("GET HOLIDAY BY USERNAME ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

const getCalendarDayStatus = (dateObj, holiday, transferHoliday, shiftDays, weekdayNames) => {
    const currentDayName = weekdayNames[dateObj.getDay()];

    if (holiday) {
        return { is_weekly_off: false, is_working_day: false, day_status: "holiday" };
    }

    if (transferHoliday) {
        return { is_weekly_off: false, is_working_day: true, day_status: "working_day_override" };
    }

    if (
        (shiftDays.length > 0 && !shiftDays.includes(currentDayName)) ||
        (shiftDays.length === 0 && dateObj.getDay() === 0)
    ) {
        return { is_weekly_off: true, is_working_day: false, day_status: "weekly_off" };
    }

    return { is_weekly_off: false, is_working_day: true, day_status: "working_day" };
};

const doesHolidayApplyToLeave = (holiday, leave) => {
    if (!holiday) {
        return false;
    }

    const locationIds = Array.isArray(holiday.location_ids)
        ? holiday.location_ids.map(String)
        : [];
    const locationNames = Array.isArray(holiday.locations)
        ? holiday.locations.map(value => String(value).trim().toLowerCase())
        : [];

    if (locationIds.length === 0 && locationNames.length === 0) {
        return true;
    }

    return locationIds.includes(String(leave.work_location_id ?? "")) ||
        locationNames.includes(
            String(leave.work_location || "").trim().toLowerCase()
        );
};

const getLeavesForWorkingDay = (leaves, date, holiday, transferHoliday) => {
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const weekdayNames = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

    return leaves.filter(leave => {
        const shiftDays = Array.isArray(leave.shift_days)
            ? leave.shift_days.map(day => String(day).trim().toUpperCase())
            : [];
        const isWeeklyOff = !doesHolidayApplyToLeave(transferHoliday, leave) && (
            shiftDays.length > 0
                ? !shiftDays.includes(weekdayNames[weekday])
                : weekday === 0
        );

        if (isWeeklyOff) {
            return false;
        }

        return !doesHolidayApplyToLeave(holiday, leave);
    });
};

/* ================= GET CALENDAR ================= */
export const getCalendar = async (req, res) => {
    try {
        const {
            year,
            month,
            work_location,
            department,
            shift_name,
            shift_type
        } = req.query;

        const selectedYear = Number(year);
        const selectedMonth = Number(month);

        /* ================= SHIFT DAYS ================= */
        const selectedShift = await getShiftDaysModel(shift_name);

        let shiftDays = [];

        if (selectedShift?.days) {
            shiftDays = selectedShift.days
                .map(day =>
                    String(day)
                        .trim()
                        .toUpperCase()
                );
        }

        /* =========================================================
           DAYS IN SELECTED MONTH
        ========================================================= */
        const daysInMonth = new Date(
            selectedYear,
            selectedMonth,
            0
        ).getDate();

        const startDate = `${selectedYear}-${String(selectedMonth).padStart(2, "0")}-01`;
        const endDate = `${selectedYear}-${String(selectedMonth).padStart(2, "0")}-${String(daysInMonth).padStart(2, "0")}`;

        /* ================= HOLIDAYS ================= */
        const holidays = await getHolidaysByMonthModel(
            selectedYear,
            selectedMonth,
            work_location,
            department
        );

        /* ================= LEAVES ================= */
        const leaveResult = await getLeavesModel({
            startDate,
            endDate,
            work_location,
            department,
            shift_name,
            shift_type,
            pagination: false
        });
        const leaves = Array.isArray(leaveResult?.data)
            ? leaveResult.data
            : [];

        /* ================= MEETINGS ================= */
        const meetings = await getMeetingScheduleByMonthModel(
            selectedYear,
            selectedMonth,
            work_location
        );

        /* ================= HOLIDAY MAP ================= */
        const holidayMap = {};
        const transferHolidayMap = {};

        holidays.forEach((h) => {
            if (h.holiday_date) {
                holidayMap[h.holiday_date] = {
                    id: h.id,
                    name: h.holiday_name,
                    original_date: h.holiday_date,
                    transfer_date: h.transfer_date,
                    locations: h.location_names || [],
                    location_ids: h.location_ids || []
                };
            }

            if (h.transfer_date) {
                transferHolidayMap[h.transfer_date] = {
                    id: h.id,
                    name: h.holiday_name,
                    original_date: h.holiday_date,
                    transfer_date: h.transfer_date,
                    locations: h.locations,
                    location_ids: h.location_ids
                };
            }
        });

        /* ================= LEAVE MAP ================= */
        const leaveMap = {};

        leaves.forEach((l) => {
            const rangeStart = String(l.start_leave_date).slice(0, 10);
            const rangeEnd = String(l.end_leave_date).slice(0, 10);

            for (const calendarDate of getDatesInRange(rangeStart, rangeEnd)) {
                if (!leaveMap[calendarDate]) {
                    leaveMap[calendarDate] = [];
                }

                leaveMap[calendarDate].push({
                    username: l.username,
                    employee_name: [
                        l.first_name,
                        l.middle_name,
                        l.last_name
                    ]
                        .filter(Boolean)
                        .join(" "),
                    start_leave_date: rangeStart,
                    end_leave_date: rangeEnd,
                    leave_start_time: l.leave_start_time || null,
                    leave_end_time: l.leave_end_time || null,
                    inform_date: l.inform_date
                        ? String(l.inform_date).slice(0, 10)
                        : null,
                    medium: l.medium || null,
                    leave_policy: formatLeavePolicy(l.leave_policy),
                    calendar_date: calendarDate,
                    work_location: l.work_location,
                    location_id: l.location_id,
                    leave_type: l.leave_type,
                    reason: l.reason,
                    description: l.description,
                    rejected_reason: l.rejected_reason,
                    document: l.document
                });
            }
        });

        /* ================= MEETING MAP ================= */
        const meetingMap = {};

        meetings.forEach((meeting) => {
            const meetingDate = String(meeting.schedule_date).substring(0, 10);

            if (!meetingMap[meetingDate]) {
                meetingMap[meetingDate] = [];
            }

            meetingMap[meetingDate].push({
                id: meeting.id,
                candidate_id: meeting.candidate_id,
                candidate_username: meeting.candidate_username,
                first_name: meeting.first_name || null,
                middle_name: meeting.middle_name || null,
                last_name: meeting.last_name || null,
                candidate_full_name: meeting.candidate_full_name,
                schedule_date: meetingDate,
                start_time: meeting.start_time,
                end_time: meeting.end_time,
                scheduled_person_name: meeting.scheduled_person_name,
                conduct_person_name: meeting.conduct_person_name,
                meeting_status: meeting.meeting_status,
                meeting_cancelled_reason:
                    meeting.meeting_cancelled_reason ||
                    meeting.cancelled_meeting_reason ||
                    null,
                cancelled_meeting_id: meeting.cancelled_meeting_id,
                cancelled_meeting_reason: meeting.cancelled_meeting_reason,
                meeting_type: meeting.meeting_type,
                note: meeting.note,
                resume: meeting.resume,
                work_location_id: meeting.work_location_id,
                work_location: meeting.work_location,
                is_pending: Boolean(meeting.is_pending)
            });
        });

        /* ================= TOTAL EMPLOYEES ================= */
        const employeeCounts = await getEmployeeCountByDateModel(
            selectedYear,
            selectedMonth,
            work_location,
            shift_name,
            shift_type,
            null,
            department
        );

        const employeeCountMap = {};

        employeeCounts.forEach((item) => {
            const dateKey =
                item.attendance_date instanceof Date
                    ? item.attendance_date
                        .toISOString()
                        .split("T")[0]
                    : String(item.attendance_date)
                        .split("T")[0];

            employeeCountMap[dateKey] = Number(item.total_employees || 0);
        });

        /* ================= ATTENDANCE ================= */
        const attendanceCounts = await getAttendanceCountByDayModel(
            selectedYear,
            selectedMonth,
            work_location,
            shift_name,
            shift_type,
            null,
            department
        );

        const attendanceMap = {};
        const leavePresentMap = {};

        attendanceCounts.forEach((item) => {
            attendanceMap[item.day] = Number(item.total_present || 0);
            leavePresentMap[item.day] = Number(item.leave_present || 0);
        });

        /* ================= TODAY ================= */
        const today =
            new Date()
                .toLocaleDateString("en-CA", {
                    timeZone: "Asia/Kolkata"
                });

        const calendar = [];

        let totalWorkingDays = 0;
        let totalPresent = 0;
        let totalAbsent = 0;

        /* =========================================================
           WEEK DAY NAMES
        ========================================================= */
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
           LOOP ONLY ACTUAL DAYS OF SELECTED MONTH
        ========================================================= */
        for (
            let day = 1;
            day <= daysInMonth;
            day++
        ) {
            const mm = String(selectedMonth).padStart(2, "0");
            const dd = String(day).padStart(2, "0");
            const dateStr = `${selectedYear}-${mm}-${dd}`;
            const dateObj = new Date(`${dateStr}T00:00:00`);
            const holiday = holidayMap[dateStr] || null;
            const transferHoliday = transferHolidayMap[dateStr] || null;

            const { is_weekly_off, is_working_day, day_status } =
                getCalendarDayStatus(dateObj, holiday, transferHoliday, shiftDays, weekdayNames);

            const dayPresent = attendanceMap[day] || 0;
            const leavePresent = leavePresentMap[day] || 0;

            let dayAbsent = 0;

            const totalEmployees = employeeCountMap[dateStr] || 0;
            const currentDate = new Date(today);
            const calendarDate = new Date(dateStr);

            /* ================= WORKING DAY ================= */
            if (is_working_day) {
                totalWorkingDays++;
                if (calendarDate <= currentDate) {
                    dayAbsent =
                        Math.max(
                            totalEmployees -
                            dayPresent +
                            leavePresent,
                            0
                        );

                    totalPresent += dayPresent;
                    totalAbsent += dayAbsent;
                }
            }

            /* ================= CALENDAR DATA ================= */
            calendar.push({
                date: dateStr,
                day,
                dayName:
                    dateObj.toLocaleDateString(
                        "en-US",
                        {
                            weekday: "short"
                        }
                    ),

                isCurrentMonth: true,
                isToday: dateStr === today,
                holiday,
                is_weekly_off,
                is_working_day,
                day_status,
                total_employees: totalEmployees,
                total_present: dayPresent,
                total_absent: dayAbsent,
                leaves: getLeavesForWorkingDay(
                    leaveMap[dateStr] || [],
                    dateStr,
                    holiday,
                    transferHoliday
                ),
                meetings: meetingMap[dateStr] || []
            });
        }

        /* ================= RESPONSE ================= */
        return res.status(200).json({
            success: true,
            data: {
                month: selectedMonth,
                year: selectedYear,
                days_in_month: daysInMonth,
                total_working_days: totalWorkingDays,
                calendar
            }
        });

    } catch (error) {
        console.error("GET CALENDAR ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* =========================================================
   GET USER CALENDAR
========================================================= */
const validateUserCalendarRequest = (username, query) => {
    if (!username || String(username).trim() === "") {
        return { error: "Username is required" };
    }

    const { year, month } = query;
    if (year === undefined || year === null || String(year).trim() === "") {
        return { error: "year is required" };
    }
    if (month === undefined || month === null || String(month).trim() === "") {
        return { error: "month is required" };
    }

    const selectedYear = Number(year);
    const selectedMonth = Number(month);
    if (!Number.isInteger(selectedYear)) {
        return { error: "Invalid year" };
    }
    if (!Number.isInteger(selectedMonth)) {
        return { error: "Invalid month" };
    }
    if (selectedMonth < 1 || selectedMonth > 12) {
        return { error: "Month must be between 1 and 12" };
    }

    return { username: String(username).trim(), year: selectedYear, month: selectedMonth };
};

const createUserCalendarDay = (day, options) => {
    const {
        year, month, shiftDays, holidayMap, transferHolidayMap,
        attendanceMap, leavePresentMap, leaveMap, meetingMap, today
    } = options;
    const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const dateObj = new Date(`${dateStr}T00:00:00`);
    const holiday = holidayMap[dateStr] || null;
    const transferHoliday = transferHolidayMap[dateStr] || null;
    const weekdayNames = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
    const currentDayName = weekdayNames[dateObj.getDay()];

    let is_weekly_off = false;
    let is_working_day = true;
    let day_status = "working_day";

    if (holiday) {
        is_working_day = false;
        day_status = "holiday";
    } else if (transferHoliday) {
        day_status = "working_day_override";
    } else if (
        (shiftDays.length > 0 && !shiftDays.includes(currentDayName)) ||
        (shiftDays.length === 0 && dateObj.getDay() === 0)
    ) {
        is_weekly_off = true;
        is_working_day = false;
        day_status = "weekly_off";
    }

    const is_present = is_working_day && new Date(dateStr) <= new Date(today) &&
        (Number(attendanceMap[day] || 0) > 0 || Number(leavePresentMap[day] || 0) > 0);

    return {
        is_working_day,
        calendarDay: {
            date: dateStr,
            day,
            dayName: dateObj.toLocaleDateString("en-US", { weekday: "short" }),
            isCurrentMonth: true,
            isToday: dateStr === today,
            holiday,
            is_weekly_off,
            is_working_day,
            day_status,
            is_present,
            leaves: getLeavesForWorkingDay(
                leaveMap[dateStr] || [],
                dateStr,
                holiday,
                transferHoliday
            ),
            meetings: meetingMap[dateStr] || []
        }
    };
};

const buildUserCalendar = (daysInMonth, options) => {
    const calendar = [];
    let totalWorkingDays = 0;
    for (let day = 1; day <= daysInMonth; day++) {
        const result = createUserCalendarDay(day, options);
        calendar.push(result.calendarDay);
        if (result.is_working_day) totalWorkingDays++;
    }
    return { calendar, totalWorkingDays };
};

export const getCalendarByUsername = async (req, res) => {
    try {
        const { username } = req.params;

        /* ================= QUERY ================= */
        const {
            work_location,
            department,
            shift_name,
            shift_type
        } = req.query;

        const validated = validateUserCalendarRequest(username, req.query);
        if (validated.error) {
            return res.status(400).json({
                success: false,
                message: validated.error
            });
        }
        const selectedUsername = validated.username;
        const selectedYear = validated.year;
        const selectedMonth = validated.month;

        /* =====================================================
           SHIFT DAYS
        ===================================================== */
        const selectedShift = await getShiftDaysModel(
            shift_name
        );

        let shiftDays = [];

        if (selectedShift?.days) {
            shiftDays =
                selectedShift.days.map(day =>
                    String(day)
                        .trim()
                        .toUpperCase()
                );
        }

        /* =====================================================
           DAYS IN MONTH
        ===================================================== */
        const daysInMonth =
            new Date(
                selectedYear,
                selectedMonth,
                0
            ).getDate();

        /* =====================================================
           DATE RANGE
        ===================================================== */
        const startDate = `${selectedYear}-${String(selectedMonth).padStart(2, "0")}-01`;
        const endDate = `${selectedYear}-${String(selectedMonth).padStart(2, "0")}-${String(daysInMonth).padStart(2, "0")}`;

        /* =====================================================
           HOLIDAYS
        ===================================================== */
        const holidays = await getHolidaysByMonthModel(
            selectedYear,
            selectedMonth,
            work_location,
            department
        );

        /* =====================================================
           LEAVES — USER SPECIFIC
        ===================================================== */
        const leaveResult = await getLeavesModel({
            username: department ? null : selectedUsername,
            startDate,
            endDate,
            work_location,
            department,
            shift_name,
            shift_type,
            pagination: false
        });
        const leaves = Array.isArray(leaveResult?.data)
            ? leaveResult.data
            : [];

        /* =====================================================
           MEETINGS — USER / DEPARTMENT SPECIFIC
        ===================================================== */
        const hasDepartmentFilter =
            department !== null &&
            department !== undefined &&
            String(department).trim() !== "" &&
            String(department).trim().toLowerCase() !== "all";

        const meetings = await getMeetingScheduleByUsername(
            hasDepartmentFilter ? null : selectedUsername,
            selectedYear,
            selectedMonth,
            work_location,
            hasDepartmentFilter ? department : null
        );

        /* =====================================================
           HOLIDAY MAP
        ===================================================== */
        const holidayMap = {};
        const transferHolidayMap = {};

        holidays.forEach((h) => {
            if (h.holiday_date) {
                holidayMap[h.holiday_date] = {
                    id: h.id,
                    name: h.holiday_name,
                    original_date: h.holiday_date,
                    transfer_date: h.transfer_date,
                    locations: h.locations,
                    location_ids: h.location_ids
                };
            }

            if (h.transfer_date) {
                transferHolidayMap[h.transfer_date] = {
                    id: h.id,
                    name: h.holiday_name,
                    original_date: h.holiday_date,
                    transfer_date: h.transfer_date,
                    locations: h.locations,
                    location_ids: h.location_ids
                };
            }
        });

        /* =====================================================
           LEAVE MAP
        ===================================================== */

        const leaveMap = {};

        leaves.forEach((l) => {
            const rangeStart = String(l.start_leave_date).slice(0, 10);
            const rangeEnd = String(l.end_leave_date).slice(0, 10);

            for (const calendarDate of getDatesInRange(rangeStart, rangeEnd)) {
                if (!leaveMap[calendarDate]) {
                    leaveMap[calendarDate] = [];
                }

                leaveMap[calendarDate].push({
                    id: l.id,
                    username: l.username,
                    start_leave_date: rangeStart,
                    end_leave_date: rangeEnd,
                    calendar_date: calendarDate,
                    inform_date: l.inform_date,
                    medium: l.medium,
                    leave_type: l.leave_type,
                    leave_start_time: l.leave_start_time,
                    leave_end_time: l.leave_end_time,
                    description: l.description,
                    reason: l.reason,
                    rejected_reason: l.rejected_reason,
                    document: l.document,
                    days_before_leave: l.days_before_leave,
                    status: l.status,
                    leave_policy: l.leave_policy,
                    created_at: l.created_at,
                    updated_at: l.updated_at,
                    first_name: l.first_name,
                    middle_name: l.middle_name,
                    last_name: l.last_name,
                    employee_name: [
                        l.first_name,
                        l.middle_name,
                        l.last_name
                    ]
                        .filter(Boolean)
                        .join(" "),
                    category_id: l.category_id,
                    category: l.category,
                    work_location_id: l.work_location_id,
                    work_location: l.work_location,
                    shift_id: l.shift_id,
                    shift_name: l.shift_name,
                    shift_type: l.shift_type,
                    employee_status: l.employee_status
                });
            }
        });

        /* =====================================================
           MEETING MAP
        ===================================================== */
        const meetingMap = {};

        meetings.forEach((meeting) => {
            const meetingDate =
                String(
                    meeting.schedule_date
                ).substring(0, 10);

            if (!meetingMap[meetingDate]) {
                meetingMap[meetingDate] = [];
            }

            meetingMap[meetingDate].push({
                id: meeting.id,
                candidate_id: meeting.candidate_id,
                candidate_username: meeting.candidate_username,
                candidate_full_name: meeting.candidate_full_name,
                schedule_date: meetingDate,
                start_time: meeting.start_time,
                end_time: meeting.end_time,
                scheduled_person_name: meeting.scheduled_person_name,
                conduct_person_name: meeting.conduct_person_name,
                meeting_status: meeting.meeting_status,
                meeting_cancelled_reason:
                    meeting.meeting_cancelled_reason ||
                    meeting.cancelled_meeting_reason ||
                    null,
                cancelled_meeting_id: meeting.cancelled_meeting_id,
                cancelled_meeting_reason: meeting.cancelled_meeting_reason,
                meeting_type: meeting.meeting_type,
                meeting_mode: meeting.meeting_mode,
                note: meeting.note,
                resume: meeting.resume,
                work_location_id: meeting.work_location_id,
                work_location: meeting.work_location,
                is_pending: Boolean(meeting.is_pending)
            });
        });

        /* =====================================================
           USER EMPLOYEE COUNT
        ===================================================== */
        const employeeCounts = await getEmployeeCountByDateModel(
            selectedYear,
            selectedMonth,
            work_location,
            shift_name,
            shift_type,
            selectedUsername,
            department
        );

        const employeeCountMap = {};

        employeeCounts.forEach((item) => {
            const dateKey =
                String(
                    item.attendance_date
                ).split("T")[0];

            employeeCountMap[dateKey] =
                Number(
                    item.total_employees || 0
                );
        });

        /* =====================================================
           USER ATTENDANCE COUNT
        ===================================================== */
        const attendanceCounts = await getAttendanceCountByDayModel(
            selectedYear,
            selectedMonth,
            work_location,
            shift_name,
            shift_type,
            selectedUsername,
            department
        );

        const attendanceMap = {};
        const leavePresentMap = {};

        attendanceCounts.forEach((item) => {
            attendanceMap[item.day] =
                Number(
                    item.total_present || 0
                );

            leavePresentMap[item.day] =
                Number(
                    item.leave_present || 0
                );
        });

        /* =====================================================
           TODAY
        ===================================================== */
        const today =
            new Date()
                .toLocaleDateString(
                    "en-CA",
                    {
                        timeZone: "Asia/Kolkata"
                    }
                );

        const { calendar, totalWorkingDays } = buildUserCalendar(daysInMonth, {
            year: selectedYear,
            month: selectedMonth,
            shiftDays,
            holidayMap,
            transferHolidayMap,
            attendanceMap,
            leavePresentMap,
            leaveMap,
            meetingMap,
            today
        });

        let totalPresent = 0;
        let totalAbsent = 0;

        /* =====================================================
           RESPONSE
        ===================================================== */
        return res.status(200).json({
            success: true,
            data: {
                username: selectedUsername,
                month: selectedMonth,
                year: selectedYear,
                days_in_month: daysInMonth,
                total_working_days: totalWorkingDays,
                total_present: totalPresent,
                total_absent: totalAbsent,
                calendar
            }
        });

    } catch (error) {
        console.error("GET USER CALENDAR ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* =========================================================
   UPDATE HOLIDAY
========================================================= */
export const updateHoliday = async (req, res) => {
    try {

        const editedBy = getEditedBy(req);
        const { id } = req.params;

        /* ================= GET OLD HOLIDAY ================= */
        const existing = await getHolidayByIdModel(id);

        if (!existing) {
            return res.status(404).json({
                success: false,
                message: "Holiday not found"
            });
        }

        const {
            holiday_name,
            holiday_date,
            transfer_date,
            locations
        } = req.body;

        /* ================= DUPLICATE HOLIDAY VALIDATION ================= */
        const existingHoliday = await checkDuplicateHolidayModel({
            id,
            holiday_name: holiday_name ?? existing.holiday_name,
            holiday_date: holiday_date ?? existing.holiday_date,
            locations: locations ?? existing.locations
        });

        if (existingHoliday) {
            return res.status(400).json({
                success: false,
                message: `Holiday already exists: ${existingHoliday.holiday_name} on ${existingHoliday.holiday_date}`,
                data: existingHoliday
            });
        }

        /* ================= UPDATE ================= */
        const data = await updateHolidayModel(
            id,
            {
                holiday_name:
                    holiday_name ??
                    existing.holiday_name,

                holiday_date:
                    holiday_date ??
                    existing.holiday_date,

                transfer_date:
                    transfer_date ??
                    existing.transfer_date,

                locations:
                    locations ??
                    existing.locations,

                created_by: existing.created_by
            }
        );

        if (!data) {
            return res.status(404).json({
                success: false,
                message: "Holiday not found"
            });
        }

        /* ================= FORMAT DATE ================= */
        if (data.holiday_date) {
            data.holiday_date = String(data.holiday_date).substring(0, 10);
        }

        if (data.transfer_date) {
            data.transfer_date = String(data.transfer_date).substring(0, 10);
        }

        /* ================= CALENDAR LOG ================= */
        const calendarLog = await addCalendarEditLogModel({
            table_name: "holidays",
            record_id: Number(id),
            username: existing.created_by || null,
            edited_by: editedBy,
            action: "UPDATE",
            field_name: "holidays",
            old_value: existing,
            new_value: data,
            calendar_date:
                data.holiday_date ||
                existing.holiday_date,
            description: `Holiday updated: ${data.holiday_name}`
        });

        const io = getIO();
        if (io) {
            io.emit("holiday:updated", {
                success: true,
                message: "Holiday updated successfully",
                data
            });
        }

        return res.status(200).json({
            success: true,
            message: "Holiday updated successfully",
            data,
            calendarLog
        });

    } catch (error) {
        console.error("UPDATE HOLIDAY ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* =========================================================
   DELETE HOLIDAY
========================================================= */
export const deleteHoliday = async (req, res) => {
    try {
        const editedBy = getEditedBy(req);
        const { id } = req.params;

        /* ================= GET OLD HOLIDAY ================= */
        const existing = await getHolidayByIdModel(id);

        if (!existing) {
            return res.status(404).json({
                success: false,
                message: "Holiday not found"
            });
        }

        /* ================= DELETE ================= */
        const data = await deleteHolidayModel(id);

        if (!data) {
            return res.status(404).json({
                success: false,
                message: "Holiday not found"
            });
        }

        /* ================= CALENDAR LOG ================= */
        const calendarLog = await addCalendarEditLogModel({
            table_name: "holidays",
            record_id: Number(id),
            username: existing.created_by || null,
            edited_by: editedBy,
            action: "DELETE",
            field_name: "holidays",
            old_value: existing,
            new_value: null,
            calendar_date: existing.holiday_date,
            description: `Holiday deleted: ${existing.holiday_name}`
        });

        const io = getIO();
        if (io) {
            io.emit("holiday:deleted", {
                success: true,
                message: "Holiday deleted successfully",
                data
            });
        }

        return res.status(200).json({
            success: true,
            message: "Holiday deleted successfully",
            data,
            calendarLog
        });

    } catch (error) {
        console.error("DELETE HOLIDAY ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* =========================================================
   TRANSFER HOLIDAY
========================================================= */
export const transferHoliday = async (req, res) => {
    try {
        const editedBy = getEditedBy(req);
        const { id } = req.params;
        const { transfer_date } = req.body;

        if (!transfer_date) {
            return res.status(400).json({
                success: false,
                message: "transfer_date is required"
            });
        }

        /* ================= GET OLD HOLIDAY ================= */
        const existing = await getHolidayByIdModel(id);

        if (!existing) {
            return res.status(404).json({
                success: false,
                message: "Holiday not found"
            });
        }

        /* ================= TRANSFER ================= */
        const data = await transferHolidayModel(
            id,
            transfer_date,
            editedBy
        );

        if (!data) {
            return res.status(404).json({
                success: false,
                message: "Holiday not found"
            });
        }

        /* ================= CALENDAR LOG ================= */
        const calendarLog = await addCalendarEditLogModel({
            table_name: "holidays",
            record_id: Number(id),
            username: existing.created_by || null,
            edited_by: editedBy,
            action: "UPDATE",
            field_name: "transfer_date",
            old_value: existing,
            new_value: data,
            calendar_date:
                data.transfer_date ||
                existing.holiday_date,

            description: `Holiday transferred: ${data.holiday_name}`
        });

        const io = getIO();
        if (io) {
            io.emit("holiday:transferred", {
                success: true,
                message: "Holiday transferred successfully",
                data
            });
        }

        return res.status(200).json({
            success: true,
            message: "Holiday transferred successfully",
            data,
            calendarLog
        });

    } catch (error) {
        console.error("TRANSFER HOLIDAY ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};