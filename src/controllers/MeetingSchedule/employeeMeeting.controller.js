import {
    createEmployeeMeetingModel,
    getEmployeeMeetingsModel,
    getEmployeeMeetingByIdModel,
    updateEmployeeMeetingModel,
    deleteEmployeeMeetingModel
} from "../../models/MeetingSchedule/employeeMeeting.models.js";
import ReadNotificationModel from "../../models/r2r/receiveIssueResponse.model.js";
import { getWorkLocationIdByNameModel } from "../../models/settings/Location.model.js";
import { emitDesktopNotification } from "../../utils/notification/r2rDesktopNotify.js";

/* =========================================================
   MEETING NOTIFICATION RECIPIENTS
========================================================= */
const getMeetingNotificationRecipients = (meetingMembers = []) => {

    if (!Array.isArray(meetingMembers)) {
        return [];
    }

    const recipients = new Map();

    for (const member of meetingMembers) {
        let username = null;

        if (typeof member === "string") {
            username = member;
        }

        if (
            member &&
            typeof member === "object"
        ) {
            username =
                member.username ||
                member.user_name ||
                member.employee_username ||
                null;
        }

        username = String(username || "").trim();

        if (
            username &&
            !recipients.has(username.toLowerCase())
        ) {
            recipients.set(
                username.toLowerCase(),
                username
            );
        }
    }

    return [
        ...recipients.values()
    ];
};

/* =========================================================
   CREATE MEETING
========================================================= */
export const createEmployeeMeeting = async (req, res) => {
    try {
        const {
            meeting_type,
            cancelled_meeting_id,
            meeting_cancelled_reason,
            date,
            start_time,
            end_time,
            conduct_person_name,
            meeting_members,
            meeting_status,
            note,
            work_location
        } = req.body;

        const username = req.headers["x-username"] || null;

        /* ================= VALIDATION ================= */
        if (!date) {
            return res.status(400).json({
                success: false,
                message: "Meeting date is required"
            });
        }

        if (!start_time) {
            return res.status(400).json({
                success: false,
                message: "Start time is required"
            });
        }

        if (!end_time) {
            return res.status(400).json({
                success: false,
                message: "End time is required"
            });
        }

        /* ================= MEETING MEMBERS ================= */
        let parsedMembers = meeting_members || [];

        if (typeof parsedMembers === "string") {
            try {
                parsedMembers = JSON.parse(parsedMembers);
            } catch (error) {
                return res.status(400).json({
                    success: false,
                    message: "meeting_members must be valid JSON"
                });
            }
        }

        if (!Array.isArray(parsedMembers)) {
            return res.status(400).json({
                success: false,
                message: "meeting_members must be an array"
            });
        }

        /* ================= WORK LOCATION ================= */
        let workLocationId = null;

        if (
            work_location !== undefined &&
            work_location !== null &&
            String(work_location).trim() !== ""
        ) {
            if (
                !Number.isNaN(Number(work_location)) &&
                Number.isInteger(Number(work_location))
            ) {
                workLocationId = Number(work_location);

            } else {
                workLocationId = await getWorkLocationIdByNameModel(
                        String(work_location).trim()
                    );

                if (!workLocationId) {
                    return res.status(400).json({
                        success: false,
                        message: `Work location "${work_location}" not found`
                    });
                }
            }
        }

        /* ================= USERNAME ================= */
        const loggedInUsername =
            req.headers["x-hrms-username"] ||
            username ||
            null;

        /* ================= CREATE MEETING ================= */
        const meeting = await createEmployeeMeetingModel({
                meeting_type: meeting_type?.trim() || null,
                cancelled_meeting_id:
                    cancelled_meeting_id
                        ? Number(cancelled_meeting_id)
                        : null,

                meeting_cancelled_reason: meeting_cancelled_reason?.trim() || null,
                date,
                start_time,
                end_time,
                conduct_person_name: conduct_person_name?.trim() || null,
                meeting_members: parsedMembers,
                meeting_status: meeting_status?.trim() || "scheduled",
                username: loggedInUsername,
                note: note?.trim() || null,
                work_location: workLocationId
            });

        /* =========================================================
        SEND CREATE MEETING NOTIFICATIONS
        ========================================================= */
        const notificationRecipients = getMeetingNotificationRecipients(
                meeting.meeting_members
            );

        const senderUsername =
            String(
                loggedInUsername || "system"
            ).trim();

        for (
            const recipientUsername
            of notificationRecipients
        ) {
            try {
                const notification = await ReadNotificationModel.create({
                        notification_type: "employee-meeting-created",
                        sender_username: senderUsername,
                        receive_username: recipientUsername,
                        page_name: "Employee Meeting",
                        title: "New Employee Meeting",
                        message:
                            `New meeting scheduled on ${meeting.date} ` +
                            `from ${meeting.start_time} ` +
                            `to ${meeting.end_time}`,

                        meta:
                            JSON.stringify({
                                meeting_id: meeting.id,
                                meeting_type: meeting.meeting_type,
                                date: meeting.date,
                                start_time: meeting.start_time,
                                end_time: meeting.end_time,
                                conduct_person_name: meeting.conduct_person_name,
                                meeting_status: meeting.meeting_status,
                                work_location: meeting.work_location
                            })
                    });

                /* ================= SOCKET / DESKTOP ================= */
                emitDesktopNotification({
                    username: recipientUsername,
                    type: "employee-meeting-created",
                    title: "New Employee Meeting",
                    message:
                        `New meeting scheduled on ${meeting.date} ` +
                        `from ${meeting.start_time} ` +
                        `to ${meeting.end_time}`,

                    href: "/employee-meeting",
                    notification
                });

            } catch (notificationError) {
                console.error("CREATE EMPLOYEE MEETING NOTIFICATION ERROR:", notificationError);
            }
        }

        return res.status(201).json({
            success: true,
            message: "Employee meeting created successfully",
            data: meeting
        });

    } catch (error) {
        console.error("Create Employee Meeting Error:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to create employee meeting",
            error: error.message
        });

    }
};

/* =========================================================
   GET ALL MEETINGS
========================================================= */
export const getEmployeeMeetings = async (req, res) => {
    try {
        const {
            date,
            meeting_status,
            meeting_type,
            username,
            work_location,
            page = 1,
            limit = 20
        } = req.query;

        const result = await getEmployeeMeetingsModel({
                date: date || null,
                meeting_status: meeting_status || null,
                meeting_type: meeting_type || null,
                username: username || null,
                work_location:
                    work_location !== undefined
                        ? Number(work_location)
                        : null,

                page,
                limit
            });

        return res.status(200).json({
            success: true,
            message: "Employee meetings fetched successfully",
            ...result
        });

    } catch (error) {
        console.error("Get Employee Meetings Error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch employee meetings",
            error: error.message
        });
    }
};

/* =========================================================
   GET MEETING BY ID
========================================================= */
export const getEmployeeMeetingById = async (req, res) => {
    try {
        const { id } = req.params;

        const meeting = await getEmployeeMeetingByIdModel(id);
        if (!meeting) {
            return res.status(404).json({
                success: false,
                message: "Employee meeting not found"
            });
        }

        return res.status(200).json({
            success: true,
            message: "Employee meeting fetched successfully",
            data: meeting
        });

    } catch (error) {
        console.error("Get Employee Meeting Error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch employee meeting",
            error: error.message
        });
    }
};

/* =========================================================
   UPDATE MEETING
========================================================= */
export const updateEmployeeMeeting = async (req, res) => {
    try {
        const { id } = req.params;

        const existingMeeting = await getEmployeeMeetingByIdModel(id);

        if (!existingMeeting) {
            return res.status(404).json({
                success: false,
                message: "Employee meeting not found"
            });
        }

        /* ================= MEETING MEMBERS ================= */
        if (req.body.meeting_members !== undefined) {
            let members = req.body.meeting_members;

            if (typeof members === "string") {
                try {
                    members = JSON.parse(members);

                } catch (error) {
                    return res.status(400).json({
                        success: false,
                        message: "meeting_members must be valid JSON"
                    });
                }
            }

            if (!Array.isArray(members)) {
                return res.status(400).json({
                    success: false,
                    message: "meeting_members must be an array"
                });
            }

            req.body.meeting_members = members;
        }

        /* ================= WORK LOCATION ================= */
        if (
            req.body.work_location !== undefined &&
            req.body.work_location !== null &&
            String(req.body.work_location).trim() !== ""
        ) {
            const workLocation = req.body.work_location;

            if (
                !Number.isNaN(Number(workLocation)) &&
                Number.isInteger(Number(workLocation))
            ) {
                req.body.work_location = Number(workLocation);

            } else {
                const workLocationId = await getWorkLocationIdByNameModel(
                        String(workLocation).trim()
                    );

                if (!workLocationId) {
                    return res.status(400).json({
                        success: false,
                        message: `Work location "${workLocation}" not found`
                    });
                }

                req.body.work_location = workLocationId;
            }
        }

        /* ================= UPDATE ================= */
        const updatedMeeting = await updateEmployeeMeetingModel(
                id,
                req.body
            );

        if (!updatedMeeting) {
            return res.status(400).json({
                success: false,
                message: "No valid fields provided for update"
            });
        }

        /* =========================================================
           SEND UPDATE MEETING NOTIFICATIONS
        ========================================================= */
        const oldRecipients = getMeetingNotificationRecipients(
                existingMeeting.meeting_members
            );

        const newRecipients = getMeetingNotificationRecipients(
                updatedMeeting.meeting_members
            );

        /* =========================================================
           MERGE OLD + NEW MEMBERS
        ========================================================= */
        const notificationRecipients = new Map();

        for (
            const username
            of [
                ...oldRecipients,
                ...newRecipients
            ]
        ) {
            const normalized =
                String(username)
                    .trim()
                    .toLowerCase();

            if (
                normalized &&
                !notificationRecipients.has(normalized)
            ) {
                notificationRecipients.set(
                    normalized,
                    username
                );
            }
        }

        /* =========================================================
           SENDER
        ========================================================= */
        const senderUsername =
            String(
                req.headers["x-hrms-username"] ||
                req.headers["x-username"] ||
                "system"
            ).trim();

        /* =========================================================
           SEND NOTIFICATION
        ========================================================= */
        for (
            const recipientUsername
            of notificationRecipients.values()
        ) {
            try {
                const notification = await ReadNotificationModel.create({
                    notification_type: "employee-meeting-updated",
                    sender_username: senderUsername,
                    receive_username: recipientUsername,
                    page_name: "Employee Meeting",
                    title: "Employee Meeting Updated",

                    message:
                        `Meeting on ${updatedMeeting.date} ` +
                        `from ${updatedMeeting.start_time} ` +
                        `to ${updatedMeeting.end_time} ` +
                        `has been updated.`,

                    meta: JSON.stringify({
                        meeting_id: updatedMeeting.id,
                        meeting_type: updatedMeeting.meeting_type,
                        date: updatedMeeting.date,
                        start_time: updatedMeeting.start_time,
                        end_time: updatedMeeting.end_time,
                        conduct_person_name: updatedMeeting.conduct_person_name,
                        meeting_status: updatedMeeting.meeting_status,
                        work_location: updatedMeeting.work_location
                    })
                });

                /* ================= SOCKET / DESKTOP ================= */
                emitDesktopNotification({
                    username: recipientUsername,
                    type: "employee-meeting-updated",
                    title: "Employee Meeting Updated",
                    message:
                        `Meeting on ${updatedMeeting.date} ` +
                        `from ${updatedMeeting.start_time} ` +
                        `to ${updatedMeeting.end_time} ` +
                        `has been updated.`,

                    href: "/employee-meeting",
                    notification
                });

            } catch (notificationError) {
                console.error("UPDATE EMPLOYEE MEETING NOTIFICATION ERROR:", notificationError);
            }
        }

        return res.status(200).json({
            success: true,
            message: "Employee meeting updated successfully",
            data: updatedMeeting
        });

    } catch (error) {
        console.error("Update Employee Meeting Error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to update employee meeting",
            error: error.message
        });
    }
};

/* =========================================================
   DELETE MEETING
========================================================= */
export const deleteEmployeeMeeting = async (req, res) => {
    try {
        const { id } = req.params;

        /* =====================================================
           GET MEETING BEFORE DELETE
        ===================================================== */
        const existingMeeting = await getEmployeeMeetingByIdModel(id);

        if (!existingMeeting) {
            return res.status(404).json({
                success: false,
                message: "Employee meeting not found"
            });
        }

        /* =====================================================
           GET LOGGED-IN USER
        ===================================================== */
        const username = req.headers["x-username"];

        const loggedInUsername =
            req.headers["x-hrms-username"] ||
            username ||
            "system";

        /* =====================================================
           GET MEETING MEMBERS
        ===================================================== */
        let meetingMembers = existingMeeting.meeting_members;

        if (typeof meetingMembers === "string") {
            try {
                meetingMembers = JSON.parse(meetingMembers);
            } catch (error) {
                meetingMembers = [];
            }
        }

        if (!Array.isArray(meetingMembers)) {
            meetingMembers = [];
        }

        /* =====================================================
           EXTRACT USERNAMES
        ===================================================== */
        const recipients = new Map();

        for (const member of meetingMembers) {
            let recipientUsername = null;

            /* ---------------------------------------------
               If meeting_members contains string
            --------------------------------------------- */
            if (typeof member === "string") {
                recipientUsername = member.trim();
            }

            /* ---------------------------------------------
               If meeting_members contains object
            --------------------------------------------- */
            else if (
                member &&
                typeof member === "object"
            ) {
                recipientUsername =
                    member.username ||
                    member.user_name ||
                    member.employee_username ||
                    null;

                if (recipientUsername) {
                    recipientUsername =
                        String(recipientUsername).trim();
                }
            }

            /* ---------------------------------------------
               Add unique recipient
            --------------------------------------------- */
            if (recipientUsername) {
                const key = recipientUsername.toLowerCase();

                if (!recipients.has(key)) {
                    recipients.set(
                        key,
                        recipientUsername
                    );
                }
            }
        }

        /* =====================================================
           DELETE MEETING
        ===================================================== */
        const meeting = await deleteEmployeeMeetingModel(id);

        if (!meeting) {
            return res.status(404).json({
                success: false,
                message: "Employee meeting not found"
            });
        }

        /* =====================================================
           NOTIFICATION DATA
        ===================================================== */
        const notificationTitle = "Employee Meeting Cancelled";
        const notificationMessage = `Employee meeting scheduled on ${existingMeeting.date} from ${existingMeeting.start_time} to ${existingMeeting.end_time} has been cancelled.`;

        /* =====================================================
           SEND NOTIFICATION
        ===================================================== */
        for (const recipientUsername of recipients.values()) {
            try {
                const notification = await ReadNotificationModel.create({
                    notification_type: "employee-meeting-cancelled",
                    sender_username: String(loggedInUsername).trim(),
                    receive_username: recipientUsername,
                    page_name: "Employee Meeting",
                    title: notificationTitle,
                    message: notificationMessage,
                    meta: JSON.stringify({
                        meeting_id: existingMeeting.id,
                        meeting_type: existingMeeting.meeting_type,
                        date: existingMeeting.date,
                        start_time: existingMeeting.start_time,
                        end_time: existingMeeting.end_time,
                        conduct_person_name: existingMeeting.conduct_person_name,
                        meeting_status: existingMeeting.meeting_status,
                        work_location: existingMeeting.work_location
                    })
                });

                /* -----------------------------------------
                   Desktop / Socket Notification
                ----------------------------------------- */
                emitDesktopNotification({
                    username: recipientUsername,
                    type: "employee-meeting-cancelled",
                    title: notificationTitle,
                    message: notificationMessage,
                    href: "/employee-meeting",
                    notification
                });

            } catch (notificationError) {
                console.error(`Employee meeting delete notification failed for ${recipientUsername}:`, notificationError);
            }
        }

        /* =====================================================
           RESPONSE
        ===================================================== */
        return res.status(200).json({
            success: true,
            message: "Employee meeting cancelled successfully",
            data: meeting
        });

    } catch (error) {
        console.error("Delete Employee Meeting Error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to delete employee meeting",
            error: error.message
        });
    }
};