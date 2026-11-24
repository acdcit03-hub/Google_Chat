import express from "express";
import {
    downloadPayrollSettingsTxt,
    getPayrollSettings
} from "../../controllers/Payroll/payrollSettings.controller.js";

const payrollSettings = express.Router();

payrollSettings.post("/download-txt", downloadPayrollSettingsTxt);
payrollSettings.get("/", getPayrollSettings);

export default payrollSettings;