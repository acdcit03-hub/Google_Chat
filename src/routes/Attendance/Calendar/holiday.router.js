import express from "express";
import { createHoliday, deleteHoliday, getAllHolidays, getCalendar, getCalendarByUsername, getHolidayByUsername, getUpcomingHolidays, transferHoliday, updateHoliday } from "../../../controllers/Attendance/Calendar/holiday.controller.js";

const holiday = express.Router();

holiday.post("/add-holiday", createHoliday);

holiday.get("/all-holiday", getAllHolidays);
holiday.get("/calendar", getCalendar);
holiday.get( "/calendar/:username", getCalendarByUsername );
holiday.get("/username/:username", getHolidayByUsername);
holiday.get("/upcoming-holidays", getUpcomingHolidays);

holiday.put("/update-holiday/:id", updateHoliday);
holiday.put("/transfer-holiday/:id", transferHoliday);

holiday.delete("/delete-holiday/:id", deleteHoliday);

export default holiday;