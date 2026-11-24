import { pool } from "../../database.js";

export const initializeUserSessionEditLogTable = async () => {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS user_session_edit_log (
            id SERIAL PRIMARY KEY,
            table_name VARCHAR(255) NOT NULL,
            record_id INTEGER NOT NULL,
            username VARCHAR(255),
            edited_by VARCHAR(255),
            field_name VARCHAR(255) NOT NULL,
            old_value TEXT,
            new_value TEXT,
            created_at TIMESTAMP DEFAULT TIMEZONE(
                'Asia/Kolkata',
                CURRENT_TIMESTAMP
            )
        );
    `);

    await pool.query(`
        SELECT setval(
            pg_get_serial_sequence('user_session_edit_log', 'id'),
            COALESCE((SELECT MAX(id) FROM user_session_edit_log), 1),
            true
        );
    `);

    console.log("✅ user_session_edit_log table ready");
};

export const addUserSessionEditLogModel = async ({
    table_name,
    record_id,
    username = null,
    edited_by = null,
    field_name,
    old_value = null,
    new_value = null
}) => {
    const { rows } = await pool.query(
        `
        INSERT INTO user_session_edit_log (
            table_name,
            record_id,
            username,
            edited_by,
            field_name,
            old_value,
            new_value
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *;
        `,
        [
            table_name,
            record_id,
            username,
            edited_by,
            field_name,
            old_value,
            new_value
        ]
    );

    return rows[0];
};

export const getUserSessionEditLogModel = async ({
    table_name = null,
    record_id = null,
    username = null,
    edited_by = null,
    field_name = null,
    from_date = null,
    to_date = null,
    page = 1,
    limit = 20,
    pagination = true
}) => {
    const values = [];
    let index = 1;
    let whereQuery = `WHERE 1 = 1`;

    if (table_name) {
        whereQuery += ` AND LOWER(TRIM(table_name)) = LOWER(TRIM($${index}))`;
        values.push(String(table_name).trim());
        index++;
    }

    if (record_id !== null && record_id !== undefined && record_id !== "") {
        whereQuery += ` AND record_id = $${index}`;
        values.push(Number(record_id));
        index++;
    }

    if (username) {
        whereQuery += ` AND LOWER(TRIM(username)) = LOWER(TRIM($${index}))`;
        values.push(String(username).trim());
        index++;
    }

    if (edited_by) {
        whereQuery += ` AND LOWER(TRIM(edited_by)) = LOWER(TRIM($${index}))`;
        values.push(String(edited_by).trim());
        index++;
    }

    if (field_name) {
        whereQuery += ` AND POSITION(LOWER(TRIM($${index})) IN LOWER(COALESCE(field_name, ''))) > 0`;
        values.push(String(field_name).trim());
        index++;
    }

    if (from_date) {
        whereQuery += ` AND created_at::DATE >= $${index}`;
        values.push(from_date);
        index++;
    }

    if (to_date) {
        whereQuery += ` AND created_at::DATE <= $${index}`;
        values.push(to_date);
        index++;
    }

    const selectSql = `
        SELECT
            id,
            table_name,
            record_id,
            username,
            edited_by,
            field_name,
            old_value,
            new_value,
            TO_CHAR(created_at, 'YYYY-MM-DD HH24:MI:SS.MS') AS created_at
        FROM user_session_edit_log
        ${whereQuery}
        ORDER BY created_at DESC, id DESC
    `;

    if (!pagination) {
        const { rows } = await pool.query(selectSql, values);
        return { data: rows, totalRecords: rows.length };
    }

    const countResult = await pool.query(
        `SELECT COUNT(*)::INTEGER AS total FROM user_session_edit_log ${whereQuery}`,
        values
    );
    const totalRecords = countResult.rows[0].total;
    const offset = (page - 1) * limit;
    const { rows } = await pool.query(
        `${selectSql} LIMIT $${index} OFFSET $${index + 1}`,
        [...values, Number(limit), Number(offset)]
    );

    return { data: rows, totalRecords };
};
