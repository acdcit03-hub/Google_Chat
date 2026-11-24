import { getIO } from "../../config/socket.js";
import { pool } from "../../database.js";
import { addSettingEditLogModel } from "../../models/history/setting_edit_log.model.js";
import { addDepartmentStructureModel, deleteDepartmentStructureModel, getActiveUsersWorkEmailModel, getAllDepartmentStructureModel, getDepartmentStructureByIdModel, getSubDepartmentsModel, toggleDepartmentStructureStatusModel, updateDepartmentEverywhere, updateDepartmentStructureModel } from "../../models/settings/Department_structure.model.js";
import {
    expireStaleUserSessionsModel,
    // getAwayUsersModel,
    getOfflineUsersModel,
    getOnlineUsersModel
} from "../../models/users/userSession.model.js";

/* ================= ADD ================= */
export const addDepartmentStructure = async (req, res) => {
    try {

        const {
            parent_id,
            name,
            work_location,
            description,
            is_active
        } = req.body;

        const username = req.headers["x-username"] || null;

        const data = await addDepartmentStructureModel({
            parent_id,
            name,
            work_location,
            description,
            is_active,
            username
        });

        /* ================= SOCKET EMIT ================= */

        const io = getIO();

        if (io) {
            io.emit("department:created", {
                success: true,
                message: "Department added successfully",
                data
            });
        }

        return res.status(201).json({
            success: true,
            message: "Department added successfully",
            data
        });

    } catch (error) {

        console.error(
            "ADD DEPARTMENT ERROR:",
            error
        );

        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= GET ALL ================= */
export const getAllDepartmentStructure = async (req, res) => {
    try {
        const { department, child, work_location } = req.query;

        const data = await getAllDepartmentStructureModel(department, child, work_location);

        const io = getIO();
        if (io) {
            io.emit("department:fetch", {
                success: true,
                message: "Departments fetched successfully",
                data
            });
        }

        return res.status(200).json({
            success: true,
            message: "Departments fetched successfully",
            data
        });

    } catch (error) {
        console.error("GET DEPARTMENT ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= GET BY ID ================= */
export const getDepartmentStructureById = async (req, res) => {
    try {
        const { id } = req.params;
        const data = await getDepartmentStructureByIdModel(id);

        if (!data) {
            return res.status(404).json({
                success: false,
                message: "Department not found"
            });
        }

        /* ================= SOCKET EMIT ================= */
        const io = getIO();

        if (io) {
            io.emit("department:fetch", {
                success: true,
                message: "Departments fetched successfully",
                data
            });
        }

        return res.status(200).json({
            success: true,
            data
        });

    } catch (error) {
        console.error("GET DEPARTMENT BY ID ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= GET SUB DEPARTMENTS ================= */
export const getSubDepartments = async (req, res) => {
    try {
        const { department } = req.query;

        const data = await getSubDepartmentsModel(department);

        return res.status(200).json({
            success: true,
            message: "Sub departments fetched successfully",
            data
        });

    } catch (error) {
        console.error("GET SUB DEPARTMENTS ERROR:", error);

        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

const toDepartmentLogValue = (value) =>
    value === null || value === undefined ? null : String(value);

const updateDepartmentNameReferences = async (existing, updated) => {
    const oldName = existing.name?.trim();
    const newName = updated.name?.trim();

    if (!oldName || !newName || oldName.toLowerCase() === newName.toLowerCase()) {
        return null;
    }

    return updateDepartmentEverywhere(oldName, newName);
};

const logDepartmentFieldChanges = async ({
    id,
    existing,
    updated,
    logUsername,
    currentUsername
}) => {
    const fields = [
        ["parent_id", existing.parent_id, updated.parent_id],
        ["name", existing.name, updated.name],
        ["work_location", existing.work_location_id, updated.work_location_id],
        ["description", existing.description, updated.description],
        ["is_active", existing.is_active, updated.is_active]
    ];

    const changedFields = fields.filter(
        ([, oldValue, newValue]) =>
            toDepartmentLogValue(oldValue) !== toDepartmentLogValue(newValue)
    );

    await Promise.all(
        changedFields.map(([fieldName, oldValue, newValue]) =>
            addSettingEditLogModel({
                table_name: "department_structure",
                record_id: Number(id),
                username: logUsername,
                edited_by: currentUsername,
                field_name: fieldName,
                old_value: toDepartmentLogValue(oldValue),
                new_value: toDepartmentLogValue(newValue)
            })
        )
    );
};

const logDepartmentUsernameChange = async (id, existing, currentUsername) => {
    const oldUsername = existing.username !== undefined && existing.username !== null
        ? String(existing.username).trim()
        : null;
    const newUsername = currentUsername || null;

    if (oldUsername === newUsername) {
        return;
    }

    await addSettingEditLogModel({
        table_name: "department_structure",
        record_id: Number(id),
        username: oldUsername,
        edited_by: currentUsername,
        field_name: "username",
        old_value: oldUsername,
        new_value: newUsername
    });
};

/* ================= UPDATE ================= */
export const updateDepartmentStructure = async (req, res) => {
    try {
        const { id } = req.params;
        const currentUsername = req.headers["x-username"]
            ? String(req.headers["x-username"]).trim()
            : null;
        const existing = await getDepartmentStructureByIdModel(id);

        if (!existing) {
            return res.status(404).json({
                success: false,
                message: "Department not found"
            });
        }

        const logUsername =
            existing.username !== undefined &&
                existing.username !== null &&
                String(existing.username).trim() !== ""
                ? String(existing.username).trim()
                : null;
        const {
            parent_id,
            name,
            work_location,
            description,
            is_active
        } = req.body;
        const updateData = {
            parent_id: parent_id !== undefined ? parent_id : existing.parent_id,
            name: name !== undefined ? name : existing.name,
            work_location: work_location !== undefined
                ? work_location
                : existing.work_location,
            description: description !== undefined
                ? description
                : existing.description,
            is_active: is_active !== undefined ? is_active : existing.is_active,
            username: currentUsername
        };

        if (
            updateData.name !== null &&
            updateData.name !== undefined &&
            String(updateData.name).trim() === ""
        ) {
            return res.status(400).json({
                success: false,
                message: "Department name cannot be empty"
            });
        }

        const data = await updateDepartmentStructureModel(id, updateData);

        if (!data) {
            return res.status(404).json({
                success: false,
                message: "Department not found"
            });
        }

        const updateResult = await updateDepartmentNameReferences(existing, data);
        await logDepartmentFieldChanges({
            id,
            existing,
            updated: data,
            logUsername,
            currentUsername
        });
        await logDepartmentUsernameChange(id, existing, currentUsername);

        const updatedDepartment = await getDepartmentStructureByIdModel(id);
        const io = getIO();

        if (io) {
            io.emit("department:updated", {
                success: true,
                message: "Department updated successfully",
                data: updatedDepartment,
                updateResult
            });
        }

        return res.status(200).json({
            success: true,
            message: "Department updated successfully",
            data: updatedDepartment,
            updateResult
        });
    } catch (error) {
        console.error("UPDATE DEPARTMENT ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= TOGGLE STATUS ================= */
export const toggleDepartmentStructureStatus = async (req, res) => {
    try {
        const { id } = req.params;

        /* =====================================================
           GET OLD DEPARTMENT
        ===================================================== */
        const oldDepartmentResult = await pool.query(
            `
                SELECT
                    id,
                    is_active,
                    username
                FROM department_structure
                WHERE id = $1
            `,
            [id]
        );

        if (!oldDepartmentResult.rows.length) {
            return res.status(404).json({
                success: false,
                message: "Department not found"
            });
        }

        const oldDepartment = oldDepartmentResult.rows[0];

        /* =====================================================
           CURRENT EDITOR
        ===================================================== */
        const editedBy = req.headers["x-username"]
            ? String(req.headers["x-username"]).trim()
            : null;

        /* =====================================================
           ORIGINAL CREATOR
        ===================================================== */
        const logUsername =
            oldDepartment.created_by !== undefined &&
                oldDepartment.created_by !== null &&
                String(oldDepartment.created_by).trim() !== ""
                ? String(oldDepartment.created_by).trim()
                : null;

        /* =====================================================
           TOGGLE STATUS
        ===================================================== */
        const data = await toggleDepartmentStructureStatusModel(id);

        /* ================= NOT FOUND ================= */
        if (!data) {
            return res.status(404).json({
                success: false,
                message: "Department not found"
            });
        }

        /* ================= BLOCKED ================= */
        if (data.blocked) {
            return res.status(400).json({
                success: false,
                message: data.message,
                reason: data.reason,
                used_count: data.used_count || 0,
                used_children: data.used_children || []
            });
        }

        /* =====================================================
           SETTING EDIT LOG
        ===================================================== */
        const settingLogs = [];
        const oldStatus = oldDepartment.is_active;
        const newStatus = data.is_active;

        /* ONLY LOG IF STATUS ACTUALLY CHANGED */
        if (oldStatus !== newStatus) {
            const log = await addSettingEditLogModel({
                table_name: "department_structure",
                record_id: Number(id),
                username: logUsername,
                edited_by: editedBy,
                field_name: "is_active",
                old_value: String(oldStatus),
                new_value: String(newStatus)
            });

            settingLogs.push(log);
        }

        /* =====================================================
           SOCKET EMIT
        ===================================================== */
        const io = getIO();

        if (io) {
            io.emit("department:status-updated", {
                success: true,
                message:
                    `Department ${data.is_active
                        ? "activated"
                        : "deactivated"
                    } successfully`,
                data,
                settingLogs
            });
        }

        /* =====================================================
           RESPONSE
        ===================================================== */
        return res.status(200).json({
            success: true,
            message:
                `Department ${data.is_active
                    ? "activated"
                    : "deactivated"
                } successfully`,
            data,
            settingLogs
        });

    } catch (error) {
        console.error("TOGGLE DEPARTMENT ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= DELETE ================= */
export const deleteDepartmentStructure = async (req, res) => {
    try {
        const { id } = req.params;

        const existing = await getDepartmentStructureByIdModel(id);

        if (!existing) {
            return res.status(404).json({
                success: false,
                message: "Department not found"
            });
        }

        const data = await deleteDepartmentStructureModel(id);

        const io = getIO();

        if (io) {
            io.emit("department:deleted", {
                success: true,
                message: "Department deleted successfully",
                data
            });
        }

        return res.status(200).json({
            success: true,
            message: "Department deleted successfully",
            data
        });

    } catch (error) {
        console.error("DELETE DEPARTMENT ERROR:", error);
        return res.status(400).json({
            success: false,
            message: error.message
        });
    }
};

export const getActiveUsersWorkEmail = async (req, res) => {
    try {
        const getQueryFilter = value =>
            value == null || String(value).trim() === ""
                ? null
                : String(value).trim();

        const name = getQueryFilter(req.query.name);

        const work_location =
            getQueryFilter(req.query.work_location) ||
            getQueryFilter(req.query.location);
        const department = getQueryFilter(req.query.department);
        const work_email = getQueryFilter(req.query.work_email);
        const requestedStatus = getQueryFilter(req.query.status)?.toLowerCase();

        if (
            requestedStatus &&
            !["all", "online", "offline"].includes(requestedStatus)
        ) {
            return res.status(400).json({
                success: false,
                message: "Status must be online, offline, or all"
            });
        }

        const filters = {
            name,
            work_location
        };

        await expireStaleUserSessionsModel();

        const [onlineUsers, offlineUsers] = await Promise.all([
            getOnlineUsersModel(filters),
            getOfflineUsersModel(filters)
        ]);

        const statusByUsername = new Map();

        for (const user of onlineUsers) {
            const key = String(user.username || "").trim().toLowerCase();
            if (key) statusByUsername.set(key, "online");
        }

        for (const user of offlineUsers) {
            const key = String(user.username || "").trim().toLowerCase();

            if (key && !statusByUsername.has(key)) {
                statusByUsername.set(key, "offline");
            }
        }

        const usernames = [...statusByUsername.keys()];

        const users = await getActiveUsersWorkEmailModel({
            name,
            work_location,
            department,
            work_email,
            usernames
        });

        const data = users
            .map(user => ({
                ...user,
                status:
                    statusByUsername.get(
                        String(user.username || "").trim().toLowerCase()
                    ) || "offline"
            }))
            .filter(user =>
                !requestedStatus ||
                requestedStatus === "all" ||
                user.status === requestedStatus
            );

        const onlineUsersCount = data.filter(user => user.status === "online").length;
        const offlineUsersCount = data.length - onlineUsersCount;

        return res.status(200).json({
            success: true,
            message: "Active users work emails fetched successfully",
            count: data.length,
            online_users: onlineUsersCount,
            offline_users: offlineUsersCount,
            data
        });

    } catch (error) {
        console.error("GET ACTIVE USERS WORK EMAIL ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};
