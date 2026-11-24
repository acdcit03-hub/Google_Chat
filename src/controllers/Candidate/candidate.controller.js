import fs from "node:fs";
import path from "node:path";

import { pool } from "../../database.js";
import { uploadToCloudinary } from "../../middleware/cloudinaryUpload.js";

import {
    createCandidateModel,
    getCandidateByIdModel,
    getCandidateModel,
    updateCandidateModel,
    transferCandidateToEmployeeModel,
    getCandidateStatusStatsModel
} from "../../models/Candidate/candidate.models.js";
import { getEducationIdForEmployeeModel } from "../../models/Employee/EducationalQualifications.models.js";
import { getBondId, getCategoryId, getShiftConfigurationId, getWorkLocationId } from "../../models/Employee/EmploymentDetails.model.js";

import {
    addEmployeeEditLogModel
} from "../../models/history/employee_edit_log.model.js";
import { getDepartmentStructureId } from "../../models/settings/Department_structure.model.js";
import { getIO } from "../../config/socket.js";

const uploadCandidateFiles = async (
    req,
    usernameOverride = null,
    candidateNameOverride = null
) => {
    const files = req.files || {};

    /* =====================================================
       CANDIDATE NAME
    ===================================================== */
    const firstName =
        req.body?.first_name
            ? String(req.body.first_name)
                .trim()
                .replace(/\s+/g, "_")
                .toUpperCase()
            : "CANDIDATE";

    const lastName =
        req.body?.last_name
            ? String(req.body.last_name)
                .trim()
                .replace(/\s+/g, "_")
                .toUpperCase()
            : "DOCUMENT";

    const candidateName =
        candidateNameOverride ||
        `${firstName}-${lastName}`;

    const candidateFolder = `candidates/${candidateName}`;

    /* =====================================================
       FILE NAME MAPPING
    ===================================================== */
    const uploadFields = {
        image: candidateName,
        pan_card_upload: `${candidateName}-PAN`,
        aadhaar_upload: `${candidateName}-AADHAAR`,
        other_document_upload: `${candidateName}-OTHER`,
        bank_proof: `${candidateName}-BANK-PROOF`,
        marksheet_certificate_upload: `${candidateName}-MARKSHEET-CERTIFICATE`,
        experience_letter: `${candidateName}-EXPERIENCE-LETTER`,
        noc_letter: `${candidateName}-NOC-LETTER`,
        offer_letter: `${candidateName}-OFFER-LETTER`
    };

    for (const field of Object.keys(files)) {
        const match = /^work_experience\[(\d+)\]\[experience_letter\]$/.exec(field);

        if (match) {
            uploadFields[field] = `${candidateName}-EXPERIENCE-LETTER-${match[1]}`;
        }

        const educationMatch = /^education\[(\d+)\]\[marksheet_certificate_upload\]$/.exec(field);

        if (educationMatch) {
            uploadFields[field] = `${candidateName}-MARKSHEET-CERTIFICATE-${educationMatch[1]}`;
        }
    }

    /* =====================================================
       UPLOAD
    ===================================================== */
    await Promise.all(Object.entries(uploadFields).map(async ([field, fileName]) => {
        const file = files[field]?.[0];

        /* =================================================
           FILE PRESENT
           Upload to Cloudinary
        ================================================= */
        if (file?.buffer) {
            const result = await uploadToCloudinary(
                file.buffer,
                fileName,
                candidateFolder,
                file.mimetype
            );

            req.body[field] = result?.secure_url || null;

            return;
        }

        /* =================================================
           NO FILE
           
           If URL is already sent in payload,
           keep that URL.
        ================================================= */
        if (
            req.body[field] !== undefined &&
            req.body[field] !== null &&
            String(req.body[field]).trim() !== ""
        ) {
            req.body[field] = String(req.body[field]).trim();
        }
    }));
};

/* =========================================================
   PARSE EDUCATION PAYLOAD
   EDUCATION IS OPTIONAL
========================================================= */
const parseEducationPayload = (
    education,
    educationDetails = {}
) => {
    const uploadedCertificates = educationDetails.uploadedMarksheetCertificates || {};

    const addUploadedCertificates = (items) => items.map(
        (item, index) => uploadedCertificates[index]
            ? {
                ...item,
                marksheet_certificate_upload:
                    item.marksheet_certificate_upload ||
                    uploadedCertificates[index]
            }
            : item
    );

    /* =================================================
       NULL
    ================================================= */
    if (
        education === null ||
        education === undefined
    ) {
        return [];
    }

    /* =================================================
       STRING NULL
    ================================================= */
    if (
        typeof education === "string"
    ) {
        let rawValue =
            education
                .trim()
                .replace(/^["']+/, "")
                ;

        while (
            rawValue.endsWith("\"") ||
            rawValue.endsWith("'")
        ) {
            rawValue = rawValue.slice(0, -1);
        }

        rawValue = rawValue.trim();

        if (
            rawValue === "" ||
            rawValue.toLowerCase() === "null" ||
            rawValue.toLowerCase() === "undefined"
        ) {
            return [];
        }
    }

    /* =================================================
       ALREADY ARRAY
    ================================================= */
    if (Array.isArray(education)) {
        return addUploadedCertificates(education);
    }

    /* =================================================
       STRING JSON ARRAY
    ================================================= */
    if (
        typeof education === "string"
    ) {
        const rawValue = education.trim();

        if (
            rawValue !== "" &&
            rawValue.startsWith("[") &&
            !rawValue.startsWith("{")
        ) {
            return [{
                education: rawValue,
                university_institution: educationDetails.university_institution,
                branch: educationDetails.branch,
                cgpa_percentage: educationDetails.cgpa_percentage,
                year_of_passing: educationDetails.year_of_passing,
                marksheet_certificate_upload:
                    uploadedCertificates[0] ||
                    educationDetails.marksheet_certificate_upload
            }];
        }

        let value;

        try {
            value =
                JSON.parse(
                    rawValue
                );

        } catch (error) {
            throw new Error("education must be a valid JSON array");
        }

        if (value === null) {
            return [];
        }

        if (Array.isArray(value)) {
            return addUploadedCertificates(value);
        }

        throw new Error("education must be an array");
    }

    /* =================================================
       OBJECT NOT ALLOWED
    ================================================= */
    if (
        typeof education === "object"
    ) {
        throw new TypeError("education must be an array");
    }

    throw new Error("education must be a valid JSON array");
};

const parseWorkExperiencePayload = (
    workExperience,
    uploadedExperienceLetters = {}
) => {
    const getUploadedLetter = (index) => {
        if (typeof uploadedExperienceLetters === "string") {
            return index === 0 ? uploadedExperienceLetters : null;
        }

        return uploadedExperienceLetters[index] || null;
    };

    if (
        workExperience === null ||
        workExperience === undefined ||
        workExperience === ""
    ) {
        return [];
    }

    if (Array.isArray(workExperience)) {
        return workExperience.map(
            (item, index) => getUploadedLetter(index)
                ? {
                    ...item,
                    experience_letter:
                        item.experience_letter ||
                        getUploadedLetter(index)
                }
                : item
        );
    }

    if (typeof workExperience === "string") {
        let parsed;

        try {
            parsed = JSON.parse(workExperience);
        } catch (error) {
            throw new Error("work_experience must be a valid JSON array");
        }

        if (Array.isArray(parsed)) {
            return parsed.map(
                (item, index) => getUploadedLetter(index)
                    ? {
                        ...item,
                        experience_letter:
                            item.experience_letter ||
                            getUploadedLetter(index)
                    }
                    : item
            );
        }
    }

    throw new Error(
        "work_experience must be an array"
    );
};

const getUploadedExperienceLetters = (body) => {
    const letters = {};

    for (const [field, value] of Object.entries(body || {})) {
        const match = /^work_experience\[(\d+)\]\[experience_letter\]$/.exec(field);

        if (match && value) {
            letters[match[1]] = value;
        }
    }

    return letters;
};

const getUploadedEducationCertificates = (body) => {
    const certificates = {};

    for (const [field, value] of Object.entries(body || {})) {
        const match = /^education\[(\d+)\]\[marksheet_certificate_upload\]$/.exec(field);

        if (match && value) {
            certificates[match[1]] = value;
        }
    }

    return certificates;
};

/* =========================================================
   RESOLVE EDUCATION ID
========================================================= */
const resolveEducationId = async (
    educationValue,
    workLocationId
) => {
    if (
        educationValue === null ||
        educationValue === undefined ||
        String(educationValue).trim() === ""
    ) {
        return null;
    }

    let value =
        String(educationValue)
            .trim()
            .replace(/^["']+/, "")
            .trim();

    /* =======================================================
        CASE 1
        Education ID received
    ======================================================= */
    if (/^\d+$/.test(value)) {
        const { rows } =
            await pool.query(
                `
                SELECT id
                FROM education
                WHERE id = $1
                  AND work_location = $2
                LIMIT 1
                `,
                [
                    Number(value),
                    Number(workLocationId)
                ]
            );

        return rows[0]?.id || null;
    }

    if (
        workLocationId === null ||
        workLocationId === undefined
    ) {
        const { rows } = await pool.query(
            `
                SELECT MIN(id) AS id
                FROM education
                WHERE LOWER(TRIM(education_name))
                      = LOWER(TRIM($1))
                GROUP BY LOWER(TRIM(education_name))
                HAVING COUNT(*) = 1
                LIMIT 1
            `,
            [value]
        );

        return rows[0]?.id || null;
    }

    /* =======================================================
        CASE 2
        Education name received
    ======================================================= */
    const educationId = await getEducationIdForEmployeeModel(
        workLocationId,
        value
    );

    return educationId || null;
};

/* =====================================================
   CLEAN VALUE
===================================================== */
const cleanValue = (value) => {

    /* =================================================
       ACTUAL NULL / UNDEFINED
    ================================================= */
    if (
        value === null ||
        value === undefined
    ) {
        return null;
    }

    /* =================================================
       BOOLEAN / NUMBER
    ================================================= */
    if (
        typeof value === "boolean" ||
        typeof value === "number"
    ) {
        return value;
    }

    /* =================================================
       STRING CLEAN
    ================================================= */
    let cleaned =
        String(value)
            .trim()
            .replace(/^["']+/, "");

    while (
        cleaned.endsWith('"') ||
        cleaned.endsWith("'")
    ) {
        cleaned = cleaned.slice(0, -1);
    }

    cleaned = cleaned.trim();

    /* =================================================
       NULL-LIKE STRING
    ================================================= */
    if (
        cleaned === "" ||
        cleaned.toLowerCase() === "null" ||
        cleaned.toLowerCase() === "undefined"
    ) {
        return null;
    }

    return cleaned;
};

const numberOrNull = (value) => {
    const cleaned = cleanValue(value);

    if (cleaned === null) {
        return null;
    }

    const number = Number(cleaned);
    return Number.isFinite(number) ? number : null;
};

const RESUME_IMAGE_MIME_TYPES = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    jpe: "image/jpeg",
    jfif: "image/jpeg",
    png: "image/png",
    ico: "image/x-icon",
    cur: "image/x-icon",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    svg: "image/svg+xml",
    tif: "image/tiff",
    tiff: "image/tiff"
};
const RESUME_EXTENSIONS = ["pdf", ...Object.keys(RESUME_IMAGE_MIME_TYPES)];
const CANDIDATE_RESUME_URL = id => `/api/candidate/resume/${id}`;
const candidateResumeBaseName = candidate => {
    const name = [candidate?.first_name, candidate?.last_name]
        .filter(value => String(value || "").trim())
        .join("-")
        .normalize("NFKD")
        .replace(/[^\w.-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .toUpperCase();
    const baseName = name || `CANDIDATE-${candidate?.id}`;
    return `${baseName}-RESUME`;
};

const getCandidateResumeFilePath = async (candidateId) => {
    const configuredPath = process.env.RESUME_UPLOAD_PATH;
    if (!configuredPath || !String(configuredPath).trim()) {
        throw new Error("RESUME_UPLOAD_PATH is not configured in .env");
    }

    const uploadDirectory = path.resolve(String(configuredPath).trim());
    for (const extension of RESUME_EXTENSIONS) {
        const filePath = path.join(
            uploadDirectory,
            `${candidateId}-RESUME.${extension}`
        );
        try {
            const stat = await fs.promises.stat(filePath);
            if (stat.isFile()) return { filePath, stat, extension };
        } catch (error) {
            if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
                throw error;
            }
        }
    }

    return null;
};

const getCandidateNamedResumeFilePath = async candidate => {
    const configuredPath = process.env.RESUME_UPLOAD_PATH;
    if (!configuredPath || !String(configuredPath).trim()) {
        throw new Error("RESUME_UPLOAD_PATH is not configured in .env");
    }

    const uploadDirectory = path.resolve(String(configuredPath).trim());
    const baseName = candidateResumeBaseName(candidate);
    for (const extension of RESUME_EXTENSIONS) {
        const filePath = path.join(uploadDirectory, `${baseName}.${extension}`);
        try {
            const stat = await fs.promises.stat(filePath);
            if (stat.isFile()) {
                return { filePath, stat, extension, fileName: path.basename(filePath) };
            }
        } catch (error) {
            if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
                throw error;
            }
        }
    }

    return null;
};

const addCandidateResumeUrl = async (candidate) => {
    if (!candidate) return candidate;

    const namedResume = await getCandidateNamedResumeFilePath(candidate);
    if (namedResume) {
        return {
            ...candidate,
            resume: `/api/candidate/resume/${encodeURIComponent(namedResume.fileName)}`
        };
    }

    if (await getCandidateResumeFilePath(candidate.id)) {
        return {
            ...candidate,
            resume: CANDIDATE_RESUME_URL(candidate.id)
        };
    }

    const legacyResume = String(candidate.resume || "").trim();
    if (legacyResume) {
        return {
            ...candidate,
            resume: `/api/candidate/resume/${encodeURIComponent(
                path.basename(legacyResume)
            )}`
        };
    }

    return { ...candidate, resume: null };
};

const persistUploadedResume = async (file, destination) => {
    await fs.promises.mkdir(path.dirname(destination), {
        recursive: true
    });

    if (file.path) {
        try {
            await fs.promises.rename(file.path, destination);
            return;
        } catch (error) {
            if (!["EPERM", "EACCES", "EXDEV", "EBUSY"].includes(error.code)) {
                throw error;
            }

            await fs.promises.copyFile(file.path, destination);
            await fs.promises.unlink(file.path);
            return;
        }
    }

    if (file.buffer) {
        await fs.promises.writeFile(destination, file.buffer);
        return;
    }

    throw new Error("Uploaded resume has no path or buffer");
};

/* =========================================================
   SAVE RESUME TO RESUME_UPLOAD_PATH
========================================================= */
const saveResumeToLocalPath = async (
    file,
    candidate
) => {
    if (
        (!file?.buffer && !file?.path) ||
        !Number.isSafeInteger(Number(candidate?.id)) ||
        Number(candidate.id) < 1
    ) {
        return null;
    }

    const configuredPath = process.env.RESUME_UPLOAD_PATH;

    if (
        !configuredPath ||
        String(configuredPath).trim() === ""
    ) {
        throw new Error(
            "RESUME_UPLOAD_PATH is not configured in .env"
        );
    }

    const uploadDirectory = path.resolve(String(configuredPath).trim());
    const extension =
        path.extname(
            file.originalname || ""
        ).toLowerCase() || ".pdf";

    if (!RESUME_EXTENSIONS.includes(extension.slice(1))) {
        throw new Error("Only PDF and image resumes are supported");
    }

    const resumeBaseName = candidateResumeBaseName(candidate);
    const fileName = `${resumeBaseName}${extension}`;
    const finalPath = path.join(uploadDirectory, fileName);
    await persistUploadedResume(file, finalPath);

    const existingFiles = await fs.promises.readdir(uploadDirectory);
    const resumePrefix = `${resumeBaseName}.`;
    await Promise.all(
        existingFiles
            .filter(name =>
                name.startsWith(resumePrefix) &&
                name !== fileName &&
                RESUME_EXTENSIONS.includes(
                    path.extname(name).slice(1).toLowerCase()
                )
            )
            .map(name => fs.promises.unlink(path.join(uploadDirectory, name)))
    );

    return finalPath;
};

/* =========================================================
   CREATE CANDIDATE
========================================================= */
export const createCandidate = async (req, res) => {
    try {
        const body = req.body || {};

        /* =====================================================
           FIRST NAME REQUIRED
        ===================================================== */
        if (
            !body.first_name ||
            !String(
                body.first_name
            ).trim()
        ) {
            return res.status(400).json({
                success: false,
                message: "First name is required"
            });
        }

        /* =====================================================
           LAST NAME REQUIRED
        ===================================================== */
        if (
            !body.last_name ||
            !String(
                body.last_name
            ).trim()
        ) {
            return res.status(400).json({
                success: false,
                message: "Last name is required"
            });
        }

        /* =====================================================
           CANDIDATE USERNAME
        ===================================================== */
        const candidateUsername =
            body.username
                ? String(body.username)
                    .trim()
                    .replace(/\s+/g, "_")
                    .toUpperCase()
                : null;

        /* =====================================================
           UPLOAD CANDIDATE FILES
        ===================================================== */
        await uploadCandidateFiles(
            req,
            candidateUsername,
            `${String(body.first_name)
                .trim()
                .replace(/\s+/g, "_")
                .toUpperCase()}-${String(body.last_name)
                    .trim()
                    .replace(/\s+/g, "_")
                    .toUpperCase()}`
        );

        /* =====================================================
           BASIC DATA
        ===================================================== */
        const {
            first_name,
            middle_name,
            last_name,
            username,
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
            image,
            mobile_number,
            alternate_contact_number,
            emergency_contact_name,
            emergency_contact_number,
            emergency_relationship,
            job_posting,
            job_position_id,
            source,
            past_salary,
            expected_salary,
            linkedin_profile_link,
            pan_card_number,
            pan_card_upload,
            aadhaar_number,
            aadhaar_upload,
            other_document_upload,
            bank_name,
            account_holder_name,
            account_number,
            ifsc_code,
            branch_name,
            bank_proof,
            education,
            work_experience,
            employment_id,
            rfid,
            designation,
            department,
            sub_department,
            category,
            date_of_joining,
            work_email,
            employment_type,
            shift_name,
            shift_type,
            work_location,
            reporting_manager,
            probation_period,
            notice_period,
            bond,
            internship_start_date,
            internship_end_date,
            internship_duration,
            noc_letter,
            offer_letter,
            has_experience,
            company_name,
            job_title,
            duration_from,
            duration_to,
            salary,
            reason_for_leaving,
            responsibilities,
            experience_letter,
            current_salary,
            effective_date,
            next_increment_date,
            candidate_status,
            note
        } = body;

        /* =====================================================
           CREATED BY
        ===================================================== */
        const created_by = req.headers["x-username"] || null;

        const resumeFile = req.files?.resume?.[0];

        /* =====================================================
           WORK LOCATION
        ===================================================== */
        const workLocationValue = cleanValue(
            work_location
        );

        const workLocationId = await getWorkLocationId(
            workLocationValue
        );

        /* =====================================================
           EDUCATION
           OPTIONAL BUT ALWAYS STORE ONE OBJECT
        ===================================================== */
        let educationPayload;

        try {
            educationPayload = parseEducationPayload(
                education,
                {
                    ...body,
                    uploadedMarksheetCertificates:
                        getUploadedEducationCertificates(body)
                }
            );

        } catch (error) {
            return res.status(400).json({
                success: false,
                message: error.message
            });
        }

        /* =====================================================
           DEFAULT EDUCATION OBJECT
           IF EDUCATION = NULL
        ===================================================== */
        let educationData = [
            {
                education: null,
                university_institution: null,
                branch: null,
                cgpa_percentage: null,
                year_of_passing: null,
                marksheet_certificate_upload: null
            }
        ];

        /* =====================================================
           EDUCATION ARRAY PROVIDED
        ===================================================== */
        if (Array.isArray(educationPayload)) {
            educationData = [];

            for (
                let i = 0;
                i < educationPayload.length;
                i++
            ) {
                const item = educationPayload[i];

                /* =============================================
                   VALIDATE EDUCATION ITEM
                ============================================= */
                if (
                    !item ||
                    typeof item !== "object" ||
                    Array.isArray(item)
                ) {
                    return res.status(400).json({
                        success: false,
                        message: `education[${i}] must be an object`
                    });
                }

                /* =============================================
                   EDUCATION VALUE
                ============================================= */
                const educationValue = cleanValue(
                    item.education
                );

                /* =============================================
                   RESOLVE EDUCATION MASTER ID
                ============================================= */
                const educationId = await resolveEducationId(
                    educationValue,
                    workLocationId
                );

                /* =============================================
                   CGPA / PERCENTAGE
                ============================================= */
                let cgpaPercentage = null;

                const cgpaValue =
                    cleanValue(
                        item.cgpa_percentage
                    );

                if (cgpaValue !== null) {
                    cgpaPercentage = Number(cgpaValue);

                    if (
                        Number.isNaN(
                            cgpaPercentage
                        )
                    ) {
                        return res.status(400).json({
                            success: false,
                            message: `education[${i}].cgpa_percentage must be a valid number`
                        });
                    }
                }

                /* =============================================
                   YEAR OF PASSING
                ============================================= */
                let yearOfPassing = null;

                const yearValue =
                    cleanValue(
                        item.year_of_passing
                    );

                if (yearValue !== null) {
                    yearOfPassing = Number(yearValue);
                    if (
                        Number.isNaN(
                            yearOfPassing
                        )
                    ) {
                        return res.status(400).json({
                            success: false,
                            message: `education[${i}].year_of_passing must be a valid number`
                        });
                    }
                }

                /* =============================================
                   EDUCATION OBJECT
                ============================================= */
                const educationItem = {
                    education: educationId,

                    university_institution:
                        cleanValue(
                            item.university_institution
                        ),

                    branch:
                        cleanValue(
                            item.branch
                        ),

                    cgpa_percentage: cgpaPercentage,
                    year_of_passing: yearOfPassing,

                    marksheet_certificate_upload:
                        cleanValue(
                            item.marksheet_certificate_upload
                        )
                };

                educationData.push(
                    educationItem
                );
            }
        }

        let workExperienceData = [];
        const workExperienceFields = [
            "company_name",
            "job_title",
            "duration_from",
            "duration_to",
            "salary",
            "reason_for_leaving",
            "responsibilities",
            "experience_letter"
        ];

        const hasWorkExperienceValues =
            workExperienceFields.some(
                (field) => cleanValue(body[field]) !== null
            );

        if (
            work_experience !== undefined &&
            work_experience !== null &&
            String(work_experience).trim() !== ""
        ) {
            try {
                workExperienceData =
                    parseWorkExperiencePayload(
                        work_experience,
                        getUploadedExperienceLetters(body)
                    );
            } catch (error) {
                return res.status(400).json({
                    success: false,
                    message: error.message
                });
            }
        } else if (hasWorkExperienceValues) {
            workExperienceData = [
                Object.fromEntries(
                    workExperienceFields.map(
                        (field) => [
                            field,
                            cleanValue(body[field])
                        ]
                    )
                )
            ];
        }

        /* =====================================================
           SHIFT
        ===================================================== */
        const shiftName =
            cleanValue(
                shift_name
            );

        const shiftType =
            cleanValue(
                shift_type
            );

        const shiftConfigurationId = await getShiftConfigurationId(
            shiftName,
            shiftType
        );

        /* =====================================================
           BOND
        ===================================================== */
        const bondValue = cleanValue(
            bond
        );

        const bondId = await getBondId(
            bondValue
        );

        /* =====================================================
           DEPARTMENT STRUCTURE
        ===================================================== */
        const designationValue =
            cleanValue(
                designation
            );

        const departmentValue =
            cleanValue(
                department
            );

        const subDepartmentValue =
            cleanValue(
                sub_department
            );

        /* =====================================================
           DESIGNATION
        ===================================================== */
        const designationId = await getDepartmentStructureId(
            designationValue
        );

        /* =====================================================
           DEPARTMENT
        ===================================================== */
        const departmentId = await getDepartmentStructureId(
            departmentValue,
            workLocationId,
            null
        );

        /* =====================================================
           SUB DEPARTMENT
        ===================================================== */
        const subDepartmentId = await getDepartmentStructureId(
            subDepartmentValue,
            workLocationId,
            departmentId
        );

        /* =====================================================
           CATEGORY
        ===================================================== */
        const categoryValue = cleanValue(category);
        const categoryId = await getCategoryId(categoryValue);

        /* =====================================================
           JOB POSITION ID
        ===================================================== */
        const jobPositionId = numberOrNull(job_position_id);

        /* =====================================================
           CREATE CANDIDATE
        ===================================================== */
        const data = await createCandidateModel({
            first_name:
                String(
                    first_name
                ).trim(),

            middle_name: cleanValue(middle_name),

            last_name:
                String(
                    last_name
                ).trim(),

            username: cleanValue(username),
            date_of_birth: cleanValue(date_of_birth),
            gender: cleanValue(gender),
            blood_group: cleanValue(blood_group),
            family_members_count: numberOrNull(family_members_count),
            marital_status: cleanValue(marital_status),
            anniversary_date: cleanValue(anniversary_date),
            dependent_children: numberOrNull(dependent_children),
            email_id: cleanValue(email_id),
            current_address: cleanValue(current_address),
            permanent_address: cleanValue(permanent_address),
            image: cleanValue(image),
            mobile_number: cleanValue(mobile_number),
            alternate_contact_number: cleanValue(alternate_contact_number),
            emergency_contact_name: cleanValue(emergency_contact_name),
            emergency_contact_number: cleanValue(emergency_contact_number),
            emergency_relationship: cleanValue(emergency_relationship),
            job_posting: cleanValue(job_posting),
            job_position_id: jobPositionId,
            source: cleanValue(source),
            past_salary: numberOrNull(past_salary),
            expected_salary: numberOrNull(expected_salary),
            linkedin_profile_link: cleanValue(linkedin_profile_link),
            resume: null,
            pan_card_number: cleanValue(pan_card_number),
            pan_card_upload: cleanValue(pan_card_upload),
            aadhaar_number: cleanValue(aadhaar_number),
            aadhaar_upload: cleanValue(aadhaar_upload),
            other_document_upload: cleanValue(other_document_upload),
            bank_name: cleanValue(bank_name),
            account_holder_name: cleanValue(account_holder_name),
            account_number: cleanValue(account_number),
            ifsc_code: cleanValue(ifsc_code),
            branch_name: cleanValue(branch_name),
            bank_proof: cleanValue(bank_proof),
            education: educationData,
            work_experience: workExperienceData,
            employment_id: cleanValue(employment_id),
            rfid: cleanValue(rfid),
            designation: designationId,
            department: departmentId,
            sub_department: subDepartmentId,
            category: categoryId,
            date_of_joining: cleanValue(date_of_joining),
            work_email: cleanValue(work_email),
            employment_type: cleanValue(employment_type),
            shift_name: shiftConfigurationId,
            shift_type: shiftConfigurationId,
            work_location: workLocationId,
            reporting_manager: cleanValue(reporting_manager),
            probation_period: cleanValue(probation_period),
            notice_period: cleanValue(notice_period),
            bond: bondId,
            internship_start_date: cleanValue(internship_start_date),
            internship_end_date: cleanValue(internship_end_date),
            internship_duration: cleanValue(internship_duration),
            noc_letter: cleanValue(noc_letter),
            offer_letter: cleanValue(offer_letter),
            has_experience:
                has_experience !==
                    undefined &&
                    has_experience !==
                    null
                    ? (
                        has_experience === true ||
                        has_experience === "true"
                    )
                    : null,

            company_name: cleanValue(company_name),
            job_title: cleanValue(job_title),
            duration_from: cleanValue(duration_from),
            duration_to: cleanValue(duration_to),
            salary: numberOrNull(salary),
            reason_for_leaving: cleanValue(reason_for_leaving),
            responsibilities: cleanValue(responsibilities),
            experience_letter: cleanValue(experience_letter),
            current_salary: numberOrNull(current_salary),
            effective_date: cleanValue(effective_date),
            next_increment_date: cleanValue(next_increment_date),
            candidate_status: cleanValue(candidate_status) || "New",
            created_by: cleanValue(created_by),
            note: cleanValue(note)
        });

        const io = getIO();
        if (io) {
            io.emit("candidate:created", {
                success: true,
                message: "Candidate added successfully",
                data
            });
        }

        /* =====================================================
           SUCCESS
        ===================================================== */
        if (resumeFile?.buffer || resumeFile?.path) {
            await saveResumeToLocalPath(resumeFile, data);
        }

        const candidateData = await addCandidateResumeUrl(data);

        return res.status(201).json({
            success: true,
            message: "Candidate added successfully",
            data: candidateData
        });

    } catch (error) {
        console.error("CREATE CANDIDATE ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* =========================================================
   TRANSFER CANDIDATE TO EMPLOYEE
========================================================= */
export const transferCandidateToEmployee = async (req, res) => {
    try {
        const candidateId =
            Number(req.params.id);

        if (
            !Number.isInteger(candidateId) ||
            candidateId <= 0
        ) {
            return res.status(400).json({
                success: false,
                message: "Valid candidate ID is required"
            });
        }

        const requestedStatus =
            req.body?.candidate_status ??
            req.body?.status_name ??
            req.body?.status;

        const data = await transferCandidateToEmployeeModel(
            candidateId,
            requestedStatus
        );

        const io = getIO();
        if (io && data.transferred !== false) {
            io.emit("candidate:transferred", {
                success: true,
                message: "Candidate transferred to employee successfully",
                data
            });
        }

        return res.status(200).json({
            success: true,
            message: data.transferred === false
                ? "No employee transfer required"
                : "Candidate transferred to employee successfully",
            data
        });

    } catch (error) {
        console.error("TRANSFER CANDIDATE ERROR:", error);
        return res.status(
            error.statusCode || 500
        ).json({
            success: false,
            message: error.message
        });
    }
};

/* =========================================================
   GET ALL CANDIDATES
========================================================= */
export const getCandidate = async (req, res) => {
    try {
        const {
            name,
            first_name,
            middle_name,
            last_name,
            email_id,
            mobile_number,
            job_posting,
            job_position_id,
            source,
            candidate_status,
            created_by,
            department,
            sub_department,
            designation,
            page,
            limit,
            pagination
        } = req.query;

        /* =================================================
           PAGINATION
        ================================================= */
        const paginationEnabled =
            String(pagination ?? "true")
                .trim()
                .toLowerCase() !== "false";

        const currentPage =
            Math.max(
                Number(page) || 1,
                1
            );

        const currentLimit =
            Math.max(
                Number(limit) || 20,
                1
            );

        const result = await getCandidateModel({
            name,
            first_name,
            middle_name,
            last_name,
            email_id,
            mobile_number,
            job_posting,
            job_position_id,
            source,
            candidate_status,
            created_by,
            department,
            sub_department,
            designation,
            paginationEnabled,
            page: currentPage,
            limit: currentLimit
        });


        const candidateData = await Promise.all(
            result.data.map(addCandidateResumeUrl)
        );

        return res.status(200).json({
            success: true,
            message: "Candidates fetched successfully",
            count: candidateData.length,
            data: candidateData,
            pagination: result.pagination
        });

    } catch (error) {
        console.error("GET CANDIDATE ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* =========================================================
   GET CANDIDATE STATUS STATS
========================================================= */
export const getCandidateStatusStats = async (req, res) => {
    try {
        const {
            job_position_id,
            job_posting
        } = req.query;

        const stats = await getCandidateStatusStatsModel({
            job_position_id,
            job_posting
        });

        return res.status(200).json({
            success: true,
            stats
        });

    } catch (error) {
        console.error("GET CANDIDATE STATUS STATS ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* =========================================================
   GET CANDIDATE BY ID
========================================================= */
export const getCandidateById = async (
    req,
    res
) => {
    try {
        const { id } = req.params;

        if (
            !id ||
            !Number.isInteger(Number(id))
        ) {
            return res.status(400).json({
                success: false,
                message: "Valid candidate ID is required"
            });
        }

        const candidate = await getCandidateByIdModel(
            Number(id)
        );
        const data = await addCandidateResumeUrl(candidate);

        return res.status(200).json({
            success: true,
            message: "Candidate fetched successfully",
            data
        });

    } catch (error) {
        console.error("GET CANDIDATE BY ID ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* =========================================================
   GET CANDIDATE RESUME
========================================================= */
export const getCandidateResume = async (req, res) => {
    try {
        const { fileName: requestedName } = req.params;

        if (
            !requestedName ||
            String(requestedName).trim() === ""
        ) {
            return res.status(400).json({
                success: false,
                message: "Candidate ID or resume file name is required"
            });
        }

        const configuredPath = process.env.RESUME_UPLOAD_PATH;
        if (!configuredPath || !String(configuredPath).trim()) {
            return res.status(500).json({
                success: false,
                message: "RESUME_UPLOAD_PATH is not configured"
            });
        }

        const requestedValue = String(requestedName).trim();
        let fileInfo = null;
        let safeFileName;

        if (/^\d+$/.test(requestedValue)) {
            fileInfo = await getCandidateResumeFilePath(Number(requestedValue));
            if (!fileInfo) {
                const candidate = await getCandidateByIdModel(Number(requestedValue));
                const legacyResume = String(candidate?.resume || "").trim();
                if (legacyResume) {
                    safeFileName = path.basename(legacyResume);
                }
            }
        } else {
            safeFileName = path.basename(requestedValue);
        }

        if (!fileInfo && !safeFileName) {
            return res.status(404).json({
                success: false,
                message: "Resume file not found"
            });
        }

        const filePath = fileInfo?.filePath || path.join(
            path.resolve(String(configuredPath).trim()),
            safeFileName
        );
        safeFileName ||= path.basename(filePath);
        const extension = fileInfo?.extension ||
            path.extname(safeFileName).toLowerCase().replace(/^\./, "");
        const contentType = extension === "pdf"
            ? "application/pdf"
            : RESUME_IMAGE_MIME_TYPES[extension];

        if (!contentType) {
            return res.status(415).json({
                success: false,
                viewable: false,
                extension: extension || null,
                message: "This file cannot be viewed"
            });
        }

        let stat = fileInfo?.stat;
        try {
            stat = await fs.promises.stat(filePath);
            if (!stat.isFile()) {
                return res.status(404).json({
                    success: false,
                    message: "Resume file not found"
                });
            }
        } catch (error) {
            if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
                throw error;
            }
            return res.status(404).json({
                success: false,
                message: "Resume file not found"
            });
        }

        res.setHeader("Content-Type", contentType);
        res.setHeader(
            "Content-Disposition",
            `inline; filename="${encodeURIComponent(safeFileName)}"; ` +
                `filename*=UTF-8''${encodeURIComponent(safeFileName)}`
        );
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("X-File-Category", extension === "pdf" ? "pdf" : "image");
        res.setHeader("X-File-Extension", extension);
        res.setHeader("Content-Length", String(stat.size));
        res.setHeader("Cache-Control", "no-store");

        const stream = fs.createReadStream(filePath);
        stream.on("error", error => {
            console.error("CANDIDATE RESUME STREAM ERROR:", error);
            if (!res.headersSent) {
                res.status(500).json({
                    success: false,
                    message: "Failed to stream resume"
                });
            } else {
                res.destroy(error);
            }
        });
        return stream.pipe(res);

    } catch (error) {
        console.error("GET CANDIDATE RESUME ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to open resume",
            error: error.message
        });
    }
};

/* =========================================================
   UPDATE CANDIDATE
========================================================= */
export const updateCandidate = async (
    req,
    res
) => {
    try {
        const { id } = req.params;
        const body = req.body || {};

        /* =====================================================
           NORMALIZE NULL VALUES
        ===================================================== */
        for (const key of Object.keys(body)) {
            if (key === "education") {
                continue;
            }

            if (
                body[key] === null ||
                body[key] === undefined ||
                (
                    typeof body[key] === "string" &&
                    (
                        body[key].trim() === "" ||
                        body[key].trim().toLowerCase() === "null" ||
                        body[key].trim().toLowerCase() === "undefined"
                    )
                )
            ) {
                body[key] = null;
            }
        }

        const edited_by = req.headers["x-username"] || null;

        /* =====================================================
           VALIDATE ID
        ===================================================== */
        const candidateId = Number(id);

        /* =====================================================
           GET OLD DATA
        ===================================================== */
        const oldData = await getCandidateByIdModel(
            candidateId
        );
        if (!oldData) {
            return res.status(404).json({
                success: false,
                message: "Candidate not found"
            });
        }

        /* =====================================================
           CANDIDATE USERNAME
        ===================================================== */
        let candidateUsername = null;
        if (body.username) {
            candidateUsername = String(body.username).trim();
        } else if (oldData.username) {
            candidateUsername = String(oldData.username).trim();
        }

        /* =====================================================
           UPLOAD FILES
        ===================================================== */
        await uploadCandidateFiles(
            req,
            candidateUsername,
            `${String(body.first_name || oldData.first_name)
                .trim()
                .replace(/\s+/g, "_")
                .toUpperCase()}-${String(body.last_name || oldData.last_name)
                    .trim()
                    .replace(/\s+/g, "_")
                    .toUpperCase()}`
        );

        const resumeFile = req.files?.resume?.[0];
        if (resumeFile?.buffer || resumeFile?.path) {
            await saveResumeToLocalPath(resumeFile, {
                ...oldData,
                first_name: body.first_name ?? oldData.first_name,
                last_name: body.last_name ?? oldData.last_name
            });
        }
        delete body.resume;

        /* =====================================================
           WORK LOCATION
        ===================================================== */
        let workLocationId = oldData.work_location || null;

        if (
            Object.hasOwn(
                body,
                "work_location"
            )
        ) {
            const workLocationValue =
                body.work_location === null ||
                    body.work_location === undefined
                    ? null
                    : String(
                        body.work_location
                    )
                        .trim()
                        .replace(
                            /^["']+|["']+$/g,
                            ""
                        )
                        .trim();

            if (
                workLocationValue === null ||
                workLocationValue === ""
            ) {
                workLocationId = null;
            } else {
                workLocationId = await getWorkLocationId(
                    workLocationValue
                );
            }

            body.work_location = workLocationId;
        }

        /* =========================================================
           EDUCATION
        ========================================================= */
        if (
            Object.hasOwn(
                body,
                "education"
            )
        ) {
            let educationPayload;

            /* =====================================================
               PARSE EDUCATION JSON
            ===================================================== */
            try {
                educationPayload =
                    parseEducationPayload(
                        body.education,
                        {
                            ...body,
                            uploadedMarksheetCertificates:
                                getUploadedEducationCertificates(body)
                        }
                    );

            } catch (error) {
                return res.status(400).json({
                    success: false,
                    message: error.message
                });
            }

            /* =====================================================
               EDUCATION DATA
            ===================================================== */
            /* =====================================================
               PROCESS EACH EDUCATION
            ===================================================== */
            const educationData = await Promise.all(
                educationPayload.map(async (item) => {

                /* =================================================
                   EDUCATION VALUE
                ================================================= */
                const educationValue = item.education;

                /* =================================================
                   RESOLVE EDUCATION ID
                ================================================= */
                const educationId = await resolveEducationId(
                    educationValue,
                    workLocationId
                );

                /* =================================================
                   CGPA / PERCENTAGE
                ================================================= */
                let cgpaPercentage = null;

                if (
                    item.cgpa_percentage !== null &&
                    item.cgpa_percentage !== undefined &&
                    String(
                        item.cgpa_percentage
                    ).trim() !== ""
                ) {
                    cgpaPercentage =
                        Number(
                            item.cgpa_percentage
                        );
                }

                /* =================================================
                   YEAR OF PASSING
                ================================================= */
                let yearOfPassing = null;

                if (
                    item.year_of_passing !== null &&
                    item.year_of_passing !== undefined &&
                    String(
                        item.year_of_passing
                    ).trim() !== ""
                ) {
                    yearOfPassing =
                        Number(
                            item.year_of_passing
                        );
                }

                /* =================================================
                   CREATE EDUCATION OBJECT
                ================================================= */
                return {
                    education: educationId,

                    university_institution:
                        item.university_institution !==
                            undefined &&
                            item.university_institution !==
                            null &&
                            String(
                                item.university_institution
                            ).trim() !== ""
                            ? String(
                                item.university_institution
                            ).trim()
                            : null,

                    branch:
                        item.branch !== undefined &&
                            item.branch !== null &&
                            String(
                                item.branch
                            ).trim() !== ""
                            ? String(
                                item.branch
                            ).trim()
                            : null,

                    cgpa_percentage: cgpaPercentage,
                    year_of_passing: yearOfPassing,

                    marksheet_certificate_upload:
                        item.marksheet_certificate_upload !==
                            undefined &&
                            item.marksheet_certificate_upload !==
                            null &&
                            String(
                                item.marksheet_certificate_upload
                            ).trim() !== ""
                            ? String(
                                item.marksheet_certificate_upload
                            ).trim()
                            : null
                };
                })
            );

            /* =====================================================
               SAVE EDUCATION JSONB
            ===================================================== */
            body.education = educationData;
        }

        const workExperienceFields = [
            "company_name",
            "job_title",
            "duration_from",
            "duration_to",
            "salary",
            "reason_for_leaving",
            "responsibilities",
            "experience_letter"
        ];

        const hasWorkExperienceField =
            Object.hasOwn(body, "work_experience") ||
            workExperienceFields.some(
                (field) => Object.hasOwn(body, field)
            );

        if (hasWorkExperienceField) {
            if (
                Object.hasOwn(body, "work_experience") &&
                body.work_experience !== null &&
                body.work_experience !== undefined &&
                String(body.work_experience).trim() !== ""
            ) {
                try {
                    body.work_experience =
                        parseWorkExperiencePayload(
                            body.work_experience,
                            getUploadedExperienceLetters(body)
                        );
                } catch (error) {
                    return res.status(400).json({
                        success: false,
                        message: error.message
                    });
                }
            } else {
                const hasWorkExperienceValues =
                    workExperienceFields.some(
                        (field) => cleanValue(body[field]) !== null
                    );

                body.work_experience =
                    hasWorkExperienceValues
                        ? [
                            Object.fromEntries(
                                workExperienceFields.map(
                                    (field) => [
                                        field,
                                        cleanValue(body[field])
                                    ]
                                )
                            )
                        ]
                        : [];
            }
        }

        /* =====================================================
           SHIFT
        ===================================================== */
        const hasShiftName =
            Object.hasOwn(
                body,
                "shift_name"
            );

        const hasShiftType =
            Object.hasOwn(
                body,
                "shift_type"
            );

        if (
            hasShiftName ||
            hasShiftType
        ) {
            const finalShiftName =
                hasShiftName
                    ? body.shift_name
                    : oldData.shift_name;

            const finalShiftType =
                hasShiftType
                    ? body.shift_type
                    : oldData.shift_type;

            /*
             * If both are null, remove shift.
             */
            if (
                (
                    finalShiftName === null ||
                    finalShiftName === undefined ||
                    finalShiftName === ""
                ) &&
                (
                    finalShiftType === null ||
                    finalShiftType === undefined ||
                    finalShiftType === ""
                )
            ) {
                body.shift_name = null;
                body.shift_type = null;
            } else {
                const shiftConfigurationId =
                    await getShiftConfigurationId(
                        finalShiftName,
                        finalShiftType
                    );

                body.shift_name = shiftConfigurationId;
                body.shift_type = shiftConfigurationId;
            }
        }

        /* =====================================================
           BOND
        ===================================================== */
        if (
            Object.hasOwn(
                body,
                "bond"
            )
        ) {
            const bondValue =
                body.bond === null ||
                    body.bond === undefined
                    ? null
                    : String(
                        body.bond
                    )
                        .trim()
                        .replace(
                            /^["']+|["']+$/g,
                            ""
                        )
                        .trim();

            if (
                bondValue === null ||
                bondValue === ""
            ) {
                body.bond = null;
            } else {
                const bondId =
                    await getBondId(
                        bondValue
                    );

                body.bond = bondId;
            }
        }

        /* =====================================================
           DEPARTMENT STRUCTURE
        ===================================================== */
        const hasDesignation =
            Object.hasOwn(
                body,
                "designation"
            );

        const hasDepartment =
            Object.hasOwn(
                body,
                "department"
            );

        const hasSubDepartment =
            Object.hasOwn(
                body,
                "sub_department"
            );

        const designationValue =
            hasDesignation
                ? body.designation
                : oldData.designation;

        const departmentValue =
            hasDepartment
                ? body.department
                : oldData.department;

        const subDepartmentValue =
            hasSubDepartment
                ? body.sub_department
                : oldData.sub_department;

        /* ================= DESIGNATION ================= */
        if (hasDesignation) {
            if (
                designationValue === null ||
                designationValue === undefined ||
                String(
                    designationValue
                ).trim() === ""
            ) {
                body.designation = null;
            } else {
                const designationId = await getDepartmentStructureId(
                    designationValue
                );

                body.designation = designationId;
            }
        }

        /* ================= DEPARTMENT ================= */
        if (hasDepartment) {
            if (
                departmentValue === null ||
                departmentValue === undefined ||
                String(
                    departmentValue
                ).trim() === ""
            ) {
                body.department = null;

            } else {
                const departmentId = await getDepartmentStructureId(
                    departmentValue,
                    workLocationId,
                    null
                );

                body.department = departmentId;
            }
        }

        /* =====================================================
           FINAL DEPARTMENT ID
        ===================================================== */
        const finalDepartmentId =
            body.department !== undefined
                ? body.department
                : oldData.department;

        /* ================= SUB DEPARTMENT ================= */
        if (hasSubDepartment) {
            if (
                subDepartmentValue === null ||
                subDepartmentValue === undefined ||
                String(
                    subDepartmentValue
                ).trim() === ""
            ) {
                body.sub_department = null;

            } else {
                const subDepartmentId = await getDepartmentStructureId(
                    subDepartmentValue,
                    workLocationId,
                    finalDepartmentId
                );

                body.sub_department = subDepartmentId;
            }
        }

        /* =====================================================
           CATEGORY
        ===================================================== */
        const hasCategory =
            Object.hasOwn(
                body,
                "category"
            );

        if (hasCategory) {
            const categoryValue =
                body.category === null ||
                    body.category === undefined
                    ? null
                    : String(
                        body.category
                    )
                        .trim()
                        .replace(
                            /^["']+|["']+$/g,
                            ""
                        )
                        .trim();

            if (
                categoryValue === null ||
                categoryValue === ""
            ) {
                body.category = null;

            } else {
                const categoryId = await getCategoryId(
                    categoryValue
                );

                body.category = categoryId;
            }
        }

        /* =====================================================
           JOB POSITION
        ===================================================== */
        if (
            Object.hasOwn(
                body,
                "job_position_id"
            )
        ) {
            if (
                body.job_position_id === null ||
                body.job_position_id === undefined ||
                body.job_position_id === ""
            ) {
                body.job_position_id = null;
            } else {
                const jobPositionId =
                    Number(
                        body.job_position_id
                    );

                body.job_position_id = jobPositionId;
            }
        }

        /* =====================================================
           CANDIDATE STATUS
        ===================================================== */
        if (
            Object.hasOwn(
                body,
                "candidate_status"
            )
        ) {
            let candidateStatus =
                body.candidate_status === null ||
                    body.candidate_status === undefined
                    ? null
                    : String(
                        body.candidate_status
                    )
                        .trim()
                        .replace(
                            /^['"]+/, 
                            ""
                        )
                        .trim();

            while (
                candidateStatus.endsWith("'") ||
                candidateStatus.endsWith('"')
            ) {
                candidateStatus = candidateStatus.slice(0, -1);
            }

            candidateStatus = candidateStatus.trim();

            if (
                candidateStatus === null ||
                candidateStatus === ""
            ) {
                body.candidate_status = null;

            } else {
                body.candidate_status = candidateStatus;
            }
        }

        /* =====================================================
           INTEGER FIELDS
        ===================================================== */
        const integerFields = [
            "family_members_count",
            "dependent_children",
            "job_position_id",
            "salary"
        ];

        for (const field of integerFields) {
            if (
                body[field] !== undefined &&
                body[field] !== null &&
                body[field] !== ""
            ) {
                const value = Number(
                    body[field]
                );

                body[field] = value;
            }
        }

        /* =====================================================
           NUMERIC FIELDS
        ===================================================== */
        const numericFields = [
            "past_salary",
            "expected_salary",
            "current_salary"
        ];

        for (const field of numericFields) {
            if (
                body[field] !== undefined &&
                body[field] !== null &&
                body[field] !== ""
            ) {
                const value =
                    Number(
                        body[field]
                    );

                body[field] = value;
            }
        }

        /* =====================================================
           BOOLEAN
        ===================================================== */
        if (
            body.has_experience !== undefined
        ) {
            if (
                body.has_experience === true ||
                body.has_experience === "true"
            ) {
                body.has_experience = true;

            } else if (
                body.has_experience === false ||
                body.has_experience === "false"
            ) {
                body.has_experience = false;

            } else {
                return res.status(400).json({
                    success: false,
                    message: "has_experience must be true or false"
                });
            }
        }

        /* =====================================================
           UPDATE
        ===================================================== */
        let data = null;
        if (Object.keys(body).length) {
            data = await updateCandidateModel(candidateId, body);
        } else if (resumeFile) {
            data = await getCandidateByIdModel(candidateId);
        }

        if (!data) {
            return res.status(404).json({
                success: false,
                message: "Candidate update failed"
            });
        }

        const candidateData = await addCandidateResumeUrl(data);

        /* =====================================================
           EDIT LOG
        ===================================================== */
        await addEmployeeEditLogModel({
            personal_details_id: null,
            username: oldData.created_by || null,
            edited_by:
                edited_by
                    ? String(
                        edited_by
                    ).trim()
                    : null,

            action: "UPDATE",
            old_value: oldData,
            new_value: candidateData,
            description: `Candidate ID ${data.id} updated`
        });

        const io = getIO();
        if (io) {
            io.emit("candidate:updated", {
                success: true,
                message: "Candidate updated successfully",
                data: candidateData
            });
        }

        /* =====================================================
           RESPONSE
        ===================================================== */
        return res.status(200).json({
            success: true,
            message: "Candidate updated successfully",
            data: candidateData
        });

    } catch (error) {
        console.error("UPDATE CANDIDATE ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};
