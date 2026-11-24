import { pool } from "../../database.js";

/* =========================================================
   CREATE LEAVE PRIOR TABLE
========================================================= */
export const initializeLeavePriorTable = async () => {
    const query = `
        CREATE TABLE IF NOT EXISTS leave_prior (
            id SERIAL PRIMARY KEY,

            setting_name VARCHAR(255) NOT NULL
                DEFAULT 'Leave Prior Notice',

            prior_days_required INTEGER NOT NULL
                DEFAULT 0,

            created_at TIMESTAMP DEFAULT (
                CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata'
            ),

            updated_at TIMESTAMP DEFAULT (
                CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata'
            )
        );
    `;

    await pool.query(query);

    // Insert default setting if it does not already exist
    await pool.query(`
        INSERT INTO leave_prior (
            setting_name,
            prior_days_required
        )
        SELECT
            'Leave Prior Notice',
            0
        WHERE NOT EXISTS (
            SELECT 1
            FROM leave_prior
            WHERE LOWER(TRIM(setting_name))
                = LOWER(TRIM('Leave Prior Notice'))
        );
    `);

    console.log("✅ Leave prior table initialized");
};

/* =========================================================
   GET LEAVE PRIOR
========================================================= */
export const getLeavePriorModel = async () => {
    const query = `
        SELECT
            id,
            setting_name,
            prior_days_required,
            created_at,
            updated_at
        FROM leave_prior
        ORDER BY id ASC
    `;

    const { rows } = await pool.query(query);

    return rows;
};

export const getPriorDaysRequired = async () => {

    const { rows } = await pool.query(
        `
        SELECT prior_days_required
        FROM leave_prior
        ORDER BY id ASC
        LIMIT 1
        `
    );

    return Number(
        rows[0]?.prior_days_required || 0
    );
};

/* =========================================================
   UPDATE ONLY PRIOR DAYS
========================================================= */
export const updatePriorDaysModel = async (
    id,
    prior_days_required
) => {
    const query = `
        UPDATE leave_prior
        SET
            prior_days_required = $1,
            updated_at = CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata'
        WHERE id = $2
        RETURNING
            id,
            setting_name,
            prior_days_required,
            created_at,
            updated_at
    `;

    const { rows } = await pool.query(query, [
        prior_days_required,
        id
    ]);

    return rows[0] || null;
};