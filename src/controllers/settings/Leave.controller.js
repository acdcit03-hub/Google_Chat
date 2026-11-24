import {
    checkDuplicateLeaveModel,
    createLeaveModel,
    getAllLeaveModel,
    getLeaveByIdModel,
    getLeaveIdModel,
    getLeaveReasonUsageModel,
    toggleLeaveStatusModel,
    updateLeaveModel
} from "../../models/settings/Leave.model.js";
import { getIO } from "../../config/socket.js";

/* =========================================================
   CREATE LEAVE
========================================================= */
export const createLeave = async (req, res) => {
    try {
        const {
            leave_reason,
            status
        } = req.body;

        const username = req.headers["x-hrms-username"] || null;

        /* ================= STATUS ================= */
        const leaveStatus =
            status !== undefined
                ? status
                : true;

        const isDuplicate = await checkDuplicateLeaveModel(
            leave_reason
        );

        if (isDuplicate) {
            const error = new Error(
                "Leave reason already exists"
            );

            error.code = "LEAVE_REASON_EXISTS";

            throw error;
        }

        /* ================= CREATE ================= */
        const leave = await createLeaveModel({
            username,
            leave_reason:
                leave_reason !== undefined &&
                    leave_reason !== null
                    ? String(leave_reason).trim()
                    : null,

            status: leaveStatus
        });

        const io = getIO();
        if (io) {
            io.emit("leave-reason:created", {
                success: true,
                message: "Leave created successfully",
                data: leave
            });
        }

        return res.status(201).json({
            success: true,
            message: "Leave created successfully",
            data: leave
        });

    } catch (error) {
        console.error("Create Leave Error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to create leave",
            error: error.message
        });
    }
};

/* =========================================================
   GET ALL LEAVES
========================================================= */
export const getAllLeave = async (req, res) => {
    try {
        const leaves = await getAllLeaveModel();

        return res.status(200).json({
            success: true,
            count: leaves.length,
            data: leaves
        });

    } catch (error) {
        console.error("Get All Leave Error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch leaves",
            error: error.message
        });
    }
};

/* =========================================================
   GET LEAVE BY ID
========================================================= */
export const getLeaveById = async (req, res) => {
    try {
        const { id } = req.params;

        if (
            !id ||
            !Number.isInteger(Number(id))
        ) {
            return res.status(400).json({
                success: false,
                message: "Valid leave ID is required"
            });
        }

        const leave = await getLeaveIdModel(
            Number(id)
        );

        if (!leave) {
            return res.status(404).json({
                success: false,
                message: "Leave not found"
            });
        }

        return res.status(200).json({
            success: true,
            data: leave
        });

    } catch (error) {
        console.error("Get Leave By ID Error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch leave",
            error: error.message
        });
    }
};

/* =========================================================
   GET LEAVE REASON USAGE
========================================================= */
export const getLeaveReasonUsage = async (req, res) => {
    try {
        const {
            view = "monthly",
            month,
            year,
            yearly_filter,
            financial_year,
            leave_reason,
            work_location,
            department,
            name
        } = req.query;

        /* =====================================================
           MONTHLY VALIDATION
        ===================================================== */
        if (
            String(view)
                .trim()
                .toLowerCase() === "monthly"
        ) {
            if (!month) {
                return res.status(400).json({
                    success: false,
                    message: "month is required for monthly view"
                });
            }

            if (!year) {
                return res.status(400).json({
                    success: false,
                    message: "year is required for monthly view"
                });
            }
        }

        /* =====================================================
           YEARLY VALIDATION
        ===================================================== */
        if (
            String(view)
                .trim()
                .toLowerCase() === "yearly"
        ) {
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
                    message: "year is required for joining_date"
                });
            }

            if (
                filter === "financial_year" &&
                !financial_year
            ) {
                return res.status(400).json({
                    success: false,
                    message: "financial_year is required for financial_year"
                });
            }
        }

        /* =====================================================
           NORMALIZE LEAVE REASON
        ===================================================== */
        let leaveReasonFilter = [];

        if (typeof leave_reason === "string") {
            leaveReasonFilter =
                leave_reason
                    .split(",")
                    .map(item => item.trim())
                    .filter(Boolean);

        } else if (Array.isArray(leave_reason)) {
            leaveReasonFilter =
                leave_reason
                    .flatMap(item =>
                        String(item)
                            .split(",")
                            .map(value => value.trim())
                    )
                    .filter(Boolean);
        }

        /* =====================================================
           NORMALIZE WORK LOCATION
        ===================================================== */
        let workLocationFilter = [];

        if (typeof work_location === "string") {

            workLocationFilter =
                work_location
                    .split(",")
                    .map(item => item.trim())
                    .filter(Boolean);

        } else if (Array.isArray(work_location)) {
            workLocationFilter =
                work_location
                    .flatMap(item =>
                        String(item)
                            .split(",")
                            .map(value => value.trim())
                    )
                    .filter(Boolean);
        }

        let departmentFilter = [];

        if (typeof department === "string") {
            departmentFilter = department
                .split(",")
                .map(item => item.trim())
                .filter(Boolean);
        } else if (Array.isArray(department)) {
            departmentFilter = department
                .flatMap(item => String(item).split(","))
                .map(item => item.trim())
                .filter(Boolean);
        }

        const nameFilter = typeof name === "string"
            ? name.split(",").map(item => item.trim()).filter(Boolean)
            : Array.isArray(name)
                ? name
                    .flatMap(item => String(item).split(","))
                    .map(item => item.trim())
                    .filter(Boolean)
                : [];

        /* =====================================================
           GET DATA
        ===================================================== */
        const data = await getLeaveReasonUsageModel({
            view,
            month,
            year,
            yearly_filter,
            financial_year,
            leave_reason: leaveReasonFilter,
            work_location: workLocationFilter,
            department: departmentFilter,
            name: nameFilter
        });

        /* =====================================================
           RESPONSE
        ===================================================== */
        return res.status(200).json({
            success: true,
            message: "Leave reason usage fetched successfully",
            filters: {
                leave_reason: leaveReasonFilter,
                work_location: workLocationFilter,
                department: departmentFilter,
                name: nameFilter
            },

            data
        });

    } catch (error) {
        console.error("Get Leave Reason Usage Error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch leave reason usage",
            error: error.message
        });
    }
};

/* =========================================================
   UPDATE LEAVE
========================================================= */
export const updateLeave = async (req, res) => {
    try {
        const { id } = req.params;

        const {
            leave_reason,
            status
        } = req.body;

        /* ================= ID VALIDATION ================= */
        if (
            !id ||
            !Number.isInteger(Number(id))
        ) {
            return res.status(400).json({
                success: false,
                message: "Valid leave ID is required"
            });
        }

        /* ================= STATUS VALIDATION ================= */
        if (
            status !== undefined &&
            typeof status !== "boolean"
        ) {
            return res.status(400).json({
                success: false,
                message: "Status must be boolean"
            });
        }

        const isDuplicate = await checkDuplicateLeaveModel(
            leave_reason,
            id
        );

        if (isDuplicate) {
            const error = new Error(
                "Leave reason already exists"
            );

            error.code = "LEAVE_REASON_EXISTS";

            throw error;
        }

        /* ================= UPDATE ================= */
        const leave = await updateLeaveModel({
            id: Number(id),
            leave_reason:
                leave_reason !== undefined
                    ? String(leave_reason).trim()
                    : null,
            status:
                status !== undefined
                    ? status
                    : null
        });

        if (!leave) {
            return res.status(404).json({
                success: false,
                message: "Leave not found"
            });
        }

        const io = getIO();
        if (io) {
            io.emit("leave-reason:updated", {
                success: true,
                message: "Leave updated successfully",
                data: leave
            });
        }

        return res.status(200).json({
            success: true,
            message: "Leave updated successfully",
            data: leave
        });

    } catch (error) {
        console.error("Update Leave Error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to update leave",
            error: error.message
        });
    }
};

/* =========================================================
   TOGGLE LEAVE STATUS
========================================================= */
export const toggleLeaveStatus = async (req, res) => {
    try {
        const { id } = req.params;

        /* ================= ID VALIDATION ================= */
        if (
            !id ||
            !Number.isInteger(Number(id))
        ) {
            return res.status(400).json({
                success: false,
                message: "Valid leave ID is required"
            });
        }

        /* ================= TOGGLE ================= */
        const leave = await toggleLeaveStatusModel(
            Number(id)
        );

        if (!leave) {
            return res.status(404).json({
                success: false,
                message: "Leave not found"
            });
        }

        const io = getIO();
        if (io) {
            io.emit("leave-reason:status-updated", {
                success: true,
                message: `Leave status changed to ${leave.status ? "active" : "inactive"}`,
                data: leave
            });
        }

        return res.status(200).json({
            success: true,
            message: `Leave status changed to ${leave.status ? "active" : "inactive"
                }`,
            data: leave
        });

    } catch (error) {
        console.error("Toggle Leave Status Error:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to toggle leave status",
            error: error.message
        });
    }
};