import express from "express";

import {
    createEmployeeMeeting,
    getEmployeeMeetings,
    getEmployeeMeetingById,
    updateEmployeeMeeting,
    deleteEmployeeMeeting
} from "../../controllers/MeetingSchedule/employeeMeeting.controller.js";

const employee_meeting = express.Router();

employee_meeting.post("/", createEmployeeMeeting);

employee_meeting.get("/", getEmployeeMeetings);
employee_meeting.get("/:id", getEmployeeMeetingById);

employee_meeting.put("/:id", updateEmployeeMeeting);

employee_meeting.delete("/:id", deleteEmployeeMeeting);


export default employee_meeting;