import express from "express";

import {
    createJobPosition,
    getJobPosition,
    getJobPositionById,
    toggleJobPositionStatus,
    updateJobPosition
} from "../../controllers/JobPosition/jobPosition.controller.js";

const job_position = express.Router();

job_position.post("/add-job-position", createJobPosition);

job_position.get("/all-job-position", getJobPosition);
job_position.get("/all-job-position/:id", getJobPositionById);

job_position.put("/update-job-position/:id", updateJobPosition);

job_position.patch("/toggle/:id", toggleJobPositionStatus);

export default job_position;