import express from "express";
import { getAttendanceSummary, getAttendanceSummaryByUsername } from "../../../controllers/Attendance/Summary/summary.controller.js";

const summary = express.Router();

summary.get("/all-summary", getAttendanceSummary);
summary.get("/username/:username", getAttendanceSummaryByUsername);

export default summary;