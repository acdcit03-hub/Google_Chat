import { addCalendarEditLogModel, getCalendarEditLogsModel } from "../../models/history/calendar_log.model.js";

/* ================= ADD CALENDAR EDIT LOG ================= */
export const addCalendarEditLog = async (req, res) => {
    try {
        const {
            table_name,
            record_id,
            username,
            action,
            field_name,
            old_value,
            new_value,
            calendar_date,
            description
        } = req.body;

        /* ================= EDITED BY ================= */
        const editedBy =
            req.headers["x-username"]
                ? String(
                    req.headers["x-username"]
                ).trim()
                : null;

        /* ================= VALIDATION ================= */
        if (!table_name) {
            return res.status(400).json({
                success: false,
                message: "table_name is required"
            });
        }

        if (!action) {
            return res.status(400).json({
                success: false,
                message: "action is required"
            });
        }

        const validActions = [
            "CREATE",
            "UPDATE",
            "DELETE"
        ];

        if (!validActions.includes(
            String(action).toUpperCase()
        )) {
            return res.status(400).json({
                success: false,
                message: "action must be CREATE, UPDATE or DELETE"
            });
        }


        /* ================= ADD LOG ================= */
        const data = await addCalendarEditLogModel({
            table_name,
            record_id:
                record_id
                    ? Number(record_id)
                    : null,

            username:
                username
                    ? String(username).trim()
                    : null,

            edited_by: editedBy,
            action: String(action).toUpperCase(),
            field_name: field_name || null,

            old_value:
                old_value !== undefined &&
                    old_value !== null
                    ? String(old_value)
                    : null,

            new_value:
                new_value !== undefined &&
                    new_value !== null
                    ? String(new_value)
                    : null,

            calendar_date: calendar_date || null,
            description: description || null
        });

        /* ================= RESPONSE ================= */
        return res.status(201).json({
            success: true,
            message: "Calendar edit log added successfully",
            data
        });

    } catch (error) {
        console.error("ADD CALENDAR EDIT LOG ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= GET CALENDAR EDIT LOG ================= */
export const getCalendarEditLogs = async (req, res) => {
    try {
        const {
            table_name,
            record_id,
            username,
            edited_by,
            action,
            calendar_date,
            page = 1,
            limit = 20,
            pagination = "true"
        } = req.query;

        /* ================= PAGINATION ================= */
        const paginationEnabled = String(pagination).toLowerCase() !== "false";

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

        /* ================= RECORD ID VALIDATION ================= */
        if (
            record_id !== undefined &&
            record_id !== null &&
            String(record_id).trim() !== ""
        ) {
            const recordIdNumber = Number(record_id);

            if (
                !Number.isInteger(recordIdNumber) ||
                recordIdNumber <= 0
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Valid record_id is required"
                });
            }
        }

        /* ================= ACTION ================= */
        let normalizedAction = null;

        if (
            action !== undefined &&
            action !== null &&
            String(action).trim() !== ""
        ) {
            normalizedAction = String(action)
                .trim()
                .toUpperCase();

            const validActions = [
                "CREATE",
                "UPDATE",
                "DELETE"
            ];

            if (!validActions.includes(normalizedAction)) {
                return res.status(400).json({
                    success: false,
                    message: "action must be CREATE, UPDATE or DELETE"
                });
            }
        }

        const result = await getCalendarEditLogsModel({
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

            edited_by: edited_by
                ? String(edited_by).trim()
                : null,

            action: normalizedAction,

            calendar_date:
                calendar_date
                    ? String(calendar_date).trim()
                    : null,

            page: pageNumber,
            limit: limitNumber,
            pagination: paginationEnabled
        });

        /* ================= WITHOUT PAGINATION ================= */
        if (!paginationEnabled) {
            return res.status(200).json({
                success: true,
                message: "Calendar edit logs fetched successfully",
                count: result.data.length,
                data: result.data,
                pagination: false
            });
        }

        /* ================= WITH PAGINATION ================= */
        return res.status(200).json({
            success: true,
            message: "Calendar edit logs fetched successfully",
            data: result.data,
            pagination: {
                page: pageNumber,
                limit: limitNumber,
                totalRecords: result.totalRecords,
                totalPages:
                    Math.ceil(
                        result.totalRecords / limitNumber
                    )
            }
        });

    } catch (error) {
        console.error("GET CALENDAR EDIT LOG ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};