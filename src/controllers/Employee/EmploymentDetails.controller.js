import { getIO } from "../../config/socket.js";
import { pool } from "../../database.js";
import { uploadToCloudinary } from "../../middleware/cloudinaryUpload.js";

import {
    addEmploymentDetailsModel,
    generateEmploymentId,
    getAllEmploymentDetailsModel,
    getBondId,
    getCategoryId,
    getEmploymentDetailsByIdModel,
    getShiftConfigurationId,
    getWorkLocationId,
    updateEmploymentDetailsModel,
    updateEmploymentId
} from "../../models/Employee/EmploymentDetails.model.js";

import {
    getPersonalDetailsByIdModel
} from "../../models/Employee/PersonalDetails.model.js";
import { addEmployeeEditLogModel } from "../../models/history/employee_edit_log.model.js";
import { getDepartmentStructureId } from "../../models/settings/Department_structure.model.js";
import { formatDateOnly } from "./PersonalDetails.controller.js";

const offerLetterFileFromRequest = (req) => {
    const files = Array.isArray(req.files) ? req.files : [];
    return files.find((file) => file.fieldname === "offer_letter") || null;
};

const uploadOfferLetter = async (file, username) => {
    if (!file?.buffer) return null;

    const safeName = String(username || "EMPLOYEE")
        .trim()
        .replace(/\s+/g, "_")
        .toUpperCase();

    const result = await uploadToCloudinary(
        file.buffer,
        `${safeName}-OFFER-LETTER`,
        safeName,
        file.mimetype
    );

    return result?.secure_url || null;
};

/* =========================================================
   DATE CLEAN HELPER
========================================================= */
const cleanDateValue = (value) => {
    if (
        value === null ||
        value === undefined ||
        value === ""
    ) {
        return null;
    }

    if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) {
            return null;
        }

        return formatDateOnly(value);
    }

    if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value)
    ) {
        if (value.$d instanceof Date) {
            return cleanDateValue(value.$d);
        }

        if (typeof value.format === "function") {
            try {
                return cleanDateValue(value.format("YYYY-MM-DD"));
            } catch {
                return null;
            }
        }
    }

    if (typeof value === "number" && Number.isFinite(value)) {
        const fromNumber = new Date(value);

        if (Number.isNaN(fromNumber.getTime())) {
            return null;
        }

        return formatDateOnly(fromNumber);
    }

    let date = String(value)
        .trim()
        .replace(/^["']+|["']+$/g, "")
        .trim();

    if (!date || date === "\\") {
        return null;
    }

    /* ================= ISO / DATETIME ================= */
    const dateTimeMatch = date.match(/^(\d{4}-\d{2}-\d{2})[ T]/);
    if (dateTimeMatch) {
        date = dateTimeMatch[1];
    }

    /* ================= YYYY-M-D (pad) ================= */
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(date)) {
        const [yearPart, monthPart, dayPart] = date.split("-");
        date = `${yearPart}-${monthPart.padStart(2, "0")}-${dayPart.padStart(2, "0")}`;
    }

    /* ================= DD-MM-YYYY ================= */
    else if (/^\d{1,2}-\d{1,2}-\d{4}$/.test(date)) {
        const [day, month, year] = date.split("-");
        date = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    }

    /* ================= DD/MM/YYYY ================= */
    else if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(date)) {
        const [day, month, year] = date.split("/");
        date = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    }

    /* ================= YYYY/MM/DD ================= */
    else if (/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(date)) {
        const [year, month, day] = date.split("/");
        date = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    }

    /* ================= YYYY-MM-DD ================= */
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return null;
    }

    const [year, month, day] = date.split("-").map(Number);

    const parsed =
        new Date(
            Date.UTC(
                year,
                month - 1,
                day
            )
        );

    /* ================= STRICT DATE CHECK ================= */
    if (
        parsed.getUTCFullYear() !== year ||
        parsed.getUTCMonth() !== month - 1 ||
        parsed.getUTCDate() !== day
    ) {
        return null;
    }

    return date;
};

const isEmptyJoinDate = (value) => {
    if (value === null || value === undefined) {
        return true;
    }

    if (typeof value === "string") {
        const cleaned = value.trim().toLowerCase();
        return (
            cleaned === "" ||
            cleaned === "null" ||
            cleaned === "undefined"
        );
    }

    return false;
};

const extractJoiningDate = (source, depth = 0) => {
    if (
        !source ||
        typeof source !== "object" ||
        depth > 2
    ) {
        return undefined;
    }

    const aliases = new Set([
        "date_of_joining",
        "dateofjoining",
        "joining_date",
        "joiningdate",
        "date-of-joining",
        "doj"
    ]);

    for (const [key, value] of Object.entries(source)) {
        const normalized = String(key)
            .toLowerCase()
            .replace(/[\s-]/g, "_");
        const compact = normalized.replace(/_/g, "");

        const isJoinDateKey =
            aliases.has(normalized) ||
            aliases.has(compact) ||
            /(date.*join|join.*date)/i.test(key);

        if (isJoinDateKey && !isEmptyJoinDate(value)) {
            return Array.isArray(value) ? value[0] : value;
        }
    }

    for (const value of Object.values(source)) {
        if (
            value &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            !(value instanceof Date)
        ) {
            const nested = extractJoiningDate(value, depth + 1);
            if (nested !== undefined) {
                return nested;
            }
        }
    }

    return undefined;
};

/* =========================================================
   ADD
========================================================= */
export const addEmploymentDetails = async (req, res) => {
    try {
        const {
            personal_details_id
        } = req.body;

        /* =====================================================
           CLEAN HELPER
        ===================================================== */
        const cleanValue = (value) => {
            if (
                value === null ||
                value === undefined
            ) {
                return null;
            }

            const cleaned =
                String(value)
                    .trim()
                    .replace(/^["']+|["']+$/g, "")
                    .trim();

            return cleaned === ""
                ? null
                : cleaned;
        };

        /* =====================================================
           EMPLOYEE
        ===================================================== */
        const employee = await getPersonalDetailsByIdModel(
            personal_details_id
        );

        if (!employee) {
            return res.status(404).json({
                success: false,
                message: "Employee not found"
            });
        }

        /* =====================================================
           WORK LOCATION
        ===================================================== */
        const workLocationValue = cleanValue(
            req.body.work_location
        );

        const workLocationId = await getWorkLocationId(
            workLocationValue
        );

        /* =====================================================
           BOND
        ===================================================== */
        const bondValue = cleanValue(req.body.bond);
        const bondId = await getBondId(bondValue);

        if (
            bondValue !== null &&
            !bondId
        ) {
            return res.status(400).json({
                success: false,
                message: `Bond not found: "${bondValue}"`
            });
        }

        /* =====================================================
           CATEGORY
        ===================================================== */
        const categoryValue = cleanValue(req.body.category);

        const categoryId =
            await getCategoryId(
                categoryValue
            );

        if (
            categoryValue !== null &&
            !categoryId
        ) {
            return res.status(400).json({
                success: false,
                message: `Category not found: "${categoryValue}"`
            });
        }

        /* =====================================================
           STATUS
        ===================================================== */
        const employeeStatus =
            req.body.status ??
            employee?.status ??
            employee?.personal_details?.status;

        const isActiveEmployee =
            String(employeeStatus || "")
                .trim()
                .toLowerCase() === "active";

        /* =====================================================
           JOINING DATE
        ===================================================== */
        const joiningDateValue = cleanDateValue(
            req.body.date_of_joining ??
            req.body.dateOfJoining ??
            req.body.joining_date
        );

        if (
            (req.body.date_of_joining ??
                req.body.dateOfJoining ??
                req.body.joining_date) !== undefined &&
            (req.body.date_of_joining ??
                req.body.dateOfJoining ??
                req.body.joining_date) !== null &&
            String(
                req.body.date_of_joining ??
                req.body.dateOfJoining ??
                req.body.joining_date
            ).trim() !== "" &&
            !joiningDateValue
        ) {
            return res.status(400).json({
                success: false,
                message:
                    `Invalid joining date: "${req.body.date_of_joining ?? req.body.dateOfJoining ?? req.body.joining_date}"`
            });
        }

        const dateOfJoining = joiningDateValue || null;

        const username =
            employee?.personal_details?.username ??
            employee?.username ??
            null;

        if (!username) {
            return res.status(400).json({
                success: false,
                message: "Employee username not found"
            });
        }

        /* =====================================================
           EMPLOYMENT ID
        ===================================================== */
        let employmentId = null;

        if (isActiveEmployee) {
            employmentId = await generateEmploymentId(
                workLocationId,
                joiningDateValue,
                categoryId
            );
        }

        /* =====================================================
           ACCESS
        ===================================================== */
        const access =
            req.body.access === 1 ||
                req.body.access === "1"
                ? 1
                : 0;

        const internshipStartDate = cleanDateValue(req.body.internship_start_date);
        const internshipEndDate = cleanDateValue(req.body.internship_end_date);
        const internshipDuration = cleanValue(req.body.internship_duration);
        const nocLetter = cleanValue(req.body.noc_letter);
        const uploadedOfferLetter = await uploadOfferLetter(
            offerLetterFileFromRequest(req),
            username
        );
        const offerLetter = uploadedOfferLetter || cleanValue(req.body.offer_letter);

        const shiftName = cleanValue(req.body.shift_name);
        const shiftType = cleanValue(req.body.shift_type);
        const shiftId = await getShiftConfigurationId(shiftName, shiftType);
        if ((shiftName || shiftType) && !shiftId) {
            return res.status(400).json({
                success: false,
                message: "Shift not found for the supplied shift_name and shift_type"
            });
        }

        /* =====================================================
           DEPARTMENT STRUCTURE (store INTEGER ids)
        ===================================================== */
        const designationId = await getDepartmentStructureId(
            cleanValue(req.body.designation) ??
            cleanValue(req.body.designation_name)
        );

        const departmentId = await getDepartmentStructureId(
            cleanValue(req.body.department) ??
            cleanValue(req.body.department_name),
            workLocationId,
            null
        );

        const subDepartmentId = await getDepartmentStructureId(
            cleanValue(req.body.sub_department) ??
            cleanValue(req.body.sub_department_name),
            workLocationId,
            departmentId
        );

        /* =====================================================
           SAVE
        ===================================================== */
        const saved = await addEmploymentDetailsModel({
            ...req.body,
            personal_details_id,
            username,
            shift_id: shiftId,
            date_of_joining: dateOfJoining,
            employment_id: employmentId,
            access,
            designation: designationId,
            department: departmentId,
            sub_department: subDepartmentId,
            internship_start_date: internshipStartDate,
            internship_end_date: internshipEndDate,
            internship_duration: internshipDuration,
            noc_letter: nocLetter,
            offer_letter: offerLetter,
            company_mobile_number: cleanValue(req.body.company_mobile_number),
            work_location: workLocationId,
            bond: bondId,
            category: categoryId
        });

        const savedData = saved.data?.id
            ? await getEmploymentDetailsByIdModel(saved.data.id)
            : saved.data;
        const responseData = {
            ...saved,
            data: savedData
        };

        /* =====================================================
           SOCKET
        ===================================================== */
        const io = getIO();

        if (io) {
            io.emit(
                "employee:added",
                {
                    success: true,
                    message: "New Employment details added",
                    data: responseData
                }
            );
        }

        /* =====================================================
           RESPONSE
        ===================================================== */
        return res.status(201).json({
            success: true,
            message: "Employment details added successfully",
            data: responseData
        });

    } catch (error) {
        console.error("ADD EMPLOYMENT DETAILS ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* =========================================================
   GET ALL
========================================================= */
export const getAllEmploymentDetails = async (
    req,
    res
) => {
    try {
        const data = await getAllEmploymentDetailsModel();

        const io = getIO();

        if (io) {
            io.emit("employee:fetch", {
                success: true,
                message: "Fetch Employment details",
                data
            });
        }

        return res.status(200).json({
            success: true,
            data
        });

    } catch (error) {
        console.error("GET EMPLOYMENT DETAILS ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* =========================================================
   GET BY ID
========================================================= */
export const getEmploymentDetailsById = async (
    req,
    res
) => {
    try {
        const id = Number(req.params.id);

        if (!Number.isInteger(id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid employment ID"
            });
        }

        const data = await getEmploymentDetailsByIdModel(id);

        if (!data) {
            return res.status(404).json({
                success: false,
                message: "Record not found"
            });
        }

        return res.status(200).json({
            success: true,
            data
        });

    } catch (error) {
        console.error("GET EMPLOYMENT DETAILS ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= UPDATE ================= */
export const updateEmploymentDetails = async (req, res) => {
    try {
        req.body =
            req.body && typeof req.body === "object"
                ? req.body
                : {};

        const bodyHas = (key) =>
            Object.prototype.hasOwnProperty.call(req.body, key);

        const cleanUpdateValue = (value) => {
            if (
                value === null ||
                value === undefined
            ) {
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

        const rawJoiningDateFromRequest =
            extractJoiningDate(req.body) ??
            extractJoiningDate(req.query);

        for (const key of Object.keys(req.body || {})) {
            if (/(date.*join|join.*date)/i.test(key)) {
                continue;
            }

            req.body[key] = cleanUpdateValue(req.body[key]);
        }

        const id = Number(req.params.id);

        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({
                success: false,
                message: "Invalid employment ID"
            });
        }

        /* =========================================================
           EXISTING
        ========================================================= */
        const existing = await getEmploymentDetailsByIdModel(id);

        if (!existing) {
            return res.status(404).json({
                success: false,
                message: "Record not found"
            });
        }

        /* =========================================================
           EMPLOYEE
        ========================================================= */
        const employee = await getPersonalDetailsByIdModel(
            existing.personal_details_id
        );

        if (!employee) {
            return res.status(404).json({
                success: false,
                message: "Employee not found"
            });
        }

        const username = employee.personal_details.username;

        const shiftProvided = bodyHas("shift_name") || bodyHas("shift_type");
        const shiftName = bodyHas("shift_name")
            ? req.body.shift_name
            : existing.shift_name;
        const shiftType = bodyHas("shift_type")
            ? req.body.shift_type
            : existing.shift_type;
        const shiftId = shiftProvided
            ? await getShiftConfigurationId(shiftName, shiftType)
            : existing.shift_id;
        if (shiftProvided && (shiftName || shiftType) && !shiftId) {
            return res.status(400).json({
                success: false,
                message: "Shift not found for the supplied shift_name and shift_type"
            });
        }

        /* =========================================================
           STATUS
        ========================================================= */
        const { rows: statusRows } =
            await pool.query(
                `
                    SELECT status
                    FROM master_employee
                    WHERE personal_details_id = $1
                    LIMIT 1
                `,
                [existing.personal_details_id]
            );

        const status = statusRows[0]?.status || "pending";

        const isActiveEmployee =
            String(status)
                .trim()
                .toLowerCase() === "active";

        /* =========================================================
           WORK LOCATION
        ========================================================= */
        const workLocationProvided =
            bodyHas("work_location") || bodyHas("work_location_name");

        const workLocationValue = bodyHas("work_location")
            ? req.body.work_location
            : bodyHas("work_location_name")
                ? req.body.work_location_name
                : existing?.work_location ??
                existing?.work_location_name ??
                null;

        const resolvedWorkLocationId = await getWorkLocationId(workLocationValue);

        const workLocationId = workLocationProvided
            ? resolvedWorkLocationId
            : resolvedWorkLocationId ?? existing?.work_location ?? null;

        if (
            workLocationProvided &&
            workLocationValue !== null &&
            workLocationValue !== undefined &&
            String(workLocationValue).trim() !== "" &&
            !workLocationId
        ) {
            return res.status(400).json({
                success: false,
                message: `Work location not found: "${workLocationValue}"`
            });
        }

        /* =========================================================
           CATEGORY
        ========================================================= */
        const categoryProvided = bodyHas("category");

        const categoryValue = categoryProvided
            ? req.body.category
            : existing.category;

        const resolvedCategoryId = await getCategoryId(
            categoryValue,
            workLocationId
        );

        const categoryId = categoryProvided
            ? resolvedCategoryId
            : resolvedCategoryId ?? existing.category ?? null;

        if (
            categoryProvided &&
            categoryValue !== null &&
            categoryValue !== undefined &&
            String(categoryValue).trim() !== "" &&
            !categoryId
        ) {
            return res.status(400).json({
                success: false,
                message: `Category not found: "${categoryValue}"`
            });
        }

        /* =========================================================
           DEPARTMENT STRUCTURE
           Store department_structure.id (INTEGER) only.
        ========================================================= */
        const designationProvided = bodyHas("designation") || bodyHas("designation_name");

        const designationValue = bodyHas("designation")
            ? req.body.designation
            : bodyHas("designation_name")
                ? req.body.designation_name
                : existing.designation;

        const departmentProvided = bodyHas("department") || bodyHas("department_name");

        const departmentValue = bodyHas("department")
            ? req.body.department
            : bodyHas("department_name")
                ? req.body.department_name
                : existing.department;

        const subDepartmentProvided = bodyHas("sub_department") || bodyHas("sub_department_name");

        const subDepartmentValue = bodyHas("sub_department")
            ? req.body.sub_department
            : bodyHas("sub_department_name")
                ? req.body.sub_department_name
                : existing.sub_department;

        /* ================= DESIGNATION ================= */
        const resolvedDesignationId = await getDepartmentStructureId(
            designationValue,
            workLocationId,
            null
        );

        const designationId = designationProvided
            ? resolvedDesignationId
            : resolvedDesignationId ?? existing.designation ?? null;

        if (
            designationProvided &&
            designationValue !== null &&
            designationValue !== undefined &&
            String(designationValue).trim() !== "" &&
            !designationId
        ) {
            return res.status(400).json({
                success: false,
                message: `Designation not found: "${designationValue}"`
            });
        }

        const resolvedDepartmentId = await getDepartmentStructureId(
            departmentValue,
            workLocationId,
            null
        );

        const departmentId = departmentProvided
            ? resolvedDepartmentId
            : resolvedDepartmentId ?? existing.department ?? null;

        if (
            departmentProvided &&
            departmentValue !== null &&
            departmentValue !== undefined &&
            String(departmentValue).trim() !== "" &&
            !departmentId
        ) {
            return res.status(400).json({
                success: false,
                message: `Department "${departmentValue}" not found for work location "${workLocationValue}"`
            });
        }

        const resolvedSubDepartmentId = await getDepartmentStructureId(
            subDepartmentValue,
            workLocationId,
            departmentId
        );

        const subDepartmentId = subDepartmentProvided
            ? resolvedSubDepartmentId
            : resolvedSubDepartmentId ?? existing.sub_department ?? null;

        if (
            subDepartmentProvided &&
            subDepartmentValue !== null &&
            subDepartmentValue !== undefined &&
            String(subDepartmentValue).trim() !== "" &&
            !subDepartmentId
        ) {
            return res.status(400).json({
                success: false,
                message: `Sub department "${subDepartmentValue}" not found under department "${departmentValue}" for work location "${workLocationValue}"`
            });
        }

        /* =====================================================
           JOINING DATE
        ===================================================== */
        const rawJoiningDate =
            rawJoiningDateFromRequest ??
            req.body.date_of_joining ??
            req.body.joining_date ??
            req.body.dateOfJoining ??
            req.body.joiningDate;

        let joiningDateValue = formatDateOnly(existing.date_of_joining);

        if (!isEmptyJoinDate(rawJoiningDate)) {
            joiningDateValue = cleanDateValue(rawJoiningDate);

            if (!joiningDateValue) {
                return res.status(400).json({
                    success: false,
                    message: `Invalid joining date: "${rawJoiningDate}"`
                });
            }
        }

        /* =========================================================
           DATE CHANGE CHECK
        ========================================================= */
        const oldJoiningDate =
            existing.date_of_joining
                ? new Date(existing.date_of_joining)
                : null;

        const newJoiningDate =
            joiningDateValue
                ? new Date(joiningDateValue)
                : null;

        const monthYearChanged =
            !!newJoiningDate &&
            !!oldJoiningDate &&
            (
                newJoiningDate.getMonth() !==
                oldJoiningDate.getMonth() ||
                newJoiningDate.getFullYear() !==
                oldJoiningDate.getFullYear()
            );


        /* =========================================================
           CHANGE CHECK
        ========================================================= */
        const locationChanged =
            Number(workLocationId || 0) !==
            Number(existing?.work_location || 0);

        const categoryChanged =
            Number(categoryId || 0) !==
            Number(existing?.category || 0);


        /* =========================================================
           EMPLOYMENT ID
        ========================================================= */
        let employmentId = existing.employment_id;

        if (isActiveEmployee) {
            if (!joiningDateValue) {
                employmentId = null;

            } else if (!employmentId) {
                employmentId = await generateEmploymentId(
                    workLocationId,
                    joiningDateValue,
                    categoryId
                );

            } else if (
                locationChanged ||
                categoryChanged
            ) {
                employmentId = await generateEmploymentId(
                    workLocationId,
                    joiningDateValue,
                    categoryId
                );

            } else if (monthYearChanged) {
                employmentId = await updateEmploymentId(
                    employmentId,
                    workLocationId,
                    joiningDateValue,
                    categoryId
                );
            }

        } else {
            employmentId = null;
        }

        /* =========================================================
           BOND
        ========================================================= */
        const bondValue =
            req.body.bond !== undefined
                ? req.body.bond
                : existing.bond;

        const bondId = await getBondId(bondValue);

        if (
            bondValue !== null &&
            bondValue !== undefined &&
            String(bondValue).trim() !== "" &&
            !bondId
        ) {
            return res.status(400).json({
                success: false,
                message: `Bond not found: "${bondValue}"`
            });
        }

        const internshipStartDate =
            req.body.internship_start_date !== undefined
                ? cleanDateValue(req.body.internship_start_date)
                : formatDateOnly(existing.internship_start_date);

        const internshipEndDate =
            req.body.internship_end_date !== undefined
                ? cleanDateValue(req.body.internship_end_date)
                : formatDateOnly(existing.internship_end_date);

        const internshipDuration =
            req.body.internship_duration !== undefined
                ? req.body.internship_duration
                : existing.internship_duration;

        const nocLetter =
            req.body.noc_letter !== undefined
                ? req.body.noc_letter
                : existing.noc_letter;

        const uploadedOfferLetter = await uploadOfferLetter(
            offerLetterFileFromRequest(req),
            username
        );
        const offerLetter = uploadedOfferLetter
            || (
                req.body.offer_letter !== undefined
                    ? req.body.offer_letter
                    : existing.offer_letter
            );

        /* =========================================================
           UPDATE
        ========================================================= */
        const updated = await updateEmploymentDetailsModel(
            id,
            {
                employment_id: employmentId,
                shift_id: shiftId,
                rfid:
                    req.body.rfid !== undefined
                        ? req.body.rfid
                        : existing.rfid,

                username,

                password:
                    req.body.password !== undefined
                        ? req.body.password
                        : existing.password,

                access:
                    req.body.access !== undefined
                        ? req.body.access
                        : existing.access,

                designation: designationId,
                department: departmentId,
                sub_department: subDepartmentId,
                category: categoryId,
                date_of_joining: joiningDateValue,
                work_email:
                    req.body.work_email !== undefined
                        ? req.body.work_email
                        : existing.work_email,

                company_mobile_number:
                    req.body.company_mobile_number !== undefined
                        ? req.body.company_mobile_number
                        : existing.company_mobile_number,

                employment_type:
                    req.body.employment_type !== undefined
                        ? req.body.employment_type
                        : existing.employment_type,

                internship_start_date: internshipStartDate,
                internship_end_date: internshipEndDate,
                internship_duration: internshipDuration,
                noc_letter: nocLetter,
                offer_letter: offerLetter,
                work_location: workLocationId,

                reporting_manager:
                    req.body.reporting_manager !== undefined
                        ? req.body.reporting_manager
                        : existing.reporting_manager,

                probation_period:
                    req.body.probation_period !== undefined
                        ? req.body.probation_period
                        : existing.probation_period,

                notice_period:
                    req.body.notice_period !== undefined
                        ? req.body.notice_period
                        : existing.notice_period,

                bond: bondId,

                has_experience:
                    req.body.has_experience !== undefined
                        ? req.body.has_experience
                        : existing.has_experience,

                show_in_attendance:
                    req.body.show_in_attendance !== undefined
                        ? req.body.show_in_attendance
                        : existing.show_in_attendance
            }
        );
        const updatedWithPayrollConfig =
            await getEmploymentDetailsByIdModel(id) || updated;

        /* =========================================================
           EMPLOYEE EDIT LOG
        ========================================================= */
        const editedBy = req.headers["x-username"]?.trim() || "null";

        const fieldsToCheck = [
            "employment_id",
            "rfid",
            "username",
            "password",
            "access",
            "shift_id",
            "designation",
            "department",
            "sub_department",
            "category",
            "date_of_joining",
            "work_email",
            "company_mobile_number",
            "employment_type",
            "internship_start_date",
            "internship_end_date",
            "internship_duration",
            "noc_letter",
            "offer_letter",
            "work_location",
            "reporting_manager",
            "probation_period",
            "notice_period",
            "bond",
            "has_experience",
            "show_in_attendance"
        ];

        for (const field of fieldsToCheck) {
            /* =====================================================
               OLD VALUE
            ===================================================== */
            let oldValue =
                existing[field] !== null &&
                    existing[field] !== undefined
                    ? existing[field]
                    : null;

            /* =====================================================
               NEW VALUE
            ===================================================== */
            let newValue =
                updatedWithPayrollConfig[field] !== null &&
                    updatedWithPayrollConfig[field] !== undefined
                    ? updatedWithPayrollConfig[field]
                    : null;

            /* =====================================================
               SHOW IN ATTENDANCE
               Always compare as boolean
            ===================================================== */
            if (field === "show_in_attendance") {

                oldValue =
                    oldValue === true ||
                    oldValue === "true";

                newValue =
                    newValue === true ||
                    newValue === "true";
            }

            /* =====================================================
               JOINING DATE
               Always store/compare as YYYY-MM-DD
            ===================================================== */
            if (field === "date_of_joining") {

                oldValue = formatDateOnly(oldValue);

                if (
                    req.body.date_of_joining !== undefined &&
                    req.body.date_of_joining !== null &&
                    String(req.body.date_of_joining).trim() !== ""
                ) {
                    newValue = cleanDateValue(
                        req.body.date_of_joining
                    );
                } else {
                    newValue = formatDateOnly(newValue);
                }
            }

            /* =====================================================
               COMPARE VALUES
            ===================================================== */
            const oldCompare =
                field === "date_of_joining"
                    ? String(oldValue ?? "")
                    : oldValue instanceof Date
                        ? oldValue.toISOString()
                        : String(oldValue ?? "");

            const newCompare =
                field === "date_of_joining"
                    ? String(newValue ?? "")
                    : newValue instanceof Date
                        ? newValue.toISOString()
                        : String(newValue ?? "");

            /* =====================================================
               SAVE LOG ONLY IF VALUE CHANGED
            ===================================================== */
            if (oldCompare !== newCompare) {
                await addEmployeeEditLogModel({
                    personal_details_id:
                        existing.personal_details_id
                            ? Number(existing.personal_details_id)
                            : null,

                    username: username,
                    edited_by: editedBy,
                    action: "UPDATE",
                    old_value: {
                        field,
                        value: oldValue
                    },

                    new_value: {
                        field,
                        value: newValue
                    },

                    description: `Employment details field "${field}" updated`
                });
            }
        }

        /* =========================================================
           SOCKET
        ========================================================= */
        const io = getIO();

        if (io) {
            io.emit("employee:updated", {
                success: true,
                message: "Update Employment details",
                data: updatedWithPayrollConfig
            });
        }

        /* =========================================================
           RESPONSE
        ========================================================= */
        return res.status(200).json({
            success: true,
            message: "Employment details updated successfully",
            data: updatedWithPayrollConfig
        });

    } catch (error) {
        console.error("UPDATE EMPLOYMENT DETAILS ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};