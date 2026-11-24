import { getIO, broadcastUserProfileUpdated } from "../../config/socket.js";
import { uploadToCloudinary } from "../../middleware/cloudinaryUpload.js";
import { addMasterEmployeeModel } from "../../models/Employee/MasterEmployee.model.js";
import { addPersonalDetailsModel, getAllEmployeeCompleteDataModel, getAllPersonalDetailsModel, getBasicPersonalDetailsModel, getMonthlyBirthdayAnniversaryModel, getPersonalDetailsByIdModel, getPersonalDetailsByUsernameModel, getPersonalDetailsPermissionsModel, updatePersonalDetailsModel } from "../../models/Employee/PersonalDetails.model.js";
import { addEmployeeEditLogModel } from "../../models/history/employee_edit_log.model.js";

export const formatDateOnly = (value) => {
    if (
        value === null ||
        value === undefined ||
        value === ""
    ) {
        return null;
    }

    /* Already YYYY-MM-DD */
    if (
        typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(value)
    ) {
        return value;
    }

    /* ISO value coming from PostgreSQL */
    if (
        typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}T/.test(value)
    ) {
        return value.substring(0, 10);
    }

    /* Date object */
    if (value instanceof Date) {
        return value.toLocaleDateString("en-CA", {
            timeZone: "Asia/Kolkata"
        });
    }

    return String(value).substring(0, 10);
};

/* ================= ADD ================= */
export const addPersonalDetails = async (req, res) => {
    try {
        const {
            first_name,
            middle_name,
            last_name,
            username,
            candidate_id,
            date_of_birth,
            gender,
            blood_group,
            family_members_count,
            marital_status,
            anniversary_date,
            dependent_children,
            email_id,
            current_address,
            permanent_address,
            mobile_number,
            alternate_contact_number,
            emergency_contact_name,
            emergency_contact_number,
            emergency_relationship,
            source,
            current_salary,
            expected_salary,
            linkedin_profile_link
        } = req.body;

        /* ================= FILES ================= */
        const imageFile = req.files?.image?.[0];
        const resumeFile = req.files?.resume?.[0];

        let imageUrl = null;
        let resumeUrl = null;

        /* ================= IMAGE UPLOAD ================= */
        if (imageFile?.buffer) {
            const folderPath = username;

            const result = await uploadToCloudinary(
                imageFile.buffer,
                first_name,
                folderPath,
                imageFile.mimetype
            );
            imageUrl = result?.secure_url || null;
        }

        /* ================= RESUME UPLOAD ================= */
        if (resumeFile?.buffer) {
            const result = await uploadToCloudinary(
                resumeFile.buffer,
                `${username}_resume`,
                username,
                resumeFile.mimetype
            );

            resumeUrl = result?.secure_url || null;
        }

        /* ================= CHECK USERNAME ================= */
        const existingUser = await getPersonalDetailsByUsernameModel(username);

        if (existingUser) {
            return res.status(409).json({
                success: false,
                message: "Username already exists",
                personal_details_id: existingUser.id,
                data: existingUser
            });
        }

        const saved = await addPersonalDetailsModel({
            first_name,
            middle_name,
            last_name,
            username,
            candidate_id,
            date_of_birth,
            gender,
            blood_group,
            family_members_count,
            marital_status,
            anniversary_date,
            dependent_children,
            email_id,
            current_address,
            permanent_address,
            image: imageUrl,
            mobile_number,
            alternate_contact_number,
            emergency_contact_name,
            emergency_contact_number,
            emergency_relationship,
            source,
            current_salary,
            expected_salary,
            linkedin_profile_link,
            resume: resumeUrl
        });

        await addMasterEmployeeModel({
            personal_details_id: saved.id,
            status: "pending_approval"
        });

        /* ================= SOCKET EMIT ================= */
        const io = getIO();

        io.emit("employee:created", {
            success: true,
            message: "New employee added",
            data: saved
        });

        return res.status(201).json({
            success: true,
            message: "Personal details added successfully",
            data: saved
        });

    } catch (error) {
        console.error("ADD PERSONAL DETAILS ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= GET ALL ================= */
export const getAllPersonalDetails = async (req, res) => {
    try {
        const data = await getAllPersonalDetailsModel();

        /* ================= SOCKET EMIT ================= */
        const io = getIO();

        io.emit("employee:fetch", {
            success: true,
            message: "Fetch employee",
            data
        });

        return res.json({
            success: true,
            message: "Personal details fetched successfully",
            data
        });

    } catch (error) {
        console.error("GET PERSONAL DETAILS ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= GET ALL EMPLOYEE TABLE ================= */
export const getAllEmployeeCompleteData = async (req, res) => {
    try {
        const {
            name,
            employment_id,
            job_posting,
            department,
            designation,
            work_email,
            contact,
            joining_date,
            manager,
            status,
            category,
            work_location,
            page = 1,
            limit = 20
        } = req.query;

        const data = await getAllEmployeeCompleteDataModel({
            name,
            employment_id,
            job_posting,
            department,
            designation,
            work_email,
            contact,
            joining_date,
            manager,
            status,
            category,
            work_location,
            page: Number(page),
            limit: Number(limit)
        });

        const io = getIO();

        io.emit("employee:fetch", {
            success: true,
            message: "Fetch employee",
            data: data.employees
        });

        return res.status(200).json({
            success: true,
            message: "All employee data fetched successfully",
            total_people: data.summary.total_people,
            total_employees: data.summary.total_employees,
            active_employees: data.summary.active_employees,
            pending_approval: data.summary.pending_approval,
            inactive_employees: data.summary.inactive_employees,
            active_intern: data.summary.active_intern,
            inactive_intern: data.summary.inactive_intern,
            data: data.employees,
            pagination: data.pagination
        });

    } catch (error) {
        console.error("GET ALL EMPLOYEE DATA ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= GET BY ID ================= */
export const getPersonalDetailsById = async (req, res) => {
    try {
        const { id } = req.params;

        const data = await getPersonalDetailsByIdModel(id);

        if (!data) {
            return res.status(404).json({
                success: false,
                message: "Record not found"
            });
        }

        const io = getIO();

        io.emit("employee:fetch", {
            success: true,
            message: "Fetch employee",
            data
        });

        return res.status(200).json({
            success: true,
            data
        });

    } catch (error) {
        console.error("GET PERSONAL DETAILS ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= GET BASIC PERSONAL DETAILS ================= */
export const getBasicPersonalDetails = async (req, res) => {
    try {
        const {
            status,
            category,
            access
        } = req.query;

        const data = await getBasicPersonalDetailsModel({
            status,
            category,
            access
        });

        /* ================= SOCKET EMIT ================= */
        const io = getIO();

        io.emit("employee:basic-fetch", {
            success: true,
            message: "Basic employee details fetched",
            data
        });

        return res.status(200).json({
            success: true,
            message: "Basic personal details fetched successfully",
            data
        });

    } catch (error) {
        console.error("GET BASIC PERSONAL DETAILS ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= GET PERSONAL DETAILS WITH PERMISSIONS ================= */
export const getPersonalDetailsPermissions = async (req, res) => {
    try {
        const { work_location } = req.query;

        const data = await getPersonalDetailsPermissionsModel({
            work_location
        });

        /* ================= SOCKET EMIT ================= */
        const io = getIO();

        io.emit("employee:basic-fetch", {
            success: true,
            message: "Basic employee details fetched",
            data
        });

        return res.status(200).json({
            success: true,
            message: "Basic personal details fetched successfully",
            data
        });

    } catch (error) {
        console.error("GET BASIC PERSONAL DETAILS ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* =========================================================
   GET MONTHLY BIRTHDAY & ANNIVERSARY LIST
========================================================= */
export const getMonthlyBirthdayAnniversary = async (req, res) => {
    try {
        const {
            month,
            year,
            work_location
        } = req.query;

        const indiaDateParts = new Intl.DateTimeFormat("en-CA", {
            timeZone: "Asia/Kolkata",
            year: "numeric",
            month: "numeric"
        }).formatToParts(new Date());
        const currentIndiaMonth = Number(
            indiaDateParts.find(part => part.type === "month").value
        );
        const currentIndiaYear = Number(
            indiaDateParts.find(part => part.type === "year").value
        );
        const selectedMonth = month === undefined || String(month).trim() === ""
            ? currentIndiaMonth
            : Number(month);
        const selectedYear = year === undefined || String(year).trim() === ""
            ? currentIndiaYear
            : Number(year);

        if (
            !Number.isInteger(selectedMonth) ||
            selectedMonth < 1 ||
            selectedMonth > 12
        ) {
            return res.status(400).json({
                success: false,
                message: "month must be between 1 and 12"
            });
        }

        /* =====================================================
           NORMALIZE WORK LOCATION
        ===================================================== */
        let workLocationFilter = [];

        if (typeof work_location === "string") {
            workLocationFilter = work_location
                .split(",")
                .map(item => item.trim())
                .filter(Boolean);

        } else if (Array.isArray(work_location)) {
            workLocationFilter = work_location
                .flatMap(item =>
                    String(item)
                        .split(",")
                        .map(value => value.trim())
                )
                .filter(Boolean);
        }

        /* =====================================================
           GET DATA
        ===================================================== */
        const data = await getMonthlyBirthdayAnniversaryModel({
            month: selectedMonth,
            year: selectedYear,
            work_location: workLocationFilter
        });
        const formatCelebrationDate = value => {
            if (!value) {
                return null;
            }

            const [, monthValue, dayValue] = /^\d{4}-(\d{2})-(\d{2})$/
                .exec(String(value).slice(0, 10)) || [];

            return monthValue && dayValue
                ? `${dayValue}/${monthValue}/${selectedYear}`
                : null;
        };
        const celebrations = data.flatMap(item => {
            const name = [item.first_name, item.last_name]
                .filter(value => value != null && String(value).trim() !== "")
                .join(" ");
            const events = [];

            if (item.is_birthday) {
                events.push({
                    username: item.username,
                    name,
                    celebration_types: "Birthday",
                    date: formatCelebrationDate(item.birthday_date)
                });
            }

            if (item.is_anniversary) {
                events.push({
                    username: item.username,
                    name,
                    celebration_types: `${item.anniversary_years} years anniversary`,
                    date: formatCelebrationDate(item.anniversary_date)
                });
            }

            return events;
        });

        /* =====================================================
           SOCKET EMIT
        ===================================================== */
        const io = getIO();

        io.emit(
            "employee:birthday-anniversary-fetch",
            {
                success: true,
                message: "Monthly birthday and wedding anniversary list fetched",
                data: celebrations
            }
        );

        /* =====================================================
           RESPONSE
        ===================================================== */
        return res.status(200).json({
            success: true,
            message: "Birthdays and anniversaries fetched successfully",
            month: selectedMonth,
            year: selectedYear,

            work_location: workLocationFilter,
            total_birthdays: celebrations.filter(
                item => item.celebration_types === "Birthday"
            ).length,
            total_anniversaries: celebrations.filter(
                item => item.celebration_types !== "Birthday"
            ).length,
            total: celebrations.length,
            data: celebrations
        });

    } catch (error) {
        console.error("GET MONTHLY BIRTHDAY & ANNIVERSARY LIST ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= UPDATE ================= */
export const updatePersonalDetails = async (req, res) => {
    try {
        const { id } = req.params;

        const imageFile = req.files?.image?.[0];
        const resumeFile = req.files?.resume?.[0];

        /* =========================================================
           GET OLD DATA BEFORE UPDATE
        ========================================================= */
        const oldData = await getPersonalDetailsByIdModel(id);

        if (!oldData) {
            return res.status(404).json({
                success: false,
                message: "Employee not found"
            });
        }

        /* =========================================================
           OLD EMPLOYEE OBJECT
        ========================================================= */
        const oldEmployee =
            oldData?.personal_details ||
            oldData;

        /* =========================================================
           IMAGE UPLOAD
        ========================================================= */
        let imageUrl = oldData.image;
        if (imageFile?.buffer) {
            const result = await uploadToCloudinary(
                imageFile.buffer,
                req.body.first_name,
                req.body.username,
                imageFile.mimetype
            );

            imageUrl = result?.secure_url || null;
        }

        let resumeUrl =
            oldEmployee?.resume ??
            oldData?.resume ??
            null;

        /* ================= RESUME UPLOAD ================= */
        if (resumeFile?.buffer) {
            const result = await uploadToCloudinary(
                resumeFile.buffer,
                `${oldEmployee?.username || req.body.username}_resume`,
                oldEmployee?.username || req.body.username,
                resumeFile.mimetype
            );

            resumeUrl = result?.secure_url || null;
        }

        /* =========================================================
           PREPARE UPDATE DATA
           Preserve existing values when fields are not provided
        ========================================================= */

        const oldPersonalDetails =
            oldData?.personal_details || oldData;

        const updateData = {
            ...req.body,

            source:
                req.body.source !== undefined
                    ? req.body.source
                    : oldPersonalDetails.source,

            current_salary:
                req.body.current_salary !== undefined
                    ? req.body.current_salary
                    : oldPersonalDetails.current_salary,

            expected_salary:
                req.body.expected_salary !== undefined
                    ? req.body.expected_salary
                    : oldPersonalDetails.expected_salary,

            linkedin_profile_link:
                req.body.linkedin_profile_link !== undefined
                    ? req.body.linkedin_profile_link
                    : oldPersonalDetails.linkedin_profile_link,

            resume: resumeUrl,

            ...(imageUrl && {
                image: imageUrl
            })
        };

        /* =========================================================
           IMPORTANT:
           KEEP DATE OF BIRTH AS YYYY-MM-DD
           WITHOUT JS TIMEZONE CONVERSION
        ========================================================= */
        if (
            updateData.date_of_birth &&
            typeof updateData.date_of_birth === "string"
        ) {
            updateData.date_of_birth = updateData.date_of_birth.substring(0, 10);
        }

        /* =========================================================
           UPDATE PERSONAL DETAILS
        ========================================================= */
        const data = await updatePersonalDetailsModel(
            id,
            updateData
        );

        if (!data) {
            return res.status(404).json({
                success: false,
                message: "Employee not found"
            });
        }

        /* =========================================================
           NEW EMPLOYEE OBJECT
        ========================================================= */
        const newEmployee =
            data?.personal_details ||
            data;

        /* =========================================================
           FIELDS TO TRACK
        ========================================================= */
        const fields = [
            "first_name",
            "middle_name",
            "last_name",
            "username",
            "date_of_birth",
            "gender",
            "blood_group",
            "family_members_count",
            "marital_status",
            "anniversary_date",
            "dependent_children",
            "email_id",
            "current_address",
            "permanent_address",
            "image",
            "mobile_number",
            "alternate_contact_number",
            "emergency_contact_name",
            "emergency_contact_number",
            "emergency_relationship",
            "source",
            "current_salary",
            "expected_salary",
            "linkedin_profile_link",
            "resume"
        ];

        /* =========================================================
           FIND ONLY CHANGED FIELDS
        ========================================================= */
        const oldChangedValues = {};
        const newChangedValues = {};

        for (const field of fields) {
            let oldValue = oldEmployee?.[field];
            let newValue = newEmployee?.[field];

            /* =====================================================
               DATE OF BIRTH
               Compare only YYYY-MM-DD
            ===================================================== */
            if (field === "date_of_birth") {
                oldValue = formatDateOnly(oldValue);
                newValue = formatDateOnly(newValue);
            }

            /* =====================================================
               NORMAL VALUE COMPARISON
            ===================================================== */
            const oldCompare =
                oldValue === null ||
                    oldValue === undefined
                    ? null
                    : String(oldValue).trim();

            const newCompare =
                newValue === null ||
                    newValue === undefined
                    ? null
                    : String(newValue).trim();

            /* =====================================================
               ONLY LOG CHANGED FIELD
            ===================================================== */
            if (oldCompare !== newCompare) {
                oldChangedValues[field] = oldValue ?? null;
                newChangedValues[field] = newValue ?? null;
            }
        }

        /* =========================================================
           EDITED BY
        ========================================================= */
        const editedBy = req.headers["x-username"]?.trim() || "null";

        /* =========================================================
           EMPLOYEE USERNAME
           Employee whose record is being edited
        ========================================================= */
        const employeeUsername =
            newEmployee?.username ||
            oldEmployee?.username ||
            null;

        /* =========================================================
           CHECK WHETHER ANY FIELD CHANGED
        ========================================================= */
        const changedFields = Object.keys(oldChangedValues);
        const hasChanges = changedFields.length > 0;

        /* =========================================================
           ADD EMPLOYEE EDIT LOG
           
           ONLY CHANGED FIELDS ARE STORED
        ========================================================= */
        let employeeEditLog = null;
        if (hasChanges) {

            employeeEditLog = await addEmployeeEditLogModel({
                personal_details_id: Number(id),
                username: employeeUsername,
                edited_by: editedBy,
                action: "UPDATE",
                old_value: oldChangedValues,
                new_value: newChangedValues,
                description:
                    `Employee details updated for ${newEmployee?.username ||
                    oldEmployee?.username ||
                    id
                    }. Changed fields: ${changedFields.join(", ")
                    }`
            });
        }

        /* =========================================================
           SOCKET EMIT
        ========================================================= */
        const io = getIO();

        io.emit("employee:updated", {
            success: true,
            message: "Employee updated",
            data
        });

        /* =========================================================
           LIVE HEADER UPDATE
        ========================================================= */
        if (data?.username) {
            broadcastUserProfileUpdated(
                data.username,
                {
                    firstName:
                        data.first_name ??
                        undefined,

                    lastName:
                        data.last_name ??
                        undefined,

                    department:
                        data.department ??
                        undefined,

                    email:
                        data.email_id ??
                        undefined
                }
            );
        }

        /* =========================================================
           RESPONSE
        ========================================================= */
        return res.status(200).json({
            success: true,
            message: "Personal details updated successfully",
            data,
            employeeEditLog
        });

    } catch (error) {
        console.error("UPDATE PERSONAL DETAILS ERROR:", error);

        if (
            error.code === "23505" &&
            error.constraint === "personal_details_username_key"
        ) {
            return res.status(409).json({
                success: false,
                message: "Username already exists. Please use a different username."
            });
        }

        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};
