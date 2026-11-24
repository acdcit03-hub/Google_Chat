import { getIO } from "../../config/socket.js";
import { pool } from "../../database.js";
import { addSettingEditLogModel } from "../../models/history/setting_edit_log.model.js";
import { addShiftModel, getAllShiftsModel, toggleShiftStatusModel, updateShiftEverywhere, updateShiftModel } from "../../models/settings/ShiftConfigurations.model.js";

/* ================= ADD SHIFT ================= */
export const addShift = async (req, res) => {
  try {

    const username = req.headers["x-username"]
      ? String(req.headers["x-username"]).trim()
      : null;

    const shift = await addShiftModel({
      ...req.body,
      created_by: username
    });

    /* ================= SOCKET EMIT ================= */
    const io = getIO();

    if (io) {
      io.emit("shift:created", {
        success: true,
        message: "Shift created successfully",
        data: shift
      });
    }

    return res.status(201).json({
      success: true,
      message: "Shift created successfully",
      data: shift
    });

  } catch (error) {
    console.error("ADD SHIFT ERROR : ", error);
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

/* ================= GET SHIFTS ================= */
export const getAllShifts = async (req, res) => {

  try {

    const { work_location } = req.query;

    const data = await getAllShiftsModel({
      work_location
    });

    const io = getIO();

    if (io) {
      io.emit("shift:fetch", {
        success: true,
        message: "Shifts fetched successfully",
        data
      });
    }

    return res.status(200).json({
      success: true,
      message: "Shifts fetched successfully",
      data
    });

  } catch (error) {

    console.error(
      "GET ALL SHIFTS ERROR:",
      error
    );

    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

/* ================= UPDATE SHIFT ================= */
export const updateShift = async (req, res) => {
  try {

    const { id } = req.params;

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
       GET OLD SHIFT
    ===================================================== */
    const oldShiftResult = await pool.query(
      `
        SELECT *
        FROM shift_configurations
        WHERE id = $1
      `,
      [id]
    );

    if (!oldShiftResult.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Shift not found"
      });
    }

    const oldShift = oldShiftResult.rows[0];

    /* =====================================================
      CHECK SHIFT STATUS
      INACTIVE SHIFT CANNOT BE UPDATED
    ===================================================== */

    if (oldShift.status === false) {
      return res.status(400).json({
        success: false,
        message: "This shift is inactive, so it cannot be updated."
      });
    }

    /* =====================================================
       UPDATE MAIN SHIFT
    ===================================================== */
    const shift = await updateShiftModel(
      id,
      req.body
    );

    if (!shift) {
      return res.status(404).json({
        success: false,
        message: "Shift not found"
      });
    }

    /* =====================================================
       UPDATE ALL TABLES
    ===================================================== */
    const updateResult = await updateShiftEverywhere(
      oldShift,
      shift
    );

    /* =====================================================
      SETTING EDIT LOG
    ===================================================== */
    const logUsername =
      oldShift.created_by !== undefined &&
        oldShift.created_by !== null &&
        String(oldShift.created_by).trim() !== ""
        ? String(oldShift.created_by).trim()
        : null;

    /* =====================================================
      FIELDS TO LOG
    ===================================================== */
    const logFields = [
      "shift_name",
      "shift_type",
      "start_time",
      "end_time",
      "break_start_time",
      "break_end_time",
      "shift_reset_time",
      "early_leave_count_time",
      "late_arrival_count_time",
      "days",
      "description",
      "status",
      "work_location"
    ];

    /* =====================================================
      NORMALIZE VALUE
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

      const oldValue =
        normalizeLogValue(oldShift[field]);

      const newValue =
        normalizeLogValue(shift[field]);

      /* ================================================
        ONLY LOG CHANGED VALUES
      ================================================ */
      if (oldValue === newValue) {
        continue;
      }

      const log = await addSettingEditLogModel({
        table_name: "shift_configurations",
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
      io.emit("shift:updated", {
        success: true,
        message: "Shift updated successfully",
        data: shift,
        updateResult,
        settingLogs
      });
    }

    /* =====================================================
       RESPONSE
    ===================================================== */
    return res.status(200).json({
      success: true,
      message: "Shift updated successfully",
      data: shift,
      updateResult,
      settingLogs
    });

  } catch (error) {
    console.error("UPDATE SHIFT ERROR:", error);
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

/* ================= TOGGLE SHIFT STATUS ================= */
export const toggleShiftStatus = async (req, res) => {
  try {
    const { id } = req.params;

    /* =====================================================
       GET OLD SHIFT
    ===================================================== */
    const oldShiftResult = await pool.query(
      `
        SELECT
          id,
          status,
          created_by
        FROM shift_configurations
        WHERE id = $1
      `,
      [id]
    );

    /* ================= SHIFT NOT FOUND ================= */
    if (!oldShiftResult.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Shift not found"
      });
    }

    const oldShift = oldShiftResult.rows[0];

    /* =====================================================
       GET CURRENT EDITOR
    ===================================================== */
    const editedBy =
      req.headers["x-username"]
        ? String(req.headers["x-username"]).trim()
        : null;

    /* =====================================================
       ORIGINAL CREATOR
    ===================================================== */
    const logUsername =
      oldShift.created_by !== undefined &&
        oldShift.created_by !== null &&
        String(oldShift.created_by).trim() !== ""
        ? String(oldShift.created_by).trim()
        : null;

    /* =====================================================
       TOGGLE SHIFT STATUS
    ===================================================== */
    const shift = await toggleShiftStatusModel(id);

    /* ================= SHIFT NOT FOUND ================= */
    if (!shift) {
      return res.status(404).json({
        success: false,
        message: "Shift not found"
      });
    }

    /* ================= SHIFT IS IN USE ================= */
    if (shift.blocked) {
      return res.status(400).json({
        success: false,
        message: shift.message,
        used_count: shift.used_count
      });
    }

    /* =====================================================
       OLD & NEW STATUS
    ===================================================== */
    const oldStatus =
      oldShift.status === true
        ? "true"
        : "false";

    const newStatus =
      shift.status === true
        ? "true"
        : "false";

    /* =====================================================
       ADD SETTING EDIT LOG
    ===================================================== */
    let settingLog = null;

    if (oldStatus !== newStatus) {
      settingLog = await addSettingEditLogModel({
        table_name: "shift_configurations",
        record_id: Number(id),
        username: logUsername,
        edited_by: editedBy,
        field_name: "status",
        old_value: oldStatus,
        new_value: newStatus
      });
    }

    /* =====================================================
       SOCKET EMIT
    ===================================================== */
    const io = getIO();

    if (io) {
      io.emit("shift:status-updated", {
        success: true,
        message: "Shift status updated successfully",
        data: shift,
        settingLog
      });
    }

    /* =====================================================
       RESPONSE
    ===================================================== */
    return res.status(200).json({
      success: true,
      message: "Shift status updated successfully",
      data: shift,
      settingLog
    });

  } catch (error) {
    console.error("TOGGLE SHIFT STATUS ERROR:", error);
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};