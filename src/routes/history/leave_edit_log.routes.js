import express from "express";
import { getLeaveEditLog } from "../../controllers/history/leave_edit_log.controller.js";

const leave_edit_log = express.Router();

leave_edit_log.get("/", getLeaveEditLog);

export default leave_edit_log;
