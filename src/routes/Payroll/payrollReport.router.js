import express from "express";
import {
    getCompanyPayrollReport,
    getFinancialYearSalaryReport,
    getPayrollIncrementReport,
    getPayrollSalaryReport
} from "../../controllers/Payroll/payrollReport.controller.js";

const payrollReport = express.Router();

payrollReport.get("/employee-salary-report", getPayrollSalaryReport);
payrollReport.get("/employee-increment-report", getPayrollIncrementReport);
payrollReport.get("/company-salary-report", getCompanyPayrollReport);
payrollReport.get("/financial-year-salary-report", getFinancialYearSalaryReport);

export default payrollReport;
