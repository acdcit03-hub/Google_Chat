import { pool } from "../../database.js";

/* ================= CREATE INACTIVE EMPLOYEE TABLE ================= */
export const initializeInactiveEmployeeTable = async () => {
    const query = `
        CREATE TABLE IF NOT EXISTS inactive_employee (
            id SERIAL PRIMARY KEY,
            personal_details_id INTEGER NOT NULL UNIQUE,
            username VARCHAR(50) NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'inactive',
            inactive_date DATE NOT NULL,
            inactive_reason TEXT,
            created_at TIMESTAMP DEFAULT TIMEZONE(
                'Asia/Kolkata',
                CURRENT_TIMESTAMP
            ),

            CONSTRAINT fk_inactive_employee_personal
            FOREIGN KEY (personal_details_id)
            REFERENCES personal_details(id)
            ON DELETE CASCADE
        );
    `;

    await pool.query(query);

    await pool.query(`
        ALTER TABLE inactive_employee
        ADD COLUMN IF NOT EXISTS past_status VARCHAR(20),
        ADD COLUMN IF NOT EXISTS inactive_reason TEXT;
    `);

    await pool.query(`
        SELECT setval(
            pg_get_serial_sequence('inactive_employee', 'id'),
            COALESCE((SELECT MAX(id) FROM inactive_employee), 1),
            true
        );
    `);

    console.log("✅ inactive_employee table ready");
};

export const addInactiveEmployeeModel = async ({
    personal_details_id,
    past_status,
    inactive_date,
    inactive_reason
}) => {
    const { rows } = await pool.query(
        `
            INSERT INTO inactive_employee
            (
                personal_details_id,
                username,
                past_status,
                status,
                inactive_date,
                inactive_reason
            )
            SELECT
                me.personal_details_id,
                me.username,
                $2,
                'inactive',
                $3,
                $4
            FROM master_employee me
            WHERE me.personal_details_id = $1

            ON CONFLICT (personal_details_id)
            DO UPDATE
            SET
                username = EXCLUDED.username,
                past_status = EXCLUDED.past_status,
                status = 'inactive',
                inactive_date = EXCLUDED.inactive_date,
                inactive_reason = EXCLUDED.inactive_reason

            RETURNING *;
        `,
        [
            personal_details_id,
            past_status,
            inactive_date,
            inactive_reason
        ]
    );

    return rows[0];
};

export const removeInactiveEmployeeModel = async (
    personal_details_id
) => {
    await pool.query(
        `
            DELETE FROM inactive_employee
            WHERE personal_details_id = $1
        `,
        [personal_details_id]
    );

};

export const getInactiveEmployeeByPersonalIdModel = async (
    personal_details_id
) => {
    const { rows } = await pool.query(
        `
            SELECT *
            FROM inactive_employee
            WHERE personal_details_id = $1
            LIMIT 1
        `,
        [personal_details_id]
    );

    return rows[0] || null;
};