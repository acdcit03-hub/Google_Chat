import { pool } from "../../../database.js";

/* ================= GET OPEN ATTENDANCE ================= */
export const getAttendanceToAutoClose = async () => {

    const { rows } = await pool.query(`
        SELECT
            ats.id,
            ats.entry_at,
            ats.username,
            ats.rfid,
            ed.rfid AS employee_rfid,

            sc.id AS shift_id,
            sc.shift_name,
            sc.shift_type,
            sc.shift_reset_time

        FROM attendance_sessions ats

        INNER JOIN employment_details ed
            ON ed.rfid = ats.rfid

        INNER JOIN personal_details pd
            ON pd.id = ed.personal_details_id

        INNER JOIN LATERAL (
            SELECT epc_latest.*
            FROM employee_payroll_config epc_latest
            WHERE epc_latest.username = pd.username
            ORDER BY
                CASE
                    WHEN (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::DATE
                        BETWEEN epc_latest.payroll_start_date
                            AND epc_latest.payroll_end_date
                    THEN 0 ELSE 1
                END,
                epc_latest.payroll_start_date DESC,
                epc_latest.id DESC
            LIMIT 1
        ) epc ON TRUE

        INNER JOIN shift_configurations sc
            ON sc.id = ed.shift_id

        WHERE ats.status = 'inside'
          AND ats.exit_at IS NULL
    `);

    return rows;
};


/* ================= EXPIRE ATTENDANCE ================= */
export const expireAttendanceModel = async (sessionId) => {

    const { rows } = await pool.query(
        `   
        UPDATE attendance_sessions
        SET
            status = 'Expired',
            exit_mac_id = 'AUTO',
            exit_device_name = 'AUTO',
            exit_at = NULL,
            duration = NULL,
            updated_at = TIMEZONE(
                'Asia/Kolkata',
                CURRENT_TIMESTAMP
            )
        WHERE id = $1
          AND status = 'inside'
          AND exit_at IS NULL

        RETURNING *;
        `,
        [sessionId]
    );

    return rows[0] || null;
};