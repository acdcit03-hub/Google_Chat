import express from "express";
import { addSalary, getAllSalary, getSalaryById, updateSalary } from "../../controllers/Employee/SalaryDetails.controller.js";
import { sanitizeBody } from "../../middleware/sanitizeBody.middleware.js";

const salary_details = express.Router();

salary_details.post("/add-salary", sanitizeBody, addSalary);

salary_details.get("/all-salary", getAllSalary);
salary_details.get("/all-salary/:id", getSalaryById);

salary_details.put("/update-salary/:id", sanitizeBody, updateSalary);

export default salary_details;