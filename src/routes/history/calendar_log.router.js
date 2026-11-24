import express from "express";
import { getCalendarEditLogs } from "../../controllers/history/calendar_log.controller.js";
const calendar_log = express.Router();

/* ================= GET ALL LOGS ================= */
calendar_log.get("/", getCalendarEditLogs);

export default calendar_log;