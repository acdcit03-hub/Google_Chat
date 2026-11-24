import express from "express";
import { getAttendanceLogById, getAttendanceLogs } from "../../controllers/history/attendance_logs.controller.js";
const attendance_log = express.Router();

/* ================= GET ALL LOGS ================= */
attendance_log.get("/", getAttendanceLogs);

/* ================= GET LOG BY ID ================= */
attendance_log.get("/:id", getAttendanceLogById);

export default attendance_log;