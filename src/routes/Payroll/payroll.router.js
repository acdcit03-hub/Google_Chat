import express from "express";
import {
    getPayrollStatusDetails,
    getPayrollEmployees,
    getPayrollSalaryStats,
    updatePayrollStatus
} from "../../controllers/Payroll/payroll.controller.js";
import { getMonthlyEmployeeAttendanceReportController } from "../../controllers/Payroll/monthlyEmployeeReport.controller.js";

const payroll = express.Router();

payroll.get("/salary-stats", getPayrollSalaryStats);
payroll.get("/employees", getPayrollEmployees);
payroll.get("/payroll-status-details", getPayrollStatusDetails);


payroll.get(
    "/monthly-employee-report",
    getMonthlyEmployeeAttendanceReportController
);

payroll.patch("/status/:id", updatePayrollStatus);
payroll.patch("/payroll-status/:id", updatePayrollStatus);

export default payroll;
