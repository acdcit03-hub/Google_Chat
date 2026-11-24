import express from "express";
import { downloadEmployeePayroll } from "../../controllers/Payroll/downloadPayroll.controller.js";

import {
    createEmployeePayroll,
    getAllEmployeePayrollConfig,
    getCurrentMonthExpiringPayrollConfigs,
    getEmployeePayrollConfigByUsername,
    updateEmployeePayrollConfig,
    deleteEmployeePayrollConfig,
    markPayrollGenerated,
    getEmployeePayrollConfigWithPayroll,
    getEmployeePayrollConfigStatCard,
    getPayrollDashboardStats
} from "../../controllers/Payroll/employee_payroll_config.controller.js";

const employee_payroll = express.Router();

employee_payroll.post("/", createEmployeePayroll);
employee_payroll.post("/generate", markPayrollGenerated);

employee_payroll.get("/download", downloadEmployeePayroll);
employee_payroll.get("/employee-payroll-config",getEmployeePayrollConfigWithPayroll);
employee_payroll.get("/employee-payroll-config-stat-card", getEmployeePayrollConfigStatCard);
employee_payroll.get("/payroll-dashboard-stats", getPayrollDashboardStats);
employee_payroll.get("/expiring-this-month", getCurrentMonthExpiringPayrollConfigs);
employee_payroll.get("/", getAllEmployeePayrollConfig);
employee_payroll.get("/:username", getEmployeePayrollConfigByUsername);

employee_payroll.put("/:id", updateEmployeePayrollConfig);

employee_payroll.delete("/:id", deleteEmployeePayrollConfig);

export default employee_payroll;