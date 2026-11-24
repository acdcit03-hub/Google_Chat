import express from "express";

import {
    getLeavePrior,
    updatePriorDays
} from "../../controllers/settings/Leave_prior.controller.js";

const leave_prior = express.Router();


leave_prior.get("/", getLeavePrior);

leave_prior.patch("/:id", updatePriorDays);


export default leave_prior;