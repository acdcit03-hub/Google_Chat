import { getIO } from "../../config/socket.js";
import { uploadToCloudinary } from "../../middleware/cloudinaryUpload.js";
import { addIdentificationDetailsModel, getAllIdentificationDetailsModel, getIdentificationDetailsByIdModel, updateIdentificationDetailsModel } from "../../models/Employee/IdentificationDetails.model.js";
import { getPersonalDetailsByIdModel } from "../../models/Employee/PersonalDetails.model.js";
import { addEmployeeEditLogModel } from "../../models/history/employee_edit_log.model.js";

export const getUsernameFromPersonalData = (data, fallbackId = null) => {
    const username = data?.personal_details?.username || data?.username || null;
    if (username) return username;
    return fallbackId ? `employee-${fallbackId}` : 'employee-unknown';
};

/* ================= ADD ================= */
export const addIdentificationDetails = async (req, res) => {
    try {
        const {
            personal_details_id,
            pan_card_number,
            aadhaar_number
        } = req.body;

        /* =====================================================
           EMPLOYEE CHECK
        ===================================================== */
        const personalData = await getPersonalDetailsByIdModel(
            personal_details_id
        );

        if (!personalData) {
            return res.status(404).json({
                success: false,
                message: "Employee not found"
            });
        }

        /* =====================================================
           FOLDER
        ===================================================== */
        const username = getUsernameFromPersonalData(
            personalData,
            personal_details_id
        );

        const folderPath = username;

        /* =====================================================
           FILES
        ===================================================== */
        const panFile = req.files?.pan_card_upload?.[0];
        const aadhaarFile = req.files?.aadhaar_upload?.[0];
        const otherFile = req.files?.other_document_upload?.[0];

        /* =====================================================
           CLOUDINARY UPLOAD
           
           Only upload when FILE is present.
           
           If URL is sent in payload, Cloudinary is NOT called.
        ===================================================== */
        const [
            panResult,
            aadhaarResult,
            otherResult
        ] = await Promise.all([

            panFile
                ? uploadToCloudinary(
                    panFile.buffer,
                    "PAN",
                    folderPath,
                    panFile.mimetype
                )
                : null,

            aadhaarFile
                ? uploadToCloudinary(
                    aadhaarFile.buffer,
                    "AADHAAR",
                    folderPath,
                    aadhaarFile.mimetype
                )
                : null,

            otherFile
                ? uploadToCloudinary(
                    otherFile.buffer,
                    "OTHER",
                    folderPath,
                    otherFile.mimetype
                )
                : null

        ]);

        /* =====================================================
           URLS
           
           PRIORITY:
           
           1. Uploaded file → Cloudinary URL
           2. Payload URL → Direct URL
           3. Nothing → null
        ===================================================== */
        const panCardUrl = panResult?.secure_url ||
            (
                req.body.pan_card_upload &&
                    String(req.body.pan_card_upload).trim() !== ""
                    ? String(req.body.pan_card_upload).trim()
                    : null
            );

        const aadhaarUrl = aadhaarResult?.secure_url ||
            (
                req.body.aadhaar_upload &&
                    String(req.body.aadhaar_upload).trim() !== ""
                    ? String(req.body.aadhaar_upload).trim()
                    : null
            );

        const otherDocUrl = otherResult?.secure_url ||
            (
                req.body.other_document_upload &&
                    String(req.body.other_document_upload).trim() !== ""
                    ? String(req.body.other_document_upload).trim()
                    : null
            );

        /* =====================================================
           DATABASE
        ===================================================== */
        const saved = await addIdentificationDetailsModel({
            personal_details_id,
            pan_card_number,
            pan_card_upload: panCardUrl,
            aadhaar_number,
            aadhaar_upload: aadhaarUrl,
            other_document_upload: otherDocUrl

        });

        /* =====================================================
           SOCKET
        ===================================================== */
        const io = getIO();

        if (io) {
            io.emit("employee:added", {
                success: true,
                message: "New Identification details added",
                data: saved
            });
        }

        /* =====================================================
           RESPONSE
        ===================================================== */
        return res.status(201).json({
            success: true,
            message: "Identification details added successfully",
            data: saved
        });

    } catch (error) {
        console.error("ADD IDENTIFICATION DETAILS ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= GET ALL ================= */
export const getAllIdentificationDetails = async (req, res) => {
    try {
        const data = await getAllIdentificationDetailsModel();

        /* ================= SOCKET EMIT ================= */
        const io = getIO();

        io.emit("employee:fetch", {
            success: true,
            message: "Fetch Identification details",
            data
        });

        return res.json({
            success: true,
            data
        });

    } catch (error) {
        console.error("GET IDENTIFICATION DETAILS ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= GET BY ID ================= */
export const getIdentificationDetailsById = async (req, res) => {
    try {
        const { id } = req.params;

        const data = await getIdentificationDetailsByIdModel(id);

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
            message: "Fetch Identification details",
            data
        });

        return res.json({
            success: true,
            data
        });

    } catch (error) {
        console.error("GET IDENTIFICATION DETAILS ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= UPDATE ================= */
export const updateIdentificationDetails = async (req, res) => {
    try {
        const { id } = req.params;

        /* =========================================================
           GET OLD DATA
        ========================================================= */
        const existingData = await getIdentificationDetailsByIdModel(id);

        if (!existingData) {
            return res.status(404).json({
                success: false,
                message: "Identification details not found"
            });
        }

        /* =========================================================
           GET EMPLOYEE DATA
        ========================================================= */
        const personalData = await getPersonalDetailsByIdModel(
            existingData.personal_details_id
        );

        if (!personalData) {
            return res.status(404).json({
                success: false,
                message: "Employee not found"
            });
        }

        /* =========================================================
           USERNAME
        ========================================================= */
        const username = getUsernameFromPersonalData(
            personalData,
            existingData.personal_details_id || id
        );

        const folderPath = username;

        /* =========================================================
           OLD URLS
        ========================================================= */
        let panCardUrl = existingData.pan_card_upload || null;
        let aadhaarUrl = existingData.aadhaar_upload || null;
        let otherDocUrl = existingData.other_document_upload || null;

        /* =========================================================
           PAN CARD
           
           Priority:
           1. Uploaded file
           2. URL from payload
           3. Existing URL
        ========================================================= */
        const panFile = req.files?.pan_card_upload?.[0];

        if (panFile) {
            const result = await uploadToCloudinary(
                panFile.buffer,
                "PAN",
                folderPath,
                panFile.mimetype
            );

            if (result?.secure_url) {
                panCardUrl = result.secure_url;
            }

        } else if (
            req.body.pan_card_upload !== undefined &&
            req.body.pan_card_upload !== null &&
            String(req.body.pan_card_upload).trim() !== ""
        ) {
            panCardUrl = String(req.body.pan_card_upload).trim();
        }

        /* =========================================================
           AADHAAR
           
           Priority:
           1. Uploaded file
           2. URL from payload
           3. Existing URL
        ========================================================= */
        const aadhaarFile = req.files?.aadhaar_upload?.[0];

        if (aadhaarFile) {
            const result = await uploadToCloudinary(
                aadhaarFile.buffer,
                "AADHAAR",
                folderPath,
                aadhaarFile.mimetype
            );

            if (result?.secure_url) {
                aadhaarUrl = result.secure_url;
            }

        } else if (
            req.body.aadhaar_upload !== undefined &&
            req.body.aadhaar_upload !== null &&
            String(req.body.aadhaar_upload).trim() !== ""
        ) {
            aadhaarUrl = String(req.body.aadhaar_upload).trim();
        }

        /* =========================================================
           OTHER DOCUMENT
           
           Priority:
           1. Uploaded file
           2. URL from payload
           3. Existing URL
        ========================================================= */
        const otherFile = req.files?.other_document_upload?.[0];

        if (otherFile) {
            const result = await uploadToCloudinary(
                otherFile.buffer,
                "OTHER",
                folderPath,
                otherFile.mimetype
            );

            if (result?.secure_url) {
                otherDocUrl = result.secure_url;
            }

        } else if (
            req.body.other_document_upload !== undefined &&
            req.body.other_document_upload !== null &&
            String(req.body.other_document_upload).trim() !== ""
        ) {
            otherDocUrl = String(req.body.other_document_upload).trim();
        }

        /* =========================================================
           UPDATE DATA
        ========================================================= */
        const updateData = {
            pan_card_number:
                req.body.pan_card_number ??
                existingData.pan_card_number,

            pan_card_upload: panCardUrl,

            aadhaar_number:
                req.body.aadhaar_number ??
                existingData.aadhaar_number,

            aadhaar_upload: aadhaarUrl,
            other_document_upload: otherDocUrl
        };

        /* =========================================================
           UPDATE DATABASE
        ========================================================= */
        const updated = await updateIdentificationDetailsModel(
            id,
            updateData
        );

        if (!updated) {
            return res.status(404).json({
                success: false,
                message: "Identification details not found"
            });
        }

        /* =========================================================
           FIELDS TO TRACK
        ========================================================= */
        const fields = [
            "pan_card_number",
            "pan_card_upload",
            "aadhaar_number",
            "aadhaar_upload",
            "other_document_upload"
        ];

        /* =========================================================
           FIND CHANGED FIELDS
        ========================================================= */
        const oldChangedValues = {};
        const newChangedValues = {};

        for (const field of fields) {
            const oldValue = existingData?.[field] ?? null;
            const newValue = updated?.[field] ?? null;

            const oldCompare =
                oldValue === null ||
                    oldValue === undefined
                    ? null
                    : String(oldValue).trim();

            const newCompare =
                newValue === null ||
                    newValue === undefined
                    ? null
                    : String(newValue).trim();

            if (oldCompare !== newCompare) {
                oldChangedValues[field] = oldValue;
                newChangedValues[field] = newValue;
            }
        }

        /* =========================================================
           EDITED BY
        ========================================================= */
        const editedBy = req.headers["x-username"]?.trim() || "null";

        /* =========================================================
           CHECK CHANGES
        ========================================================= */
        const changedFields = Object.keys(oldChangedValues);
        const hasChanges = changedFields.length > 0;

        /* =========================================================
           ADD EMPLOYEE EDIT LOG
        ========================================================= */
        let employeeEditLog = null;

        if (hasChanges) {
            employeeEditLog = await addEmployeeEditLogModel({

                personal_details_id:
                    Number(
                        existingData.personal_details_id
                    ),

                username:
                    personalData?.personal_details?.username ||
                    personalData?.username ||
                    username,

                edited_by: editedBy,
                action: "UPDATE",
                old_value: oldChangedValues,
                new_value: newChangedValues,
                description: `Identification details updated for ${username}. Changed fields: ${changedFields.join(", ")}`
            });
        }

        /* =========================================================
           SOCKET EMIT
        ========================================================= */
        const io = getIO();

        if (io) {
            io.emit("employee:updated", {
                success: true,
                message: "Updated Identification details",
                data: updated
            });
        }

        /* =========================================================
           RESPONSE
        ========================================================= */
        return res.status(200).json({
            success: true,
            message: "Identification details updated successfully",
            data: updated,
            employeeEditLog: employeeEditLog
        });

    } catch (error) {
        console.error("UPDATE IDENTIFICATION DETAILS ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};