import { getMonthlyEmployeeAttendanceReport } from "../../models/Payroll/monthlyEmployeeReport.model.js";

export const getMonthlyEmployeeAttendanceReportController =
    async (req, res) => {
        try {
            const month = req.query.month;
            const year = req.query.year;

            if (!month || !year) {
                return res.status(400).json({
                    success: false,
                    message: "month and year are required."
                });
            }

            const username =
                req.query.username?.trim() || null;

            const work_location =
                req.query.work_location?.trim() || null;

            const data = await getMonthlyEmployeeAttendanceReport({
                month,
                year,
                username,
                work_location
            });

            return res.status(200).json({
                success: true,
                message: "Employees fetched successfully.",
                data
            });
        } catch (error) {
            console.error(
                "MONTHLY EMPLOYEE ATTENDANCE REPORT ERROR:",
                error
            );

            return res.status(500).json({
                success: false,
                message: "Failed to fetch employee attendance report.",
                error: error.message
            });
        }
    };
