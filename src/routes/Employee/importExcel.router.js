import express from "express";
import { importGoogleSheet } from "../../controllers/Employee/importExcel.controller.js";
import { uploadImages } from "../../middleware/images.js";

const ImportEmployee = express.Router();

ImportEmployee.post("/import-excel", uploadImages.single("file"), importGoogleSheet);

export default ImportEmployee;