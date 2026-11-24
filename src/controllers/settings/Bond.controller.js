import { getIO } from "../../config/socket.js";
import { pool } from "../../database.js";
import { addSettingEditLogModel } from "../../models/history/setting_edit_log.model.js";
import { addBondOptionModel, checkDuplicateBondDurationModel, getAllBondOptionsModel, getBondOptionByIdModel, toggleBondOptionStatusModel, updateBondEverywhere, updateBondOptionModel } from "../../models/settings/Bond.model.js";

/* ================= ADD BOND ================= */
export const addBondOption = async (req, res) => {
    try {
        const result = await addBondOptionModel(req.body);

        /* ================= SOCKET EMIT ================= */
        const io = getIO();

        if (io) {
            io.emit("bond:created", {
                success: true,
                message: "Bond option added successfully",
                data: result
            });
        }

        return res.status(201).json({
            success: true,
            message: "Bond option added successfully",
            data: result
        });

    } catch (error) {
        console.error(error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= GET ALL ================= */
export const getAllBondOptions = async (req, res) => {
    try {
        const { work_location } = req.query;

        const data = await getAllBondOptionsModel({
            work_location
        });

        /* ================= SOCKET EMIT ================= */
        const io = getIO();

        if (io) {
            io.emit("bond:fetch", {
                success: true,
                message: "Bond option fetched successfully",
                data
            });
        }

        return res.json({
            success: true,
            message: "Bond option fetched successfully",
            data
        });

    } catch (error) {
        console.error(error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= GET BY ID ================= */
export const getBondOptionById = async (req, res) => {
    try {
        const data = await getBondOptionByIdModel(req.params.id);

        if (!data) {
            return res.status(404).json({
                success: false,
                message: "Bond option not found"
            });
        }

        /* ================= SOCKET EMIT ================= */
        const io = getIO();

        if (io) {
            io.emit("bond:fetch", {
                success: true,
                message: "Bond option fetched successfully",
                data
            });
        }

        return res.json({
            success: true,
            message: "Bond option by id Fetched successfully",
            data
        });

    } catch (error) {
        console.error(error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= UPDATE BOND ================= */
export const updateBondOption = async (req, res) => {
    try {
        const { id } = req.params;

        /* =====================================================
           GET OLD BOND
        ===================================================== */
        const oldBond = await getBondOptionByIdModel(id);

        if (!oldBond) {
            return res.status(404).json({
                success: false,
                message: "Bond option not found"
            });
        }

        /* =====================================================
           CHECK BOND STATUS
           INACTIVE BOND CANNOT BE UPDATED
        ===================================================== */

        if (oldBond.status === false) {
            return res.status(400).json({
                success: false,
                message: "This bond option is inactive, so it cannot be updated."
            });
        }

        /* =====================================================
           GET EDITED BY FROM HEADER
           x-username = current user who is updating
        ===================================================== */
        const editedBy =
            req.headers["x-username"]
                ? String(req.headers["x-username"]).trim()
                : null;

        if (!editedBy) {
            return res.status(400).json({
                success: false,
                message: "x-username header is required"
            });
        }

        /* =====================================================
           USERNAME FOR LOG
           
           created_by = original creator of bond
        ===================================================== */
        const logUsername =
            oldBond.created_by !== undefined &&
                oldBond.created_by !== null &&
                String(oldBond.created_by).trim() !== ""
                ? String(oldBond.created_by).trim()
                : null;

        /* =====================================================
           OLD BOND DURATION
        ===================================================== */
        const oldBondDuration = String(oldBond.bond_duration || "").trim();
        const newBondDuration = String(req.body.bond_duration || "").trim();

        /* =====================================================
           VALIDATE BOND DURATION
        ===================================================== */
        if (!newBondDuration) {
            return res.status(400).json({
                success: false,
                message: "Bond duration is required"
            });
        }

        /* =====================================================
           RESOLVE WORK LOCATION
        ===================================================== */
        let newWorkLocationId = oldBond.work_location;

        const workLocationValue =
            req.body.work_location !== undefined &&
                req.body.work_location !== null &&
                String(req.body.work_location).trim() !== ""
                ? String(req.body.work_location).trim()
                : null;

        if (workLocationValue) {
            let locationResult;

            /* =================================================
               FRONTEND SENT LOCATION ID
            ================================================= */
            if (/^\d+$/.test(workLocationValue)) {
                locationResult = await pool.query(
                    `
                        SELECT id, location
                        FROM work_location
                        WHERE id = $1
                        LIMIT 1
                    `,
                    [Number(workLocationValue)]
                );
            }

            /* =================================================
               FRONTEND SENT LOCATION NAME
            ================================================= */
            else {
                locationResult = await pool.query(
                    `
                        SELECT id, location
                        FROM work_location
                        WHERE LOWER(TRIM(location))
                            = LOWER(TRIM($1))
                        LIMIT 1
                    `,
                    [workLocationValue]
                );
            }

            if (!locationResult.rows.length) {
                return res.status(404).json({
                    success: false,
                    message: `Work location "${workLocationValue}" not found`
                });
            }

            newWorkLocationId = locationResult.rows[0].id;
        }

        /* =====================================================
           VALIDATE LOCATION ID
        ===================================================== */
        newWorkLocationId = Number(newWorkLocationId);

        if (!Number.isInteger(newWorkLocationId)) {
            return res.status(400).json({
                success: false,
                message: "Valid work location is required"
            });
        }

        /* =====================================================
           GET LOCATION
        ===================================================== */
        const locationResult = await pool.query(
            `
                SELECT id, location
                FROM work_location
                WHERE id = $1
                LIMIT 1
            `,
            [newWorkLocationId]
        );

        if (!locationResult.rows.length) {
            return res.status(404).json({
                success: false,
                message: `Work location ID "${newWorkLocationId}" not found`
            });
        }

        const newWorkLocationName = locationResult.rows[0].location;

        /* =====================================================
           CHECK DUPLICATE
        ===================================================== */
        const isDuplicate = await checkDuplicateBondDurationModel(
            Number(id),
            newBondDuration,
            newWorkLocationId
        );

        if (isDuplicate) {
            return res.status(409).json({
                success: false,
                message: `Bond duration "${newBondDuration}" already exists for work location "${newWorkLocationName}".`
            });
        }

        /* =====================================================
           PREPARE UPDATE DATA
        ===================================================== */
        const updateData = {
            ...req.body,
            work_location: newWorkLocationId
        };

        /* =====================================================
           UPDATE MAIN BOND
        ===================================================== */
        const result = await updateBondOptionModel(
            Number(id),
            updateData
        );

        if (!result) {
            return res.status(404).json({
                success: false,
                message: "Bond option not found"
            });
        }

        /* =====================================================
           UPDATE BOND EVERYWHERE
        ===================================================== */
        let updateResult = null;

        if (
            oldBondDuration &&
            newBondDuration &&
            oldBondDuration !== newBondDuration
        ) {
            updateResult = await updateBondEverywhere(
                Number(id),
                oldBondDuration,
                newBondDuration,
                newWorkLocationId
            );
        }

        /* =====================================================
           SETTING EDIT LOG
        ===================================================== */
        const logFields = [
            "bond_duration",
            "bond_type",
            "work_location",
            "description",
            "status"
        ];

        /* =====================================================
           NORMALIZE LOG VALUE
        ===================================================== */
        const normalizeLogValue = (value) => {
            if (value === undefined || value === null) {
                return null;
            }

            if (Array.isArray(value)) {
                return value
                    .map(item =>
                        String(item)
                            .trim()
                            .toUpperCase()
                    )
                    .filter(Boolean)
                    .join(", ");
            }

            return String(value).trim();
        };

        /* =====================================================
           CREATE LOG FOR CHANGED FIELDS
        ===================================================== */
        const settingLogs = [];

        for (const field of logFields) {
            let oldValue;
            let newValue;

            /* ================================================
               WORK LOCATION
            ================================================ */
            if (field === "work_location") {
                oldValue = normalizeLogValue(
                    oldBond.work_location
                );

                newValue = normalizeLogValue(
                    result.work_location
                );

            } else {
                oldValue = normalizeLogValue(
                    oldBond[field]
                );

                newValue = normalizeLogValue(
                    result[field]
                );
            }

            /* ================================================
               ONLY LOG CHANGED VALUES
            ================================================ */
            if (oldValue === newValue) {
                continue;
            }

            const log = await addSettingEditLogModel({
                table_name: "bond_options",
                record_id: Number(id),
                username: logUsername,
                edited_by: editedBy,
                field_name: field,
                old_value: oldValue,
                new_value: newValue
            });
            settingLogs.push(log);
        }

        /* =====================================================
           SOCKET
        ===================================================== */
        const io = getIO();
        if (io) {
            io.emit("bond:updated", {
                success: true,
                message: "Bond option updated successfully",
                data: result,
                updateResult,
                settingLogs
            });
        }

        /* =====================================================
           RESPONSE
        ===================================================== */
        return res.status(200).json({
            success: true,
            message: "Bond option updated successfully",
            data: result,
            updateResult,
            settingLogs
        });

    } catch (error) {
        console.error("UPDATE BOND ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= TOGGLE STATUS ================= */
export const toggleBondOptionStatus = async (req, res) => {
    try {
        const { id } = req.params;

        /* =====================================================
           GET CURRENT EDITOR
        ===================================================== */
        const editedBy =
            req.headers["x-username"]
                ? String(req.headers["x-username"]).trim()
                : null;

        /* =====================================================
           GET OLD BOND OPTION
        ===================================================== */
        const oldBondResult = await pool.query(
            `
                SELECT
                    id,
                    status,
                    created_by
                FROM bond_options
                WHERE id = $1
            `,
            [id]
        );

        if (!oldBondResult.rows.length) {
            return res.status(404).json({
                success: false,
                message: "Bond option not found"
            });
        }

        const oldBond = oldBondResult.rows[0];

        /* =====================================================
           ORIGINAL CREATOR
           setting_edit_log.username = bond_options.created_by
        ===================================================== */
        const logUsername =
            oldBond.created_by !== undefined &&
                oldBond.created_by !== null &&
                String(oldBond.created_by).trim() !== ""
                ? String(oldBond.created_by).trim()
                : null;

        /* =====================================================
           OLD STATUS
        ===================================================== */
        const oldStatus = Boolean(oldBond.status);

        /* =====================================================
           TOGGLE STATUS
        ===================================================== */
        const result = await toggleBondOptionStatusModel(id);

        /* ================= NOT FOUND ================= */
        if (!result) {
            return res.status(404).json({
                success: false,
                message: "Bond option not found"
            });
        }

        /* ================= USED BY EMPLOYEE ================= */
        if (result.blocked) {
            return res.status(400).json({
                success: false,
                message: result.message,
                used_count: result.used_count
            });
        }

        /* =====================================================
           NEW STATUS
        ===================================================== */
        const newStatus = Boolean(result.status);

        /* =====================================================
           ADD STATUS EDIT LOG
           ONLY IF STATUS ACTUALLY CHANGED
        ===================================================== */
        const settingLogs = [];

        if (oldStatus !== newStatus) {
            const log = await addSettingEditLogModel({
                table_name: "bond_options",
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
            io.emit("bond:status-updated", {
                success: true,
                message: "Bond option status updated successfully",
                data: result,
                settingLogs
            });
        }

        /* =====================================================
           RESPONSE
        ===================================================== */
        return res.status(200).json({
            success: true,
            message: "Status updated successfully",
            data: result,
            settingLogs
        });

    } catch (error) {
        console.error("TOGGLE BOND OPTION STATUS ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};