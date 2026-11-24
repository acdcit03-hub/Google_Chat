import { addDeviceConfigurationModel, checkDeviceExistsModel, getAllDeviceConfigurationsModel, getDeviceIpByMacModel, toggleDeviceConfigurationStatusModel, updateDeviceConfigurationModel } from "../../models/settings/DeviceConfigurations.model.js";
import { checkMacExistsModel, getUnregisteredMacsModel, syncMacAddressStatus } from "../../models/Attendance/mac_address.model.js";
import { pool } from "../../database.js";
import { getIO } from "../../config/socket.js";
import { addSettingEditLogModel } from "../../models/history/setting_edit_log.model.js";

/* ================= ADD ================= */
export const addDeviceConfiguration = async (req, res) => {
    try {
        const {
            device_id,
            mac_id,
            work_location,
            department,
            connection,
            status
        } = req.body;

        const created_by = req.headers["x-store-username"] || null;

        if (
            !device_id ||
            !mac_id ||
            !work_location ||
            !department
        ) {
            return res.status(400).json({
                success: false,
                message: "Device Name and Mac ID are required"
            });
        }

        const connectionValue = connection === "offline" ? "offline" : "online";

        const exists = await checkDeviceExistsModel(
            device_id,
            work_location,
            department
        );

        if (exists) {
            return res.status(400).json({
                success: false,
                message: `Device ID ${device_id} already exists in ${work_location}/${department}`
            });
        }

        const macExists = await checkMacExistsModel(mac_id);

        if (macExists) {
            return res.status(400).json({
                success: false,
                message: `MAC ID ${mac_id} is already assigned to another device`
            });
        }

        /* ================= CHECK MAC ================= */
        const macData = await getUnregisteredMacsModel(mac_id);

        if (!macData) {
            return res.status(400).json({
                success: false,
                message: `MAC ID ${mac_id} is not available or already registered`
            });
        }

        /* ================= AUTO DEVICE NAME ================= */
        const device_name = `${work_location}/${department}/${device_id}`;

        await syncMacAddressStatus(null, mac_id);

        const data = await addDeviceConfigurationModel({
            device_id,
            mac_id,
            work_location,
            department,
            device_name,
            connection: connectionValue,
            status,
            created_by
        });

        /* ================= SOCKET ================= */
        const io = getIO();

        io.emit("device-configuration:created", {
            success: true,
            message: "Device configuration added",
            data
        });

        return res.status(201).json({
            success: true,
            message: "Device configuration added successfully",
            data
        });

    } catch (error) {
        console.error("ADD DEVICE ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= GET ================= */
export const getAllDeviceConfigurations = async (req, res) => {
    try {
        const {
            status,
            work_location
        } = req.query;

        const data = await getAllDeviceConfigurationsModel(
            status,
            work_location
        );

        /* ================= SOCKET EMIT ================= */
        const io = getIO();

        io.emit("device-configuration:fetch", {
            success: true,
            message: "Device configurations fetched",
            data
        });

        return res.json({
            success: true,
            message: "Device configurations fetched successfully",
            data
        });

    } catch (error) {
        console.error("GET DEVICE ERROR:", error);

        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= OPEN DEVICE DETAILS ================= */
export const openDeviceDetails = async (req, res) => {
    try {
        const { mac_id } = req.params;

        if (!mac_id) {
            return res.status(400).json({
                success: false,
                message: "MAC ID is required"
            });
        }

        const device = await getDeviceIpByMacModel(mac_id);

        if (!device) {
            return res.status(404).json({
                success: false,
                message: "Device not found"
            });
        }

        if (!device.ip_address) {
            return res.status(400).json({
                success: false,
                message: "IP Address not available"
            });
        }

        // Redirect only to the device IP
        return res.redirect(`http://${device.ip_address}`);

    } catch (error) {
        console.error("OPEN DEVICE ERROR:", error);

        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= UPDATE ================= */
export const updateDeviceConfiguration = async (req, res) => {
    try {
        const { id } = req.params;

        const {
            device_id,
            mac_id,
            work_location,
            department,
            connection,
            status
        } = req.body;

        /* ================= USERNAME ================= */
        const username = req.headers["x-username"]
            ? String(req.headers["x-username"]).trim()
            : null;

        const connectionValue =
            connection === "offline"
                ? "offline"
                : "online";

        /* ================= VALIDATION ================= */
        if (
            !device_id ||
            !mac_id ||
            !work_location ||
            !department
        ) {
            return res.status(400).json({
                success: false,
                message: "Device Name and Mac ID are required"
            });
        }

        /* ================= GET OLD DATA ================= */
        const oldDataResult = await pool.query(
            `
                SELECT
                    id,
                    device_id,
                    mac_id,
                    work_location,
                    department,
                    connection,
                    status,
                    device_name
                FROM device_configurations
                WHERE id = $1
            `,
            [id]
        );

        if (!oldDataResult.rowCount) {
            return res.status(404).json({
                success: false,
                message: "Device configuration not found"
            });
        }

        const oldData = oldDataResult.rows[0];

        /* ================= CHECK DEVICE ================= */
        const exists = await checkDeviceExistsModel(
            device_id,
            work_location,
            department,
            Number(id)
        );

        if (exists) {
            return res.status(400).json({
                success: false,
                message: `Device ID ${device_id} already exists in ${work_location}/${department}`
            });
        }

        /* ================= CHECK MAC ================= */
        if (
            String(oldData.mac_id).trim() !==
            String(mac_id).trim()
        ) {
            const macExists = await checkMacExistsModel(
                mac_id,
                Number(id)
            );

            if (macExists) {
                return res.status(400).json({
                    success: false,
                    message: `MAC ID ${mac_id} is already assigned to another device`
                });
            }

            const macData = await getUnregisteredMacsModel(mac_id);

            if (!macData) {
                return res.status(400).json({
                    success: false,
                    message: `MAC ID ${mac_id} is not available or already registered`
                });
            }
        }

        /* ================= AUTO DEVICE NAME ================= */
        const device_name = `${work_location}/${department}/${device_id}`;

        /* ================= SYNC MAC ================= */
        await syncMacAddressStatus(
            oldData.mac_id,
            mac_id
        );

        /* ================= UPDATE ================= */
        const data = await updateDeviceConfigurationModel(
            id,
            {
                device_id,
                mac_id,
                work_location,
                department,
                status,
                connection: connectionValue,
                device_name
            }
        );

        if (!data) {
            return res.status(404).json({
                success: false,
                message: "Device configuration not found"
            });
        }

        /* =====================================================
           ADD SETTING EDIT LOG
        ===================================================== */
        const fieldsToLog = [
            {
                field_name: "device_id",
                old_value: oldData.device_id,
                new_value: device_id
            },
            {
                field_name: "mac_id",
                old_value: oldData.mac_id,
                new_value: mac_id
            },
            {
                field_name: "work_location",
                old_value: oldData.work_location,
                new_value: work_location
            },
            {
                field_name: "department",
                old_value: oldData.department,
                new_value: department
            },
            {
                field_name: "connection",
                old_value: oldData.connection,
                new_value: connectionValue
            },
            {
                field_name: "status",
                old_value: oldData.status,
                new_value: status
            },
            {
                field_name: "device_name",
                old_value: oldData.device_name,
                new_value: device_name
            }
        ];

        for (const field of fieldsToLog) {
            const oldValue =
                field.old_value === null ||
                    field.old_value === undefined
                    ? null
                    : String(field.old_value);

            const newValue =
                field.new_value === null ||
                    field.new_value === undefined
                    ? null
                    : String(field.new_value);

            /* Only log changed fields */
            if (oldValue === newValue) {
                continue;
            }

            await addSettingEditLogModel({
                table_name: "device_configurations",
                record_id: Number(id),
                username,
                edited_by: username,
                field_name: field.field_name,
                old_value: oldValue,
                new_value: newValue
            });
        }

        /* ================= SOCKET EMIT ================= */
        const io = getIO();

        if (io) {
            io.emit(
                "device-configuration:updated",
                {
                    success: true,
                    message: "Device configuration updated",
                    data
                }
            );
        }

        /* ================= RESPONSE ================= */
        return res.json({
            success: true,
            message: "Device configuration updated successfully",
            data
        });

    } catch (error) {
        console.error("UPDATE DEVICE ERROR:", error);

        if (error.code === "23505") {
            return res.status(400).json({
                success: false,
                message: "MAC ID is already assigned to another device"
            });
        }
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= TOGGLE STATUS ================= */
export const toggleDeviceConfigurationStatus = async (req, res) => {
    try {
        const { id } = req.params;

        /* =====================================================
           CURRENT EDITOR
        ===================================================== */
        const editedBy =
            req.headers["x-username"]
                ? String(req.headers["x-username"]).trim()
                : null;

        /* =====================================================
           GET OLD DEVICE
        ===================================================== */
        const { rows } = await pool.query(
            `
                SELECT
                    connection,
                    status,
                    created_by
                FROM device_configurations
                WHERE id = $1
            `,
            [id]
        );

        if (!rows.length) {
            return res.status(404).json({
                success: false,
                message: "Device configuration not found"
            });
        }

        const device = rows[0];

        /* =====================================================
           ORIGINAL CREATOR
        ===================================================== */
        const logUsername =
            device.created_by !== undefined &&
                device.created_by !== null &&
                String(device.created_by).trim() !== ""
                ? String(device.created_by).trim()
                : null;

        /* =====================================================
           OLD STATUS
        ===================================================== */
        const oldStatus = Boolean(device.status);

        /* =====================================================
           DON'T ALLOW DISABLING OFFLINE DEVICE
        ===================================================== */
        if (
            device.connection === "offline" &&
            device.status === true
        ) {
            return res.status(400).json({
                success: false,
                message: "Offline device status cannot be changed to inactive."
            });
        }

        /* =====================================================
           TOGGLE DEVICE STATUS
        ===================================================== */
        const data = await toggleDeviceConfigurationStatusModel(id);

        if (!data) {
            return res.status(404).json({
                success: false,
                message: "Device configuration not found"
            });
        }

        /* =====================================================
           NEW STATUS
        ===================================================== */
        const newStatus = Boolean(data.status);

        /* =====================================================
           SETTING EDIT LOG
        ===================================================== */
        const settingLogs = [];

        /* ONLY LOG WHEN STATUS ACTUALLY CHANGES */
        if (oldStatus !== newStatus) {
            const log = await addSettingEditLogModel({
                table_name: "device_configurations",
                record_id: Number(id),
                username: logUsername,
                edited_by: editedBy,
                field_name: "status",
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
            io.emit("device-configuration:updated", {
                success: true,
                message: "Device configuration status updated",
                data,
                settingLogs
            });
        }

        /* =====================================================
           RESPONSE
        ===================================================== */
        return res.status(200).json({
            success: true,
            message: "Device status updated successfully",
            data,
            settingLogs
        });

    } catch (error) {
        console.error("TOGGLE DEVICE ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};