import { getDeviceVersionLogsModel } from "../../models/history/device_version_logs.model.js";

/* =========================================================
   GET DEVICE VERSION LOGS
========================================================= */
export const getDeviceVersionLogs = async (req, res) => {
    try {

        const {
            mac_id,
            old_version,
            new_version,
            from_date,
            to_date,
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

        /* ================= GET DATA ================= */
        const result = await getDeviceVersionLogsModel({
                mac_id:
                    mac_id
                        ? String(mac_id).trim()
                        : null,

                old_version:
                    old_version
                        ? String(old_version).trim()
                        : null,

                new_version:
                    new_version
                        ? String(new_version).trim()
                        : null,

                from_date:
                    from_date
                        ? String(from_date).trim()
                        : null,

                to_date:
                    to_date
                        ? String(to_date).trim()
                        : null,

                page: pageNumber,
                limit: limitNumber,
                pagination: paginationEnabled
            });

        /* =================================================
           WITHOUT PAGINATION
        ================================================= */
        if (!paginationEnabled) {

            return res.status(200).json({
                success: true,
                message: "Device version logs fetched successfully",                
                count: result.data.length,
                data: result.data,
                pagination: false,
            });
        }

        /* =================================================
           WITH PAGINATION
        ================================================= */
        return res.status(200).json({
            success: true,
            message: "Device version logs fetched successfully",
            data: result.data,
            pagination: {
                page: pageNumber,
                limit: limitNumber,
                totalRecords: result.totalRecords,
                totalPages:
                    Math.ceil(
                        result.totalRecords /
                        limitNumber
                    )
            },
        });

    } catch (error) {
        console.error("GET DEVICE VERSION LOG ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};