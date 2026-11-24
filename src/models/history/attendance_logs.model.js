import { pool } from "../../config/db.js";

/* ================= CREATE ATTENDANCE LOG TABLE ================= */
export const initializeAttendanceLogsTable = async () => {
    const query = `
        CREATE TABLE IF NOT EXISTS attendance_logs (
            id SERIAL PRIMARY KEY,
            type VARCHAR(20) NOT NULL,
            employee_id VARCHAR(50),
            username VARCHAR(255),
            user_at VARCHAR(255),
            old_value TEXT,
            new_value TEXT,
            created_at TIMESTAMP DEFAULT TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP),
            updated_at TIMESTAMP DEFAULT TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
        );
    `;

    await pool.query(query);

    await pool.query(`
        SELECT setval(
            pg_get_serial_sequence('attendance_logs', 'id'),
            COALESCE((SELECT MAX(id) FROM attendance_logs), 1),
            true
        );
    `);

    console.log("✅ Attendance Logs Table Ready");
};

/* ================= FORMAT TIME ONLY ================= */
const formatTimeOnly = (value) => {
    if (!value) return null;

    const date = new Date(value);

    if (isNaN(date.getTime())) {
        return value; // if already plain string, return as it is
    }

    return date.toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
    });
};

/* ================= FORMAT EDIT VALUE ================= */
const formatEditValue = (value) => {
    const parts = [];

    if (value.entry_at !== undefined) {
        parts.push(`entry_at: ${formatTimeOnly(value.entry_at) ?? "null"}`);
    }

    if (value.exit_at !== undefined) {
        parts.push(`exit_at: ${formatTimeOnly(value.exit_at) ?? "null"}`);
    }

    if (value.duration !== undefined) {
        parts.push(`duration: ${value.duration ?? "null"}`);
    }

    if (value.status !== undefined) {
        parts.push(`status: ${value.status ?? "null"}`);
    }

    if (value.message !== undefined) {
        parts.push(`message: ${value.message ?? "null"}`);
    }

    return parts.join(", ");
};

/* ================= ADD ATTENDANCE LOG ================= */
export const addAttendanceLogModel = async ({
    type,
    employee_id = null,
    username = null,
    user_at = null,
    old_value = null,
    new_value = null
}) => {
    let finalOldValue = null;
    let finalNewValue = null;

    /* ================= ADD ================= */
    if (type === "add") {
        finalOldValue = null;
        finalNewValue = new_value ? JSON.stringify({
            ...new_value,
            entry_at: formatTimeOnly(new_value.entry_at),
            exit_at: formatTimeOnly(new_value.exit_at)
        }) : null;
    }

    /* ================= DELETE ================= */
    else if (type === "delete") {
        finalOldValue = old_value ? JSON.stringify({
            ...old_value,
            entry_at: formatTimeOnly(old_value.entry_at),
            exit_at: formatTimeOnly(old_value.exit_at)
        }) : null;
        finalNewValue = null;
    }

    /* ================= EDIT ================= */
    else if (type === "edit") {
        finalOldValue = old_value ? formatEditValue(old_value) : null;
        finalNewValue = new_value ? formatEditValue(new_value) : null;
    }

    const { rows } = await pool.query(
        `
            INSERT INTO attendance_logs
            (
                type,
                employee_id,
                username,
                user_at,
                old_value,
                new_value
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *;
        `,
        [
            type,
            employee_id,
            username,
            user_at,
            finalOldValue,
            finalNewValue
        ]
    );

    return rows[0];
};

/* ================= GET ATTENDANCE LOGS ================= */
export const getAttendanceLogsModel = async ({
    id = null,
    type = null,
    employee_id = null,
    username = null,
    user_at = null,
    work_location = null,
    from_date = null,
    to_date = null,
    from_time = null,
    to_time = null,
    page = 1,
    limit = 20
}) => {
    page = Number(page) || 1;
    limit = Number(limit) || 20;
    const offset = (page - 1) * limit;

    /* =========================================================
       MAIN QUERY
    ========================================================= */
    let query = `
        SELECT
            al.id,
            al.type,
            al.employee_id,
            al.username,
            al.user_at,

            ed.work_location AS work_location_id,
            wl.location AS work_location,

            al.old_value,
            al.new_value,

            TO_CHAR(
                al.created_at AT TIME ZONE 'Asia/Kolkata',
                'DD-MM-YYYY HH24:MI:SS'
            ) AS created_at,

            TO_CHAR(
                al.updated_at AT TIME ZONE 'Asia/Kolkata',
                'DD-MM-YYYY HH24:MI:SS'
            ) AS updated_at

        FROM attendance_logs al

        LEFT JOIN personal_details pd
            ON LOWER(TRIM(pd.username))
             = LOWER(TRIM(al.username))

        LEFT JOIN employment_details ed
            ON ed.personal_details_id = pd.id

        LEFT JOIN work_location wl
            ON wl.id = ed.work_location

        WHERE 1 = 1
    `;

    /* =========================================================
       COUNT QUERY
    ========================================================= */
    let countQuery = `
        SELECT COUNT(*)::INT AS total

        FROM attendance_logs al

        LEFT JOIN personal_details pd
            ON LOWER(TRIM(pd.username))
             = LOWER(TRIM(al.username))

        LEFT JOIN employment_details ed
            ON ed.personal_details_id = pd.id

        LEFT JOIN work_location wl
            ON wl.id = ed.work_location

        WHERE 1 = 1
    `;

    const values = [];
    const countValues = [];

    let count = 1;

    /* =========================================================
       ID FILTER
    ========================================================= */
    if (
        id !== null &&
        id !== undefined &&
        String(id).trim() !== ""
    ) {

        query += `
            AND al.id = $${count}
        `;

        countQuery += `
            AND al.id = $${count}
        `;

        values.push(id);
        countValues.push(id);

        count++;
    }

    /* =========================================================
       TYPE FILTER
    ========================================================= */
    if (
        type !== null &&
        type !== undefined &&
        String(type).trim() !== ""
    ) {

        query += `
            AND al.type = $${count}
        `;

        countQuery += `
            AND al.type = $${count}
        `;

        values.push(type);
        countValues.push(type);

        count++;
    }

    /* =========================================================
       EMPLOYEE ID FILTER
    ========================================================= */
    if (
        employee_id !== null &&
        employee_id !== undefined &&
        String(employee_id).trim() !== ""
    ) {

        query += `
            AND al.employee_id = $${count}
        `;

        countQuery += `
            AND al.employee_id = $${count}
        `;

        values.push(employee_id);
        countValues.push(employee_id);

        count++;
    }

    /* =========================================================
       USERNAME FILTER
    ========================================================= */
    if (
        username !== null &&
        username !== undefined &&
        String(username).trim() !== ""
    ) {

        query += `
            AND al.username ILIKE $${count}
        `;

        countQuery += `
            AND al.username ILIKE $${count}
        `;

        values.push(`%${username}%`);
        countValues.push(`%${username}%`);

        count++;
    }

    /* =========================================================
       USER AT FILTER
    ========================================================= */
    if (
        user_at !== null &&
        user_at !== undefined &&
        String(user_at).trim() !== ""
    ) {

        query += `
            AND al.user_at ILIKE $${count}
        `;

        countQuery += `
            AND al.user_at ILIKE $${count}
        `;

        values.push(`%${user_at}%`);
        countValues.push(`%${user_at}%`);

        count++;
    }

    /* =========================================================
       WORK LOCATION
    ========================================================= */
    if (
        work_location !== null &&
        work_location !== undefined &&
        String(work_location).trim() !== ""
    ) {
        const locationValue = String(work_location).trim();
        const locationId = Number(locationValue);

        /* ================= LOCATION ID ================= */
        if (
            Number.isInteger(locationId) &&
            locationId > 0
        ) {

            query += `
                AND ed.work_location = $${count}
            `;

            countQuery += `
                AND ed.work_location = $${count}
            `;

            values.push(locationId);
            countValues.push(locationId);

            count++;

        }

        /* ================= LOCATION NAME ================= */
        else {

            query += `
                AND LOWER(TRIM(wl.location::TEXT))
                    = LOWER(TRIM($${count}))
            `;

            countQuery += `
                AND LOWER(TRIM(wl.location::TEXT))
                    = LOWER(TRIM($${count}))
            `;

            values.push(locationValue);
            countValues.push(locationValue);

            count++;
        }
    }

    /* =========================================================
       FROM DATE
    ========================================================= */
    if (
        from_date !== null &&
        from_date !== undefined &&
        String(from_date).trim() !== ""
    ) {

        query += `
            AND DATE(
                al.created_at AT TIME ZONE 'Asia/Kolkata'
            ) >= $${count}::date
        `;

        countQuery += `
            AND DATE(
                al.created_at AT TIME ZONE 'Asia/Kolkata'
            ) >= $${count}::date
        `;

        values.push(from_date);
        countValues.push(from_date);

        count++;
    }

    /* =========================================================
       TO DATE
    ========================================================= */
    if (
        to_date !== null &&
        to_date !== undefined &&
        String(to_date).trim() !== ""
    ) {

        query += `
            AND DATE(
                al.created_at AT TIME ZONE 'Asia/Kolkata'
            ) <= $${count}::date
        `;

        countQuery += `
            AND DATE(
                al.created_at AT TIME ZONE 'Asia/Kolkata'
            ) <= $${count}::date
        `;

        values.push(to_date);
        countValues.push(to_date);

        count++;
    }

    /* =========================================================
       FROM TIME
    ========================================================= */
    if (
        from_time !== null &&
        from_time !== undefined &&
        String(from_time).trim() !== ""
    ) {

        query += `
            AND (
                al.created_at AT TIME ZONE 'Asia/Kolkata'
            )::time >= $${count}::time
        `;

        countQuery += `
            AND (
                al.created_at AT TIME ZONE 'Asia/Kolkata'
            )::time >= $${count}::time
        `;

        values.push(from_time);
        countValues.push(from_time);

        count++;
    }

    /* =========================================================
       TO TIME
    ========================================================= */
    if (
        to_time !== null &&
        to_time !== undefined &&
        String(to_time).trim() !== ""
    ) {

        query += `
            AND (
                al.created_at AT TIME ZONE 'Asia/Kolkata'
            )::time <= $${count}::time
        `;

        countQuery += `
            AND (
                al.created_at AT TIME ZONE 'Asia/Kolkata'
            )::time <= $${count}::time
        `;

        values.push(to_time);
        countValues.push(to_time);

        count++;
    }

    /* =========================================================
       PAGINATION
    ========================================================= */
    query += `
        ORDER BY al.id DESC
        LIMIT $${count}
        OFFSET $${count + 1}
    `;

    values.push(limit);
    values.push(offset);

    /* =========================================================
       EXECUTE
    ========================================================= */
    const [
        { rows },
        { rows: totalRows }
    ] = await Promise.all([
        pool.query(query, values),
        pool.query(countQuery, countValues)
    ]);

    const total = Number(totalRows[0]?.total || 0);

    return {
        rows,
        pagination: {
            enabled: true,
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit)
        }
    };
};

/* ================= GET ATTENDANCE LOG BY ID ================= */
export const getAttendanceLogByIdModel = async (id) => {
    const { rows } = await pool.query(
        `
        SELECT
            id,
            type,
            employee_id,
            username,
            user_at,
            old_value,
            new_value,
            TO_CHAR(created_at AT TIME ZONE 'Asia/Kolkata', 'DD-MM-YYYY HH24:MI:SS') AS created_at,
            TO_CHAR(updated_at AT TIME ZONE 'Asia/Kolkata', 'DD-MM-YYYY HH24:MI:SS') AS updated_at
        FROM attendance_logs
        WHERE id = $1
        LIMIT 1
        `,
        [id]
    );

    return rows[0];
};