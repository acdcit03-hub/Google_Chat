import express from "express";
import {
    downloadOfferLetter,
    downloadOfferLetterFromContent,
    getEmployeeFieldNames,
    getOfferLetterFormat,
    getOfferLetterFormatHistory,
    updateOfferLetterTemplate
} from "../../controllers/Employee/offerLetterFormat.controller.js";

const router = express.Router();

router.put("/", updateOfferLetterTemplate);

router.get("/download", downloadOfferLetter);
router.post("/download-letter", downloadOfferLetterFromContent);
router.get("/", getOfferLetterFormat);
router.get("/history", getOfferLetterFormatHistory);
router.get("/employee-field-names", getEmployeeFieldNames);

export default router;
