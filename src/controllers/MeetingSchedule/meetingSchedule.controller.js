import { pool } from "../../database.js";
import {
    createMeetingScheduleModel,
    getMeetingScheduleModel,
    getMeetingScheduleByIdModel,
    getLatestMeetingModel,
    updateMeetingScheduleModel,
    deleteMeetingScheduleModel
} from "../../models/MeetingSchedule/meetingSchedule.models.js";
import { addMeetingEditLogModel } from "../../models/history/meeting_edit_log.model.js";
import ReadNotificationModel from "../../models/r2r/receiveIssueResponse.model.js";
import { emitDesktopNotification } from "../../utils/notification/r2rDesktopNotify.js";

const toLogValue = (value) => {
    if (value === null || value === undefined) return null;
    if (typeof value === "object") return JSON.stringify(value);
    const text = String(value).trim();
    return text === "" ? null : text;
};

const valuesDiffer = (oldValue, newValue) =>
    String(oldValue ?? "") !== String(newValue ?? "");

const splitUsernames = (value) =>
    String(value || "")
        .split(",")
        .map((username) => username.trim())
        .filter(Boolean);

/* =========================================================
   CREATE MEETING
========================================================= */
export const createMeetingSchedule = async (req, res) => {
    try {
        const {
            candidate_id,
            schedule_date,
            start_time,
            end_time,
            candidate_person_name,
            scheduled_person_name,
            conduct_person_name,
            meeting_status,
            cancelled_meeting_id,
            meeting_type,
            meeting_mode,
            note,
            resume,
            work_location
        } = req.body;

        const candidatePersonName =
            candidate_person_name ||
            scheduled_person_name;

        const conductPersonNames = splitUsernames(conduct_person_name);

        /* =====================================================
           REQUIRED FIELD VALIDATION
        ===================================================== */
        if (!schedule_date) {
            return res.status(400).json({
                success: false,
                message: "Schedule date is required"
            });
        }

        if (!start_time || !end_time) {
            return res.status(400).json({
                success: false,
                message: "Start time and end time are required"
            });
        }

        if (start_time >= end_time) {
            return res.status(400).json({
                success: false,
                message: "End time must be greater than start time"
            });
        }

        if (
            !candidatePersonName ||
            String(candidatePersonName).trim() === ""
        ) {
            return res.status(400).json({
                success: false,
                message: "Scheduled person name is required"
            });
        }

        if (conductPersonNames.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Conduct person name is required"
            });
        }

        /* =====================================================
           CANCELLED / PREVIOUS MEETING ID
           
           IMPORTANT:
           This must be the CURRENT meeting ID being
           cancelled/rescheduled.
           
           Example:
           Meeting 1 → Meeting 5
           Meeting 5 → Meeting 8
        ===================================================== */
        let cancelledMeetingId = null;
        if (
            cancelled_meeting_id !== null &&
            cancelled_meeting_id !== undefined &&
            String(cancelled_meeting_id).trim() !== ""
        ) {
            cancelledMeetingId = Number(cancelled_meeting_id);

            if (
                !Number.isInteger(cancelledMeetingId) ||
                cancelledMeetingId <= 0
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid cancelled meeting ID"
                });
            }

            /* =================================================
               CHECK PREVIOUS MEETING EXISTS
            ================================================= */
            const previousMeetingResult =
                await pool.query(
                    `
                        SELECT
                            id,
                            meeting_status
                        FROM meeting_schedule
                        WHERE id = $1
                        LIMIT 1
                    `,
                    [cancelledMeetingId]
                );

            if (
                previousMeetingResult.rows.length === 0
            ) {
                return res.status(404).json({
                    success: false,
                    message: "Previous meeting not found"
                });
            }
        }

        /* =====================================================
           GET WORK LOCATION ID
        ===================================================== */
        let workLocationId = null;

        if (
            work_location !== null &&
            work_location !== undefined &&
            String(work_location).trim() !== ""
        ) {
            if (
                !isNaN(Number(work_location))
            ) {
                const locationResult =
                    await pool.query(
                        `
                            SELECT id
                            FROM work_location
                            WHERE id = $1
                            LIMIT 1
                        `,
                        [Number(work_location)]
                    );

                if (
                    locationResult.rows.length === 0
                ) {
                    return res.status(404).json({
                        success: false,
                        message: "Work location not found"
                    });
                }

                workLocationId = locationResult.rows[0].id;

            } else {
                const locationResult =
                    await pool.query(
                        `
                            SELECT id
                            FROM work_location
                            WHERE LOWER(TRIM(location))
                                =
                                LOWER(TRIM($1))
                        LIMIT 1
                        `,
                        [String(work_location).trim()]
                    );

                if (
                    locationResult.rows.length === 0
                ) {
                    return res.status(404).json({
                        success: false,
                        message: `Work location "${work_location}" not found`
                    });
                }

                workLocationId = locationResult.rows[0].id;
            }
        }

        /* =====================================================
           CREATED BY
        ===================================================== */
        const created_by = req.headers["x-username"] || null;

        /* =====================================================
           CREATE NEW MEETING
        ===================================================== */
        const data = await createMeetingScheduleModel({
            candidate_id:
                candidate_id
                    ? Number(candidate_id)
                    : null,

            schedule_date,
            start_time,
            end_time,
            scheduled_person_name: String(candidatePersonName).trim(),
            conduct_person_name: conductPersonNames.join(", "),
            meeting_status,
            cancelled_meeting_id: cancelledMeetingId,
            meeting_type: meeting_type || null,
            meeting_mode:
                meeting_mode == null || String(meeting_mode).trim() === ""
                    ? null
                    : String(meeting_mode).trim(),
            note: note || null,
            resume: resume || null,
            work_location: workLocationId,
            created_by
        });

        /* =====================================================
           NOTIFICATIONS
        ===================================================== */
        const notificationRecipients = new Map();

        for (const value of [
            candidatePersonName,
            ...conductPersonNames
        ]) {
            const username = String(value || "").trim();
            if (
                username &&
                !notificationRecipients.has(
                    username.toLowerCase()
                )
            ) {
                notificationRecipients.set(
                    username.toLowerCase(),
                    username
                );
            }
        }

        for (
            const recipientUsername
            of notificationRecipients.values()
        ) {
            try {
                const notification = await ReadNotificationModel.create({
                    notification_type: "meeting-scheduled",

                    sender_username:
                        String(
                            created_by || "system"
                        ).trim(),

                    receive_username: recipientUsername,
                    page_name: "Meeting Schedule",
                    title: "Meeting scheduled",
                    message: `Meeting scheduled on ${schedule_date} from ${start_time} to ${end_time}`,
                    meta: JSON.stringify({
                        meeting_id: data.id,
                        cancelled_meeting_id: data.cancelled_meeting_id,
                        schedule_date,
                        start_time,
                        end_time,
                        work_location: workLocationId
                    })
                });

                emitDesktopNotification({
                    username: recipientUsername,
                    type: "meeting-scheduled",
                    title: "Meeting scheduled",
                    message: `Meeting scheduled on ${schedule_date} from ${start_time} to ${end_time}`,
                    href: "/meeting-schedule",
                    notification
                });

            } catch (notificationError) {
                console.error("CREATE MEETING NOTIFICATION ERROR:", notificationError);
            }
        }

        /* =====================================================
           RESPONSE
        ===================================================== */
        return res.status(201).json({
            success: true,
            message: "Meeting scheduled successfully",
            data
        });

    } catch (error) {
        console.error("CREATE MEETING SCHEDULE ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to schedule meeting",
            error: error.message
        });
    }
};

/* =========================================================
   GET ALL MEETINGS
========================================================= */
export const getMeetingSchedule = async (req, res) => {
    try {
        const {
            schedule_date,
            scheduled_person_name,
            conduct_person_name,
            work_location
        } = req.query;

        const data = await getMeetingScheduleModel({
            schedule_date,
            scheduled_person_name,
            conduct_person_name,
            work_location
        });

        return res.status(200).json({
            success: true,
            count: data.length,
            data
        });

    } catch (error) {
        console.error("GET MEETING SCHEDULE ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to get meeting schedule",
            error: error.message
        });
    }
};

/* =========================================================
   GET MEETING BY ID
========================================================= */
export const getMeetingScheduleById = async (req, res) => {
    try {
        const { id } = req.params;

        if (
            !Number.isInteger(Number(id)) ||
            Number(id) <= 0
        ) {
            return res.status(400).json({
                success: false,
                message: "Valid meeting ID is required"
            });
        }

        const data = await getMeetingScheduleByIdModel(
            Number(id)
        );

        if (!data) {
            return res.status(404).json({
                success: false,
                message: "Meeting schedule not found"
            });
        }

        return res.status(200).json({
            success: true,
            data
        });
    } catch (error) {
        console.error("GET MEETING BY ID ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to get meeting schedule",
            error: error.message
        });
    }
};

/* =========================================================
   GET LATEST MEETING (per candidate_id)
========================================================= */
export const getLatestMeeting = async (req, res) => {
    try {
        const latest_meeting = await getLatestMeetingModel();

        return res.status(200).json({
            success: true,
            message: "Latest meeting per candidate fetched successfully",
            count: latest_meeting.length,
            latest_meeting
        });
    } catch (error) {
        console.error("GET LATEST MEETING ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to get latest meeting",
            error: error.message
        });
    }
};

/* =========================================================
   UPDATE MEETING
========================================================= */
export const updateMeetingSchedule = async (req, res) => {
    try {
        const { id } = req.params;

        const {
            candidate_id,
            schedule_date,
            start_time,
            end_time,
            scheduled_person_name,
            conduct_person_name,
            meeting_status,
            meeting_cancelled_reason,
            cancelled_meeting_id,
            meeting_type,
            meeting_mode,
            note = null,
            resume = null,
            work_location = null,
            candidate_status
        } = req.body;

        /* =====================================================
           TIME VALIDATION
        ===================================================== */
        if (start_time >= end_time) {
            return res.status(400).json({
                success: false,
                message: "End time must be greater than start time"
            });
        }

        /* =====================================================
           OLD MEETING (FOR EDIT LOG)
        ===================================================== */
        const oldMeeting = await getMeetingScheduleByIdModel(id);

        if (!oldMeeting) {
            return res.status(404).json({
                success: false,
                message: "Meeting schedule not found"
            });
        }

        /* =====================================================
           WORK LOCATION NAME → ID
        ===================================================== */
        let workLocationId = null;
        const workLocationProvided =
            work_location !== null &&
            work_location !== undefined &&
            String(work_location).trim() !== "";

        if (workLocationProvided) {
            // If frontend sends ID
            if (!isNaN(Number(work_location))) {

                const locationResult = await pool.query(
                    `
                        SELECT id
                        FROM work_location
                        WHERE id = $1
                        LIMIT 1
                    `,
                    [Number(work_location)]
                );

                if (locationResult.rows.length === 0) {
                    return res.status(404).json({
                        success: false,
                        message: "Work location not found"
                    });
                }

                workLocationId = locationResult.rows[0].id;

            } else {
                // If frontend sends location name
                const locationResult = await pool.query(
                    `
                        SELECT id
                        FROM work_location
                        WHERE LOWER(TRIM(location))
                            =
                            LOWER(TRIM($1))
                        LIMIT 1
                    `,
                    [work_location]
                );

                if (locationResult.rows.length === 0) {
                    return res.status(404).json({
                        success: false,
                        message: `Work location "${work_location}" not found`
                    });
                }

                workLocationId = locationResult.rows[0].id;
            }
        }

        /* =====================================================
           CANDIDATE + STATUS (VALIDATE BEFORE UPDATE)
        ===================================================== */
        const linkedCandidateId =
            candidate_id !== undefined &&
                candidate_id !== null &&
                String(candidate_id).trim() !== ""
                ? Number(candidate_id)
                : oldMeeting.candidate_id || null;

        let candidateRow = null;
        let savedCandidateStatusName = null;

        if (linkedCandidateId) {
            const candidateResult = await pool.query(
                `
                    SELECT
                        id,
                        username,
                        first_name,
                        middle_name,
                        last_name,
                        candidate_status
                    FROM candidate
                    WHERE id = $1
                    LIMIT 1
                `,
                [Number(linkedCandidateId)]
            );
            candidateRow = candidateResult.rows[0] || null;

            if (!candidateRow) {
                return res.status(404).json({
                    success: false,
                    message: "Candidate not found for this meeting"
                });
            }
        }

        if (
            candidate_status !== undefined &&
            candidate_status !== null &&
            String(candidate_status).trim() !== ""
        ) {
            if (!candidateRow) {
                return res.status(400).json({
                    success: false,
                    message: "candidate_id is required to update candidate_status"
                });
            }

            const statusExists = await pool.query(
                `
                    SELECT status_name
                    FROM status
                    WHERE LOWER(TRIM(status_name)) =
                          LOWER(TRIM($1))
                      AND COALESCE(status, TRUE) = TRUE
                    LIMIT 1
                `,
                [String(candidate_status).trim()]
            );

            if (statusExists.rows.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: `Candidate status "${String(candidate_status).trim()}" not found`
                });
            }

            savedCandidateStatusName = statusExists.rows[0].status_name;
        }

        /* =====================================================
           UPDATE
        ===================================================== */
        const updatedMeeting = await updateMeetingScheduleModel(
            id,
            {
                candidate_id,
                schedule_date,
                start_time,
                end_time,
                scheduled_person_name,
                conduct_person_name,
                meeting_status,
                meeting_cancelled_reason,
                cancelled_meeting_id,
                meeting_type,
                meeting_mode:
                    meeting_mode === undefined
                        ? null
                        : meeting_mode == null ||
                          String(meeting_mode).trim() === ""
                            ? null
                            : String(meeting_mode).trim(),
                note,
                resume,
                work_location: workLocationProvided ? workLocationId : null
            }
        );

        if (!updatedMeeting) {
            return res.status(404).json({
                success: false,
                message: "Meeting schedule not found"
            });
        }

        /* =====================================================
           MEETING EDIT LOG + CANDIDATE STATUS SAVE
        ===================================================== */
        const editedBy = String(
            req.headers["x-username"] || "system"
        ).trim();

        const logUsername =
            candidateRow?.username ||
            updatedMeeting.scheduled_person_name ||
            oldMeeting.scheduled_person_name ||
            null;

        /* Candidate form par edit time e je status hato
           (Hired / First Meeting / Telephone ...) e log ma save */
        const logCandidateStatus = toLogValue(
            candidateRow?.candidate_status
        );

        const meetingFieldsToLog = [
            "candidate_id",
            "schedule_date",
            "start_time",
            "end_time",
            "scheduled_person_name",
            "conduct_person_name",
            "meeting_status",
            "meeting_cancelled_reason",
            "cancelled_meeting_id",
            "meeting_type",
            "meeting_mode",
            "note",
            "resume",
            "work_location"
        ];

        for (const field of meetingFieldsToLog) {
            const oldValue = toLogValue(oldMeeting[field]);
            const newValue = toLogValue(updatedMeeting[field]);

            if (!valuesDiffer(oldValue, newValue)) {
                continue;
            }

            try {
                await addMeetingEditLogModel({
                    record_id: Number(updatedMeeting.id),
                    username: logUsername,
                    edited_by: editedBy,
                    field_name: field,
                    candidate_status: logCandidateStatus,
                    old_value: oldValue,
                    new_value: newValue
                });
            } catch (logError) {
                console.error("MEETING EDIT LOG ERROR:", logError);
            }
        }

        /* Candidate status: meeting edit thay tyare candidate
           no status kai mathi kai ma update thayu te save */
        if (candidateRow && savedCandidateStatusName) {
            const oldCandidateStatus = toLogValue(
                candidateRow.candidate_status
            );

            if (valuesDiffer(oldCandidateStatus, savedCandidateStatusName)) {
                await pool.query(
                    `
                        UPDATE candidate
                        SET
                            candidate_status = $1,
                            updated_at = TIMEZONE(
                                'Asia/Kolkata',
                                CURRENT_TIMESTAMP
                            )
                        WHERE id = $2
                    `,
                    [savedCandidateStatusName, candidateRow.id]
                );

                try {
                    await addMeetingEditLogModel({
                        record_id: Number(updatedMeeting.id),
                        username: logUsername,
                        edited_by: editedBy,
                        field_name: "candidate_status",
                        candidate_status: oldCandidateStatus,
                        old_value: oldCandidateStatus,
                        new_value: savedCandidateStatusName
                    });
                } catch (logError) {
                    console.error("MEETING CANDIDATE STATUS LOG ERROR:", logError);
                }
            }

            updatedMeeting.candidate_status = savedCandidateStatusName;
        } else if (candidateRow) {
            updatedMeeting.candidate_status = candidateRow.candidate_status;
        }

        const notificationRecipients = new Map();

        for (const value of [
            updatedMeeting.scheduled_person_name,
            ...splitUsernames(updatedMeeting.conduct_person_name)
        ]) {
            const username = String(value || "").trim();
            if (
                username &&
                !notificationRecipients.has(username.toLowerCase())
            ) {
                notificationRecipients.set(
                    username.toLowerCase(),
                    username
                );
            }
        }

        const senderUsername = String(
            req.headers["x-username"] || "system"
        ).trim();

        for (const recipientUsername of notificationRecipients.values()) {
            try {
                const notification = await ReadNotificationModel.create({
                    notification_type: "meeting-updated",
                    sender_username: senderUsername,
                    receive_username: recipientUsername,
                    page_name: "Meeting Schedule",
                    title: "Meeting schedule updated",
                    message: `Meeting schedule updated for ${updatedMeeting.schedule_date} from ${updatedMeeting.start_time} to ${updatedMeeting.end_time}`,
                    meta: JSON.stringify({
                        meeting_id: updatedMeeting.id,
                        schedule_date: updatedMeeting.schedule_date,
                        start_time: updatedMeeting.start_time,
                        end_time: updatedMeeting.end_time,
                        work_location: updatedMeeting.work_location
                    })
                });

                emitDesktopNotification({
                    username: recipientUsername,
                    type: "meeting-updated",
                    title: "Meeting schedule updated",
                    message: `Meeting schedule updated for ${updatedMeeting.schedule_date} from ${updatedMeeting.start_time} to ${updatedMeeting.end_time}`,
                    href: "/meeting-schedule",
                    notification: notification
                });
            } catch (notificationError) {
                console.error("UPDATE MEETING NOTIFICATION ERROR:", notificationError);
            }
        }

        return res.status(200).json({
            success: true,
            message: "Meeting schedule updated successfully",
            data: updatedMeeting
        });

    } catch (error) {
        console.error("UPDATE MEETING SCHEDULE ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to update meeting schedule",
            error: error.message
        });
    }
};

/* =========================================================
   DELETE MEETING
========================================================= */
export const deleteMeetingSchedule = async (req, res) => {
    try {
        const { id } = req.params;

        /* =====================================================
           VALIDATE ID
        ===================================================== */
        if (
            !Number.isInteger(Number(id)) ||
            Number(id) <= 0
        ) {
            return res.status(400).json({
                success: false,
                message: "Valid meeting ID is required"
            });
        }

        /* =====================================================
           DELETE MEETING
        ===================================================== */
        const deletedMeeting = await deleteMeetingScheduleModel(
            Number(id)
        );

        if (!deletedMeeting) {
            return res.status(404).json({
                success: false,
                message: "Meeting schedule not found"
            });
        }

        /* =====================================================
           NOTIFICATION RECIPIENTS
        ===================================================== */
        const notificationRecipients = new Map();

        for (const value of [
            deletedMeeting.scheduled_person_name,
            ...splitUsernames(
                deletedMeeting.conduct_person_name
            )
        ]) {
            const username = String(value || "").trim();

            if (
                username &&
                !notificationRecipients.has(
                    username.toLowerCase()
                )
            ) {
                notificationRecipients.set(
                    username.toLowerCase(),
                    username
                );
            }
        }

        const senderUsername = String(
            req.headers["x-username"] || "system"
        ).trim();

        /* =====================================================
           SEND DELETE NOTIFICATION
        ===================================================== */
        for (
            const recipientUsername
            of notificationRecipients.values()
        ) {
            try {
                const notification = await ReadNotificationModel.create({
                    notification_type: "meeting-deleted",
                    sender_username: senderUsername,
                    receive_username: recipientUsername,
                    page_name: "Meeting Schedule",
                    title: "Meeting schedule deleted",
                    message: `Meeting scheduled on ${deletedMeeting.schedule_date} from ${deletedMeeting.start_time} to ${deletedMeeting.end_time} has been deleted`,
                    meta: JSON.stringify({
                        meeting_id: deletedMeeting.id,
                        schedule_date: deletedMeeting.schedule_date,
                        start_time: deletedMeeting.start_time,
                        end_time: deletedMeeting.end_time,
                        work_location: deletedMeeting.work_location
                    })
                });

                emitDesktopNotification({
                    username: recipientUsername,
                    type: "meeting-deleted",
                    title: "Meeting schedule deleted",
                    message: `Meeting scheduled on ${deletedMeeting.schedule_date} from ${deletedMeeting.start_time} to ${deletedMeeting.end_time} has been deleted`,
                    href: "/meeting-schedule",
                    notification
                });

            } catch (notificationError) {
                console.error("DELETE MEETING NOTIFICATION ERROR:", notificationError);
            }
        }

        /* =====================================================
           RESPONSE
        ===================================================== */
        return res.status(200).json({
            success: true,
            message: "Meeting schedule deleted successfully",
            data: deletedMeeting
        });

    } catch (error) {
        console.error("DELETE MEETING SCHEDULE ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to delete meeting schedule",
            error: error.message
        });
    }
};