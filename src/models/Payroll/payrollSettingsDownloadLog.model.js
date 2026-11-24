import { pool } from "../../database.js";

/* =========================================================
   INITIALIZE PAYROLL SETTINGS DOWNLOAD LOGS TABLE
========================================================= */
export const initializePayrollSettingsDownloadLogsTable = async () => {
    const query = `
        CREATE TABLE IF NOT EXISTS payroll_settings_download_logs (
            id BIGSERIAL PRIMARY KEY,
            payroll_month INTEGER NOT NULL
                CHECK (payroll_month BETWEEN 1 AND 12),

            payroll_year INTEGER NOT NULL
                CHECK (payroll_year BETWEEN 2000 AND 9999),

            format VARCHAR(20) NOT NULL
                CHECK (format IN ('bob', 'non-bob')),

            company_account_no VARCHAR(50) DEFAULT NULL,
            downloaded_by VARCHAR(100) DEFAULT NULL,
            file_name VARCHAR(255) NOT NULL,
            employee_count INTEGER NOT NULL DEFAULT 0
                CHECK (employee_count >= 0),

            downloaded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_payroll_download_logs_period
            ON payroll_settings_download_logs (
                payroll_year,
                payroll_month
            );

        CREATE INDEX IF NOT EXISTS idx_payroll_download_logs_downloaded_at
            ON payroll_settings_download_logs (downloaded_at DESC);
    `;

    try {
        await pool.query(query);
        console.log(
            "✅ Payroll settings download logs table initialized successfully."
        );
    } catch (error) {
        console.error(
            "Error initializing payroll settings download logs table:",
            error.message
        );
        throw error;
    }
};

/* =========================================================
   CREATE PAYROLL SETTINGS DOWNLOAD LOG
========================================================= */
export const createPayrollSettingsDownloadLogModel = async ({
    payroll_month,
    payroll_year,
    format,
    company_account_no = null,
    downloaded_by = null,
    file_name,
    employee_count
}) => {
    const query = `
        INSERT INTO payroll_settings_download_logs (
            payroll_month,
            payroll_year,
            format,
            company_account_no,
            downloaded_by,
            file_name,
            employee_count
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *;
    `;

    const values = [
        payroll_month,
        payroll_year,
        format,
        company_account_no,
        downloaded_by,
        file_name,
        employee_count
    ];

    const result = await pool.query(query, values);

    return result.rows[0];
};

/* =========================================================
   GET PAYROLL SETTINGS DOWNLOAD LOGS
========================================================= */
export const getPayrollSettingsDownloadLogsModel = async ({
    payroll_month = null,
    payroll_year = null
} = {}) => {
    const query = `
        SELECT
            id,
            payroll_month,
            payroll_year,
            format,
            company_account_no,
            downloaded_by,
            file_name,
            employee_count,
            downloaded_at
        FROM payroll_settings_download_logs
        WHERE ($1::INTEGER IS NULL OR payroll_month = $1)
          AND ($2::INTEGER IS NULL OR payroll_year = $2)
        ORDER BY downloaded_at DESC, id DESC;
    `;

    const values = [
        payroll_month,
        payroll_year
    ];

    const result = await pool.query(query, values);

    return result.rows;
};