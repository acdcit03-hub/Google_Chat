import { pool } from "../../database.js";

/* =========================================================
   CREATE CANDIDATE TABLE
========================================================= */
export const initializeCandidateTable = async () => {
    const query = `
        CREATE TABLE IF NOT EXISTS candidate (
            id SERIAL PRIMARY KEY,

            /* ================= PERSONAL DETAILS ================= */
            first_name VARCHAR(255),
            middle_name VARCHAR(255),
            last_name VARCHAR(255),
            username VARCHAR(255),
            date_of_birth DATE,
            gender VARCHAR(100),
            blood_group VARCHAR(100),
            family_members_count INTEGER,
            marital_status VARCHAR(100),
            anniversary_date DATE,
            dependent_children INTEGER,
            email_id VARCHAR(255),
            current_address TEXT,
            permanent_address TEXT,
            image TEXT,
            mobile_number VARCHAR(50),
            alternate_contact_number VARCHAR(50),
            emergency_contact_name VARCHAR(255),
            emergency_contact_number VARCHAR(50),
            emergency_relationship VARCHAR(255),
            job_posting VARCHAR(255),
            job_position_id INTEGER,
            source VARCHAR(255),
            past_salary NUMERIC,
            expected_salary NUMERIC,
            linkedin_profile_link TEXT,
            resume TEXT,

            /* ================= IDENTIFICATION DETAILS ================= */
            pan_card_number VARCHAR(100),
            pan_card_upload TEXT,
            aadhaar_number VARCHAR(100),
            aadhaar_upload TEXT,
            other_document_upload TEXT,

            /* ================= BANK DETAILS ================= */
            bank_name VARCHAR(255),
            account_holder_name VARCHAR(255),
            account_number VARCHAR(255),
            ifsc_code VARCHAR(100),
            branch_name VARCHAR(255),
            bank_proof TEXT,

            /* ================= EDUCATIONAL QUALIFICATIONS ================= */
            education JSONB DEFAULT '[]'::jsonb,

            /* ================= EMPLOYMENT DETAILS ================= */
            employment_id VARCHAR(255),
            rfid VARCHAR(255),
            designation INTEGER,
            department INTEGER,
            sub_department INTEGER,
            category INTEGER,
            date_of_joining DATE,
            work_email VARCHAR(255),
            employment_type VARCHAR(100),
            shift_name INTEGER,
            shift_type INTEGER,
            work_location INTEGER,
            reporting_manager VARCHAR(255),
            probation_period VARCHAR(100),
            notice_period VARCHAR(100),
            bond INTEGER,
            has_experience BOOLEAN,
            internship_start_date DATE,
            internship_end_date DATE,
            internship_duration VARCHAR(100),
            noc_letter TEXT,
            offer_letter TEXT,

            /* ================= WORK EXPERIENCE ================= */
            work_experience JSONB DEFAULT '[]'::jsonb,

            /* ================= SALARY DETAILS ================= */
            current_salary NUMERIC,
            effective_date DATE,
            next_increment_date DATE,

            /* ================= MASTER EMPLOYEE ================= */
            candidate_status VARCHAR(100),
            note TEXT,

            /* ================= AUDIT ================= */
            created_by VARCHAR(255),

            created_at TIMESTAMP DEFAULT TIMEZONE(
                'Asia/Kolkata',
                CURRENT_TIMESTAMP
            ),

            updated_at TIMESTAMP DEFAULT TIMEZONE(
                'Asia/Kolkata',
                CURRENT_TIMESTAMP
            )
        );
    `;

    await pool.query(query);

    await pool.query(`
        ALTER TABLE candidate
        ADD COLUMN IF NOT EXISTS note TEXT,
        DROP COLUMN IF EXISTS expected_increment;
    `);

    await pool.query(`
        ALTER TABLE candidate
        ADD COLUMN IF NOT EXISTS work_experience JSONB
        DEFAULT '[]'::jsonb;
    `);

    await pool.query(`
        ALTER TABLE candidate
        ADD COLUMN IF NOT EXISTS internship_duration VARCHAR(100),
        ADD COLUMN IF NOT EXISTS noc_letter TEXT,
        ADD COLUMN IF NOT EXISTS offer_letter TEXT;
    `);

    /* =====================================================
       INTERNSHIP DATE MIGRATION
    ===================================================== */
    await pool.query(`
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = current_schema()
                  AND table_name = 'candidate'
                  AND column_name = 'internship_start_time'
            ) AND NOT EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = current_schema()
                  AND table_name = 'candidate'
                  AND column_name = 'internship_start_date'
            ) THEN
                ALTER TABLE candidate
                RENAME COLUMN internship_start_time
                TO internship_start_date;
            END IF;

            IF EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = current_schema()
                  AND table_name = 'candidate'
                  AND column_name = 'internship_end_time'
            ) AND NOT EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = current_schema()
                  AND table_name = 'candidate'
                  AND column_name = 'internship_end_date'
            ) THEN
                ALTER TABLE candidate
                RENAME COLUMN internship_end_time
                TO internship_end_date;
            END IF;
        END $$;
    `);

    // Ensure both columns exist.
    await pool.query(`
        ALTER TABLE candidate
        ADD COLUMN IF NOT EXISTS internship_start_date DATE,
        ADD COLUMN IF NOT EXISTS internship_end_date DATE;
    `);

    await pool.query(`
        DO $$
        DECLARE
            start_type TEXT;
            end_type TEXT;
        BEGIN
            SELECT data_type INTO start_type
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'candidate'
              AND column_name = 'internship_start_date';

            SELECT data_type INTO end_type
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'candidate'
              AND column_name = 'internship_end_date';

            IF start_type IS DISTINCT FROM 'date' THEN
                IF start_type = 'time without time zone'
                   OR start_type = 'time with time zone' THEN
                    ALTER TABLE candidate
                    ALTER COLUMN internship_start_date
                    TYPE DATE USING NULL::DATE;
                ELSE
                    ALTER TABLE candidate
                    ALTER COLUMN internship_start_date
                    TYPE DATE USING internship_start_date::DATE;
                END IF;
            END IF;

            IF end_type IS DISTINCT FROM 'date' THEN
                IF end_type = 'time without time zone'
                   OR end_type = 'time with time zone' THEN
                    ALTER TABLE candidate
                    ALTER COLUMN internship_end_date
                    TYPE DATE USING NULL::DATE;
                ELSE
                    ALTER TABLE candidate
                    ALTER COLUMN internship_end_date
                    TYPE DATE USING internship_end_date::DATE;
                END IF;
            END IF;
        END $$;
    `);

    await pool.query(`
        UPDATE candidate
        SET work_experience = jsonb_build_array(
            jsonb_build_object(
                'company_name', company_name,
                'job_title', job_title,
                'duration_from', duration_from,
                'duration_to', duration_to,
                'salary', salary,
                'reason_for_leaving', reason_for_leaving,
                'responsibilities', responsibilities,
                'experience_letter', experience_letter
            )
        )
        WHERE COALESCE(work_experience, '[]'::jsonb) = '[]'::jsonb
          AND (
              company_name IS NOT NULL OR
              job_title IS NOT NULL OR
              duration_from IS NOT NULL OR
              duration_to IS NOT NULL OR
              salary IS NOT NULL OR
              reason_for_leaving IS NOT NULL OR
              responsibilities IS NOT NULL OR
              experience_letter IS NOT NULL
          );
    `).catch(() => { });

    await pool.query(`
        ALTER TABLE candidate
        DROP COLUMN IF EXISTS company_name,
        DROP COLUMN IF EXISTS job_title,
        DROP COLUMN IF EXISTS duration_from,
        DROP COLUMN IF EXISTS duration_to,
        DROP COLUMN IF EXISTS salary,
        DROP COLUMN IF EXISTS reason_for_leaving,
        DROP COLUMN IF EXISTS responsibilities,
        DROP COLUMN IF EXISTS experience_letter;
    `);

    console.log("✅ candidate table ready");
};

/* =========================================================
   NORMALIZE CANDIDATE DATE VALUE
========================================================= */
const normalizeCandidateDateValue = (value) => {
    if (
        value === null ||
        value === undefined ||
        String(value).trim() === ""
    ) {
        return null;
    }

    const dateValue = String(value).trim();

    // Accept YYYY-MM-DD
    const match = dateValue.match(
        /^(\d{4})-(\d{2})-(\d{2})$/
    );

    if (!match) {
        throw new Error(
            "Invalid date format. Please use YYYY-MM-DD."
        );
    }

    const [, year, month, day] = match;

    const date = new Date(
        Date.UTC(
            Number(year),
            Number(month) - 1,
            Number(day)
        )
    );

    if (
        date.getUTCFullYear() !== Number(year) ||
        date.getUTCMonth() !== Number(month) - 1 ||
        date.getUTCDate() !== Number(day)
    ) {
        throw new Error("Invalid calendar date.");
    }

    return dateValue;
};

/* =========================================================
   CREATE CANDIDATE
========================================================= */
export const createCandidateModel = async ({
    first_name,
    middle_name = null,
    last_name,
    username = null,
    date_of_birth = null,
    gender = null,
    blood_group = null,
    family_members_count = null,
    marital_status = null,
    anniversary_date = null,
    dependent_children = null,
    email_id = null,
    current_address = null,
    permanent_address = null,
    image = null,
    mobile_number = null,
    alternate_contact_number = null,
    emergency_contact_name = null,
    emergency_contact_number = null,
    emergency_relationship = null,
    job_posting = null,
    job_position_id = null,
    source = null,
    past_salary = null,
    expected_salary = null,
    linkedin_profile_link = null,
    resume = null,
    pan_card_number = null,
    pan_card_upload = null,
    aadhaar_number = null,
    aadhaar_upload = null,
    other_document_upload = null,
    bank_name = null,
    account_holder_name = null,
    account_number = null,
    ifsc_code = null,
    branch_name = null,
    bank_proof = null,
    education = [],
    work_experience = [],
    employment_id = null,
    rfid = null,
    designation = null,
    department = null,
    sub_department = null,
    category = null,
    date_of_joining = null,
    work_email = null,
    employment_type = null,
    shift_name = null,
    shift_type = null,
    work_location = null,
    reporting_manager = null,
    probation_period = null,
    notice_period = null,
    bond = null,
    internship_start_date = null,
    internship_end_date = null,
    internship_duration = null,
    noc_letter = null,
    offer_letter = null,
    has_experience = null,
    current_salary = null,
    effective_date = null,
    next_increment_date = null,
    candidate_status = null,
    created_by = null,
    note = null
}) => {
    const query = `
        INSERT INTO candidate (
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
            resume,
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
            work_experience,
            current_salary,
            effective_date,
            next_increment_date,
            candidate_status,
            created_by,
            note
        )

        VALUES (
            $1,  $2,  $3,  $4,  $5,
            $6,  $7,  $8,  $9,  $10,
            $11, $12, $13, $14, $15,
            $16, $17, $18, $19, $20,
            $21, $22, $23, $24, $25,
            $26, $27, $28, $29, $30,
            $31, $32, $33, $34, $35,
            $36, $37, $38, $39, $40,
            $41, $42, $43, $44, $45,
            $46, $47, $48, $49, $50,
            $51, $52, $53, $54, $55,
            $56, $57, $58, $59, $60,
            $61, $62, $63, $64, $65,
            $66, $67, $68
        )

        RETURNING *;
    `;

    /* =====================================================
       EDUCATION JSON
    ===================================================== */
    const educationJson =
        Array.isArray(education)
            ? JSON.stringify(education)
            : "[]";

    const workExperienceJson =
        Array.isArray(work_experience)
            ? JSON.stringify(work_experience)
            : "[]";

    const values = [
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
        resume,
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
        educationJson,
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
        normalizeCandidateDateValue(internship_start_date),
        normalizeCandidateDateValue(internship_end_date),
        internship_duration,
        noc_letter,
        offer_letter,
        has_experience,
        workExperienceJson,
        current_salary,
        effective_date,
        next_increment_date,
        candidate_status,
        created_by,
        note
    ];

    const result = await pool.query(
        query,
        values
    );

    return result.rows[0];
};

/* =========================================================
   GET ALL CANDIDATES
========================================================= */
export const getCandidateModel = async ({
    name = null,
    first_name = null,
    middle_name = null,
    last_name = null,
    email_id = null,
    mobile_number = null,
    job_posting = null,
    job_position_id = null,
    source = null,
    candidate_status = null,
    created_by = null,
    department = null,
    sub_department = null,
    designation = null,
    paginationEnabled = false,
    page = 1,
    limit = 20

} = {}) => {
    /* =====================================================
       BASE QUERY
    ===================================================== */
    let query = `
        SELECT
            c.*,

            /* ================= IMAGE ================= */
            COALESCE(
                NULLIF(TRIM(c.image), ''),
            
                NULLIF(
                    (
                        SELECT TRIM(category_image)
                        FROM category
                        WHERE id = c.category
                        LIMIT 1
                    ),
                    ''
                ),
            
                'https://img.magnific.com/premium-vector/employee-icon_1134231-3528.jpg'
            ) AS image,

            /* ================= STATUS ================= */
            status_master.id
                AS status_id,

            status_master.status_name
                AS status_name,

            /* ================= SHIFT ================= */
            shift_name_master.shift_name
                AS shift_name_text,

            shift_type_master.shift_type
                AS shift_type_text,

            /* ================= EDUCATION ================= */
            COALESCE(
                (
                    SELECT jsonb_agg(
                        jsonb_build_object(
                            'education_id',
                            e.id,

                            'education',
                            e.education_name,

                            'university_institution',
                            item->>'university_institution',

                            'branch',
                            item->>'branch',

                            'cgpa_percentage',
                            CASE
                                WHEN
                                    item->>'cgpa_percentage' IS NULL
                                    OR
                                    item->>'cgpa_percentage' = ''
                                THEN NULL
                                ELSE
                                    (item->>'cgpa_percentage')::numeric
                            END,

                            'year_of_passing',
                            CASE
                                WHEN
                                    item->>'year_of_passing' IS NULL
                                    OR
                                    item->>'year_of_passing' = ''
                                THEN NULL
                                ELSE
                                    (item->>'year_of_passing')::integer
                            END,

                            'marksheet_certificate_upload',
                            item->>'marksheet_certificate_upload'
                        )
                    )

                    FROM jsonb_array_elements(
                        COALESCE(
                            c.education,
                            '[]'::jsonb
                        )
                    ) AS item

                    LEFT JOIN education e
                        ON e.id =
                            CASE
                                WHEN
                                    item->>'education'
                                    ~ '^[0-9]+$'
                                THEN
                                    (item->>'education')::integer
                                ELSE NULL
                            END
                ),
                '[]'::jsonb
            ) AS education,

            /* ================= DESIGNATION ================= */
            designation_master.name
                AS designation_text,

            /* ================= DEPARTMENT ================= */
            department_master.name
                AS department,

            /* ================= SUB DEPARTMENT ================= */
            sub_department_master.name
                AS sub_department,

            /* ================= WORK LOCATION ================= */
            wl.location
                AS work_location_text,

            /* ================= CATEGORY ================= */
            category_master.category_name
                AS category_text,

            /* ================= BOND ================= */
            bond_master.bond_duration
                AS bond_text

        FROM candidate c

        /* ================= STATUS ================= */
        LEFT JOIN status status_master
            ON LOWER(TRIM(status_master.status_name))
             = LOWER(TRIM(c.candidate_status))

        /* ================= SHIFT NAME ================= */
        LEFT JOIN shift_configurations shift_name_master
            ON shift_name_master.id = c.shift_name

        /* ================= SHIFT TYPE ================= */
        LEFT JOIN shift_configurations shift_type_master
            ON shift_type_master.id = c.shift_type

        /* ================= DESIGNATION ================= */
        LEFT JOIN department_structure designation_master
            ON designation_master.id = c.designation

        /* ================= DEPARTMENT ================= */
        LEFT JOIN department_structure department_master
            ON department_master.id = c.department

        /* ================= SUB DEPARTMENT ================= */
        LEFT JOIN department_structure sub_department_master
            ON sub_department_master.id = c.sub_department

        /* ================= WORK LOCATION ================= */
        LEFT JOIN work_location wl
            ON wl.id = c.work_location

        /* ================= BOND ================= */
        LEFT JOIN bond_options bond_master
            ON bond_master.id = c.bond

        /* ================= CATEGORY ================= */
        LEFT JOIN category category_master
            ON category_master.id = c.category

        WHERE 1 = 1
    `;

    const values = [];
    let index = 1;

    if (name) {
        query += `
            AND (
                LOWER(TRIM(c.first_name))
                    LIKE LOWER(TRIM($${index}))
        
                OR
        
                LOWER(TRIM(c.middle_name))
                    LIKE LOWER(TRIM($${index}))
        
                OR
        
                LOWER(TRIM(c.last_name))
                    LIKE LOWER(TRIM($${index}))
        
                OR
        
                LOWER(TRIM(c.username))
                    LIKE LOWER(TRIM($${index}))
            )
        `;

        values.push(`%${name}%`);
        index++;
    }

    /* =====================================================
       FIRST NAME
    ===================================================== */
    if (first_name) {
        query += `
            AND LOWER(TRIM(c.first_name))
                LIKE LOWER(TRIM($${index}))
        `;

        values.push(`%${first_name}%`);
        index++;
    }

    /* =====================================================
       MIDDLE NAME
    ===================================================== */
    if (middle_name) {
        query += `
            AND LOWER(TRIM(c.middle_name))
                LIKE LOWER(TRIM($${index}))
        `;

        values.push(`%${middle_name}%`);
        index++;
    }

    /* =====================================================
       LAST NAME
    ===================================================== */
    if (last_name) {
        query += `
            AND LOWER(TRIM(c.last_name))
                LIKE LOWER(TRIM($${index}))
        `;

        values.push(`%${last_name}%`);
        index++;
    }

    /* =====================================================
       EMAIL
    ===================================================== */
    if (email_id) {
        query += `
            AND LOWER(TRIM(c.email_id))
                LIKE LOWER(TRIM($${index}))
        `;

        values.push(`%${email_id}%`);
        index++;
    }

    /* =====================================================
       MOBILE NUMBER
    ===================================================== */
    if (mobile_number) {
        query += `
            AND TRIM(c.mobile_number)
                LIKE TRIM($${index})
        `;

        values.push(`%${mobile_number}%`);
        index++;
    }

    /* =====================================================
       JOB POSTING
    ===================================================== */
    if (job_posting) {
        const jobTitles = (
            Array.isArray(job_posting)
                ? job_posting
                : String(job_posting).split(",")
        )
            .map(title => String(title).trim().toLowerCase())
            .filter(Boolean);

        if (jobTitles.length > 0) {
            query += `
                AND EXISTS (
                    SELECT 1
                    FROM job_position jp
                    WHERE jp.id = c.job_position_id
                      AND LOWER(TRIM(jp.job_title))
                          LIKE ANY($${index}::TEXT[])
                )
            `;

            values.push(
                jobTitles.map(title => `%${title}%`)
            );
            index++;
        }
    }

    /* =====================================================
       JOB POSITION ID
    ===================================================== */
    if (
        job_position_id !== null &&
        job_position_id !== undefined &&
        String(job_position_id).trim() !== ""
    ) {
        const positionId = Number(job_position_id);
        if (Number.isNaN(positionId)) {
            throw new Error(
                "job_position_id must be a valid number"
            );
        }

        query += `
            AND c.job_position_id = $${index}
        `;

        values.push(positionId);
        index++;
    }

    /* =====================================================
       SOURCE
    ===================================================== */
    if (source) {
        query += `
            AND LOWER(TRIM(c.source))
                LIKE LOWER(TRIM($${index}))
        `;

        values.push(`%${source}%`);
        index++;
    }

    /* =====================================================
       CANDIDATE STATUS
    ===================================================== */
    if (candidate_status) {
        query += `
            AND LOWER(TRIM(status_master.status_name))
                = LOWER(TRIM($${index}))
        `;

        values.push(candidate_status);
        index++;
    }

    /* =====================================================
       CREATED BY
    ===================================================== */
    if (created_by) {
        query += `
            AND LOWER(TRIM(c.created_by))
                LIKE LOWER(TRIM($${index}))
        `;

        values.push(`%${created_by}%`);
        index++;
    }

    /* =====================================================
       DEPARTMENT
    ===================================================== */
    if (department) {
        query += `
            AND LOWER(TRIM(department_master.name))
                LIKE LOWER(TRIM($${index}))
        `;

        values.push(`%${department}%`);
        index++;
    }

    /* =====================================================
       SUB DEPARTMENT
    ===================================================== */
    if (sub_department) {
        query += `
            AND LOWER(TRIM(sub_department_master.name))
                LIKE LOWER(TRIM($${index}))
        `;

        values.push(`%${sub_department}%`);
        index++;
    }

    /* =====================================================
       DESIGNATION
    ===================================================== */
    if (designation) {
        query += `
            AND LOWER(TRIM(designation_master.name))
                LIKE LOWER(TRIM($${index}))
        `;

        values.push(`%${designation}%`);
        index++;
    }

    /* =====================================================
       GET TOTAL COUNT
    ===================================================== */
    const countQuery = `
        SELECT COUNT(*)::INTEGER AS total
        FROM (
            ${query}
        ) AS filtered_candidates
    `;

    const countResult = await pool.query(
        countQuery,
        values
    );

    const total =
        Number(
            countResult.rows[0]?.total || 0
        );

    /* =====================================================
       ORDER
    ===================================================== */
    query += `
        ORDER BY c.id DESC
    `;

    /* =====================================================
       PAGINATION
    ===================================================== */
    let finalValues = [...values];

    if (paginationEnabled) {
        const offset = (page - 1) * limit;

        query += `
            LIMIT $${index}
            OFFSET $${index + 1}
        `;

        finalValues.push(
            limit,
            offset
        );
    }

    /* =====================================================
       GET DATA
    ===================================================== */
    const result = await pool.query(
        query,
        finalValues
    );

    /* =====================================================
       PAGINATION RESPONSE
    ===================================================== */
    if (paginationEnabled) {
        const totalPages = Math.ceil(total / limit);
        return {
            data: result.rows,
            pagination: {
                enabled: true,
                total,
                page,
                limit,
                totalPages
            }
        };
    }

    /* =====================================================
       PAGINATION DISABLED
    ===================================================== */
    return {
        data: result.rows,
        pagination: {
            enabled: false
        }
    };
};

/* =========================================================
   GET CANDIDATE STATUS STATS
========================================================= */
export const getCandidateStatusStatsModel = async ({
    job_position_id = null,
    job_posting = null
} = {}) => {
    let query = `
        SELECT
            s.id AS status_id,
            s.status_name,
            COUNT(c.id)::INTEGER AS count

        FROM status s

        LEFT JOIN candidate c
            ON LOWER(TRIM(c.candidate_status))
             = LOWER(TRIM(s.status_name))
    `;

    const values = [];
    let index = 1;

    /* =====================================================
       JOB POSTING FILTER (same as all-candidate)
       ?job_posting=Full+Stack / Backend
    ===================================================== */
    if (job_posting) {
        const jobTitles = (
            Array.isArray(job_posting)
                ? job_posting
                : String(job_posting).split(",")
        )
            .map(title => String(title).trim().toLowerCase())
            .filter(Boolean);

        if (jobTitles.length > 0) {
            query += `
                AND EXISTS (
                    SELECT 1
                    FROM job_position jp
                    WHERE jp.id = c.job_position_id
                      AND LOWER(TRIM(jp.job_title))
                          LIKE ANY($${index}::TEXT[])
                )
            `;

            values.push(
                jobTitles.map(title => `%${title}%`)
            );
            index++;
        }
    }

    /* =====================================================
       JOB POSITION FILTER
       candidate.job_position_id = job_position_id
    ===================================================== */
    if (
        job_position_id !== null &&
        job_position_id !== undefined &&
        String(job_position_id).trim() !== ""
    ) {
        const positionId = Number(job_position_id);
        if (Number.isNaN(positionId)) {
            throw new Error(
                "job_position_id must be a valid number"
            );
        }

        query += `
            AND c.job_position_id = $${index}
        `;

        values.push(positionId);
        index++;
    }

    query += `
        GROUP BY
            s.id,
            s.status_name

        ORDER BY
            s.id ASC;
    `;

    const { rows } = await pool.query(
        query,
        values
    );

    /* =====================================================
       CREATE STATS OBJECT
    ===================================================== */
    const stats = {
        total: 0
    };

    for (const row of rows) {
        const statusName =
            String(
                row.status_name || ""
            ).trim();

        const count =
            Number(
                row.count || 0
            );

        stats[statusName] = count;
        stats.total += count;
    }

    return stats;
};

/* =========================================================
   GET CANDIDATE BY ID
========================================================= */
export const getCandidateByIdModel = async (id) => {
    const result = await pool.query(
        `
        SELECT
            c.*,

            /* ================= SHIFT ================= */
            shift_name_master.shift_name
                AS shift_name_text,

            shift_type_master.shift_type
                AS shift_type_text,

            /* ================= EDUCATION ================= */
            COALESCE(
                (
                    SELECT jsonb_agg(
                        jsonb_build_object(
                            'education',
                            e.id,

                            'education',
                            e.education_name,

                            'university_institution',
                            item->>'university_institution',

                            'branch',
                            item->>'branch',

                            'cgpa_percentage',
                            CASE
                                WHEN
                                    item->>'cgpa_percentage' IS NULL
                                    OR
                                    item->>'cgpa_percentage' = ''
                                THEN NULL
                                ELSE
                                    (item->>'cgpa_percentage')::numeric
                            END,

                            'year_of_passing',
                            CASE
                                WHEN
                                    item->>'year_of_passing' IS NULL
                                    OR
                                    item->>'year_of_passing' = ''
                                THEN NULL
                                ELSE
                                    (item->>'year_of_passing')::integer
                            END,

                            'marksheet_certificate_upload',
                            item->>'marksheet_certificate_upload'
                        )
                    )

                    FROM jsonb_array_elements(
                        COALESCE(
                            c.education,
                            '[]'::jsonb
                        )
                    ) AS item

                    LEFT JOIN education e
                        ON e.id =
                           CASE
                               WHEN
                                   item->>'education'
                                   ~ '^[0-9]+$'
                               THEN
                                   (item->>'education')::integer
                               ELSE NULL
                           END
                ),
                '[]'::jsonb
            ) AS education,

            /* ================= MEETING SCHEDULE ================= */
            COALESCE(
                (
                    SELECT jsonb_agg(
                        jsonb_build_object(
                            'id',
                            ms.id,
                
                            'candidate_id',
                            ms.candidate_id,
                
                            'schedule_date',
                            ms.schedule_date,
                
                            'start_time',
                            ms.start_time,
                
                            'end_time',
                            ms.end_time,
                
                            'scheduled_person_name',
                            ms.scheduled_person_name,
                
                            'conduct_person_name',
                            ms.conduct_person_name,
                
                            'meeting_status',
                            ms.meeting_status,

                            'meeting_mode',
                            ms.meeting_mode,

                            'cancelled_meeting_id',
                            ms.cancelled_meeting_id,
                
                            'meeting_cancelled_reason',
                            COALESCE(
                                NULLIF(
                                    BTRIM(ms.meeting_cancelled_reason),
                                    ''
                                ),
                                NULLIF(
                                    BTRIM(
                                        ms_prev.meeting_cancelled_reason
                                    ),
                                    ''
                                ),
                                NULLIF(BTRIM(ms_prev.note), '')
                            ),
                
                            'note',
                            ms.note,
                
                            'resume',
                            ms.resume,
                
                            'work_location_id',
                            ms.work_location,
                
                            'work_location',
                            wl_meeting.location,
                
                            'created_by',
                            ms.created_by,
                
                            'created_at',
                            ms.created_at,
                
                            'updated_at',
                            ms.updated_at,

                            'is_pending',
                            (
                                /* Only past: Schedule/empty → true,
                                   status updated → false. Future → false. */
                                (
                                    CURRENT_TIMESTAMP
                                    AT TIME ZONE 'Asia/Kolkata'
                                ) >= (ms.schedule_date + ms.end_time)
                                AND (
                                    ms.meeting_status IS NULL
                                    OR BTRIM(ms.meeting_status) = ''
                                    OR LOWER(BTRIM(ms.meeting_status))
                                        IN ('schedule', 'scheduled')
                                )
                            )
                        )
                        ORDER BY
                            ms.schedule_date DESC,
                            ms.start_time DESC,
                            ms.id DESC
                    )
                
                    FROM meeting_schedule ms
                
                    LEFT JOIN work_location wl_meeting
                        ON wl_meeting.id = ms.work_location

                    /* Reschedule meeting par purani cancelled
                       meeting nu reason lavo */
                    LEFT JOIN meeting_schedule ms_prev
                        ON ms_prev.id = ms.cancelled_meeting_id
                
                    WHERE ms.candidate_id = c.id
                      /* Reschedule thi cancel thai meeting
                         (cancelled_meeting_id) list ma nathi */
                      AND NOT EXISTS (
                          SELECT 1
                          FROM meeting_schedule ms_next
                          WHERE ms_next.cancelled_meeting_id = ms.id
                      )
                ),
                '[]'::jsonb
            ) AS meeting_schedule,

            /* ================= DESIGNATION ================= */
            designation_master.name
                AS designation_text,

            /* ================= DEPARTMENT ================= */
            department_master.name
                AS department,

            /* ================= SUB DEPARTMENT ================= */
            sub_department_master.name
                AS sub_department,

            /* ================= WORK LOCATION ================= */
            wl.location
                AS work_location_text,

            /* ================= CATEGORY ================= */
            category_master.category_name
                AS category_text,

            /* ================= BOND ================= */
            bond_master.bond_duration
                AS bond_text

        FROM candidate c

        /* ================= SHIFT NAME ================= */
        LEFT JOIN shift_configurations shift_name_master
            ON shift_name_master.id = c.shift_name

        /* ================= SHIFT TYPE ================= */
        LEFT JOIN shift_configurations shift_type_master
            ON shift_type_master.id = c.shift_type

        /* ================= DESIGNATION ================= */
        LEFT JOIN department_structure designation_master
            ON designation_master.id = c.designation

        /* ================= DEPARTMENT ================= */
        LEFT JOIN department_structure department_master
            ON department_master.id = c.department

        /* ================= SUB DEPARTMENT ================= */
        LEFT JOIN department_structure sub_department_master
            ON sub_department_master.id = c.sub_department

        /* ================= WORK LOCATION ================= */
        LEFT JOIN work_location wl
            ON wl.id = c.work_location

        /* ================= BOND ================= */
        LEFT JOIN bond_options bond_master
            ON bond_master.id = c.bond

        /* ================= CATEGORY ================= */
        LEFT JOIN category category_master
            ON category_master.id = c.category

        WHERE c.id = $1
        `,
        [id]
    );

    return result.rows[0] || null;
};

/* =========================================================
   UPDATE CANDIDATE
========================================================= */
export const updateCandidateModel = async (
    id,
    data
) => {
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
        "job_posting",
        "job_position_id",
        "source",
        "past_salary",
        "expected_salary",
        "linkedin_profile_link",
        "resume",
        "pan_card_number",
        "pan_card_upload",
        "aadhaar_number",
        "aadhaar_upload",
        "other_document_upload",
        "bank_name",
        "account_holder_name",
        "account_number",
        "ifsc_code",
        "branch_name",
        "bank_proof",
        "education",
        "work_experience",
        "employment_id",
        "rfid",
        "designation",
        "department",
        "sub_department",
        "category",
        "date_of_joining",
        "work_email",
        "employment_type",
        "shift_name",
        "shift_type",
        "work_location",
        "reporting_manager",
        "probation_period",
        "notice_period",
        "bond",
        "internship_start_date",
        "internship_end_date",
        "internship_duration",
        "noc_letter",
        "offer_letter",
        "has_experience",
        "current_salary",
        "effective_date",
        "next_increment_date",
        "candidate_status",
        "note"
    ];

    const setParts = [];
    const values = [];

    let index = 1;

    for (const field of fields) {
        if (
            Object.prototype.hasOwnProperty.call(
                data,
                field
            )
        ) {
            setParts.push(
                `${field} = $${index}`
            );

            /* =============================================
               JSONB FIELD
            ============================================= */
            if (
                field === "education" ||
                field === "work_experience"
            ) {
                const educationValue =
                    Array.isArray(
                        data[field]
                    )
                        ? JSON.stringify(
                            data[field]
                        )
                        : (
                            data[field] === null
                                ? JSON.stringify([])
                                : data[field]
                        );

                values.push(
                    educationValue
                );

            } else if (
                field === "internship_start_date" ||
                field === "internship_end_date"
            ) {
                values.push(
                    normalizeCandidateDateValue(
                        data[field]
                    )
                );

            } else {
                values.push(
                    data[field]
                );
            }

            index++;
        }
    }

    /* =====================================================
       NOTHING TO UPDATE
    ===================================================== */
    if (setParts.length === 0) {
        return null;
    }

    /* =====================================================
       UPDATED AT
    ===================================================== */
    setParts.push(`
         updated_at = TIMEZONE(
             'Asia/Kolkata',
             CURRENT_TIMESTAMP
         )
     `);

    /* =====================================================
       ID
    ===================================================== */
    values.push(id);

    const query = `
        UPDATE candidate
        SET
            ${setParts.join(",\n")}
        WHERE id = $${index}
        RETURNING *;
    `;

    const result =
        await pool.query(
            query,
            values
        );

    return result.rows[0] || null;
};

/* =========================================================
   TRANSFER CANDIDATE TO EMPLOYEE
========================================================= */
export const transferCandidateToEmployeeModel = async (
    candidateId,
    requestedStatus
) => {
    const client = await pool.connect();

    const normalizeStatusName = (value) =>
        String(value ?? "")
            .trim()
            .toLowerCase();

    try {
        await client.query("BEGIN");

        const candidateResult = await client.query(
            `
                SELECT c.*
                FROM candidate c
                WHERE c.id = $1
                FOR UPDATE
            `,
            [candidateId]
        );

        const candidate = candidateResult.rows[0];

        if (!candidate) {
            const error = new Error("Candidate not found");
            error.statusCode = 404;
            throw error;
        }

        const normalizedStatus = String(
            requestedStatus || ""
        ).trim();

        if (!normalizedStatus) {
            const error = new Error(
                "Status is required in payload"
            );
            error.statusCode = 400;
            throw error;
        }

        const statusResult = await client.query(
            `
                SELECT status_name, move_to_employee
                FROM status
                WHERE LOWER(TRIM(status_name)) = LOWER(TRIM($1))
                  AND COALESCE(status, TRUE) = TRUE
                LIMIT 1
            `,
            [normalizedStatus]
        );

        const candidateStatus =
            normalizeStatusName(
                candidate.candidate_status
            );

        const requestedStatusNormalized =
            normalizeStatusName(normalizedStatus);

        const statusRow = statusResult.rows[0];

        const candidateStatusMatch =
            candidateStatus === requestedStatusNormalized;

        const moveToEmployee =
            statusRow?.move_to_employee === true;

        console.log("TRANSFER STATUS CHECK:", {
            candidate_id: candidate.id,
            candidate_status: candidate.candidate_status,
            requested_status: normalizedStatus,
            candidate_status_match: candidateStatusMatch,
            status_row: statusRow || null,
            move_to_employee: statusRow?.move_to_employee
        });

        if (!candidateStatusMatch) {
            await client.query("ROLLBACK");

            return {
                transferred: false,
                candidate_id: candidate.id,
                reason: "Candidate status does not match requested status",
                candidate_status: candidate.candidate_status,
                requested_status: normalizedStatus
            };
        }

        if (!statusRow) {
            await client.query("ROLLBACK");

            return {
                transferred: false,
                candidate_id: candidate.id,
                reason: "Status not found or inactive",
                requested_status: normalizedStatus
            };
        }

        if (!moveToEmployee) {
            await client.query("ROLLBACK");

            return {
                transferred: false,
                candidate_id: candidate.id,
                reason: "This status is not configured to move candidate to employee",
                status_name: statusRow.status_name,
                move_to_employee: statusRow.move_to_employee
            };
        }

        const existingTransfer = await client.query(
            `
                SELECT me.id
                FROM personal_details pd
                INNER JOIN master_employee me
                    ON me.personal_details_id = pd.id
                WHERE pd.candidate_id = $1
                LIMIT 1
            `,
            [String(candidate.id)]
        );

        if (existingTransfer.rows[0]) {
            const error = new Error(
                "Candidate is already transferred to employee"
            );
            error.statusCode = 409;
            throw error;
        }

        const personalResult = await client.query(
            `
                INSERT INTO personal_details (
                    candidate_id, first_name, middle_name, last_name, username,
                    date_of_birth, gender, blood_group, family_members_count,
                    marital_status, anniversary_date, dependent_children, email_id,
                    current_address, permanent_address, image, mobile_number,
                    alternate_contact_number, emergency_contact_name,
                    emergency_contact_number, emergency_relationship,
                    source, current_salary, expected_salary, linkedin_profile_link, 
                    resume
                )
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,0),$10,$11,
                        COALESCE($12,0),$13,$14,$15,$16,$17,$18,$19,$20,
                        $21,$22,$23,$24,$25,$26)
                ON CONFLICT (username) DO UPDATE SET
                    candidate_id = EXCLUDED.candidate_id,
                    updated_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
                RETURNING id
            `,
            [
                String(candidate.id), candidate.first_name, candidate.middle_name,
                candidate.last_name, candidate.username, candidate.date_of_birth,
                candidate.gender, candidate.blood_group, candidate.family_members_count,
                candidate.marital_status, candidate.anniversary_date,
                candidate.dependent_children, candidate.email_id,
                candidate.current_address, candidate.permanent_address,
                candidate.image, candidate.mobile_number,
                candidate.alternate_contact_number, candidate.emergency_contact_name,
                candidate.emergency_contact_number, candidate.emergency_relationship,
                candidate.source, candidate.current_salary, candidate.expected_salary, candidate.linkedin_profile_link,
                candidate.resume
            ]
        );

        const personalDetailsId = personalResult.rows[0].id;

        await client.query(
            `
                INSERT INTO identification_details (
                    personal_details_id, pan_card_number, pan_card_upload,
                    aadhaar_number, aadhaar_upload, other_document_upload
                )
                SELECT $1,$2,$3,$4,$5,$6
                WHERE NOT EXISTS (
                    SELECT 1
                    FROM identification_details existing
                    WHERE existing.personal_details_id = $1
                )
            `,
            [
                personalDetailsId, candidate.pan_card_number,
                candidate.pan_card_upload, candidate.aadhaar_number,
                candidate.aadhaar_upload, candidate.other_document_upload
            ]
        );

        await client.query(
            `
                INSERT INTO bank_details (
                    personal_details_id, bank_name, account_holder_name,
                    account_number, ifsc_code, branch_name, bank_proof
                )
                SELECT $1,$2,$3,$4,$5,$6,$7
                WHERE NOT EXISTS (
                    SELECT 1
                    FROM bank_details existing
                    WHERE existing.personal_details_id = $1
                )
            `,
            [
                personalDetailsId, candidate.bank_name,
                candidate.account_holder_name, candidate.account_number,
                candidate.ifsc_code, candidate.branch_name, candidate.bank_proof
            ]
        );

        const education = Array.isArray(candidate.education)
            ? candidate.education
            : [];

        for (const item of education) {
            await client.query(
                `
                    INSERT INTO educational_qualifications (
                        personal_details_id, education, university_institution,
                        branch, cgpa_percentage, year_of_passing,
                        marksheet_certificate_upload
                    ) VALUES ($1,$2,$3,$4,$5,$6,$7)
                `,
                [
                    personalDetailsId, item.education,
                    item.university_institution, item.branch,
                    item.cgpa_percentage, item.year_of_passing,
                    item.marksheet_certificate_upload
                ]
            );
        }

        const employmentResult = await client.query(
            `
                INSERT INTO employment_details (
                    personal_details_id, employment_id, username, rfid,
                    designation, department, sub_department, category,
                    date_of_joining, work_email, employment_type, work_location,
                    reporting_manager, probation_period, notice_period, bond,
                    has_experience, internship_start_date,
                    internship_end_date, internship_duration, noc_letter, offer_letter
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
                RETURNING id
            `,
            [
                personalDetailsId, candidate.employment_id, candidate.username,
                candidate.rfid, candidate.designation, candidate.department,
                candidate.sub_department, candidate.category,
                candidate.date_of_joining, candidate.work_email,
                candidate.employment_type, candidate.work_location,
                candidate.reporting_manager, candidate.probation_period,
                candidate.notice_period, candidate.bond, candidate.has_experience,
                candidate.internship_start_date, candidate.internship_end_date, candidate.internship_duration,
                candidate.noc_letter, candidate.offer_letter
            ]
        );

        const workExperience = Array.isArray(candidate.work_experience)
            ? candidate.work_experience
            : [];

        for (const item of workExperience) {
            await client.query(
                `
                    INSERT INTO work_experience (
                        personal_details_id, company_name, job_title,
                        duration_from, duration_to, salary, reason_for_leaving,
                        responsibilities, experience_letter
                    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                `,
                [
                    personalDetailsId, item.company_name, item.job_title,
                    item.duration_from, item.duration_to, item.salary,
                    item.reason_for_leaving, item.responsibilities,
                    item.experience_letter
                ]
            );
        }

        const masterResult = await client.query(
            `
                INSERT INTO master_employee (
                    personal_details_id, username, status, candidate_status
                ) VALUES ($1,$2,'pending_approval',$3)
                ON CONFLICT (personal_details_id) DO UPDATE SET
                    status = 'pending_approval',
                    candidate_status = EXCLUDED.candidate_status,
                    updated_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
                RETURNING *
            `,
            [
                personalDetailsId,
                candidate.username,
                statusResult.rows[0].status_name
            ]
        );

        await client.query("COMMIT");

        return {
            candidate_id: candidate.id,
            personal_details_id: personalDetailsId,
            employment_details_id: employmentResult.rows[0]?.id || null,
            master_employee: masterResult.rows[0]
        };
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
};
