import XLSX from "xlsx-js-style";
import { getExportSummary } from "../../models/Attendance/Summary/summary.model.js";

const toDBDate = (dateStr) => {
    if (!dateStr) return null;

    const [dd, mm, yyyy] = dateStr.split("-");
    return `${yyyy}-${mm}-${dd}`;
};

/* ================= FORMAT DURATION ================= */
const formatDuration = (value) => {
    if (!value) return "00:00:00";

    if (typeof value === "string") {
        return value;
    }

    if (typeof value === "object") {
        const hours = String(value.hours || 0).padStart(2, "0");
        const minutes = String(value.minutes || 0).padStart(2, "0");
        const seconds = String(value.seconds || 0).padStart(2, "0");
        return `${hours}:${minutes}:${seconds}`;
    }

    return "00:00:00";
};

/* ================= GET ONLY TIME ================= */
const getOnlyTime = (value) => {
    if (!value) return "";

    if (typeof value === "string") {
        const parts = value.split(" ");
        return parts.length > 1 ? parts[1] : value;
    }

    return "";
};

/* ================= FORMAT PG TIME ================= */
const formatPgTime = (value) => {
    if (!value) return "00:00:00";

    const str = String(value).trim();

    // if already HH:MM:SS
    if (/^\d{2}:\d{2}:\d{2}$/.test(str)) {
        return str;
    }

    // if HH:MM
    if (/^\d{2}:\d{2}$/.test(str)) {
        return `${str}:00`;
    }

    return str;
};

/* ================= GET EMPLOYEE FULL NAME ================= */
const getEmployeeName = (item) => {
    return [
        item.first_name || "",
        item.middle_name || "",
        item.last_name || ""
    ]
        .filter(Boolean)
        .join(" ")
        .trim();
};

/* ================= HH:MM:SS -> SECONDS ================= */
const timeToSeconds = (timeStr) => {
    if (!timeStr) return 0;

    const parts = String(timeStr).trim().split(":");
    const hours = Number(parts[0] || 0);
    const minutes = Number(parts[1] || 0);
    const seconds = Number(parts[2] || 0);

    return (hours * 3600) + (minutes * 60) + seconds;
};

/* ================= SECONDS -> HH:MM:SS ================= */
const secondsToHHMMSS = (totalSeconds) => {
    if (!totalSeconds || totalSeconds < 0) {
        return "00:00:00";
    }

    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    return [
        String(hours).padStart(2, "0"),
        String(minutes).padStart(2, "0"),
        String(seconds).padStart(2, "0")
    ].join(":");
};

/* ================= SHIFT DURATION FROM START/END TIME ================= */
const getShiftDurationSecondsFromStartEnd = (startTime, endTime) => {
    if (!startTime || !endTime) return 0;

    let startSeconds = timeToSeconds(formatPgTime(startTime));
    let endSeconds = timeToSeconds(formatPgTime(endTime));

    // overnight shift support
    if (endSeconds < startSeconds) {
        endSeconds += 24 * 3600;
    }

    return endSeconds - startSeconds;
};

/* ================= CALCULATE OVERTIME ================= */
const calculateOvertimeFromStartEnd = (durationStr, startTime, endTime) => {
    const totalWorkedSeconds = timeToSeconds(durationStr);
    const shiftSeconds = getShiftDurationSecondsFromStartEnd(startTime, endTime);

    if (!totalWorkedSeconds || !shiftSeconds) {
        return "00:00:00";
    }

    const overtimeSeconds =
        totalWorkedSeconds > shiftSeconds
            ? totalWorkedSeconds - shiftSeconds
            : 0;

    return secondsToHHMMSS(overtimeSeconds);
};

/* ================= SAFE SHEET NAME ================= */
const makeSafeSheetName = (name, usedNames) => {
    let sheetName = (name || "Unknown").toString().trim();

    sheetName = sheetName.replace(/[\\\/\?\*\[\]\:]/g, "");

    if (!sheetName) sheetName = "Unknown";

    sheetName = sheetName.slice(0, 31);

    let finalName = sheetName;
    let counter = 1;

    while (usedNames.has(finalName)) {
        const suffix = `_${counter}`;
        finalName = `${sheetName.slice(0, 31 - suffix.length)}${suffix}`;
        counter++;
    }

    usedNames.add(finalName);
    return finalName;
};

/* ================= DOWNLOAD ATTENDANCE ================= */
export const downloadAttendanceByUsername = async (req, res) => {
    try {
        let {
            month,
            year,
            name,
            username,
            first_name,
            middle_name,
            last_name,
            employment_id,
            shift_type,
            work_location,
            rfid,
            mac_id,
            entry_at,
            exit_at,
            status,
            duration,
            date
        } = req.query;

        /* =========================================================
           DEFAULT CURRENT MONTH
        ========================================================= */
        const now = new Date();

        month =
            month
                ? Number(month)
                : now.getMonth() + 1;

        year =
            year
                ? Number(year)
                : now.getFullYear();

        const employeeSearch = name || username || null;

        /* =========================================================
           GET ATTENDANCE DATA
        ========================================================= */
        const attendanceResult = await getExportSummary({
            month,
            year,
            username: employeeSearch,
            work_location,
            first_name,
            middle_name,
            last_name,
            employment_id,
            shift_type,
            rfid,
            mac_id,
            entry_at,
            exit_at,
            status,
            duration,
            date:
                date
                    ? toDBDate(date)
                    : null
        });

        const data = attendanceResult?.rows || [];

        /* =========================================================
           NO DATA
        ========================================================= */
        if (!data.length) {
            return res.status(404).json({
                success: false,
                message: "No attendance data found"
            });
        }

        /* =========================================================
           COMMON BORDERS
        ========================================================= */
        const thinBlackBorder = {
            style: "thin",
            color: {
                rgb: "000000"
            }
        };

        const mediumBlackBorder = {
            style: "medium",
            color: {
                rgb: "000000"
            }
        };

        /* =========================================================
           GREEN STYLE
        ========================================================= */
        const greenStyle = {
            fill: {
                patternType: "solid",
                fgColor: {
                    rgb: "93C47D"
                }
            },

            font: {
                bold: true,
                color: {
                    rgb: "000000"
                }
            },

            alignment: {
                horizontal: "center",
                vertical: "center"
            },

            border: {
                top: thinBlackBorder,
                bottom: thinBlackBorder,
                left: thinBlackBorder,
                right: thinBlackBorder
            }
        };

        /* =========================================================
           RED STYLE
        ========================================================= */
        const redStyle = {
            fill: {
                patternType: "solid",
                fgColor: {
                    rgb: "F4CCCC"
                }
            },

            font: {
                bold: false,
                color: {
                    rgb: "000000"
                }
            },

            alignment: {
                horizontal: "center",
                vertical: "center"
            },

            border: {
                top: thinBlackBorder,
                bottom: thinBlackBorder,
                left: thinBlackBorder,
                right: thinBlackBorder
            }
        };

        /* =========================================================
           GROUP DATA BY USERNAME
        ========================================================= */
        const groupedData = {};

        for (
            const item of data
        ) {
            const userKey =
                item.employee_username ||
                item.username ||
                "Unknown";

            if (
                !groupedData[userKey]
            ) {
                groupedData[userKey] = [];
            }

            /* =====================================================
               EMPLOYEE NAME
            ===================================================== */
            const employeeName = getEmployeeName(item);

            /* =====================================================
               CHECK IN
            ===================================================== */
            const checkIn =
                getOnlyTime(
                    item.entry_at
                );

            /* =====================================================
               CHECK OUT
            ==================================================== */
            const checkOut =
                getOnlyTime(
                    item.exit_at
                );

            /* =====================================================
               ACTUAL WORKING TIME
            ===================================================== */
            let actualSeconds = 0;

            if (
                checkIn &&
                checkOut
            ) {
                actualSeconds =
                    timeToSeconds(
                        checkOut
                    )
                    -
                    timeToSeconds(
                        checkIn
                    );

                if (
                    actualSeconds < 0
                ) {
                    actualSeconds = 0;
                }
            }

            /* =====================================================
               TOTAL HOURS
            ===================================================== */
            const totalHours =
                secondsToHHMMSS(
                    actualSeconds
                );

            /* =====================================================
               TOTAL MINUTES
            ===================================================== */
            const totalMinutes =
                Math.floor(
                    actualSeconds / 60
                );

            /* =====================================================
               SHIFT
            ===================================================== */
            const shiftStartTime =
                formatPgTime(
                    item.shift_start_time
                );

            const shiftEndTime =
                formatPgTime(
                    item.shift_end_time
                );

            const shiftSeconds =
                getShiftDurationSecondsFromStartEnd(
                    shiftStartTime,
                    shiftEndTime
                );

            const totalShiftTime =
                secondsToHHMMSS(
                    shiftSeconds
                );

            /* =====================================================
               OVERTIME
            ===================================================== */
            const overtimeSeconds =
                Math.max(
                    actualSeconds -
                    shiftSeconds,
                    0
                );

            const overtime =
                secondsToHHMMSS(
                    overtimeSeconds
                );

            /* =====================================================
               PUSH ATTENDANCE
            ===================================================== */
            groupedData[userKey].push({
                "Employee Name": employeeName,

                "Date":
                    item.entry_at
                        ? item.entry_at
                            .split(" ")[0]
                        : "",

                "Check In": checkIn,
                "Check Out": checkOut,
                "Shift Time": totalShiftTime,
                "Total Hours": totalHours,
                "Total Minutes": totalMinutes,
                "Total Overtime": overtime
            });
        }

        /* =========================================================
           ADD ALL DAYS OF SELECTED MONTH
           
           If date is not supplied.
        ======================================================== */
        if (!date) {
            const daysInMonth =
                new Date(
                    year,
                    month,
                    0
                ).getDate();

            Object.entries(
                groupedData
            ).forEach(
                ([usernameKey, employeeRows]) => {
                    /* =============================================
                       EXISTING ATTENDANCE BY DATE
                    ============================================= */
                    const attendanceByDate = {};

                    employeeRows.forEach(
                        (row) => {
                            const rowDate =
                                row["Date"];

                            if (!rowDate) {
                                return;
                            }

                            if (
                                !attendanceByDate[
                                rowDate
                                ]
                            ) {
                                attendanceByDate[
                                    rowDate
                                ] = [];
                            }
                            attendanceByDate[
                                rowDate
                            ].push(row);
                        }
                    );

                    /* =============================================
                       EMPLOYEE NAME
                    ============================================= */
                    const employeeName =
                        employeeRows.find(
                            row =>
                                row[
                                "Employee Name"
                                ]
                        )?.[
                        "Employee Name"
                        ] ||
                        usernameKey;

                    /* =============================================
                       SHIFT TIME
                    ============================================= */
                    const shiftTime =
                        employeeRows.find(
                            row =>
                                row[
                                "Shift Time"
                                ]
                        )?.[
                        "Shift Time"
                        ] ||
                        "";

                    /* =============================================
                       COMPLETE MONTH
                    ============================================= */
                    const completeMonthRows = [];

                    for (
                        let day = 1;
                        day <= daysInMonth;
                        day++
                    ) {
                        const dateObj =
                            new Date(
                                year,
                                month - 1,
                                day
                            );

                        const dd =
                            String(
                                dateObj.getDate()
                            ).padStart(
                                2,
                                "0"
                            );

                        const mm =
                            String(
                                dateObj.getMonth() + 1
                            ).padStart(
                                2,
                                "0"
                            );

                        const yyyy = dateObj.getFullYear();
                        const formattedDate = `${dd}-${mm}-${yyyy}`;

                        /* =========================================
                           ATTENDANCE EXISTS
                        ========================================= */
                        if (
                            attendanceByDate[
                            formattedDate
                            ]
                        ) {
                            completeMonthRows.push(
                                ...attendanceByDate[
                                formattedDate
                                ]
                            );

                        } else {
                            /* ====================================
                               NO ATTENDANCE
                            ===================================== */
                            completeMonthRows.push({
                                "Employee Name": employeeName,
                                "Date": formattedDate,
                                "Check In": "",
                                "Check Out": "",
                                "Shift Time": shiftTime,
                                "Total Hours": "00:00:00",
                                "Total Minutes": 0,
                                "Total Overtime": "00:00:00"
                            });
                        }
                    }

                    groupedData[
                        usernameKey
                    ] =
                        completeMonthRows;
                }
            );
        }

        /* =========================================================
           CREATE WORKBOOK
        ========================================================= */
        const workbook = XLSX.utils.book_new();
        const usedSheetNames = new Set();

        /* =========================================================
           COMPANY SUMMARY
        ========================================================= */
        const companyWorkingDates = new Set();

        let companyTotalMinutes = 0;

        Object.values(
            groupedData
        ).forEach(
            (employeeRows) => {
                employeeRows.forEach(
                    (row) => {
                        const checkIn =
                            String(
                                row[
                                "Check In"
                                ] || ""
                            ).trim();

                        const checkOut =
                            String(
                                row[
                                "Check Out"
                                ] || ""
                            ).trim();

                        /* =========================================
                           ONLY ACTUAL ATTENDANCE DAYS
                        ========================================= */
                        if (
                            row["Date"] &&
                            (
                                checkIn !== "" ||
                                checkOut !== ""
                            )
                        ) {

                            companyWorkingDates.add(
                                row["Date"]
                            );
                        }

                        companyTotalMinutes +=
                            Number(
                                row[
                                "Total Minutes"
                                ]
                            ) || 0;
                    }
                );
            }
        );

        /* =========================================================
           CREATE EMPLOYEE SHEETS
        ========================================================= */
        Object.entries(
            groupedData
        ).forEach(
            ([usernameKey, rows]) => {
                /* ================================================
                   SORT DATE DESCENDING
                ================================================ */
                rows.sort(
                    (a, b) => {
                        const dateA =
                            a["Date"]
                                ? new Date(
                                    a["Date"]
                                        .split("-")
                                        .reverse()
                                        .join("-")
                                )
                                : new Date(0);

                        const dateB =
                            b["Date"]
                                ? new Date(
                                    b["Date"]
                                        .split("-")
                                        .reverse()
                                        .join("-")
                                )
                                : new Date(0);

                        return dateB - dateA;
                    }
                );

                /* ================================================
                   EMPLOYEE SUMMARY
                ================================================ */
                const employeeWorkingDates = new Set();
                let employeeWorkingMinutes = 0;

                rows.forEach(
                    (row) => {
                        const checkIn =
                            String(
                                row[
                                "Check In"
                                ] || ""
                            ).trim();

                        const checkOut =
                            String(
                                row[
                                "Check Out"
                                ] || ""
                            ).trim();

                        if (
                            row["Date"] &&
                            (
                                checkIn !== "" ||
                                checkOut !== ""
                            )
                        ) {

                            employeeWorkingDates.add(
                                row["Date"]
                            );
                        }

                        employeeWorkingMinutes +=
                            Number(
                                row[
                                "Total Minutes"
                                ]
                            ) || 0;
                    }
                );

                /* ================================================
                   CREATE WORKSHEET
                ================================================ */
                const worksheet = XLSX.utils.aoa_to_sheet([]);

                /* ================================================
                   ATTENDANCE TABLE
                ================================================ */
                XLSX.utils.sheet_add_json(
                    worksheet,
                    rows,
                    {
                        origin: "A1",
                        skipHeader: false
                    }
                );

                /* ================================================
                   HEADERS
                ================================================ */
                const headers =
                    Object.keys(
                        rows[0] || {}
                    );

                headers.forEach(
                    (header, index) => {
                        const cellAddress =
                            XLSX.utils.encode_cell({
                                r: 0,
                                c: index
                            });

                        if (
                            worksheet[
                            cellAddress
                            ]
                        ) {

                            worksheet[
                                cellAddress
                            ].s = {
                                ...greenStyle
                            };
                        }
                    }
                );

                /* ================================================
                   DATE GROUPS
                ================================================ */
                const dateGroups = {};
                rows.forEach(
                    (row, rowIndex) => {

                        const rowDate =
                            row["Date"] ||
                            "Unknown";

                        if (
                            !dateGroups[
                            rowDate
                            ]
                        ) {

                            dateGroups[
                                rowDate
                            ] = [];
                        }

                        dateGroups[
                            rowDate
                        ].push(
                            rowIndex
                        );
                    }
                );

                worksheet["!merges"] = [];

                /* ================================================
                   PROCESS DATE GROUPS
                ================================================ */
                Object.entries(
                    dateGroups
                ).forEach(
                    ([date, rowIndexes]) => {
                        const firstRow = rowIndexes[0] + 1;

                        const lastRow =
                            rowIndexes[
                            rowIndexes.length - 1
                            ] + 1;

                        const isMultipleEntry = rowIndexes.length > 1;

                        /* =========================================
                           MERGE EMPLOYEE + DATE
                        ========================================= */
                        if (
                            isMultipleEntry
                        ) {
                            worksheet[
                                "!merges"
                            ].push({
                                s: {
                                    r: firstRow,
                                    c: 0
                                },

                                e: {
                                    r: lastRow,
                                    c: 0
                                }
                            });

                            worksheet[
                                "!merges"
                            ].push({
                                s: {
                                    r: firstRow,
                                    c: 1
                                },

                                e: {
                                    r: lastRow,
                                    c: 1
                                }
                            });
                        }

                        /* =========================================
                           THIN INNER BORDER
                        ========================================= */
                        for (
                            let rowIndex =
                                firstRow;
                            rowIndex <=
                            lastRow;
                            rowIndex++
                        ) {
                            for (
                                let columnIndex =
                                    0;
                                columnIndex <
                                headers.length;
                                columnIndex++
                            ) {
                                const cellAddress =
                                    XLSX.utils.encode_cell({
                                        r: rowIndex,
                                        c: columnIndex
                                    });

                                if (
                                    worksheet[
                                    cellAddress
                                    ]
                                ) {
                                    worksheet[
                                        cellAddress
                                    ].s = {
                                        alignment: {
                                            horizontal: "center",
                                            vertical: "center"
                                        },

                                        border: {
                                            top: thinBlackBorder,
                                            bottom: thinBlackBorder,
                                            left: thinBlackBorder,
                                            right: thinBlackBorder
                                        }
                                    };
                                }
                            }
                        }

                        /* =========================================
                           MEDIUM OUTER BORDER
                        ========================================= */
                        if (
                            isMultipleEntry
                        ) {

                            /* TOP */
                            for (
                                let columnIndex =
                                    0;
                                columnIndex <
                                headers.length;
                                columnIndex++
                            ) {
                                const cellAddress =
                                    XLSX.utils.encode_cell({
                                        r: firstRow,
                                        c: columnIndex
                                    });

                                if (
                                    worksheet[
                                    cellAddress
                                    ]
                                ) {
                                    const currentStyle =
                                        worksheet[
                                            cellAddress
                                        ].s || {};

                                    worksheet[
                                        cellAddress
                                    ].s = {
                                        ...currentStyle,
                                        border: {
                                            ...(currentStyle.border || {}),
                                            top: mediumBlackBorder
                                        }
                                    };
                                }
                            }

                            /* BOTTOM */
                            for (
                                let columnIndex =
                                    0;
                                columnIndex <
                                headers.length;
                                columnIndex++
                            ) {
                                const cellAddress =
                                    XLSX.utils.encode_cell({
                                        r: lastRow,
                                        c: columnIndex
                                    });

                                if (
                                    worksheet[
                                    cellAddress
                                    ]
                                ) {
                                    const currentStyle =
                                        worksheet[
                                            cellAddress
                                        ].s || {};

                                    worksheet[
                                        cellAddress
                                    ].s = {
                                        ...currentStyle,
                                        border: {
                                            ...(currentStyle.border || {}),
                                            bottom: mediumBlackBorder
                                        }
                                    };
                                }
                            }

                            /* LEFT */
                            for (
                                let rowIndex =
                                    firstRow;
                                rowIndex <=
                                lastRow;
                                rowIndex++
                            ) {
                                const cellAddress =
                                    XLSX.utils.encode_cell({
                                        r: rowIndex,
                                        c: 0
                                    });

                                if (
                                    worksheet[
                                    cellAddress
                                    ]
                                ) {
                                    const currentStyle =
                                        worksheet[
                                            cellAddress
                                        ].s || {};

                                    worksheet[
                                        cellAddress
                                    ].s = {
                                        ...currentStyle,
                                        border: {
                                            ...(currentStyle.border || {}),
                                            left: mediumBlackBorder
                                        }
                                    };
                                }
                            }

                            /* RIGHT */
                            for (
                                let rowIndex = firstRow;
                                rowIndex <=
                                lastRow;
                                rowIndex++
                            ) {
                                const cellAddress =
                                    XLSX.utils.encode_cell({
                                        r: rowIndex,
                                        c: headers.length - 1
                                    });

                                if (
                                    worksheet[
                                    cellAddress
                                    ]
                                ) {
                                    const currentStyle =
                                        worksheet[
                                            cellAddress
                                        ].s || {};

                                    worksheet[
                                        cellAddress
                                    ].s = {
                                        ...currentStyle,
                                        border: {
                                            ...(currentStyle.border || {}),
                                            right: mediumBlackBorder
                                        }
                                    };
                                }
                            }
                        }

                        /* =========================================
                           EMPLOYEE NAME CELL
                        ========================================= */
                        const employeeCell =
                            XLSX.utils.encode_cell({

                                r: firstRow,

                                c: 0
                            });

                        if (
                            worksheet[
                            employeeCell
                            ]
                        ) {
                            const currentStyle =
                                worksheet[
                                    employeeCell
                                ].s || {};

                            worksheet[
                                employeeCell
                            ].s = {
                                ...currentStyle,

                                alignment: {
                                    horizontal: "center",
                                    vertical: "center"
                                },

                                border: {
                                    ...(currentStyle.border || {}),

                                    top:
                                        isMultipleEntry
                                            ? mediumBlackBorder
                                            : thinBlackBorder,

                                    bottom:
                                        isMultipleEntry
                                            ? mediumBlackBorder
                                            : thinBlackBorder,

                                    left:
                                        isMultipleEntry
                                            ? mediumBlackBorder
                                            : thinBlackBorder,

                                    right:
                                        isMultipleEntry
                                            ? mediumBlackBorder
                                            : thinBlackBorder
                                }
                            };
                        }

                        /* =========================================
                           DATE CELL
                        ========================================= */
                        const dateCell =
                            XLSX.utils.encode_cell({

                                r: firstRow,

                                c: 1
                            });

                        if (
                            worksheet[
                            dateCell
                            ]
                        ) {
                            const currentStyle =
                                worksheet[
                                    dateCell
                                ].s || {};

                            worksheet[
                                dateCell
                            ].s = {
                                ...currentStyle,
                                alignment: {
                                    horizontal: "center",
                                    vertical: "center"
                                },

                                font: {
                                    bold: true
                                },

                                border: {
                                    ...(currentStyle.border || {}),

                                    top:
                                        isMultipleEntry
                                            ? mediumBlackBorder
                                            : thinBlackBorder,

                                    bottom:
                                        isMultipleEntry
                                            ? mediumBlackBorder
                                            : thinBlackBorder,

                                    left:
                                        isMultipleEntry
                                            ? mediumBlackBorder
                                            : thinBlackBorder,

                                    right:
                                        isMultipleEntry
                                            ? mediumBlackBorder
                                            : thinBlackBorder
                                }
                            };
                        }
                    }
                );

                /* ================================================
                   RED INCOMPLETE ATTENDANCE
                ================================================ */
                rows.forEach(
                    (row, rowIndex) => {
                        const checkInValue =
                            String(
                                row[
                                "Check In"
                                ] || ""
                            ).trim();

                        const checkOutValue =
                            String(
                                row[
                                "Check Out"
                                ] || ""
                            ).trim();

                        /* =========================================
                           ONLY CHECK-IN WITHOUT CHECK-OUT
                        ========================================= */
                        if (
                            checkInValue !== "" &&
                            checkOutValue === ""
                        ) {
                            const excelRow = rowIndex + 1;

                            for (
                                let columnIndex =
                                    0;
                                columnIndex <
                                headers.length;
                                columnIndex++
                            ) {
                                const cellAddress =
                                    XLSX.utils.encode_cell({
                                        r: excelRow,
                                        c: columnIndex
                                    });

                                if (
                                    worksheet[
                                    cellAddress
                                    ]
                                ) {
                                    worksheet[
                                        cellAddress
                                    ].s = {
                                        ...redStyle
                                    };
                                }
                            }

                            /* =====================================
                               RESTORE OUTER BORDER
                            ===================================== */
                            const rowDate = row["Date"] || "Unknown";

                            const group =
                                dateGroups[
                                rowDate
                                ];

                            if (
                                group &&
                                group.length > 1
                            ) {
                                const firstGroupRow = group[0] + 1;

                                const lastGroupRow =
                                    group[
                                    group.length - 1
                                    ] + 1;

                                /* LEFT + RIGHT */
                                const leftCell =
                                    XLSX.utils.encode_cell({
                                        r:
                                            excelRow,
                                        c: 0
                                    });

                                const rightCell =
                                    XLSX.utils.encode_cell({
                                        r: excelRow,
                                        c: headers.length - 1
                                    });

                                if (
                                    worksheet[
                                    leftCell
                                    ]
                                ) {
                                    worksheet[
                                        leftCell
                                    ].s = {
                                        ...worksheet[
                                            leftCell
                                        ].s,

                                        border: {
                                            ...(worksheet[
                                                leftCell
                                            ].s?.border || {}),

                                            left: mediumBlackBorder
                                        }
                                    };
                                }

                                if (
                                    worksheet[
                                    rightCell
                                    ]
                                ) {
                                    worksheet[
                                        rightCell
                                    ].s = {
                                        ...worksheet[
                                            rightCell
                                        ].s,

                                        border: {
                                            ...(worksheet[
                                                rightCell
                                            ].s?.border || {}),

                                            right: mediumBlackBorder
                                        }
                                    };
                                }

                                /* TOP */
                                if (
                                    excelRow ===
                                    firstGroupRow
                                ) {
                                    for (
                                        let columnIndex =
                                            0;
                                        columnIndex <
                                        headers.length;
                                        columnIndex++
                                    ) {
                                        const cellAddress =
                                            XLSX.utils.encode_cell({
                                                r: excelRow,
                                                c: columnIndex
                                            });

                                        if (
                                            worksheet[
                                            cellAddress
                                            ]
                                        ) {
                                            worksheet[
                                                cellAddress
                                            ].s = {
                                                ...worksheet[
                                                    cellAddress
                                                ].s,

                                                border: {
                                                    ...(worksheet[
                                                        cellAddress
                                                    ].s?.border || {}),

                                                    top: mediumBlackBorder
                                                }
                                            };
                                        }
                                    }
                                }

                                /* BOTTOM */
                                if (
                                    excelRow ===
                                    lastGroupRow
                                ) {
                                    for (
                                        let columnIndex = 0;
                                        columnIndex <
                                        headers.length;
                                        columnIndex++
                                    ) {
                                        const cellAddress =
                                            XLSX.utils.encode_cell({
                                                r:
                                                    excelRow,
                                                c:
                                                    columnIndex
                                            });

                                        if (
                                            worksheet[
                                            cellAddress
                                            ]
                                        ) {
                                            worksheet[
                                                cellAddress
                                            ].s = {

                                                ...worksheet[
                                                    cellAddress
                                                ].s,

                                                border: {
                                                    ...(worksheet[
                                                        cellAddress
                                                    ].s?.border || {}),

                                                    bottom: mediumBlackBorder
                                                }
                                            };
                                        }
                                    }
                                }
                            }
                        }
                    }
                );

                /* =================================================
                   SUMMARY START
                ================================================= */
                const summaryStartRow = rows.length + 4;

                /* =================================================
                   SUMMARY DATA
                ================================================= */
                XLSX.utils.sheet_add_aoa(
                    worksheet,
                    [
                        [
                            "Company Working Days",
                            companyWorkingDates.size
                        ],

                        [
                            "Employee Working Days",
                            employeeWorkingDates.size
                        ],

                        [
                            "Company Total Minutes",
                            companyTotalMinutes
                        ],

                        [
                            "Employee Working Minutes",
                            employeeWorkingMinutes
                        ]
                    ],

                    {
                        origin: `A${summaryStartRow}`
                    }
                );

                /* =================================================
                   SUMMARY STYLE
                ================================================= */
                for (
                    let rowIndex = 0;
                    rowIndex < 4;
                    rowIndex++
                ) {
                    const actualRow =
                        summaryStartRow -
                        1 +
                        rowIndex;

                    /* =============================================
                       LABEL
                    ============================================= */
                    const labelCell =
                        XLSX.utils.encode_cell({
                            r: actualRow,
                            c: 0
                        });

                    if (
                        worksheet[
                        labelCell
                        ]
                    ) {
                        worksheet[
                            labelCell
                        ].s = {
                            ...greenStyle
                        };
                    }

                    /* =============================================
                       VALUE
                    ============================================= */
                    const valueCell =
                        XLSX.utils.encode_cell({
                            r: actualRow,
                            c: 1
                        });

                    if (
                        worksheet[
                        valueCell
                        ]
                    ) {
                        worksheet[
                            valueCell
                        ].s = {
                            fill: {
                                patternType: "solid",
                                fgColor: {
                                    rgb: "FFFFFF"
                                }
                            },

                            font: {
                                bold: true,
                                color: {
                                    rgb: "000000"
                                }
                            },

                            alignment: {
                                horizontal: "center",
                                vertical: "center"
                            },

                            border: {
                                top: thinBlackBorder,
                                bottom: thinBlackBorder,
                                left: thinBlackBorder,
                                right: thinBlackBorder
                            }
                        };
                    }
                }

                /* =================================================
                   COLUMN WIDTH
                ================================================= */
                worksheet["!cols"] = [
                    {
                        wch: 30
                    },
                    {
                        wch: 18
                    },
                    {
                        wch: 15
                    },
                    {
                        wch: 15
                    },
                    {
                        wch: 15
                    },
                    {
                        wch: 15
                    },
                    {
                        wch: 15
                    },
                    {
                        wch: 18
                    }
                ];

                /* =================================================
                   SHEET NAME
                ================================================= */
                const sheetName = makeSafeSheetName(
                    usernameKey,
                    usedSheetNames
                );

                /* =================================================
                   ADD SHEET
                ================================================= */
                XLSX.utils.book_append_sheet(
                    workbook,
                    worksheet,
                    sheetName
                );
            }
        );

        /* =========================================================
           WRITE EXCEL
        ========================================================= */
        const buffer = XLSX.write(
            workbook,
            {
                type: "buffer",
                bookType: "xlsx"
            }
        );

        /* =========================================================
           MONTH NAME
        ========================================================= */
        const monthNames = [
            "January",
            "February",
            "March",
            "April",
            "May",
            "June",
            "July",
            "August",
            "September",
            "October",
            "November",
            "December"
        ];
        const monthNumber = Number(month);
        const monthName = monthNames[monthNumber - 1] || "Unknown";

        /* =========================================================
           FILE NAME
        ========================================================= */
        const fileName = `Attendance_${monthName}.xlsx`;

        /* =========================================================
           RESPONSE
        ========================================================= */
        res.setHeader(
            "Content-Type",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );

        res.setHeader(
            "Content-Disposition",
            `attachment; filename="${fileName}"`
        );

        return res.end(buffer);

    } catch (error) {
        console.error("DOWNLOAD ATTENDANCE ERROR:", error);
        return res.status(
            500
        ).json({
            success: false,
            message: error.message
        });
    }
};