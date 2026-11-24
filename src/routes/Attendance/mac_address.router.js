import express from "express";
import { getUnregisteredMacs } from "../../controllers/Attendance/mac_address.controller.js";

const mac_address = express.Router();

mac_address.get("/mac-unregistered", getUnregisteredMacs);       // show unregistered mac_id

export default mac_address;