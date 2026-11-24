import { getIO } from "../../config/socket.js";
import { uploadToCloudinary } from "../../middleware/cloudinaryUpload.js";
import {
    addEducationalQualificationsModel,
    deleteEducationalQualificationsModel,
    getAllEducationalQualificationsModel,
    getEducationalQualificationsByIdModel,
    getEducationIdForEmployeeModel,
    updateEducationalQualificationsModel
} from "../../models/Employee/EducationalQualifications.models.js";
import { getPersonalDetailsByIdModel } from "../../models/Employee/PersonalDetails.model.js";
import { addEmployeeEditLogModel } from "../../models/history/employee_edit_log.model.js";

/* ================= SAFE USERNAME HELPER ================= */
const getUsername = (data, fallbackId = null) => {
    const username = data?.personal_details?.username || data?.username || null;
    if (username) return username;
    return fallbackId ? `employee-${fallbackId}` : 'employee-unknown';
};

/* ================= ADD ================= */
export const addEducationalQualifications = async (req, res) => {
    try {
        const {
            personal_details_id,
            education,
            university_institution,
            branch,
            cgpa_percentage,
            year_of_passing,
            work_location
        } = req.body;

        /* ================= EMPLOYEE ================= */
        const personalData = await getPersonalDetailsByIdModel(
            personal_details_id
        );

        if (!personalData) {
            return res.status(404).json({
                success: false,
                message: "Employee not found"
            });
        }

        const username =
            getUsername(
                personalData,
                personal_details_id
            );

        const folderPath = username;

        /* =====================================================
           EDUCATION
        ===================================================== */
        const educationValue =
            education === null ||
                education === undefined
                ? null
                : String(education)
                    .trim()
                    .replace(/^["']+|["']+$/g, "")
                    .trim();

        const educationId = await getEducationIdForEmployeeModel(
            work_location,
            educationValue
        );

        if (!educationId) {
            return res.status(400).json({
                success: false,
                message: `Education "${educationValue}" not found for employee's work location`
            });
        }

        /* =====================================================
           MARKSHEET / CERTIFICATE

           PRIORITY:

           1. File upload → Cloudinary URL
           2. Payload URL → Direct URL
           3. Nothing → null
        ===================================================== */
        let marksheetUrl = null;

        /* ================= FILE UPLOAD ================= */
        if (req.file?.buffer) {
            const result = await uploadToCloudinary(
                req.file.buffer,
                `${educationValue}-MARKSHEET_CERTIFICATE`,
                folderPath,
                req.file.mimetype
            );

            marksheetUrl = result?.secure_url || null;
        }

        /* ================= URL FROM PAYLOAD ================= */
        else if (
            req.body.marksheet_certificate_upload !== undefined &&
            req.body.marksheet_certificate_upload !== null &&
            String(
                req.body.marksheet_certificate_upload
            ).trim() !== ""
        ) {
            marksheetUrl =
                String(
                    req.body.marksheet_certificate_upload
                ).trim();
        }

        /* =====================================================
           CGPA
        ===================================================== */
        const cgpa =
            cgpa_percentage === "" ||
                cgpa_percentage == null
                ? null
                : Number(cgpa_percentage);

        if (
            cgpa !== null &&
            Number.isNaN(cgpa)
        ) {
            return res.status(400).json({
                success: false,
                message: "Invalid CGPA / percentage"
            });
        }

        /* =====================================================
           YEAR OF PASSING
        ===================================================== */
        const yearOfPassing =
            year_of_passing === "" ||
                year_of_passing == null
                ? null
                : Number(year_of_passing);

        if (
            yearOfPassing !== null &&
            Number.isNaN(yearOfPassing)
        ) {
            return res.status(400).json({
                success: false,
                message: "Invalid year of passing"
            });
        }

        /* =====================================================
           DATABASE
        ===================================================== */
        const saved = await addEducationalQualificationsModel({
            personal_details_id,
            education: educationId,
            university_institution,
            branch,
            cgpa_percentage: cgpa,
            year_of_passing: yearOfPassing,
            marksheet_certificate_upload: marksheetUrl
        });

        /* =====================================================
           SOCKET
        ===================================================== */
        const io = getIO();

        if (io) {
            io.emit("employee:added", {
                success: true,
                message: "New Educational qualification added",
                data: saved
            });
        }

        /* =====================================================
           RESPONSE
        ===================================================== */
        return res.status(201).json({
            success: true,
            message: "Educational qualification added successfully",
            data: saved
        });

    } catch (error) {
        console.error("ADD EDUCATIONAL QUALIFICATION ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= GET ALL ================= */
export const getAllEducationalQualifications = async (req, res) => {
    try {
        const data = await getAllEducationalQualificationsModel();

        /* ================= SOCKET EMIT ================= */
        const io = getIO();

        io.emit("employee:fetch", {
            success: true,
            message: "Fetch Educational qualification",
            data
        });

        return res.json({
            success: true,
            data
        });

    } catch (error) {
        console.error("GET EDUCATIONAL QUALIFICATION ERROR:", error);

        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= GET BY ID ================= */
export const getEducationalQualificationsById = async (req, res) => {
    try {
        const { id } = req.params;

        const data = await getEducationalQualificationsByIdModel(id);

        if (!data) {
            return res.status(404).json({
                success: false,
                message: "Record not found"
            });
        }

        /* ================= SOCKET EMIT ================= */
        const io = getIO();

        io.emit("employee:fetch", {
            success: true,
            message: "Fetch Educational qualification",
            data
        });

        return res.json({
            success: true,
            data
        });

    } catch (error) {
        console.error("GET EDUCATIONAL QUALIFICATION ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= UPDATE ================= */
export const updateEducationalQualifications = async (req, res) => {
    try {
        const {
            education,
            cgpa_percentage,
            year_of_passing,
            university_institution,
            branch,
            work_location
        } = req.body;

        const { id } = req.params;

        /* =====================================================
           EXISTING DATA
        ===================================================== */
        const existingData = await getEducationalQualificationsByIdModel(id);

        if (!existingData) {
            return res.status(404).json({
                success: false,
                message: "Record not found"
            });
        }

        /* =====================================================
           EMPLOYEE
        ===================================================== */
        const personalData =
            await getPersonalDetailsByIdModel(
                existingData.personal_details_id
            );

        if (!personalData) {
            return res.status(404).json({
                success: false,
                message: "Employee not found"
            });
        }

        const username =
            getUsername(
                personalData,
                existingData.personal_details_id
            );

        const folderPath = username;

        /* =====================================================
           EDUCATION
        ===================================================== */
        let educationId = existingData.education;
        let educationName = existingData.education_name || existingData.education;

        if (
            education !== undefined &&
            education !== null &&
            String(education).trim() !== ""
        ) {
            const educationValue =
                String(education)
                    .trim()
                    .replace(/^["']+|["']+$/g, "")
                    .trim();

            const foundEducationId = await getEducationIdForEmployeeModel(
                work_location,
                educationValue
            );

            if (!foundEducationId) {
                return res.status(400).json({
                    success: false,
                    message: `Education "${educationValue}" not found for employee's work location`
                });
            }

            educationId = foundEducationId;
            educationName = educationValue;
        }

        /* =====================================================
           MARKSHEET / CERTIFICATE

           PRIORITY:

           1. File → Cloudinary
           2. URL → Direct URL
           3. Nothing → Existing URL
        ===================================================== */
        let marksheetUrl =
            existingData.marksheet_certificate_upload ||
            null;

        /* ================= FILE UPLOAD ================= */
        if (req.file?.buffer) {
            const educationFolderName = educationName || "EDUCATION";

            const result = await uploadToCloudinary(
                req.file.buffer,
                `${educationFolderName}-MARKSHEET_CERTIFICATE`,
                folderPath,
                req.file.mimetype
            );

            if (result?.secure_url) {
                marksheetUrl =
                    result.secure_url;
            }
        }

        /* ================= URL FROM PAYLOAD ================= */
        else if (
            req.body.marksheet_certificate_upload !== undefined &&
            req.body.marksheet_certificate_upload !== null &&
            String(
                req.body.marksheet_certificate_upload
            ).trim() !== ""
        ) {
            marksheetUrl =
                String(
                    req.body.marksheet_certificate_upload
                ).trim();
        }

        /* =====================================================
           CGPA
        ===================================================== */
        const cgpa =
            cgpa_percentage === "" ||
                cgpa_percentage === null ||
                cgpa_percentage === undefined
                ? existingData.cgpa_percentage
                : Number(cgpa_percentage);

        if (
            cgpa !== null &&
            cgpa !== undefined &&
            Number.isNaN(cgpa)
        ) {
            return res.status(400).json({
                success: false,
                message: "Invalid CGPA / percentage"
            });
        }

        /* =====================================================
           YEAR
        ===================================================== */
        let yearOfPassing = existingData.year_of_passing;

        if (
            year_of_passing !== undefined &&
            year_of_passing !== null &&
            year_of_passing !== ""
        ) {

            yearOfPassing = Number(year_of_passing);

            if (Number.isNaN(yearOfPassing)) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid year of passing"
                });
            }
        }

        /* =====================================================
           UPDATE
        ===================================================== */
        const updated = await updateEducationalQualificationsModel(
            id,
            {
                education: educationId,

                university_institution:
                    university_institution ??
                    existingData.university_institution,

                branch:
                    branch ??
                    existingData.branch,

                cgpa_percentage: cgpa,
                year_of_passing: yearOfPassing,
                marksheet_certificate_upload: marksheetUrl
            }
        );

        if (!updated) {
            return res.status(404).json({
                success: false,
                message: "Record not found"
            });
        }

        /* =====================================================
           EDIT LOG
        ===================================================== */
        const fieldsToCheck = [
            "education",
            "university_institution",
            "branch",
            "cgpa_percentage",
            "year_of_passing",
            "marksheet_certificate_upload"
        ];

        const editedBy =
            req.headers["x-username"]?.trim() ||
            req.body?.username?.trim() ||
            "null";

        for (const field of fieldsToCheck) {
            const oldValue =
                existingData[field] !== null &&
                    existingData[field] !== undefined
                    ? existingData[field]
                    : null;

            const newValue =
                updated[field] !== null &&
                    updated[field] !== undefined
                    ? updated[field]
                    : null;

            if (
                JSON.stringify(oldValue) !==
                JSON.stringify(newValue)
            ) {
                await addEmployeeEditLogModel({
                    personal_details_id: existingData.personal_details_id,

                    username:
                        personalData?.personal_details?.username ||
                        personalData?.username ||
                        username,

                    edited_by: editedBy,
                    action: "UPDATE",

                    old_value: {
                        field,
                        value: oldValue
                    },

                    new_value: {
                        field,
                        value: newValue
                    },

                    description: `Educational qualification ${field} updated`
                });
            }
        }

        /* =====================================================
           SOCKET
        ===================================================== */
        const io = getIO();

        if (io) {
            io.emit("employee:updated", {
                success: true,
                message: "Update Educational qualification",
                data: updated
            });
        }

        /* =====================================================
           RESPONSE
        ===================================================== */
        return res.status(200).json({
            success: true,
            message: "Educational qualification updated successfully",
            data: updated
        });

    } catch (error) {
        console.error("UPDATE EDUCATIONAL QUALIFICATION ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= DELETE ================= */
export const deleteEducationalQualifications = async (req, res) => {

    try {

        const { id } = req.params;

        const deleted = await deleteEducationalQualificationsModel(id);

        if (!deleted) {
            return res.status(404).json({
                success: false,
                message: "Educational qualification not found."
            });
        }

        /* ================= SOCKET EMIT ================= */
        const io = getIO();

        io.emit("employee:deleted", {
            success: true,
            message: "Educational qualification deleted",
            data: deleted
        });

        return res.status(200).json({
            success: true,
            message: "Educational qualification deleted successfully.",
            data: deleted
        });

    } catch (error) {

        console.error(
            "DELETE EDUCATIONAL QUALIFICATION ERROR:",
            error
        );

        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};
