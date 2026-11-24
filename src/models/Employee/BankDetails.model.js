import { pool } from "../../database.js";

/* ================= CREATE TABLE ================= */
export const initializeBankDetailsTable = async () => {
    const query = `
        CREATE TABLE IF NOT EXISTS bank_details (
            id SERIAL PRIMARY KEY,
            personal_details_id INTEGER NOT NULL,
            bank_name VARCHAR(255),
            account_holder_name VARCHAR(255),
            account_number VARCHAR(30),
            ifsc_code VARCHAR(50),
            branch_name VARCHAR(255),
            bank_proof TEXT,
            created_at TIMESTAMP DEFAULT TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP),
            updated_at TIMESTAMP DEFAULT TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
        )
    `;

    await pool.query(query);

    await pool.query(`
        SELECT setval(
            pg_get_serial_sequence('bank_details', 'id'),
            COALESCE((SELECT MAX(id) FROM bank_details), 1),
            true
        );
    `);

    console.log("✅ bank_details table ready");
};

/* ================= ADD ================= */
export const addBankDetailsModel = async (data) => {
    const existing = await pool.query(
        `SELECT * FROM bank_details WHERE personal_details_id = $1 LIMIT 1`,
        [data.personal_details_id]
    );

    if (existing.rows[0]) {
        return existing.rows[0];
    }

    const query = `
        INSERT INTO bank_details (
            personal_details_id,
            bank_name,
            account_holder_name,
            account_number,
            ifsc_code,
            branch_name,
            bank_proof
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        RETURNING *;
    `;

    const values = [
        data.personal_details_id,
        data.bank_name || null,
        data.account_holder_name || null,
        data.account_number || null,
        data.ifsc_code || null,
        data.branch_name || null,
        data.bank_proof || null
    ];

    const { rows } = await pool.query(query, values);
    return rows[0];
};

/* ================= GET ALL ================= */
export const getAllBankDetailsModel = async () => {
    const { rows } = await pool.query(`
        SELECT *
        FROM bank_details
        ORDER BY id DESC
    `);

    return rows;
};

/* ================= GET BY ID ================= */
export const getBankDetailsByIdModel = async (id) => {
    const { rows } = await pool.query(
        `SELECT * FROM bank_details WHERE id = $1`,
        [id]
    );

    return rows[0];
};

/* ================= UPDATE ================= */
export const updateBankDetailsModel = async (id, data) => {
    const query = `
        UPDATE bank_details
        SET
            bank_name = COALESCE($1, bank_name),
            account_holder_name = COALESCE($2, account_holder_name),
            account_number = COALESCE($3, account_number),
            ifsc_code = COALESCE($4, ifsc_code),
            branch_name = COALESCE($5, branch_name),
            bank_proof = COALESCE($6, bank_proof),
            updated_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
        WHERE id = $7
        RETURNING *;
    `;

    const values = [
        data.bank_name || null,
        data.account_holder_name || null,
        data.account_number || null,
        data.ifsc_code || null,
        data.branch_name || null,
        data.bank_proof || null,
        id
    ];

    const { rows } = await pool.query(query, values);
    return rows[0];
};
