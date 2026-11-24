import {
    getCompanyPayrollReportModel,
    getFinancialYearSalaryReportModel,
    getPayrollIncrementReportModel,
    getPayrollSalaryReportModel
} from "../../models/Payroll/payrollReport.model.js";

const getIndiaMonthYear = () => {
    const indiaDateParts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Kolkata",
        month: "numeric",
        year: "numeric"
    }).formatToParts(new Date());

    return {
        currentMonth: Number(
            indiaDateParts.find(part => part.type === "month").value
        ),
        currentYear: Number(
            indiaDateParts.find(part => part.type === "year").value
        )
    };
};

export const getPayrollSalaryReport = async (req, res) => {
    try {
        const { currentMonth, currentYear } = getIndiaMonthYear();

        const type = String(req.query.type || "")
            .trim()
            .toLowerCase();

        if (!["monthly", "yearly"].includes(type)) {
            return res.status(400).json({
                success: false,
                message: "type is required and must be monthly or yearly"
            });
        }

        const year =
            req.query.year == null ||
            String(req.query.year).trim() === ""
                ? currentYear
                : Number(req.query.year);

        if (!Number.isInteger(year) || year < 1900 || year > 9999) {
            return res.status(400).json({
                success: false,
                message: "Year must be an integer between 1900 and 9999"
            });
        }

        let month = null;

        if (type === "monthly") {
            if (
                req.query.month == null ||
                String(req.query.month).trim() === ""
            ) {
                month = currentMonth;
            } else {
                month = Number(req.query.month);
            }

            if (!Number.isInteger(month) || month < 1 || month > 12) {
                return res.status(400).json({
                    success: false,
                    message: "Month must be an integer between 1 and 12"
                });
            }
        }

        const work_location =
            req.query.work_location == null ||
            String(req.query.work_location).trim() === ""
                ? null
                : String(req.query.work_location).trim();

        const username =
            req.query.username == null ||
            String(req.query.username).trim() === ""
                ? null
                : String(req.query.username).trim();

        const name =
            req.query.name == null ||
            String(req.query.name).trim() === ""
                ? null
                : String(req.query.name).trim();

        let yearly_filter = null;
        let financial_year = null;

        if (type === "yearly") {
            yearly_filter = String(req.query.yearly_filter || "")
                .trim()
                .toLowerCase();

            if (!["joining_date", "financial_year"].includes(yearly_filter)) {
                return res.status(400).json({
                    success: false,
                    message: "yearly_filter is required and must be joining_date or financial_year"
                });
            }

            if (yearly_filter === "joining_date") {
                if (!Number.isInteger(year) || year < 1900 || year > 9999) {
                    return res.status(400).json({
                        success: false,
                        message: "year is required for joining_date"
                    });
                }
            }

            if (yearly_filter === "financial_year") {
                financial_year =
                    req.query.financial_year == null ||
                    String(req.query.financial_year).trim() === ""
                        ? `${year}-${String(year + 1).slice(-2)}`
                        : String(req.query.financial_year).trim();
            }
        }

        const data = await getPayrollSalaryReportModel({
            type,
            month,
            year,
            work_location,
            username,
            name,
            yearly_filter,
            financial_year
        });

        return res.status(200).json({
            success: true,
            message:
                type === "monthly"
                    ? "Monthly salary report fetched successfully"
                    : "Yearly salary report fetched successfully",
            data
        });

    } catch (error) {
        console.error("GET PAYROLL SALARY REPORT ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch payroll salary report",
            error: error.message
        });
    }
};

export const getCompanyPayrollReport = async (req, res) => {
    try {
        const { currentMonth, currentYear } = getIndiaMonthYear();

        const type = String(req.query.type || "")
            .trim()
            .toLowerCase();

        if (!["monthly", "yearly"].includes(type)) {
            return res.status(400).json({
                success: false,
                message: "type is required and must be monthly or yearly"
            });
        }

        const year =
            req.query.year == null ||
            String(req.query.year).trim() === ""
                ? currentYear
                : Number(req.query.year);

        if (!Number.isInteger(year) || year < 1900 || year > 9999) {
            return res.status(400).json({
                success: false,
                message: "Year must be an integer between 1900 and 9999"
            });
        }

        let month = null;

        if (type === "monthly") {
            if (
                req.query.month == null ||
                String(req.query.month).trim() === ""
            ) {
                month = currentMonth;
            } else {
                month = Number(req.query.month);
            }

            if (!Number.isInteger(month) || month < 1 || month > 12) {
                return res.status(400).json({
                    success: false,
                    message: "Month must be an integer between 1 and 12"
                });
            }
        }

        const work_location =
            req.query.work_location == null ||
            String(req.query.work_location).trim() === ""
                ? null
                : String(req.query.work_location).trim();

        let yearly_filter = null;
        let financial_year = null;

        if (type === "yearly") {
            yearly_filter = String(req.query.yearly_filter || "")
                .trim()
                .toLowerCase();

            if (!["joining_date", "financial_year"].includes(yearly_filter)) {
                return res.status(400).json({
                    success: false,
                    message:
                        "yearly_filter is required and must be joining_date or financial_year"
                });
            }

            if (yearly_filter === "financial_year") {
                financial_year =
                    req.query.financial_year == null ||
                    String(req.query.financial_year).trim() === ""
                        ? `${year}-${String(year + 1).slice(-2)}`
                        : String(req.query.financial_year).trim();
            }
        }

        const data = await getCompanyPayrollReportModel({
            type,
            month,
            year,
            work_location,
            yearly_filter,
            financial_year
        });

        return res.status(200).json({
            success: true,
            message: `${type === "monthly" ? "Monthly" : "Yearly"} company salary report fetched successfully`,
            data
        });
    } catch (error) {
        console.error("GET COMPANY PAYROLL REPORT ERROR:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to fetch company salary report",
            error: error.message
        });
    }
};

export const getPayrollIncrementReport = async (req, res) => {
    try {
        const work_location =
            req.query.work_location == null ||
            String(req.query.work_location).trim() === ""
                ? null
                : String(req.query.work_location).trim();

        const name =
            req.query.name == null ||
            String(req.query.name).trim() === ""
                ? null
                : String(req.query.name).trim();

        const username =
            req.query.username == null ||
            String(req.query.username).trim() === ""
                ? null
                : String(req.query.username).trim();

        const data = await getPayrollIncrementReportModel({
            work_location,
            name,
            username
        });

        return res.status(200).json({
            success: true,
            message: "Employee increment report fetched successfully",
            data
        });
    } catch (error) {
        console.error("GET PAYROLL INCREMENT REPORT ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch yearly increment report",
            error: error.message
        });
    }
};

export const getFinancialYearSalaryReport = async (req, res) => {
    try {
        const work_location =
            req.query.work_location == null ||
            String(req.query.work_location).trim() === ""
                ? null
                : String(req.query.work_location).trim();
        const username =
            req.query.username == null ||
            String(req.query.username).trim() === ""
                ? null
                : String(req.query.username).trim();

        const hasYearlyFilters =
            req.query.type != null ||
            req.query.yearly_filter != null ||
            req.query.financial_year != null;

        // No financial-year filters: return all financial years.
        if (!hasYearlyFilters) {
            const data = await getFinancialYearSalaryReportModel({
                work_location,
                username,
                mode: "all"
            });

            return res.status(200).json({
                success: true,
                message: "Financial year salary report fetched successfully",
                data
            });
        }

        // Financial-year filters: return one year with monthly chart.
        const type = String(req.query.type || "yearly")
            .trim()
            .toLowerCase();

        const yearly_filter = String(
            req.query.yearly_filter || "financial_year"
        )
            .trim()
            .toLowerCase();

        const financial_year = String(
            req.query.financial_year || ""
        ).trim();

        const data = await getFinancialYearSalaryReportModel({
            work_location,
            username,
            type,
            yearly_filter,
            financial_year,
            mode: "detail"
        });

        return res.status(200).json({
            success: true,
            message: "Financial year monthly salary report fetched successfully",
            data
        });
    } catch (error) {
        console.error(
            "GET FINANCIAL YEAR SALARY REPORT ERROR:",
            error
        );

        return res.status(500).json({
            success: false,
            message: "Failed to fetch financial year salary report",
            error: error.message
        });
    }
};