import { pool } from "../../database.js";
import { decryptPayrollRows } from "../../utils/payrollEncryption.js";

const nameFilterSql = (paramIndex) => {
    const param = `$${paramIndex}`;

    return `
        ${param}::TEXT IS NULL
        OR LOWER(COALESCE(pd.username, ''))
            LIKE '%' || LOWER(TRIM(${param})) || '%'
        OR LOWER(COALESCE(pd.first_name, ''))
            LIKE '%' || LOWER(TRIM(${param})) || '%'
        OR LOWER(COALESCE(pd.middle_name, ''))
            LIKE '%' || LOWER(TRIM(${param})) || '%'
        OR LOWER(COALESCE(pd.last_name, ''))
            LIKE '%' || LOWER(TRIM(${param})) || '%'
        OR LOWER(
            CONCAT_WS(
                ' ',
                NULLIF(TRIM(pd.first_name), ''),
                NULLIF(TRIM(pd.middle_name), ''),
                NULLIF(TRIM(pd.last_name), '')
            )
        ) LIKE '%' || LOWER(TRIM(${param})) || '%'
    `;
};

const workLocationFilterSql = (paramIndex = 2) => {
    const param = `$${paramIndex}`;

    return `
        ${param}::TEXT IS NULL
        OR EXISTS (
            SELECT 1
            FROM employment_details ed
            LEFT JOIN work_location wl
                ON wl.id::TEXT = TRIM(ed.work_location::TEXT)
            WHERE ed.personal_details_id = pd.id
              AND (
                    TRIM(ed.work_location::TEXT) = ${param}
                    OR (
                        ${param}::TEXT ~ '^[0-9]+$'
                        AND wl.id = ${param}::INTEGER
                    )
                    OR LOWER(TRIM(wl.location)) =
                       LOWER(TRIM(${param}::TEXT))
              )
        )
    `;
};

const parseFinancialYearRange = (financialYear) => {
    const financialYearValue = String(financialYear || "").trim();
    const financialYearMatch = financialYearValue.match(
        /^(\d{4})-(\d{2}|\d{4})$/
    );

    if (!financialYearMatch) {
        throw new Error("Invalid financial_year. Use YYYY-YY or YYYY-YYYY");
    }

    const startYear = Number(financialYearMatch[1]);
    const endPart = financialYearMatch[2];
    const endYear =
        endPart.length === 2
            ? Number(`${String(startYear).slice(0, 2)}${endPart}`)
            : Number(endPart);

    if (
        !Number.isInteger(startYear) ||
        !Number.isInteger(endYear) ||
        endYear !== startYear + 1
    ) {
        throw new Error("Invalid financial_year");
    }

    return {
        financialYear: financialYearValue,
        startDate: `${startYear}-04-01`,
        endDate: `${endYear}-03-31`
    };
};

const lastDayOfMonth = (year, month) =>
    new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);

const toDateOnly = (value) => {
    if (value === null || value === undefined || value === "") {
        return null;
    }

    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value.trim())) {
        return value.trim().slice(0, 10);
    }

    const date = value instanceof Date ? value : new Date(value);

    if (Number.isNaN(date.getTime())) {
        return null;
    }

    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).format(date);
};

const monthsInDateRange = (fromDate, toDate) => {
    const [fromYear, fromMonth] = fromDate.split("-").map(Number);
    const [toYear, toMonth] = toDate.split("-").map(Number);
    const months = [];
    let year = fromYear;
    let month = fromMonth;

    while (year < toYear || (year === toYear && month <= toMonth)) {
        months.push({ month, year });
        month += 1;

        if (month > 12) {
            month = 1;
            year += 1;
        }
    }

    return months;
};

const moneyAmount = (value) => {
    if (value === null || value === undefined || value === "") {
        return 0;
    }

    const amount = Number(value);
    return Number.isFinite(amount) ? amount : 0;
};

const mapEmployeeSalary = (row) => ({
    username: String(row.username || "").trim().toUpperCase(),
    work_location: row.work_location || null,
    payroll_month: Number(row.payroll_month),
    payroll_year: Number(row.payroll_year),
    basic_salary: row.basic_salary == null ? null : Number(row.basic_salary),
    net_salary: row.net_salary == null ? null : Number(row.net_salary)
});

const toMoney = (cents) => Number(cents) / 100;

const addMoneyCents = (total, value) => {
    if (value === null || value === undefined || value === "") {
        return total;
    }

    const amount = Number(value);
    if (!Number.isFinite(amount)) {
        return total;
    }

    return total + BigInt(amount.toFixed(2).replace(".", ""));
};

const summarizeSalaryRows = (rows) => {
    const uniqueEmployees = new Set();
    let basicSalaryCents = 0n;
    let netSalaryCents = 0n;

    for (const row of rows) {
        uniqueEmployees.add(String(row.username || "").trim().toLowerCase());
        basicSalaryCents = addMoneyCents(basicSalaryCents, row.basic_salary);
        netSalaryCents = addMoneyCents(netSalaryCents, row.net_salary);
    }

    return {
        employee_count: uniqueEmployees.size,
        total_basic_salary: toMoney(basicSalaryCents),
        total_net_salary: toMoney(netSalaryCents)
    };
};

const salaryBreakdown = (totalBasicSalary, totalNetSalary) => {
    const basic = Number(totalBasicSalary || 0);
    const net = Number(totalNetSalary || 0);
    const paidPercentage = basic > 0
        ? Math.min(100, Math.max(0, Math.round((net / basic) * 100)))
        : 0;

    return {
        remaining_salary: Number((basic - net).toFixed(2)),
        paid_percentage: paidPercentage,
        remaining_percentage: 100 - paidPercentage
    };
};

export const getPayrollSalaryReportModel = async ({
    type = "monthly",
    month,
    year,
    work_location,
    username,
    name,
    yearly_filter,
    financial_year
}) => {
    const reportType = String(type || "monthly").trim().toLowerCase();
    const locationValue =
        work_location == null ||
            String(work_location).trim() === "" ||
            String(work_location).trim().toLowerCase() === "all"
            ? null
            : String(work_location).trim();
    const nameSource = [name, username].find(
        (value) => value != null && String(value).trim() !== ""
    );
    const nameValue =
        nameSource == null ? null : String(nameSource).trim();

    let startDate;
    let endDate;
    let yearlyFilter = null;
    let financialYearValue = null;
    let reportYear = year == null ? null : Number(year);
    let reportMonth = month == null ? null : Number(month);

    if (reportType === "monthly") {
        startDate = `${reportYear}-${String(reportMonth).padStart(2, "0")}-01`;
        endDate = lastDayOfMonth(reportYear, reportMonth);
    } else {
        yearlyFilter = String(yearly_filter || "").trim().toLowerCase();

        if (yearlyFilter === "joining_date") {
            startDate = `${reportYear}-01-01`;
            endDate = `${reportYear}-12-31`;
        } else if (yearlyFilter === "financial_year") {
            const financialYearRange = parseFinancialYearRange(
                financial_year ||
                `${reportYear}-${String(Number(reportYear) + 1).slice(-2)}`
            );
            financialYearValue = financialYearRange.financialYear;
            startDate = financialYearRange.startDate;
            endDate = financialYearRange.endDate;
        } else {
            throw new Error(
                "yearly_filter must be joining_date or financial_year"
            );
        }
    }

    const result = await pool.query(
        `
            SELECT DISTINCT ON (
                LOWER(TRIM(p.username::TEXT)),
                p.payroll_year,
                p.payroll_month
            )
                UPPER(TRIM(p.username::TEXT)) AS username,
                CONCAT_WS(
                    ' ',
                    NULLIF(TRIM(pd.first_name), ''),
                    NULLIF(TRIM(pd.middle_name), ''),
                    NULLIF(TRIM(pd.last_name), '')
                ) AS name,
                p.payroll_month,
                p.payroll_year,
                p.basic_salary,
                p.net_salary,
                wl.location AS work_location,
                TO_CHAR(ed.date_of_joining, 'YYYY-MM-DD') AS date_of_joining
            FROM payroll p
            INNER JOIN personal_details pd
                ON LOWER(TRIM(pd.username)) =
                   LOWER(TRIM(p.username::TEXT))
            LEFT JOIN LATERAL (
                SELECT
                    ed_inner.work_location,
                    ed_inner.date_of_joining
                FROM employment_details ed_inner
                WHERE ed_inner.personal_details_id = pd.id
                   OR LOWER(TRIM(ed_inner.username)) =
                      LOWER(TRIM(pd.username))
                ORDER BY ed_inner.id DESC
                LIMIT 1
            ) ed ON TRUE
            LEFT JOIN work_location wl
                ON wl.id::TEXT = TRIM(ed.work_location::TEXT)
            WHERE MAKE_DATE(p.payroll_year, p.payroll_month, 1)
                  BETWEEN $3::DATE AND $4::DATE
              AND (${nameFilterSql(2)})
              AND (${workLocationFilterSql(1)})
            ORDER BY
                LOWER(TRIM(p.username::TEXT)),
                p.payroll_year,
                p.payroll_month,
                p.updated_at DESC NULLS LAST,
                p.id DESC;
        `,
        [locationValue, nameValue, startDate, endDate]
    );

    const payrollRows = decryptPayrollRows(
        result.rows,
        ["basic_salary", "net_salary"]
    );

    if (reportType === "yearly") {
        const employeesByUsername = new Map();

        for (const row of payrollRows) {
            const key = String(row.username || "").trim().toLowerCase();

            if (!employeesByUsername.has(key)) {
                employeesByUsername.set(key, {
                    username: String(row.username || "").trim().toUpperCase(),
                    name: row.name || null,
                    work_location: row.work_location || null,
                    date_of_joining: toDateOnly(row.date_of_joining),
                    monthlyBasic: row.basic_salary,
                    netSalaryCents: 0n,
                    rows: []
                });
            }

            const employee = employeesByUsername.get(key);

            employee.name = row.name || employee.name;
            employee.monthlyBasic = row.basic_salary;
            employee.netSalaryCents = addMoneyCents(
                employee.netSalaryCents,
                row.net_salary
            );

            employee.rows.push(row);

            if (!employee.date_of_joining) {
                employee.date_of_joining = toDateOnly(row.date_of_joining);
            }
        }

        const yearMonths = monthsInDateRange(startDate, endDate);
        const employees = Array.from(employeesByUsername.values());

        const chart = yearMonths.map((slot, index) => {
            const slotStart =
                `${slot.year}-${String(slot.month).padStart(2, "0")}-01`;

            const slotEnd = lastDayOfMonth(slot.year, slot.month);

            let basicSalaryCents = 0n;
            let netSalaryCents = 0n;
            let monthEmployeeCount = 0;

            for (const employee of employees) {
                const joiningDate = employee.date_of_joining;

                // Joining date na pehla employee count na thavo joie.
                if (joiningDate && joiningDate > slotEnd) {
                    continue;
                }

                monthEmployeeCount++;

                // Basic salary monthly payroll record mathi lo.
                const monthRow = employee.rows.find(
                    row =>
                        Number(row.payroll_month) === slot.month &&
                        Number(row.payroll_year) === slot.year
                );

                if (monthRow) {
                    basicSalaryCents = addMoneyCents(
                        basicSalaryCents,
                        monthRow.basic_salary
                    );

                    netSalaryCents = addMoneyCents(
                        netSalaryCents,
                        monthRow.net_salary
                    );
                }
            }

            const monthLabel = new Intl.DateTimeFormat("en-US", {
                month: "short",
                timeZone: "Asia/Kolkata"
            }).format(new Date(Date.UTC(slot.year, slot.month - 1, 1)));

            const fullLabel = new Intl.DateTimeFormat("en-US", {
                month: "long",
                year: "numeric",
                timeZone: "Asia/Kolkata"
            }).format(new Date(Date.UTC(slot.year, slot.month - 1, 1)));

            const totalBasicSalary = toMoney(basicSalaryCents);
            const totalNetSalary = toMoney(netSalaryCents);
            const breakdown = salaryBreakdown(totalBasicSalary, totalNetSalary);

            return {
                label: monthLabel,
                full_label: fullLabel,
                month: slot.month,
                year: slot.year,
                position: index,
                employee_count: monthEmployeeCount,
                total_basic_salary: totalBasicSalary,
                total_net_salary: totalNetSalary,
                remaining_salary: breakdown.remaining_salary,
                paid_percentage: breakdown.paid_percentage
            };
        });

        const finalChart = chart;

        const totalBasicSalaryCents = chart.reduce(
            (sum, item) =>
                addMoneyCents(sum, item.total_basic_salary),
            0n
        );

        const totalNetSalaryCents = chart.reduce(
            (sum, item) =>
                addMoneyCents(sum, item.total_net_salary),
            0n
        );

        const totalBasicSalary = toMoney(totalBasicSalaryCents);
        const totalNetSalary = toMoney(totalNetSalaryCents);
        const yearlyBreakdown = salaryBreakdown(
            totalBasicSalary,
            totalNetSalary
        );

        return {
            type: "yearly",
            work_location: locationValue,
            year: reportYear,
            yearly_filter: yearlyFilter,
            financial_year: financialYearValue,
            employee_count: employees.length,
            total_basic_salary: totalBasicSalary,
            total_net_salary: totalNetSalary,
            remaining_salary: yearlyBreakdown.remaining_salary,
            paid_percentage: yearlyBreakdown.paid_percentage,
            remaining_percentage: yearlyBreakdown.remaining_percentage,
            chart: finalChart
        };
    }

    const summary = summarizeSalaryRows(payrollRows);

    const monthLabel = new Intl.DateTimeFormat("en-US", {
        month: "long",
        year: "numeric",
        timeZone: "Asia/Kolkata"
    }).format(new Date(Date.UTC(reportYear, reportMonth - 1, 1)));

    const monthlyBreakdown = salaryBreakdown(
        summary.total_basic_salary,
        summary.total_net_salary
    );

    return {
        type: "monthly",
        work_location: locationValue,
        label: monthLabel,
        year: reportYear,
        month: reportMonth,
        employee_count: summary.employee_count,
        total_basic_salary: summary.total_basic_salary,
        total_net_salary: summary.total_net_salary,
        remaining_salary: monthlyBreakdown.remaining_salary,
        paid_percentage: monthlyBreakdown.paid_percentage,
        remaining_percentage: monthlyBreakdown.remaining_percentage
    };

};

export const getCompanyPayrollReportModel = async ({
    type = "monthly",
    month,
    year,
    work_location,
    yearly_filter,
    financial_year
}) => {
    const reportType = String(type || "monthly").trim().toLowerCase();
    const locationValue =
        work_location == null ||
            String(work_location).trim() === "" ||
            String(work_location).trim().toLowerCase() === "all"
            ? null
            : String(work_location).trim();

    let startDate;
    let endDate;
    let yearlyFilter = null;
    let financialYearValue = null;
    let reportYear = year == null ? null : Number(year);
    let reportMonth = month == null ? null : Number(month);

    if (reportType === "monthly") {
        startDate = `${reportYear}-${String(reportMonth).padStart(2, "0")}-01`;
        endDate = lastDayOfMonth(reportYear, reportMonth);
    } else {
        yearlyFilter = String(yearly_filter || "").trim().toLowerCase();

        if (yearlyFilter === "joining_date") {
            startDate = `${reportYear}-01-01`;
            endDate = `${reportYear}-12-31`;
        } else if (yearlyFilter === "financial_year") {
            const financialYearRange = parseFinancialYearRange(
                financial_year ||
                `${reportYear}-${String(Number(reportYear) + 1).slice(-2)}`
            );
            financialYearValue = financialYearRange.financialYear;
            startDate = financialYearRange.startDate;
            endDate = financialYearRange.endDate;
        } else {
            throw new Error(
                "yearly_filter must be joining_date or financial_year"
            );
        }
    }

    const result = await pool.query(
        `
        SELECT DISTINCT ON (
            LOWER(TRIM(p.username::TEXT)),
            p.payroll_year,
            p.payroll_month
        )
            UPPER(TRIM(p.username::TEXT)) AS username,
            p.payroll_month,
            p.payroll_year,
            p.net_salary,
            wl.location AS work_location
        FROM payroll p
        INNER JOIN personal_details pd
            ON LOWER(TRIM(pd.username)) =
               LOWER(TRIM(p.username::TEXT))
        LEFT JOIN LATERAL (
            SELECT ed_inner.work_location
            FROM employment_details ed_inner
            WHERE ed_inner.personal_details_id = pd.id
               OR LOWER(TRIM(ed_inner.username)) =
                  LOWER(TRIM(pd.username))
            ORDER BY ed_inner.id DESC
            LIMIT 1
        ) ed ON TRUE
        LEFT JOIN work_location wl
            ON wl.id::TEXT = TRIM(ed.work_location::TEXT)
        WHERE MAKE_DATE(p.payroll_year, p.payroll_month, 1)
              BETWEEN $2::DATE AND $3::DATE
          AND (
                LOWER(TRIM(COALESCE(p.salary_status, ''))) = 'paid'
                OR p.paid_at IS NOT NULL
          )
          AND (${workLocationFilterSql(1)})
        ORDER BY
            LOWER(TRIM(p.username::TEXT)),
            p.payroll_year,
            p.payroll_month,
            p.updated_at DESC NULLS LAST,
            p.id DESC;
        `,
        [locationValue, startDate, endDate]
    );

    const payrollRows = result.rows;
    const uniqueEmployees = new Set(
        payrollRows.map((row) =>
            String(row.username || "").trim().toLowerCase()
        )
    );

    const sumPaidSalary = (rows) =>
        rows.reduce(
            (total, row) => addMoneyCents(total, row.net_salary),
            0n
        );

    if (reportType === "yearly") {
        const month = monthsInDateRange(startDate, endDate).map((slot) => {
            const monthRows = payrollRows.filter(
                (row) =>
                    Number(row.payroll_month) === slot.month &&
                    Number(row.payroll_year) === slot.year
            );
            const monthEmployees = new Set(
                monthRows.map((row) =>
                    String(row.username || "").trim().toLowerCase()
                )
            );

            return {
                month: slot.month,
                year: slot.year,
                employee_count: monthEmployees.size,
                total_paid_salary: toMoney(sumPaidSalary(monthRows))
            };
        });

        return {
            type: "yearly",
            yearly_filter: yearlyFilter,
            financial_year: financialYearValue,
            year: reportYear,
            work_location: locationValue,
            date_range: {
                from: startDate,
                to: endDate
            },
            employee_count: uniqueEmployees.size,
            total_paid_salary: toMoney(sumPaidSalary(payrollRows)),
            month
        };
    }

    return {
        type: "monthly",
        work_location: locationValue,
        month: reportMonth,
        year: reportYear,
        date_range: {
            from: startDate,
            to: endDate
        },
        employee_count: uniqueEmployees.size,
        total_paid_salary: toMoney(sumPaidSalary(payrollRows))
    };
};

const roundPercent = (value) => Number(value.toFixed(2));

const toFinancialYear = (dateValue) => {
    const date = toDateOnly(dateValue);

    if (!date) {
        return null;
    }

    const [year, month] = date.split("-").map(Number);

    if (month >= 4) {
        return `${year}-${String(year + 1).slice(-2)}`;
    }

    return `${year - 1}-${String(year).slice(-2)}`;
};

const financialYearStartYear = (financialYear) => {
    if (!financialYear) {
        return null;
    }

    return Number(String(financialYear).split("-")[0]);
};

const financialYearLabel = (startYear) =>
    `${startYear}-${String(startYear + 1).slice(-2)}`;

const financialYearStartDate = (startYear) => `${startYear}-04-01`;

const listFinancialYears = (fromDate, toDate) => {
    const startYear = financialYearStartYear(toFinancialYear(fromDate));
    const endYear = financialYearStartYear(toFinancialYear(toDate));

    if (!Number.isInteger(startYear) || !Number.isInteger(endYear)) {
        return [];
    }

    const years = [];

    for (let year = startYear; year <= endYear; year += 1) {
        years.push(financialYearLabel(year));
    }

    return years;
};

const incrementChartLabel = (dateValue) => {
    const date = toDateOnly(dateValue);

    if (!date) {
        return null;
    }

    const [year, month] = date.split("-").map(Number);
    const monthNames = [
        "Jan",
        "Feb",
        "Mar",
        "Apr",
        "May",
        "Jun",
        "Jul",
        "Aug",
        "Sep",
        "Oct",
        "Nov",
        "Dec"
    ];

    return `${monthNames[month - 1]} ${year}`;
};

const dateToChartPosition = (dateValue, axisStartYear) => {
    const date = toDateOnly(dateValue);

    if (!date || !Number.isInteger(axisStartYear)) {
        return 0;
    }

    const [year, month, day] = date.split("-").map(Number);
    const fyStartYear = month >= 4 ? year : year - 1;
    const monthInFy = month >= 4 ? month - 4 : month + 8;
    const dayFraction = (Math.max(day, 1) - 1) / 30;

    return fyStartYear - axisStartYear + (monthInFy + dayFraction) / 12;
};

const salaryAsOfDate = (timeline, date) => {
    let salary = 0;

    for (const point of timeline) {
        if (!point.date || point.date > date) {
            break;
        }

        salary = point.salary;
    }

    return salary;
};

const buildChartPoints = (
    timeline,
    currentSalary,
    joining = {},
    getSalaryAtDate = null
) => {
    const nowDate = toDateOnly(new Date());
    const joiningDate = joining.date || timeline[0]?.date || nowDate;
    const joiningYear = joining.year || toFinancialYear(joiningDate);
    const startDate = joiningDate || timeline[0]?.date || nowDate;
    const years = listFinancialYears(startDate, nowDate);
    const axisStartYear = financialYearStartYear(years[0]);

    const salaryAt = (date) => {
        if (typeof getSalaryAtDate === "function") {
            return getSalaryAtDate(date);
        }

        return salaryAsOfDate(timeline, date);
    };

    const yearPoints = years.map((year, index) => {
        const fyDate = financialYearStartDate(axisStartYear + index);
        const pointDate = fyDate < startDate ? startDate : fyDate;

        return {
            type: "year",
            label: year,
            year,
            date: pointDate,
            position: roundPercent(index),
            salary: roundPercent(salaryAt(pointDate)),
            increment: 0,
            increment_percentage: 0
        };
    });

    const incrementPoints = timeline
        .filter(
            (point) => moneyAmount(point.increment) > 0 && point.date
        )
        .map((point) => {
            const position = dateToChartPosition(point.date, axisStartYear);

            return {
                type: "increment",
                label: incrementChartLabel(point.date),
                year: point.year,
                date: point.date,
                position: roundPercent(position),
                salary: roundPercent(point.salary),
                increment: roundPercent(point.increment),
                increment_percentage: roundPercent(
                    point.increment_percentage || 0
                )
            };
        });

    return [...yearPoints, ...incrementPoints].sort(
        (left, right) => left.position - right.position
    );
};

export const getPayrollIncrementReportModel = async ({
    work_location,
    name,
    username
}) => {
    const locationValue =
        work_location == null ||
            String(work_location).trim() === "" ||
            String(work_location).trim().toLowerCase() === "all"
            ? null
            : String(work_location).trim();
    const nameSource = [name, username].find(
        (value) => value != null && String(value).trim() !== ""
    );
    const nameValue =
        nameSource == null ? null : String(nameSource).trim();

    const result = await pool.query(
        `
        SELECT
            UPPER(TRIM(epc.username::TEXT)) AS username,
            CONCAT_WS(
                ' ',
                NULLIF(TRIM(pd.first_name), ''),
                NULLIF(TRIM(pd.middle_name), ''),
                NULLIF(TRIM(pd.last_name), '')
            ) AS name,
            wl.location AS work_location,
            TO_CHAR(ed.date_of_joining, 'YYYY-MM-DD') AS date_of_joining,
            epc.id AS payroll_config_id,
            epc.serial_number,
            epc.status AS payroll_status,
            TO_CHAR(epc.payroll_start_date, 'YYYY-MM-DD')
                AS payroll_start_date,
            TO_CHAR(epc.payroll_end_date, 'YYYY-MM-DD')
                AS payroll_end_date,
            EXTRACT(MONTH FROM epc.payroll_start_date)::INTEGER
                AS payroll_month,
            EXTRACT(YEAR FROM epc.payroll_start_date)::INTEGER
                AS payroll_year,
            COALESCE(epc.current_salary, sd_latest.current_salary)
                AS basic_salary,
            TO_CHAR(epc.payroll_start_date, 'YYYY-MM-DD')
                AS payroll_date,
            TO_CHAR(epc.payroll_start_date, 'YYYY-MM-DD')
                AS generated_at,
            epc.updated_at,
            epc.created_at
        FROM employee_payroll_config epc
        INNER JOIN personal_details pd
            ON LOWER(TRIM(pd.username)) =
               LOWER(TRIM(epc.username::TEXT))
        LEFT JOIN LATERAL (
            SELECT sd.current_salary
            FROM salary_details sd
            WHERE sd.personal_details_id = pd.id
            ORDER BY sd.id DESC
            LIMIT 1
        ) sd_latest ON TRUE
        LEFT JOIN LATERAL (
            SELECT
                ed_inner.work_location,
                ed_inner.date_of_joining
            FROM employment_details ed_inner
            WHERE ed_inner.personal_details_id = pd.id
               OR LOWER(TRIM(ed_inner.username)) =
                  LOWER(TRIM(epc.username))
            ORDER BY ed_inner.id DESC
            LIMIT 1
        ) ed ON TRUE
        LEFT JOIN work_location wl
            ON wl.id::TEXT = TRIM(ed.work_location::TEXT)
        WHERE (${workLocationFilterSql(1)})
          AND (${nameFilterSql(2)})
        ORDER BY
            LOWER(TRIM(epc.username::TEXT)),
            epc.payroll_start_date ASC,
            epc.id ASC;
        `,
        [locationValue, nameValue]
    );

    const payrollRows = decryptPayrollRows(result.rows, ["basic_salary"]);
    const employeesByUsername = new Map();

    for (const row of payrollRows) {
        const key = String(row.username || "").trim().toLowerCase();

        if (!employeesByUsername.has(key)) {
            employeesByUsername.set(key, {
                username: String(row.username || "").trim().toUpperCase(),
                name: row.name || null,
                work_location: row.work_location || null,
                date_of_joining: toDateOnly(row.date_of_joining),
                rows: []
            });
        }

        const employee = employeesByUsername.get(key);
        employee.name = row.name || employee.name;
        if (!employee.date_of_joining) {
            employee.date_of_joining = toDateOnly(row.date_of_joining);
        }
        employee.rows.push(row);
    }

    const employees = Array.from(employeesByUsername.values()).map(
        (employee) => {
            const history = [...employee.rows].sort((left, right) => {
                const yearDiff =
                    Number(left.payroll_year) - Number(right.payroll_year);

                if (yearDiff !== 0) {
                    return yearDiff;
                }

                return Number(left.payroll_month) - Number(right.payroll_month);
            });

            const records = [];
            let previousSalary = null;
            const firstRow = history[0];
            const joiningDate = employee.date_of_joining || null;
            const joiningYear = toFinancialYear(joiningDate);
            const firstDate =
                joiningDate ||
                toDateOnly(firstRow?.payroll_date) ||
                toDateOnly(firstRow?.generated_at) ||
                toDateOnly(firstRow?.created_at);
            const timeline = [];

            if (firstRow) {
                timeline.push({
                    date: firstDate,
                    year: joiningYear || toFinancialYear(firstDate),
                    salary: moneyAmount(firstRow.basic_salary),
                    increment: 0,
                    increment_percentage: 0
                });
            }

            for (const row of history) {
                const currentSalary = moneyAmount(row.basic_salary);

                if (previousSalary !== null && currentSalary > previousSalary) {
                    const increment = roundPercent(currentSalary - previousSalary);
                    const incrementDate =
                        toDateOnly(row.generated_at) ||
                        toDateOnly(row.updated_at) ||
                        toDateOnly(row.created_at) ||
                        row.payroll_date ||
                        null;
                    const financialYear = toFinancialYear(incrementDate);
                    const incrementPercentage =
                        previousSalary > 0
                            ? roundPercent((increment / previousSalary) * 100)
                            : 0;

                    records.push({
                        increment_date: incrementDate,
                        year: financialYear,
                        month: Number(row.payroll_month),
                        previous_salary: previousSalary,
                        current_salary: currentSalary,
                        increment,
                        increment_percentage: incrementPercentage
                    });

                    timeline.push({
                        date: incrementDate,
                        year: financialYear,
                        salary: currentSalary,
                        increment,
                        increment_percentage: incrementPercentage
                    });
                }

                if (currentSalary > 0) {
                    previousSalary = currentSalary;
                }
            }

            const firstSalary = moneyAmount(history[0]?.basic_salary);
            const currentSalary = moneyAmount(
                history[history.length - 1]?.basic_salary
            );
            const totalIncrement = records.reduce(
                (sum, record) => sum + moneyAmount(record.increment),
                0
            );

            /* One entry per employee_payroll_config period, with the
               salary increment from the previous period. */
            let configPreviousSalary = null;
            const configurations = history.map((row) => {
                const salary = moneyAmount(row.basic_salary);
                const increment = configPreviousSalary === null
                    ? 0
                    : roundPercent(salary - configPreviousSalary);
                const incrementPercentage =
                    configPreviousSalary > 0
                        ? roundPercent(
                            (increment / configPreviousSalary) * 100
                        )
                        : 0;

                const entry = {
                    payroll_config_id: row.payroll_config_id,
                    serial_number: row.serial_number,
                    payroll_start_date: toDateOnly(row.payroll_start_date),
                    payroll_end_date: toDateOnly(row.payroll_end_date),
                    payroll_status: row.payroll_status,
                    current_salary: salary,
                    previous_salary: configPreviousSalary,
                    increment,
                    increment_percentage: incrementPercentage
                };

                if (salary > 0) {
                    configPreviousSalary = salary;
                }

                return entry;
            });

            return {
                username: employee.username,
                name: employee.name,
                work_location: employee.work_location,
                date_of_joining: joiningDate,
                joining_year: joiningYear,
                increment_count: records.length,
                first_salary: firstSalary,
                current_salary: currentSalary,
                configurations,
                total_increment: roundPercent(totalIncrement),
                increment_percentage:
                    firstSalary > 0
                        ? roundPercent(
                            ((currentSalary - firstSalary) / firstSalary) * 100
                        )
                        : 0,
                years: listFinancialYears(
                    joiningDate || firstDate,
                    toDateOnly(new Date())
                ),
                records,
                chart: buildChartPoints(timeline, currentSalary, {
                    date: joiningDate,
                    year: joiningYear
                }),
                timeline
            };
        }
    );

    const totalFirstSalary = employees.reduce(
        (sum, employee) => sum + moneyAmount(employee.first_salary),
        0
    );
    const totalCurrentSalary = employees.reduce(
        (sum, employee) => sum + moneyAmount(employee.current_salary),
        0
    );
    const totalIncrement = employees.reduce(
        (sum, employee) => sum + moneyAmount(employee.total_increment),
        0
    );

    const joiningDates = employees
        .map((employee) => employee.date_of_joining)
        .filter(Boolean)
        .sort();
    const joiningDate = joiningDates[0] || null;
    const joiningYear = toFinancialYear(joiningDate);
    const nowDate = toDateOnly(new Date());
    const years = listFinancialYears(joiningDate, nowDate);

    const incrementTimeline = [];
    const incrementDates = [
        ...new Set(
            employees.flatMap((employee) =>
                (employee.timeline || [])
                    .filter((point) => moneyAmount(point.increment) > 0)
                    .map((point) => point.date)
                    .filter(Boolean)
            )
        )
    ].sort();

    for (const date of incrementDates) {
        const salary = employees.reduce(
            (sum, employee) =>
                sum + salaryAsOfDate(employee.timeline || [], date),
            0
        );
        const increment = employees.reduce((sum, employee) => {
            const point = (employee.timeline || []).find(
                (item) =>
                    item.date === date && moneyAmount(item.increment) > 0
            );

            return sum + moneyAmount(point?.increment);
        }, 0);
        const previousSalary = employees.reduce(
            (sum, employee) =>
                sum + salaryAsOfDate(employee.timeline || [], date),
            0
        ) - increment;

        incrementTimeline.push({
            date,
            year: toFinancialYear(date),
            salary,
            increment,
            increment_percentage:
                previousSalary > 0
                    ? roundPercent((increment / previousSalary) * 100)
                    : 0
        });
    }

    const allEmployeesChart = buildChartPoints(
        incrementTimeline,
        totalCurrentSalary,
        {
            date: joiningDate,
            year: joiningYear
        },
        (date) =>
            employees.reduce(
                (sum, employee) =>
                    sum + salaryAsOfDate(employee.timeline || [], date),
                0
            )
    );

    return {
        work_location: locationValue,
        name: nameValue,
        employee_count: employees.length,
        total_first_salary: roundPercent(totalFirstSalary),
        total_current_salary: roundPercent(totalCurrentSalary),
        total_increment: roundPercent(totalIncrement),
        increment_percentage:
            totalFirstSalary > 0
                ? roundPercent(
                    ((totalCurrentSalary - totalFirstSalary) /
                        totalFirstSalary) *
                    100
                )
                : 0,
        chart: allEmployeesChart,
        employees: employees.flatMap((employee) =>
            (employee.configurations || []).map((config) => ({
                username: employee.username,
                name: employee.name,
                payroll_config_id: config.payroll_config_id,
                serial_number: config.serial_number,
                payroll_start_date: config.payroll_start_date,
                payroll_end_date: config.payroll_end_date,
                payroll_status: config.payroll_status,
                current_salary: config.current_salary,
                previous_salary: config.previous_salary,
                increment: config.increment,
                increment_percentage: config.increment_percentage
            }))
        )
    };
};


export const getFinancialYearSalaryReportModel = async ({
    work_location = null,
    username = null,
    type = "yearly",
    yearly_filter = "financial_year",
    financial_year = "",
    mode = "detail"
}) => {
    const locationValue =
        work_location == null ||
        String(work_location).trim() === "" ||
        String(work_location).trim().toLowerCase() === "all"
            ? null
            : String(work_location).trim();
    const usernameValue =
        username == null || String(username).trim() === ""
            ? null
            : String(username).trim();

    const monthNames = [
        "January", "February", "March", "April",
        "May", "June", "July", "August",
        "September", "October", "November", "December"
    ];

    const parseSalary = (value) => {
        if (value === null || value === undefined || value === "") {
            return null;
        }

        const amount = Number(value);

        return Number.isFinite(amount) && amount >= 0
            ? amount
            : null;
    };

    const toCents = (amount) =>
        Math.round((amount + Number.EPSILON) * 100);

    const formatAmount = (cents) =>
        Number((cents / 100).toFixed(2));

    const getFYStartYear = (year, month) =>
        month >= 4 ? year : year - 1;

    const getFYLabel = (startYear) =>
        `${startYear}-${String(startYear + 1).slice(-2)}`;

    const getCurrentFYStartYear = () => {
        const now = new Date();
        return now.getMonth() >= 3
            ? now.getFullYear()
            : now.getFullYear() - 1;
    };

    // --------------------------------------------------
    // 1. Determine mode.
    // --------------------------------------------------
    if (!["all", "detail"].includes(mode)) {
        throw new Error("Invalid report mode.");
    }

    if (mode === "detail") {
        if (type !== "yearly") {
            throw new Error("This API supports type=yearly only.");
        }

        if (yearly_filter !== "financial_year") {
            throw new Error(
                "This API supports yearly_filter=financial_year only."
            );
        }
    }

    let selectedStartYear = getCurrentFYStartYear();

    if (mode === "detail" && financial_year) {
        const match = String(financial_year).trim().match(
            /^(\d{4})-(\d{2}|\d{4})$/
        );

        if (!match) {
            throw new Error(
                "Invalid financial_year. Use format 2026-27."
            );
        }

        selectedStartYear = Number(match[1]);

        const nextYear = selectedStartYear + 1;

        if (
            match[2] !== String(nextYear).slice(-2) &&
            match[2] !== String(nextYear)
        ) {
            throw new Error(
                "Invalid financial_year range. Example: 2026-27."
            );
        }
    }

    // --------------------------------------------------
    // 2. Load all configurations and payroll records.
    //    We load the available historical data for all
    //    years in order to build both report modes.
    // --------------------------------------------------
    const configResult = await pool.query(
        `
        SELECT
            epc.id,
            LOWER(TRIM(epc.username::TEXT)) AS username,
            TO_CHAR(epc.payroll_start_date::DATE, 'YYYY-MM-DD')
                AS start_date,
            TO_CHAR(epc.payroll_end_date::DATE, 'YYYY-MM-DD')
                AS end_date,
            epc.current_salary AS basic_salary
        FROM employee_payroll_config epc
        WHERE epc.payroll_start_date IS NOT NULL
          AND epc.payroll_end_date IS NOT NULL
          AND epc.payroll_end_date >= epc.payroll_start_date
          AND (
              $1::TEXT IS NULL
              OR EXISTS (
                  SELECT 1
                  FROM personal_details pd
                  INNER JOIN employment_details ed
                      ON ed.personal_details_id = pd.id
                  LEFT JOIN work_location wl
                      ON wl.id::TEXT = TRIM(ed.work_location::TEXT)
                  WHERE LOWER(TRIM(pd.username)) =
                        LOWER(TRIM(epc.username::TEXT))
                    AND (
                        TRIM(ed.work_location::TEXT) = $1
                        OR (
                            $1 ~ '^[0-9]+$'
                            AND wl.id = $1::INTEGER
                        )
                        OR LOWER(TRIM(wl.location)) = LOWER(TRIM($1))
                    )
              )
          )
        ORDER BY
            LOWER(TRIM(epc.username::TEXT)),
            epc.payroll_start_date,
            epc.id
        `,
        [locationValue]
    );

    const payrollResult = await pool.query(
        `
        SELECT DISTINCT ON (
            LOWER(TRIM(p.username::TEXT)),
            p.payroll_year,
            p.payroll_month
        )
            LOWER(TRIM(p.username::TEXT)) AS username,
            p.payroll_month,
            p.payroll_year,
            p.basic_salary,
            p.net_salary,
            p.salary_status,
            p.paid_at
        FROM payroll p
        WHERE p.payroll_month BETWEEN 1 AND 12
          AND p.payroll_year >= 2000
          AND (
              $1::TEXT IS NULL
              OR EXISTS (
                  SELECT 1
                  FROM personal_details pd
                  INNER JOIN employment_details ed
                      ON ed.personal_details_id = pd.id
                  LEFT JOIN work_location wl
                      ON wl.id::TEXT = TRIM(ed.work_location::TEXT)
                  WHERE LOWER(TRIM(pd.username)) =
                        LOWER(TRIM(p.username::TEXT))
                    AND (
                        TRIM(ed.work_location::TEXT) = $1
                        OR (
                            $1 ~ '^[0-9]+$'
                            AND wl.id = $1::INTEGER
                        )
                        OR LOWER(TRIM(wl.location)) = LOWER(TRIM($1))
                    )
              )
          )
        ORDER BY
            LOWER(TRIM(p.username::TEXT)),
            p.payroll_year,
            p.payroll_month,
            p.updated_at DESC NULLS LAST,
            p.id DESC
        `,
        [locationValue]
    );

    const payrollRows = decryptPayrollRows(
        payrollResult.rows,
        ["basic_salary", "net_salary"]
    );
    
    const salaryConfigRows = decryptPayrollRows(
        configResult.rows,
        ["basic_salary"]
    );

    // --------------------------------------------------
    // 3. Normalize salary configurations.
    // --------------------------------------------------
    const configsByEmployee = new Map();

    for (const row of salaryConfigRows) {
        const username = String(row.username || "")
            .trim()
            .toLowerCase();

        if (!username || !row.start_date || !row.end_date) {
            continue;
        }

        if (!configsByEmployee.has(username)) {
            configsByEmployee.set(username, []);
        }

        configsByEmployee.get(username).push({
            id: Number(row.id),
            username,
            start: String(row.start_date).slice(0, 10),
            end: String(row.end_date).slice(0, 10),
            basicSalary: parseSalary(row.basic_salary)
        });
    }

    for (const configs of configsByEmployee.values()) {
        configs.sort(
            (a, b) =>
                b.start.localeCompare(a.start) ||
                b.id - a.id
        );
    }

    const payrollByEmployeeMonth = new Map();
    const financialYears = new Set();

    // Register years covered by salary configurations.
    for (const configs of configsByEmployee.values()) {
        for (const config of configs) {
            const start = new Date(`${config.start}T00:00:00Z`);
            const end = new Date(`${config.end}T00:00:00Z`);

            let year = start.getUTCFullYear();
            let month = start.getUTCMonth() + 1;

            while (
                year < end.getUTCFullYear() ||
                (
                    year === end.getUTCFullYear() &&
                    month <= end.getUTCMonth() + 1
                )
            ) {
                financialYears.add(getFYStartYear(year, month));

                month++;

                if (month > 12) {
                    month = 1;
                    year++;
                }
            }
        }
    }

    // Normalize payroll rows and register their years.
    for (const row of payrollRows) {
        const username = String(row.username || "")
            .trim()
            .toLowerCase();

        const year = Number(row.payroll_year);
        const month = Number(row.payroll_month);

        if (
            !username ||
            !Number.isInteger(year) ||
            !Number.isInteger(month) ||
            month < 1 ||
            month > 12
        ) {
            continue;
        }

        const key = `${username}|${year}-${String(month).padStart(2, "0")}`;

        payrollByEmployeeMonth.set(key, row);
        financialYears.add(getFYStartYear(year, month));
    }

    // If no data exists, detailed mode still returns the
    // requested/current financial year with zero totals.
    if (mode === "detail") {
        financialYears.add(selectedStartYear);
    } else if (financialYears.size > 0) {
        const availableYears = [...financialYears];
        const firstYear = Math.min(...availableYears);
        const lastYear = Math.max(...availableYears);

        for (let year = firstYear; year <= lastYear; year++) {
            financialYears.add(year);
        }
    }

    // --------------------------------------------------
    // 4. Calculate one financial-year summary.
    // --------------------------------------------------
    const calculateFinancialYear = (startYear, includeChart = false) => {
        const endYear = startYear + 1;
        const monthly = [];

        for (let position = 0; position < 12; position++) {
            const month = ((position + 3) % 12) + 1;
            const year = month >= 4 ? startYear : endYear;

            monthly.push({
                label: monthNames[month - 1].slice(0, 3),
                full_label: `${monthNames[month - 1]} ${year}`,
                month,
                year,
                position,
                total_basic_salary_cents: 0,
                total_paid_cents: 0,
                total_pending_cents: 0,
                total_net_salary_cents: 0,
                employees: new Set()
            });
        }

        const monthlyByKey = new Map(
            monthly.map((item) => [
                `${item.year}-${String(item.month).padStart(2, "0")}`,
                item
            ])
        );

        const yearlyEmployees = new Set();

        // Configured basic salary: one winning configuration
        // per employee per month.
        for (const [username, configs] of configsByEmployee) {
            if (
                usernameValue &&
                username !== usernameValue.toLowerCase()
            ) {
                continue;
            }

            for (const item of monthly) {
                const monthStart =
                    `${item.year}-${String(item.month).padStart(2, "0")}-01`;

                const lastDay = new Date(
                    item.year,
                    item.month,
                    0
                ).getDate();

                const monthEnd =
                    `${item.year}-${String(item.month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

                const applicable = configs.filter(
                    (config) =>
                        config.start <= monthEnd &&
                        config.end >= monthStart
                );

                if (!applicable.length) continue;

                const winningConfig = applicable[0];

                if (winningConfig.basicSalary === null) continue;

                item.total_basic_salary_cents += toCents(
                    winningConfig.basicSalary
                );
            }
        }

        let totalNet = 0;
        let totalPaid = 0;
        let totalPending = 0;

        for (const [key, row] of payrollByEmployeeMonth) {
            const [, period] = key.split("|");
            const [yearText, monthText] = period.split("-");
            const year = Number(yearText);
            const month = Number(monthText);

            if (getFYStartYear(year, month) !== startYear) {
                continue;
            }

            const username = String(row.username || "")
                .trim()
                .toLowerCase();

            if (
                usernameValue &&
                username !== usernameValue.toLowerCase()
            ) {
                continue;
            }

            const item = monthlyByKey.get(
                `${year}-${String(month).padStart(2, "0")}`
            );

            if (!item || !username) continue;

            item.employees.add(username);
            yearlyEmployees.add(username);

            const netSalary = parseSalary(row.net_salary);

            if (netSalary === null) continue;

            const netCents = toCents(netSalary);
            const status = String(row.salary_status || "")
                .trim()
                .toLowerCase();

            const isPaid = status === "paid" || row.paid_at != null;

            item.total_net_salary_cents += netCents;
            totalNet += netCents;

            if (isPaid) {
                item.total_paid_cents += netCents;
                totalPaid += netCents;
            } else {
                item.total_pending_cents += netCents;
                totalPending += netCents;
            }
        }

        const totalBasic = monthly.reduce(
            (sum, item) => sum + item.total_basic_salary_cents,
            0
        );

        const paidPercentage = totalNet
            ? Number(((totalPaid / totalNet) * 100).toFixed(2))
            : 0;

        const pendingPercentage = totalNet
            ? Number(((totalPending / totalNet) * 100).toFixed(2))
            : 0;

        const summary = {
            financial_year: getFYLabel(startYear),
            employee_count: yearlyEmployees.size,
            total_basic_salary: formatAmount(totalBasic),
            total_paid: formatAmount(totalPaid),
            total_pending: formatAmount(totalPending),
            total_net_salary: formatAmount(totalNet),
            paid_percentage: paidPercentage,
            pending_percentage: pendingPercentage
        };

        if (!includeChart) {
            return summary;
        }

        return {
            type: "yearly",
            work_location: locationValue || "all",
            year: startYear,
            yearly_filter: "financial_year",
            ...summary,
            chart: monthly.map((item) => ({
                label: item.label,
                full_label: item.full_label,
                month: item.month,
                year: item.year,
                position: item.position,
                employee_count: item.employees.size,
                total_basic_salary: formatAmount(
                    item.total_basic_salary_cents
                ),
                total_paid: formatAmount(item.total_paid_cents),
                total_pending: formatAmount(item.total_pending_cents),
                total_net_salary: formatAmount(
                    item.total_net_salary_cents
                ),
                paid_percentage: item.total_net_salary_cents
                    ? Number(
                          (
                              (item.total_paid_cents /
                                  item.total_net_salary_cents) *
                              100
                          ).toFixed(2)
                      )
                    : 0
            }))
        };
    };

    // --------------------------------------------------
    // 5. Return the requested response.
    // --------------------------------------------------
    if (mode === "all") {
        return [...financialYears]
            .sort((a, b) => b - a)
            .map((year) => calculateFinancialYear(year));
    }

    return {
        ...calculateFinancialYear(selectedStartYear, true),
        financial_year: getFYLabel(selectedStartYear)
    };
};
