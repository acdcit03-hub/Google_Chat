import { pool } from "../../database.js";

export const initializeDeviceVersionLogsTable = async () => {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS device_version_logs (
            id SERIAL PRIMARY KEY,
            mac_id VARCHAR(50) NOT NULL,
            old_version VARCHAR(30),
            new_version VARCHAR(30) NOT NULL,
            updated_at TIMESTAMP DEFAULT TIMEZONE(
                'Asia/Kolkata',
                CURRENT_TIMESTAMP
            )
        );
    `);

    // Reset sequence to MAX(id)
    await pool.query(`
        SELECT setval(
            pg_get_serial_sequence('device_version_logs', 'id'),
            COALESCE(
                (SELECT MAX(id) FROM device_version_logs),
                1
            ),
            true
        );
    `);

    console.log("✅ device_version_logs table ready");
};

export const updateDeviceVersionModel = async (
    mac_id,
    version,
    ip_address = null
) => {
    /* =========================================================
       VALIDATE MAC ID
       ========================================================= */
    if (
        !mac_id ||
        String(mac_id).trim() === ""
    ) {
        return;
    }

    const cleanMacId = String(mac_id).trim();

    /* =========================================================
       CHECK DEVICE EXISTS
       ========================================================= */
    const current = await pool.query(
        `
            SELECT
                version
            FROM device_configurations
            WHERE LOWER(TRIM(mac_id))
                = LOWER(TRIM($1))
            LIMIT 1
        `,
        [cleanMacId]
    );

    /* =========================================================
       DEVICE NOT REGISTERED
       -> DO NOT CREATE VERSION LOG
       -> DO NOT UPDATE device_configurations
       ========================================================= */
    if (current.rows.length === 0) {
        console.log(`⚠ Device not found in device_configurations -> ${cleanMacId}`);
        return;
    }

    const oldVersion = current.rows[0].version;

    /* =========================================================
       VERSION NOT PROVIDED
       -> ONLY UPDATE IP + ONLINE STATUS
       ========================================================= */
    if (!version) {
        await pool.query(
            `
                UPDATE device_configurations
                SET
                    ip_address = COALESCE($1, ip_address),
                    connection = 'online',
                    updated_at = TIMEZONE(
                        'Asia/Kolkata',
                        CURRENT_TIMESTAMP
                    )
                WHERE LOWER(TRIM(mac_id))
                    = LOWER(TRIM($2))
            `,
            [
                ip_address,
                cleanMacId
            ]
        );

        return;
    }

    /* =========================================================
       VERSION CHANGED
       -> SAVE VERSION LOG
       ========================================================= */
    if (oldVersion !== version) {
        await pool.query(
            `
                INSERT INTO device_version_logs
                (
                    mac_id,
                    old_version,
                    new_version
                )
                VALUES ($1, $2, $3)
            `,
            [
                cleanMacId,
                oldVersion,
                version
            ]
        );
    }

    /* =========================================================
       UPDATE REGISTERED DEVICE
       ========================================================= */
    await pool.query(
        `
            UPDATE device_configurations
            SET
                version = $1,
                ip_address = COALESCE($2, ip_address),
                connection = 'online',
                updated_at = TIMEZONE(
                    'Asia/Kolkata',
                    CURRENT_TIMESTAMP
                )
            WHERE LOWER(TRIM(mac_id))
                = LOWER(TRIM($3))
        `,
        [
            version,
            ip_address,
            cleanMacId
        ]
    );
};

/* =========================================================
   GET DEVICE VERSION LOGS
========================================================= */
export const getDeviceVersionLogsModel = async ({
    mac_id = null,
    old_version = null,
    new_version = null,
    from_date = null,
    to_date = null,
    page = 1,
    limit = 20,
    pagination = true
} = {}) => {

    const values = [];
    let count = 1;

    let whereQuery = `
        WHERE 1 = 1
    `;

    /* ================= MAC ID ================= */
    if (
        mac_id !== null &&
        mac_id !== undefined &&
        String(mac_id).trim() !== ""
    ) {
        whereQuery += `
            AND LOWER(TRIM(mac_id))
                LIKE '%' || LOWER(TRIM($${count})) || '%'
        `;

        values.push(String(mac_id).trim());

        count++;
    }

    /* ================= OLD VERSION ================= */
    if (
        old_version !== null &&
        old_version !== undefined &&
        String(old_version).trim() !== ""
    ) {
        whereQuery += `
            AND LOWER(TRIM(old_version))
                LIKE '%' || LOWER(TRIM($${count})) || '%'
        `;

        values.push(String(old_version).trim());

        count++;
    }

    /* ================= NEW VERSION ================= */
    if (
        new_version !== null &&
        new_version !== undefined &&
        String(new_version).trim() !== ""
    ) {
        whereQuery += `
            AND LOWER(TRIM(new_version))
                LIKE '%' || LOWER(TRIM($${count})) || '%'
        `;

        values.push(String(new_version).trim());

        count++;
    }

    /* ================= FROM DATE ================= */
    if (
        from_date !== null &&
        from_date !== undefined &&
        String(from_date).trim() !== ""
    ) {
        whereQuery += `
            AND updated_at::DATE >= $${count}::DATE
        `;

        values.push(String(from_date).trim());

        count++;
    }

    /* ================= TO DATE ================= */
    if (
        to_date !== null &&
        to_date !== undefined &&
        String(to_date).trim() !== ""
    ) {
        whereQuery += `
            AND updated_at::DATE <= $${count}::DATE
        `;

        values.push(String(to_date).trim());

        count++;
    }

    /* =====================================================
       WITHOUT PAGINATION
    ===================================================== */
    if (!pagination) {
        const query = `
            SELECT
                id,
                mac_id,
                old_version,
                new_version,
                updated_at
            FROM device_version_logs
            ${whereQuery}
            ORDER BY updated_at DESC, id DESC
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
        FROM device_version_logs
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
    const offset =
        (Number(page) - 1) *
        Number(limit);

    /* =====================================================
       DATA
    ===================================================== */
    const dataQuery = `
        SELECT
            id,
            mac_id,
            old_version,
            new_version,
            updated_at
        FROM device_version_logs
        ${whereQuery}
        ORDER BY updated_at DESC, id DESC
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