import express from "express";

import {
    createMeetingSchedule,
    deleteMeetingSchedule,
    getMeetingSchedule,
    getMeetingScheduleById,
    getLatestMeeting,
    updateMeetingSchedule
} from "../../controllers/MeetingSchedule/meetingSchedule.controller.js";

const meetingSchedule = express.Router();

meetingSchedule.post("/add-meeting-schedule", createMeetingSchedule);

meetingSchedule.get("/all-meeting-schedule", getMeetingSchedule);

meetingSchedule.get("/latest-meeting", getLatestMeeting);

meetingSchedule.get("/all-meeting-schedule/:id", getMeetingScheduleById);

meetingSchedule.put("/update-meeting-schedule/:id", updateMeetingSchedule);

meetingSchedule.delete("/delete-meeting-schedule/:id", deleteMeetingSchedule);

export default meetingSchedule;
