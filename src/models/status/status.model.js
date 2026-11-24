import { pool } from "../../database.js";

/* ================= CREATE TABLE ================= */
export const initializeStatusTable = async () => {
    const query = `
        CREATE TABLE IF NOT EXISTS status (
            id SERIAL PRIMARY KEY,
            status_name VARCHAR(255) NOT NULL UNIQUE,
            move_to_employee BOOLEAN DEFAULT FALSE,
            status BOOLEAN DEFAULT TRUE,
            created_by VARCHAR(255),
            created_at TIMESTAMP DEFAULT TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP),
            updated_at TIMESTAMP DEFAULT TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
        );
    `;

    await pool.query(query);

    await pool.query(`
        ALTER TABLE status
        ADD COLUMN IF NOT EXISTS move_to_employee BOOLEAN DEFAULT FALSE;
    `)

    console.log("✅ status table ready");
};

/* ================= CREATE STATUS ================= */
export const createStatusModel = async ({
    status_name,
    move_to_employee = false,
    status = true,
    created_by
}) => {
    const query = `
        INSERT INTO status
        (
            status_name,
            move_to_employee,
            status,
            created_by
        )
        VALUES ($1, $2, $3, $4)
        RETURNING *;
    `;

    const result = await pool.query(query, [
        status_name,
        move_to_employee,
        status,
        created_by
    ]);

    return result.rows[0];
};

/* ================= GET ALL STATUS ================= */
export const getStatusModel = async ({
    status_name = null,
    status = null
} = {}) => {

    let query = `
        SELECT
            id,
            status_name,
            move_to_employee,
            status,
            created_by,
            created_at,
            updated_at
        FROM status
        WHERE 1 = 1
    `;

    const values = [];
    let index = 1;

    if (status_name) {
        query += `
            AND LOWER(TRIM(status_name))
            LIKE LOWER(TRIM($${index}))
        `;

        values.push(`%${status_name}%`);
        index++;
    }

    if (
        status !== null &&
        status !== undefined &&
        status !== ""
    ) {
        query += `
            AND status = $${index}
        `;

        values.push(
            status === true ||
            status === "true" ||
            status === "1" ||
            status === 1
        );

        index++;
    }

    query += `
        ORDER BY id ASC
    `;

    const result = await pool.query(query, values);
    return result.rows;
};

/* ================= GET STATUS BY ID ================= */
export const getStatusByIdModel = async (id) => {
    const result = await pool.query(
        `
            SELECT
                id,
                status_name,
                move_to_employee,
                status,
                created_by,
                created_at,
                updated_at
            FROM status
            WHERE id = $1
        `,
        [id]
    );

    return result.rows[0];
};


/* ================= UPDATE STATUS ================= */
export const updateStatusModel = async (
    id,
    {
        status_name,
        move_to_employee
    }
) => {
    const currentResult = await pool.query(
        `
        SELECT status_name, move_to_employee
        FROM status
        WHERE id = $1;
        `,
        [id]
    );

    const currentStatus = currentResult.rows[0];

    if (!currentStatus) {
        return null;
    }

    const isStatusNameChanged =
        String(currentStatus.status_name ?? "").trim().toLowerCase() !==
        String(status_name ?? "").trim().toLowerCase();

    if (isStatusNameChanged) {

        const usedStatusResult = await pool.query(
            `
            SELECT EXISTS (
                SELECT 1
                FROM candidate c
                WHERE LOWER(TRIM(c.candidate_status)) =
                      LOWER(TRIM($1))
            ) AS is_used;
            `,
            [currentStatus.status_name]
        );

        const isUsed =
            usedStatusResult.rows[0]?.is_used === true;

        if (isUsed) {
            const error = new Error(
                "Status name cannot be changed because it is already used by candidate(s)."
            );

            error.code = "STATUS_IN_USE";

            throw error;
        }
    }

    /* =====================================================
       UPDATE STATUS NAME AND/OR MOVE TO EMPLOYEE
    ===================================================== */

    const result = await pool.query(
        `
        UPDATE status
        SET
            status_name = $1,
            move_to_employee = $2,
            updated_at = TIMEZONE(
                'Asia/Kolkata',
                CURRENT_TIMESTAMP
            )
        WHERE id = $3
        RETURNING *;
        `,
        [
            status_name,
            move_to_employee,
            id
        ]
    );

    return result.rows[0] || null;
};


/* ================= TOGGLE STATUS ================= */
export const toggleStatusModel = async (id) => {
    const result = await pool.query(
        `
            UPDATE status
            SET
                status = NOT COALESCE(status, FALSE),
                updated_at = TIMEZONE(
                    'Asia/Kolkata',
                    CURRENT_TIMESTAMP
                )
            WHERE id = $1
            RETURNING
                id,
                status_name,
                move_to_employee,
                status,
                created_by,
                created_at,
                updated_at;
        `,
        [id]
    );

    return result.rows[0] || null;
};
