import { pool } from "../../database.js";

/* ================= CREATE Setting LOG TABLE ================= */
export const initializeSettingLogsTable = async () => {
    const query = `
        CREATE TABLE IF NOT EXISTS setting_edit_log (
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
    `;

    await pool.query(query);

    await pool.query(`
        SELECT setval(
            pg_get_serial_sequence('setting_edit_log', 'id'),
            COALESCE((SELECT MAX(id) FROM setting_edit_log), 1),
            true
        );
    `);

    console.log("✅ Setting Logs Table Ready");
};

/* ================= ADD SETTING EDIT LOG ================= */
export const addSettingEditLogModel = async ({
    table_name,
    record_id,
    username = null,
    edited_by = null,
    field_name,
    old_value = null,
    new_value = null
}) => {
    const query = `
        INSERT INTO setting_edit_log (
            table_name,
            record_id,
            username,
            edited_by,
            field_name,
            old_value,
            new_value
        )
        VALUES (
            $1, $2, $3, $4, $5, $6, $7
        )
        RETURNING *;
    `;

    const values = [
        table_name,
        record_id,
        username,
        edited_by,
        field_name,
        old_value,
        new_value
    ];

    const { rows } = await pool.query(query, values);

    return rows[0];
};

/* ================= GET SETTING EDIT LOG ================= */
export const getSettingEditLogModel = async ({
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

    let whereQuery = `
        WHERE 1 = 1
    `;

    /* ================= TABLE NAME ================= */
    if (table_name) {
        whereQuery += `
            AND LOWER(TRIM(table_name))
                = LOWER(TRIM($${index}))
        `;

        values.push(String(table_name).trim());
        index++;
    }

    /* ================= RECORD ID ================= */
    if (
        record_id !== null &&
        record_id !== undefined &&
        record_id !== ""
    ) {
        whereQuery += `
            AND record_id = $${index}
        `;

        values.push(Number(record_id));
        index++;
    }

    /* ================= USERNAME ================= */
    if (username) {
        whereQuery += `
            AND LOWER(TRIM(username))
                = LOWER(TRIM($${index}))
        `;

        values.push(String(username).trim());
        index++;
    }

    /* ================= EDITED BY ================= */
    if (edited_by) {
        whereQuery += `
            AND LOWER(TRIM(edited_by))
                = LOWER(TRIM($${index}))
        `;

        values.push(String(edited_by).trim());
        index++;
    }

    /* ================= FIELD NAME ================= */
    if (field_name) {
        whereQuery += `
            AND LOWER(TRIM(field_name))
                = LOWER(TRIM($${index}))
        `;

        values.push(String(field_name).trim());
        index++;
    }

    /* ================= FROM DATE ================= */
    if (from_date) {
        whereQuery += `
            AND created_at::DATE >= $${index}
        `;

        values.push(from_date);
        index++;
    }

    /* ================= TO DATE ================= */
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
                table_name,
                record_id,
                username,
                edited_by,
                field_name,
                old_value,
                new_value,
                created_at
            FROM setting_edit_log

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
        FROM setting_edit_log
        ${whereQuery}
    `;

    const countResult = await pool.query(
        countQuery,
        values
    );

    const totalRecords = countResult.rows[0].total;

    /* =====================================================
       PAGINATION
    ===================================================== */
    const offset = (page - 1) * limit;

    /* =====================================================
       GET PAGINATED DATA
    ===================================================== */
    const dataQuery = `
        SELECT
            id,
            table_name,
            record_id,
            username,
            edited_by,
            field_name,
            old_value,
            new_value,
            created_at
        FROM setting_edit_log

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