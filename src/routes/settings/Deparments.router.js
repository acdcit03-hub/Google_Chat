import express from "express";
import { addDepartment, getAllDepartments, toggleDepartmentStatus, updateDepartment } from "../../controllers/settings/Deparments.controller.js";

const department = express.Router();

department.post("/add-department", addDepartment);

department.get("/all-department", getAllDepartments);

department.put("/update-department/:id", updateDepartment);

department.patch("/toggle/:id", toggleDepartmentStatus);

export default department;