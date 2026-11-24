import {
    createEmployeePayrollModel,
    getEmployeePayrollConfigByUsernameModel,
    getAllEmployeePayrollConfigModel,
    updateEmployeePayrollConfigModel,
    deleteEmployeePayrollConfigModel,
    getCurrentMonthExpiringPayrollConfigsModel,
    updatePayrollConfigStatusesModel,
    markPayrollGeneratedModel,
    getEmployeePayrollConfigWithPayrollModel,
    getEmployeePayrollConfigStatCardModel,
    getPayrollDashboardStatsModel
} from "../../models/Payroll/employee_payroll_config.model.js";
import {
    getEmployeeDailyRecordsModel,
    getPayrollEmployeesModel
} from "../../models/Payroll/payroll.model.js";
import {
    emitPayrollExpiryNotifications
} from "../../utils/notification/payrollStatusNotify.js";
import {
    broadcastEmployeePayrollConfigRead,
    broadcastEmployeePayrollConfigUpdate
} from "../../config/socket.js";

/* =========================================================
   GET LOGGED-IN USER
========================================================= */
const getEditedBy = (req) => {
    return (
        req.headers["x-hrms-username"] ||
        req.headers["x-username"] ||
        "system"
    );
};

const toIndiaDateString = (value) => {
    if (value === null || value === undefined || value === "") {
        return null;
    }

    if (
        typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(value.trim())
    ) {
        return value.trim();
    }

    const date = value instanceof Date ? value : new Date(value);

    if (Number.isNaN(date.getTime())) {
        return value;
    }

    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).format(date);
};

const formatResponseDates = (value) => {
    if (value instanceof Date) {
        return toIndiaDateString(value);
    }

    if (
        typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}T/.test(value)
    ) {
        return toIndiaDateString(value);
    }

    if (Array.isArray(value)) {
        return value.map(formatResponseDates);
    }

    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value).map(([key, nested]) => [
                key,
                formatResponseDates(nested)
            ])
        );
    }

    return value;
};

/* =========================================================
   VALIDATE DATE
========================================================= */
const isValidDate = (value) => {
    if (
        typeof value !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(value)
    ) {
        return false;
    }

    const date = new Date(`${value}T00:00:00`);

    if (
        Number.isNaN(
            date.getTime()
        )
    ) {
        return false;
    }

    const [
        year,
        month,
        day
    ] = value
        .split("-")
        .map(Number);

    return (
        date.getFullYear() === year &&
        date.getMonth() + 1 === month &&
        date.getDate() === day
    );
};

/* =========================================================
   VALIDATE TIME
========================================================= */
const isValidTime = (value) => {
    return (
        typeof value === "string" &&
        /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/.test(
            value
        )
    );
};

/* =========================================================
   VALIDATE DATE RANGE
========================================================= */
const isDateRangeValid = (
    startDate,
    endDate
) => {
    if (
        !isValidDate(startDate) ||
        !isValidDate(endDate)
    ) {
        return false;
    }

    return (
        new Date(`${endDate}T00:00:00`)
        >=
        new Date(`${startDate}T00:00:00`)
    );
};

/* =========================================================
   CREATE EMPLOYEE PAYROLL
========================================================= */
export const createEmployeePayroll = async (req, res) => {
    try {
        const createdBy = getEditedBy(req);

        const {
            username,
            working_start_time,
            working_end_time,
            payroll_start_date,
            payroll_end_date,
            applicable_date,
            payroll_month,
            payroll_year,
            day_type,
            current_salary,
            next_increment_date
        } = req.body;

        // Validate required fields
        const requiredFields = {
            username,
            working_start_time,
            working_end_time,
            payroll_start_date,
            payroll_end_date,
            payroll_month,
            payroll_year,
            current_salary
        };

        for (const [field, value] of Object.entries(requiredFields)) {
            if (
                value === undefined ||
                value === null ||
                String(value).trim() === ""
            ) {
                return res.status(400).json({
                    success: false,
                    message: `${field} is required`
                });
            }
        }

        // Validate salary
        if (
            !Number.isFinite(Number(current_salary)) ||
            Number(current_salary) < 0
        ) {
            return res.status(400).json({
                success: false,
                message: "current_salary must be a valid non-negative number"
            });
        }

        // Validate increment date
        const incrementDate =
            next_increment_date === undefined ||
                next_increment_date === null ||
                next_increment_date === ""
                ? null
                : String(next_increment_date).trim();

        if (incrementDate && !isValidDate(incrementDate)) {
            return res.status(400).json({
                success: false,
                message: "Invalid next_increment_date. Use YYYY-MM-DD"
            });
        }

        const normalizedApplicableDate =
            applicable_date === undefined ||
                applicable_date === null ||
                applicable_date === ""
                ? null
                : String(applicable_date).trim();

        if (
            normalizedApplicableDate &&
            !isValidDate(normalizedApplicableDate)
        ) {
            return res.status(400).json({
                success: false,
                message: "Invalid applicable_date. Use YYYY-MM-DD"
            });
        }

        // Normalize values
        const normalizedUsername = String(username).trim();
        const normalizedStartTime = String(working_start_time).trim();
        const normalizedEndTime = String(working_end_time).trim();
        const normalizedStartDate = String(payroll_start_date).trim();
        const normalizedEndDate = String(payroll_end_date).trim();
        const normalizedDayType =
            day_type === undefined || day_type === null
                ? "none"
                : String(day_type).trim();
        const payrollMonth = Number(payroll_month);
        const payrollYear = Number(payroll_year);

        if (!normalizedDayType) {
            return res.status(400).json({
                success: false,
                message: "day_type cannot be empty"
            });
        }

        if (!Number.isInteger(payrollMonth) || payrollMonth < 1 || payrollMonth > 12) {
            return res.status(400).json({
                success: false,
                message: "payroll_month must be between 1 and 12"
            });
        }

        if (!Number.isInteger(payrollYear) || payrollYear < 2000) {
            return res.status(400).json({
                success: false,
                message: "payroll_year must be at least 2000"
            });
        }

        // Validate payroll dates
        if (
            !isValidDate(normalizedStartDate) ||
            !isValidDate(normalizedEndDate)
        ) {
            return res.status(400).json({
                success: false,
                message: "Invalid payroll dates. Use YYYY-MM-DD"
            });
        }

        if (
            !isDateRangeValid(
                normalizedStartDate,
                normalizedEndDate
            )
        ) {
            return res.status(400).json({
                success: false,
                message: "payroll_end_date must be greater than or equal to payroll_start_date"
            });
        }

        // Validate working times
        if (
            !isValidTime(normalizedStartTime) ||
            !isValidTime(normalizedEndTime)
        ) {
            return res.status(400).json({
                success: false,
                message: "Invalid working time. Use HH:mm or HH:mm:ss"
            });
        }

        // Create configuration and save salary details
        const result = await createEmployeePayrollModel({
            username: normalizedUsername,
            working_start_time: normalizedStartTime,
            working_end_time: normalizedEndTime,
            payroll_start_date: normalizedStartDate,
            payroll_end_date: normalizedEndDate,
            applicable_date: normalizedApplicableDate,
            day_type: normalizedDayType,
            payroll_month: payrollMonth,
            payroll_year: payrollYear,
            current_salary: Number(current_salary),
            next_increment_date: incrementDate,
            created_by: createdBy
        });

        const response = {
            success: true,
            message: "Payroll configuration, salary details, and payroll saved successfully",
            data: result
        };
        broadcastEmployeePayrollConfigUpdate("created", response);

        return res.status(201).json(response);

    } catch (error) {
        console.error("CREATE EMPLOYEE PAYROLL ERROR:", error);

        if (error.message?.startsWith("Employee ")) {
            return res.status(404).json({
                success: false,
                message: error.message
            });
        }

        if (error.message?.includes("Shift not found")) {
            return res.status(404).json({
                success: false,
                message: error.message
            });
        }

        if (
            error.message?.includes("Valid current_salary")
        ) {
            return res.status(400).json({
                success: false,
                message: error.message
            });
        }

        if (error.message?.includes("Salary details not found")) {
            return res.status(404).json({
                success: false,
                message: error.message
            });
        }

        if (error.code === "23503") {
            return res.status(400).json({
                success: false,
                message: "Invalid employee or shift configuration"
            });
        }

        if (error.code === "23514") {
            return res.status(400).json({
                success: false,
                message: "Payroll configuration validation failed"
            });
        }

        return res.status(500).json({
            success: false,
            message: "Failed to create employee payroll",
            error: error.message
        });
    }
};

export const getAllEmployeePayrollConfig = async (req, res) => {
    try {
        const {
            work_location = null,
            category = null,
            serial_number = null,
            username = null,
            name = null,
            payroll_status = null,
            salary_status = null,
            basic_salary = null,
            shift = null,
            working_start_time = null,
            working_end_time = null,
            month = null,
            year = null,
            page = 1,
            limit = 20,
            pagination = "true"
        } = req.query;

        const paginationEnabled = String(pagination).trim().toLowerCase() === "true";

        const pageNumber = Math.max(1, Number(page) || 1);
        const pageLimit = Math.max(1, Number(limit) || 20);

        const serialNumberValue =
            serial_number == null || String(serial_number).trim() === ""
                ? null
                : String(serial_number).trim();

        const categoryValue =
            category == null || String(category).trim() === ""
                ? null
                : String(category).trim();

        const usernameValue =
            username == null || String(username).trim() === ""
                ? null
                : String(username).trim();

        const nameValue =
            name == null || String(name).trim() === ""
                ? null
                : String(name).trim();

        const payrollStatusValue =
            payroll_status == null ||
                String(payroll_status).trim() === ""
                ? null
                : String(payroll_status).trim().toLowerCase();

        const salaryStatusList =
            salary_status == null
                ? []
                : [
                    ...new Set(
                        String(salary_status)
                            .split(",")
                            .map(status => status.trim().toLowerCase())
                            .filter(Boolean)
                    )
                ];

        const salaryStatusValue =
            salaryStatusList.length > 0 ? salaryStatusList : null;

        const basicSalaryValue =
            basic_salary == null || String(basic_salary).trim() === ""
                ? null
                : String(basic_salary).trim();

        if (
            basicSalaryValue !== null &&
            !/^\d+(?:\.\d{0,2})?$/.test(basicSalaryValue)
        ) {
            return res.status(400).json({
                success: false,
                message: "basic_salary must contain only digits and an optional decimal point"
            });
        }

        const shiftValue =
            shift == null || String(shift).trim() === ""
                ? null
                : String(shift).trim();
        const workingStartTimeValue =
            working_start_time == null ||
            String(working_start_time).trim() === ""
                ? null
                : String(working_start_time).trim();
        const workingEndTimeValue =
            working_end_time == null ||
            String(working_end_time).trim() === ""
                ? null
                : String(working_end_time).trim();

        if (
            (workingStartTimeValue && !/^[0-9:]+$/.test(workingStartTimeValue)) ||
            (workingEndTimeValue && !/^[0-9:]+$/.test(workingEndTimeValue))
        ) {
            return res.status(400).json({
                success: false,
                message: "Working time filters may contain only digits and colons"
            });
        }

        const monthValue =
            month == null || String(month).trim() === ""
                ? null
                : String(month).trim();

        const yearValue =
            year == null || String(year).trim() === ""
                ? null
                : String(year).trim();

        if (
            monthValue !== null &&
            (!/^\d+$/.test(monthValue) ||
                Number(monthValue) < 1 ||
                Number(monthValue) > 12)
        ) {
            return res.status(400).json({
                success: false,
                message: "Month must be between 1 and 12"
            });
        }

        if (
            yearValue !== null &&
            (!/^\d{4}$/.test(yearValue) ||
                Number(yearValue) < 1900 ||
                Number(yearValue) > 9999)
        ) {
            return res.status(400).json({
                success: false,
                message: "Year must be in YYYY format"
            });
        }

        if (monthValue !== null && yearValue === null) {
            return res.status(400).json({
                success: false,
                message: "Year is required when month is provided"
            });
        }

        const result = await getAllEmployeePayrollConfigModel({
            work_location,
            category: categoryValue,
            serial_number: serialNumberValue,
            username: usernameValue,
            name: nameValue,
            payroll_status: payrollStatusValue,
            salary_status: salaryStatusValue,
            basic_salary: basicSalaryValue,
            shift: shiftValue,
            working_start_time: workingStartTimeValue,
            working_end_time: workingEndTimeValue,
            month: monthValue === null ? null : Number(monthValue),
            year: yearValue === null ? null : Number(yearValue),
            page: pageNumber,
            limit: pageLimit,
            pagination: paginationEnabled
        });

        const currentDateParts = Object.fromEntries(
            new Intl.DateTimeFormat("en-US", {
                timeZone: "Asia/Kolkata",
                year: "numeric",
                month: "numeric",
                day: "numeric"
            }).formatToParts(new Date())
                .filter(part =>
                    ["year", "month", "day"].includes(part.type)
                )
                .map(part => [part.type, Number(part.value)])
        );

        const currentMonth = currentDateParts.month;
        const currentYear = currentDateParts.year;
        const currentDate = [
            currentYear,
            String(currentMonth).padStart(2, "0"),
            String(currentDateParts.day).padStart(2, "0")
        ].join("-");

        const attendanceMonth =
            monthValue === null
                ? currentMonth
                : Number(monthValue);

        const attendanceYear =
            yearValue === null
                ? currentYear
                : Number(yearValue);

        const attendanceEmployees = await getPayrollEmployeesModel({
            month: attendanceMonth,
            year: attendanceYear,
            work_location
        });

        const attendanceByUsername = new Map(
            attendanceEmployees.map(employee => [
                String(employee.username || "")
                    .trim()
                    .toLowerCase(),
                employee
            ])
        );

        const selectedMonthStart = [
            attendanceYear,
            String(attendanceMonth).padStart(2, "0"),
            "01"
        ].join("-");
        const isFutureAttendanceMonth = selectedMonthStart > currentDate;

        const employeesWithAttendance = await Promise.all(
            result.employees.map(async employee => {
                const usernameKey = String(employee.username || "")
                    .trim()
                    .toLowerCase();

                const attendanceEmployee = attendanceByUsername.get(usernameKey);
                let selectedRecords = [];

                if (attendanceEmployee) {
                    selectedRecords = await getEmployeeDailyRecordsModel({
                        username: employee.username,
                        month: attendanceMonth,
                        year: attendanceYear,
                        work_location_id: attendanceEmployee.work_location_id
                    });
                }

                /* Same formula as download Final Total Salary /
                   salary-stats paid_salary & pending_salary:
                     workingMinutes * (base / company_total_minutes)
                     + Extra Day Type Salary */
                const selectedMonthAttendanceMinutes =
                    !attendanceEmployee || isFutureAttendanceMonth
                        ? 0
                        : selectedRecords.reduce(
                            (total, record) =>
                                total + Math.round(
                                    Number(record.total_minutes || 0)
                                ),
                            0
                        );

                const generatedPayroll = employee.payroll?.data?.find(
                    record =>
                        record.generated === true &&
                        Number(record.payroll_month) === attendanceMonth &&
                        Number(record.payroll_year) === attendanceYear
                );

                const baseSalary = Number(
                    generatedPayroll?.basic_salary ??
                    employee.payroll?.current_salary ??
                    0
                );

                const companyTotalMinutes = Math.round(
                    Number(attendanceEmployee?.company_total_minutes || 0)
                );

                const companyTotalDays = Number(
                    attendanceEmployee?.company_total_days || 0
                );

                // selectedMonthAttendanceMinutes is already declared above.
                // Do not declare it again here.
                const perMinuteSalary =
                    companyTotalMinutes > 0
                        ? baseSalary / companyTotalMinutes
                        : 0;

                const salaryBasedOnWorkingMinutes =
                    selectedMonthAttendanceMinutes * perMinuteSalary;

                const perDaySalary =
                    companyTotalDays > 0
                        ? baseSalary / companyTotalDays
                        : 0;

                const dayType = String(
                    employee.payroll?.configuration?.[0]?.day_type || ""
                )
                    .trim()
                    .replace(/\s+/g, " ")
                    .toLowerCase();

                const extraDayTypeSalary =
                    perDaySalary *
                    (dayType === "half day"
                        ? 0.5
                        : dayType === "full day"
                            ? 1
                            : 0);

                const isPayrollGenerated = Boolean(generatedPayroll);

                const currentMonthAccruedSalary = isPayrollGenerated
                    ? Number(
                        (
                            selectedMonthAttendanceMinutes > 0
                                ? salaryBasedOnWorkingMinutes + extraDayTypeSalary
                                : perDaySalary
                        ).toFixed(2)
                    )
                    : null;


                if (!attendanceEmployee) {
                    return {
                        ...employee,
                        attendance: 0,
                        totalHours: "0:00:00",
                        totalMinutes: 0,
                        totalOvertime: "0:00:00",
                        totalOvertimeMinutes: 0,
                        employeeWorkingDays: 0,
                        employeeTotalMinutes: 0,
                        employeeTotalOvertimeMinutes: 0,
                        companyTotalDays: 0,
                        companyTotalMinutes: 0,
                        currentMonthAccruedSalary,
                        dailyRecords: []
                    };
                }

                const dailyRecords = selectedRecords.map(record => {
                    const totalMinutes = Math.round(
                        Number(record.total_minutes || 0)
                    );

                    return {
                        date: record.date,

                        check_in: record.first_in
                            ? (
                                record.is_holiday &&
                                    !record.has_attendance
                                    ? record.first_in
                                    : new Date(
                                        record.first_in
                                    ).toLocaleTimeString(
                                        "en-GB",
                                        { timeZone: "Asia/Kolkata" }
                                    )
                            )
                            : null,

                        check_out: record.last_out
                            ? (
                                record.is_holiday &&
                                    !record.has_attendance
                                    ? record.last_out
                                    : new Date(
                                        record.last_out
                                    ).toLocaleTimeString(
                                        "en-GB",
                                        { timeZone: "Asia/Kolkata" }
                                    )
                            )
                            : null,

                        working_start_time:
                            record.working_start_time ||
                            attendanceEmployee.working_start_time,

                        working_end_time:
                            record.working_end_time ||
                            attendanceEmployee.working_end_time,

                        is_holiday: Boolean(record.is_holiday),
                        holiday_name: record.holiday_name || null,
                        has_attendance: Boolean(record.has_attendance),

                        total_hours: `${Math.floor(
                            totalMinutes / 60
                        )}:${String(
                            totalMinutes % 60
                        ).padStart(2, "0")}:00`,

                        total_minutes: totalMinutes,
                        total_overtime_minutes: Math.max(
                            0,
                            Math.round(
                                Number(record.total_overtime_minutes || 0)
                            )
                        ),
                        sessions: record.sessions || []
                    };
                });

                const employeeTotalMinutes = dailyRecords.reduce(
                    (total, record) => total + record.total_minutes,
                    0
                );


                const employeeTotalOvertimeMinutes = dailyRecords.reduce(
                    (total, record) =>
                        total + record.total_overtime_minutes,
                    0
                );

                const employeeWorkingDays = dailyRecords.filter(
                    record => record.has_attendance
                ).length;

                return {
                    ...employee,
                    employeeWorkingDays,
                    employeeTotalMinutes,
                    employeeTotalOvertimeMinutes,
                    companyTotalDays: Number(
                        attendanceEmployee.company_total_days || 0
                    ),
                    companyTotalMinutes,
                    currentMonthAccruedSalary
                };
            })
        );

        const response = {
            success: true,
            message: "Employee data fetched successfully",
            totalEmployees: result.totalEmployees,
            data: formatResponseDates(employeesWithAttendance),
            pagination: result.pagination
        };
        broadcastEmployeePayrollConfigRead("list", response);

        return res.status(200).json(response);

    } catch (error) {
        console.error("GET ALL EMPLOYEE PAYROLL DATA ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch employee payroll data",
            error: error.message
        });
    }
};

/* =========================================================
   GET ALL EMPLOYEE PAYROLL CONFIG WITH PAYROLL
========================================================= */
export const getEmployeePayrollConfigWithPayroll = async (req, res) => {
    try {
        const username =
            req.query.username == null ||
            String(req.query.username).trim() === ""
                ? null
                : String(req.query.username).trim();

        const status =
            req.query.status == null ||
            String(req.query.status).trim() === ""
                ? null
                : String(req.query.status).trim();

        const serialNumber =
            req.query.serial_number == null ||
            String(req.query.serial_number).trim() === ""
                ? null
                : String(req.query.serial_number).trim();
                
        const data = await getEmployeePayrollConfigWithPayrollModel({
            username,
            status,
            serial_number: serialNumber
        });

        const response = {
            success: true,
            message: "Employee payroll configurations and payroll records fetched successfully",
            total: data.length,
            data
        };
        broadcastEmployeePayrollConfigRead("with-payroll", response);

        return res.status(200).json(response);
    } catch (error) {
        console.error("GET EMPLOYEE PAYROLL CONFIG WITH PAYROLL ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch employee payroll configurations and payroll records",
            error: error.message
        });
    }
};

/* =========================================================
   GET EMPLOYEE PAYROLL CONFIG STAT CARD
========================================================= */
export const getEmployeePayrollConfigStatCard = async (req, res) => {
    try {
        const data = await getEmployeePayrollConfigStatCardModel();
        const response = {
            success: true,
            message: "Employee payroll configuration status counts fetched successfully",
            data
        };
        broadcastEmployeePayrollConfigRead("stat-card", response);

        return res.status(200).json(response);
    } catch (error) {
        console.error("GET EMPLOYEE PAYROLL CONFIG STAT CARD ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch employee payroll configuration status counts",
            error: error.message
        });
    }
};

/* =========================================================
   GET PAYROLL DASHBOARD STATISTICS
========================================================= */
export const getPayrollDashboardStats = async (req, res) => {
    try {
        const data = await getPayrollDashboardStatsModel();

        const response = {
            success: true,
            message: "Payroll dashboard statistics fetched successfully",
            data
        };
        broadcastEmployeePayrollConfigRead("dashboard-stats", response);

        return res.status(200).json(response);
    } catch (error) {
        console.error("GET PAYROLL DASHBOARD STATS ERROR:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to fetch payroll dashboard statistics",
            error: error.message
        });
    }
};

/* =========================================================
   GET CONFIG BY USERNAME
========================================================= */
export const getEmployeePayrollConfigByUsername = async (req, res) => {
    try {
        const {
            username
        } = req.params;
        const { month, year } = req.query;

        if (
            !username ||
            String(username).trim() === ""
        ) {
            return res.status(400).json({
                success: false,
                message: "username is required"
            });
        }

        const monthValue =
            month === undefined || String(month).trim() === ""
                ? null
                : Number(month);
        const yearValue =
            year === undefined || String(year).trim() === ""
                ? null
                : Number(year);

        if (
            monthValue !== null &&
            (!Number.isInteger(monthValue) ||
                monthValue < 1 ||
                monthValue > 12)
        ) {
            return res.status(400).json({
                success: false,
                message: "Month must be between 1 and 12"
            });
        }

        if (
            yearValue !== null &&
            (!Number.isInteger(yearValue) ||
                yearValue < 1900 ||
                yearValue > 9999)
        ) {
            return res.status(400).json({
                success: false,
                message: "Year must be in YYYY format"
            });
        }

        const statusUpdate = await updatePayrollConfigStatusesModel();
        // emitPayrollExpiryNotifications(statusUpdate.expiryNotifications);

        const data = await getEmployeePayrollConfigByUsernameModel(
            String(username).trim(),
            { month: monthValue, year: yearValue }
        );

        if (!data) {
            return res.status(404).json({
                success: false,
                message: "Payroll configuration not found"
            });
        }

        const response = {
            success: true,
            data
        };
        broadcastEmployeePayrollConfigRead("by-username", response);

        return res.status(200).json(response);

    } catch (error) {
        console.error("GET EMPLOYEE PAYROLL CONFIG ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch payroll configuration",
            error: error.message
        });
    }
};

/* =========================================================
   MARK PAYROLL GENERATED
========================================================= */
export const markPayrollGenerated = async (req, res) => {
    try {
        const generated_by = getEditedBy(req);

        if (!generated_by || generated_by === "system") {
            const headerUser = String(
                req.headers["x-hrms-username"] ||
                req.headers["x-username"] ||
                ""
            ).trim();

            if (!headerUser) {
                return res.status(400).json({
                    success: false,
                    message: "x-username header is required"
                });
            }
        }

        const {
            id = null,
            ids = [],
            username = null,
            usernames = [],
            month = null,
            year = null
        } = req.body || {};

        const indiaDateParts = new Intl.DateTimeFormat("en-US", {
            timeZone: "Asia/Kolkata",
            month: "numeric",
            year: "numeric"
        }).formatToParts(new Date());
        const currentMonth = Number(
            indiaDateParts.find(part => part.type === "month").value
        );
        const currentYear = Number(
            indiaDateParts.find(part => part.type === "year").value
        );

        const monthValue =
            month == null || String(month).trim() === ""
                ? currentMonth
                : Number(month);
        const yearValue =
            year == null || String(year).trim() === ""
                ? currentYear
                : Number(year);

        if (
            monthValue !== null &&
            (!Number.isInteger(monthValue) || monthValue < 1 || monthValue > 12)
        ) {
            return res.status(400).json({
                success: false,
                message: "Month must be an integer between 1 and 12"
            });
        }

        if (
            yearValue !== null &&
            (!Number.isInteger(yearValue) || yearValue < 1900 || yearValue > 9999)
        ) {
            return res.status(400).json({
                success: false,
                message: "Year must be an integer between 1900 and 9999"
            });
        }

        const data = await markPayrollGeneratedModel({
            id,
            ids,
            username,
            usernames,
            month: monthValue,
            year: yearValue,
            generated_by: String(
                req.headers["x-hrms-username"] ||
                req.headers["x-username"] ||
                generated_by
            ).trim()
        });

        const response = {
            success: true,
            message: data.length
                ? "Payroll generated successfully"
                : "No pending payroll records found to generate",
            count: data.length,
            data
        };
        broadcastEmployeePayrollConfigUpdate("generated", response);

        return res.status(200).json(response);
    } catch (error) {
        console.error("MARK PAYROLL GENERATED ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message || "Failed to generate payroll"
        });
    }
};

/* =========================================================
   CURRENT MONTH EXPIRING CONFIGS
========================================================= */
export const getCurrentMonthExpiringPayrollConfigs = async (req, res) => {
    try {
        const { work_location = null } = req.query;

        const data = await getCurrentMonthExpiringPayrollConfigsModel({
            work_location
        });

        const response = {
            success: true,
            message: "Current month expiring payroll configurations fetched successfully",
            count: data.length,
            data
        };
        broadcastEmployeePayrollConfigRead("expiring-this-month", response);

        return res.status(200).json(response);
    } catch (error) {
        console.error("GET CURRENT MONTH EXPIRING PAYROLL CONFIGS ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch current month expiring payroll configurations",
            error: error.message
        });
    }
};

/* =========================================================
   UPDATE EMPLOYEE PAYROLL CONFIG
========================================================= */
export const updateEmployeePayrollConfig = async (req, res) => {
    try {
        const { id } = req.params;
        const updatedBy = getEditedBy(req);

        const {
            username,
            working_start_time,
            working_end_time,
            payroll_start_date,
            payroll_end_date,
            applicable_date,
            day_type,
            current_salary,
            next_increment_date
        } = req.body;

        // Validate ID.
        if (!id || !/^\d+$/.test(String(id))) {
            return res.status(400).json({
                success: false,
                message: "Valid numeric id is required"
            });
        }

        const hasDayTypeField = Object.prototype.hasOwnProperty.call(
            req.body || {},
            "day_type"
        );

        const hasCurrentSalaryField = Object.prototype.hasOwnProperty.call(
            req.body || {},
            "current_salary"
        );

        const hasApplicableDateField = Object.prototype.hasOwnProperty.call(
            req.body || {},
            "applicable_date"
        );

        if (
            hasCurrentSalaryField &&
            (
                current_salary === null ||
                current_salary === undefined ||
                current_salary === "" ||
                !Number.isFinite(Number(current_salary)) ||
                Number(current_salary) < 0
            )
        ) {
            return res.status(400).json({
                success: false,
                message: "current_salary must be a valid non-negative number"
            });
        }

        // Validate required fields.
        const requiredFields = {
            working_start_time,
            working_end_time,
            payroll_start_date,
            payroll_end_date
        };

        for (const [field, value] of Object.entries(requiredFields)) {
            if (
                value === undefined ||
                value === null ||
                String(value).trim() === ""
            ) {
                return res.status(400).json({
                    success: false,
                    message: `${field} is required`
                });
            }
        }

        // Normalize input.
        const startTime = String(working_start_time).trim();
        const endTime = String(working_end_time).trim();
        const startDate = String(payroll_start_date).trim();
        const endDate = String(payroll_end_date).trim();
        // Validate dates.
        if (!isValidDate(startDate)) {
            return res.status(400).json({
                success: false,
                message: "Invalid payroll_start_date. Use YYYY-MM-DD"
            });
        }

        if (!isValidDate(endDate)) {
            return res.status(400).json({
                success: false,
                message: "Invalid payroll_end_date. Use YYYY-MM-DD"
            });
        }

        if (!isDateRangeValid(startDate, endDate)) {
            return res.status(400).json({
                success: false,
                message: "payroll_end_date must be greater than or equal to payroll_start_date"
            });
        }

        // Validate times.
        if (!isValidTime(startTime)) {
            return res.status(400).json({
                success: false,
                message: "Invalid working_start_time. Use HH:mm or HH:mm:ss"
            });
        }

        if (!isValidTime(endTime)) {
            return res.status(400).json({
                success: false,
                message: "Invalid working_end_time. Use HH:mm or HH:mm:ss"
            });
        }

        const normalizedApplicableDate = hasApplicableDateField
            ? (
                applicable_date === null ||
                    applicable_date === undefined ||
                    applicable_date === ""
                    ? null
                    : String(applicable_date).trim()
            )
            : null;

        if (
            hasApplicableDateField &&
            normalizedApplicableDate &&
            !isValidDate(normalizedApplicableDate)
        ) {
            return res.status(400).json({
                success: false,
                message: "Invalid applicable_date. Use YYYY-MM-DD"
            });
        }

        const hasSalaryFields = next_increment_date !== undefined;

        let salaryData = null;

        if (hasSalaryFields) {
            const normalizedNextIncrementDate =
                next_increment_date === undefined ||
                    next_increment_date === null ||
                    next_increment_date === ""
                    ? null
                    : String(next_increment_date).trim();

            if (!username || !String(username).trim()) {
                return res.status(400).json({
                    success: false,
                    message: "username is required to update salary details"
                });
            }

            if (
                normalizedNextIncrementDate &&
                !isValidDate(normalizedNextIncrementDate)
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid next_increment_date. Use YYYY-MM-DD"
                });
            }

            salaryData = {
                username: String(username).trim(),
                next_increment_date: normalizedNextIncrementDate
            };
        }

        // Update configuration.
        const data = await updateEmployeePayrollConfigModel(
            Number(id),
            {
                working_start_time: startTime,
                working_end_time: endTime,
                payroll_start_date: startDate,
                payroll_end_date: endDate,
                applicable_date: normalizedApplicableDate,
                has_applicable_date: hasApplicableDateField,
                day_type: hasDayTypeField ? day_type : null,
                requested_day_type: hasDayTypeField ? day_type : null,
                has_day_type: hasDayTypeField,
                requested_current_salary: hasCurrentSalaryField
                    ? Number(current_salary)
                    : null,
                has_current_salary: hasCurrentSalaryField,
                updated_by: updatedBy,
                salaryDetails: salaryData
            }
        );

        if (!data) {
            return res.status(404).json({
                success: false,
                message: "Payroll configuration not found"
            });
        }

        const responseData = { ...data };
        if (data.salary_details) {
            responseData.current_salary = data.current_salary ?? data.salary_details.current_salary;
            responseData.next_increment_date = data.salary_details.next_increment_date;
        }

        const response = {
            success: true,
            message: data.salary_details
                ? "Payroll configuration and salary details updated successfully"
                : "Payroll configuration updated successfully",
            data: responseData
        };
        broadcastEmployeePayrollConfigUpdate("updated", response);

        return res.status(200).json(response);
    } catch (error) {
        console.error("UPDATE EMPLOYEE PAYROLL CONFIG ERROR:", error);

        if (error.statusCode === 409) {
            return res.status(409).json({
                success: false,
                message: error.message
            });
        }

        if (error.message?.includes("cannot be changed")) {
            return res.status(400).json({
                success: false,
                message: error.message
            });
        }

        if (error.message?.includes("Shift not found")) {
            return res.status(404).json({
                success: false,
                message: error.message
            });
        }

        if (
            error.message?.includes("does not match the payroll configuration")
        ) {
            return res.status(400).json({
                success: false,
                message: error.message
            });
        }

        if (
            error.message?.includes("Employee '") &&
            error.message?.includes("not found")
        ) {
            return res.status(404).json({
                success: false,
                message: error.message
            });
        }

        if (error.code === "23505") {
            return res.status(409).json({
                success: false,
                message: "A payroll record already exists for this employee and month"
            });
        }

        if (error.code === "23503") {
            return res.status(400).json({
                success: false,
                message: "Invalid shift or employee configuration"
            });
        }

        if (error.code === "23514" || error.code === "22007") {
            return res.status(400).json({
                success: false,
                message: "Invalid payroll configuration values"
            });
        }

        return res.status(500).json({
            success: false,
            message: "Failed to update payroll configuration",
            error: error.message
        });
    }
};

/* =========================================================
   DELETE CONFIG
========================================================= */
export const deleteEmployeePayrollConfig = async (req, res) => {
    try {
        const { id } = req.params;

        /* =================================================
           ID VALIDATION
        ================================================= */
        if (
            !id ||
            !/^\d+$/.test(
                String(id)
            )
        ) {
            return res.status(400).json({
                success: false,
                message: "Valid numeric id is required"
            });
        }

        /* =================================================
           DELETE
        ================================================= */
        const data = await deleteEmployeePayrollConfigModel(
            Number(id)
        );

        if (!data) {
            return res.status(404).json({
                success: false,
                message: "Payroll configuration not found"
            });
        }

        const response = {
            success: true,
            message: "Payroll configuration deleted successfully",
            deleted_payroll_count: data.deleted_payroll_count || 0,
            data
        };
        broadcastEmployeePayrollConfigUpdate("deleted", response);

        return res.status(200).json(response);

    } catch (error) {
        console.error("DELETE EMPLOYEE PAYROLL CONFIG ERROR:", error);
        if (
            error.code === "23503"
        ) {
            return res.status(400).json({
                success: false,
                message: "Payroll configuration cannot be deleted because it is referenced by another record"
            });
        }

        return res.status(500).json({
            success: false,
            message: "Failed to delete payroll configuration",
            error: error.message
        });
    }
};