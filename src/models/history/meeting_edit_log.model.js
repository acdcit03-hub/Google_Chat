import { pool } from "../../database.js";

export const initializeMeetingEditLogTable = async () => {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS meeting_edit_log (
            id SERIAL PRIMARY KEY,
            record_id INTEGER NOT NULL,
            username VARCHAR(255),
            edited_by VARCHAR(255),
            field_name VARCHAR(255) NOT NULL,
            candidate_status VARCHAR(255),
            old_value TEXT,
            new_value TEXT,
            created_at TIMESTAMP DEFAULT TIMEZONE(
                'Asia/Kolkata',
                CURRENT_TIMESTAMP
            )
        );
    `);

    await pool.query(`
        ALTER TABLE meeting_edit_log
        ADD COLUMN IF NOT EXISTS candidate_status VARCHAR(255);
    `);

    await pool.query(`
        SELECT setval(
            pg_get_serial_sequence('meeting_edit_log', 'id'),
            COALESCE((SELECT MAX(id) FROM meeting_edit_log), 1),
            true
        );
    `);

    console.log("✅ meeting_edit_log table ready");
};

export const addMeetingEditLogModel = async ({
    record_id,
    username = null,
    edited_by = null,
    field_name,
    candidate_status = null,
    old_value = null,
    new_value = null
}) => {
    const { rows } = await pool.query(
        `
        INSERT INTO meeting_edit_log (
            record_id,
            username,
            edited_by,
            field_name,
            candidate_status,
            old_value,
            new_value
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *;
        `,
        [
            record_id,
            username,
            edited_by,
            field_name,
            candidate_status,
            old_value,
            new_value
        ]
    );

    return rows[0];
};

const asFilterList = (value) => {
    if (value == null || value === "") return [];
    const raw = Array.isArray(value) ? value : [value];
    return [...new Set(
        raw
            .flatMap(item => String(item).split(","))
            .map(item => item.trim())
            .filter(Boolean)
            .map(item => item.toLowerCase())
    )];
};

export const getMeetingEditLogModel = async ({
    record_id = null,
    username = null,
    edited_by = null,
    field_name = null,
    candidate_status = null,
    old_value = null,
    new_value = null,
    from_date = null,
    to_date = null,
    page = 1,
    limit = 20,
    pagination = true
}) => {
    const values = [];
    let index = 1;
    let whereQuery = `WHERE 1 = 1`;

    const addAnyFilter = (column, value) => {
        const items = asFilterList(value);
        if (!items.length) return;

        const clauses = items.map((item) => {
            values.push(item);
            return `LOWER(COALESCE(${column}::TEXT, '')) LIKE '%' || LOWER($${values.length}) || '%'`;
        });

        whereQuery += ` AND (${clauses.join(" OR ")})`;
        index = values.length + 1;
    };

    const addContains = (column, value) => {
        const items = asFilterList(value);
        if (!items.length) return;

        const clauses = items.map((item) => {
            values.push(item);
            return `LOWER(COALESCE(${column}::TEXT, '')) LIKE '%' || LOWER($${values.length}) || '%'`;
        });

        whereQuery += ` AND (${clauses.join(" OR ")})`;
        index = values.length + 1;
    };

    if (record_id !== null && record_id !== undefined && record_id !== "") {
        whereQuery += ` AND record_id = $${index}`;
        values.push(Number(record_id));
        index++;
    }

    addAnyFilter("username", username);
    addAnyFilter("edited_by", edited_by);
    addAnyFilter("candidate_status", candidate_status);
    addContains("field_name", field_name);
    addContains("old_value", old_value);
    addContains("new_value", new_value);

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
            record_id,
            username,
            edited_by,
            field_name,
            candidate_status,
            old_value,
            new_value,
            TO_CHAR(created_at, 'YYYY-MM-DD HH24:MI:SS.MS') AS created_at
        FROM meeting_edit_log
        ${whereQuery}
        ORDER BY created_at DESC, id DESC
    `;

    if (!pagination) {
        const { rows } = await pool.query(selectSql, values);
        return { data: rows, totalRecords: rows.length };
    }

    const countResult = await pool.query(
        `SELECT COUNT(*)::INTEGER AS total FROM meeting_edit_log ${whereQuery}`,
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
