import express from "express";
import { getEmployeeEditLog } from "../../controllers/history/employee_edit_log.controller.js";
const employee_log = express.Router();

/* ================= GET ALL LOGS ================= */
employee_log.get("/", getEmployeeEditLog);

export default employee_log;