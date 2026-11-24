import { getIO } from "../../config/socket.js";
import { addDepartmentModel, getAllDepartmentsModel, toggleDepartmentStatusModel, updateDepartmentModel } from "../../models/settings/Deparments.model.js";

/* ================= ADD ================= */
export const addDepartment = async (req, res) => {
  try {
    const { department_name, description } = req.body;

    const created_by =
      req.headers["x-hrms-username"] || null;

    const department = await addDepartmentModel({
      department_name,
      description,
      created_by,
      status: true
    });

    /* ================= SOCKET EMIT ================= */
    const io = getIO();

    if (io) {
      io.emit("department:created", {
        success: true,
        message: "Department added successfully",
        data: department
      });
    }

    return res.status(201).json({
      success: true,
      message: "Department added successfully",
      data: department
    });

  } catch (error) {
    console.error("ADD DEPARTMENT ERROR:", error);
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

/* ================= GET ================= */
export const getAllDepartments = async (req, res) => {
  try {
    const { status } = req.query;
    const data = await getAllDepartmentsModel(status);

    /* ================= SOCKET EMIT ================= */
    const io = getIO();

    if (io) {
      io.emit("department:fetch", {
        success: true,
        message: "Departments fetched successfully",
        data
      });
    }

    return res.json({
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

/* ================= UPDATE ================= */
export const updateDepartment = async (req, res) => {
  try {
    const { id } = req.params;
    const created_by =
      req.headers["x-store-username"] || null;

    const department = await updateDepartmentModel(id, {
      ...req.body,
      created_by
    });

    if (!department) {
      return res.status(404).json({
        success: false,
        message: "Department not found"
      });
    }

    /* ================= SOCKET EMIT ================= */
    const io = getIO();

    if (io) {
      io.emit("department:updated", {
        success: true,
        message: "Department updated successfully",
        data: department
      });
    }

    return res.json({
      success: true,
      message: "Department updated successfully",
      data: department
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
export const toggleDepartmentStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const department = await toggleDepartmentStatusModel(id);

    if (!department) {
      return res.status(404).json({
        success: false,
        message: "Department not found"
      });
    }

    /* ================= SOCKET EMIT ================= */
    const io = getIO();

    if (io) {
      io.emit("department:status-updated", {
        success: true,
        message: "Department status updated successfully",
        data: department
      });
    }

    return res.json({
      success: true,
      message: "Department status updated successfully",
      data: department
    });

  } catch (error) {
    console.error("TOGGLE DEPARTMENT ERROR:", error);
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};