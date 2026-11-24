import { getIO } from "../../../config/socket.js";
import { getHolidaysByMonthModel } from "../../../models/Attendance/Calendar/holiday.model.js";
import { getAttendanceSummaryModel } from "../../../models/Attendance/Summary/summary.model.js";

/* ================= CALCULATE SHIFT MINUTES ================= */
export const calculateShiftMinutes = (startTime, endTime) => {

    if (!startTime || !endTime) return 0;

    const [startHour, startMin] = startTime.split(":").map(Number);
    const [endHour, endMin] = endTime.split(":").map(Number);

    let start = (startHour * 60) + startMin;
    let end = (endHour * 60) + endMin;

    // Night shift support
    if (end < start) {
        end += 24 * 60;
    }

    return end - start;
};

/* ================= GET ATTENDANCE SUMMARY ================= */
export const getAttendanceSummary = async (req, res) => {
    try {
        const {
            month,
            year,
            name,
            employee_id,
            department,
            work_location,
            category,
            page,
            limit
        } = req.query;

        if (!month || !year) {
            return res.status(400).json({
                success: false,
                message: "month and year are required"
            });
        }

        const result = await getAttendanceSummaryModel({
            month,
            year,
            name,
            employee_id,
            department,
            work_location,
            category,
            page: Number(page) || 1,
            limit: Number(limit) || 20
        });

        const employees = result.rows;
        const pagination = result.pagination;

        const holidays = await getHolidaysByMonthModel(year, month);

        const totalDays = new Date(year, month, 0).getDate();

        const today = new Date();

        const selectedMonth = Number(month);
        const selectedYear = Number(year);

        let daysToCount = totalDays;

        if (
            selectedMonth === today.getMonth() + 1 &&
            selectedYear === today.getFullYear()
        ) {
            daysToCount = today.getDate();
        }

        const data = employees.map((emp) => {
            const present = Number(emp.present || 0);
            const halfDay = Number(emp.half_day || 0);
            const fullLeave = Number(emp.full_leave || 0);
            const halfLeave = Number(emp.half_leave || 0);
            const leave = fullLeave + (halfLeave * 0.5);

            /* =========================================================
               ATTENDANCE DATES
            ========================================================= */
            const presentDates = new Set(
                (emp.attendance_dates || []).map(date =>
                    new Date(date)
                        .toISOString()
                        .slice(0, 10)
                )
            );

            /* =========================================================
               JOINING DATE
            ========================================================= */
            const joiningDate = new Date(emp.joining_date);
            joiningDate.setHours(0, 0, 0, 0);

            const monthStart = new Date(
                selectedYear,
                selectedMonth - 1,
                1
            );

            monthStart.setHours(0, 0, 0, 0);

            /* =========================================================
               CURRENT MONTH END
            ========================================================= */
            const currentMonthEnd = new Date(
                selectedYear,
                selectedMonth - 1,
                selectedMonth === today.getMonth() + 1 &&
                    selectedYear === today.getFullYear()
                    ? today.getDate()
                    : totalDays
            );

            currentMonthEnd.setHours(0, 0, 0, 0);

            let employeeEndDate = new Date(currentMonthEnd);

            /* =========================================================
               INACTIVE DATE
            ========================================================= */
            if (emp.inactive_date) {
                const inactiveDate = new Date(emp.inactive_date);
                inactiveDate.setHours(0, 0, 0, 0);

                if (inactiveDate < employeeEndDate) {
                    employeeEndDate = inactiveDate;
                }
            }

            /* =========================================================
               FULL MONTH END
            ========================================================= */
            const fullMonthEnd = new Date(
                selectedYear,
                selectedMonth - 1,
                totalDays
            );

            fullMonthEnd.setHours(0, 0, 0, 0);

            /* =========================================================
               EMPLOYEE START DATE
            ========================================================= */
            const employeeStartDate =
                joiningDate > monthStart
                    ? joiningDate
                    : monthStart;

            /* =========================================================
               CURRENT PERIOD
            ========================================================= */
            let holiday = 0;
            let weeklyOff = 0;
            let overtime = 0;
            let employeeCalendarDays = 0;

            for (
                let date = new Date(employeeStartDate);
                date <= employeeEndDate;
                date.setDate(date.getDate() + 1)
            ) {

                employeeCalendarDays++;

                const dateStr = date.toISOString().slice(0, 10);

                /* =========================================================
                   HOLIDAY CHECK
                ========================================================= */
                const isHoliday = holidays.some(h => {

                    if (!h.holiday_date) {
                        return false;
                    }

                    const hd =
                        new Date(h.holiday_date)
                            .toISOString()
                            .slice(0, 10);

                    if (hd !== dateStr) {
                        return false;
                    }

                    /* ================= ALL LOCATIONS ================= */

                    if (
                        !h.locations ||
                        h.locations.length === 0
                    ) {
                        return true;
                    }

                    /* ================= LOCATION MATCH ================= */

                    return h.locations.some(
                        locationId =>
                            Number(locationId) ===
                            Number(emp.work_location_id)
                    );
                });

                const isTransferredHoliday =
                    holidays.some(h => {

                        if (!h.transfer_date) {
                            return false;
                        }

                        return (
                            new Date(h.transfer_date)
                                .toISOString()
                                .slice(0, 10) ===
                            dateStr
                        );
                    });

                const hasAttendance =
                    presentDates.has(dateStr);

                if (isHoliday) {

                    holiday++;

                    if (hasAttendance) {
                        overtime++;
                    }

                    continue;
                }

                if (
                    date.getDay() === 0 &&
                    !isTransferredHoliday
                ) {
                    weeklyOff++;
                }
            }

            /* =========================================================
               EMPLOYEE WORKING DAYS
            ========================================================= */
            const employeeWorkingDays =
                Math.max(
                    employeeCalendarDays -
                    holiday -
                    weeklyOff,
                    0
                );

            /* =========================================================
               ABSENT
            ========================================================= */
            const absent = Math.max(
                employeeWorkingDays -
                present -
                (halfDay * 0.5),
                0
            );

            /* =========================================================
               COMPANY TOTAL DAYS
            ========================================================= */
            let companyHoliday = 0;
            let companyWeeklyOff = 0;
            let companyCalendarDays = 0;

            let companyEndDate = new Date(fullMonthEnd);

            if (emp.inactive_date) {

                const inactiveDate =
                    new Date(emp.inactive_date);

                inactiveDate.setHours(0, 0, 0, 0);

                if (inactiveDate < companyEndDate) {
                    companyEndDate =
                        inactiveDate;
                }
            }

            for (
                let date = new Date(employeeStartDate);
                date <= companyEndDate;
                date.setDate(date.getDate() + 1)
            ) {
                companyCalendarDays++;

                const dateStr = date.toISOString().slice(0, 10);

                /* =========================================================
                   HOLIDAY CHECK
                ========================================================= */
                const isHoliday = holidays.some(h => {

                    if (!h.holiday_date) {
                        return false;
                    }

                    const hd =
                        new Date(h.holiday_date)
                            .toISOString()
                            .slice(0, 10);

                    if (hd !== dateStr) {
                        return false;
                    }

                    /* ================= ALL LOCATIONS ================= */

                    if (
                        !h.locations ||
                        h.locations.length === 0
                    ) {
                        return true;
                    }

                    /* ================= LOCATION MATCH ================= */

                    return h.locations.some(
                        locationId =>
                            Number(locationId) ===
                            Number(emp.work_location_id)
                    );
                });

                const isTransferredHoliday =
                    holidays.some(h => {

                        if (!h.transfer_date) {
                            return false;
                        }

                        return (
                            new Date(h.transfer_date)
                                .toISOString()
                                .slice(0, 10) ===
                            dateStr
                        );
                    });

                if (isHoliday) {
                    companyHoliday++;
                    continue;
                }

                if (
                    date.getDay() === 0 &&
                    !isTransferredHoliday
                ) {
                    companyWeeklyOff++;
                }
            }

            /* =========================================================
               COMPANY WORKING DAYS
            ========================================================= */
            const companyWorkingDays =
                Math.max(
                    companyCalendarDays -
                    companyHoliday -
                    companyWeeklyOff,
                    0
                );

            /* =========================================================
               ATTENDANCE PERCENTAGE
            ========================================================= */
            const attendedDays = present + (halfDay * 0.5);

            const attendancePercentage =
                companyWorkingDays > 0
                    ? (
                        (attendedDays /
                            companyWorkingDays) *
                        100
                    ).toFixed(2)
                    : "0.00";

            /* =========================================================
               ACTUAL ATTENDANCE TIME
               ROUND TO WHOLE MINUTES
            ========================================================= */
            const totalMinutes =
                Math.round(
                    Number(emp.total_minutes || 0)
                );

            const hrs = Math.floor(totalMinutes / 60);
            const mins = totalMinutes % 60;

            /* =========================================================
               COMPANY EXPECTED TIME
            ========================================================= */
            const shiftMinutes =
                Math.round(
                    calculateShiftMinutes(
                        emp.start_time,
                        emp.end_time
                    )
                );

            const companyTotalMinutes =
                Math.round(
                    companyWorkingDays *
                    shiftMinutes
                );

            const companyHours =
                Math.floor(
                    companyTotalMinutes / 60
                );

            const companyMinutes = companyTotalMinutes % 60;

            /* =========================================================
               RESPONSE
            ========================================================= */
            return {
                profile_image: emp.image,
                first_name: emp.first_name,
                middle_name: emp.middle_name,
                last_name: emp.last_name,
                username: emp.username,
                employee_id: emp.employment_id,
                department: emp.department,
                category: emp.category,
                work_location: emp.work_location,
                shift_name: emp.shift_name,
                shift_type: emp.shift_type,
                start_time: emp.start_time,
                end_time: emp.end_time,
                shift_days: emp.days || [],

                early_leave_count_time:
                    emp.early_leave_count_time ||
                    "00:00:00",

                late_arrival_count_time:
                    emp.late_arrival_count_time ||
                    "00:00:00",

                present,
                half_day: halfDay,
                leave,
                full_leave: fullLeave,
                half_leave: halfLeave,
                absent,
                holiday,
                weekly_off: weeklyOff,
                overtime,
                total_days: companyWorkingDays,
                total_hours: `${hrs}h ${String(mins).padStart(2, "0")}m`,
                total_minutes: totalMinutes,
                company_total_hours: `${companyHours}h ${String(companyMinutes).padStart(2, "0")}m`,
                company_total_minutes: companyTotalMinutes,
                attendance_percentage: attendancePercentage
            };
        });

        return res.status(200).json({
            success: true,
            message: "Attendance summary fetched successfully",
            data,
            pagination
        });

    } catch (error) {
        console.error("SUMMARY ERROR : ", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= GET ATTENDANCE SUMMARY BY USERNAME ================= */
export const getAttendanceSummaryByUsername = async (req, res) => {
    try {
        const { username } = req.params;
        const {
            month,
            year,
            name,
            employee_id,
            department,
            work_location
        } = req.query;

        const result = await getAttendanceSummaryModel({
            month,
            year,
            username,
            name,
            employee_id,
            department,
            work_location
        });

        const employees = result.rows;

        if (!employees.length) {
            return res.status(404).json({
                success: false,
                message: "Employee not found"
            });
        }

        const holidays = await getHolidaysByMonthModel(year, month);

        const today = new Date();

        const selectedMonth = Number(month);
        const selectedYear = Number(year);

        const totalDays = new Date(selectedYear, selectedMonth, 0).getDate();

        // Count only up to today for current month, otherwise full month
        let totalCountDays = totalDays;

        if (
            Number(month) === today.getMonth() + 1 &&
            Number(year) === today.getFullYear()
        ) {
            totalCountDays = today.getDate();
        }

        const data = employees.map((emp) => {
            const present = Number(emp.present || 0);
            const halfDay = Number(emp.half_day || 0);
            const fullLeave = Number(emp.full_leave || 0);
            const halfLeave = Number(emp.half_leave || 0);
            const leave = fullLeave + (halfLeave * 0.5);

            const presentDates = new Set(
                (emp.attendance_dates || []).map(date =>
                    new Date(date).toISOString().slice(0, 10)
                )
            );

            const joiningDate = new Date(emp.joining_date);
            joiningDate.setHours(0, 0, 0, 0);

            const monthStart = new Date(selectedYear, selectedMonth - 1, 1);
            monthStart.setHours(0, 0, 0, 0);

            // Current period end (today if current month)
            const currentEndDate = new Date(
                selectedYear,
                selectedMonth - 1,
                totalCountDays
            );
            currentEndDate.setHours(0, 0, 0, 0);

            // Full month end
            const fullMonthEnd = new Date(
                selectedYear,
                selectedMonth - 1,
                totalDays
            );
            fullMonthEnd.setHours(0, 0, 0, 0);

            // Start counting from joining date
            const employeeStartDate = joiningDate > monthStart ? joiningDate : monthStart;

            /* ================= FULL MONTH HOLIDAY + WEEKLY OFF ================= */
            let holiday = 0;
            let weeklyOff = 0;
            let overtime = 0;
            let calendarDays = 0;

            for (
                let date = new Date(monthStart);
                date <= fullMonthEnd;
                date.setDate(date.getDate() + 1)
            ) {
                calendarDays++;

                const dateStr = date.toISOString().slice(0, 10);

                /* ================= FIND HOLIDAY ================= */
                const holidayData = holidays.find(h => {
                    const holidayDate = new Date(h.holiday_date)
                        .toISOString()
                        .slice(0, 10);

                    return (
                        holidayDate === dateStr &&
                        (
                            !h.locations ||
                            (h.location_names || h.locations).length === 0 ||
                            (h.location_names || h.locations).some(
                                loc =>
                                    String(loc).trim().toLowerCase() ===
                                    (emp.work_location || "")
                                        .trim()
                                        .toLowerCase()
                            )
                        )
                    );
                });

                const isHoliday = Boolean(holidayData);

                /* ================= TRANSFER HOLIDAY ================= */
                const isTransferredHoliday =
                    holidayData?.transfer_date &&
                    new Date(holidayData.transfer_date)
                        .toISOString()
                        .slice(0, 10) === dateStr;

                const hasAttendance = presentDates.has(dateStr);

                if (
                    isHoliday &&
                    !holidayData.transfer_date
                ) {
                    holiday++;

                    // Employee worked on holiday
                    if (hasAttendance) {
                        overtime++;
                    }

                    // Important:
                    // Don't also count holiday as weekly off
                    continue;
                }

                if (
                    date.getDay() === 0 ||
                    isTransferredHoliday
                ) {
                    weeklyOff++;
                }
            }

            /* ================= ABSENT ONLY FOR PAST / CURRENT DAYS ================= */
            let countedCalendarDays = calendarDays;
            let countedHoliday = holiday;
            let countedWeeklyOff = weeklyOff;

            /*
             * For current month:
             * Only count days up to TODAY.
             * Future dates will NOT be counted as absent.
             */
            if (
                selectedMonth === today.getMonth() + 1 &&
                selectedYear === today.getFullYear()
            ) {
                countedCalendarDays = 0;
                countedHoliday = 0;
                countedWeeklyOff = 0;

                for (
                    let date = new Date(monthStart);
                    date <= currentEndDate;
                    date.setDate(date.getDate() + 1)
                ) {
                    countedCalendarDays++;

                    const dateStr = date.toISOString().slice(0, 10);

                    /* ================= FIND HOLIDAY ================= */
                    const holidayData = holidays.find(h => {
                        const holidayDate = new Date(h.holiday_date)
                            .toISOString()
                            .slice(0, 10);

                        return (
                            holidayDate === dateStr &&
                            (
                                !h.locations ||
                                (h.location_names || h.locations).length === 0 ||
                                (h.location_names || h.locations).some(
                                    loc =>
                                        String(loc)
                                            .trim()
                                            .toLowerCase() ===
                                        (emp.work_location || "")
                                            .trim()
                                            .toLowerCase()
                                )
                            )
                        );
                    });

                    const isHoliday = Boolean(holidayData);

                    /* ================= TRANSFER HOLIDAY ================= */
                    const isTransferredHoliday =
                        holidayData?.transfer_date &&
                        new Date(holidayData.transfer_date)
                            .toISOString()
                            .slice(0, 10) === dateStr;

                    /* ================= HOLIDAY ================= */
                    if (
                        isHoliday &&
                        !holidayData.transfer_date
                    ) {
                        countedHoliday++;
                        continue;
                    }

                    /* ================= WEEKLY OFF ================= */
                    if (
                        date.getDay() === 0 ||
                        isTransferredHoliday
                    ) {
                        countedWeeklyOff++;
                    }
                }
            }

            /* ================= WORKING DAYS ================= */
            const workingDays = Math.max(
                countedCalendarDays -
                countedHoliday -
                countedWeeklyOff,
                0
            );

            /* ================= ABSENT ================= */
            const absent = Math.max(
                workingDays -
                present -
                (halfDay * 0.5),
                0
            );

            /* ================= COMPANY MONTH TOTAL ================= */
            let companyHoliday = 0;
            let companyWeeklyOff = 0;
            let companyCalendarDays = 0;

            let companyEndDate = new Date(fullMonthEnd);

            if (emp.inactive_date) {
                const inactiveDate = new Date(emp.inactive_date);

                if (inactiveDate < companyEndDate) {
                    companyEndDate = inactiveDate;
                }
            }

            for (
                let date = new Date(employeeStartDate);
                date <= companyEndDate;
                date.setDate(date.getDate() + 1)
            ) {
                companyCalendarDays++;

                const dateStr = date.toISOString().slice(0, 10);

                // find matching holiday data for this date and location
                const holidayData = holidays.find(h => {
                    const hd = new Date(h.holiday_date);
                    return (
                        hd.toISOString().slice(0, 10) === dateStr &&
                        (
                            !h.locations ||
                            (h.location_names || h.locations).length === 0 ||
                            (h.location_names || h.locations).some(
                                loc =>
                                    String(loc).trim().toLowerCase() ===
                                    (emp.work_location || "").trim().toLowerCase()
                            )
                        )
                    );
                });

                const isHoliday = Boolean(holidayData);

                const isTransferredHoliday = holidays.some(h => {
                    if (!h.transfer_date) return false;

                    return (
                        new Date(h.transfer_date)
                            .toISOString()
                            .slice(0, 10) === dateStr
                    );
                });

                // Original holiday only (ignore transferred holidays)
                if (isHoliday && !holidayData?.transfer_date) {
                    companyHoliday++;
                    continue;
                }

                // Sunday + transferred holiday
                if (
                    date.getDay() === 0 ||
                    isTransferredHoliday
                ) {
                    companyWeeklyOff++;
                }
            }

            const totalMonthDays = Math.max(
                companyCalendarDays -
                companyHoliday -
                companyWeeklyOff,
                0
            );

            const attendancePercentage =
                totalMonthDays > 0
                    ? (
                        (
                            present +
                            (halfDay * 0.5)
                        ) / totalMonthDays * 100
                    ).toFixed(2)
                    : "0.00";

            const shiftMinutes = calculateShiftMinutes(
                emp.start_time,
                emp.end_time
            );

            const totalMonthMinutes = totalMonthDays * shiftMinutes;
            const totalMonthHours = Math.floor(totalMonthMinutes / 60);
            const totalMonthRemainingMinutes = totalMonthMinutes % 60;

            /* ================= TOTAL HOURS / MINUTES ================= */
            const totalMinutes = Math.round(
                Number(emp.total_minutes || 0)
            );

            const hrs = Math.floor(totalMinutes / 60);
            const mins = totalMinutes % 60;

            return {
                profile_image: emp.image,
                first_name: emp.first_name,
                middle_name: emp.middle_name,
                last_name: emp.last_name,
                username: emp.username,
                employee_id: emp.employment_id,
                department: emp.department,
                work_location: emp.work_location,
                present,
                half_day: halfDay,
                leave,
                full_leave: fullLeave,
                half_leave: halfLeave,
                absent,
                weekly_off: weeklyOff,
                holiday,
                overtime,
                total_days: totalMonthDays,
                total_hours: `${hrs}h ${String(mins).padStart(2, "0")}m`,
                total_minutes: totalMinutes,
                company_total_hours: `${totalMonthHours}h ${String(totalMonthRemainingMinutes).padStart(2, "0")}m`,
                company_total_minutes: totalMonthMinutes,
                attendance_percentage: attendancePercentage
            };
        });

        /* ================= SOCKET EMIT ================= */
        const io = getIO();

        if (io) {
            io.emit("attendance:summary", {
                success: true,
                username,
                data
            });
        }

        return res.status(200).json({
            success: true,
            message: "Attendance summary fetched successfully",
            data
        });

    } catch (error) {
        console.error("SUMMARY USERNAME ERROR : ", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};