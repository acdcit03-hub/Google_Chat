import XLSX from "xlsx";
import { google } from "googleapis";
import { pool } from "../../database.js";
import { encryptPayrollAmount } from "../../utils/payrollEncryption.js";

const clean = (value) => {
    if (value === undefined || value === null) return null;

    if (typeof value === "string") {
        value = value.trim();
        return value === "" ? null : value;
    }

    return value;
};

const toInt = (value, defaultValue = null) => {
    value = clean(value);

    if (value === null) return defaultValue;

    const num = Number(value);

    return Number.isNaN(num) ? defaultValue : num;
};

const formatDate = (value) => {
    value = clean(value);

    if (!value) return null;

    // Already in YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return value;
    }

    // DD-MM-YYYY
    if (/^\d{2}-\d{2}-\d{4}$/.test(value)) {
        const [day, month, year] = value.split("-");
        return `${year}-${month}-${day}`;
    }

    // DD/MM/YYYY
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(value)) {
        const [day, month, year] = value.split("/");
        return `${year}-${month}-${day}`;
    }

    // Excel serial number
    if (!isNaN(value)) {
        const date = XLSX.SSF.parse_date_code(Number(value));

        if (!date) return null;

        const yyyy = date.y;
        const mm = String(date.m).padStart(2, "0");
        const dd = String(date.d).padStart(2, "0");

        return `${yyyy}-${mm}-${dd}`;
    }

    return null;
};

const toUpper = (value) => {
    value = clean(value);

    if (value === null) return null;

    return String(value).toUpperCase();
};

const toTitleCase = (value) => {
    value = clean(value);

    if (!value) return null;

    return value
        .toLowerCase()
        .split(/\s+/)
        .map(word =>
            word.charAt(0).toUpperCase() + word.slice(1)
        )
        .join(" ");
};

const generateUsername = async (
    client,
    firstName,
    middleName,
    lastName
) => {

    const first = clean(firstName)?.charAt(0) || "";
    const middle = clean(middleName)?.charAt(0) || "";
    const last = clean(lastName)?.charAt(0) || "";

    const baseUsername = `${first}${middle}${last}`.toUpperCase();

    let username = baseUsername;
    let counter = 1;

    while (true) {

        const { rows } = await client.query(
            `
            SELECT id
            FROM personal_details
            WHERE UPPER(username) = UPPER($1)
            `,
            [username]
        );

        if (rows.length === 0) {
            return username;
        }

        username = `${baseUsername}${counter}`;
        counter++;
    }
};

/* ================= GOOGLE SHEET CLIENT ================= */

const getSheetsClient = () => {

    const credentials = JSON.parse(
        process.env.GOOGLE_SERVICE_ACCOUNT_JSON
    );

    credentials.private_key =
        credentials.private_key.replace(/\\n/g, "\n");

    const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: [
            "https://www.googleapis.com/auth/spreadsheets.readonly"
        ]
    });

    return google.sheets({
        version: "v4",
        auth
    });

};

/* ================= IMPORT GOOGLE SHEET / EXCEL ================= */

export const importGoogleSheet = async (req, res) => {

    const client = await pool.connect();

    try {

        let rows = [];

        /* ================= GOOGLE SHEET ================= */

        if (req.body?.sheetUrl) {

            const match = req.body.sheetUrl.match(/\/d\/([^/]+)/);

            if (!match) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid Google Sheet URL"
                });
            }

            const sheetId = match[1];

            const sheets = getSheetsClient();

            const response =
                await sheets.spreadsheets.values.get({
                    spreadsheetId: sheetId,
                    range: "A:ZZ"
                });

            const headers =
                response.data.values?.[0] || [];

            const dataRows =
                response.data.values?.slice(1) || [];

            rows = dataRows.map((row) => {

                const obj = {};

                headers.forEach((header, index) => {

                    obj[header.trim()] =
                        row[index] ?? null;

                });

                return obj;

            });

        }

        /* ================= EXCEL ================= */

        else if (req.file) {

            // console.log("REQ.FILE :", req.file);

            let workbook;

            // If multer uses memoryStorage
            if (req.file.buffer) {

                workbook = XLSX.read(req.file.buffer, {
                    type: "buffer"
                });

            }

            // If multer uses diskStorage
            else if (req.file.path) {

                workbook = XLSX.readFile(req.file.path);

            }

            else {

                return res.status(400).json({
                    success: false,
                    message: "Uploaded file not found."
                });

            }

            const worksheet =
                workbook.Sheets[
                workbook.SheetNames[0]
                ];

            rows = XLSX.utils.sheet_to_json(worksheet, {
                defval: "",
                raw: false
            }).map((row) => {
                const obj = {};

                Object.keys(row).forEach((key) => {
                    obj[key.trim()] = clean(row[key]);
                });

                return obj;
            });

        }

        else {

            return res.status(400).json({
                success: false,
                message: "Provide Google Sheet URL or Excel File."
            });

        }

        if (!rows.length) {

            return res.status(400).json({
                success: false,
                message: "No data found."
            });

        }

        let inserted = 0;
        let skipped = 0;
        const errors = [];

        await client.query("BEGIN");

        for (const row of rows) {

            try {

                /* ================= CHECK USERNAME ================= */

                const exists =
                    await client.query(
                        `
                        SELECT id
                        FROM personal_details
                        WHERE LOWER(username)=LOWER($1)
                        `,
                        [row.username]
                    );

                if (exists.rows.length) {

                    skipped++;

                    errors.push({
                        username: row.username,
                        message: "Username already exists"
                    });

                    continue;

                }

                const username = await generateUsername(
                    client,
                    row.first_name,
                    row.middle_name,
                    row.last_name
                );

                /* ================= INSERT PERSONAL DETAILS ================= */
                const personal = await client.query(
                    `
                        INSERT INTO personal_details
                        (
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
                            emergency_relationship
                        )
                        VALUES
                        (
                            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
                            $11,$12,$13,$14,$15,$16,$17,$18,$19,$20
                        )
                        RETURNING id
                    `,
                    [
                        toUpper(row.first_name),
                        toUpper(row.middle_name),
                        toUpper(row.last_name),
                        username,
                        formatDate(row.date_of_birth),
                        toUpper(row.gender),
                        toUpper(row.blood_group),
                        toInt(row.family_members_count, 0),
                        toUpper(row.marital_status),
                        formatDate(row.anniversary_date || null),
                        toInt(row.dependent_children, 0),
                        clean(row.email_id),
                        toTitleCase(row.current_address),
                        toTitleCase(row.permanent_address),
                        clean(row.image),
                        toInt(row.mobile_number),
                        toInt(row.alternate_contact_number),
                        toUpper(row.emergency_contact_name),
                        toInt(row.emergency_contact_number),
                        clean(row.emergency_relationship)
                    ]
                );
                const personal_details_id = personal.rows[0].id;

                /* ================= INSERT IDENTIFICATION DETAILS ================= */
                const identification = await client.query(
                    `
                        INSERT INTO identification_details (
                            personal_details_id,
                            pan_card_number,
                            pan_card_upload,
                            aadhaar_number,
                            aadhaar_upload,
                            other_document_upload
                        )
                        VALUES ($1,$2,$3,$4,$5,$6)
                        RETURNING *;
                    `,
                    [
                        personal_details_id,
                        clean(row.pan_card_number || null),
                        clean(row.pan_card_upload || null),
                        clean(row.aadhaar_number || null),
                        clean(row.aadhaar_upload || null),
                        clean(row.other_document_upload || null),
                    ]
                );
                const identification_details = identification.rows[0].id;

                /* ================= INSERT BANK DETAILS ================= */
                const bank = await client.query(
                    `
                        INSERT INTO bank_details (
                            personal_details_id,
                            bank_name,
                            account_holder_name,
                            account_number,
                            ifsc_code,
                            branch_name,
                            bank_proof
                        )
                        VALUES ($1,$2,$3,$4,$5,$6,$7)
                        RETURNING *;
                    `,
                    [
                        personal_details_id,
                        clean(row.bank_name || null),
                        clean(row.account_holder_name || null),
                        clean(row.account_number || null),
                        clean(row.ifsc_code || null),
                        clean(row.branch_name || null),
                        clean(row.bank_proof || null)
                    ]
                );
                const bank_details = bank.rows[0].id;

                /* ================= INSERT EDUCATIONAL QUALIFICATIONS DETAILS ================= */
                const educational = await client.query(
                    `
                        INSERT INTO educational_qualifications (
                            personal_details_id,
                            education,
                            university_institution,
                            branch,
                            cgpa_percentage,
                            year_of_passing,
                            marksheet_certificate_upload
                        )
                        VALUES ($1,$2,$3,$4,$5,$6,$7)
                        RETURNING *;
                    `,
                    [
                        personal_details_id,
                        clean(row.education || null),
                        clean(row.university_institution || null),
                        clean(row.branch || null),
                        clean(row.cgpa_percentage || null),
                        clean(row.year_of_passing || null),
                        clean(row.marksheet_certificate_upload || null)
                    ]
                );
                const educational_qualifications = educational.rows[0].id;

                /* ================= INSERT EMPLOYMENT DETAILS ================= */
                const employee = await client.query(
                    `
                        INSERT INTO employment_details (
                            personal_details_id,
                            employment_id,
                            rfid,
                            designation,
                            department,
                            sub_department,
                            category,
                            date_of_joining,
                            work_email,
                            employment_type,
                            work_location,
                            reporting_manager,
                            probation_period,
                            notice_period,
                            bond,
                            has_experience
                        )
                        VALUES (
                            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
                            $11,$12,$13,$14,$15,$16
                        )
                        RETURNING *;
                    `,
                    [
                        personal_details_id,
                        clean(row.employment_id || null),
                        clean(row.rfid || null),
                        clean(row.designation || null),
                        clean(row.department || null),
                        clean(row.sub_department || null),
                        clean(row.category || null),
                        clean(row.date_of_joining || null),
                        clean(row.work_email || null),
                        clean(row.employment_type || null),
                        clean(row.work_location || null),
                        clean(row.reporting_manager || null),
                        clean(row.probation_period || null),
                        clean(row.notice_period || null),
                        clean(row.bond || null),
                        clean(row.has_experience || null)
                    ]
                );
                const employment_details = employee.rows[0].id;

                /* ================= INSERT WORK EXPERIENCE DETAILS ================= */
                const work_experience = await client.query(
                    `
                        INSERT INTO work_experience (
                            personal_details_id,
                            company_name,
                            job_title,
                            duration_from,
                            duration_to,
                            salary,
                            reason_for_leaving,
                            responsibilities,
                            experience_letter
                        )
                        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                        RETURNING *;
                    `,
                    [
                        personal_details_id,
                        clean(row.company_name || null),
                        clean(row.job_title || null),
                        formatDate(row.duration_from || null),
                        formatDate(row.duration_to || null),
                        clean(row.salary || null),
                        clean(row.reason_for_leaving || null),
                        clean(row.responsibilities || null),
                        clean(row.experience_letter || null)
                    ]
                );
                const work_experience_details = work_experience.rows[0].id;

                /* ================= INSERT SALARY DETAILS ================= */
                const salary = await client.query(
                    `
                        INSERT INTO salary_details (
                            personal_details_id,
                            current_salary,
                            effective_date,
                            next_increment_date
                        )
                        VALUES ($1,$2,$3,$4)
                        RETURNING *;
                    `,
                    [
                        personal_details_id,
                        encryptPayrollAmount(clean(row.current_salary || null)),
                        clean(row.effective_date || null),
                        clean(row.next_increment_date || null)
                    ]
                );
                const salary_details = salary.rows[0].id;               

                inserted++;

            }

            catch (error) {

                skipped++;

                errors.push({

                    username: row.username,
                    message: error.message

                });

            }

        }

        await client.query("COMMIT");

        return res.status(200).json({

            success: true,
            message: "Import Completed",

            total: rows.length,
            inserted,
            skipped,
            errors

        });

    }

    catch (error) {

        await client.query("ROLLBACK");

        console.log(error);

        return res.status(500).json({

            success: false,
            message: error.message

        });

    }

    finally {

        client.release();

    }

};