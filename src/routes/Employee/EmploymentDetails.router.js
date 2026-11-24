import express from "express";
import { addEmploymentDetails, getAllEmploymentDetails, getEmploymentDetailsById, updateEmploymentDetails } from "../../controllers/Employee/EmploymentDetails.controller.js";
import { uploadImages } from "../../middleware/images.js";
import { sanitizeBody } from "../../middleware/sanitizeBody.middleware.js";

const employment_details = express.Router();

employment_details.post(
    "/add-employment-detail",
    uploadImages.any(),
    sanitizeBody,
    addEmploymentDetails
);

employment_details.get("/all-employment-detail", getAllEmploymentDetails);
employment_details.get("/all-employment-detail/:id", getEmploymentDetailsById);

employment_details.put(
    "/update-employment-detail/:id",
    uploadImages.any(),
    sanitizeBody,
    updateEmploymentDetails
);

export default employment_details;