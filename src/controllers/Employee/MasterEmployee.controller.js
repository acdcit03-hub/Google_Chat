import { getIO } from "../../config/socket.js";
import { addInactiveEmployeeModel, getInactiveEmployeeByPersonalIdModel, removeInactiveEmployeeModel } from "../../models/Employee/inactive_employee.model.js";
import { getAllEmployeesModel, getMasterEmployeeByPersonalIdModel, updateEmployeeStatusModel } from "../../models/Employee/MasterEmployee.model.js";
import { addEmployeeEditLogModel } from "../../models/history/employee_edit_log.model.js";
import { validateEmployeeCategoryRequiredFields } from "../../models/settings/category.model.js";

/* ================= GET ALL ================= */
export const getAllEmployees = async (req, res) => {
    try {
        const data = await getAllEmployeesModel();

        /* ================= SOCKET EMIT ================= */
        const io = getIO();

        io.emit("employee:fetch", {
            success: true,
            message: "Fetch Employee status",
            data
        });

        return res.status(200).json({
            success: true,
            count: data.length,
            data
        });

    } catch (error) {
        console.error("GET ALL EMPLOYEES ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= GET BY PERSONAL ID ================= */
export const getMasterEmployeeByPersonalId = async (req, res) => {
    try {
        const { personal_details_id } = req.params;
        const data = await getMasterEmployeeByPersonalIdModel(personal_details_id);

        if (!data) {
            return res.status(404).json({
                success: false,
                message: "Employee not found"
            });
        }

        /* ================= SOCKET EMIT ================= */
        const io = getIO();

        io.emit("employee:fetch", {
            success: true,
            message: "Fetch Employee status",
            data
        });

        return res.status(200).json({
            success: true,
            data
        });

    } catch (error) {
        console.error("GET EMPLOYEE ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= UPDATE STATUS ================= */
export const updateEmployeeStatus = async (req, res) => {
    try {
        const { personal_details_id } = req.params;

        const {
            status,
            candidate_status,
            inactive_date,
            inactive_reason
        } = req.body;

        const normalizedStatus =
            status !== undefined &&
                status !== null
                ? String(status).trim()
                : "";

        const normalizedCandidateStatus =
            candidate_status !== undefined &&
                candidate_status !== null &&
                String(candidate_status).trim() !== ""
                ? String(candidate_status).trim()
                : null;

        /* =========================================================
           GET EXISTING INACTIVE RECORD
        ========================================================= */
        const existingInactiveEmployee =
            await getInactiveEmployeeByPersonalIdModel(
                personal_details_id
            );

        /* =========================================================
           VALIDATE INACTIVE DATA
        ========================================================= */
        if (normalizedStatus.toLowerCase() === "inactive") {
            if (
                !existingInactiveEmployee &&
                !inactive_date
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Inactive date is required"
                });
            }
        }

        /* =========================================================
           GET CURRENT EMPLOYEE
        ========================================================= */
        const employee = await getMasterEmployeeByPersonalIdModel(
            personal_details_id,
            normalizedStatus,
            normalizedCandidateStatus
        );

        if (!employee) {
            return res.status(404).json({
                success: false,
                message: "Employee not found"
            });
        }

        const previousStatus =
            employee.status
                ? String(employee.status).toLowerCase()
                : null;

        if (
            previousStatus === "active" &&
            normalizedStatus.toLowerCase() === "pending_approval"
        ) {
            return res.status(400).json({
                success: false,
                message: "Active employee cannot be moved back to pending_approval."
            });
        }

        /* =========================================================
           EMPLOYEE USERNAME
        ========================================================= */
        const employeeUsername =
            employee.username ||
            employee?.personal_details?.username ||
            null;

        /* =========================================================
           USER WHO PERFORMED EDIT
        ========================================================= */
        const editedBy = req.headers["x-username"]?.trim() || "null";

        /* =========================================================
           CHECK PERMANENT INACTIVE
        ========================================================= */
        const inactiveEmployee = await getInactiveEmployeeByPersonalIdModel(
            personal_details_id
        );

        if (
            inactiveEmployee &&
            status !== "inactive"
        ) {
            return res.status(400).json({
                success: false,
                message: "Employee is permanently inactive and status cannot be changed."
            });
        }

        /* =========================================================
           CHECK CATEGORY REQUIRED FIELDS BEFORE ACTIVE
        ========================================================= */
        let categoryValidation = null;

        if (
            normalizedStatus.toLowerCase() === "active"
        ) {
            categoryValidation = await validateEmployeeCategoryRequiredFields({
                personalDetailsId: personal_details_id
            });

            if (
                categoryValidation.shouldValidate &&
                !categoryValidation.valid
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Employee cannot be activated because required fields are missing.",
                    category: categoryValidation.category_name || null,
                    work_location: categoryValidation.work_location || null,
                    missing: categoryValidation.missing || []
                });
            }
        }

        /* =========================================================
           NOW UPDATE STATUS
        ========================================================= */
        const data = await updateEmployeeStatusModel(
            personal_details_id,
            normalizedStatus,
            normalizedCandidateStatus
        );

        /* =========================================================
           INACTIVE RECORD
        ========================================================= */
        let inactiveData = null;

        if (normalizedStatus.toLowerCase() === "inactive") {
            const finalInactiveDate =
                inactive_date ||
                existingInactiveEmployee?.inactive_date ||
                null;

            const finalInactiveReason =
                inactive_reason !== undefined &&
                    inactive_reason !== null &&
                    String(inactive_reason).trim() !== ""
                    ? String(inactive_reason).trim()
                    : existingInactiveEmployee?.inactive_reason || null;

            if (!finalInactiveDate) {
                return res.status(400).json({
                    success: false,
                    message: "Inactive date is required"
                });
            }

            inactiveData = await addInactiveEmployeeModel({
                personal_details_id,
                past_status:
                    existingInactiveEmployee?.past_status ||
                    previousStatus,
                inactive_date: finalInactiveDate,
                inactive_reason: finalInactiveReason
            });

        } else {
            await removeInactiveEmployeeModel(
                personal_details_id
            );
        }

        /* =========================================================
           RESPONSE DATA
        ========================================================= */
        const response = {
            ...data,
            inactive_date: inactiveData?.inactive_date || null,
            inactive_reason: inactiveData?.inactive_reason || null
        };

        /* =========================================================
           EMPLOYEE EDIT LOG
        ========================================================= */
        let employeeEditLog = null;

        const oldChangedValues = {
            status: previousStatus
        };

        const newChangedValues = {
            status
        };

        /* =========================================================
           ADD INACTIVE DETAILS TO LOG
        ========================================================= */
        if (normalizedStatus.toLowerCase() === "inactive") {
            oldChangedValues.inactive_date = inactiveEmployee?.inactive_date || null;
            oldChangedValues.inactive_reason = inactiveEmployee?.inactive_reason || null;
            newChangedValues.inactive_date = inactive_date;
            newChangedValues.inactive_reason = inactive_reason;
        }

        /* =========================================================
           CHECK ACTUAL CHANGE
        ========================================================= */
        const changedFields = [];

        if (previousStatus !== status) {
            changedFields.push("status");
        }

        if (normalizedStatus.toLowerCase() === "inactive") {
            if (
                String(
                    inactiveEmployee?.inactive_date || ""
                ) !== String(inactive_date || "")
            ) {
                changedFields.push("inactive_date");
            }

            if (
                String(
                    inactiveEmployee?.inactive_reason || ""
                ).trim() !==
                String(inactive_reason || "").trim()
            ) {
                changedFields.push("inactive_reason");
            }
        }

        /* =========================================================
           SAVE EDIT LOG
        ========================================================= */
        if (changedFields.length > 0) {
            employeeEditLog = await addEmployeeEditLogModel({
                personal_details_id: Number(personal_details_id),
                username: employeeUsername,
                edited_by: editedBy,
                action: "UPDATE",
                old_value: oldChangedValues,
                new_value: newChangedValues,
                description: `Employee status updated for ${employeeUsername}. Changed fields: ${changedFields.join(", ")}`
            });
        }

        /* =========================================================
           SOCKET EMIT
        ========================================================= */
        const io = getIO();

        if (io) {
            io.emit("employee:updated", {
                success: true,
                message: "Employee status updated",
                data: response
            });
        }

        /* =========================================================
           RESPONSE
        ========================================================= */
        return res.status(200).json({
            success: true,
            message: "Status updated successfully",
            data: response,
            employeeEditLog
        });

    } catch (error) {
        console.error("UPDATE STATUS ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};