import express from "express";
import { getMaintenance, saveMaintenance } from "../../controllers/Maintenance/Maintenance.controller.js";

const maintenance = express.Router();

maintenance.get("/",getMaintenance);

maintenance.post("/",saveMaintenance);

export default maintenance;