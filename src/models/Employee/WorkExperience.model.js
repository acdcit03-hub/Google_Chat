import { pool } from "../../database.js";

/* ================= CREATE TABLE ================= */
export const initializeWorkExperienceTable = async () => {
    const query = `
        CREATE TABLE IF NOT EXISTS work_experience (
            id SERIAL PRIMARY KEY,
            personal_details_id INTEGER REFERENCES personal_details(id) ON DELETE CASCADE,
            company_name VARCHAR(255),
            job_title VARCHAR(255),
            duration_from DATE,
            duration_to DATE,
            salary INTEGER,
            reason_for_leaving VARCHAR(500),
            responsibilities TEXT,
            experience_letter TEXT,
            created_at TIMESTAMP DEFAULT TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP),
            updated_at TIMESTAMP DEFAULT TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
        );
    `;

    await pool.query(query);

    await pool.query(`
        SELECT setval(
            pg_get_serial_sequence('work_experience', 'id'),
            COALESCE((SELECT MAX(id) FROM work_experience), 1),
            true
        );
    `);

    console.log("✅ work_experience table ready");
};

/* ================= ADD ================= */
export const addWorkExperienceModel = async (data) => {
    const existing = await pool.query(
        `SELECT * FROM work_experience WHERE personal_details_id = $1 LIMIT 1`,
        [data.personal_details_id]
    );

    if (existing.rows[0]) {
        return existing.rows[0];
    }

    const query = `
        INSERT INTO work_experience (
            personal_details_id,
            company_name,
            job_title,
            duration_from,
            duration_to,
            salary,
            reason_for_leaving,
            responsibilities,
            experience_letter
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        RETURNING *;
    `;

    const values = [
        data.personal_details_id,
        data.company_name,
        data.job_title,
        data.duration_from === ""
        ? null
        : data.duration_from,

    data.duration_to === ""
        ? null
        : data.duration_to,
        data.salary,
        data.reason_for_leaving,
        data.responsibilities,
        data.experience_letter
    ];

    const { rows } = await pool.query(query, values);
    return rows[0];
};

/* ================= GET ALL ================= */
export const getAllWorkExperienceModel = async () => {
    const { rows } = await pool.query(`
        SELECT *
        FROM work_experience
        ORDER BY id DESC
    `);

    return rows;
};

/* ================= GET BY PERSONAL DETAILS ID ================= */
export const getWorkExperienceByIdModel = async (id) => {
    const { rows } = await pool.query(
        `
            SELECT *
            FROM work_experience
            WHERE id = $1
            ORDER BY id DESC
        `,
        [id]
    );

    return rows;
};

/* ================= UPDATE ================= */
export const updateWorkExperienceModel = async (id, data) => {
    const query = `
        UPDATE work_experience
        SET
            company_name = $1,
            job_title = $2,
            duration_from = $3,
            duration_to = $4,
            salary = $5,
            reason_for_leaving = $6,
            responsibilities = $7,
            experience_letter = $8,
            updated_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
        WHERE id = $9
        RETURNING *;
    `;

    const values = [
        data.company_name,
        data.job_title,
        data.duration_from,
        data.duration_to,
        data.salary,
        data.reason_for_leaving,
        data.responsibilities,
        data.experience_letter,
        id
    ];

    const { rows } = await pool.query(query, values);
    return rows[0];
};

/* ================= DELETE ================= */
export const deleteWorkExperienceModel = async (id) => {
    const { rows } = await pool.query(
        `
            DELETE FROM work_experience
            WHERE id = $1
            RETURNING *
        `,
        [id]
    );

    return rows[0];
};