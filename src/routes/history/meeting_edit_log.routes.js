import express from "express";
import { getMeetingEditLog } from "../../controllers/history/meeting_edit_log.controller.js";

const meeting_edit_log = express.Router();

meeting_edit_log.get("/", getMeetingEditLog);

export default meeting_edit_log;
