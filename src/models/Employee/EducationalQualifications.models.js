import { pool } from "../../database.js";

/* ================= CREATE TABLE ================= */
export const initializeEducationalQualificationsTable = async () => {
    const query = `
        CREATE TABLE IF NOT EXISTS educational_qualifications (
            id SERIAL PRIMARY KEY,
            personal_details_id INTEGER NOT NULL,
            education VARCHAR(255),
            university_institution VARCHAR(255),
            branch VARCHAR(255),
            cgpa_percentage NUMERIC(5,2),
            year_of_passing INTEGER,
            marksheet_certificate_upload TEXT,
            created_at TIMESTAMP DEFAULT TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP),
            updated_at TIMESTAMP DEFAULT TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
        )
    `;

    await pool.query(query);

    await pool.query(`
        ALTER TABLE educational_qualifications
        ALTER COLUMN cgpa_percentage
        TYPE NUMERIC(5,2)
        USING cgpa_percentage::NUMERIC(5,2)
    `).catch(() => { });

    await pool.query(`
        UPDATE educational_qualifications AS eq
        SET education = ed.id
        FROM employment_details AS emp
        INNER JOIN education AS ed
            ON ed.work_location = emp.work_location
        WHERE
            eq.personal_details_id = emp.personal_details_id
            AND eq.education IS NOT NULL
            AND TRIM(eq.education::TEXT) <> ''
            AND emp.work_location IS NOT NULL
            AND LOWER(TRIM(ed.education_name))
                = LOWER(TRIM(eq.education::TEXT));
    `);

    await pool.query(`
        DO $$
        BEGIN

            IF EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'educational_qualifications'
                  AND column_name = 'education'
                  AND data_type = 'character varying'
            ) THEN

                ALTER TABLE educational_qualifications
                ALTER COLUMN education TYPE INTEGER
                USING (
                    CASE
                        WHEN TRIM(education) ~ '^[0-9]+$'
                        THEN TRIM(education)::INTEGER
                        ELSE NULL
                    END
                );

            END IF;

        END
        $$;
    `);

    await pool.query(`
        SELECT setval(
            pg_get_serial_sequence('educational_qualifications', 'id'),
            COALESCE((SELECT MAX(id) FROM educational_qualifications), 1),
            true
        );
    `);

    console.log("✅ educational_qualifications table ready");
};

/* ================= ADD ================= */

export const addEducationalQualificationsModel = async (data) => {

    const query = `
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
    `;

    const values = [
        data.personal_details_id,
        data.education,
        data.university_institution,
        data.branch,
        data.cgpa_percentage,
        data.year_of_passing,
        data.marksheet_certificate_upload
    ];

    const { rows } = await pool.query(query, values);

    return rows[0];
};


/* ================= GET ALL ================= */

export const getAllEducationalQualificationsModel = async () => {

    const { rows } = await pool.query(`
        SELECT
            eq.*,
            ed.education_name,
            ed.work_location AS education_work_location,
            wl.location AS work_location_name
        FROM educational_qualifications eq

        LEFT JOIN education ed
            ON ed.id = eq.education

        LEFT JOIN work_location wl
            ON wl.id = ed.work_location

        ORDER BY eq.id DESC;
    `);

    return rows;
};


/* ================= GET BY ID ================= */
export const getEducationalQualificationsByIdModel = async (id) => {

    const { rows } = await pool.query(
        `
        SELECT
            eq.*,
            ed.education_name,
            ed.work_location AS education_work_location,
            wl.location AS work_location_name
        FROM educational_qualifications eq

        LEFT JOIN education ed
            ON ed.id = eq.education

        LEFT JOIN work_location wl
            ON wl.id = ed.work_location

        WHERE eq.id = $1
        `,
        [id]
    );

    return rows[0];
};

/* =====================================================
   GET EDUCATION ID BY WORK LOCATION + EDUCATION NAME
===================================================== */
export const getEducationIdForEmployeeModel = async (
    work_location,
    education
) => {

    if (
        work_location === null ||
        work_location === undefined ||
        String(work_location).trim() === "" ||
        education === null ||
        education === undefined ||
        String(education).trim() === ""
    ) {
        return null;
    }

    const workLocationValue = String(work_location)
        .trim()
        .replace(/^["']+|["']+$/g, "")
        .trim();

    const educationValue = String(education)
        .trim()
        .replace(/^["']+|["']+$/g, "")
        .trim();

    const { rows } = await pool.query(
        `
        SELECT
            edu.id,
            edu.education_name,
            edu.work_location,
            wl.location AS work_location_name
        FROM education edu
        INNER JOIN work_location wl
            ON wl.id = edu.work_location
        WHERE
            (
                wl.id::TEXT = $1
                OR LOWER(TRIM(wl.location))
                    = LOWER(TRIM($1))
            )
            AND LOWER(TRIM(edu.education_name))
                = LOWER(TRIM($2))
        LIMIT 1
        `,
        [
            workLocationValue,
            educationValue
        ]
    );

    return rows[0]?.id || null;
};


/* ================= UPDATE ================= */

export const updateEducationalQualificationsModel = async (id, data) => {

    const query = `
        UPDATE educational_qualifications
        SET
            education = COALESCE($1, education),
            university_institution = COALESCE($2, university_institution),
            branch = COALESCE($3, branch),
            cgpa_percentage = COALESCE($4, cgpa_percentage),
            year_of_passing = COALESCE($5, year_of_passing),
            marksheet_certificate_upload =
                COALESCE($6, marksheet_certificate_upload),
            updated_at = TIMEZONE(
                'Asia/Kolkata',
                CURRENT_TIMESTAMP
            )
        WHERE id = $7
        RETURNING *;
    `;

    const values = [
        data.education,
        data.university_institution,
        data.branch,
        data.cgpa_percentage,
        data.year_of_passing,
        data.marksheet_certificate_upload,
        id
    ];

    const { rows } = await pool.query(query, values);

    return rows[0];
};


/* ================= DELETE ================= */

export const deleteEducationalQualificationsModel = async (id) => {

    const { rows } = await pool.query(
        `
        DELETE FROM educational_qualifications
        WHERE id = $1
        RETURNING *;
        `,
        [id]
    );

    return rows[0];
};
