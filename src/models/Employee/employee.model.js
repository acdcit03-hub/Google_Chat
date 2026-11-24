import { pool } from "../../database.js";

/* ================= CREATE EMPLOYEE LOGIN ================= */
export const createEmployeeModel = async (data) => {

    const query = `
        UPDATE employment_details
        SET
            username = $2
        WHERE personal_details_id = $1
        RETURNING
            id,
            personal_details_id,
            username,
            password,
            access;
    `;

    const values = [
        data.personal_details_id,
        data.username
    ];

    const { rows } = await pool.query(query, values);

    return rows[0];
};

/* ================= LOGIN LOOKUP ================= */
export const findEmployeeForLoginModel = async (username) => {

    const { rows } = await pool.query(
        `
        SELECT
            ed.id,
            ed.personal_details_id,
            ed.username,
            ed.password,
            ed.access,

            /* ================= DEPARTMENT ================= */

            ed.department AS department_id,
            ds.name AS department,

            /* ================= PERSONAL ================= */

            pd.first_name,
            pd.middle_name,
            pd.last_name,
            pd.email_id,

            /* ================= EMPLOYEE STATUS ================= */

            me.status AS employee_status

        FROM employment_details ed

        INNER JOIN personal_details pd
            ON pd.id = ed.personal_details_id

        /* ================= DEPARTMENT ================= */

        LEFT JOIN department_structure ds
            ON ds.id = ed.department

        /* ================= MASTER EMPLOYEE ================= */

        LEFT JOIN master_employee me
            ON me.personal_details_id = pd.id

        WHERE LOWER(TRIM(COALESCE(ed.username, '')))
            = LOWER(TRIM($1))

        LIMIT 1
        `,
        [username]
    );

    return rows[0] ?? null;
};

/* ================= GET ALL ================= */
export const getAllEmployeesModel = async () => {

    const { rows } = await pool.query(`
        SELECT
            ed.id,
            pd.first_name,
            pd.middle_name,
            pd.last_name,
            ed.username,
            pd.email_id,
            ed.department,
            ed.access,
            ed.created_at
        FROM employment_details ed
        JOIN personal_details pd
            ON pd.id = ed.personal_details_id
        ORDER BY ed.id DESC
    `);

    return rows;
};

export const updatePasswordByPersonalId = async (
    personal_details_id,
    password
) => {

    const { rows } = await pool.query(
        `
            UPDATE employment_details
            SET password = $2
            WHERE personal_details_id = $1
            RETURNING *;
        `,
        [
            personal_details_id,
            password
        ]
    );

    return rows[0] ?? null;
};