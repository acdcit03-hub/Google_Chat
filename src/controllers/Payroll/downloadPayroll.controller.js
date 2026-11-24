import PDFDocument from "pdfkit";
import JSZip from "jszip";

import {
    generateEmployeePayrollForMonthModel,
    getAllEmployeePayrollConfigModel
} from "../../models/Payroll/employee_payroll_config.model.js";
import {
    getEmployeeDailyRecordsModel,
    getPayrollEmployeesModel
} from "../../models/Payroll/payroll.model.js";

const formatNumber = (value, decimalPlaces = 2) =>
    Number(value || 0).toLocaleString("en-IN", {
        minimumFractionDigits: decimalPlaces,
        maximumFractionDigits: decimalPlaces
    });

const createPayrollPdf = pages => new Promise((resolve, reject) => {
    const document = new PDFDocument({
        size: "A4",
        layout: "portrait",
        margin: 24
    });
    const chunks = [];

    document.on("data", chunk => chunks.push(chunk));
    document.on("error", reject);
    document.on("end", () => resolve(Buffer.concat(chunks)));

    const attendanceColumnWidths = [130, 62, 66, 66, 66, 70, 70];
    const summaryColumnWidths = [190, 90];
    const fontSize = 9;
    const availablePageHeight =
        document.page.height -
        document.page.margins.top -
        document.page.margins.bottom;
    const rowHeight = Math.min(
        14,
        availablePageHeight /
        Math.max(pages[0]?.sheetData.length || 2, 1)
    );
    const green = "#C6EFCE";
    const yellow = "#FFFF00";
    const black = "#000000";

    const drawRow = (values, y, options = {}) => {
        let x = document.page.margins.left;
        const columnWidths = options.summary
            ? summaryColumnWidths
            : attendanceColumnWidths;

        columnWidths.forEach((width, column) => {
            const value = values[column] ?? "";
            const fill =
                options.fill ||
                (options.highlight && column === 1 ? yellow : null);

            if (fill) {
                document.save();
                document.rect(x, y, width, rowHeight).fill(fill);
                document.restore();
            }

            document
                .lineWidth(0.75)
                .strokeColor(black)
                .rect(x, y, width, rowHeight)
                .stroke();

            document
                .font(options.bold ? "Helvetica-Bold" : "Helvetica")
                .fontSize(fontSize)
                .fillColor(black)
                .text(String(value), x + 7, y + (rowHeight - fontSize) / 2, {
                    width: width - 10,
                    height: rowHeight,
                    align: options.alignments?.[column] ||
                        (options.header ? "center" : "left"),
                    lineBreak: false,
                    ellipsis: true
                });
            x += width;
        });
    };

    const drawEmployeePage = (page, addPage) => {
        if (addPage) {
            document.addPage();
        }

        let y = document.page.margins.top;
        const monthRowIndex = page.dailyRecordCount + 4;
        const summaryRows = new Set(
            Array.from({ length: 10 }, (_, index) => monthRowIndex + index)
        );

        page.sheetData.forEach((row, rowIndex) => {
            if (!Array.isArray(row) || row.length === 0) {
                y += rowHeight;
                return;
            }

            const isHeader = rowIndex === 0;
            const isMonthRow = rowIndex === monthRowIndex;
            const isSummary = summaryRows.has(rowIndex);
            const isHighlighted =
                rowIndex === monthRowIndex + 7 ||
                rowIndex === monthRowIndex + 9;
            const values = row.map((value, column) => {
                if (!isSummary || column !== 1 || typeof value !== "number") {
                    return value;
                }

                const decimalPlaces =
                    rowIndex === monthRowIndex + 2
                        ? 0
                        : rowIndex === monthRowIndex + 4
                            ? 3
                            : rowIndex === monthRowIndex + 5 ||
                                rowIndex === monthRowIndex + 6
                                ? 0
                                : 2;
                return formatNumber(value, decimalPlaces);
            });
            drawRow(values, y, {
                header: isHeader,
                bold: isHeader || isMonthRow || isHighlighted,
                fill: isHeader || isMonthRow ? green : null,
                highlight: isHighlighted,
                summary: isSummary,
                alignments: isMonthRow
                    ? ["center", "center"]
                    : isSummary
                        ? ["left", "right"]
                        : undefined
            });
            y += rowHeight;
        });
    };

    if (pages.length === 0) {
        drawRow(["Message"], document.page.margins.top, {
            header: true,
            bold: true,
            fill: green,
            summary: true
        });
        drawRow(
            ["No payroll employee data found for the selected filters"],
            document.page.margins.top + rowHeight,
            { summary: true }
        );
    } else {
        pages.forEach((page, index) => drawEmployeePage(page, index > 0));
    }

    document.end();
});

export const downloadEmployeePayroll = async (req, res) => {
    try {
        const {
            month,
            year,
            work_location = null,
            username = null
        } = req.query;

        const currentPeriodParts = new Intl.DateTimeFormat("en-US", {
            timeZone: "Asia/Kolkata",
            year: "numeric",
            month: "numeric"
        }).formatToParts(new Date());
        
        const currentPeriod = Object.fromEntries(
            currentPeriodParts
                .filter(part => part.type === "month" || part.type === "year")
                .map(part => [part.type, Number(part.value)])
        );

        const monthValue =
            month == null || String(month).trim() === ""
                ? currentPeriod.month
                : Number(month);

        const yearValue =
            year == null || String(year).trim() === ""
                ? currentPeriod.year
                : Number(year);

        if (
            !Number.isInteger(monthValue) ||
            monthValue < 1 ||
            monthValue > 12
        ) {
            return res.status(400).json({
                success: false,
                message: "Month must be between 1 and 12"
            });
        }

        if (
            !Number.isInteger(yearValue) ||
            yearValue < 1900 ||
            yearValue > 9999
        ) {
            return res.status(400).json({
                success: false,
                message: "Year must be in YYYY format"
            });
        }

        const result = await getAllEmployeePayrollConfigModel({
            work_location,
            month: monthValue,
            year: yearValue,
            pagination: false
        });

        const attendanceEmployees = await getPayrollEmployeesModel({
            month: monthValue,
            year: yearValue,
            work_location
        });

        const attendanceByUsername = new Map(
            attendanceEmployees.map(employee => [
                String(employee.username || "").trim().toLowerCase(),
                employee
            ])
        );

        const usernameFilter =
            username == null || String(username).trim() === ""
                ? null
                : String(username).trim().toLowerCase();

        const activeConfigEmployees = result.employees.filter(employee =>
            employee.payroll?.configuration?.some(
                config =>
                    config.payroll_config_id !== null &&
                    config.payroll_config_id !== undefined &&
                    config.payroll_status === "active"
            )
        );

        if (usernameFilter) {
            const requestedEmployee = result.employees.find(
                employee =>
                    String(employee.username || "").trim().toLowerCase() ===
                    usernameFilter
            );

            if (!requestedEmployee) {
                return res.status(404).json({
                    success: false,
                    message: `Payroll employee '${String(username).trim()}' was not found for the selected filters`
                });
            }

            const requestedPayrollStatus = requestedEmployee.payroll?.configuration?.[0]?.payroll_status;

            if (
                requestedPayrollStatus === "pending" ||
                requestedPayrollStatus === "expire"
            ) {
                return res.status(400).json({
                    success: false,
                    payroll_status: requestedPayrollStatus,
                    message:
                        requestedPayrollStatus === "pending"
                            ? `Payroll for '${String(username).trim()}' is pending and cannot be downloaded`
                            : `Payroll for '${String(username).trim()}' has expired and cannot be downloaded`
                });
            }
        }

        const employees = usernameFilter
            ? activeConfigEmployees.filter(
                employee =>
                    String(employee.username || "").trim().toLowerCase() ===
                    usernameFilter
            )
            : activeConfigEmployees;
            
        const payrollPages = [];

        const monthName = new Date(
            Date.UTC(yearValue, monthValue - 1, 1)
        ).toLocaleString("en-US", {
            month: "long",
            timeZone: "UTC"
        }).toUpperCase();

        for (const employee of employees) {
            const usernameKey = String(employee.username || "")
                .trim()
                .toLowerCase();

            const attendanceEmployee = attendanceByUsername.get(usernameKey);
            const payroll = employee.payroll || {};
            const config = payroll.configuration?.[0] || {};
            const employeeName = [
                employee.first_name,
                employee.last_name
            ]
                .map(name => String(name || "").trim())
                .filter(Boolean)
                .join(" ");

            let dailyRecords = [];
            let companyTotalDays = 0;
            let companyFullMonthDays = 0;
            let companyTotalMinutes = 0;

            if (attendanceEmployee) {
                const records = await getEmployeeDailyRecordsModel({
                    username: employee.username,
                    month: monthValue,
                    year: yearValue,
                    work_location_id: attendanceEmployee.work_location_id
                });

                dailyRecords = records.map(record => {
                    const totalMinutes = Math.round(
                        Number(record.total_minutes || 0)
                    );

                    return {
                        date: record.date,
                        checkIn: record.is_holiday
                            ? (
                                record.working_start_time ||
                                attendanceEmployee.working_start_time ||
                                ""
                            )
                            : record.first_in
                                ? new Date(record.first_in).toLocaleTimeString(
                                    "en-GB",
                                    { timeZone: "Asia/Kolkata" }
                                )
                                : "",
                        checkOut: record.is_holiday
                            ? (
                                record.working_end_time ||
                                attendanceEmployee.working_end_time ||
                                ""
                            )
                            : record.last_out
                                ? new Date(record.last_out).toLocaleTimeString(
                                    "en-GB",
                                    { timeZone: "Asia/Kolkata" }
                                )
                                : "",
                        totalMinutes,
                        totalHours: `${String(
                            Math.floor(totalMinutes / 60)
                        ).padStart(2, "0")}:${String(
                            totalMinutes % 60
                        ).padStart(2, "0")}:00`,
                        totalOvertimeMinutes: Math.max(
                            totalMinutes -
                            Math.max(
                                Math.floor(
                                    (
                                        new Date(
                                            `1970-01-01T${attendanceEmployee.working_end_time || "00:00:00"}`
                                        ).getTime() -
                                        new Date(
                                            `1970-01-01T${attendanceEmployee.working_start_time || "00:00:00"}`
                                        ).getTime()
                                    ) / 60000
                                ),
                                0
                            ),
                            0
                        )
                    };
                }).sort((left, right) => right.date.localeCompare(left.date));

                companyTotalDays = Number(
                    attendanceEmployee.company_total_days || 0
                );

                companyFullMonthDays = Number(
                    attendanceEmployee.company_full_month_days || 0
                );

                companyTotalMinutes = Math.round(
                    Number(attendanceEmployee.company_total_minutes || 0)
                );
            }

            const baseSalary = Number(payroll.current_salary || 0);

            const perDaySalary =
                companyTotalDays > 0
                    ? baseSalary / companyTotalDays
                    : 0;

            const dayType = String(config.day_type || "none")
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

            const perMinuteSalary =
                companyTotalMinutes > 0
                    ? baseSalary / companyTotalMinutes
                    : 0;

            const employeeWorkingMinutes = dailyRecords.reduce(
                (total, record) => total + record.totalMinutes,
                0
            );

            const overtimeMinutes = employeeWorkingMinutes - companyTotalMinutes;
            const salaryBasedOnWorkingMinutes = employeeWorkingMinutes * perMinuteSalary;

            const finalTotalSalary =
                Number(
                    (
                        salaryBasedOnWorkingMinutes + extraDayTypeSalary
                    ).toFixed(2)
                );

            if (
                config.payroll_config_id !== null &&
                config.payroll_config_id !== undefined
            ) {
                await generateEmployeePayrollForMonthModel({
                    username: employee.username,
                    month: monthValue,
                    year: yearValue,
                    created_by:
                        req.headers["x-hrms-username"] ||
                        req.headers["x-username"] ||
                        "system",
                    payrollCalculation: {
                        basicSalary: baseSalary,
                        overtimeMinutes,
                        overtimeHours: overtimeMinutes / 60,
                        overtimeAmount:
                            companyTotalMinutes > 0
                                ? (
                                    baseSalary *
                                    overtimeMinutes /
                                    companyTotalMinutes
                                )
                                : 0,
                        netSalary: finalTotalSalary
                    }
                });
            }

            const sheetData = [
                [
                    "Employee Name",
                    "Date",
                    "Check In",
                    "Check Out",
                    "Total Hour",
                    "Total Minu",
                    "Total Over"
                ],
                ...dailyRecords.map(record => [
                    employeeName,
                    record.date
                        ? `${record.date.slice(8, 10)}-${record.date.slice(5, 7)}-${record.date.slice(0, 4)}`
                        : "",
                    record.checkIn,
                    record.checkOut,
                    record.totalHours,
                    record.totalMinutes,
                    `${String(
                        Math.floor(record.totalOvertimeMinutes / 60)
                    ).padStart(2, "0")}:${String(
                        record.totalOvertimeMinutes % 60
                    ).padStart(2, "0")}:00`
                ]),
                [],
                [],
                [],
                ["MONTH", monthName],
                ["Base salary", baseSalary],
                ["Total Working Days", companyTotalDays],
                ["Per day salary", perDaySalary],
                ["Per minutes salary", perMinuteSalary],
                ["Company Standard Minute", companyTotalMinutes],
                ["Employee Working Minute", employeeWorkingMinutes],
                ["Salary based on Working Minute", salaryBasedOnWorkingMinutes],
                ["Extra Day Type Salary", extraDayTypeSalary],
                ["Final Total Salary", finalTotalSalary]
            ];

            payrollPages.push({
                username: employee.username,
                first_name: employee.first_name,
                last_name: employee.last_name,
                sheetData,
                dailyRecordCount: dailyRecords.length
            });
        }

        const locationSuffix = work_location
            ? `_${String(work_location).trim().replace(/[^a-z0-9_-]/gi, "_")}`
            : "";
        const usernameSuffix = usernameFilter
            ? `_${String(username).trim().replace(/[^a-z0-9_-]/gi, "_")}`
            : "";

        if (usernameFilter) {
            const buffer = await createPayrollPdf(payrollPages);
            const page = payrollPages[0];

            const sanitizeName = value =>
                String(value || "")
                    .trim()
                    .replace(/\s+/g, "_")
                    .replace(/[^a-z0-9_-]/gi, "_")
                    .replace(/^_+|_+$/g, "");

            const firstName = sanitizeName(page?.first_name);
            const lastName = sanitizeName(page?.last_name);
            const fileName = `${firstName}_${lastName}_${monthValue}_${yearValue}.pdf`;

            res.setHeader(
                "Content-Disposition",
                `attachment; filename="${fileName}"`
            );
            res.setHeader("Content-Type", "application/pdf");

            return res.status(200).send(buffer);
        }

        const archive = new JSZip();
        const usedPdfNames = new Set();

        if (payrollPages.length === 0) {
            archive.file(
                "No_employee_data.pdf",
                await createPayrollPdf([])
            );
        } else {
            for (const page of payrollPages) {

                const firstName = String(page.first_name || "")
                    .trim()
                    .replace(/\s+/g, "_")
                    .replace(/[^a-z0-9_-]/gi, "_");

                const lastName = String(page.last_name || "")
                    .trim()
                    .replace(/\s+/g, "_")
                    .replace(/[^a-z0-9_-]/gi, "_");

                const baseName =
                    `${firstName}_${lastName}_${monthValue}_${yearValue}`
                        .replace(/^_+|_+$/g, "") || "Employee";


                let pdfName = `${baseName}.pdf`;
                let suffix = 1;

                while (usedPdfNames.has(pdfName.toLowerCase())) {
                    pdfName = `${baseName}_${suffix}.pdf`;
                    suffix += 1;
                }

                usedPdfNames.add(pdfName.toLowerCase());
                archive.file(
                    pdfName,
                    await createPayrollPdf([page])
                );
            }
        }

        const buffer = await archive.generateAsync({
            type: "nodebuffer",
            compression: "DEFLATE"
        });

        const fileName =
            `Payroll_${monthValue}_${yearValue}` +
            `${locationSuffix}.zip`;

        res.setHeader(
            "Content-Disposition",
            `attachment; filename="${fileName}"`
        );

        res.setHeader(
            "Content-Type",
            "application/zip"
        );

        return res.status(200).send(buffer);
    } catch (error) {
        console.error("DOWNLOAD EMPLOYEE PAYROLL ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to download payroll data",
            error: error.message
        });
    }
};
