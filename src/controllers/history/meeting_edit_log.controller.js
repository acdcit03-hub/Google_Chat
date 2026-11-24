import { getMeetingEditLogModel } from "../../models/history/meeting_edit_log.model.js";

export const getMeetingEditLog = async (req, res) => {
    try {
        const {
            record_id,
            username,
            edited_by,
            field_name,
            candidate_status,
            old_value,
            new_value,
            from_date,
            to_date,
            page = 1,
            limit = 20,
            pagination = "true"
        } = req.query;

        const paginationEnabled = String(pagination).toLowerCase() !== "false";

        if (record_id && !Number.isInteger(Number(record_id))) {
            return res.status(400).json({
                success: false,
                message: "record_id must be an integer"
            });
        }

        const pageNumber = Number(page);
        const limitNumber = Number(limit);

        if (paginationEnabled) {
            if (!Number.isInteger(pageNumber) || pageNumber <= 0) {
                return res.status(400).json({
                    success: false,
                    message: "page must be a positive integer"
                });
            }

            if (!Number.isInteger(limitNumber) || limitNumber <= 0) {
                return res.status(400).json({
                    success: false,
                    message: "limit must be a positive integer"
                });
            }
        }

        const result = await getMeetingEditLogModel({
            record_id: record_id ? Number(record_id) : null,
            username,
            edited_by,
            field_name,
            candidate_status,
            old_value,
            new_value,
            from_date: from_date || null,
            to_date: to_date || null,
            page: pageNumber,
            limit: limitNumber,
            pagination: paginationEnabled
        });

        if (!paginationEnabled) {
            return res.status(200).json({
                success: true,
                message: "Meeting edit logs fetched successfully",
                count: result.data.length,
                data: result.data,
                pagination: false
            });
        }

        return res.status(200).json({
            success: true,
            message: "Meeting edit logs fetched successfully",
            data: result.data,
            pagination: {
                page: pageNumber,
                limit: limitNumber,
                totalRecords: result.totalRecords,
                totalPages: Math.ceil(result.totalRecords / limitNumber)
            }
        });
    } catch (error) {
        console.error("GET MEETING EDIT LOG ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};
