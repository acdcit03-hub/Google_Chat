import express from "express";
import { getGlobalCalendarMonthly, getGlobalCalendarYearly } from "../../controllers/Calendar/GlobalCalendar.controller.js";

const globalCalendar = express.Router();

globalCalendar.get("/global-monthly", getGlobalCalendarMonthly);
globalCalendar.get("/global-yearly", getGlobalCalendarYearly);

export default globalCalendar;