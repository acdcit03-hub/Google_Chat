import express from "express";
import {
    createCategory,
    getAllCategory,
    getEmployeeRequiredFieldNames,
    toggleCategoryStatus,
    updateCategory
} from "../../controllers/settings/category.controller.js";
import { upload } from "../../middleware/upload.js";

const category = express.Router();

category.post("/add-category", upload.single("category_image"), createCategory);

category.get("/all-category", getAllCategory);
category.get("/employee-required-field-names", getEmployeeRequiredFieldNames);

category.put("/update-category/:id", upload.single("category_image"), updateCategory);
category.patch("/toggle/:id", toggleCategoryStatus);

export default category;