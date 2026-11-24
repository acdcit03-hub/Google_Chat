import { pool } from '../../config/db.js';

export const initializeMacAddressTable = async () => {
    const query = `
        CREATE TABLE IF NOT EXISTS mac_address (
            id SERIAL PRIMARY KEY,
            mac_address VARCHAR(50) UNIQUE NOT NULL,
            status VARCHAR(20) DEFAULT 'unregistered',
            created_at TIMESTAMP DEFAULT TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP),
            updated_at TIMESTAMP DEFAULT TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
        );
    `;

    await pool.query(query);

    await pool.query(`
        SELECT setval(
            pg_get_serial_sequence('mac_address', 'id'),
            COALESCE((SELECT MAX(id) FROM mac_address), 1),
            true
        );
    `);

    console.log("✅ MAC Address Table Ready");
};

/* ================= SAVE MAC ADDRESS ================= */
export const saveMacAddress = async (macAddress) => {
    try {
        const existing = await pool.query(
            `
                SELECT id FROM mac_address
                WHERE mac_address = $1
            `,
            [macAddress]
        );

        const statusQuery = await pool.query(
            `
                SELECT id FROM device_configurations
                WHERE mac_id = $1
                LIMIT 1
            `,
            [macAddress]
        );

        const status =
            statusQuery.rowCount > 0
                ? "registered"
                : "unregistered";

        let result;

        if (existing.rowCount > 0) {
            result = await pool.query(
                `
                    UPDATE mac_address
                    SET status = $2,
                        updated_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
                    WHERE mac_address = $1
                    RETURNING *;
                `,
                [macAddress, status]
            );
        } else {
            result = await pool.query(
                `
                    INSERT INTO mac_address (mac_address, status)
                    VALUES ($1, $2)
                    RETURNING *;
                `,
                [macAddress, status]
            );
        }

        console.log(`MAC: ${macAddress} | Status: ${status}`);
        return result.rows[0];

    } catch (error) {
        console.error("❌ Save MAC Address Error:", error);
        throw error;
    }
};

/* ================= CHECK MAC ID STATUS ================= */
export const syncMacAddressStatus = async (oldMac, newMac) => {

    if (newMac) {
        await pool.query(
            `
                INSERT INTO mac_address (mac_address, status)
                VALUES ($1, 'registered')
                ON CONFLICT (mac_address)
                DO UPDATE SET
                    status = 'registered',
                    updated_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP);
            `,
            [newMac]
        );
    }

    if (oldMac && oldMac !== newMac) {
        await pool.query(
            `
                UPDATE mac_address
                SET status = 'unregistered',
                    updated_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
                WHERE mac_address = $1;
            `,
            [oldMac]
        );
    }
};

/* ================= GET UNREGISTERED MAC ID ================= */
export const getUnregisteredMacsModel = async () => {

    const query = `
        SELECT *
        FROM mac_address
        WHERE status = 'unregistered'
        ORDER BY id ASC;
    `;

    const { rows } = await pool.query(query);

    return rows;
};

/* ================= CHECK MAC EXIST ================= */
export const checkMacExistsModel = async (mac_id, id = null) => {
    let query = `
        SELECT id
        FROM device_configurations
        WHERE mac_id = $1
    `;

    const values = [mac_id];

    if (id) {
        query += ` AND id <> $2`;
        values.push(id);
    }

    const { rows } = await pool.query(
        query,
        values
    );

    return rows.length > 0;
};