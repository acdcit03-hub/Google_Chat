import { addSettingEditLogModel, getSettingEditLogModel } from "../../models/history/setting_edit_log.model.js";

/* ================= ADD SETTING EDIT LOG ================= */
export const addSettingEditLog = async (req, res) => {
    try {
        const {
            table_name,
            record_id,
            username,
            edited_by,
            field_name,
            old_value,
            new_value
        } = req.body;

        /* ================= VALIDATION ================= */
        if (!table_name) {
            return res.status(400).json({
                success: false,
                message: "table_name is required"
            });
        }

        if (
            record_id === undefined ||
            record_id === null ||
            record_id === ""
        ) {
            return res.status(400).json({
                success: false,
                message: "record_id is required"
            });
        }

        if (!field_name) {
            return res.status(400).json({
                success: false,
                message: "field_name is required"
            });
        }

        if (!Number.isInteger(Number(record_id))) {
            return res.status(400).json({
                success: false,
                message: "record_id must be an integer"
            });
        }

        /* ================= ADD LOG ================= */
        const log = await addSettingEditLogModel({
            table_name: String(table_name).trim(),
            record_id: Number(record_id),

            username:
                username !== undefined &&
                    username !== null &&
                    String(username).trim() !== ""
                    ? String(username).trim()
                    : null,

            edited_by:
                edited_by !== undefined &&
                    edited_by !== null &&
                    String(edited_by).trim() !== ""
                    ? String(edited_by).trim()
                    : null,

            field_name: String(field_name).trim(),

            old_value:
                old_value !== undefined &&
                    old_value !== null
                    ? String(old_value)
                    : null,

            new_value:
                new_value !== undefined &&
                    new_value !== null
                    ? String(new_value)
                    : null
        });

        return res.status(201).json({
            success: true,
            message: "Setting edit log added successfully",
            data: log
        });

    } catch (error) {
        console.error("ADD SETTING EDIT LOG ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= GET SETTING EDIT LOG ================= */
export const getSettingEditLog = async (req, res) => {
    try {
        const {
            table_name,
            record_id,
            username,
            edited_by,
            field_name,
            from_date,
            to_date,
            page = 1,
            limit = 20,
            pagination = "true"
        } = req.query;

        /* ================= PAGINATION ENABLE / DISABLE ================= */
        const paginationEnabled = String(pagination).toLowerCase() !== "false";

        /* ================= VALIDATE RECORD ID ================= */
        if (record_id) {
            if (!Number.isInteger(Number(record_id))) {
                return res.status(400).json({
                    success: false,
                    message: "record_id must be an integer"
                });
            }
        }

        /* ================= PAGE & LIMIT ================= */
        const pageNumber = Number(page);
        const limitNumber = Number(limit);

        if (paginationEnabled) {

            if (
                !Number.isInteger(pageNumber) ||
                pageNumber <= 0
            ) {
                return res.status(400).json({
                    success: false,
                    message: "page must be a positive integer"
                });
            }

            if (
                !Number.isInteger(limitNumber) ||
                limitNumber <= 0
            ) {
                return res.status(400).json({
                    success: false,
                    message: "limit must be a positive integer"
                });
            }
        }

        /* ================= GET LOG ================= */
        const result = await getSettingEditLogModel({
            table_name:
                table_name
                    ? String(table_name).trim()
                    : null,

            record_id:
                record_id
                    ? Number(record_id)
                    : null,

            username:
                username
                    ? String(username).trim()
                    : null,

            edited_by:
                edited_by
                    ? String(edited_by).trim()
                    : null,

            field_name:
                field_name
                    ? String(field_name).trim()
                    : null,

            from_date: from_date || null,
            to_date: to_date || null,
            page: pageNumber,
            limit: limitNumber,
            pagination: paginationEnabled
        });

        /* ================= PAGINATION FALSE ================= */
        if (!paginationEnabled) {
            return res.status(200).json({
                success: true,
                message: "Setting edit logs fetched successfully",                
                count: result.data.length,
                data: result.data,
                pagination: false
            });
        }

        /* ================= RESPONSE ================= */
        return res.status(200).json({
            success: true,
            message: "Setting edit logs fetched successfully",
            data: result.data,
            pagination: {
                page: pageNumber,
                limit: limitNumber,
                totalRecords: result.totalRecords,
                totalPages: Math.ceil(
                    result.totalRecords / limitNumber
                )
            }
        });

    } catch (error) {
        console.error("GET SETTING EDIT LOG ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};