import { getIO } from "../../config/socket.js";
import { uploadToCloudinary } from "../../middleware/cloudinaryUpload.js";
import { addBankDetailsModel, getAllBankDetailsModel, getBankDetailsByIdModel, updateBankDetailsModel } from "../../models/Employee/BankDetails.model.js";
import { getPersonalDetailsByIdModel } from "../../models/Employee/PersonalDetails.model.js";
import { addEmployeeEditLogModel } from "../../models/history/employee_edit_log.model.js";

/* ================= SAFE USERNAME HELPER ================= */
const getUsername = (data, fallbackId = null) => {
    const username = data?.personal_details?.username || data?.username || null;
    if (username) return username;
    return fallbackId ? `employee-${fallbackId}` : 'employee-unknown';
};

/* ================= ADD ================= */
export const addBankDetails = async (req, res) => {
    try {
        const {
            personal_details_id,
            bank_name,
            account_holder_name,
            account_number,
            ifsc_code,
            branch_name
        } = req.body;

        const personalData = await getPersonalDetailsByIdModel(
            personal_details_id
        );

        if (!personalData) {
            return res.status(404).json({
                success: false,
                message: "Employee not found"
            });
        }

        const username = getUsername(
            personalData,
            personal_details_id
        );

        const folderPath = username;

        /* =========================================================
           BANK PROOF
           
           Priority:
           1. File upload → Cloudinary URL
           2. URL from payload → Direct URL
           3. Nothing → null
        ========================================================= */
        let bankProofUrl = null;

        if (req.file?.buffer) {
            const result = await uploadToCloudinary(
                req.file.buffer,
                "BANK_PROOF",
                folderPath,
                req.file.mimetype
            );

            bankProofUrl = result?.secure_url || null;

        } else if (
            req.body.bank_proof !== undefined &&
            req.body.bank_proof !== null &&
            String(req.body.bank_proof).trim() !== ""
        ) {
            bankProofUrl = String(req.body.bank_proof).trim();
        }

        /* =========================================================
           DATABASE
        ========================================================= */
        const saved = await addBankDetailsModel({
            personal_details_id,
            bank_name,
            account_holder_name,
            account_number,
            ifsc_code,
            branch_name,
            bank_proof: bankProofUrl
        });

        /* =========================================================
           SOCKET EMIT
        ========================================================= */
        const io = getIO();

        if (io) {
            io.emit("employee:added", {
                success: true,
                message: "New Bank details added",
                data: saved
            });
        }

        /* =========================================================
           RESPONSE
        ========================================================= */
        return res.status(201).json({
            success: true,
            message: "Bank details added successfully",
            data: saved
        });

    } catch (error) {
        console.error("ADD BANK DETAILS ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= GET ALL ================= */
export const getAllBankDetails = async (req, res) => {
    try {
        const data = await getAllBankDetailsModel();

        /* ================= SOCKET EMIT ================= */
        const io = getIO();

        io.emit("employee:fetch", {
            success: true,
            message: "Fetch Bank details",
            data
        });

        return res.json({
            success: true,
            data
        });

    } catch (error) {
        console.error("GET BANK DETAILS ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= GET BY ID ================= */
export const getBankDetailsById = async (req, res) => {
    try {
        const { id } = req.params;

        const data = await getBankDetailsByIdModel(id);

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
            message: "Fetch Bank details",
            data
        });

        return res.json({
            success: true,
            data
        });

    } catch (error) {
        console.error("GET BANK DETAILS ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= UPDATE ================= */
export const updateBankDetails = async (req, res) => {
    try {
        const { id } = req.params;

        /* =========================================================
           GET EXISTING BANK DATA
        ========================================================= */
        const existingData =
            await getBankDetailsByIdModel(id);

        if (!existingData) {
            return res.status(404).json({
                success: false,
                message: "Bank details not found"
            });
        }

        /* =========================================================
           GET EMPLOYEE DATA
        ========================================================= */
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

        /* =========================================================
           USERNAME
        ========================================================= */
        const username =
            getUsername(
                personalData,
                existingData?.personal_details_id || id
            );

        const folderPath = username;

        /* =========================================================
           EDITED BY
        ========================================================= */
        const editedBy = req.headers["x-username"]?.trim() || "null";

        /* =========================================================
           OLD BANK PROOF
        ========================================================= */
        let bankProofUrl = existingData.bank_proof || null;

        /* =========================================================
           BANK PROOF
               
           Priority:
           1. File upload → Cloudinary URL
           2. URL from payload → Direct URL
           3. Existing URL
        ========================================================= */
        if (req.file?.buffer) {
            const result = await uploadToCloudinary(
                req.file.buffer,
                "BANK_PROOF",
                folderPath,
                req.file.mimetype
            );

            if (result?.secure_url) {
                bankProofUrl = result.secure_url;
            }

        } else if (
            req.body.bank_proof !== undefined &&
            req.body.bank_proof !== null &&
            String(req.body.bank_proof).trim() !== ""
        ) {
            bankProofUrl = String(req.body.bank_proof).trim();
        }

        /* =========================================================
           PREPARE NEW DATA
        ========================================================= */
        const newBankData = {
            bank_name:
                req.body.bank_name ??
                existingData.bank_name,

            account_holder_name:
                req.body.account_holder_name ??
                existingData.account_holder_name,

            account_number:
                req.body.account_number ??
                existingData.account_number,

            ifsc_code:
                req.body.ifsc_code ??
                existingData.ifsc_code,

            branch_name:
                req.body.branch_name ??
                existingData.branch_name,

            bank_proof:
                bankProofUrl
        };

        /* =========================================================
           FIND ONLY CHANGED FIELDS
        ========================================================= */
        const oldChangedValues = {};
        const newChangedValues = {};

        const fields = [
            "bank_name",
            "account_holder_name",
            "account_number",
            "ifsc_code",
            "branch_name",
            "bank_proof"
        ];

        for (const field of fields) {

            const oldValue =
                existingData?.[field] ?? null;

            const newValue =
                newBankData?.[field] ?? null;

            /* =====================================================
               NORMAL VALUE COMPARISON
            ===================================================== */
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

            /* =====================================================
               ONLY STORE CHANGED FIELD
            ===================================================== */
            if (oldCompare !== newCompare) {
                oldChangedValues[field] =
                    oldValue;

                newChangedValues[field] =
                    newValue;
            }
        }

        /* =========================================================
           UPDATE BANK DETAILS
        ========================================================= */
        const updated =
            await updateBankDetailsModel(
                id,
                newBankData
            );

        if (!updated) {
            return res.status(404).json({
                success: false,
                message: "Bank details not found"
            });
        }

        /* =========================================================
           CHECK WHETHER ANY FIELD CHANGED
        ========================================================= */
        const changedFields =
            Object.keys(oldChangedValues);

        const hasChanges =
            changedFields.length > 0;

        /* =========================================================
           EMPLOYEE EDIT LOG
           
           ONLY CHANGED FIELDS ARE STORED
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
                description:
                    `Bank details updated for ${personalData?.personal_details?.username ||
                    personalData?.username ||
                    username ||
                    existingData.personal_details_id
                    }. Changed fields: ${changedFields.join(", ")}`
            });
        }

        /* =========================================================
           SOCKET EMIT
        ========================================================= */
        const io = getIO();

        io.emit("employee:updated", {
            success: true,
            message: "update Bank details",
            data: updated
        });

        /* =========================================================
           RESPONSE
        ========================================================= */
        return res.status(200).json({
            success: true,
            message: "Bank details updated successfully",
            data: updated,
            employeeEditLog
        });

    } catch (error) {
        console.error(
            "UPDATE BANK DETAILS ERROR:",
            error
        );

        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};