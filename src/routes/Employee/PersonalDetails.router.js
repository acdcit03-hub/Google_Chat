import express from "express";
import { addPersonalDetails, getAllEmployeeCompleteData, getAllPersonalDetails, getBasicPersonalDetails, getMonthlyBirthdayAnniversary, getPersonalDetailsById, getPersonalDetailsPermissions, updatePersonalDetails } from "../../controllers/Employee/PersonalDetails.controller.js";
import { uploadImages } from "../../middleware/images.js";
import { sanitizeBody } from "../../middleware/sanitizeBody.middleware.js";

const personal_details = express.Router();

personal_details.post("/add-personal-detail", uploadImages.fields([
    { name: "image", maxCount: 1 },
    { name: "resume", maxCount: 1 }
]), sanitizeBody, addPersonalDetails);

personal_details.get("/all-personal-detail", getAllPersonalDetails);
personal_details.get("/employee-complete-data", getAllEmployeeCompleteData);    // get all employee table data
personal_details.get("/all-personal-detail/:id", getPersonalDetailsById);
personal_details.get("/basic-personal-detail", getBasicPersonalDetails);
personal_details.get("/personal-details-permissions", getPersonalDetailsPermissions);
personal_details.get("/birthday-anniversary-list", getMonthlyBirthdayAnniversary);

personal_details.put("/update-personal-detail/:id", uploadImages.fields([
    { name: "image", maxCount: 1 },
    { name: "resume", maxCount: 1 }
]), sanitizeBody, updatePersonalDetails);

export default personal_details;