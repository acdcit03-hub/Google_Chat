import { pool } from "../../database.js";

/* ================= CREATE TABLE ================= */
export const initializeIdentificationDetailsTable = async () => {
    const query = `
        CREATE TABLE IF NOT EXISTS identification_details (
            id SERIAL PRIMARY KEY,
            personal_details_id INTEGER NOT NULL,
            pan_card_number VARCHAR(20),
            pan_card_upload TEXT,
            aadhaar_number BIGINT,
            aadhaar_upload TEXT,
            other_document_upload TEXT,
            created_at TIMESTAMP DEFAULT TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP),
            updated_at TIMESTAMP DEFAULT TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
        )
    `;

    await pool.query(query);

    await pool.query(`
        SELECT setval(
            pg_get_serial_sequence('identification_details', 'id'),
            COALESCE((SELECT MAX(id) FROM identification_details), 1),
            true
        );
    `);
    
    console.log("✅ identification_details table ready");
};

/* ================= ADD ================= */
export const addIdentificationDetailsModel = async (data) => {
    const existing = await pool.query(
        `SELECT * FROM identification_details WHERE personal_details_id = $1 LIMIT 1`,
        [data.personal_details_id]
    );

    if (existing.rows[0]) {
        return existing.rows[0];
    }

    const query = `
        INSERT INTO identification_details (
            personal_details_id,
            pan_card_number,
            pan_card_upload,
            aadhaar_number,
            aadhaar_upload,
            other_document_upload
        )
        VALUES ($1,$2,$3,$4,$5,$6)
        RETURNING *;
    `;

    const values = [
        data.personal_details_id,
        data.pan_card_number || null,
        data.pan_card_upload || null,
        data.aadhaar_number || null,
        data.aadhaar_upload || null,
        data.other_document_upload || null
    ];

    const { rows } = await pool.query(query, values);
    return rows[0];
};

/* ================= GET ALL ================= */
export const getAllIdentificationDetailsModel = async () => {
    const { rows } = await pool.query(`
        SELECT *
        FROM identification_details
        ORDER BY id DESC
    `);

    return rows;
};

/* ================= GET BY ID ================= */
export const getIdentificationDetailsByIdModel = async (id) => {
    const { rows } = await pool.query(
        `SELECT * FROM identification_details WHERE id = $1`,
        [id]
    );

    return rows[0];
};

/* ================= UPDATE ================= */
export const updateIdentificationDetailsModel = async (id, data) => {
    const query = `
        UPDATE identification_details
        SET
            pan_card_number = COALESCE($1, pan_card_number),
            pan_card_upload = COALESCE($2, pan_card_upload),
            aadhaar_number = COALESCE($3, aadhaar_number),
            aadhaar_upload = COALESCE($4, aadhaar_upload),
            other_document_upload = COALESCE($5, other_document_upload),
            updated_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
        WHERE id = $6
        RETURNING *;
    `;

    const values = [
        data.pan_card_number || null,
        data.pan_card_upload || null,
        data.aadhaar_number || null,
        data.aadhaar_upload || null,
        data.other_document_upload || null,
        id
    ];

    const { rows } = await pool.query(query, values);
    return rows[0];
};