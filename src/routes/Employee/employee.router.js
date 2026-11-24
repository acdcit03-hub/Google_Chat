import express from "express";
import { createEmployee } from "../../controllers/Employee/employee.controller.js";
import { getAllEmployees } from "../../controllers/Employee/MasterEmployee.controller.js";

const employeeRoutes = express.Router();

/* ================= CREATE ================= */
employeeRoutes.post("/", createEmployee);

/* ================= GET ALL ================= */
employeeRoutes.get("/", getAllEmployees);

export default employeeRoutes;