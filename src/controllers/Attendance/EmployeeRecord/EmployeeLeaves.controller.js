import { getIO } from "../../../config/socket.js";
import { uploadToCloudinary } from "../../../middleware/cloudinaryUpload.js";
import {
    addLeaveModel,
    deleteLeaveModel,
    getLeaveByIdModel,
    getLeaveCalendarModel,
    getLeavesModel,
    getLeaveStatusCountsModel,
    getPendingLeaveCountModel,
    getTodayLeaveModel,
    getUpcomingLeavesModel,
    updateLeaveModel,
    updateLeaveStatusModel
} from "../../../models/Attendance/EmployeeRecord/EmployeeLeaves.model.js";

import {
    addCalendarEditLogModel
} from "../../../models/history/calendar_log.model.js";
import { addLeaveEditLogModel } from "../../../models/history/leave_edit_log.model.js";


/* =========================================================
   GET EDITED BY
========================================================= */
const getEditedBy = (req) => {
    return req.headers["x-username"]
        ? String(req.headers["x-username"]).trim()
        : null;
};

const cleanLeaveValue = (value) => {
    if (value === undefined) {
        return undefined;
    }

    if (value === null) {
        return null;
    }

    if (typeof value === "string") {
        const cleaned = value.trim();

        if (
            cleaned === "" ||
            cleaned.toLowerCase() === "null" ||
            cleaned.toLowerCase() === "undefined"
        ) {
            return null;
        }

        return cleaned;
    }

    return value;
};

const resolveLeaveDocumentUrl = async ({
    file,
    bodyDocument,
    existingDocument = null,
    username
}) => {
    if (file?.buffer) {
        const folderPath =
            String(username || "LEAVE")
                .trim()
                .replace(/\s+/g, "_")
                .toUpperCase() || "LEAVE";

        const result = await uploadToCloudinary(
            file.buffer,
            `LEAVE_DOCUMENT_${Date.now()}`,
            folderPath,
            file.mimetype
        );

        if (result?.secure_url) {
            return result.secure_url;
        }
    }

    const bodyUrl = cleanLeaveValue(bodyDocument);

    if (bodyUrl !== undefined && bodyUrl !== null) {
        return bodyUrl;
    }

    return existingDocument ?? null;
};

const formatLeaveDate = (value) => {
    if (!value) {
        return value;
    }

    if (
        typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(value)
    ) {
        return value;
    }

    const date = value instanceof Date
        ? value
        : new Date(value);

    if (Number.isNaN(date.getTime())) {
        return value;
    }

    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).formatToParts(date);
    const part = type => parts.find(item => item.type === type)?.value;

    return `${part("year")}-${part("month")}-${part("day")}`;
};

/* =========================================================
   ADD LEAVE
========================================================= */
export const addLeave = async (req, res) => {
    try {
        const {
            username,
            start_leave_date,
            end_leave_date,
            inform_date,
            medium,
            leave_type,
            reason,
            description,
            document,
            status
        } = req.body;

        /* ================= VALIDATE ================= */
        if (
            !username ||
            String(username).trim() === "" ||

            !start_leave_date ||
            String(start_leave_date).trim() === "" ||

            !end_leave_date ||
            String(end_leave_date).trim() === "" ||

            !inform_date ||
            String(inform_date).trim() === "" ||

            !medium ||
            String(medium).trim() === "" ||

            !leave_type ||
            String(leave_type).trim() === "" ||

            !reason ||
            String(reason).trim() === "" ||

            !description ||
            String(description).trim() === "" ||

            !status ||
            String(status).trim() === ""
        ) {
            return res.status(400).json({
                success: false,
                message: "All fields are required"
            });
        }

        const editedBy = getEditedBy(req);

        const documentUrl = await resolveLeaveDocumentUrl({
            file: req.file,
            bodyDocument: document,
            username
        });

        /* ================= CREATE LEAVE ================= */
        const data = await addLeaveModel({
            ...req.body,
            document: documentUrl,
            created_by: editedBy
        });

        if (!data) {
            return res.status(400).json({
                success: false,
                message: "Leave could not be added"
            });
        }

        const io = getIO();
        if (io) {
            io.emit("employee-leave:created", {
                success: true,
                message: "Leave added successfully",
                data
            });
        }

        return res.status(201).json({
            success: true,
            message: "Leave added successfully",
            data
        });

    } catch (error) {
        console.error("ADD LEAVE ERROR:", error);
        return res.status(error.statusCode || 500).json({
            success: false,
            message: error.message
        });
    }
};

/* =========================================================
   GET LEAVES
========================================================= */
export const getLeaves = async (req, res) => {
    try {
        const {
            page = 1,
            limit = 20,
            pagination = "true"
        } = req.query;

        let date = null;
        if (req.query.date != null && String(req.query.date).trim() !== "") {
            const dateMatch = /^(\d{2})-(\d{2})-(\d{4})$/.exec(
                String(req.query.date).trim()
            );

            if (!dateMatch) {
                return res.status(400).json({
                    success: false,
                    message: "date must use DD-MM-YYYY format"
                });
            }

            const [, day, month, year] = dateMatch;
            const parsedDate = new Date(
                Date.UTC(Number(year), Number(month) - 1, Number(day))
            );
            if (
                parsedDate.getUTCFullYear() !== Number(year) ||
                parsedDate.getUTCMonth() !== Number(month) - 1 ||
                parsedDate.getUTCDate() !== Number(day)
            ) {
                return res.status(400).json({
                    success: false,
                    message: "date must be a valid calendar date"
                });
            }

            date = `${year}-${month}-${day}`;
        }

        const paginationEnabled = String(pagination).trim().toLowerCase() !== "false";

        const data = await getLeavesModel({
            ...req.query,
            date,
            page,
            limit,
            pagination: paginationEnabled
        });

        return res.status(200).json({
            success: true,
            data: data.data,
            pagination: data.pagination
        });

    } catch (error) {
        console.error( "GET LEAVES ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* =========================================================
   GET LEAVE BY ID
========================================================= */
export const getLeaveById = async (req, res) => {
    try {
        const { id } = req.params;

        /* ================= VALIDATE ID ================= */
        if (!id || Number.isNaN(Number(id))) {
            return res.status(400).json({
                success: false,
                message: "Valid leave ID is required"
            });
        }

        /* ================= GET LEAVE ================= */
        const data = await getLeaveByIdModel(Number(id));

        /* ================= NOT FOUND ================= */
        if (!data) {
            return res.status(404).json({
                success: false,
                message: "Leave not found"
            });
        }

        /* ================= RESPONSE ================= */
        return res.status(200).json({
            success: true,
            message: "Leave fetched successfully",
            data
        });

    } catch (error) {
        console.error("GET LEAVE BY ID ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

export const getLeaveCalendar = async (req, res) => {
    try {
        const {
            view = "monthly",
            month,
            year,
            financial_year,
            yearly_filter,
            username,
            work_location,
            department,
            shift_name,
            shift_type
        } = req.query;

        const normalizedView =
            String(view).trim().toLowerCase();

        if (!["monthly", "yearly"].includes(normalizedView)) {
            return res.status(400).json({
                success: false,
                message: "view must be monthly or yearly"
            });
        }

        if (normalizedView === "monthly" && (!month || !year)) {
            return res.status(400).json({
                success: false,
                message: "month and year are required for monthly view"
            });
        }

        if (normalizedView === "yearly") {
            if (!yearly_filter) {
                return res.status(400).json({
                    success: false,
                    message: "yearly_filter is required for yearly view"
                });
            }

            const filter =
                String(yearly_filter)
                    .trim()
                    .toLowerCase();

            if (
                ![
                    "joining_date",
                    "financial_year"
                ].includes(filter)
            ) {
                return res.status(400).json({
                    success: false,
                    message: "yearly_filter must be joining_date or financial_year"
                });
            }

            if (
                filter === "joining_date" &&
                !year
            ) {
                return res.status(400).json({
                    success: false,
                    message: "year is required for joining_date filter"
                });
            }

            if (
                filter === "financial_year" &&
                !financial_year
            ) {
                return res.status(400).json({
                    success: false,
                    message: "financial_year is required for financial_year filter"
                });
            }
        }

        const data = await getLeaveCalendarModel({
                view: normalizedView,
                month,
                year,
                financial_year,
                yearly_filter,
                username,
                work_location,
                department,
                shift_name,
                shift_type
            });

        return res.status(200).json({
            success: true,
            data
        });

    } catch (error) {
        console.error("GET LEAVE CALENDAR ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* =========================================================
   GET TODAY LEAVE COUNT + DETAILS
========================================================= */
export const getTodayLeave = async (req, res) => {
    try {
        const { work_location } = req.query;

        const data = await getTodayLeaveModel({
            work_location
        });

        const today = new Date().toLocaleDateString("en-CA", {
            timeZone: "Asia/Kolkata"
        });
        const leaves = data.leaves.map(leave => ({
            id: leave.id,
            username: leave.username,
            first_name: leave.first_name,
            middle_name: leave.middle_name,
            last_name: leave.last_name,
            full_name: [leave.first_name, leave.last_name]
                .filter(name => name != null && String(name).trim() !== "")
                .join(" "),
            leave_type: leave.leave_type,
            status: leave.status,
            start_leave_date: leave.start_leave_date,
            end_leave_date: leave.end_leave_date
        }));

        return res.status(200).json({
            success: true,
            message: "Today's leave count and details fetched successfully",
            data: {
                date: today,
                work_location: work_location || null,
                leave_count: leaves.length,
                leaves
            }
        });

    } catch (error) {
        console.error("GET TODAY LEAVE COUNT ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* =========================================================
   GET UPCOMING LEAVES - NEXT 10 DAYS
========================================================= */
export const getUpcomingLeaves = async (req, res) => {
    try {

        const {
            username,
            status,
            work_location
        } = req.query;

        const leaves =
            await getUpcomingLeavesModel({
                username,
                status,
                work_location
            });
        const formatDisplayDate = value => {
            if (!value) {
                return "";
            }

            const [year, month, day] = String(value).slice(0, 10).split("-");
            return `${day}/${month}/${year}`;
        };
        const responseLeaves = leaves.map(leave => {
            const startDate = formatDisplayDate(leave.start_leave_date);
            const endDate = formatDisplayDate(leave.end_leave_date);

            return {
                id: leave.id,
                username: leave.username,
                first_name: leave.first_name,
                middle_name: leave.middle_name,
                last_name: leave.last_name,
                display_name: [leave.first_name, leave.last_name]
                    .filter(name => name != null && String(name).trim() !== "")
                    .join(" "),
                leave_type: leave.leave_type,
                status: leave.status,
                start_leave_date: leave.start_leave_date,
                end_leave_date: leave.end_leave_date,
                display_date: startDate === endDate
                    ? startDate
                    : `${startDate} - ${endDate}`
            };
        });

        return res.status(200).json({
            success: true,
            message: "Upcoming leaves fetched successfully",

            data: {
                total: responseLeaves.length,
                leaves: responseLeaves
            }
        });

    } catch (error) {
        console.error("GET UPCOMING LEAVES ERROR:", error);

        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* =========================================================
   GET LEAVE STATUS COUNTS
========================================================= */
export const getLeaveStatusCounts = async (req, res) => {
    try {
        const {
            status,
            work_location,
            username,
            name,
            leave_type,
            startDate,
            start_date,
            endDate,
            end_date,
            informDate,
            inform_date,
            days_before_leave,
            medium,
            reason,
            department,
            shift_name,
            shift_type
        } = req.query;

        const data = await getLeaveStatusCountsModel({
            status,
            work_location,
            username,
            name,
            leave_type,
            startDate: startDate ?? start_date,
            endDate: endDate ?? end_date,
            informDate: informDate ?? inform_date,
            days_before_leave,
            medium,
            reason,
            department,
            shift_name,
            shift_type
        });

        return res.status(200).json({
            success: true,
            message: "Leave status counts fetched successfully",
            data: {
                pending: data.pending,
                approved: data.approved,
                cancelled: data.cancelled,
                rejected: data.rejected
            }
        });

    } catch (error) {
        console.error("GET LEAVE STATUS COUNTS ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* =========================================================
   GET PENDING LEAVE COUNT + DATA
========================================================= */
export const getPendingLeaveCount = async (req, res) => {
    try {
        const { work_location = null } = req.query;

        const data = await getPendingLeaveCountModel({
            work_location
        });
        const formatDisplayDate = date => {
            if (!date) {
                return "";
            }

            const [year, month, day] = String(date).slice(0, 10).split("-");
            return `${day}/${month}/${year}`;
        };
        const leaves = data.leaves.map(leave => {
            const startDate = formatDisplayDate(leave.start_leave_date);
            const endDate = formatDisplayDate(leave.end_leave_date);

            return {
                id: leave.id,
                username: leave.username,
                first_name: leave.first_name,
                middle_name: leave.middle_name,
                last_name: leave.last_name,
                full_name: [leave.first_name, leave.last_name]
                    .filter(name => name != null && String(name).trim() !== "")
                    .join(" "),
                leave_type: leave.leave_type,
                status: leave.status,
                start_leave_date: leave.start_leave_date,
                end_leave_date: leave.end_leave_date,
                display_date: startDate === endDate
                    ? startDate
                    : `${startDate} - ${endDate}`
            };
        });

        return res.status(200).json({
            success: true,
            message: "Pending leaves fetched successfully",
            data: {
                pending_count: data.pending_count,
                leaves
            }
        });

    } catch (error) {
        console.error("GET PENDING LEAVE COUNT ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* =========================================================
   UPDATE LEAVE
========================================================= */
export const updateLeave = async (req, res) => {
    try {
        const editedBy = getEditedBy(req);

        const existing = await getLeaveByIdModel(
            req.params.id
        );

        if (!existing) {
            return res.status(404).json({
                success: false,
                message: "Leave not found"
            });
        }

        const first_name =
            cleanLeaveValue(req.body.first_name) ??
            existing.first_name ??
            null;

        const middle_name =
            cleanLeaveValue(req.body.middle_name) ??
            existing.middle_name ??
            null;

        const last_name =
            cleanLeaveValue(req.body.last_name) ??
            existing.last_name ??
            null;

        const username =
            cleanLeaveValue(req.body.username) ??
            existing.username;

        const documentUrl = await resolveLeaveDocumentUrl({
            file: req.file,
            bodyDocument: req.body.document,
            existingDocument: existing.document,
            username
        });

        const updateValues = {
            username,

            start_leave_date:
                cleanLeaveValue(req.body.start_leave_date) ??
                formatLeaveDate(existing.start_leave_date),

            end_leave_date:
                cleanLeaveValue(req.body.end_leave_date) ??
                formatLeaveDate(existing.end_leave_date),

            inform_date:
                cleanLeaveValue(req.body.inform_date) ??
                formatLeaveDate(existing.inform_date),

            medium:
                cleanLeaveValue(req.body.medium) ??
                existing.medium,

            leave_type:
                cleanLeaveValue(req.body.leave_type) ??
                existing.leave_type,

            leave_start_time:
                cleanLeaveValue(req.body.leave_start_time) ??
                existing.leave_start_time,

            leave_end_time:
                cleanLeaveValue(req.body.leave_end_time) ??
                existing.leave_end_time,

            description:
                cleanLeaveValue(req.body.description) ??
                existing.description,

            reason:
                cleanLeaveValue(req.body.reason) ??
                existing.reason,

            rejected_reason:
                cleanLeaveValue(req.body.rejected_reason) ??
                existing.rejected_reason,

            document: documentUrl,

            status:
                cleanLeaveValue(req.body.status) ??
                existing.status
        };

        const statusOnlyKeys = new Set([
            "status",
            "rejected_reason"
        ]);

        const bodyKeys = Object.keys(req.body || {}).filter((key) => {
            const value = cleanLeaveValue(req.body[key]);
            return value !== undefined && value !== null;
        });

        const hasOtherFields = bodyKeys.some(
            (key) => !statusOnlyKeys.has(key)
        );

        const isStatusOnlyUpdate =
            req.body.status !== undefined &&
            !hasOtherFields &&
            !req.file;

        const data = isStatusOnlyUpdate
            ? await updateLeaveStatusModel(
                req.params.id,
                updateValues.status,
                updateValues.rejected_reason,
                documentUrl
            )
            : await updateLeaveModel(
                req.params.id,
                updateValues
            );

        if (!data) {
            return res.status(404).json({
                success: false,
                message: "Leave not found"
            });
        }

        data.start_leave_date = formatLeaveDate(data.start_leave_date);
        data.end_leave_date = formatLeaveDate(data.end_leave_date);
        data.inform_date = formatLeaveDate(data.inform_date);

        const fields = [
            "username",
            "start_leave_date",
            "end_leave_date",
            "leave_type",
            "leave_start_time",
            "leave_end_time",
            "description",
            "reason",
            "rejected_reason",
            "document",
            "inform_date",
            "medium",
            "status"
        ];

        const normalizeLeaveLogValue = (field, value) => {
            if (value === null || value === undefined) return null;

            if (
                field === "start_leave_date" ||
                field === "end_leave_date" ||
                field === "inform_date"
            ) {
                const formatted = formatLeaveDate(value);
                return formatted == null ? null : String(formatted);
            }

            if (
                field === "leave_start_time" ||
                field === "leave_end_time"
            ) {
                const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(value).trim());
                if (!match) {
                    const text = String(value).trim();
                    return text === "" ? null : text;
                }
                return `${match[1].padStart(2, "0")}:${match[2]}:${match[3] || "00"}`;
            }

            const text = String(value).trim();
            return text === "" ? null : text;
        };

        let hasChanges = false;
        const leaveEditLogs = [];

        for (const field of fields) {
            const oldValue = normalizeLeaveLogValue(field, existing[field]);
            const newValue = normalizeLeaveLogValue(field, data[field]);
            if (oldValue === newValue) continue;

            hasChanges = true;
            leaveEditLogs.push(addLeaveEditLogModel({
                table_name: "employee_leaves",
                record_id: Number(req.params.id),
                username: data.username || existing.username || null,
                edited_by: editedBy,
                field_name: field,
                old_value: oldValue,
                new_value: newValue
            }));
        }

        if (leaveEditLogs.length) {
            await Promise.all(leaveEditLogs);
        }

        /* =========================================================
           CREATE CALENDAR LOG
        ========================================================= */
        if (hasChanges) {
            await addCalendarEditLogModel({
                table_name: "employee_leaves",
                record_id: Number(req.params.id),
                username: existing.created_by || null,
                edited_by: editedBy,
                action: "UPDATE",
                field_name: "employee_leaves",
                old_value: existing,
                new_value: data,
                calendar_date:
                    data.start_leave_date ||
                    existing.start_leave_date,

                description: `Leave updated for ${data.username}`
            });
        }

        const responseData = {
            ...data,
            first_name,
            middle_name,
            last_name
        };

        const io = getIO();
        if (io) {
            io.emit(
                isStatusOnlyUpdate
                    ? "employee-leave:status-updated"
                    : "employee-leave:updated",
                {
                    success: true,
                    message: "Leave updated successfully",
                    data
                }
            );
        }

        /* =========================================================
           RESPONSE
        ========================================================= */
        return res.status(200).json({
            success: true,
            message: "Leave updated successfully",
            data: responseData
        });

    } catch (error) {
        console.error("UPDATE LEAVE ERROR:", error);
        return res.status(error.statusCode || 500).json({
            success: false,
            message: error.message
        });
    }
};

/* =========================================================
   DELETE LEAVE
========================================================= */
export const deleteLeave = async (req, res) => {
    try {

        /* =========================================================
           CURRENT USER WHO IS DELETING
        ========================================================= */
        const editedBy = getEditedBy(req);

        /* =========================================================
           GET OLD LEAVE BEFORE DELETE
        ========================================================= */
        const existing = await getLeaveByIdModel(
            req.params.id
        );

        if (!existing) {
            return res.status(404).json({
                success: false,
                message: "Leave not found"
            });
        }

        /* =========================================================
           DELETE LEAVE
        ========================================================= */
        const data = await deleteLeaveModel(
            req.params.id
        );

        if (!data) {
            return res.status(404).json({
                success: false,
                message: "Leave not found"
            });
        }

        /* =========================================================
           CREATE DELETE CALENDAR LOG

           old_value = COMPLETE DELETED RECORD JSON
           new_value = NULL
        ========================================================= */
        await addCalendarEditLogModel({
            table_name: "employee_leaves",
            record_id: Number(req.params.id),
            username: existing.created_by || null,
            edited_by: editedBy,
            action: "DELETE",
            field_name: "employee_leaves",
            old_value: existing,
            new_value: null,
            calendar_date: existing.start_leave_date,
            description: `Leave deleted for ${existing.username}`
        });

        const io = getIO();
        if (io) {
            io.emit("employee-leave:deleted", {
                success: true,
                message: "Leave deleted successfully",
                data
            });
        }

        /* =========================================================
           RESPONSE
        ========================================================= */
        return res.status(200).json({
            success: true,
            message: "Leave deleted successfully",
            data
        });

    } catch (error) {
        console.error("DELETE LEAVE ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};