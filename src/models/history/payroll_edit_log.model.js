import { pool } from "../../database.js";

export const initializePayrollEditLogTable = async () => {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS payroll_edit_log (
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
            pg_get_serial_sequence('payroll_edit_log', 'id'),
            COALESCE((SELECT MAX(id) FROM payroll_edit_log), 1),
            true
        );
    `);

    console.log("✅ payroll_edit_log table ready");
};

export const addPayrollEditLogModel = async (client, {
    table_name,
    record_id,
    username = null,
    edited_by = null,
    field_name,
    old_value = null,
    new_value = null
}) => {
    const db = client || pool;
    const { rows } = await db.query(
        `
        INSERT INTO payroll_edit_log (
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

export const getPayrollEditLogModel = async ({
    table_name = null,
    record_id = null,
    username = null,
    edited_by = null,
    field_name = null,
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
        whereQuery += ` AND LOWER(TRIM(COALESCE(${column}, ''))) = ANY($${index}::text[])`;
        values.push(items);
        index++;
    };

    const addContainsFilter = (column, value) => {
        const items = asFilterList(value);
        if (!items.length) return;
        const clauses = items.map((item) => {
            values.push(item);
            return `POSITION($${values.length} IN LOWER(COALESCE(${column}, ''))) > 0`;
        });
        whereQuery += ` AND (${clauses.join(" OR ")})`;
        index = values.length + 1;
    };

    addAnyFilter("table_name", table_name);

    if (record_id !== null && record_id !== undefined && record_id !== "") {
        whereQuery += ` AND record_id = $${index}`;
        values.push(Number(record_id));
        index++;
    }

    addAnyFilter("username", username);
    addAnyFilter("edited_by", edited_by);
    addContainsFilter("field_name", field_name);
    addContainsFilter("old_value", old_value);
    addContainsFilter("new_value", new_value);

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
        FROM payroll_edit_log
        ${whereQuery}
        ORDER BY created_at DESC, id DESC
    `;

    if (!pagination) {
        const { rows } = await pool.query(selectSql, values);
        return { data: rows, totalRecords: rows.length };
    }

    const countResult = await pool.query(
        `SELECT COUNT(*)::INTEGER AS total FROM payroll_edit_log ${whereQuery}`,
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
