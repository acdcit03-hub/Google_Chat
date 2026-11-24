import express from "express";
import { addDeviceConfiguration, getAllDeviceConfigurations, openDeviceDetails, toggleDeviceConfigurationStatus, updateDeviceConfiguration } from "../../controllers/settings/DeviceConfiguration.controller.js";

const device_configurations = express.Router();

device_configurations.post("/add-device-configuration", addDeviceConfiguration);

device_configurations.get("/all-device-configuration", getAllDeviceConfigurations);
device_configurations.get("/open-mac-address/:mac_id", openDeviceDetails);

device_configurations.put("/update-device-configuration/:id", updateDeviceConfiguration);

device_configurations.patch("/toggle/:id", toggleDeviceConfigurationStatus);

export default device_configurations;