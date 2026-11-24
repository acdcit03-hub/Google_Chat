import { pool } from "../../database.js";
import { addSettingEditLogModel } from "../history/setting_edit_log.model.js";

/* ================= CREATE TABLE ================= */
export const initializeDeviceConfigurationsTable = async () => {

    await pool.query(`SET TIME ZONE 'Asia/Kolkata';`);

    const query = `
        CREATE TABLE IF NOT EXISTS device_configurations (
          id SERIAL PRIMARY KEY,
          device_id VARCHAR(255) NOT NULL,
          mac_id VARCHAR(255) NOT NULL,
          ip_address VARCHAR(50),
          work_location VARCHAR(255),
          department VARCHAR(255),
          connection VARCHAR(20) DEFAULT 'online',
          device_name VARCHAR(255) NOT NULL,
          created_by VARCHAR(255),
          status BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMP DEFAULT TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP),
          updated_at TIMESTAMP DEFAULT TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
        );
    `;

    await pool.query(query);

    await pool.query(`
        ALTER TABLE device_configurations
        ADD COLUMN IF NOT EXISTS ip_address VARCHAR(50),
        ADD COLUMN IF NOT EXISTS version VARCHAR(30);
    `);

    await pool.query(`
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_name = 'device_configurations'
                  AND column_name = 'location'
            ) THEN
                ALTER TABLE device_configurations
                RENAME COLUMN location TO work_location;
            END IF;
        END $$;
    `);

    await pool.query(`
        ALTER TABLE device_configurations
        DROP CONSTRAINT IF EXISTS check_device_status;
    `);

    await pool.query(`
        UPDATE device_configurations dc
        SET work_location = wl.id
        FROM work_location wl
        WHERE
            dc.work_location IS NOT NULL
            AND TRIM(dc.work_location::TEXT) <> ''
            AND LOWER(TRIM(dc.work_location::TEXT))
                = LOWER(TRIM(wl.location));
    `);

    await pool.query(`
        DO $$
        BEGIN

            IF EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'device_configurations'
                  AND column_name = 'work_location'
                  AND data_type = 'character varying'
            ) THEN

                ALTER TABLE device_configurations
                ALTER COLUMN work_location TYPE INTEGER
                USING (
                    CASE
                        WHEN TRIM(work_location) ~ '^[0-9]+$'
                        THEN TRIM(work_location)::INTEGER
                        ELSE NULL
                    END
                );

            END IF;

        END
        $$;
    `);

    await pool.query(`
        SELECT setval(
            pg_get_serial_sequence('device_configurations', 'id'),
            COALESCE((SELECT MAX(id) FROM device_configurations), 1),
            true
        );
    `);

    console.log("✅ device_configurations table ready");
};

/* =====================================================
   RESOLVE WORK LOCATION
   ID OR LOCATION NAME -> ID
===================================================== */
const resolveWorkLocationId = async (work_location) => {
    if (
        work_location === null ||
        work_location === undefined ||
        String(work_location).trim() === "" ||
        String(work_location).trim().toLowerCase() === "nan"
    ) {
        return null;
    }

    const value = String(work_location).trim();

    /* ================= IF ID ================= */
    const locationId = Number(value);

    if (
        Number.isInteger(locationId) &&
        locationId > 0
    ) {

        const { rows } = await pool.query(
            `
                SELECT id
                FROM work_location
                WHERE id = $1
                LIMIT 1
            `,
            [locationId]
        );

        if (!rows.length) {
            throw new Error("Work location not found");
        }

        return rows[0].id;
    }

    /* ================= IF LOCATION NAME ================= */
    const { rows } = await pool.query(
        `
            SELECT id
            FROM work_location
            WHERE LOWER(TRIM(location))
                = LOWER(TRIM($1))
            LIMIT 1
        `,
        [value]
    );

    if (!rows.length) {
        throw new Error(`Work location "${value}" not found`);
    }

    return rows[0].id;
};

/* ================= ADD ================= */
export const addDeviceConfigurationModel = async (data) => {
    const locationId = await resolveWorkLocationId(data.work_location);

    const query = `
        INSERT INTO device_configurations
        (
            device_id,
            mac_id,
            work_location,
            department,
            status,
            connection,
            device_name,
            created_by
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        RETURNING *;
    `;

    const values = [
        data.device_id,
        data.mac_id,
        locationId,
        data.department,
        data.status ?? true,
        data.connection || "online",
        data.device_name,
        data.created_by || null
    ];

    const { rows } = await pool.query(query, values);

    return rows[0];
};

/* ================= GET ================= */
export const getAllDeviceConfigurationsModel = async (
    status = null,
    work_location = null
) => {
    let query = `
        SELECT
            dc.*,
            wl.location AS work_location
        FROM device_configurations dc

        LEFT JOIN work_location wl
            ON wl.id = dc.work_location

        WHERE 1 = 1
    `;

    const values = [];
    let count = 1;

    /* ================= STATUS ================= */
    if (
        status !== null &&
        status !== undefined &&
        String(status).trim() !== ""
    ) {

        query += ` AND dc.status = $${count}`;

        values.push(
            status === true ||
            status === "true"
        );

        count++;
    }

    /* ================= WORK LOCATION ================= */
    if (
        work_location !== null &&
        work_location !== undefined &&
        String(work_location).trim() !== "" &&
        String(work_location).trim().toLowerCase() !== "nan"
    ) {

        const value = String(work_location).trim();
        const locationId = Number(value);

        if (
            Number.isInteger(locationId) &&
            locationId > 0
        ) {

            query += `
                AND dc.work_location = $${count}
            `;

            values.push(locationId);
            count++;

        } else {

            query += `
                AND LOWER(TRIM(wl.location))
                    = LOWER(TRIM($${count}))
            `;

            values.push(value);
            count++;
        }
    }

    query += `
        ORDER BY dc.device_name ASC
    `;

    const { rows } = await pool.query(query, values);

    return rows;
};

/* ================= CHECK DEVICE ================= */
export const checkDeviceExistsModel = async (
    device_id,
    work_location,
    department,
    id = null
) => {
    const locationId = await resolveWorkLocationId(work_location);

    let query = `
        SELECT id
        FROM device_configurations
        WHERE device_id = $1
          AND work_location = $2
          AND UPPER(TRIM(department))
              = UPPER(TRIM($3))
    `;

    const values = [
        device_id,
        locationId,
        department
    ];

    if (id) {
        query += ` AND id <> $4`;
        values.push(id);
    }

    const { rows } = await pool.query(query, values);

    return rows.length > 0;
};

/* ================= UPDATE ================= */
export const updateDeviceConfigurationModel = async (
    id,
    data
) => {

    const locationId =
        await resolveWorkLocationId(data.work_location);

    const query = `
        UPDATE device_configurations
        SET
            device_id = $1,
            mac_id = $2,
            work_location = $3,
            department = $4,
            status = $5,
            connection = $6,
            device_name = $7,
            updated_at = TIMEZONE(
                'Asia/Kolkata',
                CURRENT_TIMESTAMP
            )
        WHERE id = $8
        RETURNING *;
    `;

    const values = [
        data.device_id,
        data.mac_id,
        locationId,
        data.department,
        data.status ?? true,
        data.connection || "online",
        data.device_name,
        id
    ];

    const { rows } = await pool.query(query, values);

    return rows[0];
};

/* ================= TOGGLE STATUS ================= */
export const toggleDeviceConfigurationStatusModel = async (id) => {
    const { rows } = await pool.query(
        `
            SELECT *
            FROM device_configurations
            WHERE id = $1
        `,
        [id]
    );

    if (!rows.length) {
        return null;
    }

    const newStatus = !rows[0].status;

    const result = await pool.query(
        `
            UPDATE device_configurations
            SET
                status = $1,
                updated_at = TIMEZONE(
                    'Asia/Kolkata',
                    CURRENT_TIMESTAMP
                )
            WHERE id = $2
            RETURNING *;
        `,
        [newStatus, id]
    );

    return result.rows[0];
};

/* ================= UPDATE HEARTBEAT ================= */
export const updateDeviceHeartbeatModel = async (
    mac_id,
    ip_address = null
) => {
    let query = `
        UPDATE device_configurations
        SET
            connection = 'online',
            updated_at = TIMEZONE(
                'Asia/Kolkata',
                CURRENT_TIMESTAMP
            )
    `;

    const values = [];
    let count = 1;

    if (ip_address) {

        query += `,
            ip_address = $${count}
        `;

        values.push(ip_address);
        count++;
    }

    query += `
        WHERE mac_id = $${count}
        RETURNING *;
    `;

    values.push(mac_id);

    const { rows } = await pool.query(query, values);

    return rows[0];
};

/* ================= OFFLINE CHECK ================= */
export const markOfflineDevicesModel = async () => {

    const query = `
        UPDATE device_configurations
        SET
            connection = 'offline',
            updated_at = TIMEZONE(
                'Asia/Kolkata',
                CURRENT_TIMESTAMP
            )
        WHERE
            connection <> 'offline'
            AND updated_at < NOW() - INTERVAL '60 seconds'
        RETURNING
            id,
            mac_id,
            connection;
    `;

    const { rows } = await pool.query(query);

    /* =================================================
       LOG ONLY ACTUAL ONLINE -> OFFLINE CHANGE
    ================================================= */
    for (const device of rows) {

        await addSettingEditLogModel({
            table_name: "device_configurations",
            record_id: Number(device.id),
            username: "MQTT",
            edited_by: "MQTT",
            field_name: "connection",
            old_value: "online",
            new_value: "offline"
        });

        console.log(
            `📝 DEVICE CONNECTION LOG | ${device.mac_id} | online → offline`
        );
    }

    return rows;
};

/* ================= DEVICE STATUS ================= */
export const getDeviceStatusModel = async (mac_id) => {
    const { rows } = await pool.query(
        `
            SELECT status
            FROM device_configurations
            WHERE mac_id = $1
            LIMIT 1
        `,
        [mac_id]
    );

    return rows[0]?.status ?? true;
};

/* ================= GET DEVICE BY MAC ================= */
export const getDeviceIpByMacModel = async (mac_id) => {
    const { rows } = await pool.query(
        `
            SELECT ip_address
            FROM device_configurations
            WHERE mac_id = $1
            LIMIT 1
        `,
        [mac_id]
    );

    return rows[0];
};

/* ================= UPDATE DEVICE IP BY MAC ================= */
export const updateDeviceIpModel = async (
    mac_id,
    ip
) => {
    const { rows } = await pool.query(
        `
            UPDATE device_configurations
            SET
                ip_address = $1,
                connection = 'online',
                updated_at = TIMEZONE(
                    'Asia/Kolkata',
                    CURRENT_TIMESTAMP
                )
            WHERE mac_id = $2
            RETURNING *;
        `,
        [ip, mac_id]
    );

    return rows[0];
};