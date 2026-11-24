import express from "express";
import {
    createLeave,
    getAllLeave,
    getLeaveById,
    getLeaveReasonUsage,
    toggleLeaveStatus,
    updateLeave
} from "../../controllers/settings/Leave.controller.js";

const leave = express.Router();

leave.post("/", createLeave);

leave.get("/", getAllLeave);
leave.get("/user-leave", getLeaveReasonUsage);
leave.get("/:id", getLeaveById);

leave.put("/:id", updateLeave);

leave.patch("/toggle/:id", toggleLeaveStatus);

export default leave;