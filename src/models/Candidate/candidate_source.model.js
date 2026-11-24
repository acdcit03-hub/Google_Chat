import { pool } from "../../database.js";

/* =========================================================
   INITIALIZE CANDIDATE SOURCE TABLE
========================================================= */
export const initializeCandidateSourceTable = async () => {
    const query = `
        CREATE TABLE IF NOT EXISTS candidate_source (
            id SERIAL PRIMARY KEY,
            source_name VARCHAR(255) NOT NULL UNIQUE,
            created_by VARCHAR(255),
            created_at TIMESTAMP DEFAULT TIMEZONE(
                'Asia/Kolkata',
                CURRENT_TIMESTAMP
            ),

            updated_at TIMESTAMP DEFAULT TIMEZONE(
                'Asia/Kolkata',
                CURRENT_TIMESTAMP
            )
        );
    `;

    await pool.query(query);

    console.log("✅ Candidate Source Table Ready");
};


/* =========================================================
   CREATE CANDIDATE SOURCE
========================================================= */
export const createCandidateSourceModel = async ({
    source_name,
    created_by = null
}) => {

    const query = `
        INSERT INTO candidate_source
        (
            source_name,
            created_by
        )
        VALUES
        (
            $1,
            $2
        )
        RETURNING *;
    `;

    const values = [
        source_name,
        created_by
    ];

    const result = await pool.query(
        query,
        values
    );

    return result.rows[0];
};


/* =========================================================
   GET ALL CANDIDATE SOURCES
========================================================= */
export const getCandidateSourceModel = async ({
    source_name = null,
} = {}) => {

    let query = `
        SELECT
            id,
            source_name,
            created_by,
            created_at,
            updated_at

        FROM candidate_source

        WHERE 1 = 1
    `;

    const values = [];
    let index = 1;

    /* ================= SOURCE NAME ================= */
    if (source_name) {

        query += `
            AND LOWER(TRIM(source_name))
                LIKE LOWER(TRIM($${index}))
        `;

        values.push(`%${source_name}%`);
        index++;
    }

    query += `
        ORDER BY id ASC
    `;

    const result = await pool.query(
        query,
        values
    );

    return result.rows;
};


/* =========================================================
   GET CANDIDATE SOURCE BY ID
========================================================= */
export const getCandidateSourceByIdModel = async (id) => {

    const query = `
        SELECT
            id,
            source_name,
            created_by,
            created_at,
            updated_at

        FROM candidate_source

        WHERE id = $1
    `;

    const result = await pool.query(
        query,
        [id]
    );

    return result.rows[0];
};


/* =========================================================
   UPDATE CANDIDATE SOURCE
========================================================= */
export const updateCandidateSourceModel = async (
    id,
    {
        source_name,
    }
) => {

    const query = `
        UPDATE candidate_source

        SET
            source_name = $1,
            updated_at = TIMEZONE(
                'Asia/Kolkata',
                CURRENT_TIMESTAMP
            )

        WHERE id = $2

        RETURNING *;
    `;

    const values = [
        source_name,
        id
    ];

    const result = await pool.query(
        query,
        values
    );

    return result.rows[0];
};