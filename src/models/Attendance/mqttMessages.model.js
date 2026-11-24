import { pool } from '../../config/db.js';

export const initializeMqttMessagesTable = async () => {
    const query = `
        CREATE TABLE IF NOT EXISTS mqtt_messages (
            id SERIAL PRIMARY KEY,
            mac_id VARCHAR(255) NOT NULL,
            rfid_uid VARCHAR(255) NOT NULL,
            message_id INTEGER,
            device_timestamp TIMESTAMP,
            received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            ack_sent BOOLEAN DEFAULT TRUE,
            raw_payload TEXT
        );
    `;

    await pool.query(query);

    await pool.query(`
        SELECT setval(
            pg_get_serial_sequence('mqtt_messages', 'id'),
            COALESCE((SELECT MAX(id) FROM mqtt_messages), 1),
            true
        );
    `);

    console.log("✅ MQTT_messages Table Ready");
};

/* ================= INSERT MQTT MESSAGE ================= */
export const insertMQTTMessageModel = async (data) => {
    const query = `
        INSERT INTO mqtt_messages
        (
            mac_id,
            rfid_uid,
            message_id,
            device_timestamp,
            ack_sent,
            raw_payload
        )
        VALUES ($1,$2,$3,$4,$5,$6)
        RETURNING *;
    `;

    const values = [
        data.mac_id,
        data.rfid_uid,
        data.message_id || 0,
        data.device_timestamp || null,
        data.ack_sent || true,
        data.raw_payload
    ];

    const { rows } = await pool.query(query, values);
    return rows[0];
};

/* ================= UPDATE ACK ================= */
export const updateAckStatusModel = async (message_id) => {
    const query = `
        UPDATE mqtt_messages
        SET ack_sent = TRUE
        WHERE message_id = $1
        RETURNING *;
    `;

    const { rows } = await pool.query(query, [message_id]);
    return rows[0];
};

/* =========================================================
   IST DATETIME NORMALIZER
   Converts:
   2026-09-23T09:00
   2026-09-23 09:00
   2026-09-23T09:00:00

   into:
   2026-09-23T09:00:00+05:30
========================================================= */

const normalizeISTDateTime = (value) => {

    if (
        value === null ||
        value === undefined ||
        String(value).trim() === "" ||
        String(value).trim().toLowerCase() === "nan"
    ) {
        return null;
    }

    let dateValue = String(value).trim();

    /* Already contains timezone */
    if (
        /[zZ]$/.test(dateValue) ||
        /[+-]\d{2}:\d{2}$/.test(dateValue)
    ) {
        return dateValue;
    }

    /* Convert space to T */
    dateValue = dateValue.replace(" ", "T");

    /* Add seconds if not supplied */
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(dateValue)) {
        dateValue += ":00";
    }

    /* Add IST */
    return `${dateValue}+05:30`;
};

/* ================= GET ALL ================= */
export const getAllMQTTMessagesModel = async ({
    work_location = null,
    location_id = null,
    device_time_from = null,
    device_time_to = null,
    received_time_from = null,
    received_time_to = null,
    mac_id = null,
    rfid = null,
    message_id = null,
    page = 1,
    limit = 20
} = {}) => {

    page = Number(page) || 1;
    limit = Number(limit) || 20;

    const offset = (page - 1) * limit;

    const values = [];
    const countValues = [];

    let count = 1;

    /* =========================================================
       MAIN QUERY
    ========================================================= */
    let query = `
        SELECT
            mm.*,
            ed.username,
            ed.employment_id,
            ed.work_location AS work_location_id,
            wl.location AS work_location,
            wl.id AS location_id
        FROM mqtt_messages mm

        LEFT JOIN employment_details ed
            ON ed.rfid = mm.rfid_uid

        LEFT JOIN work_location wl
            ON wl.id = ed.work_location

        WHERE 1 = 1
    `;


    /* =========================================================
       COUNT QUERY
    ========================================================= */

    let countQuery = `
        SELECT
            COUNT(*)::INT AS total

        FROM mqtt_messages mm

        LEFT JOIN employment_details ed
            ON ed.rfid = mm.rfid_uid

        LEFT JOIN work_location wl
            ON wl.id = ed.work_location

        WHERE 1 = 1
    `;


    /* =========================================================
       WORK LOCATION FILTER
    ========================================================= */

    if (
        work_location !== null &&
        work_location !== undefined &&
        String(work_location).trim() !== "" &&
        String(work_location).trim().toLowerCase() !== "nan"
    ) {

        const locationValue = String(work_location).trim();

        const locationId = Number(locationValue);

        if (
            Number.isInteger(locationId) &&
            locationId > 0
        ) {

            query += `
                AND wl.id = $${count}
            `;

            countQuery += `
                AND wl.id = $${count}
            `;

            values.push(locationId);
            countValues.push(locationId);

            count++;

        } else {

            query += `
                AND LOWER(TRIM(wl.location))
                    = LOWER(TRIM($${count}))
            `;

            countQuery += `
                AND LOWER(TRIM(wl.location))
                    = LOWER(TRIM($${count}))
            `;

            values.push(locationValue);
            countValues.push(locationValue);

            count++;
        }
    }


    /* =========================================================
       LOCATION ID FILTER
    ========================================================= */

    if (
        location_id !== null &&
        location_id !== undefined &&
        String(location_id).trim() !== "" &&
        String(location_id).trim().toLowerCase() !== "nan"
    ) {

        const locationId = Number(location_id);

        if (
            Number.isInteger(locationId) &&
            locationId > 0
        ) {

            query += `
                AND wl.id = $${count}
            `;

            countQuery += `
                AND wl.id = $${count}
            `;

            values.push(locationId);
            countValues.push(locationId);

            count++;
        }
    }


    /* =========================================================
       DEVICE TIME FROM
       Asia/Kolkata
    ========================================================= */

    if (
        device_time_from !== null &&
        device_time_from !== undefined &&
        String(device_time_from).trim() !== "" &&
        String(device_time_from).trim().toLowerCase() !== "nan"
    ) {

        const normalizedDeviceTimeFrom =
            normalizeISTDateTime(device_time_from);

        query += `
        AND mm.device_timestamp >= $${count}::timestamptz
    `;

        countQuery += `
        AND mm.device_timestamp >= $${count}::timestamptz
    `;

        values.push(normalizedDeviceTimeFrom);
        countValues.push(normalizedDeviceTimeFrom);

        count++;
    }


    /* =========================================================
       DEVICE TIME TO
       Asia/Kolkata
    ========================================================= */
    if (
        device_time_to !== null &&
        device_time_to !== undefined &&
        String(device_time_to).trim() !== "" &&
        String(device_time_to).trim().toLowerCase() !== "nan"
    ) {

        const normalizedDeviceTimeTo =
            normalizeISTDateTime(device_time_to);

        query += `
        AND mm.device_timestamp <= $${count}::timestamptz
    `;

        countQuery += `
        AND mm.device_timestamp <= $${count}::timestamptz
    `;
        values.push(normalizedDeviceTimeTo);
        countValues.push(normalizedDeviceTimeTo);

        count++;
    }


    /* =========================================================
       RECEIVED TIME FROM
       Asia/Kolkata
    ========================================================= */
if (
    received_time_from !== null &&
    received_time_from !== undefined &&
    String(received_time_from).trim() !== "" &&
    String(received_time_from).trim().toLowerCase() !== "nan"
) {
    const normalizedReceivedTimeFrom =
        normalizeISTDateTime(received_time_from);

    query += `
        AND mm.received_at >= $${count}::timestamptz
    `;

    countQuery += `
        AND mm.received_at >= $${count}::timestamptz
    `;

    values.push(normalizedReceivedTimeFrom);
    countValues.push(normalizedReceivedTimeFrom);

    count++;
}


    /* =========================================================
       RECEIVED TIME TO
       Asia/Kolkata
    ========================================================= */
if (
    received_time_to !== null &&
    received_time_to !== undefined &&
    String(received_time_to).trim() !== "" &&
    String(received_time_to).trim().toLowerCase() !== "nan"
) {

    const normalizedReceivedTimeTo =
        normalizeISTDateTime(received_time_to);

    query += `
        AND mm.received_at <= $${count}::timestamptz
    `;

    countQuery += `
        AND mm.received_at <= $${count}::timestamptz
    `;

    values.push(normalizedReceivedTimeTo);
    countValues.push(normalizedReceivedTimeTo);

    count++;
}


    /* =========================================================
       MAC ID FILTER
    ========================================================= */

    if (
        mac_id !== null &&
        mac_id !== undefined &&
        String(mac_id).trim() !== "" &&
        String(mac_id).trim().toLowerCase() !== "nan"
    ) {

        query += `
            AND mm.mac_id::TEXT ILIKE $${count}
        `;

        countQuery += `
            AND mm.mac_id::TEXT ILIKE $${count}
        `;

        values.push(`%${String(mac_id).trim()}%`);
        countValues.push(`%${String(mac_id).trim()}%`);

        count++;
    }


    /* =========================================================
       RFID FILTER
    ========================================================= */

    if (
        rfid !== null &&
        rfid !== undefined &&
        String(rfid).trim() !== "" &&
        String(rfid).trim().toLowerCase() !== "nan"
    ) {

        query += `
            AND mm.rfid_uid::TEXT ILIKE $${count}
        `;

        countQuery += `
            AND mm.rfid_uid::TEXT ILIKE $${count}
        `;

        values.push(`%${String(rfid).trim()}%`);
        countValues.push(`%${String(rfid).trim()}%`);

        count++;
    }


    /* =========================================================
       MESSAGE ID FILTER
    ========================================================= */

    if (
        message_id !== null &&
        message_id !== undefined &&
        String(message_id).trim() !== "" &&
        String(message_id).trim().toLowerCase() !== "nan"
    ) {

        query += `
            AND mm.message_id::TEXT ILIKE $${count}
        `;

        countQuery += `
            AND mm.message_id::TEXT ILIKE $${count}
        `;

        values.push(`%${String(message_id).trim()}%`);
        countValues.push(`%${String(message_id).trim()}%`);

        count++;
    }


    /* =========================================================
       PAGINATION
    ========================================================= */

    query += `
        ORDER BY
            mm.id DESC

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

        pool.query(
            query,
            values
        ),

        pool.query(
            countQuery,
            countValues
        )
    ]);


    const total =
        Number(totalRows[0]?.total || 0);


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