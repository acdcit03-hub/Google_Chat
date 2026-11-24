import express from "express";
import { getOpenSessions } from "../../controllers/Attendance/open_sessions.controller.js";

const open_sessions = express.Router();

open_sessions.get("/open-sessions", getOpenSessions);

export default open_sessions;