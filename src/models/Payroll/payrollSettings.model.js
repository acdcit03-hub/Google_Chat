
import { pool } from "../../database.js";

export const getPayrollSettingsModel = async ({
    payroll_month,
    payroll_year,
    company_number = null
}) => {
    const query = `
        SELECT
            pd.username,
            p.pay_slip_no AS pay_slip_no,

            COALESCE(
                NULLIF($3::TEXT, ''),
                cbd.company_bank_account_no::TEXT
            ) AS debit_ac,

            p.net_salary AS amount,
            p.salary_status,
            bd.ifsc_code,
            bd.account_number AS credit_ac_no,
            bd.account_holder_name AS beneficiary_name,
            bd.bank_name,

            CASE
                WHEN UPPER(TRIM(COALESCE(bd.bank_name, '')))
                     IN ('BOB', 'BOD', 'BANK OF BARODA')
                THEN 'BB'
                ELSE
                    LEFT(
                        UPPER(TRIM(COALESCE(bd.bank_name, ''))),
                        1
                    ) || 'B'
            END AS scheme_type

        FROM payroll p

        INNER JOIN personal_details pd
            ON pd.username = p.username

        LEFT JOIN LATERAL (
            SELECT cbd.company_bank_account_no
            FROM company_bank_details cbd
            WHERE cbd.status = TRUE
            ORDER BY cbd.id ASC
            LIMIT 1
        ) cbd ON TRUE

        INNER JOIN bank_details bd
            ON bd.personal_details_id = pd.id

        WHERE p.payroll_month = $1
          AND p.payroll_year = $2

        ORDER BY pd.username ASC;
    `;

    const result = await pool.query(query, [
        payroll_month,
        payroll_year,
        company_number
    ]);

    return result.rows;
};
