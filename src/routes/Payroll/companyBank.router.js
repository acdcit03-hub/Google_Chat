
import express from "express";

import {
    addCompanyBank,
    deleteCompanyBank,
    getAllCompanyBanks,
    getCompanyBankById,
    toggleCompanyBankStatus,
    updateCompanyBank
} from "../../controllers/Payroll/companyBank.controller.js";

const companyBankDetails = express.Router();

companyBankDetails.post("/", addCompanyBank);

companyBankDetails.get("/", getAllCompanyBanks);
companyBankDetails.get("/:id", getCompanyBankById);

companyBankDetails.put("/:id", updateCompanyBank);

companyBankDetails.patch("/toggle/:id", toggleCompanyBankStatus);

companyBankDetails.delete("/:id", deleteCompanyBank);

export default companyBankDetails;
