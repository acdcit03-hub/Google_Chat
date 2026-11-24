import { pool } from "../../database.js";

/* =========================================================
   INITIALIZE EMPLOYEE EDIT LOG TABLE
========================================================= */
export const initializeEmployeeEditLogTable = async () => {
    const query = `
        CREATE TABLE IF NOT EXISTS employee_edit_log (
            id SERIAL PRIMARY KEY,
            personal_details_id INTEGER,
            username VARCHAR(255),
            edited_by VARCHAR(255),
            action VARCHAR(20) NOT NULL
                CHECK (
                    action IN (
                        'CREATE',
                        'UPDATE',
                        'DELETE'
                    )
                ),

            old_value JSONB,
            new_value JSONB,
            description TEXT,
            created_at TIMESTAMP
                DEFAULT TIMEZONE(
                    'Asia/Kolkata',
                    CURRENT_TIMESTAMP
                )
        );
    `;

    await pool.query(query);

    await pool.query(`
        SELECT setval(
            pg_get_serial_sequence('employee_edit_log', 'id'),
            COALESCE(
                (SELECT MAX(id) FROM employee_edit_log),
                1
            ),
            true
        );
    `);

    console.log("✅ Employee Edit Log Table Ready");
};


/* =========================================================
   ADD EMPLOYEE EDIT LOG
========================================================= */
export const addEmployeeEditLogModel = async ({
    personal_details_id = null,
    username = null,
    edited_by = null,
    action,
    old_value = null,
    new_value = null,
    description = null
}) => {

    const query = `
        INSERT INTO employee_edit_log
        (
            personal_details_id,
            username,
            edited_by,
            action,
            old_value,
            new_value,
            description
        )
        VALUES
        (
            $1,
            $2,
            $3,
            $4,
            $5::jsonb,
            $6::jsonb,
            $7
        )
        RETURNING *;
    `;

    const values = [
        personal_details_id !== null
            ? Number(personal_details_id)
            : null,

        username,
        edited_by,
        action,
        old_value !== null &&
        old_value !== undefined
            ? JSON.stringify(old_value)
            : null,

        new_value !== null &&
        new_value !== undefined
            ? JSON.stringify(new_value)
            : null,

        description
    ];

    const { rows } = await pool.query(
        query,
        values
    );

    return rows[0];
};

/* =========================================================
   GET EMPLOYEE EDIT LOG
========================================================= */
export const getEmployeeEditLogModel = async ({
    personal_details_id = null,
    username = null,
    edited_by = null,
    action = null,
    from_date = null,
    to_date = null,
    page = 1,
    limit = 20,
    pagination = true
}) => {

    const values = [];
    let index = 1;

    let whereQuery = `
        WHERE 1 = 1
    `;

    /* =====================================================
       PERSONAL DETAILS ID
    ===================================================== */
    if (
        personal_details_id !== null &&
        personal_details_id !== undefined &&
        personal_details_id !== ""
    ) {
        whereQuery += `
            AND personal_details_id = $${index}
        `;

        values.push(Number(personal_details_id));
        index++;
    }

    /* =====================================================
       USERNAME
    ===================================================== */
    if (username) {

        whereQuery += `
            AND LOWER(TRIM(username))
                = LOWER(TRIM($${index}))
        `;

        values.push(String(username).trim());
        index++;
    }

    /* =====================================================
       EDITED BY
    ===================================================== */
    if (edited_by) {

        whereQuery += `
            AND LOWER(TRIM(edited_by))
                = LOWER(TRIM($${index}))
        `;

        values.push(String(edited_by).trim());
        index++;
    }

    /* =====================================================
       ACTION
    ===================================================== */
    if (action) {

        whereQuery += `
            AND action = $${index}
        `;

        values.push(
            String(action).toUpperCase()
        );

        index++;
    }

    /* =====================================================
       FROM DATE
    ===================================================== */
    if (from_date) {

        whereQuery += `
            AND created_at::DATE >= $${index}
        `;

        values.push(from_date);
        index++;
    }

    /* =====================================================
       TO DATE
    ===================================================== */
    if (to_date) {

        whereQuery += `
            AND created_at::DATE <= $${index}
        `;

        values.push(to_date);
        index++;
    }

    /* =====================================================
       PAGINATION FALSE
       GET ALL RECORDS
    ===================================================== */
    if (!pagination) {

        const query = `
            SELECT
                id,
                personal_details_id,
                username,
                edited_by,
                action,
                old_value,
                new_value,
                description,
                created_at

            FROM employee_edit_log

            ${whereQuery}

            ORDER BY created_at DESC, id DESC
        `;

        const { rows } = await pool.query(
            query,
            values
        );

        return {
            data: rows,
            totalRecords: rows.length
        };
    }

    /* =====================================================
       GET TOTAL RECORDS
    ===================================================== */
    const countQuery = `
        SELECT COUNT(*)::INTEGER AS total
        FROM employee_edit_log

        ${whereQuery}
    `;

    const countResult = await pool.query(
        countQuery,
        values
    );

    const totalRecords = countResult.rows[0].total;

    /* =====================================================
       OFFSET
    ===================================================== */
    const offset = (Number(page) - 1) * Number(limit);

    /* =====================================================
       GET PAGINATED DATA
    ===================================================== */
    const dataQuery = `
        SELECT
            id,
            personal_details_id,
            username,
            edited_by,
            action,
            old_value,
            new_value,
            description,
            created_at

        FROM employee_edit_log

        ${whereQuery}

        ORDER BY created_at DESC, id DESC

        LIMIT $${index}
        OFFSET $${index + 1}
    `;

    const dataValues = [
        ...values,
        Number(limit),
        Number(offset)
    ];

    const { rows } = await pool.query(
        dataQuery,
        dataValues
    );

    return {
        data: rows,
        totalRecords
    };
};