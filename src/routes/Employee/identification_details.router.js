import express from "express";
import { addIdentificationDetails, getAllIdentificationDetails, getIdentificationDetailsById, updateIdentificationDetails } from "../../controllers/Employee/IdentificationDetails.controller.js";
import { uploadImages } from "../../middleware/images.js";
import { sanitizeBody } from "../../middleware/sanitizeBody.middleware.js";

const identification_details = express.Router();

identification_details.post("/add-identification-detail", uploadImages.fields([
        { name: "pan_card_upload", maxCount: 1 },
        { name: "aadhaar_upload", maxCount: 1 },
        { name: "other_document_upload", maxCount: 1 }
    ]), sanitizeBody, addIdentificationDetails);

identification_details.get("/all-identification-detail", getAllIdentificationDetails);
identification_details.get("/all-identification-detail/:id", getIdentificationDetailsById);

identification_details.put("/update-identification-detail/:id", uploadImages.fields([
        { name: "pan_card_upload", maxCount: 1 },
        { name: "aadhaar_upload", maxCount: 1 },
        { name: "other_document_upload", maxCount: 1 }
    ]), sanitizeBody, updateIdentificationDetails);

export default identification_details;