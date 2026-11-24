import express from "express";

import {
    createEducation,
    getAllEducation,
    updateEducation,
    toggleEducationStatus
} from "../../controllers/settings/education.controller.js";

const education = express.Router();

education.post("/add-education", createEducation);

education.get("/all-education", getAllEducation);

education.put("/update-education/:id", updateEducation);

education.patch("/toggle/:id", toggleEducationStatus);

export default education;