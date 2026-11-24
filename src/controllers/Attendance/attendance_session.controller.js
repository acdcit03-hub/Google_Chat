import {
    addAttendanceSessionModel,
    checkAttendanceOverlap,
    deleteAttendanceSessionModel,
    editAttendanceSessionModel,
    getAttendanceByUsernameModel,
    getAttendanceEntriesByUsernameModel,
    getAttendanceSessionByIdModel,
    getAttendanceSessionsModel
} from "../../models/Attendance/attendance_session.model.js";
import { getIO } from '../../config/socket.js';
import { addAttendanceLogModel } from "../../models/history/attendance_logs.model.js";
import { getEmployeeByRFID, getEmployeeByUsername } from "../../models/Employee/EmploymentDetails.model.js";
import { createOpenSession, deleteOpenSession, getOpenSession } from "../../models/Attendance/open_sessions.model.js";

/* ================= CHANGE DATE FORMAT ================= */
const toDBDate = (dateStr) => {
    if (!dateStr) return null;

    // already correct format
    if (dateStr.includes("-") && dateStr.split("-")[0].length === 4) {
        return dateStr;
    }

    // DD-MM-YYYY → YYYY-MM-DD
    const [dd, mm, yyyy] = dateStr.split("-");
    return `${yyyy}-${mm}-${dd}`;
};

/* ================= NORMALIZE TO TIMEZONE STRING ================= */
const normalizeToTzString = (input) => {
    if (!input) return null;
    if (typeof input !== 'string') return input;

    // If already contains timezone info or Z, return as-is
    if (/[zZ]|[+-]\d{2}(:?\d{2})?$/.test(input)) return input;

    // Split date and time
    let datePart = null;
    let timePart = null;
    if (input.includes('T')) {
        [datePart, timePart] = input.split('T');
    } else if (input.includes(' ')) {
        [datePart, timePart] = input.split(' ');
    } else {
        // Only a date or only a time — return as-is and let DB handle or reject
        return input;
    }

    // Convert DD-MM-YYYY to YYYY-MM-DD
    if (datePart && datePart.split('-')[0].length === 2) {
        const [dd, mm, yyyy] = datePart.split('-');
        datePart = `${yyyy}-${mm}-${dd}`;
    }

    // Ensure time has seconds
    if (!timePart) timePart = '00:00:00';
    const parts = timePart.split(':');
    if (parts.length === 2) timePart = `${timePart}:00`;

    // Append Asia/Kolkata offset so Postgres parses as that timezone
    return `${datePart} ${timePart}+05:30`;
};

const parseAttendanceTimestamp = (value) => {
    if (!value) return null;

    // Convert unzoned timestamps to Asia/Kolkata
    if (
        typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)
    ) {
        return new Date(`${value}+05:30`).getTime();
    }

    if (
        typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(value)
    ) {
        return new Date(`${value.replace(" ", "T")}+05:30`).getTime();
    }

    return new Date(value).getTime();
};

const validateAttendanceDateTime = (entry_at, exit_at) => {
    // Current actual time (independent of server timezone)
    const now = Date.now();

    for (const [field, value] of [
        ["entry_at", entry_at],
        ["exit_at", exit_at]
    ]) {
        if (value === undefined || value === null || value === "") {
            continue;
        }

        const timestamp = parseAttendanceTimestamp(value);

        if (!Number.isFinite(timestamp)) {
            return `${field} is invalid.`;
        }

        // Allow current time; reject only future timestamps
        if (timestamp > now) {
            return `Future ${field.replace("_", " ")} is not allowed.`;
        }
    }

    if (entry_at && exit_at) {
        const entryTime = parseAttendanceTimestamp(entry_at);
        const exitTime = parseAttendanceTimestamp(exit_at);

        if (exitTime <= entryTime) {
            return "Exit time must be greater than entry time.";
        }
    }

    return null;
};

/* ================= ADD ATTENDANCE SESSION ================= */
export const addAttendanceSession = async (req, res) => {
    try {
        const { username, entry_at, exit_at, status } = req.body || {};

        // Validate future date/time
        const validationError = validateAttendanceDateTime(
            entry_at,
            exit_at
        );

        if (validationError) {
            return res.status(400).json({
                success: false,
                message: validationError
            });
        }

        const actionUsername = req.headers["x-hrms-username"] || null;

        const finalMacId = "MANUAL";

        const attendance = await addAttendanceSessionModel({
            username,
            mac_id: finalMacId,
            message_id: null,
            entry_at: normalizeToTzString(entry_at) ?? null,
            exit_at: normalizeToTzString(exit_at) ?? null,
            manualStatus: status ?? "inside",
            actionUsername
        });

        const io = getIO();
        if (io) {
            io.emit("attendance-update", {
                type: attendance.action,
                data: attendance.data
            });
        }

        return res.status(201).json({
            success: true,
            message: `Attendance ${attendance.action} recorded successfully`,
            data: attendance.data
        });

    } catch (error) {
        console.error("ADD ATTENDANCE SESSION ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= GET ATTENDANCE SESSIONS ================= */
export const getAttendanceSessions = async (req, res) => {
    try {
        const {
            rfid,
            entry_mac_id,
            exit_mac_id,
            status
        } = req.query;

        const data = await getAttendanceSessionsModel({
            rfid,
            entry_mac_id,
            exit_mac_id,
            status
        });

        /* ================= SOCKET ================= */
        const io = getIO();
        if (io) {
            io.emit("attendance-list", {
                type: "fetch",
                data
            });
        }

        return res.status(200).json({
            success: true,
            message: "Attendance sessions fetched successfully",
            data
        });

    } catch (error) {
        console.error("GET ATTENDANCE SESSIONS ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= ATTENDANCE BY USERNAME ================= */
export const getAttendanceByUsername = async (req, res) => {
    try {
        let {
            date,
            username,
            first_name,
            middle_name,
            last_name,
            employment_id,
            department,
            shift_type,
            work_location,
            category,
            rfid,
            mac_id,
            entry_at,
            exit_at,
            status,
            duration,
            page = 1,
            limit = 20
        } = req.query;

        if (!date) {
            const now = new Date();
            const dd = String(now.getDate()).padStart(2, "0");
            const mm = String(now.getMonth() + 1).padStart(2, "0");
            const yyyy = now.getFullYear();

            date = `${yyyy}-${mm}-${dd}`;
        }

        const dbDate = toDBDate(date);
        const data = await getAttendanceByUsernameModel({
            date: dbDate,
            username,
            first_name,
            middle_name,
            last_name,
            employment_id,
            department,
            shift_type,
            work_location,
            category,
            rfid,
            mac_id,
            entry_at,
            exit_at,
            status,
            duration,
            page: Number(page),
            limit: Number(limit)
        });

        if (!data || data.length === 0) {
            return res.status(404).json({
                success: false,
                message: "No attendance found"
            });
        }

        const grouped = data.rows.reduce((acc, item) => {
            const key = item.employee_username || "Unregistered";

            if (!acc[key]) {
                acc[key] = {
                    username: key,
                    first_name: item.first_name,
                    middle_name: item.middle_name,
                    last_name: item.last_name,
                    full_name: `${item.first_name || ""} ${item.middle_name || ""} ${item.last_name || ""} (${key || ""})`
                        .replace(/\s+/g, " ")
                        .trim(),

                    employment_id: item.employment_id,
                    category: item.category,
                    department: item.department,
                    shift_name: item.shift_name,
                    shift_type: item.shift_type,
                    shift_time: item.shift_time,
                    break_start_time: item.break_start_time,
                    break_end_time: item.break_end_time,
                    late_arrival_count_time: item.late_arrival_count_time,
                    early_leave_count_time: item.early_leave_count_time,
                    work_location: item.work_location,
                    image: item.image,
                    attendance_status: "Absent",
                    leave_type: null,
                    leave_reason: null,
                    entries: []
                };
            }

            const today = new Date().toISOString().split("T")[0];

            if (item.attendance_id) {

                /* ============================================
                   ATTENDANCE HAS HIGHEST PRIORITY
                   Holiday day attendance = Present
                   ============================================ */
                acc[key].attendance_status = item.status || "completed";

                acc[key].entries.push({
                    attendance_id: item.attendance_id,
                    rfid: item.rfid,
                    entry_mac_id: item.entry_mac_id,
                    entry_device_name: item.entry_device_name,
                    exit_mac_id: item.exit_mac_id,
                    exit_device_name: item.exit_device_name,
                    entry_at: item.entry_at,
                    exit_at: item.exit_at,
                    status:
                        item.status === "Expired"
                            ? "Expired"
                            : item.exit_at
                                ? "completed"
                                : "inside",
                    attendance_time_status: item.attendance_time_status,
                    duration: item.duration,
                    attendance_created_at: item.attendance_created_at
                });

            } else if (item.holiday_id) {

                /* ============================================
                   HOLIDAY WITHOUT ATTENDANCE
                   ============================================ */
                acc[key].attendance_status = "Holiday";

            } else if (item.is_weekly_off) {

                acc[key].attendance_status = "Weekly Off";

            } else if (item.leave_id) {

                if (dbDate < today) {

                    acc[key].attendance_status = "Absent";
                    acc[key].leave_type = null;
                    acc[key].leave_reason = null;

                } else {

                    acc[key].attendance_status = "Leave";
                    acc[key].leave_type = item.leave_type;
                    acc[key].leave_reason = item.reason;
                }

            } else {

                acc[key].attendance_status = "Absent";
                acc[key].leave_type = null;
                acc[key].leave_reason = null;
            }

            return acc;

        }, {});

        const groupedEmployees = Object.values(grouped);
        const totalPresent = data.summary.total_present;
        const totalAbsent = data.summary.total_absent;

        /* ================= SOCKET ================= */
        const io = getIO();
        if (io) {
            io.emit("attendance-list", {
                type: "fetch",
                data
            });
        }

        return res.status(200).json({
            success: true,
            message: "Attendance fetched successfully",
            total_present: totalPresent,
            total_absent: totalAbsent,
            data: groupedEmployees,
            pagination: data.pagination
        });

    } catch (error) {
        console.error("ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= GET ATTENDANCE ENTRIES BY USERNAME ================= */
export const getAttendanceEntriesByUsername = async (req, res) => {
    try {
        const { username } = req.params;
        const { month, year, page = 1, limit = 20 } = req.query;

        const currentPage = Number(page);
        const perPage = Number(limit);

        if (!username) {
            return res.status(400).json({
                success: false,
                message: "Username is required"
            });
        }

        const rows = await getAttendanceEntriesByUsernameModel({
            username,
            month,
            year
        });

        const groupedData = [];
        const dateMap = {};

        rows.forEach((row) => {

            const date =
                row.attendance_date instanceof Date
                    ? row.attendance_date.toLocaleDateString("en-CA", {
                        timeZone: "Asia/Kolkata"
                    })
                    : row.attendance_date;

            if (!dateMap[date]) {

                dateMap[date] = {
                    date,
                    shift_type: row.shift_type,
                    shift_time: row.shift_time,
                    work_location: row.work_location,
                    entries: []
                };

                groupedData.push(dateMap[date]);
            }

            dateMap[date].entries.push({
                id: row.id,
                entry_at: row.entry_at,
                exit_at: row.exit_at,
                duration: row.duration ?? {
                    hours: 0,
                    minutes: 0,
                    seconds: 0
                },
                status: row.status,
                attendance_time_status: row.attendance_time_status ?? null,
                entry_device_name: row.entry_device_name || "-",
                exit_device_name: row.exit_device_name || "-"
            });
        });

        const io = getIO();

        if (io) {
            io.emit("attendance:entries", {
                success: true,
                username,
                data: groupedData
            });
        }

        const totalRecords = groupedData.length;
        const totalPages = Math.ceil(totalRecords / perPage);

        const paginatedData = groupedData.slice(
            (currentPage - 1) * perPage,
            currentPage * perPage
        );

        return res.status(200).json({
            success: true,
            message: "Attendance entries fetched successfully",
            data: paginatedData,
            pagination: {
                enabled: true,
                total: totalRecords,
                page: currentPage,
                limit: perPage,
                totalPages
            }
        });

    } catch (error) {
        console.error("GET ATTENDANCE ENTRIES ERROR:", error);

        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= EDIT ATTENDANCE SESSION ================= */
export const editAttendanceSession = async (req, res) => {
    try {
        const { entry_at, exit_at, status } = req.body;
        const { id } = req.params;

        const actionUsername = req.headers["x-hrms-username"] || null;
        const existing = await getAttendanceSessionByIdModel(id);

        if (!existing) {
            return res.status(404).json({
                success: false,
                message: "Attendance session not found"
            });
        }

        const finalEntryAt = entry_at ?? existing.entry_at;

        const finalExitAt =
            status === "inside"
                ? null
                : (exit_at ?? existing.exit_at);

        // Validate final timestamps
        const validationError = validateAttendanceDateTime(
            finalEntryAt,
            finalExitAt
        );

        if (validationError) {
            return res.status(400).json({
                success: false,
                message: validationError
            });
        }

        // Employee details
        const employee = await getEmployeeByUsername(existing.username);

        if (!employee) {
            return res.status(404).json({
                success: false,
                message: "Employee not found"
            });
        }

        // Check overlap
        const overlap = await checkAttendanceOverlap({
            username: employee.username,
            entry_at: normalizeToTzString(entry_at ?? existing.entry_at),
            exit_at:
                status === "inside"
                    ? null
                    : normalizeToTzString(exit_at ?? existing.exit_at),
            ignoreId: id
        });

        if (overlap) {
            return res.status(400).json({
                success: false,
                message: "Attendance overlaps with existing attendance."
            });
        }

        const updatedData = {
            entry_at: normalizeToTzString(entry_at ?? existing.entry_at),
            exit_at:
                status === "inside"
                    ? null
                    : normalizeToTzString(exit_at ?? existing.exit_at),
            status: status ?? existing.status
        };

        const data = await editAttendanceSessionModel(id, updatedData);

        // Maintain open_sessions
        if (data.status === "inside") {
            const session = await getOpenSession(employee.rfid);

            if (!session) {
                await createOpenSession({
                    rfid: employee.rfid,
                    mac_id: data.entry_mac_id,
                    session_id: data.id,
                    entry_at: data.entry_at
                });
            }

        } else {
            await deleteOpenSession(data.id);
        }

        // Logs
        const oldValue = {};
        const newValue = {};

        [
            "entry_at",
            "exit_at",
            "duration",
            "status"
        ].forEach((field) => {
            if (
                (existing[field]?.toString() || null) !==
                (data[field]?.toString() || null)
            ) {
                oldValue[field] = existing[field];
                newValue[field] = data[field];
            }
        });

        if (Object.keys(oldValue).length) {
            await addAttendanceLogModel({
                type: "edit",
                employee_id: employee.employment_id,
                username: employee.username,
                user_at: actionUsername,
                old_value: oldValue,
                new_value: newValue
            });
        }

        const io = getIO();

        if (io) {
            io.emit("attendance-edit", {
                type: "edit",
                data
            });
        }

        return res.status(200).json({
            success: true,
            message: "Attendance updated successfully.",
            data
        });

    } catch (err) {
        console.error(err);
        return res.status(500).json({
            success: false,
            message: err.message
        });
    }
};

/* ================= DELETE ATTENDANCE SESSION ================= */
export const deleteAttendanceSession = async (req, res) => {
    try {
        const { id } = req.params;

        const actionUsername = req.headers["x-hrms-username"] || null;
        const existing = await getAttendanceSessionByIdModel(id);

        if (!existing) {
            return res.status(404).json({
                success: false,
                message: "Attendance session not found"
            });
        }

        const employee = await getEmployeeByRFID(existing.rfid);
        const deleted = await deleteAttendanceSessionModel(id);

        /* ================= LOG DELETE ================= */
        await addAttendanceLogModel({
            type: "delete",
            employee_id: employee?.employment_id || null,
            username: deleted.username,
            user_at: actionUsername,
            old_value: {
                rfid: deleted.rfid,
                username: deleted.username,
                entry_mac_id: deleted.entry_mac_id,
                exit_mac_id: deleted.exit_mac_id,
                entry_at: deleted.entry_at,
                exit_at: deleted.exit_at,
                duration: deleted.duration,
                status: deleted.status
            },
            new_value: null
        });

        /* ================= SOCKET ================= */
        const io = getIO();
        if (io) {
            io.emit("attendance-delete", {
                type: "delete",
                data: deleted
            });
        }

        return res.status(200).json({
            success: true,
            message: "Attendance session deleted successfully",
            data: deleted
        });

    } catch (error) {
        console.error("DELETE ATTENDANCE SESSION ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};