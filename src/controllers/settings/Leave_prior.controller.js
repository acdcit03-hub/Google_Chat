import {
    getLeavePriorModel,
    updatePriorDaysModel
} from "../../models/settings/Leave_prior.model.js";

/* =========================================================
   GET ALL LEAVE PRIOR SETTINGS
========================================================= */
export const getLeavePrior = async (req, res) => {
    try {
        const data = await getLeavePriorModel();

        return res.status(200).json({
            success: true,
            message: "Leave prior settings fetched successfully",
            data
        });

    } catch (error) {
        console.error("Get Leave Prior Error:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to fetch leave prior settings",
            error: error.message
        });
    }
};

/* =========================================================
   UPDATE ONLY PRIOR DAYS
========================================================= */
export const updatePriorDays = async (req, res) => {
    try {
        const { id } = req.params;
        const body = req.body || {};

        const prior_days_required =
            body.prior_days_required !== undefined
                ? Number(body.prior_days_required)
                : null;


        /* ================= VALIDATION ================= */
        if (!id || isNaN(id)) {
            return res.status(400).json({
                success: false,
                message: "Valid leave prior ID is required"
            });
        }

        if (
            prior_days_required === null ||
            !Number.isInteger(prior_days_required)
        ) {
            return res.status(400).json({
                success: false,
                message: "prior_days_required must be a valid integer"
            });
        }

        if (prior_days_required < 0) {
            return res.status(400).json({
                success: false,
                message: "prior_days_required cannot be negative"
            });
        }

        /* ================= UPDATE ================= */
        const updatedData = await updatePriorDaysModel(
            id,
            prior_days_required
        );

        if (!updatedData) {
            return res.status(404).json({
                success: false,
                message: "Leave prior setting not found"
            });
        }

        return res.status(200).json({
            success: true,
            message: "Leave prior days updated successfully",
            data: updatedData
        });

    } catch (error) {
        console.error("Update Prior Days Error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to update prior days",
            error: error.message
        });
    }
};