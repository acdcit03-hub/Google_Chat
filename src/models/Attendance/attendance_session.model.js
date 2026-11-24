
import { pool } from '../../config/db.js';
import { getEmployeeByUsername, getUsernameByRFID } from '../Employee/EmploymentDetails.model.js';
import { addAttendanceLogModel } from '../history/attendance_logs.model.js';
import { createOpenSession, deleteOpenSession, getOpenSession, getOpenSessionByDate } from "./open_sessions.model.js";
import { decryptPayrollFields } from "../../utils/payrollEncryption.js";

export const initializeAttendanceSessionsTable = async () => {
    const query = `
        CREATE TABLE IF NOT EXISTS attendance_sessions (
            id SERIAL PRIMARY KEY,
            rfid VARCHAR(255) NOT NULL,
            username VARCHAR(255),
            entry_mac_id VARCHAR(255),
            exit_mac_id VARCHAR(255),
            entry_device_name VARCHAR(255),
            exit_device_name VARCHAR(255),
            entry_at TIMESTAMPTZ,
            exit_at TIMESTAMPTZ,
            duration INTERVAL,
            entry_message_id INTEGER,
            exit_message_id INTEGER,
            status VARCHAR(50) DEFAULT 'inside',
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        );
    `;

    await pool.query(query);

    await pool.query(`
        SELECT setval(
            pg_get_serial_sequence('attendance_sessions', 'id'),
            COALESCE((SELECT MAX(id) FROM attendance_sessions), 1),
            true
        );
    `);

    console.log("✅ Attendance Sessions Table Ready");
};

/* ================= SAFE TIMESTAMP PARSER ================= */
function parseTimestamp(value) {
    if (!value) return null;

    const date = new Date(value);
    if (isNaN(date.getTime())) return null;

    return date.toISOString();
}

/* ================= GET INDIA TIME PARTS ================= */
function getIndiaTimeParts(timestamp) {

    if (!timestamp) {
        return null;
    }

    const date = new Date(timestamp);

    if (isNaN(date.getTime())) {
        return null;
    }

    const formatter = new Intl.DateTimeFormat("en-IN", {
        timeZone: "Asia/Kolkata",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
    });

    const parts = formatter.formatToParts(date);

    const getPart = (type) =>
        Number(
            parts.find(
                part => part.type === type
            )?.value || 0
        );

    return {
        hour: getPart("hour"),
        minute: getPart("minute"),
        second: getPart("second")
    };
}

/* ================= CHECK BREAK TIME ================= */
function isBreakTime(deviceTimestamp, shift) {
    if (
        !deviceTimestamp ||
        !shift?.break_start_time ||
        !shift?.break_end_time
    ) {
        return false;
    }

    const indiaTime = getIndiaTimeParts(deviceTimestamp);

    if (!indiaTime) {
        return false;
    }

    const [startHour, startMinute] =
        String(shift.break_start_time)
            .substring(0, 5)
            .split(":")
            .map(Number);

    const [endHour, endMinute] =
        String(shift.break_end_time)
            .substring(0, 5)
            .split(":")
            .map(Number);

    const currentMinutes =
        indiaTime.hour * 60 +
        indiaTime.minute;

    const breakStartMinutes =
        startHour * 60 +
        startMinute;

    const breakEndMinutes =
        endHour * 60 +
        endMinute;

    /* ================= NORMAL BREAK ================= */
    if (breakEndMinutes > breakStartMinutes) {
        return (
            currentMinutes >= breakStartMinutes &&
            currentMinutes < breakEndMinutes
        );
    }

    /* ================= OVERNIGHT BREAK ================= */
    return (
        currentMinutes >= breakStartMinutes ||
        currentMinutes < breakEndMinutes
    );
}

/* ================= APPLY BREAK TIME ================= */
function applyBreakTime(deviceTimestamp, shift) {
    if (
        !deviceTimestamp ||
        !shift?.break_start_time ||
        !shift?.break_end_time
    ) {
        return deviceTimestamp;
    }

    if (!isBreakTime(deviceTimestamp, shift)) {
        return deviceTimestamp;
    }

    const originalDate = new Date(deviceTimestamp);

    if (isNaN(originalDate.getTime())) {
        return deviceTimestamp;
    }

    const [endHour, endMinute] =
        String(shift.break_end_time)
            .substring(0, 5)
            .split(":")
            .map(Number);

    const indiaDate = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).format(originalDate);

    const [year, month, day] = indiaDate.split("-").map(Number);

    const utcTimestamp = Date.UTC(
        year,
        month - 1,
        day,
        endHour - 5,
        endMinute - 30,
        0,
        0
    );

    const breakEnd = new Date(utcTimestamp);
    return breakEnd.toISOString();
}

/* ================= CHECK IF SESSION ENTRY IS BREAK ENTRY ================= */
function isBreakAdjustedEntry(entryAt, shift) {
    if (
        !entryAt ||
        !shift?.break_start_time ||
        !shift?.break_end_time
    ) {
        return false;
    }

    const entryDate = new Date(entryAt);

    if (isNaN(entryDate.getTime())) {
        return false;
    }

    const indiaTime = getIndiaTimeParts(entryDate);

    if (!indiaTime) {
        return false;
    }

    const [endHour, endMinute] =
        String(shift.break_end_time)
            .substring(0, 5)
            .split(":")
            .map(Number);

    return (
        indiaTime.hour === endHour &&
        indiaTime.minute === endMinute &&
        indiaTime.second === 0
    );
}

/* ================= GET DEVICE NAME BY MAC ID ================= */
export const getDeviceNameByMac = async (mac_id) => {
    if (!mac_id) return null;

    const { rows } = await pool.query(
        `SELECT device_name FROM device_configurations WHERE mac_id = $1 LIMIT 1`,
        [mac_id]
    );

    return rows[0]?.device_name || mac_id;
};

/* ================= CREATE ENTRY / MANUAL SESSION ================= */
export const createAttendanceSession = async ({
    rfid,
    entry_mac_id,
    exit_mac_id = null,
    message_id = null,
    entry_at = null,
    exit_at = null,
    status = "inside"
}) => {
    const username = await getUsernameByRFID(rfid);
    const finalStatus = exit_at ? "completed" : status;
    const entry_device_name = await getDeviceNameByMac(entry_mac_id);
    const exit_device_name = await getDeviceNameByMac(exit_mac_id);

    const { rows } = await pool.query(
        `
            INSERT INTO attendance_sessions
            (
                rfid,
                username,
                entry_mac_id,
                exit_mac_id,
                entry_at,
                exit_at,
                duration,
                entry_message_id,
                exit_message_id,
                status,
                entry_device_name,
                exit_device_name
            )
            VALUES
            (
                $1,
                $2,
                $3,
                $4,
                $5::timestamptz,
                $6::timestamptz,
                CASE
                    WHEN $5::timestamptz IS NOT NULL AND $6::timestamptz IS NOT NULL
                    THEN $6::timestamptz - $5::timestamptz
                    ELSE NULL
                END,
                $7,
                NULL,
                $8,
                $9,
                $10
            )
            RETURNING *;
        `,
        [
            rfid,
            username,
            entry_mac_id,
            exit_mac_id,
            entry_at,
            exit_at,
            message_id,
            finalStatus,
            entry_device_name,
            exit_device_name
        ]
    );

    return rows[0];
};

/* ================= COMPLETE SESSION ================= */
export const completeAttendanceSession = async (
    sessionId,
    exitMacId,
    messageId,
    exitAt
) => {

    const client = await pool.connect();

    try {

        await client.query("BEGIN");

        /* =====================================================
           GET EXIT DEVICE
        ===================================================== */

        const deviceRes = await client.query(
            `
                SELECT device_name
                FROM device_configurations
                WHERE mac_id = $1
                LIMIT 1
            `,
            [exitMacId]
        );

        const exitDeviceName =
            deviceRes.rows[0]?.device_name || exitMacId;


        /* =====================================================
           GET EXISTING SESSION
        ===================================================== */

        const sessionResult = await client.query(
            `
                SELECT *
                FROM attendance_sessions
                WHERE id = $1
                FOR UPDATE
            `,
            [sessionId]
        );

        if (!sessionResult.rows.length) {

            throw new Error(
                "Attendance session not found."
            );
        }

        const session =
            sessionResult.rows[0];


        const entryAt =
            new Date(session.entry_at);

        const finalExitAt =
            new Date(exitAt);


        /* =====================================================
           VALIDATE EXIT
        ===================================================== */

        if (
            Number.isNaN(entryAt.getTime()) ||
            Number.isNaN(finalExitAt.getTime())
        ) {

            throw new Error(
                "Invalid attendance entry or exit timestamp."
            );
        }

        if (finalExitAt <= entryAt) {

            throw new Error(
                "Exit time must be greater than entry time."
            );
        }


        /* =====================================================
           CHECK SAME CALENDAR DATE
        ===================================================== */

        const entryDate =
            entryAt.toLocaleDateString(
                "en-CA",
                {
                    timeZone: "Asia/Kolkata"
                }
            );

        const exitDate =
            finalExitAt.toLocaleDateString(
                "en-CA",
                {
                    timeZone: "Asia/Kolkata"
                }
            );


        /* =====================================================
           SAME DATE
           -----------------------------------------------------
           Normal attendance session.
        ===================================================== */

        if (entryDate === exitDate) {

            const { rows } = await client.query(
                `
                    UPDATE attendance_sessions
                    SET
                        exit_mac_id = $1,
                        exit_device_name = $2,
                        exit_at = $3::timestamptz,
                        exit_message_id = $4,

                        duration =
                            $3::timestamptz - entry_at,

                        status = 'completed',

                        updated_at = CURRENT_TIMESTAMP

                    WHERE id = $5

                    RETURNING *;
                `,
                [
                    exitMacId,
                    exitDeviceName,
                    exitAt,
                    messageId,
                    sessionId
                ]
            );

            await client.query("COMMIT");

            return rows[0];
        }


        /* =====================================================
           MULTI-DATE SESSION
           -----------------------------------------------------
           Example:

           Entry:
           09-10-2026 09:00 AM

           Exit:
           10-10-2026 04:00 AM

           Create:

           Record 1:
           09-10-2026 09:00:00
           ->
           09-10-2026 23:59:59

           Record 2:
           10-10-2026 00:00:00
           ->
           10-10-2026 04:00:00
        ===================================================== */


        /* =====================================================
           MIDNIGHT OF EXIT DATE
        ===================================================== */

        const midnightExit =
            new Date(
                `${exitDate}T00:00:00+05:30`
            );

        const previousDayEnd =
            new Date(
                midnightExit.getTime() - 1000
            );


        /* =====================================================
           FIRST RECORD
        ===================================================== */

        const firstDuration =
            previousDayEnd.getTime()
            -
            entryAt.getTime();


        const firstResult =
            await client.query(
                `
                    UPDATE attendance_sessions
                    SET
                        exit_mac_id = $1,
                        exit_device_name = $2,

                        exit_at = $3::timestamptz,

                        exit_message_id = $4,

                        duration =
                            $3::timestamptz - entry_at,

                        status = 'completed',

                        updated_at = CURRENT_TIMESTAMP

                    WHERE id = $5

                    RETURNING *;
                `,
                [
                    exitMacId,
                    exitDeviceName,
                    previousDayEnd.toISOString(),
                    messageId,
                    sessionId
                ]
            );


        const firstSession =
            firstResult.rows[0];


        /* =====================================================
           CREATE SECOND RECORD
        ===================================================== */

        const secondResult =
            await client.query(
                `
                    INSERT INTO attendance_sessions
                    (
                        rfid,
                        username,

                        entry_mac_id,
                        entry_device_name,

                        exit_mac_id,
                        exit_device_name,

                        entry_at,
                        exit_at,

                        duration,

                        entry_message_id,
                        exit_message_id,

                        status
                    )

                    VALUES
                    (
                        $1,
                        $2,

                        $3,
                        $4,

                        $5,
                        $6,

                        $7::timestamptz,
                        $8::timestamptz,

                        $8::timestamptz
                            - $7::timestamptz,

                        NULL,
                        $9,

                        'completed'
                    )

                    RETURNING *;
                `,
                [
                    session.rfid,
                    session.username,

                    session.entry_mac_id,
                    session.entry_device_name,

                    exitMacId,
                    exitDeviceName,

                    midnightExit.toISOString(),
                    exitAt,

                    messageId
                ]
            );


        const secondSession =
            secondResult.rows[0];


        await client.query("COMMIT");


        /* =====================================================
           RETURN BOTH RECORDS
        ===================================================== */

        return {
            split: true,

            sessions: [
                firstSession,
                secondSession
            ],

            first_session:
                firstSession,

            second_session:
                secondSession
        };


    } catch (error) {

        await client.query("ROLLBACK");

        console.error(
            "COMPLETE ATTENDANCE SESSION ERROR:",
            error
        );

        throw error;

    } finally {

        client.release();
    }
};


/* ================= ADD ATTENDANCE SESSION ================= */
export const addAttendanceSessionModel = async (data) => {

    const {
        username,
        mac_id,
        message_id = null,
        entry_at = null,
        exit_at = null,
        manualStatus = "inside",
        actionUsername
    } = data;

    /* =====================================================
       GET EMPLOYEE
    ===================================================== */
    const employee = await getEmployeeByUsername(username);

    if (!employee) {
        throw new Error("Employee not found.");
    }

    const employeeRFID = employee.rfid;
    const employee_id = employee?.employment_id || null;
    const employeeUsername = employee?.username || null;

    /* =====================================================
       UNREGISTERED
    ===================================================== */
    if (
        !username ||
        String(username).toLowerCase() === "unregistered"
    ) {
        console.log(
            "⛔ MANUAL + Unregistered -> SKIP attendance session"
        );

        return {
            action: "unregistered_only",
            data: null
        };
    }

    /* =====================================================
       FIND OPEN SESSION
    ===================================================== */
    let activeSession;

    if (entry_at) {

        activeSession = await getOpenSessionByDate(
            employeeUsername,
            entry_at
        );

    } else {

        activeSession = await getOpenSession(
            employeeUsername
        );
    }

    /* =====================================================
       EXISTING OPEN SESSION
       -----------------------------------------------------
       Existing open session means this request is EXIT.
    ===================================================== */
    if (activeSession) {

        const oldSession = {
            ...activeSession
        };

        const finalExitTime =
            exit_at ??
            entry_at ??
            new Date().toISOString();

        /* =================================================
           COMPLETE EXISTING SESSION

           completeAttendanceSession() already handles:

           SAME DATE:
           09:00 -> 18:00

           OVERNIGHT:
           09-Oct 09:00 -> 09-Oct 23:59:59
           10-Oct 00:00 -> 10-Oct 04:00
        ================================================= */

        const session = await completeAttendanceSession(
            activeSession.id,
            mac_id,
            message_id,
            finalExitTime
        );

        /* =================================================
           DELETE OPEN SESSION
        ================================================= */

        await deleteOpenSession(
            activeSession.id
        );

        /* =================================================
           ATTENDANCE LOG
        ================================================= */

        await addAttendanceLogModel({
            type: "edit",
            employee_id,
            username: employeeUsername,
            user_at: actionUsername,
            old_value: oldSession,
            new_value: session
        });

        return {
            action: "exit",
            data: session
        };
    }

    /* =====================================================
       NO OPEN SESSION
       ===================================================== */

    /* =====================================================
       VALIDATE ENTRY / EXIT
       ===================================================== */

    if (entry_at && exit_at) {

        const entryDate = new Date(entry_at);
        const exitDate = new Date(exit_at);

        if (
            Number.isNaN(entryDate.getTime()) ||
            Number.isNaN(exitDate.getTime())
        ) {
            throw new Error(
                "Invalid attendance entry or exit timestamp."
            );
        }

        if (exitDate <= entryDate) {
            throw new Error(
                "Exit time must be greater than entry time."
            );
        }
    }

    /* =====================================================
       OVERLAP CHECK
       ===================================================== */

    if (entry_at || exit_at) {

        const overlap = await checkAttendanceOverlap({
            rfid: employeeRFID,
            entry_at: entry_at ?? null,
            exit_at: exit_at ?? null
        });

        if (overlap) {
            throw new Error(
                "Attendance overlaps with an existing attendance."
            );
        }
    }

    /* =====================================================
       ENTRY + EXIT TOGETHER
       ===================================================== */

    if (entry_at && exit_at) {

        const entryDate = new Date(entry_at);
        const exitDate = new Date(exit_at);

        /* =================================================
           INDIA CALENDAR DATE
        ================================================= */

        const entryIndiaDate =
            entryDate.toLocaleDateString(
                "en-CA",
                {
                    timeZone: "Asia/Kolkata"
                }
            );

        const exitIndiaDate =
            exitDate.toLocaleDateString(
                "en-CA",
                {
                    timeZone: "Asia/Kolkata"
                }
            );

        /* =================================================
           SAME DATE
           -------------------------------------------------
           Example:
           09-Oct 09:00 -> 09-Oct 18:00
        ================================================= */

        if (entryIndiaDate === exitIndiaDate) {

            const session =
                await createAttendanceSession({
                    rfid: employeeRFID,

                    entry_mac_id: mac_id,
                    exit_mac_id: mac_id,

                    message_id,

                    entry_at,
                    exit_at,

                    status: "completed"
                });

            await addAttendanceLogModel({
                type: "add",
                employee_id,
                username: employeeUsername,
                user_at: actionUsername,
                old_value: null,
                new_value: session
            });

            return {
                action: "entry",
                data: session
            };
        }

        /* =================================================
           OVERNIGHT ATTENDANCE
           -------------------------------------------------
           Example:

           09-Oct 09:00
                ->
           09-Oct 23:59:59

           10-Oct 00:00
                ->
           10-Oct 04:00
        ================================================= */

        const midnightExit =
            new Date(
                `${exitIndiaDate}T00:00:00+05:30`
            );

        const previousDayEnd =
            new Date(
                midnightExit.getTime() - 1000
            );

        const entryDeviceName =
            await getDeviceNameByMac(mac_id);

        const exitDeviceName =
            await getDeviceNameByMac(mac_id);

        const client = await pool.connect();

        try {

            await client.query("BEGIN");

            /* =============================================
               FIRST SESSION
               ============================================= */

            const firstResult =
                await client.query(
                    `
                    INSERT INTO attendance_sessions
                    (
                        rfid,
                        username,

                        entry_mac_id,
                        exit_mac_id,

                        entry_at,
                        exit_at,

                        duration,

                        entry_message_id,
                        exit_message_id,

                        status,

                        entry_device_name,
                        exit_device_name
                    )
                    VALUES
                    (
                        $1,
                        $2,

                        $3,
                        $4,

                        $5::timestamptz,
                        $6::timestamptz,

                        $6::timestamptz
                            - $5::timestamptz,

                        $7,
                        $8,

                        'completed',

                        $9,
                        $10
                    )
                    RETURNING *;
                    `,
                    [
                        employeeRFID,
                        employeeUsername,

                        mac_id,
                        mac_id,

                        entry_at,
                        previousDayEnd.toISOString(),

                        message_id,
                        message_id,

                        entryDeviceName,
                        exitDeviceName
                    ]
                );

            const firstSession =
                firstResult.rows[0];

            /* =============================================
               SECOND SESSION
               ============================================= */

            const secondResult =
                await client.query(
                    `
                    INSERT INTO attendance_sessions
                    (
                        rfid,
                        username,

                        entry_mac_id,
                        exit_mac_id,

                        entry_at,
                        exit_at,

                        duration,

                        entry_message_id,
                        exit_message_id,

                        status,

                        entry_device_name,
                        exit_device_name
                    )
                    VALUES
                    (
                        $1,
                        $2,

                        $3,
                        $4,

                        $5::timestamptz,
                        $6::timestamptz,

                        $6::timestamptz
                            - $5::timestamptz,

                        NULL,
                        $7,

                        'completed',

                        $8,
                        $9
                    )
                    RETURNING *;
                    `,
                    [
                        employeeRFID,
                        employeeUsername,

                        mac_id,
                        mac_id,

                        midnightExit.toISOString(),
                        exit_at,

                        message_id,

                        entryDeviceName,
                        exitDeviceName
                    ]
                );

            const secondSession =
                secondResult.rows[0];

            await client.query("COMMIT");

            /* =============================================
               LOG BOTH SESSIONS
            ============================================= */

            const logData = {
                split: true,

                sessions: [
                    firstSession,
                    secondSession
                ],

                first_session: firstSession,
                second_session: secondSession
            };

            await addAttendanceLogModel({
                type: "add",
                employee_id,
                username: employeeUsername,
                user_at: actionUsername,
                old_value: null,
                new_value: logData
            });

            /* =============================================
               RESPONSE
            ============================================= */

            return {
                action: "entry",
                data: logData
            };

        } catch (error) {

            await client.query("ROLLBACK");

            console.error(
                "MANUAL OVERNIGHT ATTENDANCE ERROR:",
                error
            );

            throw error;

        } finally {

            client.release();
        }
    }

    /* =====================================================
       NEW ENTRY ONLY
       ===================================================== */

    const finalEntryAt =
        entry_at ??
        new Date().toISOString();

    const entryDeviceName =
        await getDeviceNameByMac(mac_id);

    const session =
        await createAttendanceSession({
            rfid: employeeRFID,

            entry_mac_id: mac_id,

            message_id,

            entry_at: finalEntryAt,

            exit_at: null,

            status: manualStatus
        });

    /* =====================================================
       CREATE OPEN SESSION
       ===================================================== */

    await createOpenSession({
        rfid: employeeRFID,
        mac_id,
        session_id: session.id,
        entry_at: session.entry_at
    });

    /* =====================================================
       ATTENDANCE LOG
       ===================================================== */

    await addAttendanceLogModel({
        type: "add",
        employee_id,
        username: session.username,
        user_at: actionUsername,
        old_value: null,
        new_value: session
    });

    return {
        action: "entry",
        data: session
    };
};

/* ================= ENTRY / EXIT LOGIC ================= */
export const saveAttendanceSession = async ({
    rfid,
    mac_id,
    message_id,
    deviceTimestamp
}) => {

    const username = await getUsernameByRFID(rfid);

    if (!username) {
        throw new Error("Employee not found.");
    }

    const originalTimestamp = parseTimestamp(deviceTimestamp);

    if (!originalTimestamp) {
        throw new Error("Invalid attendance timestamp.");
    }

    const expiredCompleted = await completeExpiredSessionByDeviceTimestamp({
            username,
            deviceTimestamp: originalTimestamp,
            mac_id,
            message_id
        });

    if (expiredCompleted) {
        await deleteOpenSession(
            expiredCompleted.id
        );

        return {
            action: "exit",
            data: expiredCompleted,
            source: "expired_offline_scan"
        };
    }

    /* ================= GET SHIFT ================= */
    const shift = await getEmployeeShiftBreakModel(username);
    const activeSession = await getOpenSession(username);

    /* =====================================================
       ENTRY
    ===================================================== */
    if (!activeSession) {
        let entryTime = originalTimestamp;

        if (
            isBreakTime(
                originalTimestamp,
                shift
            )
        ) {
            entryTime =
                new Date(
                    applyBreakTime(
                        originalTimestamp,
                        shift
                    )
                );
        }

        const session = await createAttendanceSession({
            rfid,
            entry_mac_id: mac_id,
            message_id,
            entry_at: entryTime,
            status: "inside"
        });

        await createOpenSession({
            rfid,
            mac_id,
            session_id: session.id,
            entry_at: entryTime
        });

        return {
            action: "entry",
            data: session
        };
    }

    /* =====================================================
       EXIT
    ===================================================== */
    let exitTime = originalTimestamp;

    const breakAdjustedEntry =
        isBreakAdjustedEntry(
            activeSession.entry_at,
            shift
        );

    if (
        breakAdjustedEntry &&
        isBreakTime(
            originalTimestamp,
            shift
        )
    ) {
        exitTime = new Date(
            applyBreakTime(
                originalTimestamp,
                shift
            )
        );
    }

    /* =====================================================
       COMPLETE EXISTING SESSION
    ===================================================== */
    const session = await completeAttendanceSession(
        activeSession.id,
        mac_id,
        message_id,
        exitTime
    );

    await deleteOpenSession(
        activeSession.id
    );

    return {
        action: "exit",
        data: session
    };
}

/* =========================================================
   COMPLETE EXPIRED SESSION FROM OFFLINE DEVICE SCAN
========================================================= */
export const completeExpiredSessionByDeviceTimestamp = async ({
    username,
    deviceTimestamp,
    mac_id,
    message_id
}) => {

    if (!username || !deviceTimestamp) {
        return null;
    }

    const { rows } = await pool.query(
        `
            UPDATE attendance_sessions AS a
            SET
                exit_at = $2::timestamptz,
                exit_mac_id = $3,
                exit_message_id = $4,
                duration = $2::timestamptz - a.entry_at,
                status = 'completed'
            WHERE a.id = (
                SELECT id
                FROM attendance_sessions
                WHERE username = $1
        
                  /* ONLY EXPIRED SESSION */
                  AND LOWER(TRIM(status::TEXT)) = 'expired'
        
                  /* EXIT DEVICE DATE MUST MATCH ENTRY DATE */
                  AND (
                        entry_at AT TIME ZONE 'Asia/Kolkata'
                      )::DATE
                      =
                      (
                        $2::timestamptz
                        AT TIME ZONE 'Asia/Kolkata'
                      )::DATE
        
                  /* Exit cannot be before entry */
                  AND entry_at <= $2::timestamptz
        
                  /* Only session without exit */
                  AND exit_at IS NULL
        
                ORDER BY entry_at DESC
                LIMIT 1
            )
            RETURNING *
        `,
        [
            username,
            deviceTimestamp,
            mac_id,
            message_id
        ]
    );

    return rows[0] || null;
};

/* ================= GET ATTENDANCE SESSIONS ================= */
export const getAttendanceSessionsModel = async ({
    rfid,
    entry_mac_id,
    exit_mac_id,
    status
}) => {
    let query = `
        SELECT 
            ats.*,
            ats.entry_mac_id,
            ats.exit_mac_id,

            /* ================= PERSONAL DETAILS ================= */
            pd.first_name,
            pd.middle_name,
            pd.last_name,
            pd.username AS employee_username,

            /* ================= EMPLOYMENT DETAILS ================= */
            ed.employment_id,
            ed.shift_id,
            sc.shift_type,
            ed.work_location,

            CONCAT(
                TO_CHAR(sc.start_time, 'HH24:MI'),
                ' - ',
                TO_CHAR(sc.end_time, 'HH24:MI')
            ) AS shift_time,

            /* ================= EMPLOYEE STATUS ================= */
            me.status AS employee_status

        FROM attendance_sessions ats

        LEFT JOIN employment_details ed
            ON ed.rfid = ats.rfid

        LEFT JOIN personal_details pd
            ON pd.id = ed.personal_details_id

        LEFT JOIN LATERAL (
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

        LEFT JOIN shift_configurations sc
            ON sc.id = ed.shift_id

        LEFT JOIN master_employee me
            ON me.personal_details_id = pd.id

        WHERE 1 = 1
    `;

    const values = [];
    let count = 1;

    if (rfid) {
        query += ` AND rfid = $${count}`;
        values.push(rfid);
        count++;
    }

    if (entry_mac_id) {
        query += ` AND ats.entry_mac_id = $${count}`;
        values.push(entry_mac_id);
        count++;
    }

    if (exit_mac_id) {
        query += ` AND ats.exit_mac_id = $${count}`;
        values.push(exit_mac_id);
        count++;
    }

    if (status) {
        query += ` AND status = $${count}`;
        values.push(status);
        count++;
    }

    query += `ORDER BY id DESC`;

    const { rows } = await pool.query(
        query,
        values
    );

    return rows;
};

/* ================= GET ATTENDANCE SESSION BY ID ================= */
export const getAttendanceSessionByIdModel = async (id) => {
    const query = `
        SELECT *
        FROM attendance_sessions
        WHERE id = $1
    `;

    const { rows } = await pool.query(query, [id]);

    return rows[0];
};

/* ================= GET EMPLOYEE SHIFT BREAK TIME ================= */
export const getEmployeeShiftBreakModel = async (username) => {

    const query = `
        SELECT
            sc.id,
            sc.shift_name,
            sc.shift_type,
            sc.break_start_time,
            sc.break_end_time,
            sc.start_time,
            sc.end_time

        FROM employment_details ed

        INNER JOIN personal_details pd
            ON pd.id = ed.personal_details_id

        LEFT JOIN LATERAL (
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

        LEFT JOIN shift_configurations sc
            ON sc.id = ed.shift_id

        WHERE LOWER(TRIM(pd.username))
            = LOWER(TRIM($1::TEXT))

        LIMIT 1
    `;

    const { rows } = await pool.query(
        query,
        [username]
    );

    return rows[0] || null;
};

/* ================= EDIT ATTENDANCE SESSION ================= */
export const editAttendanceSessionModel = async (
    id,
    { entry_at, exit_at, status }
) => {

    const client = await pool.connect();

    try {

        await client.query("BEGIN");

        /* =====================================================
           GET EXISTING SESSION
        ===================================================== */

        const existingResult = await client.query(
            `
                SELECT *
                FROM attendance_sessions
                WHERE id = $1
                FOR UPDATE
            `,
            [id]
        );

        if (!existingResult.rows.length) {
            throw new Error("Attendance session not found.");
        }

        const existing = existingResult.rows[0];

        /* =====================================================
           FINAL VALUES
        ===================================================== */

        const finalEntryAt =
            entry_at ?? existing.entry_at;

        const finalStatus =
            status ?? existing.status;

        let finalExitAt;

        if (finalStatus === "inside") {
            finalExitAt = null;
        } else {
            finalExitAt =
                exit_at ?? existing.exit_at;
        }

        /* =====================================================
           VALIDATE ENTRY
        ===================================================== */

        const entryDateObj =
            finalEntryAt
                ? new Date(finalEntryAt)
                : null;

        const exitDateObj =
            finalExitAt
                ? new Date(finalExitAt)
                : null;

        if (
            !entryDateObj ||
            Number.isNaN(entryDateObj.getTime())
        ) {
            throw new Error(
                "Invalid attendance entry timestamp."
            );
        }

        /* =====================================================
           INSIDE SESSION
           -----------------------------------------------------
           No exit => normal single record
        ===================================================== */

        if (!exitDateObj) {

            const result = await client.query(
                `
                    UPDATE attendance_sessions
                    SET
                        entry_at = $1::timestamptz,

                        entry_mac_id =
                            CASE
                                WHEN $1 IS NOT NULL
                                THEN 'MANUAL'
                                ELSE entry_mac_id
                            END,

                        entry_device_name =
                            CASE
                                WHEN $1 IS NOT NULL
                                THEN 'MANUAL'
                                ELSE entry_device_name
                            END,

                        exit_at = NULL,
                        exit_mac_id = NULL,
                        exit_device_name = NULL,
                        exit_message_id = NULL,

                        duration = NULL,

                        status = 'inside',

                        updated_at = CURRENT_TIMESTAMP

                    WHERE id = $2

                    RETURNING *;
                `,
                [
                    finalEntryAt,
                    id
                ]
            );

            await client.query("COMMIT");

            return result.rows[0];
        }

        /* =====================================================
           VALIDATE EXIT
        ===================================================== */

        if (
            Number.isNaN(exitDateObj.getTime())
        ) {
            throw new Error(
                "Invalid attendance exit timestamp."
            );
        }

        if (
            exitDateObj <= entryDateObj
        ) {
            throw new Error(
                "Exit time must be greater than entry time."
            );
        }

        /* =====================================================
           INDIA CALENDAR DATE
        ===================================================== */

        const entryDate =
            entryDateObj.toLocaleDateString(
                "en-CA",
                {
                    timeZone: "Asia/Kolkata"
                }
            );

        const exitDate =
            exitDateObj.toLocaleDateString(
                "en-CA",
                {
                    timeZone: "Asia/Kolkata"
                }
            );

        /* =====================================================
           SAME DATE
        ===================================================== */

        if (entryDate === exitDate) {

            const result = await client.query(
                `
                    UPDATE attendance_sessions
                    SET
                        entry_at = $1::timestamptz,

                        entry_mac_id =
                            CASE
                                WHEN $1 IS NOT NULL
                                THEN 'MANUAL'
                                ELSE entry_mac_id
                            END,

                        entry_device_name =
                            CASE
                                WHEN $1 IS NOT NULL
                                THEN 'MANUAL'
                                ELSE entry_device_name
                            END,

                        exit_at = $2::timestamptz,

                        exit_mac_id = 'MANUAL',
                        exit_device_name = 'MANUAL',

                        duration =
                            $2::timestamptz
                            - $1::timestamptz,

                        status = 'completed',

                        updated_at = CURRENT_TIMESTAMP

                    WHERE id = $3

                    RETURNING *;
                `,
                [
                    finalEntryAt,
                    finalExitAt,
                    id
                ]
            );

            await client.query("COMMIT");

            return result.rows[0];
        }

        /* =====================================================
           CROSS-DATE ATTENDANCE
           =====================================================

           Example:

           Entry:
           09-10-2026 09:00

           Exit:
           10-10-2026 04:00

           Record 1:
           09-10-2026 09:00
           ->
           09-10-2026 23:59:59

           Record 2:
           10-10-2026 00:00
           ->
           10-10-2026 04:00
        ===================================================== */

        const midnightExit =
            new Date(
                `${exitDate}T00:00:00+05:30`
            );

        const previousDayEnd =
            new Date(
                midnightExit.getTime() - 1000
            );

        /* =====================================================
           UPDATE FIRST RECORD
        ===================================================== */

        const firstResult =
            await client.query(
                `
                    UPDATE attendance_sessions
                    SET
                        entry_at =
                            $1::timestamptz,

                        exit_at =
                            $2::timestamptz,

                        exit_mac_id =
                            'MANUAL',

                        exit_device_name =
                            'MANUAL',

                        exit_message_id =
                            NULL,

                        duration =
                            $2::timestamptz
                            - $1::timestamptz,

                        status =
                            'completed',

                        updated_at =
                            CURRENT_TIMESTAMP

                    WHERE id = $3

                    RETURNING *;
                `,
                [
                    finalEntryAt,
                    previousDayEnd.toISOString(),
                    id
                ]
            );

        const firstSession =
            firstResult.rows[0];

        /* =====================================================
           CREATE SECOND RECORD
        ===================================================== */

        const secondResult =
            await client.query(
                `
                    INSERT INTO attendance_sessions
                    (
                        rfid,
                        username,

                        entry_mac_id,
                        entry_device_name,

                        exit_mac_id,
                        exit_device_name,

                        entry_at,
                        exit_at,

                        duration,

                        entry_message_id,
                        exit_message_id,

                        status
                    )

                    VALUES
                    (
                        $1,
                        $2,

                        $3,
                        $4,

                        'MANUAL',
                        'MANUAL',

                        $5::timestamptz,
                        $6::timestamptz,

                        $6::timestamptz
                        - $5::timestamptz,

                        NULL,
                        NULL,

                        'completed'
                    )

                    RETURNING *;
                `,
                [
                    existing.rfid,
                    existing.username,

                    existing.entry_mac_id,
                    existing.entry_device_name,

                    midnightExit.toISOString(),
                    finalExitAt
                ]
            );

        const secondSession =
            secondResult.rows[0];

        /* =====================================================
           COMMIT
        ===================================================== */

        await client.query("COMMIT");

        /* =====================================================
           RETURN FIRST RECORD
           + SECOND RECORD INFORMATION
        ===================================================== */

        return {
            ...firstSession,

            split: true,

            first_session:
                firstSession,

            second_session:
                secondSession,

            sessions: [
                firstSession,
                secondSession
            ]
        };

    } catch (error) {
        await client.query("ROLLBACK");
        console.error("EDIT ATTENDANCE SESSION ERROR:", error);
        throw error;

    } finally {
        client.release();
    }
};

/* ================= DELETE ATTENDANCE SESSION ================= */
export const deleteAttendanceSessionModel = async (id) => {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const { rows } = await client.query(
            `
                DELETE FROM attendance_sessions
                WHERE id = $1
                RETURNING *;
            `,
            [id]
        );

        if (rows[0]) {
            await client.query(
                `
                    DELETE FROM open_sessions
                    WHERE session_id = $1;
                `,
                [id]
            );
        }

        await client.query("COMMIT");
        return rows[0];
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
};

/* ================= GET ATTENDANCE BY USERNAME ================= */
export const getAttendanceByUsernameModel = async ({
    month = null,
    year = null,
    date = null,
    username = null,
    first_name = null,
    middle_name = null,
    last_name = null,
    employment_id = null,
    department = null,
    category = null,
    shift_type = null,
    work_location = null,
    rfid = null,
    entry_mac_id = null,
    exit_mac_id = null,
    entry_at = null,
    exit_at = null,
    status = null,
    duration = null,
    page = 1,
    limit = 20
}) => {

    page = Math.max(Number(page) || 1, 1);
    limit = Math.max(Number(limit) || 20, 1);

    const offset = (page - 1) * limit;
    const dateValue = date || null;

    /* ============================================================
       MAIN QUERY
    ============================================================ */
    const values = [dateValue];
    let count = 2;

    let query = `
        SELECT

            /* ================= PERSONAL ================= */
            pd.username AS employee_username,
            pd.first_name,
            pd.middle_name,
            pd.last_name,
            COALESCE(
                NULLIF(BTRIM(pd.image), ''),
                category_image.category_image
            ) AS image,

            /* ================= EMPLOYEE PAGINATION ================= */
            DENSE_RANK() OVER (
                ORDER BY
                    ed.employment_id ASC,
                    pd.username ASC
            ) AS employee_rank,

            /* ================= EMPLOYMENT ================= */
            ed.employment_id,
            ds.name AS department,

            /* ================= SHIFT ================= */
            ed.shift_id,
            sc.shift_name AS shift_name,
            sc.shift_type AS shift_type,

            CONCAT(
                TO_CHAR(sc.start_time, 'HH24:MI'),
                ' - ',
                TO_CHAR(sc.end_time, 'HH24:MI')
            ) AS shift_time,

            sc.start_time AS shift_start_time,
            sc.end_time AS shift_end_time,

            /* ================= BREAK TIME ================= */
            sc.break_start_time AS break_start_time,
            sc.break_end_time AS break_end_time,

            sc.late_arrival_count_time AS late_arrival_count_time,
            sc.early_leave_count_time AS early_leave_count_time,

            /* ================= LATE / EARLY STATUS ================= */
            CASE

                /* ================= BOTH LATE + EARLY ================= */
                WHEN ats.entry_at IS NOT NULL
                     AND ats.exit_at IS NOT NULL
                     AND sc.start_time IS NOT NULL
                     AND sc.end_time IS NOT NULL
                     AND sc.late_arrival_count_time IS NOT NULL
                     AND sc.early_leave_count_time IS NOT NULL

                     AND (
                         ats.entry_at AT TIME ZONE 'Asia/Kolkata'
                     )::time
                     >
                     (
                         sc.start_time
                         + (
                             sc.late_arrival_count_time::INT
                             * INTERVAL '1 minute'
                         )
                     )::time

                     AND (
                         ats.exit_at AT TIME ZONE 'Asia/Kolkata'
                     )::time
                     <
                     (
                         sc.end_time
                         - (
                             sc.early_leave_count_time::INT
                             * INTERVAL '1 minute'
                         )
                     )::time

                THEN 'LA_EE'

                /* ================= LATE ARRIVAL ================= */
                WHEN ats.entry_at IS NOT NULL
                     AND sc.start_time IS NOT NULL
                     AND sc.late_arrival_count_time IS NOT NULL

                     AND (
                         ats.entry_at AT TIME ZONE 'Asia/Kolkata'
                     )::time
                     >
                     (
                         sc.start_time
                         + (
                             sc.late_arrival_count_time::INT
                             * INTERVAL '1 minute'
                         )
                     )::time

                THEN 'LA'

                /* ================= EARLY EXIT ================= */
                WHEN ats.exit_at IS NOT NULL
                     AND sc.end_time IS NOT NULL
                     AND sc.early_leave_count_time IS NOT NULL

                     AND (
                         ats.exit_at AT TIME ZONE 'Asia/Kolkata'
                     )::time
                     <
                     (
                         sc.end_time
                         - (
                             sc.early_leave_count_time::INT
                             * INTERVAL '1 minute'
                         )
                     )::time

                THEN 'EE'

                /* ================= ON TIME ================= */
                WHEN ats.entry_at IS NOT NULL
                     OR ats.exit_at IS NOT NULL
                THEN 'On Time'

                ELSE NULL

            END AS attendance_time_status,

            /* ================= WORK LOCATION ================= */
            ed.work_location AS work_location_id,
            wl.location AS work_location,

            /* ================= CATEGORY ================= */
            ed.category AS category_id,
            cat.category_name AS category,

            /* ================= SALARY ================= */
            sd.current_salary,

            /* ================= ATTENDANCE ================= */
            ats.id AS attendance_id,
            ats.rfid,
            ats.entry_mac_id,
            ats.entry_device_name,
            ats.exit_mac_id,
            ats.exit_device_name,

            CASE
                WHEN ats.entry_at IS NOT NULL THEN
                    TO_CHAR(
                        ats.entry_at AT TIME ZONE 'Asia/Kolkata',
                        'DD-MM-YYYY HH24:MI:SS'
                    )
                ELSE NULL
            END AS entry_at,

            CASE
                WHEN ats.exit_at IS NOT NULL THEN
                    TO_CHAR(
                        ats.exit_at AT TIME ZONE 'Asia/Kolkata',
                        'DD-MM-YYYY HH24:MI:SS'
                    )
                ELSE NULL
            END AS exit_at,

            /* ================= ATTENDANCE STATUS ================= */
            CASE

                WHEN ats.id IS NOT NULL
                     AND LOWER(TRIM(ats.status::TEXT)) = 'expired'
                THEN 'Expired'

                /* Holiday day + attendance entry = Present */
                WHEN ats.id IS NOT NULL
                     AND h.id IS NOT NULL
                THEN 'Present'
            
                /* Normal attendance */
                WHEN ats.id IS NOT NULL
                THEN COALESCE(
                    ats.status,
                    'Present'
                )

                /* Holiday */
                WHEN h.id IS NOT NULL
                THEN 'Holiday'

                /* Weekly off */
                WHEN $1::date IS NOT NULL
                     AND (
                        (
                            COALESCE(cardinality(sc.days), 0) > 0
                            AND NOT EXISTS (
                                SELECT 1
                                FROM unnest(sc.days) AS shift_days(shift_day)
                                WHERE UPPER(TRIM(shift_day)) = CASE
                                    EXTRACT(DOW FROM $1::date)::INT
                                    WHEN 0 THEN 'SUN'
                                    WHEN 1 THEN 'MON'
                                    WHEN 2 THEN 'TUE'
                                    WHEN 3 THEN 'WED'
                                    WHEN 4 THEN 'THU'
                                    WHEN 5 THEN 'FRI'
                                    WHEN 6 THEN 'SAT'
                                END
                            )
                        )
                        OR (
                            COALESCE(cardinality(sc.days), 0) = 0
                            AND EXTRACT(DOW FROM $1::date)::INT = 0
                        )
                        OR EXISTS (
                            SELECT 1
                            FROM holidays hh
                            WHERE hh.transfer_date = $1::date
                              AND (
                                    hh.locations IS NULL
                                    OR array_length(hh.locations, 1) IS NULL
                                    OR ed.work_location::TEXT = ANY(hh.locations)
                              )
                        )
                     )
                THEN 'Weekly Off'

                /* No Attendance */
                ELSE 'Absent'
            END AS status,
            
            ats.duration,

            /* ================= LEAVE ================= */
            el.id AS leave_id,
            el.leave_type,
            el.reason,
            el.description,

            /* ================= HOLIDAY ================= */
            h.id AS holiday_id,
            h.holiday_name,

            /* ================= CREATED ================= */
            CASE
                WHEN ats.created_at IS NOT NULL THEN
                    TO_CHAR(
                        ats.created_at AT TIME ZONE 'Asia/Kolkata',
                        'DD-MM-YYYY HH24:MI:SS'
                    )
                ELSE NULL
            END AS attendance_created_at,

            /* ================= WEEKLY OFF ================= */
            CASE

                WHEN $1::date IS NOT NULL
                     AND (
                        (
                            COALESCE(cardinality(sc.days), 0) > 0
                            AND NOT EXISTS (
                                SELECT 1
                                FROM unnest(sc.days) AS shift_days(shift_day)
                                WHERE UPPER(TRIM(shift_day)) = CASE
                                    EXTRACT(DOW FROM $1::date)::INT
                                    WHEN 0 THEN 'SUN'
                                    WHEN 1 THEN 'MON'
                                    WHEN 2 THEN 'TUE'
                                    WHEN 3 THEN 'WED'
                                    WHEN 4 THEN 'THU'
                                    WHEN 5 THEN 'FRI'
                                    WHEN 6 THEN 'SAT'
                                END
                            )
                        )
                        OR (
                            COALESCE(cardinality(sc.days), 0) = 0
                            AND EXTRACT(DOW FROM $1::date)::INT = 0
                        )
                     )
                THEN TRUE

                WHEN $1::date IS NOT NULL
                     AND EXISTS (
                        SELECT 1
                        FROM holidays hh
                        WHERE hh.transfer_date = $1::date
                          AND (
                                hh.locations IS NULL
                                OR array_length(
                                    hh.locations,
                                    1
                                ) IS NULL
                                OR ed.work_location::TEXT
                                   = ANY(hh.locations)
                          )
                     )
                THEN TRUE

                ELSE FALSE

            END AS is_weekly_off

        FROM personal_details pd

        /* ================= EMPLOYMENT ================= */
        LEFT JOIN employment_details ed
            ON ed.personal_details_id = pd.id

        /* ================= MASTER EMPLOYEE ================= */
        LEFT JOIN master_employee me
            ON me.personal_details_id = pd.id

        /* ================= INACTIVE ================= */
        LEFT JOIN inactive_employee ie
            ON ie.personal_details_id = pd.id

        LEFT JOIN LATERAL (
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

        /* ================= SHIFT ================= */
        LEFT JOIN shift_configurations sc
            ON sc.id = ed.shift_id

        /* ================= WORK LOCATION ================= */
        LEFT JOIN work_location wl
            ON wl.id = ed.work_location

        /* ================= CATEGORY ================= */
        LEFT JOIN category cat
            ON cat.id = ed.category

        LEFT JOIN LATERAL (
            SELECT c.category_image
            FROM category c
            WHERE LOWER(TRIM(c.category_name)) =
                  LOWER(TRIM(cat.category_name))
              AND c.work_location = ed.work_location
              AND NULLIF(BTRIM(c.category_image), '') IS NOT NULL
            ORDER BY c.id DESC
            LIMIT 1
        ) category_image ON TRUE

        /* ================= DEPARTMENT ================= */
        LEFT JOIN department_structure ds
            ON ds.id = ed.department

        /* ================= SALARY ================= */
        LEFT JOIN salary_details sd
            ON sd.personal_details_id = pd.id

        /* ================= ATTENDANCE ================= */
        LEFT JOIN attendance_sessions ats
            ON ats.username = pd.username
            AND (
                $1::date IS NULL
                OR (
                    ats.entry_at
                    AT TIME ZONE 'Asia/Kolkata'
                )::date = $1::date
            )

        /* ================= LEAVE ================= */
        LEFT JOIN employee_leaves el
            ON el.username = pd.username
            AND (
                $1::date IS NULL
                OR $1::date BETWEEN
                    el.start_leave_date
                    AND el.end_leave_date
            )
            AND (
                $1::date IS NULL
                OR (
                    (
                        (
                            COALESCE(cardinality(sc.days), 0) > 0
                            AND EXISTS (
                                SELECT 1
                                FROM unnest(sc.days) AS shift_days(shift_day)
                                WHERE UPPER(TRIM(shift_day)) = CASE
                                    EXTRACT(DOW FROM $1::date)::INT
                                    WHEN 0 THEN 'SUN'
                                    WHEN 1 THEN 'MON'
                                    WHEN 2 THEN 'TUE'
                                    WHEN 3 THEN 'WED'
                                    WHEN 4 THEN 'THU'
                                    WHEN 5 THEN 'FRI'
                                    WHEN 6 THEN 'SAT'
                                END
                            )
                        )
                        OR (
                            COALESCE(cardinality(sc.days), 0) = 0
                            AND EXTRACT(DOW FROM $1::date)::INT <> 0
                        )
                    )
                    AND NOT EXISTS (
                        SELECT 1
                        FROM holidays hh
                        WHERE hh.holiday_date = $1::date
                          AND (
                                hh.locations IS NULL
                                OR array_length(hh.locations, 1) IS NULL
                                OR ed.work_location::TEXT = ANY(hh.locations)
                          )
                    )
                    AND NOT EXISTS (
                        SELECT 1
                        FROM holidays hh
                        WHERE hh.transfer_date = $1::date
                          AND (
                                hh.locations IS NULL
                                OR array_length(hh.locations, 1) IS NULL
                                OR ed.work_location::TEXT = ANY(hh.locations)
                          )
                    )
                )
            )

        /* ================= HOLIDAY ================= */
        LEFT JOIN holidays h
            ON h.holiday_date = $1::date
            AND h.transfer_date IS NULL
            AND (
                h.locations IS NULL
                OR array_length(
                    h.locations,
                    1
                ) IS NULL
                OR ed.work_location::TEXT
                   = ANY(h.locations)
            )

        WHERE 1 = 1

        /* ================= SHOW IN ATTENDANCE ================= */
        AND ed.show_in_attendance = TRUE

        /* ================= ACTIVE / INACTIVE ================= */
        AND (
            LOWER(TRIM(me.status)) = 'active'

            OR (

                LOWER(TRIM(me.status)) = 'inactive'

                AND LOWER(
                    TRIM(
                        COALESCE(
                            ie.past_status,
                            ''
                        )
                    )
                ) = 'active'

                AND (
                    ie.inactive_date IS NULL
                    OR $1::date IS NULL
                    OR DATE(
                        ie.inactive_date
                    ) >= $1::date
                )

            )
        )

        /* ================= JOINING DATE ================= */
        AND (

            (
                LOWER(TRIM(me.status)) = 'active'

                AND (
                    $1::date IS NULL
                    OR DATE(
                        ed.date_of_joining
                    ) <= $1::date
                )
            )

            OR

            (

                LOWER(TRIM(me.status)) = 'inactive'

                AND LOWER(
                    TRIM(
                        COALESCE(
                            ie.past_status,
                            ''
                        )
                    )
                ) = 'active'

                AND (
                    $1::date IS NULL
                    OR DATE(
                        ed.date_of_joining
                    ) <= $1::date
                )

                AND (
                    ie.inactive_date IS NULL
                    OR $1::date IS NULL
                    OR DATE(
                        ie.inactive_date
                    ) >= $1::date
                )
            )
        )
    `;

    /* ============================================================
       MONTH
    ============================================================ */
    if (month) {

        query += `
            AND EXTRACT(
                MONTH FROM
                ats.entry_at AT TIME ZONE 'Asia/Kolkata'
            ) = $${count}
        `;

        values.push(Number(month));
        count++;
    }

    /* ============================================================
       YEAR
    ============================================================ */
    if (year) {

        query += `
            AND EXTRACT(
                YEAR FROM
                ats.entry_at AT TIME ZONE 'Asia/Kolkata'
            ) = $${count}
        `;

        values.push(Number(year));
        count++;
    }

    /* ============================================================
       USERNAME / NAME
    ============================================================ */
    if (username) {

        query += `
            AND (
                pd.username ILIKE $${count}
                OR pd.first_name ILIKE $${count}
                OR pd.middle_name ILIKE $${count}
                OR pd.last_name ILIKE $${count}

                OR CONCAT(
                    COALESCE(pd.first_name, ''),
                    ' ',
                    COALESCE(pd.middle_name, ''),
                    ' ',
                    COALESCE(pd.last_name, '')
                ) ILIKE $${count}
            )
        `;

        values.push(`%${username}%`);
        count++;
    }

    /* ============================================================
       DEPARTMENT
    ============================================================ */
    if (department) {

        query += `
            AND ds.name ILIKE $${count}
        `;

        values.push(`%${department}%`);
        count++;
    }

    /* ============================================================
       CATEGORY
    ============================================================ */
    if (category) {

        query += `
            AND cat.category_name ILIKE $${count}
        `;

        values.push(`%${category}%`);
        count++;
    }

    /* ============================================================
       FIRST NAME
    ============================================================ */
    if (first_name) {

        query += `
            AND pd.first_name ILIKE $${count}
        `;

        values.push(`%${first_name}%`);
        count++;
    }

    /* ============================================================
       MIDDLE NAME
    ============================================================ */
    if (middle_name) {

        query += `
            AND pd.middle_name ILIKE $${count}
        `;

        values.push(`%${middle_name}%`);
        count++;
    }

    /* ============================================================
       LAST NAME
    ============================================================ */
    if (last_name) {

        query += `
            AND pd.last_name ILIKE $${count}
        `;

        values.push(`%${last_name}%`);
        count++;
    }

    /* ============================================================
       EMPLOYMENT ID
    ============================================================ */
    if (employment_id) {

        query += `
            AND ed.employment_id ILIKE $${count}
        `;

        values.push(`%${employment_id}%`);
        count++;
    }

    /* ============================================================
       SHIFT TYPE
    ============================================================ */
    if (shift_type) {

        query += `
            AND sc.shift_type ILIKE $${count}
        `;

        values.push(`%${shift_type}%`);
        count++;
    }

    /* ============================================================
       WORK LOCATION
    ============================================================ */
    const workLocationFilters = Array.isArray(work_location)
        ? work_location
            .map(value => String(value).trim())
            .filter(Boolean)
        : String(work_location || "")
            .split(",")
            .map(value => value.trim())
            .filter(Boolean);

    const isAllLocation =
        workLocationFilters.some(
            value =>
                value.toLowerCase() === "all"
        );

    if (
        !isAllLocation &&
        workLocationFilters.length
    ) {

        const locationIds =
            workLocationFilters
                .filter(
                    value => /^\d+$/.test(value)
                )
                .map(Number);

        const locationNames = workLocationFilters
            .filter(value => !/^\d+$/.test(value))
            .map(value => value.toLowerCase());

        const conditions = [];
        const locationValues = [];

        if (locationIds.length) {
            conditions.push(
                `ed.work_location = ANY($${count}::INTEGER[])`
            );

            locationValues.push(locationIds);
            count++;
        }

        if (locationNames.length) {
            conditions.push(
                `LOWER(TRIM(wl.location)) = ANY($${count}::TEXT[])`
            );

            locationValues.push(locationNames);
            count++;
        }

        if (conditions.length) {
            query += `
                AND (
                    ${conditions.join(" OR ")}
                )
            `;

            values.push(...locationValues);
        }
    }

    /* ============================================================
       RFID
    ============================================================ */
    if (rfid) {

        query += `
            AND ats.rfid ILIKE $${count}
        `;

        values.push(`%${rfid}%`);
        count++;
    }

    /* ============================================================
       ENTRY MAC
    ============================================================ */
    if (entry_mac_id) {

        query += `
            AND ats.entry_mac_id = $${count}
        `;

        values.push(entry_mac_id);
        count++;
    }

    /* ============================================================
       EXIT MAC
    ============================================================ */
    if (exit_mac_id) {

        query += `
            AND ats.exit_mac_id = $${count}
        `;

        values.push(exit_mac_id);
        count++;
    }

    /* ============================================================
       ENTRY TIME
    ============================================================ */
    if (entry_at) {

        query += `
            AND (
                ats.entry_at
                AT TIME ZONE 'Asia/Kolkata'
            )::time = $${count}::time
        `;

        values.push(entry_at);
        count++;
    }

    /* ============================================================
       EXIT TIME
    ============================================================ */
    if (exit_at) {

        query += `
            AND (
                ats.exit_at
                AT TIME ZONE 'Asia/Kolkata'
            )::time = $${count}::time
        `;

        values.push(exit_at);
        count++;
    }

    /* ============================================================
       STATUS
    ============================================================ */
    if (status) {

        const normalizedStatus =
            String(status)
                .trim()
                .toLowerCase();

        query += `
            AND LOWER(
                CASE

                    /* ================= EXPIRED ================= */
                    WHEN ats.id IS NOT NULL
                         AND LOWER(TRIM(ats.status::TEXT)) = 'expired'
                    THEN 'Expired'

                    /* ================= ATTENDANCE ================= */
                    WHEN ats.id IS NOT NULL
                         AND h.id IS NOT NULL
                    THEN 'Present'

                    WHEN ats.id IS NOT NULL
                    THEN COALESCE(
                        ats.status,
                        'Present'
                    )

                    /* ================= HOLIDAY ================= */
                    WHEN h.id IS NOT NULL
                    THEN 'Holiday'

                    /* ================= SUNDAY ================= */
                    WHEN $1::date IS NOT NULL
                         AND EXTRACT(
                             DOW FROM $1::date
                         ) = 0
                    THEN 'Weekly Off'

                    /* ================= ABSENT ================= */
                    ELSE 'Absent'

                END
            ) = $${count}
        `;

        values.push(normalizedStatus);
        count++;
    }

    /* ============================================================
       DURATION
    ============================================================ */
    if (duration) {

        query += `
            AND ats.duration = $${count}::interval
        `;

        values.push(duration);
        count++;
    }

    /* ============================================================
       EMPLOYEE-WISE PAGINATION
    ============================================================ */
    const summaryQuery = `
        SELECT
            COUNT(DISTINCT employee_username)
                FILTER (WHERE attendance_id IS NOT NULL) AS total_present,

            COUNT(DISTINCT employee_username)
                FILTER (
                    WHERE attendance_id IS NULL
                      AND holiday_id IS NULL
                      AND NOT COALESCE(is_weekly_off, FALSE)
                      AND (
                          leave_id IS NULL
                          OR $1::date < (
                              CURRENT_TIMESTAMP
                              AT TIME ZONE 'Asia/Kolkata'
                          )::date
                      )
                ) AS total_absent
        FROM (
            ${query}
        ) AS attendance_summary
    `;
    const summaryValues = [...values];

    const offsetParam = count;
    const limitParam = count + 1;

    values.push(offset);
    values.push(limit);

    query = `
        SELECT *
        FROM (
            ${query}
        ) AS attendance_data

        WHERE employee_rank > $${offsetParam}
          AND employee_rank <= (
              $${offsetParam} + $${limitParam}
          )

        ORDER BY
            employment_id ASC,
            employee_username ASC,

            CASE
                WHEN status = 'inside'
                THEN 0
                ELSE 1
            END,

            entry_at DESC NULLS LAST,
            attendance_created_at DESC NULLS LAST,
            attendance_id DESC
    `;

    /* ============================================================
       COUNT QUERY
    ============================================================ */
    const countValues = [dateValue];
    let countIndex = 2;

    let countQuery = `
        SELECT COUNT(DISTINCT pd.username) AS total

        FROM personal_details pd

        LEFT JOIN employment_details ed
            ON ed.personal_details_id = pd.id

        LEFT JOIN master_employee me
            ON me.personal_details_id = pd.id

        LEFT JOIN inactive_employee ie
            ON ie.personal_details_id = pd.id

        /* ================= CATEGORY ================= */
        LEFT JOIN category cat
            ON cat.id = ed.category

        /* ================= DEPARTMENT ================= */
        LEFT JOIN department_structure ds
            ON ds.id = ed.department

        /* ================= LOCATION ================= */
        LEFT JOIN work_location wl
            ON wl.id = ed.work_location

        LEFT JOIN LATERAL (
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

        /* ================= SHIFT ================= */
        LEFT JOIN shift_configurations sc
            ON sc.id = ed.shift_id

        /* ================= ATTENDANCE ================= */
        LEFT JOIN attendance_sessions ats
            ON ats.username = pd.username
            AND (
                $1::date IS NULL
                OR (
                    ats.entry_at
                    AT TIME ZONE 'Asia/Kolkata'
                )::date = $1::date
            )

        WHERE 1 = 1

        /* ================= SHOW IN ATTENDANCE ================= */
        AND ed.show_in_attendance = TRUE

        /* ================= ACTIVE / INACTIVE ================= */
        AND (
            LOWER(TRIM(me.status)) = 'active'

            OR (

                LOWER(TRIM(me.status)) = 'inactive'

                AND LOWER(
                    TRIM(
                        COALESCE(
                            ie.past_status,
                            ''
                        )
                    )
                ) = 'active'

                AND (
                    ie.inactive_date IS NULL
                    OR $1::date IS NULL
                    OR DATE(
                        ie.inactive_date
                    ) >= $1::date
                )

            )
        )

        /* ================= JOINING DATE ================= */
        AND (

            (
                LOWER(TRIM(me.status)) = 'active'

                AND (
                    $1::date IS NULL
                    OR DATE(ed.date_of_joining) <= $1::date
                )
            )

            OR

            (

                LOWER(TRIM(me.status)) = 'inactive'

                AND LOWER(
                    TRIM(
                        COALESCE(ie.past_status, '')
                    )
                ) = 'active'

                AND (
                    $1::date IS NULL
                    OR DATE(ed.date_of_joining) <= $1::date
                )

                AND (
                    ie.inactive_date IS NULL
                    OR $1::date IS NULL
                    OR DATE(ie.inactive_date) >= $1::date
                )
            )
        )
    `;

    /* ============================================================
       COUNT MONTH
    ============================================================ */
    if (month) {

        countQuery += `
            AND EXTRACT(
                MONTH FROM
                ats.entry_at AT TIME ZONE 'Asia/Kolkata'
            ) = $${countIndex}
        `;

        countValues.push(Number(month));
        countIndex++;
    }

    /* ============================================================
       COUNT YEAR
    ============================================================ */
    if (year) {

        countQuery += `
            AND EXTRACT(
                YEAR FROM
                ats.entry_at AT TIME ZONE 'Asia/Kolkata'
            ) = $${countIndex}
        `;

        countValues.push(Number(year));
        countIndex++;
    }

    /* ================= COUNT USERNAME ================= */
    if (username) {

        countQuery += `
            AND (
                pd.username ILIKE $${countIndex}
                OR pd.first_name ILIKE $${countIndex}
                OR pd.middle_name ILIKE $${countIndex}
                OR pd.last_name ILIKE $${countIndex}

                OR CONCAT(
                    COALESCE(pd.first_name, ''),
                    ' ',
                    COALESCE(pd.middle_name, ''),
                    ' ',
                    COALESCE(pd.last_name, '')
                ) ILIKE $${countIndex}
            )
        `;

        countValues.push(`%${username}%`);
        countIndex++;
    }

    /* ================= COUNT DEPARTMENT ================= */
    if (department) {

        countQuery += `
            AND ds.name ILIKE $${countIndex}
        `;

        countValues.push(`%${department}%`);
        countIndex++;
    }

    /* ================= COUNT CATEGORY ================= */
    if (category) {

        countQuery += `
            AND cat.category_name ILIKE $${countIndex}
        `;

        countValues.push(`%${category}%`);
        countIndex++;
    }

    /* ================= COUNT FIRST NAME ================= */
    if (first_name) {

        countQuery += `
            AND pd.first_name ILIKE $${countIndex}
        `;

        countValues.push(`%${first_name}%`);
        countIndex++;
    }

    /* ================= COUNT MIDDLE NAME ================= */
    if (middle_name) {

        countQuery += `
            AND pd.middle_name ILIKE $${countIndex}
        `;

        countValues.push(`%${middle_name}%`);
        countIndex++;
    }

    /* ================= COUNT LAST NAME ================= */
    if (last_name) {

        countQuery += `
            AND pd.last_name ILIKE $${countIndex}
        `;

        countValues.push(`%${last_name}%`);
        countIndex++;
    }

    /* ================= COUNT EMPLOYMENT ID ================= */
    if (employment_id) {

        countQuery += `
            AND ed.employment_id ILIKE $${countIndex}
        `;

        countValues.push(`%${employment_id}%`);
        countIndex++;
    }

    /* ================= COUNT SHIFT TYPE ================= */
    if (shift_type) {

        countQuery += `
            AND sc.shift_type ILIKE $${countIndex}
        `;

        countValues.push(`%${shift_type}%`);
        countIndex++;
    }

    /* ================= COUNT WORK LOCATION ================= */
    if (!isAllLocation && workLocationFilters.length) {

        const locationIds = workLocationFilters
            .filter(value => /^\d+$/.test(value))
            .map(Number);

        const locationNames = workLocationFilters
            .filter(value => !/^\d+$/.test(value))
            .map(value => value.toLowerCase());

        const conditions = [];
        const locationValues = [];

        if (locationIds.length) {

            conditions.push(
                `ed.work_location = ANY($${countIndex}::INTEGER[])`
            );

            locationValues.push(locationIds);
            countIndex++;
        }

        if (locationNames.length) {

            conditions.push(
                `LOWER(TRIM(wl.location)) = ANY($${countIndex}::TEXT[])`
            );

            locationValues.push(locationNames);
            countIndex++;
        }

        if (conditions.length) {

            countQuery += `
                AND (
                    ${conditions.join(" OR ")}
                )
            `;

            countValues.push(...locationValues);
        }
    }

    /* ================= COUNT RFID ================= */
    if (rfid) {

        countQuery += `
            AND ats.rfid ILIKE $${countIndex}
        `;

        countValues.push(`%${rfid}%`);
        countIndex++;
    }

    /* ================= COUNT ENTRY MAC ================= */
    if (entry_mac_id) {

        countQuery += `
            AND ats.entry_mac_id = $${countIndex}
        `;

        countValues.push(entry_mac_id);
        countIndex++;
    }

    /* ================= COUNT EXIT MAC ================= */
    if (exit_mac_id) {

        countQuery += `
            AND ats.exit_mac_id = $${countIndex}
        `;

        countValues.push(exit_mac_id);
        countIndex++;
    }

    /* ================= COUNT ENTRY TIME ================= */
    if (entry_at) {

        countQuery += `
            AND ats.entry_at::time = $${countIndex}::time
        `;

        countValues.push(entry_at);
        countIndex++;
    }

    /* ================= COUNT EXIT TIME ================= */
    if (exit_at) {

        countQuery += `
            AND ats.exit_at::time = $${countIndex}::time
        `;

        countValues.push(exit_at);
        countIndex++;
    }

    /* ================= COUNT STATUS ================= */
    if (status) {

        const normalizedStatus =
            String(status)
                .trim()
                .toLowerCase();

        countQuery += `
            AND LOWER(
                CASE
        
                    /* ================= ATTENDANCE ================= */
                    WHEN ats.id IS NOT NULL
                    THEN COALESCE(
                        ats.status,
                        'Present'
                    )
        
                    /* ================= HOLIDAY ================= */
                    WHEN EXISTS (
                        SELECT 1
                        FROM holidays hh
                        WHERE hh.holiday_date = $1::date
                          AND hh.transfer_date IS NULL
                          AND (
                                hh.locations IS NULL
                                OR array_length(
                                    hh.locations,
                                    1
                                ) IS NULL
                                OR ed.work_location::TEXT
                                   = ANY(hh.locations)
                          )
                    )
                    THEN 'Holiday'
        
                    /* ================= SUNDAY ================= */
                    WHEN $1::date IS NOT NULL
                         AND EXTRACT(
                             DOW FROM $1::date
                         ) = 0
                    THEN 'Weekly Off'
        
                    /* ================= ABSENT ================= */
                    ELSE 'Absent'
        
                END
            ) = $${countIndex}
        `;

        countValues.push(normalizedStatus);
        countIndex++;
    }

    /* ================= COUNT DURATION ================= */
    if (duration) {
        countQuery += `
            AND ats.duration = $${countIndex}::interval
        `;

        countValues.push(duration);
        countIndex++;
    }

    /* ================= EXECUTE ================= */
    const [
        { rows },
        { rows: totalRows },
        { rows: summaryRows }
    ] = await Promise.all([
        pool.query(query, values),
        pool.query(countQuery, countValues),
        pool.query(summaryQuery, summaryValues)
    ]);

    const totalRecords = Number(
        totalRows[0]?.total || 0
    );

    return {
        rows: rows.map(row =>
            decryptPayrollFields(row, ["current_salary"])
        ),
        summary: {
            total_present: Number(summaryRows[0]?.total_present || 0),
            total_absent: Number(summaryRows[0]?.total_absent || 0)
        },
        pagination: {
            enabled: true,
            total: totalRecords,
            page,
            limit,
            totalPages:
                totalRecords > 0
                    ? Math.ceil(
                        totalRecords / limit
                    )
                    : 0
        }
    };
};

/* ================= GET ATTENDANCE ENTRIES BY USERNAME ================= */
export const getAttendanceEntriesByUsernameModel = async ({
    username,
    month,
    year,
    work_location = null
}) => {

    const values = [
        username,
        Number(month),
        Number(year),
        work_location
    ];

    const query = `
        WITH employee AS (

            SELECT
                ed.rfid,

                /* ================= SHIFT ================= */

                ed.shift_id AS shift_name_id,
                ed.shift_id AS shift_type_id,

                sc.shift_name,
                sc.shift_type,
                sc.start_time AS shift_start_time,
                sc.end_time AS shift_end_time,
                sc.late_arrival_count_time,
                sc.early_leave_count_time,

                /* ================= WORK LOCATION ================= */

                ed.work_location AS work_location_id,
                wl.location AS work_location,

                /* ================= PERSONAL ================= */

                pd.username,
                pd.first_name,
                pd.middle_name,
                pd.last_name,
                pd.image,

                /* ================= EMPLOYMENT ================= */

                ed.employment_id,
                ed.date_of_joining

            FROM employment_details ed

            INNER JOIN personal_details pd
                ON pd.id = ed.personal_details_id

            /* ================= CATEGORY ================= */

            INNER JOIN category c
                ON c.id = ed.category

            /* ================= WORK LOCATION ================= */

            LEFT JOIN work_location wl
                ON wl.id = ed.work_location

            LEFT JOIN LATERAL (
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

            /* ================= SHIFT ================= */

            LEFT JOIN shift_configurations sc
                ON sc.id = ed.shift_id

            /* ================= MASTER EMPLOYEE ================= */

            LEFT JOIN master_employee me
                ON me.personal_details_id = pd.id

            /* ================= LATEST INACTIVE ================= */

            LEFT JOIN LATERAL (

                SELECT
                    ie.past_status,
                    ie.inactive_date,
                    ie.created_at

                FROM inactive_employee ie

                WHERE ie.personal_details_id = pd.id

                ORDER BY ie.created_at DESC

                LIMIT 1

            ) ie ON TRUE

            WHERE

                LOWER(TRIM(pd.username))
                    = LOWER(TRIM($1))

                /* ================= CATEGORY ================= */
                AND LOWER(
                    TRIM(c.category_name)
                ) IN (
                    'employee',
                    'intern'
                )

                /* ================= EMPLOYEE STATUS ================= */
                AND (
                    LOWER(
                        TRIM(me.status::TEXT)
                    ) = 'active'

                    OR (

                        LOWER(
                            TRIM(me.status::TEXT)
                        ) = 'inactive'

                        AND LOWER(
                            TRIM(
                                COALESCE(
                                    ie.past_status::TEXT,
                                    ''
                                )
                            )
                        ) = 'active'

                    )
                )

                /* ================= WORK LOCATION FILTER ================= */
                AND (
                    $4::INT IS NULL
                    OR ed.work_location = $4::INT
                )
        ),

        /* =========================================================
           DATES
        ========================================================= */
        dates AS (

            SELECT generate_series(

                GREATEST(

                    MAKE_DATE(
                        $3,
                        $2,
                        1
                    ),

                    (
                        SELECT
                            DATE(e.date_of_joining)

                        FROM employment_details e

                        INNER JOIN personal_details p
                            ON p.id = e.personal_details_id

                        WHERE
                            LOWER(TRIM(p.username))
                                = LOWER(TRIM($1))

                        ORDER BY e.id DESC

                        LIMIT 1
                    )

                ),

                LEAST(

                    CASE

                        WHEN
                            $2 = EXTRACT(
                                MONTH FROM CURRENT_DATE
                            )::INT

                            AND

                            $3 = EXTRACT(
                                YEAR FROM CURRENT_DATE
                            )::INT

                        THEN CURRENT_DATE

                        ELSE (

                            DATE_TRUNC(
                                'month',
                                MAKE_DATE($3, $2, 1)
                            )
                            + INTERVAL '1 month'
                            - INTERVAL '1 day'

                        )::date

                    END,

                    COALESCE(

                        (
                            SELECT
                                ie.inactive_date

                            FROM inactive_employee ie

                            INNER JOIN personal_details pd
                                ON pd.id =
                                   ie.personal_details_id

                            WHERE
                                LOWER(TRIM(pd.username))
                                    = LOWER(TRIM($1))

                                AND LOWER(
                                    TRIM(
                                        COALESCE(
                                            ie.past_status::TEXT,
                                            ''
                                        )
                                    )
                                ) = 'active'

                            ORDER BY ie.created_at DESC

                            LIMIT 1
                        ),

                        '9999-12-31'::date

                    )

                ),

                INTERVAL '1 day'

            )::date AS attendance_date
        ),

        /* =========================================================
           ATTENDANCE
        ========================================================= */

        attendance AS (

            SELECT *

            FROM attendance_sessions

            WHERE

                LOWER(TRIM(username))
                    = LOWER(TRIM($1))

                AND EXTRACT(
                    MONTH FROM entry_at
                    AT TIME ZONE 'Asia/Kolkata'
                ) = $2

                AND EXTRACT(
                    YEAR FROM entry_at
                    AT TIME ZONE 'Asia/Kolkata'
                ) = $3
        )

        /* =========================================================
           FINAL
        ========================================================= */

        SELECT

            d.attendance_date,

            ats.id,
            ats.rfid,
            ats.username,

            ats.entry_mac_id,
            ats.entry_device_name,

            ats.exit_mac_id,
            ats.exit_device_name,

            /* ================= ENTRY ================= */

            CASE

                WHEN ats.entry_at IS NOT NULL

                THEN TO_CHAR(
                    ats.entry_at
                        AT TIME ZONE 'Asia/Kolkata',
                    'DD-MM-YYYY HH24:MI:SS'
                )

                ELSE '-'

            END AS entry_at,

            /* ================= EXIT ================= */

            CASE

                WHEN ats.exit_at IS NOT NULL

                THEN TO_CHAR(
                    ats.exit_at
                        AT TIME ZONE 'Asia/Kolkata',
                    'DD-MM-YYYY HH24:MI:SS'
                )

                ELSE '-'

            END AS exit_at,

            /* ================= DURATION ================= */

            CASE

                WHEN ats.duration IS NOT NULL

                THEN json_build_object(

                    'hours',
                    EXTRACT(
                        HOUR FROM ats.duration
                    )::INT,

                    'minutes',
                    EXTRACT(
                        MINUTE FROM ats.duration
                    )::INT,

                    'seconds',
                    EXTRACT(
                        SECOND FROM ats.duration
                    )::INT

                )

                ELSE NULL

            END AS duration,

            /* ================= STATUS ================= */
            CASE

                /* ================= ATTENDANCE ================= */
                WHEN ats.id IS NOT NULL
                    THEN COALESCE(
                        ats.status,
                        'Present'
                    )

                /* ================= HOLIDAY ================= */
                WHEN h.holiday_date IS NOT NULL
                    THEN 'Holiday'

                /* ================= SUNDAY ================= */
                WHEN EXTRACT(
                    DOW FROM d.attendance_date
                ) = 0
                    THEN 'Weekly Off'

                /* ================= TRANSFER DATE ================= */
                WHEN EXISTS (
                    SELECT 1
                    FROM holidays hh
                    WHERE
                        hh.transfer_date = d.attendance_date

                        AND (
                            hh.locations IS NULL

                            OR array_length(
                                hh.locations,
                                1
                            ) IS NULL

                            OR emp.work_location_id::TEXT =
                               ANY(hh.locations)
                        )
                )
                    THEN 'Weekly Off'

                /* ================= ABSENT ================= */
                ELSE 'Absent'

            END AS status,

            /* ================= ATTENDANCE TIME STATUS ================= */

            CASE

                /* ================= LATE + EARLY ================= */

                WHEN
                    ats.entry_at IS NOT NULL
                    AND ats.exit_at IS NOT NULL

                    AND (
                        ats.entry_at
                            AT TIME ZONE 'Asia/Kolkata'
                    )::time >

                    (
                        emp.shift_start_time::time
                        + (
                            COALESCE(
                                emp.late_arrival_count_time,
                                0
                            ) * INTERVAL '1 minute'
                        )
                    )

                    AND (
                        ats.exit_at
                            AT TIME ZONE 'Asia/Kolkata'
                    )::time <

                    (
                        emp.shift_end_time::time
                        - (
                            COALESCE(
                                emp.early_leave_count_time,
                                0
                            ) * INTERVAL '1 minute'
                        )
                    )

                    THEN 'LA_EE'


                /* ================= LATE ONLY ================= */

                WHEN
                    ats.entry_at IS NOT NULL

                    AND (
                        ats.entry_at
                            AT TIME ZONE 'Asia/Kolkata'
                    )::time >

                    (
                        emp.shift_start_time::time
                        + (
                            COALESCE(
                                emp.late_arrival_count_time,
                                0
                            ) * INTERVAL '1 minute'
                        )
                    )

                    THEN 'LA'


                /* ================= EARLY ONLY ================= */

                WHEN
                    ats.exit_at IS NOT NULL

                    AND (
                        ats.exit_at
                            AT TIME ZONE 'Asia/Kolkata'
                    )::time <

                    (
                        emp.shift_end_time::time
                        - (
                            COALESCE(
                                emp.early_leave_count_time,
                                0
                            ) * INTERVAL '1 minute'
                        )
                    )

                    THEN 'EE'

                /* ================= ON TIME ================= */
                WHEN ats.entry_at IS NOT NULL
                     OR ats.exit_at IS NOT NULL
                THEN 'On Time'

                ELSE NULL

            END AS attendance_time_status,

            /* ================= PERSONAL ================= */

            emp.first_name,
            emp.middle_name,
            emp.last_name,
            emp.image,

            /* ================= EMPLOYMENT ================= */

            emp.employment_id,

            /* ================= SHIFT ================= */

            emp.shift_name,
            emp.shift_type,

            /* ================= WORK LOCATION ================= */

            emp.work_location_id,
            emp.work_location,

            /* ================= SHIFT TIME ================= */

            CONCAT(
                TO_CHAR(
                    sc.start_time,
                    'HH24:MI'
                ),
                ' - ',
                TO_CHAR(
                    sc.end_time,
                    'HH24:MI'
                )
            ) AS shift_time

        FROM dates d

        CROSS JOIN employee emp

        /* ================= ATTENDANCE ================= */

        LEFT JOIN attendance ats
            ON (
                ats.entry_at
                    AT TIME ZONE 'Asia/Kolkata'
            )::date = d.attendance_date

        /* ================= SHIFT ================= */

        LEFT JOIN shift_configurations sc
            ON sc.id = emp.shift_type_id

        /* ================= HOLIDAY ================= */

        LEFT JOIN holidays h
            ON h.holiday_date = d.attendance_date

            AND h.transfer_date IS NULL

            AND (
                h.locations IS NULL

                OR array_length(h.locations, 1) IS NULL

                OR emp.work_location_id::TEXT = ANY(h.locations)
            )

        ORDER BY
            d.attendance_date DESC,
            ats.entry_at DESC;
    `;

    const { rows } = await pool.query(
        query,
        values
    );

    return rows;
};

/* ================= CHECK ATTENDANCE OVERLAP ================= */
export const checkAttendanceOverlap = async ({
    rfid,
    entry_at = null,
    exit_at = null,
    ignoreId = null
}) => {

    let query = `
        SELECT id
        FROM attendance_sessions
        WHERE rfid = $1
    `;

    const values = [rfid];
    let count = 2;

    if (ignoreId) {
        query += ` AND id <> $${count}`;
        values.push(ignoreId);
        count++;
    }

    query += `
        AND (
            (
                exit_at IS NOT NULL
                AND (
                    ($${count}::timestamptz IS NOT NULL
                     AND $${count + 1}::timestamptz IS NOT NULL
                     AND tstzrange(entry_at, exit_at, '[]')
                         && tstzrange($${count}, $${count + 1}, '[]'))

                    OR

                    ($${count}::timestamptz IS NOT NULL
                     AND $${count + 1}::timestamptz IS NULL
                     AND $${count} BETWEEN entry_at AND exit_at)

                    OR

                    ($${count}::timestamptz IS NULL
                     AND $${count + 1}::timestamptz IS NOT NULL
                     AND $${count + 1} BETWEEN entry_at AND exit_at)
                )
            )

            OR

            (
                exit_at IS NULL
                AND (
                    (
                        $${count}::timestamptz IS NOT NULL
                        AND $${count} >= entry_at
                    )

                    OR

                    (
                        $${count + 1}::timestamptz IS NOT NULL
                        AND $${count + 1} >= entry_at
                    )
                )
            )
        )
        LIMIT 1
    `;

    values.push(entry_at, exit_at);

    const { rows } = await pool.query(query, values);

    return rows.length > 0;
};

/* ================= DELETE ATTENDANCE BY USERNAME AND DATE ================= */
export const deleteAttendanceByUsernameAndDate = async (
    username,
    leaveDate
) => {
    const { rows } = await pool.query(
        `
            DELETE FROM attendance_sessions
            WHERE username = $1
            AND entry_at::date = $2::date
            RETURNING *;
        `,
        [username, leaveDate]
    );

    return rows;
};

/* ================= CHECK DUPLICATE SCAN ================= */
export const isDuplicateScanWithinOneMinute = async ({
    username,
    deviceTimestamp
}) => {

    const { rows } = await pool.query(
        `
            SELECT id
            FROM attendance_sessions
            WHERE username = $1
            AND (
                ABS(
                    EXTRACT(
                        EPOCH FROM (
                            entry_at - $2::timestamptz
                        )
                    )
                ) < 30
        
                OR
        
                (
                    exit_at IS NOT NULL
                    AND ABS(
                        EXTRACT(
                            EPOCH FROM (
                                exit_at - $2::timestamptz
                            )
                        )
                    ) < 30
                )
            )
            LIMIT 1;
        `,
        [
            username,
            deviceTimestamp
        ]
    );

    return rows.length > 0;
};