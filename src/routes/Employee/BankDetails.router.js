import express from "express";
import { addBankDetails, getAllBankDetails, getBankDetailsById, updateBankDetails } from "../../controllers/Employee/BankDetails.controller.js";
import { uploadImages } from "../../middleware/images.js";
import { sanitizeBody } from "../../middleware/sanitizeBody.middleware.js";

const bank_details = express.Router();

bank_details.post("/add-bank-detail", uploadImages.single("bank_proof"), sanitizeBody, addBankDetails);

bank_details.get("/all-bank-detail", getAllBankDetails);
bank_details.get("/all-bank-detail/:id", getBankDetailsById);

bank_details.put("/update-bank-detail/:id", uploadImages.single("bank_proof"), sanitizeBody, updateBankDetails);

export default bank_details;