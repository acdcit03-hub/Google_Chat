import { getUnregisteredMacsModel } from "../../models/Attendance/mac_address.model.js";

export const getUnregisteredMacs = async (req, res) => {
    try {
        const data = await getUnregisteredMacsModel();
        return res.json({
            success: true,
            message: "Unregistered MAC addresses fetched successfully",
            data
        });

    } catch (error) {
        console.error("GET UNREGISTERED MAC ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};
