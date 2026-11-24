import express from "express";
import { addSettingEditLog, getSettingEditLog } from "../../controllers/history/setting_edit_log.controller.js";

const setting_edit_log = express.Router();

/* ================= ADD ================= */
setting_edit_log.post("/add", addSettingEditLog);

/* ================= GET ================= */
setting_edit_log.get("/", getSettingEditLog);

export default setting_edit_log;