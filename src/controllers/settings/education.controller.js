import { pool } from "../../database.js";
import { addSettingEditLogModel } from "../../models/history/setting_edit_log.model.js";
import { createEducationModel, getAllEducationModel, toggleEducationStatusModel, updateEducationEverywhere, updateEducationModel } from "../../models/settings/education.model.js";

/* ================= CREATE ================= */
export const createEducation = async (req, res) => {

    try {
        const username = req.headers["x-username"]
            ? String(req.headers["x-username"]).trim()
            : null;

        const data = await createEducationModel({
            ...req.body,
            username
        });

        return res.status(201).json({
            success: true,
            message: "Education created successfully.",
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
export const getAllEducation = async (req, res) => {
    try {

        const { work_location } = req.query;

        const data = await getAllEducationModel(
            work_location || null
        );

        return res.status(200).json({
            success: true,
            message: "Education fetched successfully.",
            data
        });

    } catch (err) {
        console.error("GET ALL EDUCATION ERROR:", err);
        return res.status(500).json({
            success: false,
            message: err.message
        });
    }
};

/* ================= UPDATE ================= */
export const updateEducation = async (req, res) => {
    try {
        const { id } = req.params;

        /* =====================================================
           GET OLD EDUCATION
        ===================================================== */
        const oldEducationResult = await pool.query(
            `
                SELECT *
                FROM education
                WHERE id = $1
            `,
            [id]
        );

        if (!oldEducationResult.rows.length) {
            return res.status(404).json({
                success: false,
                message: "Education not found."
            });
        }

        const oldEducation = oldEducationResult.rows[0];

        /* =====================================================
           CHECK EDUCATION STATUS
           INACTIVE EDUCATION CANNOT BE UPDATED
        ===================================================== */

        if (oldEducation.is_active === false) {
            return res.status(400).json({
                success: false,
                message: "This education is inactive, so it cannot be updated."
            });
        }

        /* =====================================================
           GET CURRENT EDITOR FROM HEADER
        ===================================================== */
        const editedBy =
            req.headers["x-username"]
                ? String(req.headers["x-username"]).trim()
                : null;

        if (!editedBy) {
            return res.status(400).json({
                success: false,
                message: "x-username header is required"
            });
        }

        /* =====================================================
           ORIGINAL CREATOR
           
           setting_edit_log.username = education.username
        ===================================================== */
        const logUsername = oldEducation.username !== undefined &&
            oldEducation.username !== null &&
            String(oldEducation.username).trim() !== ""
            ? String(oldEducation.username).trim()
            : null;

        /* =====================================================
           UPDATE MASTER EDUCATION
        ===================================================== */
        const data = await updateEducationModel(
            id,
            req.body
        );

        if (!data) {
            return res.status(404).json({
                success: false,
                message: "Education not found."
            });
        }

        /* =====================================================
           UPDATE EDUCATION NAME EVERYWHERE
        ===================================================== */
        let updateResult = null;

        const oldEducationName = oldEducation.education_name?.trim();

        const newEducationName =
            data.education_name?.trim();

        if (
            oldEducationName &&
            newEducationName &&
            oldEducationName !== newEducationName
        ) {
            updateResult = await updateEducationEverywhere(
                Number(id),
                newEducationName
            );
        }

        /* =====================================================
           FIELDS TO LOG
        ===================================================== */
        const logFields = [
            "education_name",
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
            const oldValue = normalizeLogValue(
                oldEducation[field]
            );

            const newValue = normalizeLogValue(
                data[field]
            );

            /* ================================================
               ONLY LOG CHANGED FIELD
            ================================================ */
            if (oldValue === newValue) {
                continue;
            }

            const log = await addSettingEditLogModel({
                table_name: "education",
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
            message: "Education updated successfully.",
            data,
            updateResult,
            settingLogs
        });

    } catch (err) {
        console.error("UPDATE EDUCATION ERROR:", err);
        return res.status(500).json({
            success: false,
            message: err.message
        });
    }
};

/* ================= TOGGLE EDUCATION STATUS ================= */
export const toggleEducationStatus = async (req, res) => {
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
           GET OLD EDUCATION
        ===================================================== */
        const oldEducationResult = await pool.query(
            `
                SELECT
                    id,
                    is_active,
                    username
                FROM education
                WHERE id = $1
            `,
            [id]
        );

        /* ================= NOT FOUND ================= */
        if (!oldEducationResult.rows.length) {
            return res.status(404).json({
                success: false,
                message: "Education not found."
            });
        }

        const oldEducation = oldEducationResult.rows[0];

        /* =====================================================
           ORIGINAL CREATOR
           
           setting_edit_log.username = education.username
        ===================================================== */
        const logUsername =
            oldEducation.username !== undefined &&
                oldEducation.username !== null &&
                String(oldEducation.username).trim() !== ""
                ? String(oldEducation.username).trim()
                : null;

        /* =====================================================
           OLD STATUS
        ===================================================== */
        const oldStatus = Boolean(oldEducation.is_active);

        /* =====================================================
           TOGGLE EDUCATION STATUS
        ===================================================== */
        const data = await toggleEducationStatusModel(
            id
        );

        /* ================= NOT FOUND ================= */
        if (!data) {
            return res.status(404).json({
                success: false,
                message: "Education not found."
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
           SETTING EDIT LOG
        ===================================================== */
        const settingLogs = [];
        if (oldStatus !== newStatus) {
            const log = await addSettingEditLogModel({
                table_name: "education",
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
           RESPONSE
        ===================================================== */
        return res.status(200).json({
            success: true,
            message:
                `Education ${newStatus
                    ? "activated"
                    : "deactivated"
                } successfully.`,
            data,
            settingLogs

        });

    } catch (err) {
        console.error("TOGGLE EDUCATION STATUS ERROR:", err);
        return res.status(500).json({
            success: false,
            message: err.message
        });
    }
};