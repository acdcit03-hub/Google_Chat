import {
    getEmployeeDailyRecordsModel,
    getPayrollEmployeesModel,
    getPayrollSalaryStatsModel
} from "../../models/Payroll/payroll.model.js";
import {
    getPayrollStatusDetailsModel,
    updatePayrollStatusModel
} from "../../models/Payroll/employee_payroll_config.model.js";
import { broadcast } from "../../config/socket.js";


export const getPayrollSalaryStats = async (req, res) => {
    try {
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

        const month =
            req.query.month == null ||
                String(req.query.month).trim() === ""
                ? currentMonth
                : Number(req.query.month);

        const year =
            req.query.year == null ||
                String(req.query.year).trim() === ""
                ? currentYear
                : Number(req.query.year);

        const work_location =
            req.query.work_location == null ||
                String(req.query.work_location).trim() === ""
                ? null
                : String(req.query.work_location).trim();

        if (!Number.isInteger(month) || month < 1 || month > 12) {
            return res.status(400).json({
                success: false,
                message: "Month must be an integer between 1 and 12"
            });
        }

        if (!Number.isInteger(year) || year < 1900 || year > 9999) {
            return res.status(400).json({
                success: false,
                message: "Year must be an integer between 1900 and 9999"
            });
        }

        const category =
            req.query.category == null ||
                String(req.query.category).trim() === ""
                ? null
                : String(req.query.category).trim();

        const data = await getPayrollSalaryStatsModel({
            month,
            year,
            work_location,
            category
        });

        const response = {
            success: true,
            message: "Payroll salary statistics fetched successfully",
            data
        };
        
        broadcast("payroll-salary-stats", "fetched", response);

        return res.status(200).json(response);
    } catch (error) {
        console.error("GET PAYROLL SALARY STATS ERROR:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to fetch payroll salary statistics",
            error: error.message
        });
    }
};

export const getPayrollEmployees = async (req, res) => {
    try {
        const {
            month,
            year,
            work_location
        } = req.query;

        const employees = await getPayrollEmployeesModel({
            month,
            year,
            work_location
        });

        const data = await Promise.all(
            employees.map(async (emp) => {
                const records = await getEmployeeDailyRecordsModel({
                    username: emp.username,
                    month: Number(month),
                    year: Number(year),
                    work_location_id: emp.work_location_id
                });

                const dailyRecords = records.map(r => {
                    const totalMinutes = Math.round(Number(r.total_minutes || 0));
                    const hours = Math.floor(totalMinutes / 60);
                    const minutes = totalMinutes % 60;

                    return {
                        date: r.date,
                        check_in: r.first_in
                            ? (
                                r.is_holiday && !r.has_attendance
                                    ? r.first_in
                                    : new Date(r.first_in).toLocaleTimeString(
                                        "en-GB",
                                        { timeZone: "Asia/Kolkata" }
                                    )
                            )
                            : null,

                        check_out: r.last_out
                            ? (
                                r.is_holiday && !r.has_attendance
                                    ? r.last_out
                                    : new Date(r.last_out).toLocaleTimeString(
                                        "en-GB",
                                        { timeZone: "Asia/Kolkata" }
                                    )
                            )
                            : null,

                        working_start_time: r.working_start_time || emp.start_time,
                        working_end_time: r.working_end_time || emp.end_time,
                        is_holiday: Boolean(r.is_holiday),
                        holiday_name: r.holiday_name || null,
                        total_hours: `${hours}:${String(minutes).padStart(2, "0")}:00`,
                        total_minutes: totalMinutes,
                        sessions: r.sessions || []
                    };
                });

                /* ================= TOTAL FROM DAILY RECORDS ================= */
                const totalMinutes = dailyRecords.reduce(
                    (total, record) => total + Number(record.total_minutes || 0),
                    0
                );

                const totalHours = Math.floor(totalMinutes / 60);
                const totalRemainingMinutes = totalMinutes % 60;

                return {
                    employmentId: emp.employment_id,
                    username: emp.username,
                    firstName: emp.first_name,
                    middleName: emp.middle_name,
                    lastName: emp.last_name,
                    work_location: emp.work_location,
                    work_location_id: emp.work_location_id,
                    shiftName: emp.shift_name,
                    shiftType: emp.shift_type,
                    workingStartTime: emp.working_start_time,
                    workingEndTime: emp.working_end_time,
                    status: emp.status,
                    month: emp.month.trim(),
                    year: Number(emp.year),
                    attendance: Number(
                        emp.attendance
                    ),

                    totalHours:
                        `${totalHours}:${String(
                            totalRemainingMinutes
                        ).padStart(2, "0")}:00`,

                    totalMinutes: totalMinutes,
                    totalOvertime: emp.total_overtime,

                    totalOvertimeMinutes:
                        Math.round(
                            Number(
                                emp.total_overtime_minutes ||
                                0
                            )
                        ),

                    companyTotalDays:
                        Number(
                            emp.company_total_days
                        ),

                    companyTotalMinutes:
                        Math.round(
                            Number(
                                emp.company_total_minutes ||
                                0
                            )
                        ),

                    dailyRecords
                };
            })
        );

        return res.status(200).json({
            success: true,
            message: "Employees fetched successfully.",
            data
        });

    } catch (error) {
        console.error("GET PAYROLL EMPLOYEES ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

export const updatePayrollStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const {
            salary_status: requestedSalaryStatus,
            generated
        } = req.body || {};

        if (!/^\d+$/.test(String(id))) {
            return res.status(400).json({
                success: false,
                message: "Valid numeric payroll record id is required"
            });
        }

        if (
            typeof requestedSalaryStatus !== "string" ||
            !requestedSalaryStatus.trim() ||
            requestedSalaryStatus.trim().length > 30
        ) {
            return res.status(400).json({
                success: false,
                message: "salary_status is required and must be 30 characters or fewer"
            });
        }

        const requestedStatus = requestedSalaryStatus.trim().toLowerCase();

        const normalizedStatus =
            requestedStatus === "paid"
                ? "Paid"
                : ["approve", "approved"].includes(requestedStatus)
                    ? "Approved"
                    : requestedSalaryStatus.trim();

        const updatedBy = String(
            req.headers["x-hrms-username"] ||
            req.headers["x-username"] ||
            req.user?.username ||
            ""
        ).trim();

        if (
            ["paid", "approve", "approved"].includes(normalizedStatus.toLowerCase()) &&
            !updatedBy
        ) {
            return res.status(400).json({
                success: false,
                message: "x-username header is required for Paid or Approved salary_status"
            });
        }

        if (
            generated === true &&
            !updatedBy
        ) {
            return res.status(400).json({
                success: false,
                message: "x-username header is required when generated is true"
            });
        }

        const payroll = await updatePayrollStatusModel(
            Number(id),
            normalizedStatus,
            updatedBy || null,
            generated === true
        );

        if (!payroll) {
            return res.status(409).json({
                success: false,
                message: "Payroll record not found or salary is already Paid and cannot be changed to another status"
            });
        }

        const response = {
            success: true,
            message: `Payroll salary_status updated to ${normalizedStatus}`,
            data: payroll
        };
        broadcast("payroll-status-update", "updated", payroll);

        return res.status(200).json(response);

    } catch (error) {
        console.error("UPDATE PAYROLL STATUS ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to update payroll salary_status",
            error: error.message
        });
    }
};

export const getPayrollStatusDetails = async (req, res) => {
    try {
        const { month, year } = req.query;

        const payrollMonth = Number(month);
        const payrollYear = Number(year);

        if (
            !month ||
            !year ||
            !Number.isInteger(payrollMonth) ||
            payrollMonth < 1 ||
            payrollMonth > 12 ||
            !Number.isInteger(payrollYear) ||
            payrollYear < 2000 ||
            payrollYear > 9999
        ) {
            return res.status(400).json({
                success: false,
                message: "month and year are required"
            });
        }

        const data = await getPayrollStatusDetailsModel({
            month: payrollMonth,
            year: payrollYear
        });

        return res.status(200).json({
            success: true,
            message: "Approved and pending payroll details fetched successfully",
            data
        });
    } catch (error) {
        console.error("GET APPROVED PENDING PAYROLL DETAILS ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch payroll details",
            error: error.message
        });
    }
};