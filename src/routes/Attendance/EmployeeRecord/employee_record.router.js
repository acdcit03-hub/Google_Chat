import express from "express";
import { getEmployeeAttendanceRecord, getEmployeeAttendanceRecordByUsername, getYearlyAttendanceSummary } from "../../../controllers/Attendance/EmployeeRecord/employee_record.controller.js";

const employee_record = express.Router();

employee_record.get("/all-employee-record", getEmployeeAttendanceRecord);
employee_record.get("/all-employee-yearly-record", getYearlyAttendanceSummary);
employee_record.get("/username/:username", getEmployeeAttendanceRecordByUsername);

export default employee_record;