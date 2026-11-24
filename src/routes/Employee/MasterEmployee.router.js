import express from "express";
import { getAllEmployees, getMasterEmployeeByPersonalId, updateEmployeeStatus } from "../../controllers/Employee/MasterEmployee.controller.js";
import { sanitizeBody } from "../../middleware/sanitizeBody.middleware.js";

const master_employee = express.Router();

master_employee.get("/employees", sanitizeBody, getAllEmployees);
master_employee.get("/employees/:personal_details_id", getMasterEmployeeByPersonalId);

master_employee.put("/employees/status/:personal_details_id", sanitizeBody, updateEmployeeStatus);

export default master_employee;