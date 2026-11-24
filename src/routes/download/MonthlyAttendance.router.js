import express from "express";
import { getActiveEmployeeMonthlyAttendance } from "../../controllers/Download/MonthlyAttendance.controller.js";
const download_employee_attendance = express.Router();

/* ================= GET ALL LOGS ================= */
download_employee_attendance.get("/attendance", getActiveEmployeeMonthlyAttendance);

export default download_employee_attendance;