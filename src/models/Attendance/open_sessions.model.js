import { pool } from '../../config/db.js';

export const initializeOpenSessionsTable = async () => {
    const query = `
        CREATE TABLE IF NOT EXISTS open_sessions (
            id SERIAL PRIMARY KEY,
            rfid VARCHAR(255) NOT NULL,
            mac_id VARCHAR(255) NOT NULL,
            session_id INTEGER NOT NULL,
            entry_at TIMESTAMP NOT NULL,
            last_scan_at TIMESTAMP NOT NULL,
            created_at TIMESTAMP DEFAULT TIMEZONE(
                'Asia/Kolkata',
                CURRENT_TIMESTAMP
            )
        );
    `;

    await pool.query(query);

    await pool.query(`
        SELECT setval(
            pg_get_serial_sequence('open_sessions', 'id'),
            COALESCE((SELECT MAX(id) FROM open_sessions), 1),
            true
        );
    `);

    console.log("✅ Open Sessions Table Ready");
};

/* ================= CREATE OPEN SESSION ================= */
export const createOpenSession = async ({
    rfid,
    mac_id,
    session_id,
    entry_at
}) => {
    if (!mac_id) mac_id = "MANUAL";
    
    const { rows } = await pool.query(
        `
            INSERT INTO open_sessions
            (
                rfid,
                mac_id,
                session_id,
                entry_at,
                last_scan_at
            )
            VALUES
            ($1, $2, $3, $4, $4)
            RETURNING *;
        `,
        [
            rfid,
            mac_id,
            session_id,
            entry_at
        ]
    );

    return rows[0];
};

/* ================= DELETE OPEN SESSION ================= */
export const deleteOpenSession = async (
    session_id
) => {
    await pool.query(
        `
        DELETE FROM open_sessions
        WHERE session_id = $1
        `,
        [session_id]
    );
};

/* ================= DELETE OPEN SESSIONS BY RFID ================= */
export const deleteOpenSessionByRFID = async (rfid) => {
    await pool.query(
        `
        DELETE FROM open_sessions
        WHERE rfid = $1
        `,
        [rfid]
    );
};

/* ================= GET OPEN SESSIONS ================= */
export const getOpenSessionsModel = async () => {
    const { rows } = await pool.query(
        `
            SELECT *
            FROM open_sessions
            ORDER BY id DESC
        `
    );

    return rows;
};

/* ================= GET OPEN SESSION ================= */
export const getOpenSession = async (username) => {
    const { rows } = await pool.query(
        `
            SELECT *
            FROM attendance_sessions
            WHERE username = $1
            AND status = 'inside'
            ORDER BY entry_at DESC
            LIMIT 1
        `,
        [username]
    );

    return rows[0];
};

/* ================= GET OPEN SESSION BY DATE ================= */
export const getOpenSessionByDate = async (username, date) => {

    const { rows } = await pool.query(
        `
        SELECT *
        FROM attendance_sessions
        WHERE username = $1
          AND status = 'inside'
          AND DATE(entry_at AT TIME ZONE 'Asia/Kolkata')
              = DATE($2::timestamptz AT TIME ZONE 'Asia/Kolkata')
        ORDER BY entry_at DESC
        LIMIT 1
        `,
        [username, date]
    );

    return rows[0] || null;
};