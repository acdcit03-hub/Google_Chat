import express from "express";
import { downloadAttendanceByUsername } from "../../controllers/Download/downloadAttendance.controller.js";
const download_attendance = express.Router();

/* ================= GET ALL LOGS ================= */
download_attendance.get("/attendance", downloadAttendanceByUsername);

export default download_attendance;