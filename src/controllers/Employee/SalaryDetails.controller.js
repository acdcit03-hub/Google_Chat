import { getIO } from "../../config/socket.js";
import { getPersonalDetailsByIdModel } from "../../models/Employee/PersonalDetails.model.js";
import { addSalaryModel, getAllSalaryModel, getSalaryByIdModel, updateSalaryModel } from "../../models/Employee/SalaryDetails.models.js";
import { addEmployeeEditLogModel } from "../../models/history/employee_edit_log.model.js";

/* ================= ADD ================= */
export const addSalary = async (req, res) => {
    try {
        const {
            personal_details_id,
            current_salary,
            next_increment_date
        } = req.body;

        const employee = await getPersonalDetailsByIdModel(
            personal_details_id
        );

        if (!employee) {
            return res.status(404).json({
                success: false,
                message: "Employee not found"
            });
        }

        const saved = await addSalaryModel({
            personal_details_id,
            current_salary,
            next_increment_date
        });

        /* ================= SOCKET EMIT ================= */
        const io = getIO();

        io.emit("employee:created", {
            success: true,
            message: "New salary added",
            data: saved
        });

        return res.status(201).json({
            success: true,
            message: "Salary added successfully",
            data: saved
        });

    } catch (error) {
        console.error("ADD SALARY ERROR:", error);

        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= GET ALL ================= */
export const getAllSalary = async (req, res) => {
    try {
        const data = await getAllSalaryModel();

        /* ================= SOCKET EMIT ================= */
        const io = getIO();

        io.emit("employee:fetch", {
            success: true,
            message: "Fetch salary",
            data
        });

        return res.json({
            success: true,
            message: "Salary fetch successfully",
            data
        });

    } catch (error) {
        console.error("GET SALARY ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= GET BY ID ================= */
export const getSalaryById = async (req, res) => {
    try {
        const { id } = req.params;

        const data = await getSalaryByIdModel(id);

        if (!data) {
            return res.status(404).json({
                success: false,
                message: "Record not found"
            });
        }

        /* ================= SOCKET EMIT ================= */
        const io = getIO();

        io.emit("employee:fetch", {
            success: true,
            message: "Fetch salary",
            data
        });

        return res.json({
            success: true,
            message: "Salary fetch successfully",
            data
        });

    } catch (error) {
        console.error("GET SALARY ERROR:", error);

        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= UPDATE ================= */
export const updateSalary = async (req, res) => {
    try {
        const { id } = req.params;

        /* =========================================================
           GET OLD SALARY DATA
        ========================================================= */
        const existing = await getSalaryByIdModel(id);

        if (!existing) {
            return res.status(404).json({
                success: false,
                message: "Record not found"
            });
        }

        /* =========================================================
           EMPLOYEE USERNAME
           
           IMPORTANT:
           Salary table should have personal_details_id.
        ========================================================= */
        const personalDetailsId =
            existing.personal_details_id ??
            existing.personal_id ??
            null;

        let employeeUsername = null;

        if (personalDetailsId) {
            const personalData = await getPersonalDetailsByIdModel(
                personalDetailsId
            );

            employeeUsername =
                personalData?.personal_details?.username ||
                personalData?.username ||
                null;
        }

        /* =========================================================
           USER WHO PERFORMED EDIT
        ========================================================= */
        const editedBy = req.headers["x-username"]?.trim() || "null";

        /* =========================================================
           PREPARE UPDATE DATA
        ========================================================= */
        const updateData = {
            current_salary:
                req.body.current_salary !== undefined &&
                    req.body.current_salary !== ""
                    ? req.body.current_salary
                    : existing.current_salary,

            next_increment_date:
                req.body.next_increment_date !== undefined
                    ? (
                        req.body.next_increment_date === ""
                            ? null
                            : req.body.next_increment_date
                    )
                    : existing.next_increment_date
        };

        /* =========================================================
           UPDATE SALARY
        ========================================================= */
        const updated = await updateSalaryModel(
            id,
            updateData
        );

        if (!updated) {
            return res.status(404).json({
                success: false,
                message: "Salary record not found"
            });
        }

        /* =========================================================
           FIELDS TO TRACK
        ========================================================= */
        const fields = [
            "current_salary",
            "next_increment_date"
        ];

        const oldChangedValues = {};
        const newChangedValues = {};

        /* =========================================================
           DATE FORMAT
        ========================================================= */
        const formatSalaryDate = (value) => {
            if (
                value === null ||
                value === undefined ||
                value === ""
            ) {
                return null;
            }

            if (typeof value === "string") {
                if (
                    /^\d{4}-\d{2}-\d{2}$/.test(value)
                ) {
                    return value;
                }

                if (
                    /^\d{4}-\d{2}-\d{2}T/.test(value)
                ) {
                    return value.substring(0, 10);
                }
            }

            if (value instanceof Date) {
                if (isNaN(value.getTime())) {
                    return null;
                }

                return value.toLocaleDateString(
                    "en-CA",
                    {
                        timeZone: "Asia/Kolkata"
                    }
                );
            }

            return String(value);
        };

        /* =========================================================
           FIND CHANGED VALUES
        ========================================================= */
        for (const field of fields) {
            let oldValue = existing?.[field] ?? null;
            let newValue =
                updated?.[field] ??
                updateData?.[field] ??
                null;

            /* =====================================================
               DATE FIELDS
            ===================================================== */
            if (
                field === "next_increment_date"
            ) {
                oldValue = formatSalaryDate(oldValue);
                newValue = formatSalaryDate(newValue);
            }

            /* =====================================================
               SALARY NUMBER
            ===================================================== */
            if (
                field === "current_salary"
            ) {
                if (
                    oldValue !== null &&
                    oldValue !== undefined &&
                    oldValue !== ""
                ) {
                    oldValue = Number(oldValue);
                }

                if (
                    newValue !== null &&
                    newValue !== undefined &&
                    newValue !== ""
                ) {
                    newValue = Number(newValue);
                }
            }

            /* =====================================================
               COMPARE
            ===================================================== */
            const oldCompare =
                oldValue === null ||
                    oldValue === undefined
                    ? ""
                    : String(oldValue).trim();

            const newCompare =
                newValue === null ||
                    newValue === undefined
                    ? ""
                    : String(newValue).trim();

            /* =====================================================
               ONLY CHANGED FIELDS
            ===================================================== */
            if (oldCompare !== newCompare) {
                oldChangedValues[field] = oldValue;
                newChangedValues[field] = newValue;
            }
        }

        /* =========================================================
           CHANGED FIELDS
        ========================================================= */
        const changedFields = Object.keys(oldChangedValues);

        /* =========================================================
           EMPLOYEE EDIT LOG
           
           username  = EMPLOYEE BEING EDITED
           edited_by = USER WHO PERFORMED EDIT
        ========================================================= */
        let employeeEditLog = null;

        if (changedFields.length > 0) {
            employeeEditLog = await addEmployeeEditLogModel({
                personal_details_id:
                    personalDetailsId
                        ? Number(personalDetailsId)
                        : null,

                username: employeeUsername,
                edited_by: editedBy,
                action: "UPDATE",
                old_value: oldChangedValues,
                new_value: newChangedValues,
                description: `Salary updated for ${employeeUsername || personalDetailsId || id}. Changed fields: ${changedFields.join(", ")}`
            });
        }

        /* =========================================================
           SOCKET EMIT
        ========================================================= */
        const io = getIO();

        if (io) {
            io.emit("employee:updated", {
                success: true,
                message: "Update salary",
                data: updated
            });
        }

        /* =========================================================
           RESPONSE
        ========================================================= */
        return res.json({
            success: true,
            message: "Salary updated successfully",
            data: updated,
            employeeEditLog
        });

    } catch (error) {
        console.error("UPDATE SALARY ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};