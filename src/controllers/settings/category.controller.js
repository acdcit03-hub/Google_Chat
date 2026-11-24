import { getIO } from "../../config/socket.js";
import { pool } from "../../database.js";
import { uploadCategoryImageToCloudinary } from "../../middleware/cloudinaryUpload.js";
import { addSettingEditLogModel } from "../../models/history/setting_edit_log.model.js";
import {
    checkDuplicateCategory,
    createCategoryModel,
    getAllCategoryModel,
    getEmployeeRequiredFieldNamesModel,
    toggleCategoryStatusModel,
    updateCategoryEverywhere,
    updateCategoryModel
} from "../../models/settings/category.model.js";

/* ================= CREATE ================= */
export const createCategory = async (req, res) => {
    try {
        const { id } = req.params;

        const username = req.headers["x-username"]
            ? String(req.headers["x-username"]).trim()
            : null;

        /* =================================================
           CHECK DUPLICATE CATEGORY
        ================================================= */
        const duplicateCategory = await checkDuplicateCategory({
            category_name: req.body.category_name,
            work_location: req.body.work_location
        });

        if (duplicateCategory) {
            return res.status(409).json({
                success: false,
                message: `Category "${req.body.category_name}" already exists for this work location.`,
                data: duplicateCategory
            });
        }

        /* =================================================
           CATEGORY IMAGE
        ================================================= */
        let categoryImage = null;

        if (req.file) {

            if (
                !req.file.mimetype ||
                !req.file.mimetype.startsWith("image/")
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Only image files are allowed for category_image."
                });
            }

            const categoryFileName =
                `CATEGORY_${String(
                    req.body.category_name || "IMAGE"
                )
                    .trim()
                    .replace(/\s+/g, "_")
                    .replace(/[^a-zA-Z0-9_-]/g, "_")}`;

            const uploadResult = await uploadCategoryImageToCloudinary(
                req.file.buffer,
                `CATEGORY_${id}`,
                req.file.mimetype
            );

            categoryImage = uploadResult.secure_url;
        }

        const data = await createCategoryModel({
            ...req.body,
            category_image: categoryImage,
            username
        });

        return res.status(201).json({
            success: true,
            message: "Category created successfully.",
            data
        });

    } catch (err) {

        return res.status(500).json({
            success: false,
            message: err.message
        });

    }
};

/* ================= GET ALL ================= */
export const getAllCategory = async (req, res) => {
    try {

        const { work_location } = req.query;

        const data = await getAllCategoryModel(work_location);

        return res.status(200).json({
            success: true,
            message: "Category fetched successfully.",
            data
        });

    } catch (err) {
        return res.status(500).json({
            success: false,
            message: err.message
        });

    }
};

/* ================= GET EMPLOYEE REQUIRED FILED NAME ================= */
export const getEmployeeRequiredFieldNames = async (
    req,
    res
) => {
    try {
        const search = req.query.search ?? req.query.q ?? null;
        const requiredFields = await getEmployeeRequiredFieldNamesModel({
            search
        });

        return res.status(200).json({
            success: true,
            required_fields: requiredFields
        });

    } catch (error) {
        console.error("GET REQUIRED FIELD NAMES ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= UPDATE ================= */
export const updateCategory = async (req, res) => {
    try {
        const { id } = req.params;

        /* =====================================================
           GET OLD CATEGORY
        ===================================================== */
        const oldCategoryResult = await pool.query(
            `
                SELECT *
                FROM category
                WHERE id = $1
            `,
            [id]
        );

        if (oldCategoryResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Category not found."
            });

        }

        const oldCategory = oldCategoryResult.rows[0];

        /* =====================================================
           CHECK CATEGORY STATUS
           INACTIVE CATEGORY CANNOT BE UPDATED
        ===================================================== */
        if (oldCategory.is_active === false) {
            return res.status(400).json({
                success: false,
                message: "This category is inactive, so it cannot be updated."
            });
        }

        /* =====================================================
           GET CURRENT EDITOR FROM HEADER
        ===================================================== */
        const editedBy = req.headers["x-username"]
            ? String(req.headers["x-username"]).trim()
            : null;

        /* =====================================================
           CATEGORY OWNER / CREATOR
        ===================================================== */
        const logUsername =
            oldCategory.username !== undefined &&
                oldCategory.username !== null &&
                String(oldCategory.username).trim() !== ""
                ? String(oldCategory.username).trim()
                : null;

        /* =================================================
           PREPARE UPDATE DATA
        ================================================= */
        const updateData = {
            ...req.body
        };

        /* =================================================
           PREPARE FINAL CATEGORY + WORK LOCATION
        ================================================= */
        const finalCategoryName =
            req.body.category_name !== undefined
                ? req.body.category_name
                : oldCategory.category_name;
        
        const finalWorkLocation =
            req.body.work_location !== undefined
                ? req.body.work_location
                : oldCategory.work_location;

        /* =================================================
           CHECK DUPLICATE CATEGORY
           SAME CATEGORY + SAME WORK LOCATION
           BUT EXCLUDE CURRENT CATEGORY ID
        ================================================= */
        const duplicateCategory = await checkDuplicateCategory({
                category_name: finalCategoryName,
                work_location: finalWorkLocation,
                excludeId: Number(id)
            });

        if (duplicateCategory) {
            return res.status(409).json({
                success: false,
                message: `Category "${finalCategoryName}" already exists for this work location.`,
                data: duplicateCategory
            });
        }

        /* =================================================
           CATEGORY IMAGE
        ================================================= */
        if (req.file) {
            /* =================================================
               UPLOAD IMAGE
            ================================================= */
            const uploadResult = await uploadCategoryImageToCloudinary(
                req.file.buffer,
                `CATEGORY_${id}`,
                req.file.mimetype
            );

            updateData.category_image = uploadResult.secure_url;
        }

        /* =================================================
           UPDATE CATEGORY
        ================================================= */
        const data = await updateCategoryModel(
            id,
            updateData
        );

        if (!data) {
            return res.status(404).json({
                success: false,
                message: "Category not found."
            });

        }

        /* =====================================================
           FIELDS TO LOG
        ===================================================== */
        const logFields = [
            "category_name",
            "category_image",
            "work_location",
            "is_active"
        ];

        /* =====================================================
           NORMALIZE VALUE
        ===================================================== */
        const normalizeLogValue = (value) => {
            if (
                value === undefined ||
                value === null
            ) {
                return null;
            }

            if (Array.isArray(value)) {
                return value
                    .map(item =>
                        String(item)
                            .trim()
                            .toUpperCase()
                    )
                    .filter(Boolean)
                    .join(", ");

            }

            return String(value).trim();
        };

        /* =====================================================
           CREATE SETTING LOG
        ===================================================== */
        const settingLogs = [];
        for (const field of logFields) {

            const oldValue =
                normalizeLogValue(
                    oldCategory[field]
                );

            const newValue =
                normalizeLogValue(
                    data[field]
                );

            /* =================================================
               ONLY LOG CHANGED FIELD
            ================================================= */
            if (oldValue === newValue) {
                continue;
            }

            const log = await addSettingEditLogModel({
                table_name: "category",
                record_id: Number(id),
                username: logUsername,
                edited_by: editedBy,
                field_name: field,
                old_value: oldValue,
                new_value: newValue
            });
            settingLogs.push(log);
        }

        /* =====================================================
           RESPONSE
        ===================================================== */
        return res.status(200).json({
            success: true,
            message: "Category updated successfully.",
            data,
            settingLogs
        });

    } catch (err) {
        console.error("UPDATE CATEGORY ERROR:", err);
        return res.status(500).json({
            success: false,
            message: err.message
        });
    }
};

/* ================= TOGGLE STATUS ================= */
export const toggleCategoryStatus = async (req, res) => {
    try {

        const { id } = req.params;

        /* =====================================================
           GET CURRENT EDITOR
        ===================================================== */
        const editedBy =
            req.headers["x-username"]
                ? String(req.headers["x-username"]).trim()
                : null;

        /* =====================================================
           GET OLD CATEGORY
        ===================================================== */
        const oldCategoryResult = await pool.query(
            `
                SELECT
                    id,
                    is_active,
                    username
                FROM category
                WHERE id = $1
            `,
            [id]
        );

        /* ================= NOT FOUND ================= */
        if (!oldCategoryResult.rows.length) {
            return res.status(404).json({
                success: false,
                message: "Category not found."
            });
        }

        const oldCategory = oldCategoryResult.rows[0];

        /* =====================================================
           ORIGINAL CREATOR
           setting_edit_log.username = category.username
        ===================================================== */
        const logUsername =
            oldCategory.username !== undefined &&
                oldCategory.username !== null &&
                String(oldCategory.username).trim() !== ""
                ? String(oldCategory.username).trim()
                : null;

        /* =====================================================
           OLD STATUS
        ===================================================== */
        const oldStatus = Boolean(oldCategory.is_active);

        /* =====================================================
           TOGGLE CATEGORY STATUS
        ===================================================== */
        const data = await toggleCategoryStatusModel(id);

        /* ================= NOT FOUND ================= */
        if (!data) {
            return res.status(404).json({
                success: false,
                message: "Category not found."
            });
        }

        /* ================= USED BY EMPLOYEE ================= */
        if (data.blocked) {
            return res.status(400).json({
                success: false,
                message: data.message,
                used_count: data.used_count
            });
        }

        /* =====================================================
           NEW STATUS
        ===================================================== */
        const newStatus = Boolean(data.is_active);

        /* =====================================================
           ADD STATUS EDIT LOG
        ===================================================== */
        const settingLogs = [];

        if (oldStatus !== newStatus) {
            const log = await addSettingEditLogModel({
                table_name: "category",
                record_id: Number(id),
                username: logUsername,
                edited_by: editedBy,
                field_name: "is_active",
                old_value: String(oldStatus),
                new_value: String(newStatus)
            });

            settingLogs.push(log);
        }

        /* =====================================================
           SOCKET
        ===================================================== */
        const io = getIO();

        if (io) {
            io.emit("category:status-updated", {
                success: true,
                message:
                    `Category ${newStatus
                        ? "activated"
                        : "deactivated"
                    } successfully.`,
                data,
                settingLogs
            });
        }

        /* =====================================================
           RESPONSE
        ===================================================== */
        return res.status(200).json({
            success: true,
            message:
                `Category ${newStatus
                    ? "activated"
                    : "deactivated"
                } successfully.`,
            data,
            settingLogs
        });

    } catch (err) {
        console.error("TOGGLE CATEGORY STATUS ERROR:", err);
        return res.status(500).json({
            success: false,
            message: err.message
        });
    }
};