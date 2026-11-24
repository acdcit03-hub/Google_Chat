import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "../../config/db.js";
import { decryptPayrollFields } from "../../utils/payrollEncryption.js";

const offerLetterTemplatePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../assets/offer-letter-template.docx"
);

export const initializeOfferLetterFormatTables = async () => {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS offer_letter_format (
            id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
            content_html JSONB,
            updated_by VARCHAR(255),
            updated_at TIMESTAMPTZ
        );

        CREATE TABLE IF NOT EXISTS offer_letter_format_history (
            id SERIAL PRIMARY KEY,
            old_value JSONB,
            new_value JSONB,
            updated_by VARCHAR(255),
            updated_at TIMESTAMPTZ
        );
    `);

    await pool.query(`
        ALTER TABLE offer_letter_format
            ADD COLUMN IF NOT EXISTS content_html TEXT,
            ADD COLUMN IF NOT EXISTS updated_by VARCHAR(255),
            ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ,
            DROP COLUMN IF EXISTS work_location;

        ALTER TABLE offer_letter_format_history
            ADD COLUMN IF NOT EXISTS old_value JSONB,
            ADD COLUMN IF NOT EXISTS new_value JSONB,
            ADD COLUMN IF NOT EXISTS updated_by VARCHAR(255),
            ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ,
            DROP COLUMN IF EXISTS work_location;
    `);

    await pool.query(`
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'offer_letter_format_history'
                  AND column_name = 'content_html'
            ) THEN
                UPDATE offer_letter_format_history
                SET old_value = CASE
                    WHEN old_value IS NOT NULL THEN old_value
                    WHEN content_html IS NULL THEN NULL
                    WHEN pg_typeof(content_html)::text = 'jsonb' THEN content_html::jsonb
                    ELSE to_jsonb(content_html::text)
                END
                WHERE old_value IS NULL;
            END IF;
        END
        $$;
    `);

    await pool.query(`
        ALTER TABLE offer_letter_format_history
            DROP COLUMN IF EXISTS content_html,
            DROP COLUMN IF EXISTS replaced_by,
            DROP COLUMN IF EXISTS replaced_at;
    `);

    await pool.query(`
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'offer_letter_format'
                  AND column_name = 'content_html'
                  AND udt_name <> 'jsonb'
            ) THEN
                ALTER TABLE offer_letter_format
                    ALTER COLUMN content_html TYPE JSONB
                    USING (
                        CASE
                            WHEN content_html IS NULL OR BTRIM(content_html) = '' THEN NULL
                            ELSE to_jsonb(content_html)
                        END
                    );
            END IF;
        END
        $$;
    `);

    await pool.query(`
        ALTER TABLE offer_letter_format
            ADD COLUMN IF NOT EXISTS template_file BYTEA;
    `);

    if (fs.existsSync(offerLetterTemplatePath)) {
        await pool.query(
            `
            INSERT INTO offer_letter_format (
                id,
                template_file,
                updated_by,
                updated_at
            )
            VALUES (1, $1, 'system', CURRENT_TIMESTAMP)
            ON CONFLICT (id) DO UPDATE SET
                template_file = EXCLUDED.template_file,
                updated_at = CURRENT_TIMESTAMP;
            `,
            [fs.readFileSync(offerLetterTemplatePath)]
        );
    }
};

const toJsonValue = (value) => {
    if (value === undefined || value === null) return null;
    return JSON.stringify(value);
};

export const updateOfferLetterTemplateModel = async ({
    content_html,
    updated_by
}) => {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");
        await client.query(
            "SELECT pg_advisory_xact_lock(hashtext('offer_letter_format_upload'));"
        );

        const currentResult = await client.query(
            `
            SELECT *
            FROM offer_letter_format
            WHERE id = 1
            FOR UPDATE;
            `
        );
        const current = currentResult.rows[0] || null;

        if (current) {
            const previousContent = typeof current.content_html === "string"
                ? current.content_html
                : current.content_html == null
                    ? null
                    : JSON.stringify(current.content_html);

            await client.query(
                `
                INSERT INTO offer_letter_format_history (
                    old_value,
                    new_value,
                    updated_by,
                    updated_at
                )
                VALUES ($1::jsonb, $2::jsonb, $3, CURRENT_TIMESTAMP);
                `,
                [
                    toJsonValue(previousContent),
                    toJsonValue(content_html),
                    updated_by
                ]
            );
        }

        const result = await client.query(
            `
            INSERT INTO offer_letter_format (
                id,
                content_html,
                updated_by,
                updated_at
            )
            VALUES (1, $1::jsonb, $2, CURRENT_TIMESTAMP)
            ON CONFLICT (id)
            DO UPDATE SET
                content_html = EXCLUDED.content_html,
                updated_by = EXCLUDED.updated_by,
                updated_at = CURRENT_TIMESTAMP
            RETURNING
                id,
                content_html #>> '{}' AS content_html,
                TO_CHAR(updated_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI:SS.MS') AS updated_at,
                updated_by;
            `,
            [toJsonValue(content_html), updated_by]
        );

        await client.query("COMMIT");
        return {
            template: result.rows[0],
            replaced: Boolean(current)
        };
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
};

export const getOfferLetterFormatModel = async () => {
    const result = await pool.query(`
        SELECT
            id,
            content_html #>> '{}' AS content_html,
            TO_CHAR(updated_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI:SS.MS') AS updated_at,
            updated_by
        FROM offer_letter_format
        WHERE id = 1
        LIMIT 1;
    `);

    return result.rows[0] || null;
};

export const getOfferLetterFormatHistoryModel = async ({
    limit = 50,
    offset = 0
} = {}) => {
    const result = await pool.query(
        `
        SELECT
            id,
            CASE
                WHEN old_value IS NULL THEN NULL
                WHEN jsonb_typeof(old_value) = 'string' THEN old_value #>> '{}'
                ELSE old_value::text
            END AS old_value,
            CASE
                WHEN new_value IS NULL THEN NULL
                WHEN jsonb_typeof(new_value) = 'string' THEN new_value #>> '{}'
                ELSE new_value::text
            END AS new_value,
            updated_by,
            TO_CHAR(updated_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI:SS.MS') AS updated_at
        FROM offer_letter_format_history
        ORDER BY updated_at DESC NULLS LAST, id DESC
        LIMIT $1 OFFSET $2;
        `,
        [limit, offset]
    );

    return result.rows;
};

export const getOfferLetterEmployeeModel = async (username) => {
    const { rows } = await pool.query(
        `
        SELECT
            COALESCE(NULLIF(TRIM(ed.username), ''), pd.username) AS username,
            pd.first_name,
            pd.middle_name,
            pd.last_name,
            pd.email_id,
            pd.mobile_number,
            COALESCE(des.name, NULLIF(TRIM(ed.designation::text), '')) AS designation,
            COALESCE(dep.name, NULLIF(TRIM(ed.department::text), '')) AS department,
            TO_CHAR(ed.date_of_joining, 'DD-MM-YYYY') AS date_of_joining,
            wl.location AS work_location,
            ed.reporting_manager,
            ed.notice_period,
            sd.current_salary
        FROM personal_details pd
        INNER JOIN employment_details ed
            ON ed.personal_details_id = pd.id
        LEFT JOIN department_structure des
            ON des.id = ed.designation
        LEFT JOIN department_structure dep
            ON dep.id = ed.department
        LEFT JOIN work_location wl
            ON wl.id = ed.work_location
        LEFT JOIN salary_details sd
            ON sd.personal_details_id = pd.id
        WHERE LOWER(TRIM(COALESCE(ed.username, pd.username))) = LOWER(TRIM($1))
        LIMIT 1;
        `,
        [username]
    );

    const employee = rows[0];
    if (!employee) return null;

    try {
        const salary = decryptPayrollFields(employee, ["current_salary"]);
        employee.current_salary = salary.current_salary;
    } catch {
        employee.current_salary = null;
    }

    return employee;
};

export const getOfferLetterTemplateFileModel = async () => {
    const { rows } = await pool.query(`
        SELECT template_file
        FROM offer_letter_format
        WHERE id = 1
        LIMIT 1;
    `);

    const file = rows[0]?.template_file;
    return file ? Buffer.from(file) : null;
};


/* =========================================================
   EMPLOYEE FILED NAME 
========================================================= */
export const getEmployeeFieldNamesModel = async ({
    search = null
} = {}) => {
    const tables = [
        "personal_details",
        "identification_details",
        "bank_details",
        "educational_qualifications",
        "employment_details",
        "work_experience",
        "salary_details",
        "employee_payroll_config",
        "work_location"
    ];

    const query = `
        SELECT
            table_name,
            column_name,
            ordinal_position
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = ANY($1)
        ORDER BY
            array_position($1, table_name),
            ordinal_position;
    `;

    const { rows } = await pool.query(
        query,
        [tables]
    );

    const requiredFields = {};

    /* =========================================
       CREATE TABLE OBJECTS
    ========================================= */
    for (const table of tables) {
        requiredFields[table] = {
            fields: []
        };
    }

    /* =========================================
       ADD COLUMN NAMES
    ========================================= */
    for (const row of rows) {
        const excludedFields = [
            "id",
            "personal_details_id",
            "candidate_id",
            "employment_id",
            "access",
            "password",
            "created_by",
            "status",
            "created_at",
            "updated_at"
        ];

        if (
            excludedFields.includes(
                row.column_name
            )
        ) {
            continue;
        }

        if (
            row.table_name === "employee_payroll_config" &&
            row.column_name === "shift_id"
        ) {
            requiredFields[row.table_name].fields.push(
                "shift_name",
                "shift_type"
            );
            continue;
        }

        requiredFields[
            row.table_name
        ].fields.push(
            row.column_name
        );
    }

    const searchValue = search == null
        ? ""
        : String(search).trim().toLowerCase();

    if (searchValue) {
        for (const table of tables) {
            requiredFields[table].fields = requiredFields[table].fields
                .filter(field =>
                    field.toLowerCase().includes(searchValue)
                );
        }
    }

    return requiredFields;
};