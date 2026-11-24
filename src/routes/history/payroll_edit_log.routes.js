import express from "express";
import { getPayrollEditLog } from "../../controllers/history/payroll_edit_log.controller.js";

const payroll_edit_log = express.Router();

payroll_edit_log.get("/", getPayrollEditLog);

export default payroll_edit_log;
