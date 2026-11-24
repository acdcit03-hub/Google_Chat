import XLSX from "xlsx-js-style";

import {
    getActiveEmployeeMonthlyAttendanceModel
} from "../../models/Download/MonthlyAttendance.model.js";

/* =========================================================
   CONVERT DURATION TO SECONDS
========================================================= */

const parseDurationToSeconds = (duration) => {

    if (
        duration === null ||
        duration === undefined ||
        duration === ""
    ) {
        return 0;
    }

    /* PostgreSQL interval object */

    if (typeof duration === "object") {

        const hours =
            Number(duration.hours || 0);

        const minutes =
            Number(duration.minutes || 0);

        const seconds =
            Number(duration.seconds || 0);

        return (
            hours * 3600 +
            minutes * 60 +
            seconds
        );
    }

    /* PostgreSQL interval string */

    if (typeof duration === "string") {

        const value =
            duration.trim();

        /* HH:MM:SS */

        const timeMatch =
            value.match(
                /^(\d+):(\d{2}):(\d{2})(?:\.\d+)?$/
            );

        if (timeMatch) {

            return (
                Number(timeMatch[1]) * 3600 +
                Number(timeMatch[2]) * 60 +
                Number(timeMatch[3])
            );
        }

        /* PostgreSQL text format */

        const hoursMatch =
            value.match(
                /(\d+)\s*hours?/i
            );

        const minutesMatch =
            value.match(
                /(\d+)\s*mins?/i
            );

        const secondsMatch =
            value.match(
                /(\d+)\s*secs?/i
            );

        return (
            Number(hoursMatch?.[1] || 0) * 3600 +
            Number(minutesMatch?.[1] || 0) * 60 +
            Number(secondsMatch?.[1] || 0)
        );
    }

    return 0;
};

/* =========================================================
   SECONDS TO HH:MM:SS
========================================================= */

const secondsToHHMMSS = (totalSeconds) => {

    if (
        totalSeconds === null ||
        totalSeconds === undefined ||
        totalSeconds <= 0
    ) {
        return "";
    }

    const hours =
        Math.floor(
            totalSeconds / 3600
        );

    const minutes =
        Math.floor(
            (totalSeconds % 3600) / 60
        );

    const seconds =
        Math.floor(
            totalSeconds % 60
        );

    return (
        String(hours).padStart(2, "0") +
        ":" +
        String(minutes).padStart(2, "0") +
        ":" +
        String(seconds).padStart(2, "0")
    );
};

/* =========================================================
   CONTROLLER
========================================================= */

export const getActiveEmployeeMonthlyAttendance = async (
    req,
    res
) => {

    try {

        const {
            month,
            year,
            username,
            work_location,
            category
        } = req.query;

        /* =====================================================
           VALIDATION
        ===================================================== */

        if (!month || !year) {

            return res.status(400).json({
                success: false,
                message: "month and year are required"
            });
        }

        const monthNumber =
            Number(month);

        const yearNumber =
            Number(year);

        if (
            !Number.isInteger(monthNumber) ||
            monthNumber < 1 ||
            monthNumber > 12
        ) {

            return res.status(400).json({
                success: false,
                message: "Invalid month"
            });
        }

        if (
            !Number.isInteger(yearNumber) ||
            yearNumber < 2000
        ) {

            return res.status(400).json({
                success: false,
                message: "Invalid year"
            });
        }

        /* =====================================================
           GET DATABASE DATA
        ===================================================== */

        const rows =
            await getActiveEmployeeMonthlyAttendanceModel({
                month: monthNumber,
                year: yearNumber,
                username,
                work_location,
                category
            });

        /* =====================================================
           CREATE WORKBOOK
        ===================================================== */

        const workbook =
            XLSX.utils.book_new();

        /* =====================================================
           GROUP BY USERNAME
        ===================================================== */

        const employees = {};

        rows.forEach(row => {

            const employeeUsername =
                String(
                    row.username || ""
                )
                    .trim()
                    .toUpperCase();

            if (!employeeUsername) {
                return;
            }

            if (!employees[employeeUsername]) {

                employees[employeeUsername] = {

                    username:
                        employeeUsername,

                    employee_name: [
                        row.first_name,
                        row.middle_name,
                        row.last_name
                    ]
                        .filter(Boolean)
                        .join(" "),

                    employment_id:
                        row.employment_id || "",

                    rows: []
                };
            }

            employees[
                employeeUsername
            ].rows.push(row);
        });

        /* =====================================================
           CREATE EMPLOYEE SHEETS
        ===================================================== */

        Object.values(employees).forEach(
            employee => {

                const daysInMonth =
                    new Date(
                        yearNumber,
                        monthNumber,
                        0
                    ).getDate();

                /* =================================================
                   GROUP DATA BY DATE
                ================================================= */

                const dataByDate = {};
                const statusByDate = {};

                employee.rows.forEach(row => {

                    if (!row.date) {
                        return;
                    }

                    const dateKey =
                        new Date(row.date)
                            .toLocaleDateString(
                                "en-GB",
                                {
                                    timeZone:
                                        "Asia/Kolkata"
                                }
                            );

                    if (!dataByDate[dateKey]) {

                        dataByDate[dateKey] = [];
                    }

                    dataByDate[
                        dateKey
                    ].push(row);

                    if (row.day_status) {

                        statusByDate[
                            dateKey
                        ] = row.day_status;
                    }
                });

                /* =================================================
                   CREATE EXCEL ROWS
                ================================================= */

                const excelRows = [];

                /* =================================================
                   MONTHLY TOTAL VARIABLES
                ================================================= */

                let monthlyAttendanceSeconds = 0;

                let monthlyTimesheetSeconds = 0;

                let monthlyCompareSeconds = 0;

                /* =================================================
                   LOOP DAYS
                ================================================= */

                for (
                    let day = 1;
                    day <= daysInMonth;
                    day++
                ) {

                    const dateObject =
                        new Date(
                            yearNumber,
                            monthNumber - 1,
                            day
                        );

                    const date =
                        dateObject.toLocaleDateString(
                            "en-GB",
                            {
                                timeZone:
                                    "Asia/Kolkata"
                            }
                        );

                    const dayRows =
                        dataByDate[date] || [];

                    /* =============================================
                       ATTENDANCE TOTAL
                    ============================================= */

                    let attendanceTotalSeconds = 0;

                    /* =============================================
                       TIMESHEET TOTAL
                    ============================================= */

                    let timesheetTotalSeconds = 0;

                    dayRows.forEach(row => {

                        attendanceTotalSeconds +=
                            parseDurationToSeconds(
                                row.attendance_duration
                            );

                        timesheetTotalSeconds +=
                            parseDurationToSeconds(
                                row.duration
                            );
                    });

                    /* =============================================
                       STATUS
                    ============================================= */

                    const status =
                        statusByDate[date] || "";

                    /* =============================================
                       COMPARE
                       
                       Attendance - Timesheet
                    ============================================= */

                    let compareTotalSeconds =
                        attendanceTotalSeconds -
                        timesheetTotalSeconds;

                    if (
                        compareTotalSeconds < 0
                    ) {

                        compareTotalSeconds = 0;
                    }

                    /* =============================================
                       MONTHLY TOTAL

                       Do not count:
                       - Leave
                       - Holiday
                       - Weekly Off
                    ============================================= */

                    if (!status) {

                        monthlyAttendanceSeconds +=
                            attendanceTotalSeconds;

                        monthlyTimesheetSeconds +=
                            timesheetTotalSeconds;

                        monthlyCompareSeconds +=
                            compareTotalSeconds;
                    }

                    /* =============================================
                       FORMAT DURATIONS
                    ============================================= */

                    let attendanceDuration =
                        secondsToHHMMSS(
                            attendanceTotalSeconds
                        );

                    let timesheetDuration =
                        secondsToHHMMSS(
                            timesheetTotalSeconds
                        );

                    let compareDuration =
                        secondsToHHMMSS(
                            compareTotalSeconds
                        );

                    /* =============================================
                       STATUS DISPLAY

                       Leave / Holiday / Weekly Off
                       will replace duration display.
                    ============================================= */

                    if (status) {

                        attendanceDuration =
                            status;

                        timesheetDuration =
                            status;

                        compareDuration =
                            status;
                    }

                    /* =============================================
                       ADD EXCEL ROW
                    ============================================= */

                    excelRows.push([
                        date,
                        attendanceDuration,
                        timesheetDuration,
                        compareDuration
                    ]);
                }

                /* =================================================
                   MONTHLY TOTAL ROW
                ================================================= */

                const monthlyTotalRow = [

                    "MONTHLY TOTAL",

                    secondsToHHMMSS(
                        monthlyAttendanceSeconds
                    ),

                    secondsToHHMMSS(
                        monthlyTimesheetSeconds
                    ),

                    secondsToHHMMSS(
                        monthlyCompareSeconds
                    )
                ];

                /* =================================================
                   HEADER
                ================================================= */

                const sheetData = [

                    [
                        "Username",
                        employee.username
                    ],

                    [
                        "Employee Name",
                        employee.employee_name
                    ],

                    [
                        "Employment ID",
                        employee.employment_id
                    ],

                    [],

                    [
                        "Date",
                        "Attendance Duration",
                        "Timesheet Duration",
                        "Compare"
                    ]
                ];

                /* =================================================
                   ADD DAILY DATA
                ================================================= */

                excelRows.forEach(row => {

                    sheetData.push(row);
                });

                /* =================================================
                   EMPTY ROW BEFORE TOTAL
                ================================================= */

                sheetData.push([]);

                /* =================================================
                   ADD MONTHLY TOTAL
                ================================================= */

                sheetData.push(
                    monthlyTotalRow
                );

                /* =================================================
                   CREATE WORKSHEET
                ================================================= */

                const worksheet =
                    XLSX.utils.aoa_to_sheet(
                        sheetData
                    );

                /* =================================================
                   STATUS ROW COLORS
                ================================================= */

                excelRows.forEach(
                    (row, index) => {

                        const date =
                            row[0];

                        const status =
                            statusByDate[date];

                        if (!status) {
                            return;
                        }

                        const excelRowIndex =
                            index + 5;

                        let fillColor =
                            "FFF2CC";

                        const statusText =
                            String(status)
                                .trim()
                                .toLowerCase();

                        /* Weekly Off */

                        if (
                            statusText ===
                            "weekly off"
                        ) {

                            fillColor =
                                "D9EAF7";
                        }

                        /* Leave */

                        else if (
                            statusText.includes(
                                "leave"
                            )
                        ) {

                            fillColor =
                                "F4CCCC";
                        }

                        /* Holiday */

                        else {

                            fillColor =
                                "FFF2CC";
                        }

                        for (
                            let columnIndex = 0;
                            columnIndex < 4;
                            columnIndex++
                        ) {

                            const cell =
                                XLSX.utils.encode_cell({
                                    r:
                                        excelRowIndex,
                                    c:
                                        columnIndex
                                });

                            if (!worksheet[cell]) {
                                continue;
                            }

                            worksheet[cell].s = {

                                fill: {
                                    patternType:
                                        "solid",

                                    fgColor: {
                                        rgb:
                                            fillColor
                                    }
                                },

                                font: {

                                    bold: true,

                                    color: {
                                        rgb:
                                            "000000"
                                    }
                                },

                                alignment: {

                                    horizontal:
                                        "center",

                                    vertical:
                                        "center"
                                },

                                border: {

                                    top: {
                                        style:
                                            "thin",

                                        color: {
                                            rgb:
                                                "000000"
                                        }
                                    },

                                    bottom: {
                                        style:
                                            "thin",

                                        color: {
                                            rgb:
                                                "000000"
                                        }
                                    },

                                    left: {
                                        style:
                                            "thin",

                                        color: {
                                            rgb:
                                                "000000"
                                        }
                                    },

                                    right: {
                                        style:
                                            "thin",

                                        color: {
                                            rgb:
                                                "000000"
                                        }
                                    }
                                }
                            };
                        }
                    }
                );

                /* =================================================
                   GREEN HEADER
                ================================================= */

                const totalColumns = 4;

                for (
                    let columnIndex = 0;
                    columnIndex < totalColumns;
                    columnIndex++
                ) {

                    const cell =
                        XLSX.utils.encode_cell({
                            r: 4,
                            c: columnIndex
                        });

                    if (!worksheet[cell]) {
                        continue;
                    }

                    worksheet[cell].s = {

                        fill: {

                            patternType:
                                "solid",

                            fgColor: {

                                rgb:
                                    "93C47D"
                            }
                        },

                        font: {

                            bold: true,

                            color: {

                                rgb:
                                    "000000"
                            }
                        },

                        alignment: {

                            horizontal:
                                "center",

                            vertical:
                                "center"
                        },

                        border: {

                            top: {

                                style:
                                    "thin",

                                color: {

                                    rgb:
                                        "000000"
                                }
                            },

                            bottom: {

                                style:
                                    "thin",

                                color: {

                                    rgb:
                                        "000000"
                                }
                            },

                            left: {

                                style:
                                    "thin",

                                color: {

                                    rgb:
                                        "000000"
                                }
                            },

                            right: {

                                style:
                                    "thin",

                                color: {

                                    rgb:
                                        "000000"
                                }
                            }
                        }
                    };
                }

                /* =================================================
                   MONTHLY TOTAL ROW STYLE
                ================================================= */

                const totalRowIndex =
                    sheetData.length - 1;

                for (
                    let columnIndex = 0;
                    columnIndex < totalColumns;
                    columnIndex++
                ) {

                    const cell =
                        XLSX.utils.encode_cell({
                            r:
                                totalRowIndex,
                            c:
                                columnIndex
                        });

                    if (!worksheet[cell]) {
                        continue;
                    }

                    worksheet[cell].s = {

                        fill: {

                            patternType:
                                "solid",

                            fgColor: {

                                rgb:
                                    "B6D7A8"
                            }
                        },

                        font: {

                            bold: true,

                            color: {

                                rgb:
                                    "000000"
                            }
                        },

                        alignment: {

                            horizontal:
                                "center",

                            vertical:
                                "center"
                        },

                        border: {

                            top: {

                                style:
                                    "thin",

                                color: {

                                    rgb:
                                        "000000"
                                }
                            },

                            bottom: {

                                style:
                                    "thin",

                                color: {

                                    rgb:
                                        "000000"
                                }
                            },

                            left: {

                                style:
                                    "thin",

                                color: {

                                    rgb:
                                        "000000"
                                }
                            },

                            right: {

                                style:
                                    "thin",

                                color: {

                                    rgb:
                                        "000000"
                                }
                            }
                        }
                    };
                }

                /* =================================================
                   COLUMN WIDTH
                ================================================= */

                worksheet["!cols"] = [

                    {
                        wch: 18
                    },

                    {
                        wch: 22
                    },

                    {
                        wch: 22
                    },

                    {
                        wch: 18
                    }
                ];

                /* =================================================
                   SAFE SHEET NAME
                ================================================= */

                let sheetName =
                    employee.username
                        .replace(
                            /[\\\/\?\*\[\]\:]/g,
                            ""
                        )
                        .substring(
                            0,
                            31
                        );

                if (!sheetName) {

                    sheetName =
                        "Employee";
                }

                /* =================================================
                   DUPLICATE SHEET NAME
                ================================================= */

                const originalSheetName =
                    sheetName;

                let counter = 1;

                while (
                    workbook.Sheets[
                    sheetName
                    ]
                ) {

                    const suffix =
                        `_${counter}`;

                    sheetName =
                        originalSheetName.substring(
                            0,
                            31 -
                            suffix.length
                        ) +
                        suffix;

                    counter++;
                }

                /* =================================================
                   APPEND SHEET
                ================================================= */

                XLSX.utils.book_append_sheet(
                    workbook,
                    worksheet,
                    sheetName
                );
            }
        );

        /* =========================================================
           NO DATA
        ========================================================= */

        if (
            Object.keys(employees).length ===
            0
        ) {

            const worksheet =
                XLSX.utils.aoa_to_sheet([

                    [
                        "Message"
                    ],

                    [
                        "No active employee attendance found"
                    ]
                ]);

            XLSX.utils.book_append_sheet(
                workbook,
                worksheet,
                "Attendance"
            );
        }

        /* =========================================================
           CREATE BUFFER
        ========================================================= */

        const buffer =
            XLSX.write(
                workbook,
                {
                    type: "buffer",
                    bookType: "xlsx"
                }
            );

        /* =========================================================
           FILE NAME
        ========================================================= */

        const fileName =
            `Active_Employee_Attendance_${String(
                monthNumber
            ).padStart(
                2,
                "0"
            )}_${yearNumber}.xlsx`;

        /* =========================================================
           RESPONSE
        ========================================================= */

        res.setHeader(
            "Content-Disposition",
            `attachment; filename="${fileName}"`
        );

        res.setHeader(
            "Content-Type",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );

        return res
            .status(200)
            .send(buffer);

    } catch (error) {

        console.error(
            "ACTIVE MONTHLY ATTENDANCE EXCEL ERROR:",
            error
        );

        return res.status(500).json({

            success: false,

            message:
                error.message
        });
    }
};