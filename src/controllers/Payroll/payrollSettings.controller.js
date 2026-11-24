
import {
    getPayrollSettingsModel
} from "../../models/Payroll/payrollSettings.model.js";

import {
    createPayrollSettingsDownloadLogModel,
    getPayrollSettingsDownloadLogsModel
} from "../../models/Payroll/payrollSettingsDownloadLog.model.js";

const getRequestValue = (req, ...keys) => {
    for (const key of keys) {
        if (req.body?.[key] != null) {
            return req.body[key];
        }

        if (req.query?.[key] != null) {
            return req.query[key];
        }
    }

    return undefined;
};

const validatePayrollPeriod = (month, year) => {
    return (
        Number.isInteger(month) &&
        month >= 1 &&
        month <= 12 &&
        Number.isInteger(year) &&
        year >= 2000 &&
        year <= 9999
    );
};

const isBOB = (row) => {
    const bankName = String(row.bank_name ?? "")
        .trim()
        .toUpperCase()
        .replace(/\s+/g, " ");

    return ["BOB", "BOD", "BANK OF BARODA"].includes(bankName);
};

// GET PAYROLL SETTINGS
export const getPayrollSettings = async (req, res) => {
    try {
        const payroll_month = Number(req.query.payroll_month);
        const payroll_year = Number(req.query.payroll_year);

        if (
            !req.query.payroll_month ||
            !req.query.payroll_year ||
            !validatePayrollPeriod(payroll_month, payroll_year)
        ) {
            return res.status(400).json({
                success: false,
                message: "Valid payroll_month and payroll_year are required."
            });
        }

        const rows = await getPayrollSettingsModel({
            payroll_month,
            payroll_year
        });

        const data = rows.map((row, index) => {
            if (isBOB(row)) {
                const amount = Number(row.amount);

                if (!Number.isFinite(amount) || amount < 0) {
                    throw new Error(
                        `Invalid salary amount for username ${row.username}`
                    );
                }

                const creditAccount = String(
                    row.credit_ac_no ?? ""
                ).trim();

                return {
                    Credit_Ac_No: row.credit_ac_no,
                    Amount: `INR${creditAccount.slice(0, 4)}`,
                    Transaction_Type:
                        String(row.salary_status ?? "")
                            .trim()
                            .toLowerCase() === "paid"
                            ? "C"
                            : "",
                    Payment_Details: `${amount.toFixed(2)}SALARY`
                };
            }

            return {
                Serial_No: String(index + 1).padStart(3, "0"),
                Debit_Ac: row.debit_ac,
                Amount: row.amount,
                IFSC_Code: row.ifsc_code,
                Credit_Ac_No: row.credit_ac_no,
                Beneficiary_Name: row.beneficiary_name,
                Scheme_Type: row.scheme_type
            };
        });

        return res.status(200).json({
            success: true,
            count: data.length,
            data
        });
    } catch (error) {
        console.error("GET PAYROLL SETTINGS ERROR:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to fetch payroll settings."
        });
    }
};

// DOWNLOAD PAYROLL SETTINGS TXT
export const downloadPayrollSettingsTxt = async (req, res) => {
    try {
        const payroll_month = Number(
            getRequestValue(req, "payroll_month")
        );

        const payroll_year = Number(
            getRequestValue(req, "payroll_year")
        );

        const format = String(
            getRequestValue(req, "format") ?? "non-bob"
        ).trim().toLowerCase();

        const rawDebitAc = getRequestValue(
            req,
            "Debit_Ac",
            "company_number"
        );

        const company_number =
            rawDebitAc == null ? "" : String(rawDebitAc).trim();

        if (!validatePayrollPeriod(payroll_month, payroll_year)) {
            return res.status(400).json({
                success: false,
                message: "Valid payroll_month and payroll_year are required."
            });
        }

        if (!["non-bob", "bob"].includes(format)) {
            return res.status(400).json({
                success: false,
                message: "Invalid format. Use bob or non-bob."
            });
        }

        if (format === "non-bob" && !company_number) {
            return res.status(400).json({
                success: false,
                message: "Debit_Ac is required for non-bob format."
            });
        }

        const rows = await getPayrollSettingsModel({
            payroll_month,
            payroll_year,
            company_number:
                format === "non-bob" ? company_number : null
        });

        const bobRows = rows.filter(isBOB);
        const nonBobRows = rows.filter((row) => !isBOB(row));

        const month = String(payroll_month).padStart(2, "0");
        const year = payroll_year;

        let txtContent;
        let fileName;
        let employee_count;

        // BOB FORMAT: Debit_Ac is not included
        if (format === "bob") {
            if (bobRows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: "No Bank of Baroda payroll records found."
                });
            }

            txtContent = bobRows.map((row) => {
                const amount = Number(row.amount);

                if (!Number.isFinite(amount) || amount < 0) {
                    throw new Error(
                        `Invalid salary amount for username ${row.username}`
                    );
                }

                const creditAccount = String(
                    row.credit_ac_no ?? ""
                ).trim();

                const fullAccount = creditAccount;
                const paySlipNo = String(row.pay_slip_no ?? "").trim();
                const firstFourDigits = creditAccount.slice(0, 4);
                const transactionType = "C";
                const paymentDetails = `${amount.toFixed(2)}SALARY`;

                return (
                    paySlipNo +
                    "    " +
                    fullAccount.padEnd(14, " ") +
                    "    " +
                    `INR${firstFourDigits}` +
                    "     " +
                    transactionType +
                    "         " +
                    paymentDetails
                );
            }).join("\r\n");

            fileName = `payroll_settings_BOB_${year}_${month}.txt`;
            employee_count = bobRows.length;
        } else {
            // NON-BOB FORMAT: Debit_Ac is included
            if (nonBobRows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: "No non-BOB payroll records found."
                });
            }

            const sanitize = (value) =>
                String(value ?? "")
                    .replace(/[|\r\n]/g, " ")
                    .trim();

            const headers = [
                "Sheet|Sheet1",
                [
                    "Serial_No",
                    "Pay_Slip_No",
                    "Debit_Ac",
                    "Amount",
                    "IFSC_Code",
                    "Credit_Ac_No",
                    "Beneficiary_Name",
                    "Scheme_Type"
                ].join("|")
            ];

            txtContent = [
                ...headers,
                ...nonBobRows.map((row, index) => [
                    String(index + 1).padStart(3, "0"),
                    row.pay_slip_no,
                    company_number,
                    row.amount,
                    row.ifsc_code,
                    row.credit_ac_no,
                    row.beneficiary_name,
                    row.scheme_type
                ].map(sanitize).join("|"))
            ].join("\r\n");

            fileName =
                `payroll_settings_non_BOB_${year}_${month}.txt`;

            employee_count = nonBobRows.length;
        }

        // Identify the user who initiated the download
        const downloaded_by =
            req.user?.username ||
            req.headers["x-hrms-username"] ||
            req.headers["x-username"] ||
            null;

        // Save the download log before sending the file
        await createPayrollSettingsDownloadLogModel({
            payroll_month,
            payroll_year,
            format,
            company_account_no:
                format === "non-bob" ? company_number : null,
            downloaded_by,
            file_name: fileName,
            employee_count
        });

        res.setHeader(
            "Content-Type",
            "text/plain; charset=utf-8"
        );

        res.setHeader(
            "Content-Disposition",
            `attachment; filename="${fileName}"`
        );

        return res.status(200).send(txtContent);

    } catch (error) {
        console.error("DOWNLOAD PAYROLL SETTINGS TXT ERROR:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to download payroll settings TXT file."
        });
    }
};

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
