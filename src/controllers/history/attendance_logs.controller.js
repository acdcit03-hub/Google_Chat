import { getAttendanceLogByIdModel, getAttendanceLogsModel } from "../../models/history/attendance_logs.model.js";

/* ================= GET ALL ATTENDANCE LOGS ================= */
export const getAttendanceLogs = async (req, res) => {
    try {
        const {
            id,
            type,
            employee_id,
            username,
            user_at,
            work_location,
            from_date,
            to_date,
            from_time,
            to_time,
            page,
            limit
        } = req.query;

        const result = await getAttendanceLogsModel({
            id,
            type,
            employee_id,
            username,
            user_at,
            work_location,
            from_date,
            to_date,
            from_time,
            to_time,
            page: Number(page) || 1,
            limit: Number(limit) || 20
        });

        return res.status(200).json({
            success: true,
            message: "Attendance logs fetched successfully",
            count: result.rows.length,
            data: result.rows,
            pagination: result.pagination
        });

    } catch (error) {
        console.error("GET ATTENDANCE LOGS ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= GET ATTENDANCE LOG BY ID ================= */
export const getAttendanceLogById = async (req, res) => {
    try {
        const { id } = req.params;

        const data = await getAttendanceLogByIdModel(id);

        if (!data) {
            return res.status(404).json({
                success: false,
                message: "Attendance log not found"
            });
        }

        return res.status(200).json({
            success: true,
            message: "Attendance log fetched successfully",
            data
        });

    } catch (error) {
        console.error("GET ATTENDANCE LOG BY ID ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};