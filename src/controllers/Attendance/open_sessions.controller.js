import { getOpenSessionsModel } from "../../models/Attendance/open_sessions.model.js";

/* ================= GET OPEN SESSIONS ================= */
export const getOpenSessions = async (req, res) => {
    try {
        const data = await getOpenSessionsModel();

        return res.status(200).json({
            success: true,
            message: "Open sessions fetched successfully",
            data
        });

    } catch (error) {
        console.error("GET OPEN SESSIONS ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};