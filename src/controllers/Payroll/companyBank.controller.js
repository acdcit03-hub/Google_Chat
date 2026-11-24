
import {
    getAllCompanyBanksModel,
    getCompanyBankByIdModel,
    addCompanyBankModel,
    updateCompanyBankModel,
    deleteCompanyBankModel,
    toggleCompanyBankStatusModel
} from "../../models/Payroll/companyBank.model.js";

const getEditedBy = (req) =>
    req.headers["x-hrms-username"] ||
    req.headers["x-username"] ||
    "system";

const validateBankDetails = (body) => {
    const {
        company_bank_name,
        company_bank_account_no,
        primary_account
    } = body;

    if (
        typeof company_bank_name !== "string" ||
        !company_bank_name.trim() ||
        typeof company_bank_account_no !== "string" ||
        !company_bank_account_no.trim()
    ) {
        return "Company bank name and account number are required.";
    }

    if (
        primary_account !== undefined &&
        typeof primary_account !== "boolean"
    ) {
        return "primary_account must be true or false.";
    }

    return null;
};

/* ================= GET ALL COMPANY BANKS ================= */
export const getAllCompanyBanks = async (req, res) => {
    try {
        const banks = await getAllCompanyBanksModel();

        return res.status(200).json({
            success: true,
            count: banks.length,
            data: banks
        });
    } catch (error) {
        console.error("GET COMPANY BANKS ERROR:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to fetch company bank details."
        });
    }
};

/* ================= GET COMPANY BANK BY ID ================= */
export const getCompanyBankById = async (req, res) => {
    try {
        const id = Number(req.params.id);

        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({
                success: false,
                message: "Invalid company bank ID."
            });
        }

        const bank = await getCompanyBankByIdModel(id);

        if (!bank) {
            return res.status(404).json({
                success: false,
                message: "Company bank details not found."
            });
        }

        return res.status(200).json({
            success: true,
            data: bank
        });
    } catch (error) {
        console.error("GET COMPANY BANK ERROR:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to fetch company bank details."
        });
    }
};

/* ================= ADD COMPANY BANK ================= */
export const addCompanyBank = async (req, res) => {
    try {
        const error = validateBankDetails(req.body);

        if (error) {
            return res.status(400).json({
                success: false,
                message: error
            });
        }

        const bank = await addCompanyBankModel({
            company_bank_name: req.body.company_bank_name.trim(),
            company_bank_account_no: req.body.company_bank_account_no.trim(),
            primary_account: req.body.primary_account ?? false,
            created_by: getEditedBy(req)
        });

        return res.status(201).json({
            success: true,
            message: "Company bank added successfully.",
            data: bank
        });
    } catch (error) {
        console.error("ADD COMPANY BANK ERROR:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to add company bank details."
        });
    }
};

/* ================= UPDATE COMPANY BANK ================= */
export const updateCompanyBank = async (req, res) => {
    try {
        const id = Number(req.params.id);

        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({
                success: false,
                message: "Invalid company bank ID."
            });
        }

        const error = validateBankDetails(req.body);

        if (error) {
            return res.status(400).json({
                success: false,
                message: error
            });
        }

        const bank = await updateCompanyBankModel({
            id,
            company_bank_name: req.body.company_bank_name.trim(),
            company_bank_account_no: req.body.company_bank_account_no.trim(),
            primary_account: req.body.primary_account ?? false,
            updated_by: getEditedBy(req)
        });

        if (!bank) {
            return res.status(404).json({
                success: false,
                message: "Company bank details not found."
            });
        }

        return res.status(200).json({
            success: true,
            message: "Company bank details updated successfully.",
            data: bank
        });
    } catch (error) {
        console.error("UPDATE COMPANY BANK ERROR:", error);
    
        if (error.statusCode === 409) {
            return res.status(409).json({
                success: false,
                message: error.message
            });
        }
    
        return res.status(500).json({
            success: false,
            message: "Failed to update company bank details."
        });
    }
};

/* ================= DELETE COMPANY BANK ================= */
export const deleteCompanyBank = async (req, res) => {
    try {
        const id = Number(req.params.id);

        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({
                success: false,
                message: "Invalid company bank ID."
            });
        }

        const bank = await deleteCompanyBankModel(id);

        if (!bank) {
            return res.status(404).json({
                success: false,
                message: "Company bank details not found."
            });
        }

        return res.status(200).json({
            success: true,
            message: "Company bank deleted successfully.",
            data: bank
        });
    } catch (error) {
        console.error("DELETE COMPANY BANK ERROR:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to delete company bank details."
        });
    }
};

/* ================= TOGGLE COMPANY BANK STATUS ================= */
export const toggleCompanyBankStatus = async (req, res) => {
    try {
        const id = Number(req.params.id);

        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({
                success: false,
                message: "Invalid company bank ID."
            });
        }

        const bank = await toggleCompanyBankStatusModel({
            id,
            updated_by: getEditedBy(req)
        });

        if (!bank) {
            return res.status(404).json({
                success: false,
                message: "Company bank details not found."
            });
        }

        return res.status(200).json({
            success: true,
            message: bank.status
                ? "Company bank activated successfully."
                : "Company bank deactivated successfully.",
            data: bank
        });
    } catch (error) {
        console.error("TOGGLE COMPANY BANK STATUS ERROR:", error);

        if (error.statusCode === 409) {
            return res.status(409).json({
                success: false,
                message: error.message,
                active_bank: error.activeBank
            });
        }

        return res.status(500).json({
            success: false,
            message: "Failed to toggle company bank status."
        });
    }
};