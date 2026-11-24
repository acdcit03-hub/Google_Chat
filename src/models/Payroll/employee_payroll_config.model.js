import { pool } from "../../database.js";
import {
    decryptPayrollFields,
    decryptPayrollRows,
    encryptPayrollAmount,
    migratePayrollEncryptedColumns
} from "../../utils/payrollEncryption.js";
import { addPayrollEditLogModel } from "../history/payroll_edit_log.model.js";

/* =========================================================
   CREATE EMPLOYEE PAYROLL CONFIG TABLE
========================================================= */
export const initializeEmployeePayrollConfigTable = async () => {
    const query = `
        CREATE TABLE IF NOT EXISTS employee_payroll_config (
            id SERIAL PRIMARY KEY,
            serial_number VARCHAR(20),
            username VARCHAR(100) NOT NULL,
            working_start_time TIME NOT NULL,
            working_end_time TIME NOT NULL,
            payroll_start_date DATE NOT NULL,
            payroll_end_date DATE NOT NULL,
            applicable_date DATE,
            day_type VARCHAR(20),
            status VARCHAR(30) NOT NULL DEFAULT 'pending',
            created_by VARCHAR(100),
            updated_by VARCHAR(100),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

            CONSTRAINT employee_payroll_config_date_check
                CHECK (
                    payroll_end_date >= payroll_start_date
                ),

            CONSTRAINT employee_payroll_config_username_fk
                FOREIGN KEY (username)
                REFERENCES personal_details(username)
                ON DELETE CASCADE
        );
    `;

    await pool.query(query);

    await pool.query(`
        ALTER TABLE employee_payroll_config
            ADD COLUMN IF NOT EXISTS serial_number VARCHAR(20),
            ADD COLUMN IF NOT EXISTS day_type VARCHAR(20);
    `);

    await pool.query(`
        UPDATE employee_payroll_config
        SET day_type = 'none'
        WHERE day_type IS NULL;

        ALTER TABLE employee_payroll_config
            ALTER COLUMN day_type SET DEFAULT 'none',
            ALTER COLUMN day_type SET NOT NULL,
            DROP CONSTRAINT IF EXISTS employee_payroll_config_day_type_check;
    `);

    await pool.query(`
        ALTER TABLE employee_payroll_config
            DROP CONSTRAINT IF EXISTS employee_payroll_config_month_check,
            DROP CONSTRAINT IF EXISTS employee_payroll_config_year_check,
            DROP COLUMN IF EXISTS payroll_month,
            DROP COLUMN IF EXISTS payroll_year;
    `);

    /* =====================================================
       PERIOD-WISE CONFIGURATIONS
       One row per payroll period for an employee, and every
       row stores the salary applicable to its own period.
    ===================================================== */
    await pool.query(`
        DROP INDEX IF EXISTS employee_payroll_config_username_unique_idx;

        ALTER TABLE employee_payroll_config
            ADD COLUMN IF NOT EXISTS current_salary TEXT,
            ADD COLUMN IF NOT EXISTS next_increment_date DATE,
            DROP COLUMN IF EXISTS expected_increment;

        CREATE INDEX IF NOT EXISTS
            employee_payroll_config_username_period_idx
        ON employee_payroll_config (
            username,
            payroll_start_date,
            payroll_end_date
        );
    `);

    /* Backfill period salary from the latest salary_details row. */
    await pool.query(`
        UPDATE employee_payroll_config epc
        SET current_salary = latest_salary.current_salary,
            next_increment_date = latest_salary.next_increment_date
        FROM (
            SELECT DISTINCT ON (sd.personal_details_id)
                sd.personal_details_id,
                sd.current_salary,
                sd.next_increment_date
            FROM salary_details sd
            ORDER BY sd.personal_details_id, sd.id DESC
        ) latest_salary
        INNER JOIN personal_details pd
            ON pd.id = latest_salary.personal_details_id
        WHERE LOWER(TRIM(pd.username)) = LOWER(TRIM(epc.username))
          AND epc.current_salary IS NULL;
    `);

    await pool.query(`
        ALTER TABLE employment_details
            ADD COLUMN IF NOT EXISTS shift_id INTEGER;

        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'employee_payroll_config'
                  AND column_name = 'shift_id'
            ) THEN
                EXECUTE $migration$
                    UPDATE employment_details ed
                    SET shift_id = latest_config.shift_id
                    FROM (
                        SELECT DISTINCT ON (LOWER(TRIM(username)))
                            username,
                            shift_id
                        FROM employee_payroll_config
                        WHERE shift_id IS NOT NULL
                        ORDER BY
                            LOWER(TRIM(username)),
                            CASE
                                WHEN (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::DATE
                                    BETWEEN payroll_start_date AND payroll_end_date
                                THEN 0 ELSE 1
                            END,
                            payroll_start_date DESC NULLS LAST,
                            id DESC
                    ) latest_config
                    INNER JOIN personal_details pd
                        ON LOWER(TRIM(pd.username)) =
                           LOWER(TRIM(latest_config.username))
                    WHERE pd.id = ed.personal_details_id
                      AND ed.shift_id IS NULL;
                $migration$;
            END IF;
        END
        $$;

        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1
                FROM pg_constraint
                WHERE conname = 'employment_details_shift_fk'
                  AND conrelid = 'employment_details'::regclass
            ) THEN
                ALTER TABLE employment_details
                    ADD CONSTRAINT employment_details_shift_fk
                    FOREIGN KEY (shift_id)
                    REFERENCES shift_configurations(id)
                    ON DELETE RESTRICT;
            END IF;
        END
        $$;

        ALTER TABLE employee_payroll_config
            DROP CONSTRAINT IF EXISTS employee_payroll_config_shift_fk,
            DROP COLUMN IF EXISTS shift_id;
    `);

    await pool.query(`
        ALTER TABLE employee_payroll_config
            DROP CONSTRAINT IF EXISTS employee_payroll_config_pending_shift_fk;
    `);

    await pool.query(`
        ALTER TABLE employee_payroll_config
            ADD COLUMN IF NOT EXISTS applicable_date DATE,
            DROP COLUMN IF EXISTS pending_shift_id,
            DROP COLUMN IF EXISTS pending_working_start_time,
            DROP COLUMN IF EXISTS pending_working_end_time;
    `);

    await pool.query(`
        DROP TABLE IF EXISTS employee_payroll_config_shift_history;
    `);

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const configsWithoutSerial = await client.query(
            `
            SELECT id
            FROM employee_payroll_config
            WHERE serial_number IS NULL
            ORDER BY id ASC
            FOR UPDATE;
            `
        );

        for (const config of configsWithoutSerial.rows) {
            const serialNumber =
                await generateEmployeePayrollConfigSerialNumber(client);
            await client.query(
                `
                UPDATE employee_payroll_config
                SET serial_number = $1
                WHERE id = $2;
                `,
                [serialNumber, config.id]
            );
        }

        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }

    console.log("✅ employee_payroll_config table initialized");
};

/* =========================================================
   CREATE PAYROLL TABLE
========================================================= */
export const initializePayrollTable = async () => {
    const query = `
        CREATE TABLE IF NOT EXISTS payroll (
            id SERIAL PRIMARY KEY,
            payroll_id VARCHAR(50) NOT NULL,
            pay_slip_no VARCHAR(20),
            username VARCHAR(100) NOT NULL,
            payroll_month INTEGER NOT NULL,
            payroll_year INTEGER NOT NULL,
            basic_salary TEXT,
            next_increment_date DATE,
            overtime_minutes INTEGER DEFAULT 0,
            overtime_hours NUMERIC(8,2) DEFAULT 0,
            overtime_amount NUMERIC(12,2) DEFAULT 0,
            net_salary NUMERIC(12,2) DEFAULT 0,
            created_by VARCHAR(100),
            approved_by VARCHAR(100),
            approved_at TIMESTAMP,
            generated BOOLEAN NOT NULL DEFAULT FALSE,
            generated_by VARCHAR(100),
            generated_at TIMESTAMP,
            salary_status VARCHAR(30) NOT NULL DEFAULT 'Pending',
            paid_by VARCHAR(100),
            paid_at TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT payroll_month_check
                CHECK (
                    payroll_month BETWEEN 1 AND 12
                ),

            CONSTRAINT payroll_year_check
                CHECK (
                    payroll_year >= 2000
                ),

            CONSTRAINT payroll_username_fk
                FOREIGN KEY (username)
                REFERENCES personal_details(username)
                ON DELETE CASCADE
        );
    `;

    await pool.query(query);
    await pool.query(`
        ALTER TABLE payroll
            ALTER COLUMN basic_salary DROP DEFAULT,
            ALTER COLUMN basic_salary TYPE TEXT USING basic_salary::TEXT,
            ADD COLUMN IF NOT EXISTS next_increment_date DATE,
            DROP COLUMN IF EXISTS expected_increment,
            ADD COLUMN IF NOT EXISTS created_by VARCHAR(100),
            ADD COLUMN IF NOT EXISTS paid_by VARCHAR(100),
            ADD COLUMN IF NOT EXISTS paid_at TIMESTAMP,
            ADD COLUMN IF NOT EXISTS approved_by VARCHAR(100),
            ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP,
            ADD COLUMN IF NOT EXISTS generated BOOLEAN NOT NULL DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS generated_by VARCHAR(100),
            ADD COLUMN IF NOT EXISTS generated_at TIMESTAMP,
            ADD COLUMN IF NOT EXISTS pay_slip_no VARCHAR(20);

        ALTER TABLE payroll
            ALTER COLUMN generated_at DROP DEFAULT;

        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = current_schema()
                  AND table_name = 'payroll'
                  AND column_name = 'status'
            ) THEN
                IF EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_schema = current_schema()
                      AND table_name = 'payroll'
                      AND column_name = 'salary_status'
                ) THEN
                    UPDATE payroll
                    SET salary_status = status
                    WHERE status IS NOT NULL;

                    ALTER TABLE payroll DROP COLUMN status;
                ELSE
                    ALTER TABLE payroll RENAME COLUMN status TO salary_status;
                END IF;
            END IF;
        END $$;

        ALTER TABLE payroll
            ADD COLUMN IF NOT EXISTS salary_status VARCHAR(30) NOT NULL DEFAULT 'Pending';

        ALTER TABLE payroll
            DROP CONSTRAINT IF EXISTS payroll_employee_month_unique,
            DROP CONSTRAINT IF EXISTS payroll_payroll_id_key;

        UPDATE payroll
        SET salary_status = 'Paid'
        WHERE paid_at IS NOT NULL
          AND LOWER(TRIM(salary_status)) NOT IN ('paid', 'approve', 'approved');

        UPDATE payroll
        SET salary_status = 'Approved'
        WHERE LOWER(TRIM(salary_status)) = 'approve';

        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = current_schema()
                  AND table_name = 'payroll'
                  AND column_name = 'paid'
            ) THEN
                UPDATE payroll
                SET salary_status = 'Paid'
                WHERE paid = TRUE;

                ALTER TABLE payroll
                    DROP COLUMN paid;
            END IF;
        END $$;
    `);
    await migratePayrollEncryptedColumns(
        pool,
        "payroll",
        ["basic_salary"]
    );

    console.log("✅ payroll table initialized");
};

/* =========================================================
   GET INDIA DATE
========================================================= */
const getIndiaDate = async (client) => {
    const result = await client.query(`
        SELECT
            (
                CURRENT_TIMESTAMP
                AT TIME ZONE 'Asia/Kolkata'
            )::DATE AS current_date
    `);

    return result.rows[0].current_date;
};

const generateEmployeePayrollConfigSerialNumber = async client => {
    const financialYearResult = await client.query(
        `
        SELECT year_code
        FROM financial_years
        WHERE is_active = TRUE
          AND is_current = TRUE
        ORDER BY id DESC
        LIMIT 1;
        `
    );
    const yearCode = financialYearResult.rows[0]?.year_code;
    const match = String(yearCode || "").match(/^(\d{4})-(\d{2}|\d{4})$/);

    if (!match) {
        throw new Error(
            "No valid active and current financial year is configured"
        );
    }

    const financialYearSerial = `${match[1].slice(-2)}${match[2].slice(-2)}`;

    await client.query(
        `
        SELECT pg_advisory_xact_lock(
            hashtext('employee_payroll_config_serial'),
            hashtext($1)
        );
        `,
        [financialYearSerial]
    );

    const sequenceResult = await client.query(
        `
        SELECT COALESCE(
            MAX((regexp_match(serial_number, $1))[1]::INTEGER),
            0
        ) AS last_sequence
        FROM employee_payroll_config
        WHERE serial_number ~ $2;
        `,
        [
            `^ECN-${financialYearSerial}-([0-9]+)$`,
            `^ECN-${financialYearSerial}-[0-9]+$`
        ]
    );
    const nextSequence = Number(sequenceResult.rows[0].last_sequence) + 1;

    return `ECN-${financialYearSerial}-${String(nextSequence).padStart(3, "0")}`;
};

/* =========================================================
   GET EMPLOYEE SALARY
========================================================= */
const getEmployeeSalary = async ({
    client,
    username
}) => {
    /* =====================================================
       GET EMPLOYEE
    ===================================================== */
    const employeeResult =
        await client.query(
            `
            SELECT
                pd.id AS personal_details_id
            FROM personal_details pd
            WHERE pd.username = $1
            LIMIT 1;
            `,
            [username]
        );

    if (
        employeeResult.rows.length === 0
    ) {
        throw new Error(`Employee '${username}' not found`);
    }

    const employee = employeeResult.rows[0];

    /* =====================================================
       GET SALARY
    ===================================================== */
    const salaryResult =
        await client.query(
            `
            SELECT
                id,
                current_salary,
                next_increment_date
            FROM salary_details
            WHERE personal_details_id = $1
            ORDER BY id DESC
            LIMIT 1;
            `,
            [
                employee.personal_details_id
            ]
        );

    if (
        salaryResult.rows.length === 0
    ) {
        throw new Error(`Salary details not found for employee '${username}'`);
    }

    if (
        salaryResult.rows[0].current_salary === null ||
        salaryResult.rows[0].current_salary === undefined
    ) {
        throw new Error(`Current salary is not set for employee '${username}'`);
    }

    /* =====================================================
       RETURN SALARY
    ===================================================== */
    const salary = decryptPayrollFields(salaryResult.rows[0], [
        "current_salary"
    ]);

    return {
        id: salary.id,
        username,
        current_salary: salary.current_salary,
        next_increment_date: salary.next_increment_date
    };
};

/* =========================================================
   GET PAYROLL DATE RANGE
========================================================= */
const getPayrollDateRange = async ({
    client,
    payrollMonth,
    payrollYear,
    payrollStartDate,
    payrollEndDate
}) => {
    const result = await client.query(
        `
        SELECT
            GREATEST(
                $1::DATE,
                MAKE_DATE(
                    $2::INTEGER,
                    $3::INTEGER,
                    1
                )
            ) AS start_date,

            LEAST(
                $4::DATE,
                (
                    MAKE_DATE(
                        $2::INTEGER,
                        $3::INTEGER,
                        1
                    )
                    + INTERVAL '1 MONTH'
                    - INTERVAL '1 DAY'
                )::DATE,
                (
                    CURRENT_TIMESTAMP
                    AT TIME ZONE 'Asia/Kolkata'
                )::DATE
            ) AS end_date;
        `,
        [
            payrollStartDate,
            payrollYear,
            payrollMonth,
            payrollEndDate
        ]
    );

    return {
        startDate: result.rows[0].start_date,
        endDate: result.rows[0].end_date
    };
};

/* =========================================================
   GET ATTENDANCE OVERTIME
========================================================== */
const getAttendanceOvertime = async ({
    client,
    username,
    payrollMonth,
    payrollYear,
    payrollStartDate,
    payrollEndDate,
    workingStartTime,
    workingEndTime
}) => {
    /* =====================================================
       PAYROLL DATE RANGE
    ===================================================== */
    const {
        startDate,
        endDate
    } = await getPayrollDateRange({
        client,
        payrollMonth,
        payrollYear,
        payrollStartDate,
        payrollEndDate
    });

    if (
        !startDate ||
        !endDate ||
        startDate > endDate
    ) {
        return {
            actual_working_minutes: 0,
            standard_working_minutes: 0,
            overtime_minutes: 0,
            overtime_hours: 0
        };
    }

    const payrollMinutesResult =
        await client.query(
            `
            WITH employee_shift AS (
                SELECT
                    ed.work_location,
                    epc.working_start_time,
                    epc.working_end_time
                FROM employment_details ed
                INNER JOIN personal_details pd
                    ON pd.id = ed.personal_details_id
                INNER JOIN employee_payroll_config epc
                    ON epc.username = pd.username
                WHERE pd.username = $3
                ORDER BY
                    CASE
                        WHEN epc.payroll_start_date <= $2::DATE
                         AND epc.payroll_end_date >= $1::DATE
                        THEN 0 ELSE 1
                    END,
                    epc.payroll_start_date DESC,
                    epc.id DESC
                LIMIT 1
            ),
            attendance_dates AS (
                SELECT DISTINCT
                    (
                        ats.entry_at
                        AT TIME ZONE 'Asia/Kolkata'
                    )::DATE AS work_date
                FROM attendance_sessions ats
                WHERE LOWER(TRIM(ats.username)) = LOWER(TRIM($3))
                  AND LOWER(ats.status) IN ('completed', 'expired')
                  AND (
                      ats.entry_at
                      AT TIME ZONE 'Asia/Kolkata'
                  )::DATE BETWEEN $1::DATE AND $2::DATE
            ),
            attendance_daily AS (
                SELECT
                    (
                        ats.entry_at
                        AT TIME ZONE 'Asia/Kolkata'
                    )::DATE AS work_date,
                    ROUND(
                        SUM(
                            EXTRACT(
                                EPOCH FROM
                                COALESCE(
                                    ats.duration,
                                    INTERVAL '0 second'
                                )
                            )
                        ) / 60.0
                    )::INTEGER AS actual_working_minutes
                FROM attendance_sessions ats
                WHERE LOWER(TRIM(ats.username)) = LOWER(TRIM($3))
                  AND LOWER(ats.status) IN ('completed', 'expired')
                  AND (
                      ats.entry_at
                      AT TIME ZONE 'Asia/Kolkata'
                  )::DATE BETWEEN $1::DATE AND $2::DATE
                GROUP BY 1
            ),
            holiday_dates AS (
                SELECT DISTINCT
                    COALESCE(
                        h.transfer_date::DATE,
                        h.holiday_date::DATE
                    ) AS work_date
                FROM holidays h
                CROSS JOIN employee_shift es
                WHERE COALESCE(
                    h.transfer_date::DATE,
                    h.holiday_date::DATE
                ) BETWEEN $1::DATE AND $2::DATE
                  AND (
                      h.locations IS NULL
                      OR cardinality(h.locations) = 0
                      OR es.work_location::TEXT = ANY(h.locations)
                  )
            ),
            payroll_dates AS (
                SELECT work_date
                FROM attendance_dates

                UNION

                SELECT work_date
                FROM holiday_dates
            ),
            daily_minutes AS (
                SELECT
                    CASE
                        WHEN hd.work_date IS NOT NULL
                             AND ad.work_date IS NULL
                        THEN GREATEST(
                            FLOOR(
                                EXTRACT(
                                    EPOCH FROM (
                                        $5::TIME - $4::TIME
                                    )
                                ) / 60.0
                            )::INTEGER,
                            0
                        )
                        ELSE COALESCE(
                            ad.actual_working_minutes,
                            0
                        )
                    END AS working_minutes
                FROM payroll_dates pd
                CROSS JOIN employee_shift es
                LEFT JOIN holiday_dates hd
                    ON hd.work_date = pd.work_date
                LEFT JOIN attendance_daily ad
                    ON ad.work_date = pd.work_date
            )
            SELECT
                COALESCE(
                    SUM(working_minutes),
                    0
                )::INTEGER AS actual_working_minutes,
                (
                    SELECT COUNT(*)::INTEGER
                    FROM generate_series(
                        $1::DATE,
                        $2::DATE,
                        INTERVAL '1 day'
                    ) AS calendar(work_date)
                    WHERE EXTRACT(DOW FROM work_date) <> 0
                      AND NOT EXISTS (
                          SELECT 1
                          FROM holidays h
                          WHERE h.transfer_date = work_date::DATE
                      )
                ) *
                GREATEST(
                    FLOOR(
                        EXTRACT(
                            EPOCH FROM (
                                $5::TIME - $4::TIME
                            )
                        ) / 60.0
                    )::INTEGER,
                    0
                ) AS standard_working_minutes
            FROM daily_minutes;
            `,
            [
                startDate,
                endDate,
                username,
                workingStartTime,
                workingEndTime
            ]
        );

    const {
        actual_working_minutes: actualWorkingMinutes,
        standard_working_minutes: standardWorkingMinutes
    } = payrollMinutesResult.rows[0];

    // Positive = overtime; negative = working-time shortage.
    const overtimeMinutes =
        Number(actualWorkingMinutes || 0) -
        Number(standardWorkingMinutes || 0);

    /* =====================================================
       OVERTIME HOURS
    ===================================================== */
    const overtimeHours = Number(
        (overtimeMinutes / 60).toFixed(2)
    );

    return {
        actual_working_minutes: actualWorkingMinutes,
        standard_working_minutes: standardWorkingMinutes,
        overtime_minutes: overtimeMinutes,
        overtime_hours: overtimeHours
    };
};

/* =========================================================
   OVERTIME AMOUNT
========================================================= */
const calculateOvertimeAmount = ({
    overtimeMinutes,
    basicSalary,
    standardWorkingMinutes
}) => {
    if (standardWorkingMinutes <= 0) {
        return 0;
    }

    return Number(
        (
            Number(basicSalary || 0) *
            Number(overtimeMinutes || 0) /
            Number(standardWorkingMinutes)
        ).toFixed(2)
    );
};

/* =========================================================
   GENERATE PAYROLL
========================================================= */
const generatePayroll = async ({
    client,
    config,
    created_by,
    payrollMonth: requestedPayrollMonth,
    payrollYear: requestedPayrollYear,
    payrollCalculation = null
}) => {
    /* =====================================================
       SALARY
    ===================================================== */
    const periodSalary = config.current_salary != null &&
        config.current_salary !== ""
        ? decryptPayrollFields(config, [
            "current_salary"
        ])
        : null;

    const salary = periodSalary
        ? {
            current_salary: periodSalary.current_salary,
            next_increment_date: config.next_increment_date || null
        }
        : await getEmployeeSalary({
            client,
            username: config.username
        });

    const basicSalary = payrollCalculation
        ? Number(payrollCalculation.basicSalary || 0)
        : Number(salary.current_salary);

    const [startDateYear, startDateMonth] = String(
        config.payroll_start_date
    ).slice(0, 10).split("-").map(Number);

    const payrollMonth = requestedPayrollMonth ?? startDateMonth;
    const payrollYear = requestedPayrollYear ?? startDateYear;

    /* =====================================================
       OVERTIME
    ===================================================== */
    const overtime = payrollCalculation
        ? {
            overtime_minutes: Math.round(
                Number(payrollCalculation.overtimeMinutes || 0)
            ),
            overtime_hours: Number(
                Number(payrollCalculation.overtimeHours || 0).toFixed(2)
            ),
            standard_working_minutes: 0
        }
        : await getAttendanceOvertime({
            client,
            username: config.username,
            payrollMonth,
            payrollYear,
            payrollStartDate: config.payroll_start_date,
            payrollEndDate: config.payroll_end_date,
            workingStartTime: config.working_start_time,
            workingEndTime: config.working_end_time
        });

    /* =====================================================
       OVERTIME AMOUNT
    ===================================================== */
    const overtimeAmount = payrollCalculation
        ? Number(Number(payrollCalculation.overtimeAmount || 0).toFixed(2))
        : calculateOvertimeAmount({
            overtimeMinutes: overtime.overtime_minutes,
            basicSalary,
            standardWorkingMinutes: overtime.standard_working_minutes
        });


    /* =========================================================
       REGULAR SALARY + EXTRA DAY SALARY
    ========================================================= */
    const regularSalary = payrollCalculation
        ? Number(Number(payrollCalculation.netSalary || 0).toFixed(2))
        : overtime.standard_working_minutes > 0
            ? Number(
                (
                    basicSalary *
                    Number(overtime.actual_working_minutes || 0) /
                    Number(overtime.standard_working_minutes)
                ).toFixed(2)
            )
            : 0;

    // Calculate one standard working day's minutes.
    const [startHour, startMinute, startSecond = 0] =
        String(config.working_start_time).split(":").map(Number);

    const [endHour, endMinute, endSecond = 0] =
        String(config.working_end_time).split(":").map(Number);

    let shiftMinutes =
        (endHour * 60 + endMinute + endSecond / 60) -
        (startHour * 60 + startMinute + startSecond / 60);

    if (shiftMinutes <= 0) {
        shiftMinutes += 24 * 60;
    }

    const standardWorkingDays =
        shiftMinutes > 0
            ? Number(overtime.standard_working_minutes || 0) / shiftMinutes
            : 0;

    // One day's salary.
    const perDaySalary =
        standardWorkingDays > 0
            ? basicSalary / standardWorkingDays
            : 0;

    // Extra salary based on configured day_type.
    const dayType = String(config.day_type || "")
        .trim()
        .replace(/\s+/g, " ")
        .toLowerCase();

    const extraDaySalary =
        dayType === "full day"
            ? perDaySalary
            : dayType === "half day"
                ? perDaySalary * 0.5
                : 0;

    // Final salary = regular salary + extra day salary.
    const netSalary = Number(
        (regularSalary + extraDaySalary).toFixed(2)
    );

    const payrollId = String(config.id);

    const payrollValues = [
        payrollId,
        config.username,
        payrollMonth,
        payrollYear,
        encryptPayrollAmount(basicSalary),
        salary.next_increment_date,
        overtime.overtime_minutes,
        overtime.overtime_hours,
        overtimeAmount,
        netSalary,
        created_by
    ];

    // Lock payslip numbering for this payroll month/year.
    // This prevents concurrent employees from receiving the same sequence.
    await client.query(
        `
        SELECT pg_advisory_xact_lock(
            hashtext('pay_slip_no'),
            ($1::INTEGER * 100 + $2::INTEGER)
        );
        `,
        [payrollYear, payrollMonth]
    );

    const existingPayrollResult = await client.query(
        `
        SELECT id, pay_slip_no
        FROM payroll
        WHERE LOWER(TRIM(username)) = LOWER(TRIM($1))
          AND payroll_month = $2
          AND payroll_year = $3
        ORDER BY
            CASE
                WHEN LOWER(TRIM(COALESCE(salary_status, ''))) = 'paid'
                    THEN 0
                ELSE 1
            END,
            id DESC
        LIMIT 1
        FOR UPDATE;
        `,
        [config.username, payrollMonth, payrollYear]
    );

    // Preserve an existing payslip number during regeneration.
    let paySlipNo = existingPayrollResult.rows[0]?.pay_slip_no || null;

    // Generate a number only if this payroll record does not have one.
    if (!paySlipNo) {
        const monthCode = String(payrollMonth).padStart(2, "0");
        const yearCode = String(payrollYear).slice(-2);
        const prefix = `EPS-${monthCode}${yearCode}-`;

        const sequenceResult = await client.query(
            `
                SELECT COALESCE(
                    MAX(
                        SUBSTRING(pay_slip_no FROM '([0-9]+)$')::INTEGER
                    ),
                    0
                ) + 1 AS next_sequence
                FROM payroll
                WHERE pay_slip_no LIKE $1;
            `,
            [`${prefix}%`]
        );

        const sequence = Number(
            sequenceResult.rows[0].next_sequence
        );

        paySlipNo = `${prefix}${String(sequence).padStart(3, "0")}`;
    }

    const result = existingPayrollResult.rows.length > 0
        ? await client.query(
            `
                UPDATE payroll
                SET
                    overtime_minutes = $1,
                    overtime_hours = $2,
                    overtime_amount = $3,
                    net_salary = $4,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $5
                RETURNING *;
            `,
            [
                overtime.overtime_minutes,
                overtime.overtime_hours,
                overtimeAmount,
                netSalary,
                existingPayrollResult.rows[0].id
            ]
        )
        : await client.query(
            `
                INSERT INTO payroll (
                    payroll_id,
                    username,
                    payroll_month,
                    payroll_year,
                    basic_salary,
                    next_increment_date,
                    overtime_minutes,
                    overtime_hours,
                    overtime_amount,
                    net_salary,
                    created_by,
                    pay_slip_no,
                    generated,
                    generated_by,
                    generated_at,
                    updated_at
                )
                VALUES (
                    $1, $2, $3, $4, $5, $6,
                    $7, $8, $9, $10, $11, $12,
                    FALSE, NULL, NULL, CURRENT_TIMESTAMP
                )
                RETURNING *;
            `,
            [
                payrollId,
                config.username,
                payrollMonth,
                payrollYear,
                encryptPayrollAmount(basicSalary),
                salary.next_increment_date,
                overtime.overtime_minutes,
                overtime.overtime_hours,
                overtimeAmount,
                netSalary,
                created_by,
                paySlipNo
            ]
        );

    return decryptPayrollFields(result.rows[0], [
        "basic_salary"
    ]);
};

/* =========================================================
   CREATE EMPLOYEE PAYROLL CONFIG
========================================================= */
export const createEmployeePayrollModel = async ({
    username,
    working_start_time,
    working_end_time,
    payroll_start_date,
    payroll_end_date,
    applicable_date = null,
    day_type = "none",
    current_salary,
    next_increment_date = null,
    created_by = "system"
}) => {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        /* =====================================================
           VALIDATE SALARY VALUES
        ===================================================== */
        if (
            current_salary === undefined ||
            current_salary === null ||
            current_salary === "" ||
            !Number.isFinite(Number(current_salary)) ||
            Number(current_salary) < 0
        ) {
            throw new Error("Valid current_salary is required");
        }

        /* =====================================================
           FIND EMPLOYEE
        ===================================================== */
        const employeeResult = await client.query(
            `
            SELECT id, username
            FROM personal_details
            WHERE LOWER(TRIM(username)) = LOWER(TRIM($1))
            LIMIT 1
            FOR UPDATE;
            `,
            [username]
        );

        if (employeeResult.rows.length === 0) {
            throw new Error(`Employee '${username}' not found`);
        }

        const employee = employeeResult.rows[0];
        const employeeUsername = employee.username;
        const personalDetailsId = employee.id;

        /* =====================================================
           FIND SHIFT
        ===================================================== */
        const shiftResult = await client.query(
            `
            SELECT
                ed.shift_id AS id,
                sc.shift_name,
                sc.shift_type,
                sc.start_time,
                sc.end_time
            FROM employment_details ed
            INNER JOIN shift_configurations sc
                ON sc.id = ed.shift_id
            WHERE ed.personal_details_id = $1
            ORDER BY ed.id DESC
            LIMIT 1;
            `,
            [personalDetailsId]
        );

        if (shiftResult.rows.length === 0) {
            throw new Error(`Shift not found in employment details for employee '${employeeUsername}'`);
        }

        const shift = shiftResult.rows[0];

        /* =====================================================
           SAVE SALARY DETAILS
           salary_details always holds the salary of the latest
           payroll period; older periods keep their own salary on
           their employee_payroll_config row.
        ===================================================== */
        const latestPeriodResult = await client.query(
            `
            SELECT TO_CHAR(MAX(payroll_end_date), 'YYYY-MM-DD')
                AS latest_period_end
            FROM employee_payroll_config
            WHERE username = $1;
            `,
            [employeeUsername]
        );
        const latestPeriodEnd = latestPeriodResult.rows[0]?.latest_period_end;
        const isLatestPeriod =
            !latestPeriodEnd ||
            String(payroll_end_date).slice(0, 10) >= latestPeriodEnd;

        const salaryResult = isLatestPeriod
            ? await client.query(
                `
                SELECT id
                FROM salary_details
                WHERE personal_details_id = $1
                ORDER BY id DESC
                LIMIT 1
                FOR UPDATE;
                `,
                [personalDetailsId]
            )
            : { rows: [] };

        let salaryDetails;

        if (!isLatestPeriod) {
            salaryDetails = {
                personal_details_id: personalDetailsId,
                current_salary: Number(current_salary),
                next_increment_date: next_increment_date || null
            };
        } else if (salaryResult.rows.length > 0) {
            const salaryId = salaryResult.rows[0].id;

            const updateSalaryResult = await client.query(
                `
                UPDATE salary_details
                SET
                    current_salary = $1,
                    next_increment_date = $2,
                    updated_at = TIMEZONE(
                        'Asia/Kolkata',
                        CURRENT_TIMESTAMP
                    )
                WHERE id = $3
                RETURNING *;
                `,
                [
                    encryptPayrollAmount(Number(current_salary)),
                    next_increment_date || null,
                    salaryId
                ]
            );

            salaryDetails = decryptPayrollFields(updateSalaryResult.rows[0], [
                "current_salary"
            ]);
        } else {
            const insertSalaryResult = await client.query(
                `
                INSERT INTO salary_details (
                    personal_details_id,
                    current_salary,
                    next_increment_date,
                    created_at,
                    updated_at
                )
                VALUES (
                    $1,
                    $2,
                    $3,
                    TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP),
                    TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
                )
                RETURNING *;
                `,
                [
                    personalDetailsId,
                    encryptPayrollAmount(Number(current_salary)),
                    next_increment_date || null
                ]
            );

            salaryDetails = decryptPayrollFields(insertSalaryResult.rows[0], [
                "current_salary"
            ]);
        }

        /* =====================================================
           DETERMINE CONFIGURATION STATUS
        ===================================================== */
        const statusResult = await client.query(
            `
            SELECT
                CASE
                    WHEN (
                        CURRENT_TIMESTAMP
                        AT TIME ZONE 'Asia/Kolkata'
                    )::DATE BETWEEN $1::DATE AND $2::DATE
                    THEN 'active'
                    ELSE 'pending'
                END AS status;
            `,
            [payroll_start_date, payroll_end_date]
        );

        const status = statusResult.rows[0].status;

        const existingConfigResult = await client.query(
            `
            SELECT *
            FROM employee_payroll_config
            WHERE username = $1
            ORDER BY payroll_start_date DESC, id DESC
            FOR UPDATE;
            `,
            [employeeUsername]
        );
        const existingConfigs = existingConfigResult.rows;

        /* A configuration is unique per payroll period: creating the
           same period again updates that period's row, while a new
           period creates a separate row with its own salary. */
        const samePeriodConfigResult = await client.query(
            `
            SELECT *
            FROM employee_payroll_config
            WHERE username = $1
              AND payroll_start_date = $2::DATE
              AND payroll_end_date = $3::DATE
            LIMIT 1
            FOR UPDATE;
            `,
            [employeeUsername, payroll_start_date, payroll_end_date]
        );
        const targetConfig = samePeriodConfigResult.rows[0] || null;

        /* Contract renewal (a new payroll period) always gets a new
           serial number; updating the same period keeps its serial. */
        const serialNumber = targetConfig
            ? targetConfig.serial_number ||
            await generateEmployeePayrollConfigSerialNumber(client)
            : await generateEmployeePayrollConfigSerialNumber(client);

        /* =====================================================
           SAVE PAYROLL CONFIGURATION (PERIOD-WISE)
        ===================================================== */
        const encryptedCurrentSalary = encryptPayrollAmount(Number(current_salary));

        const configResult = targetConfig
            ? await client.query(
                `
                UPDATE employee_payroll_config
                SET
                    serial_number = COALESCE(serial_number, $1),
                    working_start_time = $2::TIME,
                    working_end_time = $3::TIME,
                    payroll_start_date = $4::DATE,
                    payroll_end_date = $5::DATE,
                    applicable_date = $6::DATE,
                    day_type = $7,
                    status = $8,
                    current_salary = $9,
                    next_increment_date = $10::DATE,
                    updated_by = $11,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $12
                RETURNING *;
                `,
                [
                    serialNumber,
                    working_start_time,
                    working_end_time,
                    payroll_start_date,
                    payroll_end_date,
                    applicable_date || null,
                    day_type,
                    status,
                    encryptedCurrentSalary,
                    next_increment_date || null,
                    created_by,
                    targetConfig.id
                ]
            )
            : await client.query(
                `
                INSERT INTO employee_payroll_config (
                    serial_number,
                    username,
                    working_start_time,
                    working_end_time,
                    payroll_start_date,
                    payroll_end_date,
                    applicable_date,
                    day_type,
                    status,
                    current_salary,
                    next_increment_date,
                    created_by,
                    updated_by
                )
                VALUES (
                    $1, $2, $3::TIME, $4::TIME, $5::DATE, $6::DATE,
                    $7::DATE, $8, $9, $10, $11::DATE, $12, $12
                )
                RETURNING *;
                `,
                [
                    serialNumber,
                    employeeUsername,
                    working_start_time,
                    working_end_time,
                    payroll_start_date,
                    payroll_end_date,
                    applicable_date || null,
                    day_type,
                    status,
                    encryptedCurrentSalary,
                    next_increment_date || null,
                    created_by
                ]
            );

        const config = configResult.rows[0];

        const savedConfigResult = await client.query(
            `
            SELECT
                epc.id,
                epc.serial_number,
                epc.username,
                epc.working_start_time,
                epc.working_end_time,
                TO_CHAR(epc.payroll_start_date, 'YYYY-MM-DD')
                    AS payroll_start_date,
                TO_CHAR(epc.payroll_end_date, 'YYYY-MM-DD')
                    AS payroll_end_date,
                TO_CHAR(epc.applicable_date, 'YYYY-MM-DD')
                    AS applicable_date,
                epc.day_type,
                epc.status,
                epc.created_by,
                epc.updated_by,
                epc.created_at,
                epc.updated_at,
                epc.current_salary,
                TO_CHAR(epc.next_increment_date, 'YYYY-MM-DD')
                    AS next_increment_date
            FROM employee_payroll_config epc
            WHERE epc.id = $1;
            `,
            [config.id]
        );

        if (salaryDetails?.next_increment_date) {
            const incrementDateResult = await client.query(
                `
                SELECT TO_CHAR($1::DATE, 'YYYY-MM-DD') AS next_increment_date;
                `,
                [next_increment_date]
            );
            salaryDetails.next_increment_date =
                incrementDateResult.rows[0]?.next_increment_date || null;
        }

        await client.query("COMMIT");

        return {
            employee_payroll_config: decryptPayrollFields(
                savedConfigResult.rows[0],
                ["current_salary"]
            ),
            salary_details: salaryDetails,
            payroll: null,
            status,
            shift: {
                shift_id: shift.id,
                shift_name: shift.shift_name,
                shift_type: shift.shift_type
            }
        };
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
};

export const generateEmployeePayrollForMonthModel = async ({
    username,
    month,
    year,
    created_by = "system",
    payrollCalculation = null
}) => {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const configResult = await client.query(
            `
            SELECT epc.*
            FROM employee_payroll_config epc
            INNER JOIN personal_details pd
                ON pd.username = epc.username
            WHERE LOWER(TRIM(pd.username)) = LOWER(TRIM($1))
              AND epc.payroll_start_date <= (
                    MAKE_DATE($3::INTEGER, $2::INTEGER, 1)
                    + INTERVAL '1 month'
                    - INTERVAL '1 day'
                  )::DATE
              AND epc.payroll_end_date >=
                  MAKE_DATE($3::INTEGER, $2::INTEGER, 1)
            ORDER BY
                epc.payroll_start_date DESC,
                epc.id DESC
            LIMIT 1
            FOR UPDATE OF epc;
            `,
            [username, month, year]
        );

        if (configResult.rows.length === 0) {
            await client.query("COMMIT");
            return null;
        }

        const config = configResult.rows[0];

        const payroll = await generatePayroll({
            client,
            config,
            created_by: created_by,
            payrollMonth: month,
            payrollYear: year,
            payrollCalculation
        });

        await client.query("COMMIT");
        return payroll;
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
};

/* =========================================================
   GET CONFIG BY USERNAME
========================================================= */
export const getEmployeePayrollConfigByUsernameModel = async (
    username,
    { month = null, year = null } = {}
) => {
    const configurationQuery = `
        SELECT
            epc.id AS payroll_config_id,
            epc.serial_number,
            epc.username,
            ed.shift_id,
            sc.shift_name,
            sc.shift_type,
            epc.working_start_time,
            epc.working_end_time,
            epc.day_type,
            TO_CHAR(epc.payroll_start_date, 'YYYY-MM-DD')
                AS payroll_start_date,
            TO_CHAR(epc.payroll_end_date, 'YYYY-MM-DD')
                AS payroll_end_date,
            TO_CHAR(epc.applicable_date, 'YYYY-MM-DD')
                AS applicable_date,
            EXTRACT(MONTH FROM epc.payroll_start_date)::INTEGER
                AS payroll_month,
            EXTRACT(YEAR FROM epc.payroll_start_date)::INTEGER
                AS payroll_year,
            epc.status AS payroll_status,
            epc.created_by AS payroll_created_by,
            epc.updated_by AS payroll_updated_by,
            epc.created_at AS payroll_created_at,
            epc.updated_at AS payroll_updated_at,
            epc.current_salary,
            TO_CHAR(epc.next_increment_date, 'YYYY-MM-DD')
                AS next_increment_date
        FROM employee_payroll_config epc
        LEFT JOIN LATERAL (
            SELECT ed_inner.shift_id
            FROM employment_details ed_inner
            INNER JOIN personal_details pd_inner
                ON pd_inner.id = ed_inner.personal_details_id
            WHERE LOWER(TRIM(pd_inner.username)) =
                  LOWER(TRIM(epc.username))
            ORDER BY ed_inner.id DESC
            LIMIT 1
        ) ed ON TRUE
        LEFT JOIN shift_configurations sc
            ON sc.id = ed.shift_id
        WHERE LOWER(TRIM(epc.username)) = LOWER(TRIM($1))
          AND (
                $2::INTEGER IS NULL
                OR $3::INTEGER IS NULL
                OR (
                    epc.payroll_start_date <= (
                        MAKE_DATE($3::INTEGER, $2::INTEGER, 1)
                        + INTERVAL '1 month'
                        - INTERVAL '1 day'
                    )::DATE
                    AND epc.payroll_end_date >=
                        MAKE_DATE($3::INTEGER, $2::INTEGER, 1)
                )
          )
        ORDER BY
            epc.payroll_start_date DESC,
            epc.id DESC
        LIMIT 1;
    `;

    const configurationResult = await pool.query(
        configurationQuery,
        [username, month, year]
    );
    const configuration = configurationResult.rows[0]
        ? decryptPayrollFields(configurationResult.rows[0], [
            "current_salary"
        ])
        : null;

    if (!configuration) {
        return null;
    }

    const [salaryResult, payrollResult] = await Promise.all([
        pool.query(
            `
            SELECT
                sd.current_salary,
                TO_CHAR(sd.next_increment_date, 'YYYY-MM-DD')
                    AS next_increment_date
            FROM personal_details pd
            INNER JOIN salary_details sd
                ON sd.personal_details_id = pd.id
            WHERE LOWER(TRIM(pd.username)) = LOWER(TRIM($1))
            ORDER BY sd.id DESC
            LIMIT 1;
            `,
            [username]
        ),
        pool.query(
            `
            SELECT
                p.id AS payroll_record_id,
                p.payroll_id,
                p.pay_slip_no,
                p.username,
                p.payroll_month,
                p.payroll_year,
                p.basic_salary,
                p.next_increment_date,
                p.overtime_minutes,
                p.overtime_hours,
                p.overtime_amount,
                p.net_salary,
                p.created_by,
                p.generated,
                p.generated_by,
                p.generated_at,
                p.salary_status,
                p.paid_by,
                p.paid_at,
                p.approved_by,
                p.approved_at,
                p.created_at,
                p.updated_at
            FROM payroll p
            WHERE LOWER(TRIM(p.username)) = LOWER(TRIM($1))
              AND ($2::INTEGER IS NULL OR p.payroll_month = $2::INTEGER)
              AND ($3::INTEGER IS NULL OR p.payroll_year = $3::INTEGER)
            ORDER BY
                p.payroll_year DESC,
                p.payroll_month DESC,
                p.id DESC;
            `,
            [username, month, year]
        )
    ]);
    const salary = decryptPayrollFields(salaryResult.rows[0] || {}, [
        "current_salary"
    ]);

    return {
        payroll: {
            current_salary:
                configuration.current_salary ?? salary.current_salary ?? null,
            next_increment_date:
                configuration.next_increment_date ??
                salary.next_increment_date ??
                null,
            configuration: [configuration],
            data: decryptPayrollRows(payrollResult.rows, [
                "basic_salary"
            ])
        }
    };
};

/* =========================================================
   GET EMPLOYEE PAYROLL CONFIG BY ID
========================================================= */
export const getEmployeePayrollConfigByIdModel = async (id) => {
    const result = await pool.query(
        `
        SELECT
            epc.id,
            epc.serial_number,
            epc.username,
            ed.shift_id,
            sc.shift_name,
            sc.shift_type,
            epc.working_start_time,
            epc.working_end_time,
            epc.day_type,
            TO_CHAR(epc.payroll_start_date, 'YYYY-MM-DD') AS payroll_start_date,
            TO_CHAR(epc.payroll_end_date, 'YYYY-MM-DD') AS payroll_end_date,
            TO_CHAR(epc.applicable_date, 'YYYY-MM-DD') AS applicable_date,
            EXTRACT(MONTH FROM epc.payroll_start_date)::INTEGER
                AS payroll_month,
            EXTRACT(YEAR FROM epc.payroll_start_date)::INTEGER
                AS payroll_year,
            epc.status,
            epc.created_by,
            epc.updated_by,
            epc.created_at,
            epc.updated_at
        FROM employee_payroll_config epc
        LEFT JOIN LATERAL (
            SELECT ed_inner.shift_id
            FROM employment_details ed_inner
            INNER JOIN personal_details pd_inner
                ON pd_inner.id = ed_inner.personal_details_id
            WHERE LOWER(TRIM(pd_inner.username)) =
                  LOWER(TRIM(epc.username))
            ORDER BY ed_inner.id DESC
            LIMIT 1
        ) ed ON TRUE
        LEFT JOIN shift_configurations sc
            ON sc.id = ed.shift_id
        WHERE epc.id = $1
        LIMIT 1;
        `,
        [id]
    );

    return result.rows[0] || null;
};

/* =========================================================
   GET ALL EMPLOYEE PAYROLL CONFIG
========================================================= */
export const getAllEmployeePayrollConfigModel = async ({
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
    pagination = true
} = {}) => {
    const paginationEnabled = pagination === true;

    const currentPage = Math.max(1, Number(page) || 1);
    const pageLimit = Math.max(1, Number(limit) || 20);
    const offset = (currentPage - 1) * pageLimit;

    const normalizedLocation =
        work_location == null || String(work_location).trim() === ""
            ? null
            : String(work_location).trim();

    const normalizedCategory =
        category == null || String(category).trim() === ""
            ? null
            : String(category).trim();

    const normalizedUsername =
        username == null || String(username).trim() === ""
            ? null
            : String(username).trim();

    const normalizedName =
        name == null || String(name).trim() === ""
            ? null
            : String(name).trim();

    const normalizedPayrollStatus =
        payroll_status == null ||
            String(payroll_status).trim() === ""
            ? null
            : String(payroll_status).trim().toLowerCase();

    const salaryStatusList = (
        Array.isArray(salary_status)
            ? salary_status
            : salary_status == null
                ? []
                : String(salary_status).split(",")
    )
        .map(status => String(status).trim().toLowerCase())
        .filter(Boolean);

    const normalizedSalaryStatus =
        salaryStatusList.length > 0
            ? [...new Set(salaryStatusList)]
            : null;

    const normalizedBasicSalary =
        basic_salary == null || String(basic_salary).trim() === ""
            ? null
            : String(basic_salary).trim().toLowerCase();

    const normalizedShift =
        shift == null || String(shift).trim() === ""
            ? null
            : String(shift).trim();
    const normalizedWorkingStartTime =
        working_start_time == null ||
        String(working_start_time).trim() === ""
            ? null
            : String(working_start_time).trim();
    const normalizedWorkingEndTime =
        working_end_time == null ||
        String(working_end_time).trim() === ""
            ? null
            : String(working_end_time).trim();

    const normalizedMonth =
        month == null || String(month).trim() === ""
            ? null
            : Number(month);

    const normalizedYear =
        year == null || String(year).trim() === ""
            ? null
            : Number(year);

    const normalizedSerialNumber =
        serial_number == null || String(serial_number).trim() === ""
            ? null
            : String(serial_number).trim();

    const today = new Date();
    const selectedMonth = normalizedMonth ?? today.getMonth() + 1;
    const selectedYear = normalizedYear ?? today.getFullYear();

    const employeeFilter = `
        (
            $1::TEXT IS NULL
            OR EXISTS (
                SELECT 1
                FROM employment_details ed_filter
                LEFT JOIN work_location wl_filter
                    ON wl_filter.id = ed_filter.work_location
                WHERE LOWER(TRIM(ed_filter.username)) =
                      LOWER(TRIM(pd.username))
                  AND (
                      ed_filter.work_location::TEXT = $1
                      OR LOWER(TRIM(wl_filter.location)) =
                         LOWER(TRIM($1))
                  )
            )
        )

        AND (
            $2::TEXT IS NULL
            OR EXISTS (
                SELECT 1
                FROM employment_details ed_category
                INNER JOIN category c_filter
                    ON c_filter.id = ed_category.category
                WHERE LOWER(TRIM(ed_category.username)) =
                      LOWER(TRIM(pd.username))
                  AND LOWER(TRIM(c_filter.category_name)) =
                      LOWER(TRIM($2))
            )
        )

        AND (
            $9::TEXT IS NULL
            OR LOWER(COALESCE(pd.username, ''))
                LIKE '%' || LOWER(TRIM($9::TEXT)) || '%'
        )

        AND (
            $3::TEXT IS NULL
            OR LOWER(COALESCE(pd.username, ''))
                LIKE '%' || LOWER($3) || '%'
            OR LOWER(COALESCE(pd.first_name, ''))
                LIKE '%' || LOWER($3) || '%'
            OR LOWER(COALESCE(pd.middle_name, ''))
                LIKE '%' || LOWER($3) || '%'
            OR LOWER(COALESCE(pd.last_name, ''))
                LIKE '%' || LOWER($3) || '%'
            OR LOWER(
                CONCAT_WS(
                    ' ',
                    NULLIF(TRIM(pd.first_name), ''),
                    NULLIF(TRIM(pd.middle_name), ''),
                    NULLIF(TRIM(pd.last_name), '')
                )
            ) LIKE '%' || LOWER($3) || '%'
        )

        AND (
            $4::TEXT IS NULL
            OR (
                EXISTS (
                    SELECT 1
                    FROM employee_payroll_config epc_serial
                    WHERE LOWER(TRIM(epc_serial.username)) =
                          LOWER(TRIM(pd.username))
                      AND POSITION(
                          LOWER(TRIM($4)) IN
                          LOWER(TRIM(epc_serial.serial_number))
                      ) > 0
                )
                OR EXISTS (
                    SELECT 1
                    FROM payroll p_pay_slip
                    WHERE LOWER(TRIM(p_pay_slip.username::TEXT)) =
                          LOWER(TRIM(pd.username))
                      AND p_pay_slip.payroll_month = $6::INTEGER
                      AND p_pay_slip.payroll_year = $7::INTEGER
                      AND POSITION(
                          LOWER(TRIM($4)) IN
                          LOWER(TRIM(p_pay_slip.pay_slip_no))
                      ) > 0
                )
            )
        )

        AND (
            $5::TEXT IS NULL
            OR COALESCE(
                (
                    SELECT
                        CASE
                            WHEN epc_filter.payroll_start_date IS NULL
                              OR epc_filter.payroll_end_date IS NULL
                                THEN 'pending'

                            WHEN MAKE_DATE(
                                $7::INTEGER,
                                $6::INTEGER,
                                1
                            ) > epc_filter.payroll_end_date
                                THEN 'expire'

                            WHEN (
                                MAKE_DATE(
                                    $7::INTEGER,
                                    $6::INTEGER,
                                    1
                                ) + INTERVAL '1 month'
                            )::DATE <= epc_filter.payroll_start_date
                                THEN 'pending'

                            ELSE 'active'
                        END
                    FROM employee_payroll_config epc_filter
                    WHERE LOWER(TRIM(epc_filter.username)) =
                          LOWER(TRIM(pd.username))
                    /* List response ni jem: pehla selected month
                       ma overlap thati config, nahi to latest */
                    ORDER BY
                        CASE
                            WHEN epc_filter.payroll_start_date IS NOT NULL
                             AND epc_filter.payroll_end_date IS NOT NULL
                             AND epc_filter.payroll_start_date <= (
                                    MAKE_DATE(
                                        $7::INTEGER,
                                        $6::INTEGER,
                                        1
                                    )
                                    + INTERVAL '1 month'
                                    - INTERVAL '1 day'
                                )::DATE
                             AND epc_filter.payroll_end_date >=
                                    MAKE_DATE(
                                        $7::INTEGER,
                                        $6::INTEGER,
                                        1
                                    )
                            THEN 0
                            ELSE 1
                        END,
                        epc_filter.payroll_start_date DESC NULLS LAST,
                        epc_filter.id DESC
                    LIMIT 1
                ),
                'pending'
            ) LIKE '%' || LOWER(TRIM($5)) || '%'
        )
        
        AND (
            $8::TEXT[] IS NULL
            OR EXISTS (
                SELECT 1
                FROM payroll p_salary_status
                WHERE LOWER(TRIM(p_salary_status.username::TEXT)) =
                      LOWER(TRIM(pd.username))
                  AND p_salary_status.payroll_month = $6::INTEGER
                  AND p_salary_status.payroll_year = $7::INTEGER
                  AND EXISTS (
                      SELECT 1
                      FROM UNNEST($8::TEXT[]) AS status_filter(value)
                      WHERE POSITION(
                          status_filter.value IN
                          LOWER(TRIM(p_salary_status.salary_status))
                      ) > 0
                  )
            )
        )

        AND (
            $5::TEXT IS NULL
            OR COALESCE(
                (
                    SELECT
                        CASE
                            WHEN epc_filter.payroll_start_date IS NULL
                              OR epc_filter.payroll_end_date IS NULL
                                THEN 'pending'

                            WHEN MAKE_DATE(
                                $7::INTEGER,
                                $6::INTEGER,
                                1
                            ) > epc_filter.payroll_end_date
                                THEN 'expire'

                            WHEN (
                                MAKE_DATE(
                                    $7::INTEGER,
                                    $6::INTEGER,
                                    1
                                ) + INTERVAL '1 month'
                            )::DATE <= epc_filter.payroll_start_date
                                THEN 'pending'

                            ELSE 'active'
                        END
                    FROM employee_payroll_config epc_filter
                    WHERE LOWER(TRIM(epc_filter.username)) =
                          LOWER(TRIM(pd.username))

                    ORDER BY
                        CASE
                            WHEN epc_filter.payroll_start_date IS NOT NULL
                             AND epc_filter.payroll_end_date IS NOT NULL
                             AND epc_filter.payroll_start_date <= (
                                    MAKE_DATE(
                                        $7::INTEGER,
                                        $6::INTEGER,
                                        1
                                    )
                                    + INTERVAL '1 month'
                                    - INTERVAL '1 day'
                                )::DATE
                             AND epc_filter.payroll_end_date >=
                                    MAKE_DATE(
                                        $7::INTEGER,
                                        $6::INTEGER,
                                        1
                                    )
                            THEN 0
                            ELSE 1
                        END,
                        epc_filter.payroll_start_date DESC NULLS LAST,
                        epc_filter.id DESC
                    LIMIT 1
                ),
                'pending'
            ) LIKE '%' || LOWER(TRIM($5)) || '%'
        )

        AND (
            $10::TEXT[] IS NULL
            OR LOWER(TRIM(pd.username)) = ANY($10::TEXT[])
        )

        AND (
            ($11::TEXT IS NULL AND $12::TEXT IS NULL AND $13::TEXT IS NULL)
            OR EXISTS (
                SELECT 1
                FROM employee_payroll_config epc_shift
                LEFT JOIN LATERAL (
                    SELECT ed_inner.shift_id
                    FROM employment_details ed_inner
                    INNER JOIN personal_details pd_inner
                        ON pd_inner.id = ed_inner.personal_details_id
                    WHERE LOWER(TRIM(pd_inner.username)) =
                          LOWER(TRIM(epc_shift.username))
                    ORDER BY ed_inner.id DESC
                    LIMIT 1
                ) ed_shift ON TRUE
                LEFT JOIN shift_configurations sc_shift
                    ON sc_shift.id = ed_shift.shift_id
                WHERE LOWER(TRIM(epc_shift.username)) =
                      LOWER(TRIM(pd.username))
                  AND epc_shift.id = (
                      SELECT epc_selected.id
                      FROM employee_payroll_config epc_selected
                      WHERE LOWER(TRIM(epc_selected.username)) =
                            LOWER(TRIM(pd.username))
                      ORDER BY
                          CASE
                              WHEN epc_selected.payroll_start_date IS NOT NULL
                               AND epc_selected.payroll_end_date IS NOT NULL
                               AND epc_selected.payroll_start_date <= (
                                      MAKE_DATE($7::INTEGER, $6::INTEGER, 1)
                                      + INTERVAL '1 month'
                                      - INTERVAL '1 day'
                                  )::DATE
                               AND epc_selected.payroll_end_date >=
                                      MAKE_DATE($7::INTEGER, $6::INTEGER, 1)
                              THEN 0
                              ELSE 1
                          END,
                          epc_selected.payroll_start_date DESC NULLS LAST,
                          epc_selected.id DESC
                      LIMIT 1
                  )
                  AND (
                      $11::TEXT IS NULL
                      OR POSITION(
                          LOWER(TRIM($11)) IN
                          LOWER(TRIM(sc_shift.shift_name))
                      ) > 0
                      OR POSITION(
                          LOWER(TRIM($11)) IN
                          LOWER(TRIM(sc_shift.shift_type))
                      ) > 0
                  )
                  AND (
                      $12::TEXT IS NULL
                      OR POSITION(
                          LOWER(TRIM($12)) IN
                          LOWER(epc_shift.working_start_time::TEXT)
                      ) > 0
                  )
                  AND (
                      $13::TEXT IS NULL
                      OR POSITION(
                          LOWER(TRIM($13)) IN
                          LOWER(epc_shift.working_end_time::TEXT)
                      ) > 0
                  )
            )
        )
    `;

    let basicSalaryUsernames = null;
    if (normalizedBasicSalary !== null) {
        const matchingPayrollResult = await pool.query(
            `
            SELECT username, basic_salary
            FROM payroll
            WHERE payroll_month = $1::INTEGER
              AND payroll_year = $2::INTEGER;
            `,
            [selectedMonth, selectedYear]
        );
        const matchingPayrollRows = decryptPayrollRows(
            matchingPayrollResult.rows,
            ["basic_salary"]
        );
        basicSalaryUsernames = [
            ...new Set(
                matchingPayrollRows
                    .filter(row =>
                        row.username &&
                        row.basic_salary !== null &&
                        row.basic_salary !== undefined &&
                        row.basic_salary !== "" &&
                        Number.isFinite(Number(row.basic_salary)) &&
                        Number(row.basic_salary)
                            .toFixed(2)
                            .includes(normalizedBasicSalary)
                    )
                    .map(row =>
                        String(row.username).trim().toLowerCase()
                    )
                    .filter(Boolean)
            )
        ];
    }

    const baseParams = [
        normalizedLocation,
        normalizedCategory,
        normalizedName,
        normalizedSerialNumber,
        normalizedPayrollStatus,
        selectedMonth,
        selectedYear,
        normalizedSalaryStatus,
        normalizedUsername,
        basicSalaryUsernames,
        normalizedShift,
        normalizedWorkingStartTime,
        normalizedWorkingEndTime
    ];

    const summaryQuery = `
        SELECT COUNT(
            DISTINCT LOWER(TRIM(pd.username))
        )::INTEGER AS total_people
        FROM personal_details pd
        INNER JOIN master_employee me
            ON LOWER(TRIM(me.username)) =
               LOWER(TRIM(pd.username))
        WHERE LOWER(TRIM(me.status::TEXT)) = 'active'
          AND ${employeeFilter};
    `;

    const summaryResult = await pool.query(
        summaryQuery,
        baseParams
    );

    const totalPeople = Number(
        summaryResult.rows[0]?.total_people || 0
    );

    const employeeQuery = `
        SELECT
            pd.id,
            pd.first_name,
            pd.middle_name,
            pd.last_name,

            CONCAT_WS(
                ' ',
                NULLIF(TRIM(pd.first_name), ''),
                NULLIF(TRIM(pd.middle_name), ''),
                NULLIF(TRIM(pd.last_name), '')
            ) AS full_name,

            pd.username,
            pd.mobile_number,
            pd.image,

            ed.employment_id AS employment_id,
            wl.location AS work_location,

            ed.category AS category_id,
            c.category_name AS category,

            pd.created_at,
            pd.updated_at,
            me.status AS status

        FROM personal_details pd

        INNER JOIN master_employee me
            ON LOWER(TRIM(me.username)) =
               LOWER(TRIM(pd.username))

        LEFT JOIN LATERAL (
            SELECT
                ed_inner.id,
                ed_inner.employment_id,
                ed_inner.work_location,
                ed_inner.category
            FROM employment_details ed_inner
            WHERE LOWER(TRIM(ed_inner.username)) =
                  LOWER(TRIM(pd.username))
            ORDER BY ed_inner.id DESC
            LIMIT 1
        ) ed ON TRUE

        LEFT JOIN work_location wl
            ON wl.id = ed.work_location

        LEFT JOIN category c
            ON c.id = ed.category

        WHERE LOWER(TRIM(me.status::TEXT)) = 'active'
          AND ${employeeFilter}

        ORDER BY
            CASE
                WHEN NULLIF(TRIM(ed.employment_id), '') IS NULL THEN 1
                ELSE 0
            END ASC,
            UPPER(TRIM(ed.employment_id)) ASC,
            pd.id ASC
        ${paginationEnabled ? "LIMIT $14::BIGINT OFFSET $15::BIGINT" : ""};
    `;

    const employeeParams = paginationEnabled
        ? [...baseParams, pageLimit, offset]
        : baseParams;

    const employeeResult = await pool.query(
        employeeQuery,
        employeeParams
    );

    const employees = employeeResult.rows;
    const salaryMap = new Map();
    const configurationMap = new Map();
    const monthlyPayrollMap = new Map();

    if (employees.length > 0) {
        const usernames = employees
            .map(employee => employee.username)
            .filter(Boolean);

        const salaryQuery = `
            SELECT DISTINCT ON (LOWER(TRIM(pd.username)))
                LOWER(TRIM(pd.username)) AS username,
                sd.current_salary,
                TO_CHAR(
                    sd.next_increment_date,
                    'YYYY-MM-DD'
                ) AS next_increment_date
            FROM personal_details pd
            INNER JOIN salary_details sd
                ON sd.personal_details_id = pd.id
            WHERE LOWER(TRIM(pd.username)) = ANY (
                SELECT LOWER(TRIM(u.username))
                FROM UNNEST($1::TEXT[]) AS u(username)
            )
            ORDER BY
                LOWER(TRIM(pd.username)),
                sd.id DESC;
        `;

        const salaryResult = await pool.query(
            salaryQuery,
            [usernames]
        );

        for (const salary of salaryResult.rows) {
            salaryMap.set(
                salary.username,
                decryptPayrollFields(salary, [
                    "current_salary"
                ])
            );
        }

        const configurationQuery = `
            SELECT
                epc.id AS payroll_config_id,
                epc.serial_number,
                epc.username,
                ed.shift_id,
                sc.shift_name,
                sc.shift_type,
                epc.working_start_time,
                epc.working_end_time,
                epc.day_type,

                TO_CHAR(
                    epc.payroll_start_date,
                    'YYYY-MM-DD'
                ) AS payroll_start_date,

                TO_CHAR(
                    epc.payroll_end_date,
                    'YYYY-MM-DD'
                ) AS payroll_end_date,

                TO_CHAR(
                    epc.applicable_date,
                    'YYYY-MM-DD'
                ) AS applicable_date,

                EXTRACT(
                    MONTH FROM epc.payroll_start_date
                )::INTEGER AS payroll_month,

                EXTRACT(
                    YEAR FROM epc.payroll_start_date
                )::INTEGER AS payroll_year,

                epc.status AS payroll_status,
                epc.created_by AS payroll_created_by,
                epc.updated_by AS payroll_updated_by,
                epc.created_at AS payroll_created_at,
                epc.updated_at AS payroll_updated_at,
                epc.current_salary,
                TO_CHAR(epc.next_increment_date, 'YYYY-MM-DD')
                    AS next_increment_date

            FROM employee_payroll_config epc
            LEFT JOIN LATERAL (
                SELECT ed_inner.shift_id
                FROM employment_details ed_inner
                INNER JOIN personal_details pd_inner
                    ON pd_inner.id = ed_inner.personal_details_id
                WHERE LOWER(TRIM(pd_inner.username)) =
                      LOWER(TRIM(epc.username))
                ORDER BY ed_inner.id DESC
                LIMIT 1
            ) ed ON TRUE
            LEFT JOIN shift_configurations sc
                ON sc.id = ed.shift_id

            WHERE LOWER(TRIM(epc.username)) = ANY (
                SELECT LOWER(TRIM(u.username))
                FROM UNNEST($1::TEXT[]) AS u(username)
            )

            ORDER BY
                epc.payroll_start_date DESC NULLS LAST,
                epc.id DESC;
        `;

        const configurationResult = await pool.query(
            configurationQuery,
            [usernames]
        );

        for (const rawConfig of configurationResult.rows) {
            const config = decryptPayrollFields(rawConfig, [
                "current_salary"
            ]);
            const key = String(config.username || "")
                .trim()
                .toLowerCase();

            if (!configurationMap.has(key)) {
                configurationMap.set(key, []);
            }

            configurationMap.get(key).push(config);
        }

        const monthlyPayrollQuery = `
            SELECT
                p.id AS payroll_record_id,
                p.payroll_id,
                p.pay_slip_no,
                p.username,
                p.payroll_month,
                p.payroll_year,
                p.basic_salary,
                p.next_increment_date,
                p.overtime_minutes,
                p.overtime_hours,
                p.overtime_amount,
                p.net_salary,
                p.created_by,
                p.generated,
                p.generated_by,
                p.generated_at,
                p.salary_status,
                p.paid_by,
                p.paid_at,
                p.approved_by,
                p.approved_at,
                p.created_at,
                p.updated_at

            FROM payroll p

            WHERE LOWER(TRIM(p.username)) = ANY (
                SELECT LOWER(TRIM(u.username))
                FROM UNNEST($1::TEXT[]) AS u(username)
            )
              AND (
                  $2::INTEGER IS NULL
                  OR p.payroll_month = $2::INTEGER
              )
              AND (
                  $3::INTEGER IS NULL
                  OR p.payroll_year = $3::INTEGER
              )

            ORDER BY
                p.payroll_year DESC,
                p.payroll_month DESC,
                p.id DESC;
        `;

        const monthlyPayrollResult = await pool.query(
            monthlyPayrollQuery,
            [
                usernames,
                normalizedMonth,
                normalizedYear
            ]
        );

        for (const record of decryptPayrollRows(
            monthlyPayrollResult.rows,
            ["basic_salary"]
        )) {
            const key = String(record.username || "")
                .trim()
                .toLowerCase();

            if (!monthlyPayrollMap.has(key)) {
                monthlyPayrollMap.set(key, []);
            }
            monthlyPayrollMap.get(key).push(record);
        }
    }

    const updatedEmployees = employees.map(employee => {
        const key = String(employee.username || "")
            .trim()
            .toLowerCase();

        const salaryDetails = salaryMap.get(key) || {};
        const configurations = configurationMap.get(key) || [];
        const monthlyRecords = monthlyPayrollMap.get(key) || [];

        /* Pick the configuration whose payroll period covers the
           selected month, so each period shows its own salary. */
        const selectedMonthFirst = `${selectedYear}-${String(selectedMonth).padStart(2, "0")}-01`;
        const selectedMonthLast = new Date(
            Date.UTC(selectedYear, selectedMonth, 0)
        ).toISOString().slice(0, 10);

        const periodConfig = configurations.find(config =>
            config.payroll_start_date &&
            config.payroll_end_date &&
            config.payroll_start_date <= selectedMonthLast &&
            config.payroll_end_date >= selectedMonthFirst
        ) || null;

        const config = periodConfig || configurations[0] || null;

        /* Salary is shown only when the selected month falls inside
           a payroll period. Before the period starts (pending) and
           after it ends (expire) the salary must not be shown. */
        const effectiveSalary = periodConfig
            ? {
                current_salary:
                    periodConfig.current_salary ??
                    salaryDetails.current_salary ??
                    null,
                next_increment_date:
                    periodConfig.next_increment_date ??
                    salaryDetails.next_increment_date ??
                    null
            }
            : {
                current_salary: null,
                next_increment_date: null
            };

        const emptyConfiguration = status => [{
            payroll_config_id: null,
            serial_number: null,
            username: employee.username,
            shift_id: null,
            shift_name: null,
            shift_type: null,
            working_start_time: null,
            working_end_time: null,
            payroll_start_date: null,
            payroll_end_date: null,
            payroll_month: null,
            payroll_year: null,
            payroll_status: status,
            payroll_created_by: null,
            payroll_updated_by: null,
            payroll_created_at: null,
            payroll_updated_at: null,
            current_salary: null,
            next_increment_date: null
        }];

        let selectedPayrollStatus = "pending";

        if (
            config &&
            config.payroll_start_date &&
            config.payroll_end_date
        ) {
            const selectedMonthStart = new Date(
                Date.UTC(selectedYear, selectedMonth - 1, 1)
            );

            const nextMonthStart = new Date(
                Date.UTC(selectedYear, selectedMonth, 1)
            );

            const startDate = new Date(
                `${config.payroll_start_date}T00:00:00Z`
            );

            const endDate = new Date(
                `${config.payroll_end_date}T00:00:00Z`
            );

            if (selectedMonthStart > endDate) {
                selectedPayrollStatus = "expire";
            } else if (nextMonthStart <= startDate) {
                selectedPayrollStatus = "pending";
            } else {
                selectedPayrollStatus = "active";
            }
        }

        let configurationData;

        if (
            selectedPayrollStatus === "pending" ||
            selectedPayrollStatus === "expire"
        ) {
            configurationData = emptyConfiguration(
                selectedPayrollStatus
            );
        } else {
            configurationData = [{
                payroll_config_id: config.payroll_config_id,
                serial_number: config.serial_number,
                username: employee.username,
                shift_id: config.shift_id,
                shift_name: config.shift_name,
                shift_type: config.shift_type,
                working_start_time: config.working_start_time,
                working_end_time: config.working_end_time,
                day_type: config.day_type,
                payroll_start_date: config.payroll_start_date,
                payroll_end_date: config.payroll_end_date,
                payroll_month: config.payroll_month,
                payroll_year: config.payroll_year,
                payroll_status: selectedPayrollStatus,
                payroll_created_by: config.payroll_created_by,
                payroll_updated_by: config.payroll_updated_by,
                payroll_created_at: config.payroll_created_at,
                payroll_updated_at: config.payroll_updated_at,
                current_salary: config.current_salary ?? null,
                next_increment_date: config.next_increment_date ?? null
            }];
        }

        return {
            ...employee,
            payroll: {
                current_salary: effectiveSalary.current_salary ?? null,
                next_increment_date: effectiveSalary.next_increment_date ?? null,
                configuration: configurationData,

                data: monthlyRecords.map(record => ({
                    payroll_record_id: record.payroll_record_id,
                    payroll_id: record.payroll_id,
                    pay_slip_no: record.pay_slip_no,
                    username: employee.username,
                    payroll_month: record.payroll_month,
                    payroll_year: record.payroll_year,
                    basic_salary: record.basic_salary,
                    next_increment_date: record.next_increment_date,
                    overtime_minutes: record.overtime_minutes,
                    overtime_hours: record.overtime_hours,
                    overtime_amount: record.overtime_amount,
                    net_salary: record.net_salary,
                    created_by: record.created_by,
                    generated: Boolean(record.generated),
                    generated_by: record.generated_by,
                    generated_at: record.generated_at,
                    salary_status: record.salary_status,
                    paid_by: record.paid_by,
                    paid_at: record.paid_at,
                    approved_by: record.approved_by,
                    approved_at: record.approved_at,
                    created_at: record.created_at,
                    updated_at: record.updated_at
                }))
            }
        };
    });

    return {
        employees: updatedEmployees,
        totalEmployees: totalPeople,
        pagination: paginationEnabled
            ? {
                enabled: true,
                total: totalPeople,
                page: currentPage,
                limit: pageLimit,
                totalPages: Math.ceil(totalPeople / pageLimit)
            }
            : {
                enabled: false
            }
    };
};

/* =========================================================
   UPDATE EMPLOYEE PAYROLL CONFIG
========================================================= */
const saveEmployeeSalaryDetails = async (client, salaryData) => {
    const employeeResult = await client.query(
        `
        SELECT id, username
        FROM personal_details
        WHERE LOWER(TRIM(username)) = LOWER(TRIM($1))
        LIMIT 1
        FOR UPDATE;
        `,
        [salaryData.username]
    );

    if (employeeResult.rows.length === 0) {
        throw new Error(`Employee '${salaryData.username}' not found`);
    }

    const employee = employeeResult.rows[0];
    const personalDetailsId = employee.id;
    const salaryResult = await client.query(
        `
        SELECT id
        FROM salary_details
        WHERE personal_details_id = $1
        ORDER BY id DESC
        LIMIT 1
        FOR UPDATE;
        `,
        [personalDetailsId]
    );
    let salaryDetails;

    if (salaryResult.rows.length > 0) {
        const updateResult = await client.query(
            `
            UPDATE salary_details
            SET
                next_increment_date = $1,
                updated_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
            WHERE id = $2
            RETURNING *;
            `,
            [
                salaryData.next_increment_date,
                salaryResult.rows[0].id
            ]
        );
        salaryDetails = decryptPayrollFields(updateResult.rows[0], [
            "current_salary"
        ]);
    } else {
        throw new Error("Salary details not found");
    }

    await client.query(
        `
        UPDATE payroll
        SET
            next_increment_date = $1,
            updated_at = CURRENT_TIMESTAMP
        WHERE LOWER(TRIM(username)) = LOWER(TRIM($2));
        `,
        [
            salaryDetails.next_increment_date,
            employee.username
        ]
    );

    return salaryDetails;
};

export const updateEmployeePayrollConfigModel = async (
    id,
    {
        working_start_time,
        working_end_time,
        payroll_start_date,
        payroll_end_date,
        applicable_date = null,
        has_applicable_date = false,
        day_type,
        requested_day_type = null,
        has_day_type = false,
        requested_current_salary = null,
        has_current_salary = false,
        updated_by,
        salaryDetails: salaryData = null
    }
) => {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const configResult = await client.query(
            `
            SELECT *
            FROM employee_payroll_config
            WHERE id = $1
            FOR UPDATE;
            `,
            [id]
        );

        if (configResult.rows.length === 0) {
            await client.query("ROLLBACK");
            return null;
        }

        if (
            salaryData &&
            String(configResult.rows[0].username).trim().toLowerCase() !==
            String(salaryData.username).trim().toLowerCase()
        ) {
            throw new Error("Payload username does not match the payroll configuration employee");
        }

        const shiftResult = await client.query(
            `
            SELECT
                ed.shift_id AS id,
                sc.shift_name,
                sc.shift_type
            FROM employment_details ed
            INNER JOIN personal_details pd
                ON pd.id = ed.personal_details_id
            INNER JOIN shift_configurations sc
                ON sc.id = ed.shift_id
            WHERE LOWER(TRIM(pd.username)) =
                  LOWER(TRIM($1))
            ORDER BY ed.id DESC
            LIMIT 1;
            `,
            [configResult.rows[0].username]
        );

        if (shiftResult.rows.length === 0) {
            throw new Error(`Shift not found in employment details for employee '${configResult.rows[0].username}'`);
        }

        const statusResult = await client.query(
            `
            SELECT
                CASE
                    WHEN
                        (
                            CURRENT_TIMESTAMP
                            AT TIME ZONE 'Asia/Kolkata'
                        )::DATE BETWEEN $1::DATE AND $2::DATE
                    THEN 'active'
                    ELSE 'pending'
                END AS status;
            `,
            [payroll_start_date, payroll_end_date]
        );

        const status = statusResult.rows[0].status;
        const existingConfig = configResult.rows[0];

        const oldSnapshotResult = await client.query(
            `
            SELECT
                epc.username,
                sc.shift_name,
                sc.shift_type,
                epc.working_start_time::TEXT AS working_start_time,
                epc.working_end_time::TEXT AS working_end_time,
                TO_CHAR(epc.payroll_start_date, 'YYYY-MM-DD')
                    AS payroll_start_date,
                TO_CHAR(epc.payroll_end_date, 'YYYY-MM-DD')
                    AS payroll_end_date,
                TO_CHAR(epc.applicable_date, 'YYYY-MM-DD')
                    AS applicable_date,
                epc.current_salary,
                epc.day_type,
                epc.status
            FROM employee_payroll_config epc
            LEFT JOIN LATERAL (
                SELECT ed_inner.shift_id
                FROM employment_details ed_inner
                INNER JOIN personal_details pd_inner
                    ON pd_inner.id = ed_inner.personal_details_id
                WHERE LOWER(TRIM(pd_inner.username)) =
                      LOWER(TRIM(epc.username))
                ORDER BY ed_inner.id DESC
                LIMIT 1
            ) ed ON TRUE
            LEFT JOIN shift_configurations sc
                ON sc.id = ed.shift_id
            WHERE epc.id = $1;
            `,
            [id]
        );
        const oldSnapshot = decryptPayrollFields(
            oldSnapshotResult.rows[0] || {},
            ["current_salary"]
        );

        const oldSalaryResult = (salaryData || has_current_salary)
            ? await client.query(
                `
                SELECT
                    sd.id,
                    sd.current_salary,
                    TO_CHAR(sd.next_increment_date, 'YYYY-MM-DD')
                        AS next_increment_date
                FROM personal_details pd
                INNER JOIN salary_details sd
                    ON sd.personal_details_id = pd.id
                WHERE LOWER(TRIM(pd.username)) = LOWER(TRIM($1))
                ORDER BY sd.id DESC
                LIMIT 1;
                `,
                [existingConfig.username]
            )
            : { rows: [] };
        const oldSalary = decryptPayrollFields(
            oldSalaryResult.rows[0] || {},
            ["current_salary"]
        );

        const generatedPayrollResult = (has_day_type || has_current_salary)
            ? await client.query(
                `
                SELECT EXISTS (
                    SELECT 1
                    FROM payroll
                    WHERE TRIM(payroll_id::TEXT) = TRIM($1::TEXT)
                      AND generated = TRUE
                ) AS generated;
                `,
                [String(id)]
            )
            : { rows: [{ generated: false }] };

        const hasGeneratedPayroll = generatedPayrollResult.rows[0].generated;

        if (has_day_type) {
            const normalizeDayType = (value) => String(value ?? "")
                .trim()
                .replace(/\s+/g, " ")
                .toLowerCase();

            if (
                hasGeneratedPayroll &&
                normalizeDayType(requested_day_type) !==
                normalizeDayType(existingConfig.day_type)
            ) {
                const error = new Error("day_type cannot be changed after payroll has been generated");
                error.statusCode = 409;
                throw error;
            }
        }

        if (has_current_salary) {
            /* Period salary config row is authoritative; salary_details
               is only a fallback for older configs. */
            const decryptedConfigSalary = decryptPayrollFields(
                { current_salary: existingConfig.current_salary },
                ["current_salary"]
            ).current_salary;

            const existingSalarySource =
                decryptedConfigSalary !== null &&
                    decryptedConfigSalary !== undefined &&
                    String(decryptedConfigSalary).trim() !== ""
                    ? decryptedConfigSalary
                    : oldSalary.current_salary;

            const existingSalary = Number(existingSalarySource);
            const requestedSalary = Number(requested_current_salary);

            const salaryChanged =
                !Number.isFinite(existingSalary) ||
                !Number.isFinite(requestedSalary) ||
                Math.abs(existingSalary - requestedSalary) > 0.005;

            if (hasGeneratedPayroll && salaryChanged) {
                const error = new Error("current_salary cannot be changed after payroll has been generated");
                error.statusCode = 409;
                throw error;
            }
        }

        /* Contract renewal (payroll period changed) gets a new
           serial number; other updates keep the existing serial. */
        const toDateString = (value) => {
            if (value instanceof Date && !Number.isNaN(value.getTime())) {
                const year = value.getFullYear();
                const month = String(value.getMonth() + 1).padStart(2, "0");
                const day = String(value.getDate()).padStart(2, "0");
                return `${year}-${month}-${day}`;
            }
            return String(value || "").slice(0, 10);
        };

        const periodChanged =
            toDateString(existingConfig.payroll_start_date) !==
            toDateString(payroll_start_date) ||
            toDateString(existingConfig.payroll_end_date) !==
            toDateString(payroll_end_date);

        const renewedSerialNumber = periodChanged
            ? await generateEmployeePayrollConfigSerialNumber(client)
            : null;

        const updateResult = await client.query(
            `
            UPDATE employee_payroll_config
            SET
                serial_number = COALESCE($9, serial_number),
                working_start_time = $1::TIME,
                working_end_time = $2::TIME,
                payroll_start_date = $3::DATE,
                payroll_end_date = $4::DATE,
                applicable_date = CASE
                    WHEN $10::BOOLEAN THEN $5::DATE
                    ELSE applicable_date
                END,
                day_type = COALESCE($6, day_type),
                status = $7,
                updated_by = $8,
                updated_at = CURRENT_TIMESTAMP,
                current_salary = CASE
                    WHEN $12::BOOLEAN THEN $13
                    ELSE current_salary
                END
            WHERE id = $11
            RETURNING *;
            `,
            [
                working_start_time,
                working_end_time,
                payroll_start_date,
                payroll_end_date,
                applicable_date,
                day_type,
                status,
                updated_by,
                renewedSerialNumber,
                has_applicable_date,
                id,
                has_current_salary && !hasGeneratedPayroll,
                has_current_salary && !hasGeneratedPayroll
                    ? encryptPayrollAmount(Number(requested_current_salary))
                    : null
            ]
        );

        const salaryDetails = salaryData
            ? await saveEmployeeSalaryDetails(client, salaryData)
            : null;

        /* Keep this period's salary details on the config row. */
        if (salaryDetails) {
            await client.query(
                `
                UPDATE employee_payroll_config
                SET
                    next_increment_date = $2
                WHERE id = $1;
                `,
                [
                    id,
                    salaryDetails.next_increment_date || null
                ]
            );
        }

        const finalResult = await client.query(
            `
            SELECT
                epc.id,
                epc.serial_number,
                epc.username,
                ed.shift_id,
                sc.shift_name,
                sc.shift_type,
                epc.working_start_time,
                epc.working_end_time,
                epc.day_type,
                epc.current_salary,
                TO_CHAR(
                    epc.payroll_start_date,
                    'YYYY-MM-DD'
                ) AS payroll_start_date,
                TO_CHAR(
                    epc.payroll_end_date,
                    'YYYY-MM-DD'
                ) AS payroll_end_date,
                TO_CHAR(
                    epc.applicable_date,
                    'YYYY-MM-DD'
                ) AS applicable_date,
                EXTRACT(MONTH FROM epc.payroll_start_date)::INTEGER
                    AS payroll_month,
                EXTRACT(YEAR FROM epc.payroll_start_date)::INTEGER
                    AS payroll_year,
                epc.status,
                epc.created_by,
                epc.updated_by,
                epc.created_at,
                epc.updated_at
            FROM employee_payroll_config epc
            LEFT JOIN LATERAL (
                SELECT ed_inner.shift_id
                FROM employment_details ed_inner
                INNER JOIN personal_details pd_inner
                    ON pd_inner.id = ed_inner.personal_details_id
                WHERE LOWER(TRIM(pd_inner.username)) =
                      LOWER(TRIM(epc.username))
                ORDER BY ed_inner.id DESC
                LIMIT 1
            ) ed ON TRUE
            LEFT JOIN shift_configurations sc
                ON sc.id = ed.shift_id
            WHERE epc.id = $1;
            `,
            [id]
        );

        const updatedConfig = decryptPayrollFields(
            finalResult.rows[0],
            ["current_salary"]
        );
        const normalizeLogValue = (value) => {
            if (value === null || value === undefined) return null;
            if (value instanceof Date && !Number.isNaN(value.getTime())) {
                const year = value.getFullYear();
                const month = String(value.getMonth() + 1).padStart(2, "0");
                const day = String(value.getDate()).padStart(2, "0");
                return `${year}-${month}-${day}`;
            }
            const text = String(value).trim();
            return text === "" ? null : text;
        };
        const changedFields = [
            "working_start_time",
            "working_end_time",
            "payroll_start_date",
            "payroll_end_date",
            "applicable_date",
            "current_salary",
            "day_type",
            "status"
        ];

        for (const field of changedFields) {
            const oldValue = normalizeLogValue(oldSnapshot[field]);
            const newValue = normalizeLogValue(updatedConfig[field]);
            if (oldValue === newValue) continue;

            await addPayrollEditLogModel(client, {
                table_name: "employee_payroll_config",
                record_id: Number(id),
                username: updatedConfig.username,
                edited_by: updated_by,
                field_name: field,
                old_value: oldValue,
                new_value: newValue
            });
        }

        if (salaryDetails) {
            for (const field of [
                "current_salary",
                "next_increment_date"
            ]) {
                const oldValue = normalizeLogValue(oldSalary[field]);
                const newValue = normalizeLogValue(salaryDetails[field]);
                if (oldValue === newValue) continue;

                await addPayrollEditLogModel(client, {
                    table_name: "salary_details",
                    record_id: Number(salaryDetails.id || oldSalary.id),
                    username: updatedConfig.username,
                    edited_by: updated_by,
                    field_name: field,
                    old_value: oldValue,
                    new_value: newValue
                });
            }
        }

        await client.query("COMMIT");

        return {
            ...finalResult.rows[0],
            status,
            ...(salaryDetails ? { salary_details: salaryDetails } : {})
        };
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
};

/* =========================================================
   DELETE CONFIG
========================================================= */
export const deleteEmployeePayrollConfigModel = async (id) => {
    const client = await pool.connect();

    try {
        await client.query(
            "BEGIN"
        );

        const configResult =
            await client.query(
                `
                    SELECT *
                    FROM employee_payroll_config
                    WHERE id = $1
                    FOR UPDATE;
                    `,
                [id]
            );

        if (
            configResult.rows.length === 0
        ) {
            await client.query("ROLLBACK");
            return null;
        }

        /* payroll_id = employee_payroll_config.id (string),
           etle config delete thay tyare e id vala badha
           payroll records pan delete thava joy */
        const payrollDeleteResult =
            await client.query(
                `
                    DELETE FROM payroll
                    WHERE TRIM(payroll_id::TEXT) = TRIM($1::TEXT)
                    RETURNING id, payroll_id, username,
                              payroll_month, payroll_year;
                    `,
                [String(id)]
            );

        const deleteResult =
            await client.query(
                `
                    DELETE FROM employee_payroll_config
                    WHERE id = $1
                    RETURNING *;
                    `,
                [id]
            );

        await client.query("COMMIT");

        return {
            ...deleteResult.rows[0],
            deleted_payroll_count: payrollDeleteResult.rows.length,
            deleted_payroll: payrollDeleteResult.rows
        };

    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
};

export const markPayrollGeneratedModel = async ({
    id = null,
    ids = [],
    username = null,
    usernames = [],
    month = null,
    year = null,
    generated_by
}) => {
    const payrollIds = [
        ...(id != null ? [id] : []),
        ...(Array.isArray(ids) ? ids : [])
    ]
        .map(Number)
        .filter(value => Number.isInteger(value) && value > 0);

    const payrollUsernames = [
        ...(username ? [username] : []),
        ...(Array.isArray(usernames) ? usernames : [])
    ]
        .map(value => String(value).trim())
        .filter(Boolean);

    if (payrollIds.length === 0 && (month == null || year == null)) {
        throw new Error("id / ids, or month and year, are required");
    }

    // Recalculate existing payroll records and generate missing records
    // for the requested month/year.
    if (payrollIds.length === 0) {
        if (month == null || year == null) {
            throw new Error("Month and year are required");
        }

        // 1. Fetch existing payroll records for the selected period.
        const existingPayrollResult = await pool.query(
            `
                SELECT DISTINCT ON (LOWER(TRIM(p.username)))
                    p.username,
                    p.payroll_month,
                    p.payroll_year
                FROM payroll p
                WHERE p.payroll_month = $1::INTEGER
                  AND p.payroll_year = $2::INTEGER
                  AND (
                      CARDINALITY($3::TEXT[]) = 0
                      OR EXISTS (
                          SELECT 1
                          FROM UNNEST($3::TEXT[]) AS selected(username)
                          WHERE LOWER(TRIM(selected.username)) =
                                LOWER(TRIM(p.username))
                      )
                  )
                ORDER BY LOWER(TRIM(p.username)), p.id DESC;
            `,
            [month, year, payrollUsernames]
        );

        // 2. Recalculate existing payroll.
        for (const employee of existingPayrollResult.rows) {
            await generateEmployeePayrollForMonthModel({
                username: employee.username,
                month: employee.payroll_month,
                year: employee.payroll_year,
                created_by: generated_by
            });
        }

        // 3. Find eligible employees who do not have payroll for this period.
        const missingEmployeesResult = await pool.query(
            `
                SELECT DISTINCT ON (LOWER(TRIM(pd.username)))
                    pd.username
                FROM personal_details pd
                INNER JOIN master_employee me
                    ON LOWER(TRIM(me.username)) = LOWER(TRIM(pd.username))
                INNER JOIN employee_payroll_config epc
                    ON LOWER(TRIM(epc.username)) = LOWER(TRIM(pd.username))
                WHERE LOWER(TRIM(me.status::TEXT)) = 'active'
                  AND epc.payroll_start_date IS NOT NULL
                  AND epc.payroll_end_date IS NOT NULL
                  AND epc.payroll_start_date <= (
                        MAKE_DATE($2::INTEGER, $1::INTEGER, 1)
                        + INTERVAL '1 month'
                        - INTERVAL '1 day'
                      )::DATE
                  AND epc.payroll_end_date >=
                        MAKE_DATE($2::INTEGER, $1::INTEGER, 1)
                  AND (
                      CARDINALITY($3::TEXT[]) = 0
                      OR EXISTS (
                          SELECT 1
                          FROM UNNEST($3::TEXT[]) AS selected(username)
                          WHERE LOWER(TRIM(selected.username)) =
                                LOWER(TRIM(pd.username))
                      )
                  )
                  AND NOT EXISTS (
                      SELECT 1
                      FROM payroll p
                      WHERE LOWER(TRIM(p.username)) =
                            LOWER(TRIM(pd.username))
                        AND p.payroll_month = $1::INTEGER
                        AND p.payroll_year = $2::INTEGER
                  )
                ORDER BY
                    LOWER(TRIM(pd.username)),
                    epc.payroll_start_date DESC,
                    epc.id DESC;
            `,
            [month, year, payrollUsernames]
        );

        // 4. Insert payroll for employees who are missing it.
        for (const employee of missingEmployeesResult.rows) {
            await generateEmployeePayrollForMonthModel({
                username: employee.username,
                month,
                year,
                created_by: generated_by
            });
        }
    }

    // Mark matching payroll records as generated.
    const result = await pool.query(
        `
        UPDATE payroll
        SET
            generated = TRUE,
            generated_by = $1::VARCHAR(100),
            generated_at = COALESCE(
                generated_at,
                CURRENT_TIMESTAMP
            ),
            updated_at = CURRENT_TIMESTAMP
        WHERE generated = FALSE

          AND EXISTS (
                SELECT 1
                FROM master_employee me
                INNER JOIN employee_payroll_config epc
                    ON LOWER(TRIM(epc.username)) =
                       LOWER(TRIM(me.username))
                WHERE LOWER(TRIM(me.username)) =
                      LOWER(TRIM(payroll.username))
                  AND LOWER(TRIM(me.status::TEXT)) = 'active'
                  AND epc.payroll_start_date IS NOT NULL
                  AND epc.payroll_end_date IS NOT NULL
                  AND epc.payroll_start_date <= (
                        MAKE_DATE(
                            payroll.payroll_year,
                            payroll.payroll_month,
                            1
                        )
                        + INTERVAL '1 month'
                        - INTERVAL '1 day'
                      )::DATE
                  AND epc.payroll_end_date >= MAKE_DATE(
                        payroll.payroll_year,
                        payroll.payroll_month,
                        1
                      )
          )

          AND (
                (
                    CARDINALITY($2::INTEGER[]) > 0
                    AND payroll.id = ANY($2::INTEGER[])
                )
                OR (
                    CARDINALITY($2::INTEGER[]) = 0
                    AND payroll.payroll_month = $4::INTEGER
                    AND payroll.payroll_year = $5::INTEGER
                    AND (
                        CARDINALITY($3::TEXT[]) = 0
                        OR EXISTS (
                            SELECT 1
                            FROM UNNEST($3::TEXT[]) AS selected(username)
                            WHERE LOWER(TRIM(selected.username)) =
                                  LOWER(TRIM(payroll.username))
                        )
                    )
                )
          )
        RETURNING
            id,
            username,
            payroll_month,
            payroll_year,
            generated,
            generated_by,
            generated_at,
            salary_status;
        `,
        [
            generated_by,
            payrollIds,
            payrollUsernames,
            month,
            year
        ]
    );

    return result.rows;
};

export const updatePayrollStatusModel = async (
    payrollRecordId,
    status,
    updatedBy,
    generated = null
) => {
    const result = await pool.query(
        `
        UPDATE payroll
        SET
            salary_status = $1::VARCHAR(30),

            paid_by = CASE
                WHEN LOWER($1::TEXT) = 'paid'
                    THEN $2::VARCHAR(100)
                ELSE paid_by
            END,

            paid_at = CASE
                WHEN LOWER($1::TEXT) = 'paid'
                    THEN COALESCE(paid_at, CURRENT_TIMESTAMP)
                ELSE paid_at
            END,

            generated = CASE
                WHEN $4::BOOLEAN IS TRUE
                    THEN TRUE
                ELSE generated
            END,

            generated_by = CASE
                WHEN $4::BOOLEAN IS TRUE
                    THEN COALESCE(generated_by, $2::VARCHAR(100))
                ELSE generated_by
            END,

            generated_at = CASE
                WHEN $4::BOOLEAN IS TRUE
                    THEN COALESCE(generated_at, CURRENT_TIMESTAMP)
                ELSE generated_at
            END,

            approved_by = CASE
                WHEN LOWER($1::TEXT) IN ('approve', 'approved')
                    THEN $2::VARCHAR(100)
                ELSE approved_by
            END,

            approved_at = CASE
                WHEN LOWER($1::TEXT) IN ('approve', 'approved')
                    THEN COALESCE(approved_at, CURRENT_TIMESTAMP)
                ELSE approved_at
            END,

            updated_at = CURRENT_TIMESTAMP

        WHERE id = $3
          AND (
              LOWER(TRIM(COALESCE(salary_status, ''))) <> 'paid'
              OR LOWER(TRIM($1::TEXT)) = 'paid'
          )

        RETURNING
            id,
            username,
            payroll_month,
            payroll_year,
            salary_status,
            generated,
            generated_by,
            generated_at,
            paid_by,
            paid_at,
            approved_by,
            approved_at;
        `,
        [status, updatedBy, payrollRecordId, generated === true]
    );

    return result.rows[0] || null;
};

/* =========================================================
   CURRENT MONTH EXPIRING CONFIGS
========================================================= */
export const getCurrentMonthExpiringPayrollConfigsModel = async ({
    work_location = null
} = {}) => {
    const locationValue =
        work_location == null ||
            String(work_location).trim() === "" ||
            String(work_location).trim().toLowerCase() === "all"
            ? null
            : String(work_location).trim();

    const values = [locationValue];

    const { rows } = await pool.query(
        `
        WITH india_today AS (
            SELECT (
                CURRENT_TIMESTAMP
                AT TIME ZONE 'Asia/Kolkata'
            )::DATE AS today
        )
        SELECT
            epc.id,
            epc.serial_number,
            epc.username,
            pd.first_name,
            pd.middle_name,
            pd.last_name,
            ed.work_location AS work_location_id,
            wl.location AS work_location,
            ed.shift_id,
            sc.shift_name,
            sc.shift_type,
            epc.working_start_time,
            epc.working_end_time,
            epc.day_type,
            TO_CHAR(epc.payroll_start_date, 'YYYY-MM-DD')
                AS payroll_start_date,
            TO_CHAR(epc.payroll_end_date, 'YYYY-MM-DD')
                AS payroll_end_date,
            TO_CHAR(epc.applicable_date, 'YYYY-MM-DD')
                AS applicable_date,
            EXTRACT(MONTH FROM epc.payroll_end_date)::INTEGER
                AS expire_month,
            EXTRACT(YEAR FROM epc.payroll_end_date)::INTEGER
                AS expire_year,
            epc.status,
            CASE
                WHEN india_today.today > epc.payroll_end_date
                    THEN 'expire'
                WHEN india_today.today < epc.payroll_start_date
                    THEN 'pending'
                ELSE 'active'
            END AS calculated_status,
            (india_today.today > epc.payroll_end_date) AS is_expired,
            (india_today.today <= epc.payroll_end_date) AS will_expire,
            GREATEST(
                (epc.payroll_end_date - india_today.today)::INTEGER,
                0
            ) AS days_remaining,
            epc.created_by,
            epc.updated_by,
            epc.created_at,
            epc.updated_at
        FROM employee_payroll_config epc
        CROSS JOIN india_today
        LEFT JOIN personal_details pd
            ON LOWER(TRIM(pd.username)) = LOWER(TRIM(epc.username))
        LEFT JOIN LATERAL (
            SELECT
                ed_inner.work_location,
                ed_inner.shift_id
            FROM employment_details ed_inner
            INNER JOIN personal_details pd_inner
                ON pd_inner.id = ed_inner.personal_details_id
            WHERE LOWER(TRIM(pd_inner.username)) =
                  LOWER(TRIM(epc.username))
            ORDER BY ed_inner.id DESC
            LIMIT 1
        ) ed ON TRUE
        LEFT JOIN work_location wl
            ON wl.id::TEXT = TRIM(ed.work_location::TEXT)
        LEFT JOIN shift_configurations sc
            ON sc.id = ed.shift_id
        WHERE EXTRACT(MONTH FROM epc.payroll_end_date)
                = EXTRACT(MONTH FROM india_today.today)
          AND EXTRACT(YEAR FROM epc.payroll_end_date)
                = EXTRACT(YEAR FROM india_today.today)
          AND (
                $1::TEXT IS NULL
                OR TRIM(ed.work_location::TEXT) = $1
                OR LOWER(TRIM(wl.location)) = LOWER(TRIM($1))
          )
        ORDER BY
            epc.payroll_end_date ASC,
            epc.id ASC;
        `,
        values
    );

    return rows;
};

/* =========================================================
   UPDATE ACTIVE / PENDING STATUS
========================================================= */
export const updatePayrollConfigStatusesModel = async () => {
    const client = await pool.connect();

    try {
        await client.query(
            "BEGIN"
        );

        /* =================================================
           GET CURRENT DATE
        ================================================= */
        const currentDate = await getIndiaDate(
            client
        );

        /* =================================================
           GET CONFIGS WHOSE STATUS MUST CHANGE
        ================================================= */
        const configsResult = await client.query(
            `
            SELECT
                *,
                CASE
                    WHEN $1::DATE > payroll_end_date THEN 'expire'
                    WHEN $1::DATE < payroll_start_date THEN 'pending'
                    ELSE 'active'
                END AS calculated_status
            FROM employee_payroll_config
            WHERE status <> CASE
                WHEN $1::DATE > payroll_end_date THEN 'expire'
                WHEN $1::DATE < payroll_start_date THEN 'pending'
                ELSE 'active'
            END
            FOR UPDATE;
            `,
            [currentDate]
        );

        const updatedConfigs = [];
        const expiredConfigs = [];
        for (const oldConfig of configsResult.rows) {
            const updateResult = await client.query(
                `
                UPDATE employee_payroll_config
                SET status = $1,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $2
                RETURNING *;
                `,
                [oldConfig.calculated_status, oldConfig.id]
            );

            updatedConfigs.push(updateResult.rows[0]);
            if (oldConfig.calculated_status === "expire") {
                expiredConfigs.push(updateResult.rows[0]);
            }
        }

        // const expiryNotifications = await createPayrollExpiryNotifications(client, expiredConfigs);
        await client.query("COMMIT");

        return {
            updated: updatedConfigs,
            // expiryNotifications,
            payrolls: []
        };

    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
};

export const getPayrollStatusDetailsModel = async ({
    month,
    year
}) => {
    const result = await pool.query(
        `
        SELECT
            p.id AS payroll_record_id,
            p.payroll_id,
            p.username,

            pd.first_name,
            pd.middle_name,
            pd.last_name,

            CONCAT_WS(
                ' ',
                NULLIF(TRIM(pd.first_name), ''),
                NULLIF(TRIM(pd.middle_name), ''),
                NULLIF(TRIM(pd.last_name), '')
            ) AS employee_name,

            p.payroll_month,
            p.payroll_year,
            p.basic_salary,
            p.overtime_minutes,
            p.overtime_hours,
            p.overtime_amount,
            p.net_salary,
            p.salary_status,
            p.generated,
            p.generated_at,
            p.approved_by,
            p.approved_at,
            p.paid_by,
            p.paid_at,
            p.created_at,
            p.updated_at

        FROM payroll p

        LEFT JOIN personal_details pd
            ON LOWER(TRIM(pd.username)) =
               LOWER(TRIM(p.username))

        WHERE p.payroll_month = $1
          AND p.payroll_year = $2
          AND LOWER(TRIM(p.salary_status)) IN (
              'pending',
              'approved'
          )

        ORDER BY
            CASE
                WHEN LOWER(TRIM(p.salary_status)) = 'pending'
                    THEN 1
                WHEN LOWER(TRIM(p.salary_status)) = 'approved'
                    THEN 2
                ELSE 3
            END,
            p.username ASC,
            p.id DESC;
        `,
        [month, year]
    );

    const payrollRows = decryptPayrollRows(
        result.rows,
        ["basic_salary"]
    );

    // Payroll generated but awaiting approval
    const approved = payrollRows.filter(
        row =>
            String(row.salary_status || "")
                .trim()
                .toLowerCase() === "pending"
    );

    // Payroll approved but awaiting payment
    const paid = payrollRows.filter(
        row =>
            String(row.salary_status || "")
                .trim()
                .toLowerCase() === "approved"
    );

    const generatedResult = await pool.query(
        `
            SELECT DISTINCT ON (LOWER(TRIM(epc.username)))
                epc.id AS payroll_config_id,
                epc.username,

                pd.first_name,
                pd.middle_name,
                pd.last_name,

                CONCAT_WS(
                    ' ',
                    NULLIF(TRIM(pd.first_name), ''),
                    NULLIF(TRIM(pd.middle_name), ''),
                    NULLIF(TRIM(pd.last_name), '')
                ) AS employee_name,

                epc.status AS contract_status,
                epc.payroll_start_date,
                epc.payroll_end_date,
                epc.created_at,
                epc.updated_at

            FROM employee_payroll_config epc

            LEFT JOIN personal_details pd
                ON LOWER(TRIM(pd.username)) =
                   LOWER(TRIM(epc.username))

            WHERE LOWER(TRIM(epc.status)) = 'active'

              -- Contract must overlap the selected payroll month
              AND epc.payroll_start_date <=
                  (make_date($2::INTEGER, $1::INTEGER, 1)
                   + INTERVAL '1 month - 1 day')::DATE

              AND epc.payroll_end_date >=
                  make_date($2::INTEGER, $1::INTEGER, 1)

              -- Exclude employees whose payroll is already generated
              AND NOT EXISTS (
                  SELECT 1
                  FROM payroll p
                  WHERE LOWER(TRIM(p.username)) =
                        LOWER(TRIM(epc.username))
                    AND p.payroll_month = $1
                    AND p.payroll_year = $2
                    AND p.generated = TRUE
              )

            ORDER BY
                LOWER(TRIM(epc.username)),
                epc.payroll_start_date DESC,
                epc.id DESC;
        `,
        [month, year]
    );

    const non_generated = generatedResult.rows.map(row => ({
        ...row,
        generated: false,
        requested_payroll_month: Number(month),
        requested_payroll_year: Number(year)
    }));

    return {
        month: Number(month),
        year: Number(year),

        summary: {
            total_records: payrollRows.length,
            non_approved_count: approved.length,
            non_paid_count: paid.length,
            non_generated_count: non_generated.length
        },

        non_generated,
        non_approved: approved,
        non_paid: paid
    };
};

/* =========================================================
   GET ALL EMPLOYEE PAYROLL CONFIG WITH PAYROLL
========================================================= */
export const getEmployeePayrollConfigWithPayrollModel = async ({
    username = null,
    status = null,
    serial_number = null
} = {}) => {
    const normalizedUsername =
        username == null || String(username).trim() === ""
            ? null
            : String(username).trim();
    const normalizedStatus =
        status == null || String(status).trim() === ""
            ? null
            : String(status).trim();
    const normalizedSerialNumber =
        serial_number == null || String(serial_number).trim() === ""
            ? null
            : String(serial_number).trim();

    const configResult = await pool.query(`
        SELECT
            epc.id,
            epc.serial_number,
            epc.username,
            ed.shift_id,
            sc.shift_name,
            sc.shift_type,
            epc.working_start_time,
            epc.working_end_time,
            epc.payroll_start_date,
            epc.payroll_end_date,
            epc.applicable_date,
            epc.day_type,
            epc.status,
            epc.created_by,
            epc.updated_by,
            epc.created_at,
            epc.updated_at,
            epc.current_salary,
            epc.next_increment_date
        FROM employee_payroll_config epc
        LEFT JOIN LATERAL (
            SELECT shift_id
            FROM employment_details
            WHERE LOWER(TRIM(username)) = LOWER(TRIM(epc.username))
            ORDER BY id DESC
            LIMIT 1
        ) ed ON TRUE
        LEFT JOIN shift_configurations sc
            ON sc.id = ed.shift_id
        WHERE (
            $1::TEXT IS NULL
            OR COALESCE(epc.status, '') ILIKE '%' || $1 || '%'
        )
          AND (
            $2::TEXT IS NULL
            OR LOWER(TRIM(epc.username)) LIKE
               '%' || LOWER(TRIM($2)) || '%'
          )
          AND (
            $3::TEXT IS NULL
            OR LOWER(TRIM(COALESCE(epc.serial_number, ''))) LIKE
               '%' || LOWER(TRIM($3)) || '%'
          )
        ORDER BY epc.id ASC;
    `, [normalizedStatus, normalizedUsername, normalizedSerialNumber]);

    const configurations = configResult.rows;

    if (configurations.length === 0) {
        return [];
    }

    const configIds = configurations.map(config =>
        String(config.id)
    );

    const payrollResult = await pool.query(
        `
        SELECT
            p.id AS payroll_record_id,
            p.payroll_id,
            p.pay_slip_no,
            p.username,
            p.payroll_month,
            p.payroll_year,
            p.basic_salary,
            p.next_increment_date,
            p.net_salary,
            p.created_by,
            p.approved_by,
            p.approved_at,
            p.generated,
            p.generated_by,
            p.generated_at,
            p.salary_status,
            p.paid_by,
            p.paid_at,
            p.created_at,
            p.updated_at
        FROM payroll p
        WHERE TRIM(p.payroll_id::TEXT) = ANY($1::TEXT[])
          AND (
              $2::TEXT IS NULL
              OR LOWER(TRIM(p.username::TEXT)) LIKE
                 '%' || LOWER(TRIM($2)) || '%'
          )
        ORDER BY
            p.payroll_year DESC,
            p.payroll_month DESC,
            p.id DESC;
        `,
        [configIds, normalizedUsername]
    );

    const configById = new Map(
        configurations.map(config => [
            String(config.id),
            config
        ])
    );
    const decryptedPayrollRecords = decryptPayrollRows(
        payrollResult.rows,
        ["basic_salary"]
    );
    const payrollRecords = normalizedUsername
        ? await Promise.all(
            decryptedPayrollRecords.map(async record => {
                const config = configById.get(
                    String(record.payroll_id ?? "").trim()
                );

                if (!config) {
                    throw new Error(`Payroll configuration not found for payroll record ${record.payroll_record_id}`);
                }

                const attendance = await getAttendanceOvertime({
                    client: pool,
                    username: record.username,
                    payrollMonth: Number(record.payroll_month),
                    payrollYear: Number(record.payroll_year),
                    payrollStartDate: config.payroll_start_date,
                    payrollEndDate: config.payroll_end_date,
                    workingStartTime: config.working_start_time,
                    workingEndTime: config.working_end_time
                });
                const totalMinutes = Number(
                    attendance.actual_working_minutes || 0
                );
                const standardWorkingMinutes = Number(
                    attendance.standard_working_minutes || 0
                );

                return {
                    ...record,
                    total_minutes: totalMinutes,
                    total_hours: `${Math.floor(totalMinutes / 60)}:${String(
                        totalMinutes % 60
                    ).padStart(2, "0")}`,
                    total_amount: standardWorkingMinutes > 0
                        ? Number(
                            (
                                Number(record.basic_salary || 0) *
                                totalMinutes /
                                standardWorkingMinutes
                            ).toFixed(2)
                        )
                        : 0
                };
            })
        )
        : decryptedPayrollRecords;

    const payrollMap = new Map();

    for (const record of payrollRecords) {
        const key = String(record.payroll_id ?? "").trim();

        if (!payrollMap.has(key)) {
            payrollMap.set(key, []);
        }

        payrollMap.get(key).push(record);
    }

    return configurations.map(config => {
        // Decrypt current_salary
        const decryptedConfig = decryptPayrollFields(
            config,
            ["current_salary"]
        );

        const employeePayroll = payrollMap.get(String(config.id)) || [];
        const response = {
            ...decryptedConfig,
            total_records: employeePayroll.length,
            latest_salary_status: employeePayroll.length
                ? employeePayroll[employeePayroll.length - 1].salary_status
                : null,
        };

        if (normalizedUsername) {
            response.payroll = {
                total_records: employeePayroll.length,
                records: employeePayroll
            };
        }

        return response;
    });
};

export const getEmployeePayrollConfigStatCardModel = async () => {
    const result = await pool.query(`
        SELECT
            COUNT(*)::INTEGER AS total,
            COUNT(*) FILTER (
                WHERE LOWER(TRIM(COALESCE(epc.status, ''))) = 'pending'
            )::INTEGER AS pending,
            COUNT(*) FILTER (
                WHERE LOWER(TRIM(COALESCE(epc.status, ''))) = 'active'
            )::INTEGER AS active,
            COUNT(*) FILTER (
                WHERE LOWER(TRIM(COALESCE(epc.status, ''))) = 'expire'
            )::INTEGER AS expire
        FROM employee_payroll_config epc
    `);

    const counts = result.rows[0] || {};
    return {
        total: Number(counts.total || 0),
        total_pending: Number(counts.pending || 0),
        total_active: Number(counts.active || 0),
        total_expire: Number(counts.expire || 0)
    };
};

/* =========================================================
   GET PAYROLL DASHBOARD STATISTICS
========================================================= */
export const getPayrollDashboardStatsModel = async () => {
    // 1. Get overall contract statistics
    const configResult = await pool.query(`
        WITH report_period AS (
            SELECT CURRENT_DATE AS as_of_date
        )
        SELECT
            COUNT(*)::INTEGER AS total_configurations,

            COUNT(*) FILTER (
                WHERE LOWER(TRIM(epc.status)) = 'active'
                  AND epc.payroll_start_date <= rp.as_of_date
                  AND epc.payroll_end_date >= rp.as_of_date
            )::INTEGER AS active_configurations,

            COUNT(*) FILTER (
                WHERE LOWER(TRIM(epc.status)) = 'pending'
                    AND epc.payroll_end_date >= rp.as_of_date
            )::INTEGER AS pending_configurations,

            COUNT(*) FILTER (
                WHERE
                    (
                        LOWER(TRIM(epc.status)) = 'inactive'
                        OR epc.payroll_end_date < rp.as_of_date
                    )
                    AND NOT EXISTS (
                        SELECT 1
                        FROM employee_payroll_config newer
                        WHERE LOWER(TRIM(newer.username))
                            = LOWER(TRIM(epc.username))
                          AND newer.id <> epc.id
                          AND newer.payroll_start_date <= rp.as_of_date
                          AND newer.payroll_end_date >= rp.as_of_date
                    )
            )::INTEGER AS expired_configurations,

            COUNT(DISTINCT LOWER(TRIM(epc.username)))
                FILTER (
                    WHERE epc.username IS NOT NULL
                      AND TRIM(epc.username) <> ''
                )::INTEGER AS total_employees

        FROM employee_payroll_config epc
        CROSS JOIN report_period rp;
    `);

    const configStats = configResult.rows[0];

    // 2. Fetch ALL payroll records (no month/year filter)
    const payrollResult = await pool.query(`
        SELECT
            p.id AS payroll_record_id,
            p.payroll_id,
            p.username,
            p.payroll_month,
            p.payroll_year,
            p.basic_salary,
            p.overtime_minutes,
            p.overtime_hours,
            p.overtime_amount,
            p.net_salary,
            p.generated,
            p.salary_status,
            p.paid_at
        FROM payroll p
        ORDER BY
            p.payroll_year DESC,
            p.payroll_month DESC,
            p.id DESC;
    `);

    // 3. Decrypt basic salary
    const payrollRecords = decryptPayrollRows(
        payrollResult.rows,
        ["basic_salary"]
    );

    // 4. Initialize payroll statistics
    const stats = {
        total_payroll_records: payrollRecords.length,
        generated_payrolls: 0,
        total_approval: 0,
        total_paid: 0,
        total_basic_salary: 0,
        total_net_salary: 0,
        total_overtime_amount: 0
    };

    const toAmount = (value) => {
        if (
            value === null ||
            value === undefined ||
            value === ""
        ) {
            return 0;
        }

        const amount = Number(value);
        return Number.isFinite(amount) ? amount : 0;
    };

    // 5. Calculate statistics across all payroll records
    for (const record of payrollRecords) {
        const status = String(
            record.salary_status || ""
        ).trim().toLowerCase();

        if (record.generated === true) {
            stats.generated_payrolls += 1;
        }

        if (status === "approved") {
            stats.total_approval += 1;
        } else if (status === "paid") {
            stats.total_paid += 1;
        }

        stats.total_basic_salary += toAmount(
            record.basic_salary
        );

        stats.total_net_salary += toAmount(
            record.net_salary
        );

        stats.total_overtime_amount += toAmount(
            record.overtime_amount
        );
    }

    // 6. Return overall dashboard statistics
    return {
        configurations: {
            total_contract: Number(configStats.total_configurations),
            total_active_contract: Number(configStats.active_configurations),
            total_pending_contract: Number(configStats.pending_configurations),
            total_completed_contract: Number(configStats.expired_configurations),
            total_employees: Number(configStats.total_employees)
        },

        payroll: {
            ...stats,

            total_basic_salary: Number(
                stats.total_basic_salary.toFixed(2)
            ),

            total_net_salary: Number(
                stats.total_net_salary.toFixed(2)
            ),

            total_overtime_amount: Number(
                stats.total_overtime_amount.toFixed(2)
            )
        }
    };
};
