import { pool } from "../../database.js";

/* ================= CREATE Calender LOG TABLE ================= */
export const initializeCalendarEditLogTable = async () => {
    const query = `
        CREATE TABLE IF NOT EXISTS calendar_edit_log (
            id SERIAL PRIMARY KEY,
            table_name VARCHAR(100) NOT NULL,
            record_id INTEGER,
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
            field_name VARCHAR(100),
            old_value JSONB,
            new_value JSONB,
            calendar_date DATE,
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
            pg_get_serial_sequence('calendar_edit_log', 'id'),
            COALESCE((SELECT MAX(id) FROM calendar_edit_log), 1),
            true
        );
    `);

    console.log("✅ Calendar Logs Table Ready");
};

/* ================= ADD CALENDAR EDIT LOG ================= */
export const addCalendarEditLogModel = async ({
    table_name,
    record_id = null,
    username = null,
    edited_by = null,
    action,
    field_name = null,
    old_value = null,
    new_value = null,
    calendar_date = null,
    description = null
}) => {

    const { rows } = await pool.query(
        `
        INSERT INTO calendar_edit_log
        (
            table_name,
            record_id,
            username,
            edited_by,
            action,
            field_name,
            old_value,
            new_value,
            calendar_date,
            description
        )
        VALUES
        (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7::jsonb,
            $8::jsonb,
            $9,
            $10
        )
        RETURNING *;
        `,
        [
            table_name,
            record_id,
            username,
            edited_by,
            action,
            field_name,
            old_value !== null &&
                old_value !== undefined
                ? JSON.stringify(old_value)
                : null,

            new_value !== null &&
                new_value !== undefined
                ? JSON.stringify(new_value)
                : null,
            calendar_date,
            description
        ]
    );

    return rows[0];
};

/* ================= GET CALENDAR EDIT LOGS ================= */
export const getCalendarEditLogsModel = async ({
    table_name = null,
    record_id = null,
    username = null,
    edited_by = null,
    action = null,
    calendar_date = null,
    page = 1,
    limit = 20,
    pagination = true
} = {}) => {

    const values = [];
    let count = 1;

    let whereQuery = `
        WHERE 1 = 1
    `;

    /* ================= TABLE NAME ================= */
    if (
        table_name !== null &&
        table_name !== undefined &&
        String(table_name).trim() !== ""
    ) {
        whereQuery += `
            AND LOWER(TRIM(table_name))
                = LOWER(TRIM($${count}))
        `;

        values.push(
            String(table_name).trim()
        );

        count++;
    }

    /* ================= RECORD ID ================= */
    if (
        record_id !== null &&
        record_id !== undefined &&
        String(record_id).trim() !== ""
    ) {
        whereQuery += `
            AND record_id = $${count}
        `;

        values.push(
            Number(record_id)
        );

        count++;
    }

    /* ================= USERNAME ================= */
    if (
        username !== null &&
        username !== undefined &&
        String(username).trim() !== ""
    ) {
        whereQuery += `
            AND LOWER(TRIM(username))
                = LOWER(TRIM($${count}))
        `;

        values.push(
            String(username).trim()
        );

        count++;
    }

    /* ================= EDITED BY ================= */
    if (
        edited_by !== null &&
        edited_by !== undefined &&
        String(edited_by).trim() !== ""
    ) {
        whereQuery += `
            AND LOWER(TRIM(edited_by))
                LIKE '%' || LOWER(TRIM($${count})) || '%'
        `;

        values.push(String(edited_by).trim());

        count++;
    }

    /* ================= ACTION ================= */
    if (
        action !== null &&
        action !== undefined &&
        String(action).trim() !== ""
    ) {
        whereQuery += `
            AND action = $${count}
        `;

        values.push(
            String(action)
                .trim()
                .toUpperCase()
        );

        count++;
    }

    /* ================= CALENDAR DATE ================= */
    if (
        calendar_date !== null &&
        calendar_date !== undefined &&
        String(calendar_date).trim() !== ""
    ) {
        whereQuery += `
            AND calendar_date = $${count}::date
        `;

        values.push(
            String(calendar_date).trim()
        );

        count++;
    }

    /* =====================================================
       WITHOUT PAGINATION
    ===================================================== */
    if (!pagination) {

        const query = `
            SELECT
                id,
                table_name,
                record_id,
                username,
                edited_by,
                action,
                field_name,
                old_value,
                new_value,
                calendar_date,
                description,
                created_at
            FROM calendar_edit_log
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
       COUNT
    ===================================================== */
    const countQuery = `
        SELECT
            COUNT(*)::INTEGER AS total
        FROM calendar_edit_log
        ${whereQuery}
    `;

    const countResult = await pool.query(
        countQuery,
        values
    );

    const totalRecords = countResult.rows[0].total;

    /* ================= OFFSET ================= */
    const offset = (Number(page) - 1) * Number(limit);

    /* =====================================================
       DATA QUERY
    ===================================================== */
    const dataQuery = `
        SELECT
            id,
            table_name,
            record_id,
            username,
            edited_by,
            action,
            field_name,
            old_value,
            new_value,
            calendar_date,
            description,
            created_at
        FROM calendar_edit_log
        ${whereQuery}
        ORDER BY created_at DESC, id DESC
        LIMIT $${count}
        OFFSET $${count + 1}
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