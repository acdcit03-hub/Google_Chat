import express from "express";
import { addLocation, getAllLocation, toggleLocationStatus, updateLocation } from "../../controllers/settings/Location.controller.js";

const location = express.Router();

location.post("/add-location", addLocation);

location.get("/all-location", getAllLocation);

location.put("/update-location/:id", updateLocation);

location.patch("/toggle/:id", toggleLocationStatus);

export default location;