import express from "express";
import { addWorkExperience, deleteWorkExperience, getAllWorkExperience, getWorkExperienceById, updateWorkExperience } from "../../controllers/Employee/WorkExperience.controller.js";
import { uploadImages } from "../../middleware/images.js";
import { sanitizeBody } from "../../middleware/sanitizeBody.middleware.js";

const work_exprience = express.Router();

work_exprience.post("/add-work-exprience", uploadImages.single("experience_letter"), sanitizeBody, addWorkExperience);

work_exprience.get("/all-work-exprience", getAllWorkExperience);
work_exprience.get("/all-work-exprience/:id", getWorkExperienceById);

work_exprience.put("/update-work-exprience/:id", uploadImages.single("experience_letter"), sanitizeBody, updateWorkExperience);

work_exprience.delete("/delete-work-exprience/:id", deleteWorkExperience);

export default work_exprience;