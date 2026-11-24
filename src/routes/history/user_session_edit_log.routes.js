import express from "express";
import {
    getUserSessionEditLog,
    getUserSessionOldData
} from "../../controllers/history/user_session_edit_log.controller.js";

const user_session_edit_log = express.Router();

user_session_edit_log.get("/user-data", getUserSessionOldData);
user_session_edit_log.get("/", getUserSessionEditLog);

export default user_session_edit_log;
