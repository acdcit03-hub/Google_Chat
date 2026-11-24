import express from "express";
import { getMQTTMessages } from "../../controllers/Attendance/mqttMessages.controller.js";

const mqtt_messages = express.Router();

mqtt_messages.get("/all-mqtt-messages", getMQTTMessages);

export default mqtt_messages;