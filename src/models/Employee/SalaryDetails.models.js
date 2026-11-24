import { pool } from "../../database.js";
import {
    decryptPayrollFields,
    encryptPayrollAmount,
    migratePayrollEncryptedColumns
} from "../../utils/payrollEncryption.js";

/* ================= CREATE TABLE ================= */
export const initializeSalaryTable = async () => {
    const query = `
        CREATE TABLE IF NOT EXISTS salary_details (
            id SERIAL PRIMARY KEY,
            personal_details_id INTEGER NOT NULL,
            current_salary TEXT,
            next_increment_date DATE,
            created_at TIMESTAMP DEFAULT TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP),
            updated_at TIMESTAMP DEFAULT TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
        )
    `;

    await pool.query(query);

    await pool.query(`
        ALTER TABLE salary_details
            ALTER COLUMN current_salary TYPE TEXT USING current_salary::TEXT,
            DROP COLUMN IF EXISTS expected_increment;
    `);
    await migratePayrollEncryptedColumns(
        pool,
        "salary_details",
        ["current_salary"]
    );

    await pool.query(`
        SELECT setval(
                pg_get_serial_sequence('salary_details', 'id'),
                COALESCE((SELECT MAX(id) FROM salary_details), 1),
                true
            );
        `);

    await pool.query(`
        ALTER TABLE salary_details
        DROP COLUMN IF EXISTS effective_date
    `);

    console.log("✅ salary_details table ready");
};

/* ================= ADD ================= */
export const addSalaryModel = async (data) => {
    if (
        data.personal_details_id === undefined ||
        data.personal_details_id === null
    ) {
        throw new Error("personal_details_id is required");
    }

    const existing = await pool.query(
        `
        SELECT *
        FROM salary_details
        WHERE personal_details_id = $1
        ORDER BY id DESC
        LIMIT 1;
        `,
        [data.personal_details_id]
    );

    if (existing.rows.length > 0) {
        return decryptPayrollFields(existing.rows[0], [
            "current_salary"
        ]);
    }

    const query = `
        INSERT INTO salary_details (
            personal_details_id,
            current_salary,
            next_increment_date
        )
        VALUES ($1, $2, $3)
        RETURNING *;
    `;

    const values = [
        data.personal_details_id,
        encryptPayrollAmount(data.current_salary ?? null),
        data.next_increment_date || null
    ];

    const { rows } = await pool.query(query, values);

    return decryptPayrollFields(rows[0], [
        "current_salary"
    ]);
};

/* ================= GET ALL ================= */
export const getAllSalaryModel = async () => {
    const { rows } = await pool.query(`
        SELECT *
        FROM salary_details
        ORDER BY id DESC
    `);

    return rows.map(row => decryptPayrollFields(row, [
        "current_salary"
    ]));
};

/* ================= GET BY ID ================= */
export const getSalaryByIdModel = async (id) => {
    const { rows } = await pool.query(
        `SELECT * FROM salary_details WHERE id = $1`,
        [id]
    );

    return decryptPayrollFields(rows[0], [
        "current_salary"
    ]);
};

/* ================= UPDATE ================= */
export const updateSalaryModel = async (id, data) => {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");
        const result = await client.query(
            `
            UPDATE salary_details
            SET
                current_salary = $1,
                next_increment_date = $2,
                updated_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
            WHERE id = $3
            RETURNING *;
            `,
            [
                encryptPayrollAmount(data.current_salary),
                data.next_increment_date,
                id
            ]
        );
        const salary = result.rows[0];

        if (salary) {
            const employee = await client.query(
                `
                SELECT username
                FROM personal_details
                WHERE id = $1
                LIMIT 1;
                `,
                [salary.personal_details_id]
            );

            if (employee.rows[0]?.username) {
                await client.query(
                    `
                    UPDATE payroll
                    SET
                        next_increment_date = $1,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE LOWER(TRIM(username)) = LOWER(TRIM($2));
                    `,
                    [
                        salary.next_increment_date,
                        employee.rows[0].username
                    ]
                );
            }
        }

        await client.query("COMMIT");
        return decryptPayrollFields(salary, [
            "current_salary"
        ]);
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
};
