import { getMaintenanceModel, saveMaintenanceModel } from "../../models/Maintenance/Maintenance.model.js";

export const saveMaintenance = async (req, res) => {
    try {

        const {
            title,
            description,
            endTime,
            features
        } = req.body;

        const maintenance = await saveMaintenanceModel({
            title,
            description,
            endTime,
            features
        });

        return res.status(201).json({
            success: true,
            message: "Maintenance saved successfully",
            data: maintenance
        });

    } catch (err) {

        return res.status(500).json({
            success: false,
            message: err.message,
            data: null
        });

    }
};

export const getMaintenance = async (req, res) => {
    try {

        const data = await getMaintenanceModel();

        if (!data) {
            return res.status(404).json({
                success: false,
                message: "No maintenance data found",
                data: null
            });
        }

        return res.status(200).json({
            success: true,
            message: "Maintenance data fetched successfully",
            data
        });

    } catch (err) {

        return res.status(500).json({
            success: false,
            message: err.message,
            data: null
        });

    }
};