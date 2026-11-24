import express from "express";
import { addShift, getAllShifts, toggleShiftStatus, updateShift } from "../../controllers/settings/ShiftConfigurations.controller.js";

const shift_configurations = express.Router();

shift_configurations.post("/add-shift", addShift);

shift_configurations.get("/all-shift", getAllShifts);

shift_configurations.put("/update-shift/:id", updateShift);

shift_configurations.patch("/toggle/:id", toggleShiftStatus);

export default shift_configurations;