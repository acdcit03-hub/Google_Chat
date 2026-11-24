import express from "express";
import { 
    createStatus,
    getStatus,
    getStatusById,
    toggleStatus,
    updateStatus
} from "../../controllers/status/status.controller.js";

const status = express.Router();

status.post("/add-status", createStatus);

status.get("/all-status", getStatus);

status.get("/all-status/:id", getStatusById);

status.put("/update-status/:id", updateStatus);

status.patch("/toggle/:id", toggleStatus);

export default status;
