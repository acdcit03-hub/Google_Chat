import { getIO } from "../../config/socket.js";
import { pool } from "../../database.js";
import { uploadToCloudinary } from "../../middleware/cloudinaryUpload.js";
import { getPersonalDetailsByIdModel } from "../../models/Employee/PersonalDetails.model.js";
import { addWorkExperienceModel, deleteWorkExperienceModel, getAllWorkExperienceModel, getWorkExperienceByIdModel, updateWorkExperienceModel } from "../../models/Employee/WorkExperience.model.js";
import { addEmployeeEditLogModel } from "../../models/history/employee_edit_log.model.js";
import { formatDateOnly } from "./PersonalDetails.controller.js";

const getFolderPath = (data, fallbackId = null) => {
    const username = data?.personal_details?.username || data?.username || null;
    if (username) return username;
    return fallbackId ? String(fallbackId) : 'unknown';
};

/* ================= ADD ================= */
export const addWorkExperience = async (req, res) => {
    try {
        const {
            personal_details_id,
            company_name,
            job_title,
            duration_from,
            duration_to,
            salary,
            reason_for_leaving,
            responsibilities
        } = req.body;

        /* =========================================================
           GET EMPLOYEE
        ========================================================= */
        const personalData = await getPersonalDetailsByIdModel(
            personal_details_id
        );

        if (!personalData?.personal_details) {
            return res.status(404).json({
                success: false,
                message: "Employee not found"
            });
        }

        /* =========================================================
           USERNAME / FOLDER
        ========================================================= */
        const folderPath = getFolderPath(
            personalData,
            personal_details_id
        );

        /* =========================================================
           EXPERIENCE LETTER URL
        ========================================================= */
        let experienceLetterUrl = null;

        /* =========================================================
           FILE UPLOAD
        ========================================================= */
        if (req.file?.buffer) {
            const result = await uploadToCloudinary(
                req.file.buffer,
                `${company_name || "COMPANY"}-experience-letter`,
                folderPath,
                req.file.mimetype
            );

            experienceLetterUrl = result?.secure_url || null;
        }

        /* =========================================================
           DIRECT URL
           
           Example:
           experience_letter:
           https://res.cloudinary.com/....webp
        ========================================================= */
        else if (
            req.body.experience_letter !== undefined &&
            req.body.experience_letter !== null &&
            String(
                req.body.experience_letter
            ).trim() !== ""
        ) {

            experienceLetterUrl =
                String(
                    req.body.experience_letter
                ).trim();
        }

        /* =========================================================
           ADD DATABASE
        ========================================================= */
        const data = await addWorkExperienceModel({
            personal_details_id,
            company_name,
            job_title,

            duration_from:
                duration_from === ""
                    ? null
                    : duration_from,

            duration_to:
                duration_to === ""
                    ? null
                    : duration_to,

            salary,
            reason_for_leaving,
            responsibilities,
            experience_letter: experienceLetterUrl
        });

        /* =========================================================
           SOCKET EMIT
        ========================================================= */
        const io = getIO();

        if (io) {

            io.emit(
                "work-experience:created",
                {
                    success: true,
                    message: "New work experience added",
                    data
                }
            );
        }

        /* =========================================================
           RESPONSE
        ========================================================= */
        return res.status(201).json({
            success: true,
            message: "Work experience added successfully",
            data
        });

    } catch (error) {
        console.error("ADD WORK EXPERIENCE ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= GET ALL ================= */
export const getAllWorkExperience = async (req, res) => {
    try {
        const data = await getAllWorkExperienceModel();

        /* ================= SOCKET EMIT ================= */
        const io = getIO();

        io.emit("work-experience:fetch", {
            success: true,
            message: "work experience fetched",
            data
        });

        return res.json({
            success: true,
            message: "Work Experience fetch successfully",
            data
        });

    } catch (error) {
        console.error("GET WORK EXPERIENCE ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= GET BY ID ================= */
export const getWorkExperienceById = async (req, res) => {
    try {
        const { id } = req.params;

        const data = await getWorkExperienceByIdModel(
            id
        );

        /* ================= SOCKET EMIT ================= */
        const io = getIO();

        io.emit("work-experience:fetch", {
            success: true,
            message: "Work Experience fetched",
            data
        });

        return res.json({
            success: true,
            message: "Work Experience fetch successfully",
            data
        });

    } catch (error) {
        console.error("GET WORK EXPERIENCE ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= UPDATE ================= */
export const updateWorkExperience = async (req, res) => {
    try {
        const {
            personal_details_id,
            company_name
        } = req.body;

        const { id } = req.params;

        /* =========================================================
           GET EMPLOYEE
        ========================================================= */
        const personalData = await getPersonalDetailsByIdModel(
            personal_details_id
        );

        if (!personalData?.personal_details) {
            return res.status(404).json({
                success: false,
                message: "Employee not found"
            });
        }

        /* =========================================================
           EMPLOYEE USERNAME
        ========================================================= */
        const employeeUsername =
            personalData?.personal_details?.username ||
            personalData?.username ||
            null;

        /* =========================================================
           USER WHO PERFORMED EDIT
        ========================================================= */
        const editedBy = req.headers["x-username"]?.trim() || "null";

        /* =========================================================
           GET OLD DATA
        ========================================================= */
        const oldResult = await pool.query(
            `
                SELECT
                    id,
                    personal_details_id,
                    company_name,
                    job_title,
                    duration_from,
                    duration_to,
                    salary,
                    reason_for_leaving,
                    responsibilities,
                    experience_letter
                FROM work_experience
                WHERE id = $1
                  AND personal_details_id = $2
                LIMIT 1
            `,
            [
                id,
                personal_details_id
            ]
        );

        if (oldResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Work experience not found"
            });
        }

        const oldData = oldResult.rows[0];

        /* =========================================================
           FOLDER PATH
        ========================================================= */
        const folderPath = getFolderPath(
            personalData,
            personal_details_id
        );

        /* =========================================================
           EXPERIENCE LETTER
           
           Existing URL by default
        ========================================================= */
        let experienceLetterUrl = oldData.experience_letter || null;

        /* =========================================================
           FILE UPLOAD
           
           If file is uploaded -> upload to Cloudinary
        ========================================================= */
        if (req.file?.buffer) {
            const result = await uploadToCloudinary(
                req.file.buffer,
                `${company_name || "COMPANY"}-experience-letter`,
                folderPath,
                req.file.mimetype
            );

            if (result?.secure_url) {
                experienceLetterUrl =
                    result.secure_url;
            }
        }

        /* =========================================================
           DIRECT URL
           
           If no file is uploaded and URL is provided
           in req.body -> save that URL directly
        ========================================================= */
        else if (
            req.body.experience_letter !== undefined &&
            req.body.experience_letter !== null &&
            String(req.body.experience_letter).trim() !== ""
        ) {

            experienceLetterUrl =
                String(
                    req.body.experience_letter
                ).trim();
        }

        /* =========================================================
           PREPARE UPDATE DATA
        ========================================================= */
        const updateData = {
            ...req.body,
            experience_letter: experienceLetterUrl
        };

        /* =========================================================
           UPDATE DATABASE
        ========================================================= */
        const data = await updateWorkExperienceModel(
            id,
            updateData
        );

        if (!data) {
            return res.status(404).json({
                success: false,
                message: "Work experience not found"
            });
        }

        /* =========================================================
           FIELDS TO TRACK
        ========================================================= */
        const fields = [
            "company_name",
            "job_title",
            "duration_from",
            "duration_to",
            "salary",
            "reason_for_leaving",
            "responsibilities",
            "experience_letter"
        ];

        const oldChangedValues = {};
        const newChangedValues = {};

        /* =========================================================
           DATE FORMAT HELPER
        ========================================================= */
        const formatWorkExperienceDate = (value) => {

            if (
                value === null ||
                value === undefined ||
                value === ""
            ) {
                return null;
            }

            /* ================= STRING DATE ================= */
            if (typeof value === "string") {

                if (
                    /^\d{4}-\d{2}-\d{2}$/.test(value)
                ) {
                    return value;
                }

                if (
                    /^\d{4}-\d{2}-\d{2}T/.test(value)
                ) {
                    return value.substring(0, 10);
                }
            }

            /* ================= DATE OBJECT ================= */
            if (value instanceof Date) {
                if (isNaN(value.getTime())) {
                    return null;
                }

                return value.toLocaleDateString(
                    "en-CA",
                    {
                        timeZone: "Asia/Kolkata"
                    }
                );
            }

            return String(value);
        };

        /* =========================================================
           FIND CHANGED FIELDS
        ========================================================= */
        for (const field of fields) {

            let oldValue = oldData[field] ?? null;

            let newValue =
                data?.[field] ??
                updateData?.[field] ??
                null;

            /* ================= DATE ================= */
            if (
                field === "duration_from" ||
                field === "duration_to"
            ) {
                oldValue = formatWorkExperienceDate(
                    oldValue
                );

                newValue = formatWorkExperienceDate(
                    newValue
                );
            }

            /* ================= SALARY ================= */
            if (field === "salary") {
                if (
                    oldValue !== null &&
                    oldValue !== undefined &&
                    oldValue !== ""
                ) {
                    oldValue = Number(oldValue);
                }

                if (
                    newValue !== null &&
                    newValue !== undefined &&
                    newValue !== ""
                ) {
                    newValue = Number(newValue);
                }
            }

            /* ================= COMPARE ================= */
            const oldCompare =
                oldValue === null ||
                    oldValue === undefined
                    ? ""
                    : String(oldValue).trim();

            const newCompare =
                newValue === null ||
                    newValue === undefined
                    ? ""
                    : String(newValue).trim();

            /* ================= ONLY CHANGED ================= */
            if (oldCompare !== newCompare) {
                oldChangedValues[field] = oldValue;
                newChangedValues[field] = newValue;
            }
        }

        /* =========================================================
           CHANGED FIELDS
        ========================================================= */
        const changedFields =
            Object.keys(
                oldChangedValues
            );

        /* =========================================================
           EMPLOYEE EDIT LOG
        ========================================================= */
        let employeeEditLog = null;

        if (changedFields.length > 0) {
            employeeEditLog = await addEmployeeEditLogModel({
                personal_details_id:
                    Number(
                        personal_details_id
                    ),

                username: employeeUsername,
                edited_by: editedBy,
                action: "UPDATE",
                old_value: oldChangedValues,
                new_value: newChangedValues,
                description: `Work experience updated for ${employeeUsername}. Changed fields: ${changedFields.join(", ")}`
            });
        }

        /* =========================================================
           SOCKET EMIT
        ========================================================= */
        const io = getIO();
        if (io) {

            io.emit(
                "work-experience:updated",
                {
                    success: true,
                    message: "Work experience updated",
                    data
                }
            );
        }

        /* =========================================================
           RESPONSE
        ========================================================= */
        return res.status(200).json({
            success: true,
            message: "Work experience updated successfully",
            data,
            employeeEditLog
        });

    } catch (error) {
        console.error("UPDATE WORK EXPERIENCE ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= DELETE ================= */
export const deleteWorkExperience = async (req, res) => {
    try {
        const { id } = req.params;

        const data = await deleteWorkExperienceModel(id);

        /* ================= SOCKET EMIT ================= */
        const io = getIO();

        io.emit("work-experience:deleted", {
            success: true,
            message: "Deleted work experience",
            data
        });

        return res.json({
            success: true,
            message: "Work experience deleted successfully",
            data
        });

    } catch (error) {
        console.error("DELETE WORK EXPERIENCE ERROR:", error);

        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};