import express from "express";
import { addEducationalQualifications, deleteEducationalQualifications, getAllEducationalQualifications, getEducationalQualificationsById, updateEducationalQualifications } from "../../controllers/Employee/EducationalQualifications.controller.js";
import { uploadImages } from "../../middleware/images.js";
import { sanitizeBody } from "../../middleware/sanitizeBody.middleware.js";

const educational_qualifications = express.Router();

educational_qualifications.post("/add-educational-qualification", uploadImages.single("marksheet_certificate_upload"), sanitizeBody, addEducationalQualifications);

educational_qualifications.get("/all-educational-qualification", getAllEducationalQualifications);
educational_qualifications.get("/all-educational-qualification/:id", getEducationalQualificationsById);

educational_qualifications.put("/update-educational-qualification/:id", uploadImages.single("marksheet_certificate_upload"), sanitizeBody, updateEducationalQualifications);

educational_qualifications.delete("/delete-educational-qualification/:id", deleteEducationalQualifications);

export default educational_qualifications;