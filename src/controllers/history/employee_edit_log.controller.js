import { addEmployeeEditLogModel, getEmployeeEditLogModel } from "../../models/history/employee_edit_log.model.js";

/* =========================================================
   ADD EMPLOYEE EDIT LOG API
========================================================= */
export const addEmployeeEditLog = async (req, res) => {
    try {
        const {
            personal_details_id,
            username,
            edited_by,
            action,
            old_value,
            new_value,
            description
        } = req.body;

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

        if (!validActions.includes(action.toUpperCase())) {
            return res.status(400).json({
                success: false,
                message: "action must be CREATE, UPDATE or DELETE"
            });
        }

        /* ================= CREATE LOG ================= */
        const data = await addEmployeeEditLogModel({
            personal_details_id:
                personal_details_id
                    ? Number(personal_details_id)
                    : null,

            username: username || null,
            edited_by: edited_by || null,
            action: action.toUpperCase(),
            old_value: old_value ?? null,
            new_value: new_value ?? null,
            description: description || null
        });

        return res.status(201).json({
            success: true,
            message: "Employee edit log added successfully",
            data
        });

    } catch (error) {
        console.error("ADD EMPLOYEE EDIT LOG ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* =========================================================
   GET EMPLOYEE EDIT LOG API
========================================================= */
export const getEmployeeEditLog = async (req, res) => {
    try {
        const {
            personal_details_id,
            username,
            edited_by,
            action,
            from_date,
            to_date,
            page = 1,
            limit = 20,
            pagination = "true"
        } = req.query;

        /* =====================================================
           PAGINATION ENABLE / DISABLE
        ===================================================== */
        const paginationEnabled = String(pagination).toLowerCase() !== "false";

        /* =====================================================
           VALIDATE PERSONAL DETAILS ID
        ===================================================== */
        if (personal_details_id) {

            const personalDetailsId =
                Number(personal_details_id);

            if (
                !Number.isInteger(personalDetailsId) ||
                personalDetailsId <= 0
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Valid personal_details_id is required"
                });
            }
        }

        /* =====================================================
           VALIDATE ACTION
        ===================================================== */
        let normalizedAction = null;

        if (action) {
            normalizedAction = String(action).toUpperCase();

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

        /* =====================================================
           VALIDATE PAGINATION
        ===================================================== */
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

        /* =====================================================
           GET LOG
        ===================================================== */
        const result = await getEmployeeEditLogModel({
            personal_details_id:
                personal_details_id
                    ? Number(personal_details_id)
                    : null,

            username:
                username
                    ? String(username).trim()
                    : null,

            edited_by:
                edited_by
                    ? String(edited_by).trim()
                    : null,

            action: normalizedAction,
            from_date: from_date || null,
            to_date: to_date || null,
            page: pageNumber,
            limit: limitNumber,
            pagination: paginationEnabled
        });

        /* =====================================================
           PAGINATION FALSE
        ===================================================== */
        if (!paginationEnabled) {
            return res.status(200).json({
                success: true,
                message: "Employee edit logs fetched successfully",
                count: result.data.length,
                data: result.data,
                pagination: false
            });
        }

        /* =====================================================
           PAGINATION TRUE
        ===================================================== */
        return res.status(200).json({
            success: true,
            message: "Employee edit logs fetched successfully",
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
        console.error("GET EMPLOYEE EDIT LOG ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};