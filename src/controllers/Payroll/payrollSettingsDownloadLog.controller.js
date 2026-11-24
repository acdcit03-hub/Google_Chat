import { getPayrollSettingsDownloadLogsModel } from "../../models/Payroll/payrollSettingsDownloadLog.model";

// GET PAYROLL TXT DOWNLOAD LOGS
export const getPayrollSettingsDownloadLogs = async (req, res) => {
    try {
        const monthValue = req.query.payroll_month;
        const yearValue = req.query.payroll_year;

        const payroll_month =
            monthValue == null || monthValue === ""
                ? null
                : Number(monthValue);

        const payroll_year =
            yearValue == null || yearValue === ""
                ? null
                : Number(yearValue);

        if (
            (payroll_month !== null &&
                (!Number.isInteger(payroll_month) ||
                    payroll_month < 1 ||
                    payroll_month > 12)) ||
            (payroll_year !== null &&
                (!Number.isInteger(payroll_year) ||
                    payroll_year < 2000 ||
                    payroll_year > 9999))
        ) {
            return res.status(400).json({
                success: false,
                message: "Invalid payroll_month or payroll_year."
            });
        }

        const logs = await getPayrollSettingsDownloadLogsModel({
            payroll_month,
            payroll_year
        });

        return res.status(200).json({
            success: true,
            count: logs.length,
            data: logs
        });
    } catch (error) {
        console.error("GET PAYROLL DOWNLOAD LOGS ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch payroll download logs."
        });
    }
};