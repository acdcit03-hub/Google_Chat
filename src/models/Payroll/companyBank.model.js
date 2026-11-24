
import { pool } from "../../database.js";

/* ================= CREATE / INITIALIZE COMPANY BANK TABLE ================= */
export const initializeCompanyBankTable = async () => {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        // Create table if it does not already exist
        await client.query(`
            CREATE TABLE IF NOT EXISTS company_bank_details (
                id INTEGER PRIMARY KEY,
                company_bank_name VARCHAR(150) NOT NULL DEFAULT '',
                company_bank_account_no VARCHAR(50) NOT NULL DEFAULT '',
                primary_account BOOLEAN NOT NULL DEFAULT FALSE,
                status BOOLEAN NOT NULL DEFAULT FALSE,
                created_by VARCHAR(100),
                updated_by VARCHAR(100),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Add status to existing tables without deleting existing records
        await client.query(`
            ALTER TABLE company_bank_details
            ADD COLUMN IF NOT EXISTS status BOOLEAN NOT NULL DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS primary_account BOOLEAN NOT NULL DEFAULT FALSE;
        `);

        // Create an auto-increment sequence
        await client.query(`
            CREATE SEQUENCE IF NOT EXISTS company_bank_details_id_seq;
        `);

        // Automatically generate an ID for every new bank record
        await client.query(`
            ALTER TABLE company_bank_details
            ALTER COLUMN id SET DEFAULT
            nextval('company_bank_details_id_seq');
        `);

        // Make the sequence belong to the ID column
        await client.query(`
            ALTER SEQUENCE company_bank_details_id_seq
            OWNED BY company_bank_details.id;
        `);

        // Start from the next ID after the highest existing ID
        await client.query(`
            SELECT setval(
                'company_bank_details_id_seq',
                COALESCE((SELECT MAX(id) FROM company_bank_details), 0) + 1,
                false
            );
        `);

        await client.query("COMMIT");

        console.log("Company bank table initialized with auto-generated IDs.");
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("INITIALIZE COMPANY BANK TABLE ERROR:", error);
        throw error;
    } finally {
        client.release();
    }
};

/* ================= INITIALIZE COMPANY BANK EDIT LOG TABLE ================= */
export const initializeCompanyBankDetailsLogTable = async () => {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        await client.query(`
            CREATE TABLE IF NOT EXISTS company_bank_details_log (
                id BIGSERIAL PRIMARY KEY,
                username VARCHAR(100),
                edited_by VARCHAR(100),
                field_name VARCHAR(100),
                old_value TEXT,
                new_value TEXT,
                edited_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_company_bank_details_log_username
            ON company_bank_details_log (username);
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_company_bank_details_log_edited_at
            ON company_bank_details_log (edited_at DESC);
        `);

        await client.query("COMMIT");

        console.log("Company bank edit log table initialized successfully.");
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("INITIALIZE COMPANY BANK EDIT LOG TABLE ERROR:", error);
        throw error;
    } finally {
        client.release();
    }
};

/* ================= GET ALL ================= */
export const getAllCompanyBanksModel = async () => {
    const result = await pool.query(`
        SELECT *
        FROM company_bank_details
        ORDER BY id DESC;
    `);

    return result.rows;
};

/* ================= GET BY ID ================= */
export const getCompanyBankByIdModel = async (id) => {
    const result = await pool.query(
        `
        SELECT *
        FROM company_bank_details
        WHERE id = $1;
        `,
        [id]
    );

    return result.rows[0] || null;
};

/* ================= ADD COMPANY BANK ================= */
export const addCompanyBankModel = async ({
    company_bank_name,
    company_bank_account_no,
    primary_account = false,
    created_by
}) => {
    const result = await pool.query(
        `
        INSERT INTO company_bank_details (
            company_bank_name,
            company_bank_account_no,
            primary_account,
            created_by,
            updated_by
        )
        VALUES ($1, $2, $3, $4, $4)
        RETURNING *;
        `,
        [
            company_bank_name,
            company_bank_account_no,
            primary_account,
            created_by
        ]
    );

    return result.rows[0];
};

/* ================= UPDATE COMPANY BANK WITH EDIT LOG ================= */
export const updateCompanyBankModel = async ({
    id,
    company_bank_name,
    company_bank_account_no,
    primary_account,
    updated_by
}) => {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        // Get existing bank details
        const oldBankResult = await client.query(
            `
            SELECT *
            FROM company_bank_details
            WHERE id = $1
            FOR UPDATE;
            `,
            [id]
        );

        if (oldBankResult.rows.length === 0) {
            await client.query("ROLLBACK");
            return null;
        }

        const oldBank = oldBankResult.rows[0];

        // Check whether another primary account already exists
        if (
            primary_account === true &&
            oldBank.primary_account !== true
        ) {
            const existingPrimary = await client.query(
                `
                SELECT id
                FROM company_bank_details
                WHERE primary_account = TRUE
                  AND id <> $1
                LIMIT 1;
                `,
                [id]
            );

            if (existingPrimary.rows.length > 0) {
                const error = new Error(
                    "A primary company bank account already exists. Please set the existing primary account to No before selecting another account as Yes."
                );

                error.statusCode = 409;
                throw error;
            }
        }

        // Update bank details
        const updatedResult = await client.query(
            `
            UPDATE company_bank_details
            SET
                company_bank_name = $2,
                company_bank_account_no = $3,
                primary_account = $4,
                updated_by = $5,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
            RETURNING *;
            `,
            [
                id,
                company_bank_name,
                company_bank_account_no,
                primary_account,
                updated_by
            ]
        );

        const updatedBank = updatedResult.rows[0];

        // Compare old and new values
        const fieldsToLog = [
            {
                field: "company_bank_name",
                oldValue: oldBank.company_bank_name,
                newValue: updatedBank.company_bank_name
            },
            {
                field: "company_bank_account_no",
                oldValue: oldBank.company_bank_account_no,
                newValue: updatedBank.company_bank_account_no
            },
            {
                field: "primary_account",
                oldValue: oldBank.primary_account,
                newValue: updatedBank.primary_account
            }
        ];

        // Insert one log for each changed field
        for (const field of fieldsToLog) {
            if (field.oldValue !== field.newValue) {
                await client.query(
                    `
                    INSERT INTO company_bank_details_log (
                        username,
                        edited_by,
                        field_name,
                        old_value,
                        new_value
                    )
                    VALUES ($1, $2, $3, $4, $5);
                    `,
                    [
                        String(id),
                        updated_by,
                        field.field,
                        String(field.oldValue),
                        String(field.newValue)
                    ]
                );
            }
        }

        await client.query("COMMIT");

        return updatedBank;
    } catch (error) {
        try {
            await client.query("ROLLBACK");
        } catch {}

        throw error;
    } finally {
        client.release();
    }
};

/* ================= DELETE COMPANY BANK ================= */
export const deleteCompanyBankModel = async (id) => {
    const result = await pool.query(
        `
        DELETE FROM company_bank_details
        WHERE id = $1
        RETURNING *;
        `,
        [id]
    );

    return result.rows[0] || null;
};


/* ================= TOGGLE COMPANY BANK STATUS WITH EDIT LOG ================= */
export const toggleCompanyBankStatusModel = async ({
    id,
    updated_by
}) => {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        // Get existing bank details
        const bankResult = await client.query(
            `
            SELECT id, company_bank_name, status
            FROM company_bank_details
            WHERE id = $1
            FOR UPDATE;
            `,
            [id]
        );

        if (bankResult.rows.length === 0) {
            await client.query("ROLLBACK");
            return null;
        }

        const selectedBank = bankResult.rows[0];

        // Toggle the selected bank status
        const oldStatus = selectedBank.status;
        const newStatus = !oldStatus;

        // Update bank status
        const updatedResult = await client.query(
            `
            UPDATE company_bank_details
            SET
                status = $2,
                updated_by = $3,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
            RETURNING *;
            `,
            [id, newStatus, updated_by]
        );

        const updatedBank = updatedResult.rows[0];

        // Insert status change into company_bank_details_log
        await client.query(
            `
            INSERT INTO company_bank_details_log (
                username,
                edited_by,
                field_name,
                old_value,
                new_value
            )
            VALUES ($1, $2, $3, $4, $5);
            `,
            [
                String(id),
                updated_by,
                "status",
                String(oldStatus),
                String(newStatus)
            ]
        );

        await client.query("COMMIT");

        return updatedBank;

    } catch (error) {
        try {
            await client.query("ROLLBACK");
        } catch {}

        throw error;
    } finally {
        client.release();
    }
};
