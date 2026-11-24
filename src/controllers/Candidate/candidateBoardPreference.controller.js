import {
    getCandidateBoardPreferenceModel,
    saveCandidateBoardPreferenceModel
} from "../../models/Candidate/candidateBoardPreference.model.js";

/* Board preference single (global) chhe — fakt table ni
   ek j row update thay chhe. x-username fakt updated_by mate chhe. */
const getUpdatedBy = (req) => {
    const username = String(req.headers["x-username"] || "").trim();
    return username === "" ? null : username;
};

const normalizeIdArray = (value) => {
    if (!Array.isArray(value)) {
        return null;
    }

    const ids = value.map(Number);

    if (ids.some((id) => !Number.isInteger(id) || id <= 0)) {
        return null;
    }

    if (new Set(ids).size !== ids.length) {
        return null;
    }
    
    return ids;
};

/* ================= SAVE BOARD PREFERENCE ================= */
export const saveCandidateBoardPreference = async (req, res) => {
    try {
        const {
            status_order = [],
            card_order = {},
            collapsed_columns = []
        } = req.body || {};

        const statusOrder = normalizeIdArray(status_order);

        if (statusOrder === null) {
            return res.status(400).json({
                success: false,
                message: "status_order must be an array of unique positive integers"
            });
        }

        if (
            !card_order ||
            typeof card_order !== "object" ||
            Array.isArray(card_order)
        ) {
            return res.status(400).json({
                success: false,
                message: "card_order must be an object of status id to candidate id array"
            });
        }

        const cardOrder = {};

        for (const [statusId, candidateIds] of Object.entries(card_order)) {
            if (!/^\d+$/.test(statusId) || Number(statusId) <= 0) {
                return res.status(400).json({
                    success: false,
                    message: "card_order keys must be valid status ids"
                });
            }

            const ids = normalizeIdArray(candidateIds);

            if (ids === null) {
                return res.status(400).json({
                    success: false,
                    message: `card_order["${statusId}"] must be an array of unique positive integers`
                });
            }

            cardOrder[String(Number(statusId))] = ids;
        }

        if (
            !Array.isArray(collapsed_columns) ||
            collapsed_columns.some(
                column => typeof column !== "string" || column.trim() === ""
            ) ||
            new Set(collapsed_columns).size !== collapsed_columns.length
        ) {
            return res.status(400).json({
                success: false,
                message: "collapsed_columns must be an array of unique non-empty strings"
            });
        }

        const data = await saveCandidateBoardPreferenceModel({
            status_order: statusOrder,
            card_order: cardOrder,
            collapsed_columns: collapsed_columns.map(column => column.trim()),
            updated_by: getUpdatedBy(req)
        });

        return res.status(200).json({
            success: true,
            message: "Board preference saved.",
            data: {
                status_order: data.status_order,
                card_order: data.card_order,
                collapsed_columns: data.collapsed_columns
            }
        });
    } catch (error) {
        console.error("SAVE BOARD PREFERENCE ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= GET BOARD PREFERENCE ================= */
export const getCandidateBoardPreference = async (req, res) => {
    try {
        const data = await getCandidateBoardPreferenceModel();

        return res.status(200).json({
            success: true,
            message: "Board preference fetched successfully.",
            data
        });
    } catch (error) {
        console.error("GET BOARD PREFERENCE ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};
