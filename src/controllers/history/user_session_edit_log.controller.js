import { getUserSessionEditLogModel } from "../../models/history/user_session_edit_log.model.js";
import { getUserSessionOldDataModel } from "../../models/users/userSession.model.js";

const readPagination = (query) => ({
    enabled: String(query.pagination ?? "true").toLowerCase() !== "false",
    page: Number(query.page ?? 1),
    limit: Number(query.limit ?? 20)
});

const paginationError = ({ enabled, page, limit }) => {
    if (!enabled) return null;
    if (!Number.isInteger(page) || page <= 0) {
        return "page must be a positive integer";
    }
    if (!Number.isInteger(limit) || limit <= 0) {
        return "limit must be a positive integer";
    }
    return null;
};

const buildPagination = (enabled, total, page, limit) => (
    enabled
        ? {
            enabled: true,
            total,
            page,
            limit,
            totalPages: limit > 0 ? Math.ceil(total / limit) : 0
        }
        : { enabled: false }
);

export const getUserSessionEditLog = async (req, res) => {
    try {
        const {
            table_name,
            record_id,
            username,
            edited_by,
            field_name,
            from_date,
            to_date
        } = req.query;
        const paging = readPagination(req.query);

        if (record_id && !Number.isInteger(Number(record_id))) {
            return res.status(400).json({
                success: false,
                message: "record_id must be an integer"
            });
        }

        const pagingError = paginationError(paging);
        if (pagingError) {
            return res.status(400).json({
                success: false,
                message: pagingError
            });
        }

        const result = await getUserSessionEditLogModel({
            table_name: table_name ? String(table_name).trim() : null,
            record_id: record_id ? Number(record_id) : null,
            username: username ? String(username).trim() : null,
            edited_by: edited_by ? String(edited_by).trim() : null,
            field_name: field_name ? String(field_name).trim() : null,
            from_date: from_date || null,
            to_date: to_date || null,
            page: paging.page,
            limit: paging.limit,
            pagination: paging.enabled
        });

        return res.status(200).json({
            success: true,
            message: "User session edit logs fetched successfully",
            count: result.totalRecords,
            data: result.data,
            pagination: buildPagination(
                paging.enabled,
                result.totalRecords,
                paging.page,
                paging.limit
            )
        });
    } catch (error) {
        console.error("GET USER SESSION EDIT LOG ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

export const getUserSessionOldData = async (req, res) => {
    try {
        const paging = readPagination(req.query);
        const pagingError = paginationError(paging);
        if (pagingError) {
            return res.status(400).json({
                success: false,
                message: pagingError
            });
        }

        const rows = await getUserSessionOldDataModel({
            username: req.query.username
        });
        const total = rows.length;
        const data = paging.enabled
            ? rows.slice((paging.page - 1) * paging.limit, paging.page * paging.limit)
            : rows;

        return res.status(200).json({
            success: true,
            message: "User session old data fetched successfully",
            count: total,
            data,
            pagination: buildPagination(paging.enabled, total, paging.page, paging.limit)
        });
    } catch (error) {
        console.error("GET USER SESSION OLD DATA ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};
