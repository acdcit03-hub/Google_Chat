import express from "express";
import { addLeave, deleteLeave, getLeaveCalendar, getLeaves, getLeaveStatusCounts, getPendingLeaveCount, getTodayLeave, getUpcomingLeaves, updateLeave } from "../../../controllers/Attendance/EmployeeRecord/EmployeeLeaves.controller.js";
import { getLeaveById } from "../../../controllers/settings/Leave.controller.js";
import { uploadImages } from "../../../middleware/images.js";

const employee_leave = express.Router();

employee_leave.post("/add-leave", uploadImages.single("document"), addLeave);

employee_leave.get("/all-leave", getLeaves);
employee_leave.get("/leave/:id", getLeaveById);
employee_leave.get("/calendar", getLeaveCalendar);
employee_leave.get("/today-leave", getTodayLeave);
employee_leave.get("/upcoming", getUpcomingLeaves);
employee_leave.get("/status-counts", getLeaveStatusCounts);
employee_leave.get("/pending-leave-count", getPendingLeaveCount);

employee_leave.put("/update-leave/:id", uploadImages.single("document"), updateLeave);

employee_leave.delete("/delete-leave/:id", deleteLeave);

export default employee_leave;