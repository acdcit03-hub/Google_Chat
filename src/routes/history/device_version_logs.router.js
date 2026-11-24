import express from "express";
import { getDeviceVersionLogs } from "../../controllers/history/device_version_logs.controller.js";
const device_version_log = express.Router();

/* ================= GET ALL LOGS ================= */
device_version_log.get("/", getDeviceVersionLogs);

export default device_version_log;