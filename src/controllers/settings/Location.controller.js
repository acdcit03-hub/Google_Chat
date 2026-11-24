import { getIO } from "../../config/socket.js";
import { pool } from "../../database.js";
import { addSettingEditLogModel } from "../../models/history/setting_edit_log.model.js";
import { GetLocation, locationItems, toggleLocationStatusModel, updateLocationById, updateWorkLocationEverywhere } from "../../models/settings/Location.model.js";

/* ================= ADD ================= */
export const addLocation = async (req, res) => {
  try {
    const { location, address, city, state, zip } = req.body;

    /* ================= USERNAME ================= */
    const username =
      req.headers["x-store-username"] || null;

    if (!location || !location.trim()) {
      return res.status(400).json({
        message: "Location is required"
      });
    }

    const existing = await pool.query(
      `SELECT 1 FROM work_location WHERE LOWER(location) = LOWER($1)`,
      [location.trim()]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({
        message: "Location already exists"
      });
    }

    const saved = await locationItems({
      location,
      address,
      city,
      state,
      zip,
      created_by: username,
      status: true
    });

    /* ================= SOCKET EMIT ================= */
    const io = getIO();

    if (io) {
      io.emit("location:created", {
        success: true,
        message: "Location added successfully",
        data: saved
      });
    }

    return res.status(201).json({
      message: "Location added successfully",
      data: saved
    });

  } catch (error) {
    console.error("ADD LOCATION ERROR:", error);
    res.status(500).json({ message: "Internal Server Error" });
  }
};

/* ================= GET ================= */
export const getAllLocation = async (req, res) => {
  try {
    const { status } = req.query;

    let parsedStatus;

    if (status === "true") parsedStatus = true;
    else if (status === "false") parsedStatus = false;
    else parsedStatus = null;

    const data = await GetLocation(parsedStatus);

    /* ================= SOCKET EMIT ================= */
    const io = getIO();

    if (io) {
      io.emit("location:fetch", {
        success: true,
        message: "Locations fetched successfully",
        data
      });
    }

    res.json({
      message: "Location fetched successfully",
      data
    });

  } catch (error) {
    console.error("GET LOCATION ERROR:", error);
    res.status(500).json({ message: "Internal Server Error" });
  }
};

/* ================= UPDATE ================= */
export const updateLocation = async (req, res) => {
  try {
    const {
      location,
      address,
      city,
      state,
      zip,
      status
    } = req.body;

    const { id } = req.params;

    /* =====================================================
       VALIDATION
    ===================================================== */
    if (!id || !location || !location.trim()) {
      return res.status(400).json({
        success: false,
        message: "ID and Location required"
      });
    }

    const newLocation = location.trim();

    /* =====================================================
       CURRENT EDITOR FROM HEADER
    ===================================================== */
    const editedBy =
      req.headers["x-username"]
        ? String(req.headers["x-username"]).trim()
        : null;

    /* =====================================================
       GET OLD LOCATION
       IMPORTANT:
       Get created_by also.
    ===================================================== */
    const oldLocationResult = await pool.query(
      `
        SELECT *
        FROM work_location
        WHERE id = $1
      `,
      [id]
    );

    if (!oldLocationResult.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Location not found"
      });
    }

    const oldLocation = oldLocationResult.rows[0];

    /* =====================================================
      CHECK LOCATION STATUS
      INACTIVE LOCATION CANNOT BE UPDATED
    ===================================================== */

    if (oldLocation.status === false) {
      return res.status(400).json({
        success: false,
        message: "This location is inactive, so it cannot be updated."
      });
    }

    /* =====================================================
       ORIGINAL CREATOR

       setting_edit_log.username
       = work_location.created_by
    ===================================================== */
    const logUsername =
      oldLocation.created_by !== undefined &&
        oldLocation.created_by !== null &&
        String(oldLocation.created_by).trim() !== ""
        ? String(oldLocation.created_by).trim()
        : null;

    /* =====================================================
       OLD LOCATION NAME
    ===================================================== */
    const oldLocationName = String(oldLocation.location || "").trim();

    /* =====================================================
       CHECK DUPLICATE LOCATION
    ===================================================== */
    const duplicate = await pool.query(
      `
        SELECT id
        FROM work_location
        WHERE LOWER(TRIM(location)) =
              LOWER(TRIM($1))
          AND id <> $2
        LIMIT 1
      `,
      [
        newLocation,
        id
      ]
    );

    if (duplicate.rows.length) {
      return res.status(400).json({
        success: false,
        message: "Location already exists"
      });
    }

    /* =====================================================
       NORMALIZE STATUS
    ===================================================== */
    const normalizedStatus =
      status !== undefined
        ? Boolean(status)
        : oldLocation.status;

    /* =====================================================
       UPDATE LOCATION EVERYWHERE
       ONLY IF NAME CHANGED
    ===================================================== */
    let locationUpdateResult = null;

    if (
      oldLocationName.toLowerCase() !==
      newLocation.toLowerCase()
    ) {
      locationUpdateResult =
        await updateWorkLocationEverywhere(
          id,
          oldLocationName,
          newLocation
        );
    }

    /* =====================================================
       UPDATE MAIN LOCATION
    ===================================================== */
    const updated = await updateLocationById(
      id,
      {
        location: newLocation,
        address,
        city,
        state,
        zip,
        created_by: undefined,
        status: normalizedStatus
      }
    );

    if (!updated) {
      return res.status(404).json({
        success: false,
        message: "Location not found"
      });
    }

    /* =====================================================
       FIELDS TO LOG
    ===================================================== */
    const logFields = [
      "location",
      "address",
      "city",
      "state",
      "zip",
      "status"
    ];

    /* =====================================================
       NORMALIZE VALUE
    ===================================================== */
    const normalizeLogValue = (value) => {

      if (
        value === undefined ||
        value === null
      ) {
        return null;
      }

      if (typeof value === "boolean") {
        return String(value);
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
       CREATE SETTING EDIT LOGS
    ===================================================== */
    const settingLogs = [];
    for (const field of logFields) {

      const oldValue = normalizeLogValue(
        oldLocation[field]
      );

      const newValue = normalizeLogValue(
        updated[field]
      );

      /* ONLY LOG CHANGED FIELD */
      if (oldValue === newValue) {
        continue;
      }

      const log = await addSettingEditLogModel({
        table_name: "work_location",
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
      io.emit("location:updated", {
        success: true,
        message: "Location updated successfully",
        data: updated,
        locationUpdate: locationUpdateResult,
        settingLogs
      });
    }

    /* =====================================================
       RESPONSE
    ===================================================== */
    return res.status(200).json({
      success: true,
      message: "Location updated successfully",
      data: updated,
      locationUpdate: locationUpdateResult,
      settingLogs
    });

  } catch (error) {
    console.error("LOCATION UPDATE ERROR:", error);
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

/* ================= TOGGLE STATUS ================= */
export const toggleLocationStatus = async (req, res) => {
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
       GET OLD LOCATION
    ===================================================== */
    const oldLocationResult = await pool.query(
      `
        SELECT
          id,
          status,
          created_by
        FROM work_location
        WHERE id = $1
      `,
      [id]
    );

    /* ================= NOT FOUND ================= */
    if (!oldLocationResult.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Location not found"
      });
    }

    const oldLocation = oldLocationResult.rows[0];

    /* =====================================================
       ORIGINAL CREATOR
       
       setting_edit_log.username = work_location.created_by
    ===================================================== */
    const logUsername =
      oldLocation.created_by !== undefined &&
        oldLocation.created_by !== null &&
        String(oldLocation.created_by).trim() !== ""
        ? String(oldLocation.created_by).trim()
        : null;

    /* =====================================================
       OLD STATUS
    ===================================================== */
    const oldStatus = Boolean(oldLocation.status);

    /* =====================================================
       TOGGLE LOCATION STATUS
    ===================================================== */
    const updated = await toggleLocationStatusModel(id);

    /* ================= NOT FOUND ================= */
    if (!updated) {
      return res.status(404).json({
        success: false,
        message: "Location not found"
      });
    }

    /* ================= USED BY EMPLOYEE ================= */
    if (updated.blocked) {
      return res.status(400).json({
        success: false,
        message: updated.message,
        used_count: updated.used_count
      });
    }

    /* =====================================================
       NEW STATUS
    ===================================================== */
    const newStatus = Boolean(updated.status);

    /* =====================================================
       SETTING EDIT LOG
    ===================================================== */
    const settingLogs = [];

    if (oldStatus !== newStatus) {
      const log = await addSettingEditLogModel({
        table_name: "work_location",
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
       SOCKET
    ===================================================== */
    const io = getIO();

    if (io) {
      io.emit("location:status-updated", {
        success: true,
        message:
          `Location ${newStatus
            ? "activated"
            : "deactivated"
          } successfully`,
        data: updated,
        settingLogs
      });
    }

    /* ================= RESPONSE ================= */
    return res.status(200).json({
      success: true,
      message:
        `Location ${newStatus
          ? "activated"
          : "deactivated"
        } successfully`,
      data: updated,
      settingLogs
    });

  } catch (error) {
    console.error("TOGGLE LOCATION STATUS ERROR:", error);
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};
