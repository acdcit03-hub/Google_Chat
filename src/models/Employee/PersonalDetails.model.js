import { pool } from "../../database.js";

/* ================= CREATE TABLE ================= */
export const initializePersonalDetailsTable = async () => {
    const query = `
        CREATE TABLE IF NOT EXISTS personal_details (
          id SERIAL PRIMARY KEY,
          candidate_id VARCHAR(255),
          first_name VARCHAR(255) NOT NULL,
          middle_name VARCHAR(255),
          last_name VARCHAR(255),
          username VARCHAR(50) UNIQUE,
          date_of_birth DATE,
          gender VARCHAR(50),
          blood_group VARCHAR(20),
          family_members_count INTEGER DEFAULT 0,
          marital_status VARCHAR(50),
          anniversary_date DATE,
          dependent_children INTEGER DEFAULT 0,
          email_id VARCHAR(255),
          current_address TEXT,
          permanent_address TEXT,
          image TEXT,
          mobile_number BIGINT,
          alternate_contact_number BIGINT,
          emergency_contact_name VARCHAR(255),
          emergency_contact_number BIGINT,
          emergency_relationship VARCHAR(100),
          source VARCHAR(255),
          current_salary NUMERIC,
          expected_salary NUMERIC,
          linkedin_profile_link TEXT,
          resume TEXT,
          created_at TIMESTAMP DEFAULT TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP),
          updated_at TIMESTAMP DEFAULT TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
        );
    `;

    await pool.query(query);

    await pool.query(`
        ALTER TABLE personal_details
        ADD COLUMN IF NOT EXISTS candidate_id VARCHAR(255);

        ALTER TABLE personal_details
        ADD COLUMN IF NOT EXISTS source VARCHAR(255);

        ALTER TABLE personal_details
        ADD COLUMN IF NOT EXISTS current_salary NUMERIC;

        ALTER TABLE personal_details
        ADD COLUMN IF NOT EXISTS expected_salary NUMERIC;

        ALTER TABLE personal_details
        ADD COLUMN IF NOT EXISTS linkedin_profile_link TEXT;

        ALTER TABLE personal_details
        ADD COLUMN IF NOT EXISTS resume TEXT;
    `);

    await pool.query(`
        SELECT setval(
            pg_get_serial_sequence('personal_details', 'id'),
            COALESCE((SELECT MAX(id) FROM personal_details), 1),
            true
        );
    `);

    console.log("✅ personal_details table ready");
};

/* ================= ADD ================= */
export const addPersonalDetailsModel = async (data) => {
    const existingUser = await pool.query(
        `SELECT * FROM personal_details WHERE username = $1 LIMIT 1`,
        [data.username]
    );

    if (existingUser.rows[0]) {
        return existingUser.rows[0];
    }

    const query = `
        INSERT INTO personal_details (
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
            image,
            mobile_number,
            alternate_contact_number,
            emergency_contact_name,
            emergency_contact_number,
            emergency_relationship,
            source,
            current_salary,
            expected_salary,
            linkedin_profile_link,
            resume
        )
        VALUES (
          $1,$2,$3,$4,$5,
          $6,$7,$8,$9,$10,
          $11,$12,$13,$14,$15,
          $16,$17,$18,$19,$20,
          $21,$22,$23,$24,$25,
          $26
        )
        RETURNING *;
    `;

    const values = [
        data.first_name,
        data.middle_name || null,
        data.last_name || null,
        data.username || null,
        data.candidate_id || null,
        data.date_of_birth || null,
        data.gender || null,
        data.blood_group || null,
        data.family_members_count || 0,
        data.marital_status || null,
        data.anniversary_date || null,
        data.dependent_children || 0,
        data.email_id || null,
        data.current_address || null,
        data.permanent_address || null,
        data.image || null,
        data.mobile_number || null,
        data.alternate_contact_number || null,
        data.emergency_contact_name || null,
        data.emergency_contact_number || null,
        data.emergency_relationship || null,
        data.source || null,
        data.current_salary || null,
        data.expected_salary || null,
        data.linkedin_profile_link || null,
        data.resume || null
    ];

    const { rows } = await pool.query(query, values);
    return rows[0];
};

/* ================= GET ALL ================= */
export const getAllPersonalDetailsModel = async () => {
    const { rows } = await pool.query(`
        SELECT
            pd.*,
            me.status
        FROM personal_details pd
        LEFT JOIN master_employee me
            ON me.personal_details_id = pd.id
        ORDER BY pd.id DESC
    `);

    return rows;
};

/* ================= GET BY USERNAME ================= */
export const getPersonalDetailsByUsernameModel = async (username) => {
    const { rows } = await pool.query(
        `
        SELECT *
        FROM personal_details
        WHERE username = $1
        `,
        [username]
    );

    return rows[0];
};

/* ================= GET ALL EMPLOYEE TABLE ================= */
export const getAllEmployeeCompleteDataModel = async ({
    name = null,
    employment_id = null,
    job_posting = null,
    department = null,
    designation = null,
    work_email = null,
    contact = null,
    joining_date = null,
    manager = null,
    status = null,
    category = null,
    work_location = null,
    page = 1,
    limit = 20
} = {}) => {

    page = Number(page);
    limit = Number(limit);

    if (!Number.isInteger(page) || page < 1) {
        page = 1;
    }

    if (!Number.isInteger(limit) || limit < 1) {
        limit = 20;
    }

    /* Prevent unnecessarily huge queries */
    limit = Math.min(limit, 100);
    const offset = (page - 1) * limit;

    /* =========================================================
       FILTER HELPERS
    ========================================================= */
    const parseFilters = (value) => {
        if (Array.isArray(value)) {
            return value
                .map(v => String(v).trim())
                .filter(Boolean);
        }

        return String(value || "")
            .split(",")
            .map(v => v.trim())
            .filter(Boolean);
    };

    const departmentFilters = parseFilters(department);
    const designationFilters = parseFilters(designation);
    const categoryFilters = parseFilters(category);
    const workLocationFilters = parseFilters(work_location);
    const statusFilters = parseFilters(status);
    const jobPostingFilters = parseFilters(job_posting);

    /* =========================================================
       MAIN QUERY
    ========================================================= */
    let query = `
        SELECT
            pd.*,

            TO_CHAR(
                pd.date_of_birth,
                'YYYY-MM-DD'
            ) AS date_of_birth,

            /* ================= EMPLOYEE IMAGE ================= */
            CASE
                WHEN pd.image IS NOT NULL
                     AND TRIM(pd.image) <> ''
                THEN pd.image

                ELSE COALESCE(
                    NULLIF(
                        (
                            SELECT TRIM(c_img.category_image)
                            FROM employment_details ed_img
                            LEFT JOIN category c_img
                                ON c_img.id = ed_img.category
                            WHERE ed_img.personal_details_id = pd.id
                            LIMIT 1
                        ),
                        ''
                    ),
                    'https://img.magnific.com/premium-vector/employee-icon_1134231-3528.jpg'
                )
            END AS image,

            /* ================= CANDIDATE ================= */
            pd.candidate_id AS candidate_id,
        
            (
                SELECT row_to_json(cand)
                FROM candidate cand
                WHERE cand.id =
                    CASE
                        WHEN pd.candidate_id ~ '^[0-9]+$'
                        THEN pd.candidate_id::INTEGER
                        ELSE NULL
                    END
                LIMIT 1
            ) AS candidate,

            /* ================= MASTER EMPLOYEE ================= */
            me.id AS master_employee_id,
            me.status,
            me.created_at AS employee_created_at,
            me.updated_at AS employee_updated_at,

            /* =====================================================
               EMPLOYMENT DETAILS
            ===================================================== */
            (
                SELECT to_jsonb(ed) || jsonb_build_object(

                    /* ================= BASIC ================= */
                    'id', ed.id,
                    'personal_details_id',
                        ed.personal_details_id,

                    'employment_id',
                        ed.employment_id,

                    'rfid',
                        ed.rfid,

                    /* ================= DESIGNATION ================= */
                    'designation_id',
                        ed.designation,

                    'designation',
                        ds.name,

                    /* ================= DEPARTMENT ================= */
                    'department_id',
                        ed.department,

                    'department',
                        dep.name,

                    /* ================= SUB DEPARTMENT ================= */
                    'sub_department_id',
                        ed.sub_department,

                    'sub_department',
                        subdep.name,


                    /* ================= CATEGORY ================= */
                    'category_id',
                        c.id,

                    'category',
                        c.category_name,

                    /* ================= JOINING ================= */
                    'date_of_joining',
                        ed.date_of_joining,

                    'work_email',
                        ed.work_email,

                    'employment_type',
                        ed.employment_type,

                    /* ================= SHIFT ================= */
                    'shift_id',
                        ed.shift_id,

                    'shift_name',
                        sc.shift_name,

                    'shift_type',
                        sc.shift_type,

                    /* ================= WORK LOCATION ================= */
                    'work_location_id',
                        wl.id,

                    'work_location',
                        wl.location,

                    'address',
                        wl.address,

                    'city',
                        wl.city,

                    'state',
                        wl.state,

                    'zip',
                        wl.zip,

                    /* ================= MANAGER ================= */
                    'reporting_manager',
                        ed.reporting_manager,

                    'probation_period',
                        ed.probation_period,

                    'notice_period',
                        ed.notice_period,

                    /* ================= BOND ================= */
                    'bond_id',
                        bo.id,

                    'bond',
                        bo.bond_duration,

                    /* ================= OTHER ================= */
                    'has_experience',
                        ed.has_experience,

                    /* ================= LOGIN ================= */
                    'username',
                        ed.username,

                    'password',
                        ed.password,

                    'access',
                        ed.access,

                    /* ================= TIMESTAMPS ================= */
                    'created_at',
                        ed.created_at,

                    'updated_at',
                        ed.updated_at,

                    /* ================= WORKING TIME ================= */
                    'working_start_time',
                        epc.working_start_time,

                    'working_end_time',
                        epc.working_end_time,

                    'show_in_attendance',
                        ed.show_in_attendance,

                    /* ================= SHIFT TIME ================= */
                    'start_time',
                        sc.start_time,

                    'end_time',
                        sc.end_time,

                    'shift_reset_time',
                        sc.shift_reset_time,

                    'shift_time',
                        CONCAT(
                            TO_CHAR(
                                sc.start_time,
                                'HH24:MI'
                            ),
                            ' - ',
                            TO_CHAR(
                                sc.end_time,
                                'HH24:MI'
                            )
                        ),

                    'break_time',
                        CONCAT(
                            TO_CHAR(
                                sc.break_start_time,
                                'HH24:MI'
                            ),
                            ' - ',
                            TO_CHAR(
                                sc.break_end_time,
                                'HH24:MI'
                            )
                        )
                )

                    FROM employment_details ed

                LEFT JOIN LATERAL (
                    SELECT epc_latest.*
                    FROM employee_payroll_config epc_latest
                    WHERE epc_latest.username = pd.username
                    ORDER BY
                        CASE
                            WHEN (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::DATE
                                BETWEEN epc_latest.payroll_start_date
                                    AND epc_latest.payroll_end_date
                            THEN 0 ELSE 1
                        END,
                        epc_latest.payroll_start_date DESC,
                        epc_latest.id DESC
                    LIMIT 1
                ) epc ON TRUE

                /* ================= SHIFT ================= */
                    LEFT JOIN shift_configurations sc
                    ON sc.id = ed.shift_id

                /* ================= LOCATION ================= */
                    LEFT JOIN work_location wl
                    ON wl.id = ed.work_location

                /* ================= BOND ================= */
                LEFT JOIN bond_options bo
                    ON bo.id = ed.bond

                /* ================= CATEGORY ================= */
                LEFT JOIN category c
                    ON c.id = ed.category

                /* ================= DESIGNATION ================= */
                LEFT JOIN department_structure ds
                    ON ds.id = ed.designation

                /* ================= DEPARTMENT ================= */
                LEFT JOIN department_structure dep
                    ON dep.id = ed.department

                /* ================= SUB DEPARTMENT ================= */
                LEFT JOIN department_structure subdep
                    ON subdep.id = ed.sub_department

                WHERE ed.personal_details_id = pd.id
                    LIMIT 1

            ) AS employment_details,

            /* =====================================================
               IDENTIFICATION
            ===================================================== */
            (
                SELECT COALESCE(
                    json_agg(idt),
                    '[]'::json
                )
                FROM identification_details idt
                WHERE idt.personal_details_id = pd.id
            ) AS identification_details,

            /* =====================================================
               WORK EXPERIENCE
            ===================================================== */
            (
                SELECT COALESCE(
                    json_agg(we),
                    '[]'::json
                )
                FROM work_experience we
                WHERE we.personal_details_id = pd.id
            ) AS work_experience,

            /* =====================================================
               EDUCATION
            ===================================================== */
            (
                SELECT COALESCE(
                    json_agg(
                        to_jsonb(eq) || jsonb_build_object(
                            'id', eq.id,
                            'personal_details_id', eq.personal_details_id,
            
                            'education_id', eq.education,
                            'education', edu.education_name,
            
                            'university_institution',
                                eq.university_institution,
            
                            'branch',
                                eq.branch,
            
                            'cgpa_percentage',
                                eq.cgpa_percentage,
            
                            'year_of_passing',
                                eq.year_of_passing,
            
                            'marksheet_certificate_upload',
                                eq.marksheet_certificate_upload,
            
                            'created_at',
                                eq.created_at,
            
                            'updated_at',
                                eq.updated_at
                        )
                        ORDER BY eq.id DESC
                    ),
                    '[]'::json
                )
            
                FROM educational_qualifications eq
            
                LEFT JOIN education edu
                    ON edu.id = eq.education
            
                WHERE eq.personal_details_id = pd.id
            
            ) AS educational_qualifications,

            /* =====================================================
               BANK
            ===================================================== */
            (
                SELECT row_to_json(bd)
                FROM bank_details bd
                WHERE bd.personal_details_id = pd.id
                LIMIT 1
            ) AS bank_details

        FROM personal_details pd

        LEFT JOIN master_employee me
            ON me.personal_details_id = pd.id

        LEFT JOIN employment_details emp
            ON emp.personal_details_id = pd.id

        LEFT JOIN candidate cand_filter
            ON cand_filter.id =
                CASE
                    WHEN pd.candidate_id ~ '^[0-9]+$'
                    THEN pd.candidate_id::INTEGER
                    ELSE NULL
                END

        /* ================= FILTER JOINS ================= */
        LEFT JOIN work_location wl_filter
            ON wl_filter.id = emp.work_location

        LEFT JOIN category c_filter
            ON c_filter.id = emp.category

        LEFT JOIN department_structure dept_filter
            ON dept_filter.id = emp.department

        LEFT JOIN department_structure desig_filter
            ON desig_filter.id = emp.designation

        WHERE 1 = 1
    `;

    /* =========================================================
       COUNT QUERY
    ========================================================= */
    let countQuery = `
        SELECT
            COUNT(DISTINCT pd.id) AS total

        FROM personal_details pd

        LEFT JOIN master_employee me
            ON me.personal_details_id = pd.id

        LEFT JOIN employment_details emp
            ON emp.personal_details_id = pd.id

        LEFT JOIN candidate cand_filter
            ON cand_filter.id =
                CASE
                    WHEN pd.candidate_id ~ '^[0-9]+$'
                    THEN pd.candidate_id::INTEGER
                    ELSE NULL
                END

        LEFT JOIN work_location wl_filter
            ON wl_filter.id = emp.work_location

        LEFT JOIN category c_filter
            ON c_filter.id = emp.category

        LEFT JOIN department_structure dept_filter
            ON dept_filter.id = emp.department

        LEFT JOIN department_structure desig_filter
            ON desig_filter.id = emp.designation

        WHERE 1 = 1
    `;

    const values = [];
    const countValues = [];

    let paramIndex = 1;
    let countParamIndex = 1;

    /* =========================================================
       NAME
    ========================================================= */
    if (name) {
        query += `
            AND CONCAT_WS(
                ' ',
                pd.first_name,
                pd.middle_name,
                pd.last_name,
                pd.username
            ) ILIKE $${paramIndex}
    `;

        values.push(`%${name}%`);
        paramIndex++;

        countQuery += `
            AND CONCAT_WS(
                ' ',
                pd.first_name,
                pd.middle_name,
                pd.last_name,
                pd.username
            ) ILIKE $${countParamIndex}
    `;

        countValues.push(`%${name}%`);
        countParamIndex++;
    }

    /* =========================================================
       EMPLOYMENT ID
    ========================================================= */
    if (employment_id) {
        query += `
            AND emp.employment_id ILIKE $${paramIndex}
        `;

        values.push(
            `%${employment_id}%`
        );

        paramIndex++;

        countQuery += `
            AND emp.employment_id ILIKE $${countParamIndex}
        `;

        countValues.push(
            `%${employment_id}%`
        );

        countParamIndex++;
    }

    /* =========================================================
       JOB POSTING
    ========================================================= */
    if (jobPostingFilters.length) {
        const conditions = [];

        jobPostingFilters.forEach((value, index) => {
            const param = paramIndex + index;

            conditions.push(`
                cand_filter.job_posting
                    ILIKE
                $${param}
            `);
        });

        query += `
            AND (
                ${conditions.join(" OR ")}
            )
        `;

        values.push(
            ...jobPostingFilters.map(value =>
                `%${value}%`
            )
        );

        paramIndex += jobPostingFilters.length;

        /* ================= COUNT ================= */
        const countConditions = [];

        jobPostingFilters.forEach((value, index) => {
            const param = countParamIndex + index;

            countConditions.push(`
                cand_filter.job_posting
                    ILIKE
                $${param}
            `);
        });

        countQuery += `
            AND (
                ${countConditions.join(" OR ")}
            )
        `;

        countValues.push(
            ...jobPostingFilters.map(value =>
                `%${value}%`
            )
        );

        countParamIndex += jobPostingFilters.length;
    }

    /* =========================================================
       DEPARTMENT
    ========================================================= */
    if (departmentFilters.length) {
        const conditions = [];

        departmentFilters.forEach(
            (value, index) => {

                const param =
                    paramIndex + index;

                if (/^\d+$/.test(value)) {

                    conditions.push(`
                        dept_filter.id =
                        $${param}::INTEGER
                    `);

                } else {

                    conditions.push(`
                        dept_filter.name
                        ILIKE
                        $${param}
                    `);
                }
            }
        );

        query += `
            AND (
                ${conditions.join(" OR ")}
            )
        `;

        values.push(
            ...departmentFilters.map(value =>
                /^\d+$/.test(value)
                    ? value
                    : `%${value}%`
            )
        );

        paramIndex += departmentFilters.length;

        /* ================= COUNT ================= */
        const countConditions = [];

        departmentFilters.forEach(
            (value, index) => {

                const param =
                    countParamIndex + index;

                if (/^\d+$/.test(value)) {

                    countConditions.push(`
                        dept_filter.id =
                        $${param}::INTEGER
                    `);

                } else {

                    countConditions.push(`
                        dept_filter.name
                        ILIKE
                        $${param}
                    `);
                }
            }
        );

        countQuery += `
            AND (
                ${countConditions.join(" OR ")}
            )
        `;

        countValues.push(
            ...departmentFilters.map(value =>
                /^\d+$/.test(value)
                    ? value
                    : `%${value}%`
            )
        );

        countParamIndex += departmentFilters.length;
    }

    /* =========================================================
       DESIGNATION
    ========================================================= */
    if (designationFilters.length) {
        const conditions = [];

        designationFilters.forEach(
            (value, index) => {

                const param =
                    paramIndex + index;

                if (/^\d+$/.test(value)) {

                    conditions.push(`
                        desig_filter.id =
                        $${param}::INTEGER
                    `);

                } else {

                    conditions.push(`
                        desig_filter.name
                        ILIKE
                        $${param}
                    `);
                }
            }
        );

        query += `
            AND (
                ${conditions.join(" OR ")}
            )
        `;

        values.push(
            ...designationFilters.map(value =>
                /^\d+$/.test(value)
                    ? value
                    : `%${value}%`
            )
        );

        paramIndex +=
            designationFilters.length;


        /* ================= COUNT ================= */
        const countConditions = [];

        designationFilters.forEach(
            (value, index) => {

                const param =
                    countParamIndex + index;

                if (/^\d+$/.test(value)) {

                    countConditions.push(`
                        desig_filter.id =
                        $${param}::INTEGER
                    `);

                } else {

                    countConditions.push(`
                        desig_filter.name
                        ILIKE
                        $${param}
                    `);
                }
            }
        );

        countQuery += `
            AND (
                ${countConditions.join(" OR ")}
            )
        `;

        countValues.push(
            ...designationFilters.map(value =>
                /^\d+$/.test(value)
                    ? value
                    : `%${value}%`
            )
        );

        countParamIndex +=
            designationFilters.length;
    }


    /* =========================================================
       WORK EMAIL
    ========================================================= */
    if (work_email) {

        query += `
            AND emp.work_email ILIKE $${paramIndex}
        `;

        values.push(
            `%${work_email}%`
        );

        paramIndex++;


        countQuery += `
            AND emp.work_email ILIKE $${countParamIndex}
        `;

        countValues.push(
            `%${work_email}%`
        );

        countParamIndex++;
    }


    /* =========================================================
       CONTACT
    ========================================================= */
    if (contact) {

        query += `
            AND pd.mobile_number::TEXT
                ILIKE $${paramIndex}
        `;

        values.push(
            `%${contact}%`
        );

        paramIndex++;


        countQuery += `
            AND pd.mobile_number::TEXT
                ILIKE $${countParamIndex}
        `;

        countValues.push(
            `%${contact}%`
        );

        countParamIndex++;
    }

    /* =========================================================
       JOINING DATE
    ========================================================= */
    if (joining_date) {

        query += `
            AND emp.date_of_joining =
                $${paramIndex}::DATE
        `;

        values.push(joining_date);
        paramIndex++;


        countQuery += `
            AND emp.date_of_joining =
                $${countParamIndex}::DATE
        `;

        countValues.push(joining_date);
        countParamIndex++;
    }

    /* =========================================================
       MANAGER
    ========================================================= */
    if (manager) {

        query += `
            AND emp.reporting_manager
                ILIKE $${paramIndex}
        `;

        values.push(
            `%${manager}%`
        );

        paramIndex++;

        countQuery += `
            AND emp.reporting_manager
                ILIKE $${countParamIndex}
        `;

        countValues.push(
            `%${manager}%`
        );

        countParamIndex++;
    }

    /* =========================================================
       CATEGORY
    ========================================================= */
    if (categoryFilters.length) {
        const conditions = [];
        categoryFilters.forEach(
            (value, index) => {

                const param =
                    paramIndex + index;

                if (/^\d+$/.test(value)) {

                    conditions.push(`
                        c_filter.id =
                        $${param}::INTEGER
                    `);

                } else {

                    conditions.push(`
                        c_filter.category_name
                        ILIKE
                        $${param}
                    `);
                }
            }
        );

        query += `
            AND (
                ${conditions.join(" OR ")}
            )
        `;

        values.push(
            ...categoryFilters.map(value =>
                /^\d+$/.test(value)
                    ? value
                    : `%${value}%`
            )
        );

        paramIndex += categoryFilters.length;

        /* ================= COUNT ================= */
        const countConditions = [];

        categoryFilters.forEach(
            (value, index) => {

                const param =
                    countParamIndex + index;

                if (/^\d+$/.test(value)) {

                    countConditions.push(`
                        c_filter.id =
                        $${param}::INTEGER
                    `);

                } else {

                    countConditions.push(`
                        c_filter.category_name
                        ILIKE
                        $${param}
                    `);
                }
            }
        );

        countQuery += `
            AND (
                ${countConditions.join(" OR ")}
            )
        `;

        countValues.push(
            ...categoryFilters.map(value =>
                /^\d+$/.test(value)
                    ? value
                    : `%${value}%`
            )
        );

        countParamIndex +=
            categoryFilters.length;
    }

    /* =========================================================
       WORK LOCATION
    ========================================================= */
    const isAllLocation =
        workLocationFilters.some(
            value =>
                value.toLowerCase() === "all"
        );

    if (
        workLocationFilters.length &&
        !isAllLocation
    ) {

        const conditions = [];

        workLocationFilters.forEach(
            (value, index) => {

                const param =
                    paramIndex + index;

                if (/^\d+$/.test(value)) {

                    conditions.push(`
                        wl_filter.id =
                        $${param}::INTEGER
                    `);

                } else {

                    conditions.push(`
                        wl_filter.location
                        ILIKE
                        $${param}
                    `);
                }
            }
        );

        query += `
            AND (
                ${conditions.join(" OR ")}
            )
        `;

        values.push(
            ...workLocationFilters.map(value =>
                /^\d+$/.test(value)
                    ? value
                    : `%${value}%`
            )
        );

        paramIndex += workLocationFilters.length;

        /* ================= COUNT ================= */
        const countConditions = [];

        workLocationFilters.forEach(
            (value, index) => {

                const param =
                    countParamIndex + index;

                if (/^\d+$/.test(value)) {

                    countConditions.push(`
                        wl_filter.id =
                        $${param}::INTEGER
                    `);

                } else {

                    countConditions.push(`
                        wl_filter.location
                        ILIKE
                        $${param}
                    `);
                }
            }
        );

        countQuery += `
            AND (
                ${countConditions.join(" OR ")}
            )
        `;

        countValues.push(
            ...workLocationFilters.map(value =>
                /^\d+$/.test(value)
                    ? value
                    : `%${value}%`
            )
        );

        countParamIndex +=
            workLocationFilters.length;
    }

    /* =========================================================
       STATUS
    ========================================================= */
    if (statusFilters.length) {

        query += `
        AND LOWER(TRIM(me.status)) IN (
            ${statusFilters
                .map(
                    (_, index) =>
                        `LOWER(TRIM($${paramIndex + index}))`
                )
                .join(",")}
        )
    `;

        values.push(
            ...statusFilters
        );

        paramIndex += statusFilters.length;


        /* ================= COUNT ================= */

        countQuery += `
        AND LOWER(TRIM(me.status)) IN (
            ${statusFilters
                .map(
                    (_, index) =>
                        `LOWER(TRIM($${countParamIndex + index}))`
                )
                .join(",")}
        )
    `;

        countValues.push(
            ...statusFilters
        );

        countParamIndex += statusFilters.length;
    }

    /* =========================================================
       ORDER + PAGINATION
    ========================================================= */

    query += `
        ORDER BY

            /* ================= CATEGORY ORDER ================= */
            CASE
                WHEN LOWER(TRIM(c_filter.category_name)) = 'employee'
                    THEN 1

                WHEN LOWER(TRIM(c_filter.category_name)) = 'intern'
                    THEN 2

                ELSE 3
            END,

            /* ================= EMPLOYMENT ID ================= */
            CASE
                WHEN emp.employment_id IS NULL
                    THEN 1
                ELSE 0
            END,

            /* ================= EMPLOYMENT ID ASC ================= */
            emp.employment_id ASC,

            /* ================= FALLBACK ================= */
            emp.id ASC

        LIMIT $${paramIndex}
        OFFSET $${paramIndex + 1}
    `;

    values.push(limit);
    values.push(offset);

    /* =========================================================
       EXECUTE MAIN + COUNT
    ========================================================= */
    const [
        mainResult,
        countResult
    ] = await Promise.all([
        pool.query(query, values),
        pool.query(countQuery, countValues)
    ]);

    const rows = mainResult.rows;
    const totalRecords =
        Number(
            countResult.rows[0]?.total || 0
        );

    /* =========================================================
       SUMMARY
    ========================================================= */
    let summaryQuery = `
        SELECT

            COUNT(DISTINCT me.id)
                AS total_people,

            COUNT(DISTINCT CASE
                WHEN LOWER(
                    TRIM(c.category_name)
                ) = 'employee'
                THEN me.id
            END)
                AS total_employees,

            COUNT(DISTINCT CASE
                WHEN me.status = 'active'
                 AND LOWER(
                    TRIM(c.category_name)
                 ) = 'employee'
                    THEN me.id
            END)
                AS active_employees,

            COUNT(DISTINCT CASE
                WHEN me.status =
                    'pending_approval'
                THEN me.id
            END)
                AS pending_approval,

            COUNT(DISTINCT CASE
                WHEN me.status = 'inactive'
                 AND LOWER(
                    TRIM(c.category_name)
                 ) = 'employee'
                THEN me.id
            END)
                AS inactive_employees,

            COUNT(DISTINCT CASE
                WHEN me.status = 'active'
                 AND LOWER(
                    TRIM(c.category_name)
                 ) = 'intern'
                THEN me.id
            END)
                AS active_intern,


            COUNT(DISTINCT CASE
                WHEN me.status = 'inactive'
                 AND LOWER(
                    TRIM(c.category_name)
                 ) = 'intern'
                THEN me.id
            END)
                AS inactive_intern

        FROM master_employee me

        LEFT JOIN personal_details pd
            ON pd.id =
                me.personal_details_id

        LEFT JOIN employment_details ed
            ON ed.personal_details_id =
                pd.id

        LEFT JOIN category c
            ON c.id = ed.category

        LEFT JOIN work_location wl
            ON wl.id = ed.work_location

        WHERE 1 = 1
    `;


    const summaryValues = [];
    let summaryParamIndex = 1;

    /* =========================================================
       SUMMARY WORK LOCATION
    ========================================================= */
    if (
        workLocationFilters.length &&
        !isAllLocation
    ) {

        const conditions = [];
        workLocationFilters.forEach(
            (value, index) => {

                const param =
                    summaryParamIndex + index;

                if (/^\d+$/.test(value)) {

                    conditions.push(`
                        wl.id =
                        $${param}::INTEGER
                    `);

                } else {

                    conditions.push(`
                        wl.location
                        ILIKE
                        $${param}
                    `);
                }
            }
        );

        summaryQuery += `
            AND (
                ${conditions.join(" OR ")}
            )
        `;

        summaryValues.push(
            ...workLocationFilters.map(value =>
                /^\d+$/.test(value)
                    ? value
                    : `%${value}%`
            )
        );

        summaryParamIndex += workLocationFilters.length;
    }

    /* =========================================================
       EXECUTE SUMMARY
    ========================================================= */
    const {
        rows: summaryRows
    } = await pool.query(
        summaryQuery,
        summaryValues
    );

    const summaryData =
        summaryRows[0] || {};


    /* =========================================================
       RESPONSE
    ========================================================= */
    return {
        summary: {
            total_people:
                Number(
                    summaryData.total_people || 0
                ),

            total_employees:
                Number(
                    summaryData.total_employees || 0
                ),

            active_employees:
                Number(
                    summaryData.active_employees || 0
                ),

            inactive_employees:
                Number(
                    summaryData.inactive_employees || 0
                ),

            pending_approval:
                Number(
                    summaryData.pending_approval || 0
                ),

            active_intern:
                Number(
                    summaryData.active_intern || 0
                ),

            inactive_intern:
                Number(
                    summaryData.inactive_intern || 0
                )
        },

        pagination: {
            enabled: true,
            total: totalRecords,
            page,
            limit,
            totalPages:
                Math.ceil(
                    totalRecords / limit
                )
        },
        employees: rows
    };
};

/* ================= GET BY ID (basic) ================= */
export const findPersonalDetailsByIdModel = async (id) => {
    const { rows } = await pool.query(
        `
        SELECT
            id,
            username,
            first_name,
            middle_name,
            last_name,
            email_id
        FROM personal_details
        WHERE id = $1
        LIMIT 1
        `,
        [id],
    );

    return rows[0] ?? null;
};

/* ================= GET BY ID ================= */
export const getPersonalDetailsByIdModel = async (value) => {
    const isNumeric =
        value !== null &&
        value !== undefined &&
        String(value).trim() !== "" &&
        /^\d+$/.test(String(value).trim());

    const whereClause = isNumeric
        ? "pd.id = $1"
        : "LOWER(TRIM(pd.username)) = LOWER(TRIM($1))";

    /* =====================================================
       PERSONAL DETAILS
    ===================================================== */
    const personalDetails = await pool.query(
        `
            SELECT
                pd.id,
                pd.first_name,
                pd.middle_name,
                pd.last_name,
                pd.username,

                /* ================= DATE ONLY ================= */
                TO_CHAR(
                    pd.date_of_birth,
                    'YYYY-MM-DD'
                ) AS date_of_birth,

                pd.gender,
                pd.blood_group,
                pd.family_members_count,
                pd.marital_status,

                /* ================= ANNIVERSARY DATE ================= */
                TO_CHAR(
                    pd.anniversary_date,
                    'YYYY-MM-DD'
                ) AS anniversary_date,

                pd.dependent_children,
                pd.email_id,
                pd.current_address,
                pd.permanent_address,
                CASE
                    WHEN pd.image IS NOT NULL
                         AND TRIM(pd.image) <> ''
                    THEN pd.image

                    ELSE COALESCE(
                        NULLIF(
                            (
                                SELECT TRIM(c_img.category_image)
                                FROM employment_details ed_img
                                LEFT JOIN category c_img
                                    ON c_img.id = ed_img.category
                                WHERE ed_img.personal_details_id = pd.id
                                LIMIT 1
                            ),
                            ''
                        ),
                        'https://img.magnific.com/premium-vector/employee-icon_1134231-3528.jpg'
                    )
                END AS image,
                pd.mobile_number,
                pd.alternate_contact_number,
                pd.emergency_contact_name,
                pd.emergency_contact_number,
                pd.emergency_relationship,
                pd.candidate_id,
                pd.source,
                pd.current_salary,
                pd.expected_salary,
                pd.linkedin_profile_link,
                pd.resume,
                pd.created_at,
                pd.updated_at,

                me.id AS master_employee_id,
                me.status,
                me.created_at AS employee_created_at,
                me.updated_at AS employee_updated_at

            FROM personal_details pd

            LEFT JOIN master_employee me
                ON me.personal_details_id = pd.id

            WHERE ${whereClause}

        LIMIT 1
        `,
        [value]
    );

    if (personalDetails.rows.length === 0) {
        return null;
    }

    const personalId = personalDetails.rows[0].id;

    /* =====================================================
       IDENTIFICATION DETAILS
    ===================================================== */
    const identificationDetails = await pool.query(
        `
        SELECT *
        FROM identification_details
        WHERE personal_details_id = $1
        ORDER BY id DESC
        `,
        [personalId]
    );

    /* =====================================================
       EMPLOYMENT DETAILS
    ===================================================== */
    const employmentDetails = await pool.query(
        `
            SELECT
                ed.id,
                ed.personal_details_id,
                ed.employment_id,
                ed.rfid,
                ed.designation,
                ed.department,
                ed.sub_department,
                ed.category,

                /* ================= JOINING DATE ================= */
                TO_CHAR(
                    ed.date_of_joining,
                    'YYYY-MM-DD'
                ) AS date_of_joining,

                ed.work_email,
                ed.company_mobile_number,
                ed.employment_type,
                ed.shift_id,
                epc.working_start_time,
                epc.working_end_time,
                ed.work_location,
                ed.reporting_manager,
                ed.probation_period,
                ed.notice_period,

                /* ================= INTERNSHIP DATES ================= */
                TO_CHAR(
                    ed.internship_start_date,
                    'YYYY-MM-DD'
                ) AS internship_start_date,

                TO_CHAR(
                    ed.internship_end_date,
                    'YYYY-MM-DD'
                ) AS internship_end_date,

                ed.internship_duration,

                ed.bond,
                ed.has_experience,
                ed.show_in_attendance,
                ed.created_at,
                ed.updated_at,
                ed.username,
                ed.password,
                ed.access,

                /* =================================================
                   DESIGNATION
                ================================================= */
                ds_designation.id AS designation_id,
                ds_designation.name AS designation_name,

                /* =================================================
                   DEPARTMENT
                ================================================= */
                ds_department.id AS department_id,
                ds_department.name AS department_name,

                /* =================================================
                   SUB DEPARTMENT
                ================================================= */
                ds_sub_department.id AS sub_department_id,
                ds_sub_department.name AS sub_department_name,

                /* =================================================
                   CATEGORY
                ================================================= */
                c.id AS category_id,
                c.category_name AS category_name,

                /* =================================================
                   SHIFT
                ================================================= */
                sc.id AS shift_configuration_id,
                sc.shift_name AS shift_config_name,
                sc.shift_type AS shift_config_type,

                    sc.start_time,
                    sc.end_time,
                    sc.shift_reset_time,

                    CONCAT(
                        TO_CHAR(sc.start_time, 'HH24:MI'),
                        ' - ',
                        TO_CHAR(sc.end_time, 'HH24:MI')
                    ) AS shift_time,

                    CONCAT(
                        TO_CHAR(sc.break_start_time, 'HH24:MI'),
                        ' - ',
                        TO_CHAR(sc.break_end_time, 'HH24:MI')
                ) AS break_time,


                /* =================================================
                   WORK LOCATION
                ================================================= */
                wl.id AS location_id,
                wl.location AS work_location_name,
                wl.address AS work_location_address,
                wl.city AS work_location_city,
                wl.state AS work_location_state,
                wl.zip AS work_location_zip,

                /* =================================================
                   BOND
                ================================================= */
                bo.id AS bond_id,
                bo.bond_duration AS bond_duration

                FROM employment_details ed

                INNER JOIN personal_details pd
                    ON pd.id = ed.personal_details_id

                LEFT JOIN LATERAL (
                    SELECT epc_latest.*
                    FROM employee_payroll_config epc_latest
                    WHERE epc_latest.username = pd.username
                    ORDER BY
                        CASE
                            WHEN (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::DATE
                                BETWEEN epc_latest.payroll_start_date
                                    AND epc_latest.payroll_end_date
                            THEN 0 ELSE 1
                        END,
                        epc_latest.payroll_start_date DESC,
                        epc_latest.id DESC
                    LIMIT 1
                ) epc ON TRUE

                /* =====================================================
                   DESIGNATION
                ===================================================== */
                LEFT JOIN department_structure ds_designation
                    ON ds_designation.id = ed.designation
            
                /* =====================================================
                   DEPARTMENT
                ===================================================== */
                LEFT JOIN department_structure ds_department
                    ON ds_department.id = ed.department
            
                /* =====================================================
                   SUB DEPARTMENT
                ===================================================== */
                LEFT JOIN department_structure ds_sub_department
                    ON ds_sub_department.id = ed.sub_department
            
                /* =====================================================
                   CATEGORY
                ===================================================== */
                LEFT JOIN category c
                    ON c.id = ed.category
            
                /* =====================================================
                   SHIFT
                ===================================================== */
                    LEFT JOIN shift_configurations sc
                    ON sc.id = ed.shift_id
            
                /* =====================================================
                   WORK LOCATION
                ===================================================== */
                LEFT JOIN work_location wl
                    ON wl.id = ed.work_location
            
                /* =====================================================
                   BOND
                ===================================================== */
                LEFT JOIN bond_options bo
                    ON bo.id = ed.bond
            
                    WHERE ed.personal_details_id = $1
            
                LIMIT 1
        `,
        [personalId]
    );

    /* =====================================================
       WORK EXPERIENCE
    ===================================================== */
    const workExperience = await pool.query(
        `
            SELECT
                id,
                personal_details_id,
                company_name,
                job_title,

                TO_CHAR(duration_from, 'YYYY-MM-DD')
                    AS duration_from,

                TO_CHAR(duration_to, 'YYYY-MM-DD')
                    AS duration_to,

                salary,
                reason_for_leaving,
                responsibilities,
                experience_letter,
                created_at,
                updated_at

            FROM work_experience

            WHERE personal_details_id = $1

            ORDER BY id DESC
        `,
        [personalId]
    );

    /* =====================================================
       EDUCATIONAL QUALIFICATIONS
    ===================================================== */
    const educationalQualifications = await pool.query(
        `
        SELECT
            eq.id,
            eq.personal_details_id,

            /* ================= EDUCATION ================= */

            eq.education AS education_id,
            edu.education_name AS education,


            /* ================= OTHER ================= */

            eq.university_institution,
            eq.branch,
            eq.cgpa_percentage,
            eq.year_of_passing,
            eq.marksheet_certificate_upload,

            eq.created_at,
            eq.updated_at,


            /* ================= EDUCATION WORK LOCATION ================= */

            edu.work_location AS education_work_location_id,

            wl.id AS education_location_id,
            wl.location AS education_work_location_name,
            wl.address AS education_work_location_address,
            wl.city AS education_work_location_city,
            wl.state AS education_work_location_state,
            wl.zip AS education_work_location_zip


        FROM educational_qualifications eq


        LEFT JOIN education edu
            ON edu.id = eq.education


        LEFT JOIN work_location wl
            ON wl.id = edu.work_location


        WHERE eq.personal_details_id = $1

        ORDER BY eq.id DESC
        `,
        [personalId]
    );

    /* =====================================================
       BANK DETAILS
    ===================================================== */
    const bankDetails = await pool.query(
        `
            SELECT *
            FROM bank_details
            WHERE personal_details_id = $1
            LIMIT 1
        `,
        [personalId]
    );

    /* =====================================================
       FORMAT EMPLOYMENT DATA
    ===================================================== */
    let employmentData = employmentDetails.rows[0] || null;

    if (employmentData) {
        employmentData = {
            ...employmentData,

            /* =================================================
               DESIGNATION
            ================================================= */
            designation:
                employmentData.designation_name ??
                employmentData.designation,

            designation_id:
                employmentData.designation_id ??
                employmentData.designation ??
                null,

            /* =================================================
               DEPARTMENT
            ================================================= */
            department:
                employmentData.department_name ??
                employmentData.department,

            department_id:
                employmentData.department_id ??
                employmentData.department ??
                null,

            /* =================================================
               SUB DEPARTMENT
            ================================================= */
            sub_department:
                employmentData.sub_department_name ??
                employmentData.sub_department,

            sub_department_id:
                employmentData.sub_department_id ??
                employmentData.sub_department ??
                null,

            /* =================================================
               CATEGORY
            ================================================= */
            category:
                employmentData.category_name ??
                employmentData.category,

            category_id:
                employmentData.category_id ??
                employmentData.category ??
                null,

            /* =================================================
               SHIFT
            ================================================= */
            shift_name:
                employmentData.shift_config_name ??
                employmentData.shift_name,

            shift_type:
                employmentData.shift_config_type ??
                employmentData.shift_type,

            shift_id:
                employmentData.shift_configuration_id ??
                employmentData.shift_name ??
                null,

            /* =================================================
               WORK LOCATION
            ================================================= */
            work_location:
                employmentData.work_location_name ??
                employmentData.work_location,

            location_id:
                employmentData.location_id ??
                employmentData.work_location ??
                null,

            /* =================================================
               BOND
            ================================================= */
            bond:
                employmentData.bond_duration ??
                employmentData.bond,

            bond_id:
                employmentData.bond_id ??
                employmentData.bond ??
                null
        };

        /* =================================================
           REMOVE HELPER FIELDS
        ================================================= */
        delete employmentData.designation_name;
        delete employmentData.department_name;
        delete employmentData.sub_department_name;
        delete employmentData.shift_config_name;
        delete employmentData.shift_config_type;
        delete employmentData.shift_configuration_id;
        delete employmentData.work_location_name;
        delete employmentData.bond_duration;
        delete employmentData.category_name;
    }

    /* =====================================================
       FINAL RESPONSE
    ===================================================== */
    return {
        personal_details: personalDetails.rows[0],
        identification_details: identificationDetails.rows,
        employment_details: employmentData,
        work_experience: workExperience.rows,
        educational_qualifications: educationalQualifications.rows,
        bank_details: bankDetails.rows[0] || null
    };
};

/* ================= GET BASIC PERSONAL DETAILS ================= */
export const getBasicPersonalDetailsModel = async ({
    status = null,
    category = null,
    access = null
} = {}) => {
    const values = [];
    let count = 1;
    let extraWhere = "";

    /* ================= STATUS FILTER ================= */
    if (status) {
        const statuses = String(status)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);

        if (statuses.length) {

            extraWhere += `
                AND LOWER(TRIM(me.status)) IN (
                    ${statuses
                    .map((_, i) => `$${count + i}`)
                    .join(",")}
                )
            `;

            values.push(
                ...statuses.map((s) =>
                    s.toLowerCase()
                )
            );

            count += statuses.length;
        }

    } else {
        extraWhere += `
            AND LOWER(TRIM(me.status))
            IN ('active', 'pending_approval')
        `;
    }

    /* ================= CATEGORY FILTER ================= */
    if (category) {

        const cat = String(category).trim();

        if (/^\d+$/.test(cat)) {
            /* Compare as text so INTEGER or VARCHAR category both work */
            extraWhere += `
                AND TRIM(ed.category::TEXT) = $${count}
            `;

            values.push(cat);

        } else {
            extraWhere += `
                AND c.category_name ILIKE $${count}
            `;

            values.push(`%${cat}%`);
        }

        count += 1;
    }

    /* ================= ACCESS FILTER ================= */
    if (
        access !== null &&
        access !== undefined &&
        String(access).trim() !== ""
    ) {
        const accessValues = String(access)
            .split(",")
            .map((value) => value.trim())
            .filter(
                (value) =>
                    value === "0" ||
                    value === "1"
            );

        if (accessValues.length) {
            extraWhere += `
                AND TRIM(COALESCE(ed.access, 0)::TEXT)
                IN (
                    ${accessValues
                    .map((_, i) => `$${count + i}`)
                    .join(",")}
                )
            `;

            values.push(
                ...accessValues
            );

            count += accessValues.length;
        }
    }

    const { rows } = await pool.query(
        `
        SELECT
            pd.id,
            pd.first_name,
            pd.middle_name,
            pd.last_name,
            pd.username,

            COALESCE(
                dep.name,
                ed.department::TEXT
            ) AS department,

            COALESCE(
                c.category_name,
                ed.category::TEXT
            ) AS category,

            COALESCE(
                ed.access,
                0
            ) AS access,

            me.status

        FROM personal_details pd

        LEFT JOIN employment_details ed
            ON ed.personal_details_id = pd.id

        LEFT JOIN department_structure dep
            ON dep.id::TEXT = TRIM(ed.department::TEXT)

        LEFT JOIN category c
            ON c.id::TEXT = TRIM(ed.category::TEXT)

        LEFT JOIN master_employee me
            ON me.personal_details_id = pd.id

        WHERE 1 = 1

        ${extraWhere}

        ORDER BY pd.id DESC
        `,
        values
    );

    return rows;
};

/* ================= GET PERSONAL DETAILS WITH PERMISSIONS ================= */
export const getPersonalDetailsPermissionsModel = async ({
    work_location = null
} = {}) => {

    const values = [];
    let count = 1;

    let query = `
        SELECT
            pd.id,
            pd.first_name,
            pd.middle_name,
            pd.last_name,
            pd.username,

            ed.department,

            ed.work_location AS work_location_id,

            wl.location AS work_location,

            COALESCE(ed.access, 0) AS access,

            me.status

        FROM personal_details pd

        LEFT JOIN employment_details ed
            ON ed.personal_details_id = pd.id

        LEFT JOIN work_location wl
            ON wl.id = ed.work_location

        LEFT JOIN master_employee me
            ON me.personal_details_id = pd.id

        WHERE LOWER(TRIM(me.status))
            IN ('active', 'pending_approval')
    `;

    /* ================= WORK LOCATION FILTER ================= */

    if (work_location) {

        query += `
            AND LOWER(TRIM(wl.location)) = LOWER(TRIM($${count}))
        `;

        values.push(String(work_location));
        count++;
    }

    query += `
        ORDER BY pd.id DESC
    `;

    const { rows } = await pool.query(
        query,
        values
    );

    return rows;
};

/* =========================================================
   GET MONTHLY BIRTHDAY & ANNIVERSARY LIST
========================================================= */
export const getMonthlyBirthdayAnniversaryModel = async ({
    month = null,
    year = null,
    work_location = []
} = {}) => {
    const currentIndiaDateParts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "numeric"
    }).formatToParts(new Date());
    const currentIndiaMonth = Number(
        currentIndiaDateParts.find(part => part.type === "month").value
    );
    const currentIndiaYear = Number(
        currentIndiaDateParts.find(part => part.type === "year").value
    );
    const numericMonth = month === null || String(month).trim() === ""
        ? currentIndiaMonth
        : Number(month);

    /* =====================================================
       VALIDATE MONTH
    ===================================================== */
    if (
        !Number.isInteger(numericMonth) ||
        numericMonth < 1 ||
        numericMonth > 12
    ) {
        throw new Error("Invalid month");
    }

    /* =====================================================
       VALIDATE YEAR
    ===================================================== */
    const numericYear = year
        ? Number(year)
        : currentIndiaYear;

    if (
        !Number.isInteger(numericYear) ||
        numericYear < 1900
    ) {
        throw new Error("Invalid year");
    }

    /* =====================================================
       NORMALIZE WORK LOCATION
    ==================================================== */
    let normalizedWorkLocations = [];

    if (Array.isArray(work_location)) {
        normalizedWorkLocations =
            work_location
                .flatMap(item =>
                    String(item)
                        .split(",")
                        .map(value => value.trim())
                )
                .filter(Boolean)
                .filter(
                    value =>
                        value.toLowerCase() !== "all" &&
                        value.toLowerCase() !== "nan"
                );
    }

    normalizedWorkLocations = [
        ...new Set(
            normalizedWorkLocations
        )
    ];

    /* =====================================================
       RESOLVE WORK LOCATION IDS
    ===================================================== */
    const workLocationIds = [];
    const workLocationNames = [];

    for (
        const value of normalizedWorkLocations
    ) {
        const numericValue = Number(value);

        if (
            Number.isInteger(numericValue) &&
            numericValue > 0
        ) {
            workLocationIds.push(
                numericValue
            );

        } else {
            workLocationNames.push(
                value.toLowerCase()
            );
        }
    }

    /* =====================================================
       FIND LOCATION IDS FROM NAMES
    ===================================================== */
    if (
        workLocationNames.length > 0
    ) {

        const locationResult =
            await pool.query(
                `
                SELECT
                    id
                FROM work_location
                WHERE LOWER(TRIM(location))
                    = ANY($1::text[])
                `,
                [
                    workLocationNames
                ]
            );

        workLocationIds.push(
            ...locationResult.rows.map(
                row => Number(row.id)
            )
        );
    }

    /* =====================================================
       UNIQUE LOCATION IDS
    ===================================================== */
    const uniqueWorkLocationIds = [
        ...new Set(
            workLocationIds.filter(
                id =>
                    Number.isInteger(id) &&
                    id > 0
            )
        )
    ];

    /* =====================================================
       CONDITIONS
    ===================================================== */
    const conditions = [
        /* ================= ACTIVE EMPLOYEE ================= */
        `
            LOWER(TRIM(me.status::TEXT)) = 'active'
        `,

        /* ================= MONTHLY CELEBRATIONS ================= */
        `
            (
                (
                    pd.date_of_birth IS NOT NULL
                    AND EXTRACT(
                        MONTH FROM pd.date_of_birth
                    ) = $1
                )

                OR

                (
                    LOWER(TRIM(COALESCE(pd.marital_status, ''))) = 'married'
                    AND pd.anniversary_date IS NOT NULL
                    AND EXTRACT(
                        MONTH FROM pd.anniversary_date
                    ) = $1
                )

            )
        `
    ];

    const queryParams = [
        numericMonth,
        numericYear
    ];

    /* =====================================================
       WORK LOCATION FILTER
    ===================================================== */
    if (
        uniqueWorkLocationIds.length > 0
    ) {
        queryParams.push(
            uniqueWorkLocationIds
        );

        conditions.push(
            `
                ed.work_location = ANY($${queryParams.length}::integer[])
            `
        );
    }

    /* =====================================================
       FINAL QUERY
    ===================================================== */
    const query = `
        SELECT
            /* =================================================
               PERSONAL DETAILS
            ================================================= */
            pd.id AS personal_details_id,
            pd.username,
            pd.first_name,
            pd.middle_name,
            pd.last_name,

            /* =================================================
               BIRTHDAY
            ================================================= */
            TO_CHAR(
                pd.date_of_birth,
                'YYYY-MM-DD'
            ) AS birthday_date,

            CASE
                WHEN pd.date_of_birth IS NOT NULL
                     AND EXTRACT(
                         MONTH FROM pd.date_of_birth
                     ) = $1
                THEN TRUE
                ELSE FALSE
            END AS is_birthday,

            /* =================================================
               AGE
            ================================================= */
            CASE
                WHEN pd.date_of_birth IS NOT NULL
                THEN
                    EXTRACT(
                        YEAR FROM AGE(
                            make_date(
                                $2::INTEGER,

                                EXTRACT(
                                    MONTH FROM pd.date_of_birth
                                )::INTEGER,

                                EXTRACT(
                                    DAY FROM pd.date_of_birth
                                )::INTEGER
                            ),

                            pd.date_of_birth
                        )
                    )::INTEGER
                ELSE NULL
            END AS age,

            /* =================================================
               EMPLOYMENT / ANNIVERSARY
            ================================================= */
            ed.employment_id,

            CASE
                WHEN LOWER(TRIM(COALESCE(pd.marital_status, ''))) = 'married'
                     AND pd.anniversary_date IS NOT NULL
                     AND EXTRACT(MONTH FROM pd.anniversary_date) = $1
                THEN TO_CHAR(pd.anniversary_date, 'YYYY-MM-DD')
                ELSE NULL
            END AS anniversary_date,

            CASE
                WHEN LOWER(TRIM(COALESCE(pd.marital_status, ''))) = 'married'
                     AND pd.anniversary_date IS NOT NULL
                     AND EXTRACT(MONTH FROM pd.anniversary_date) = $1
                THEN TRUE
                ELSE FALSE
            END AS is_anniversary,

            /* =================================================
               ANNIVERSARY YEARS
            ================================================= */
            CASE
                WHEN LOWER(TRIM(COALESCE(pd.marital_status, ''))) = 'married'
                     AND pd.anniversary_date IS NOT NULL
                     AND EXTRACT(MONTH FROM pd.anniversary_date) = $1
                THEN $2::INTEGER - EXTRACT(YEAR FROM pd.anniversary_date)::INTEGER
                ELSE NULL
            END AS anniversary_years,

            ARRAY_REMOVE(ARRAY[
                CASE
                    WHEN pd.date_of_birth IS NOT NULL
                         AND EXTRACT(MONTH FROM pd.date_of_birth) = $1
                    THEN 'Birthday'
                END,
                CASE
                    WHEN LOWER(TRIM(COALESCE(pd.marital_status, ''))) = 'married'
                         AND pd.anniversary_date IS NOT NULL
                         AND EXTRACT(MONTH FROM pd.anniversary_date) = $1
                    THEN 'Wedding Anniversary'
                END
            ], NULL) AS celebration_types,

            /* =================================================
               EMPLOYMENT DETAILS
            ================================================= */
            ed.work_email,

            ed.department AS department_id,

            ds.name AS department,

            ed.designation AS designation_id,

            des.name AS designation,

            ed.work_location AS work_location_id,

            wl.location AS work_location,

            me.status AS employee_status

        FROM personal_details pd

        INNER JOIN employment_details ed
            ON ed.personal_details_id =
               pd.id

        INNER JOIN master_employee me
            ON me.personal_details_id =
               pd.id

        LEFT JOIN department_structure ds
            ON ds.id = ed.department

        LEFT JOIN department_structure des
            ON des.id = ed.designation

        LEFT JOIN work_location wl
            ON wl.id = ed.work_location

        WHERE
            ${conditions.join("\nAND ")}

        ORDER BY

            LEAST(

                CASE
                    WHEN pd.date_of_birth IS NOT NULL
                         AND EXTRACT(
                             MONTH FROM pd.date_of_birth
                         ) = $1
                    THEN EXTRACT(
                        DAY FROM pd.date_of_birth
                    )
                    ELSE 999
                END,

                CASE
                    WHEN ed.date_of_joining IS NOT NULL
                         AND EXTRACT(
                             MONTH FROM ed.date_of_joining
                         ) = $1
                    THEN EXTRACT(
                        DAY FROM ed.date_of_joining
                    )
                    ELSE 999
                END

            ) ASC,

            LOWER(
                TRIM(pd.first_name)
            ) ASC,

            LOWER(
                TRIM(pd.last_name)
            ) ASC
    `;

    /* =====================================================
       EXECUTE QUERY
    ===================================================== */
    const result =
        await pool.query(
            query,
            queryParams
        );

    return result.rows;
};

/* ================= UPDATE ================= */
export const updatePersonalDetailsModel = async (id, data) => {

    const normalizeValue = (value) => {
        if (value === undefined || value === null) {
            return null;
        }

        if (typeof value === "string" && value.trim() === "") {
            return null;
        }

        return value;
    };

    const query = `
        UPDATE personal_details
        SET
            first_name = COALESCE($1, first_name),
            middle_name = COALESCE($2, middle_name),
            last_name = COALESCE($3, last_name),
            username = COALESCE($4, username),
            candidate_id = COALESCE($5, candidate_id),
            date_of_birth = COALESCE($6, date_of_birth),
            gender = COALESCE($7, gender),
            blood_group = COALESCE($8, blood_group),
            family_members_count = COALESCE($9, family_members_count),
            marital_status = COALESCE($10, marital_status),
            anniversary_date = COALESCE($11, anniversary_date),
            dependent_children = COALESCE($12, dependent_children),
            email_id = COALESCE($13, email_id),
            current_address = COALESCE($14, current_address),
            permanent_address = COALESCE($15, permanent_address),
            image = COALESCE($16, image),
            mobile_number = COALESCE($17, mobile_number),
            alternate_contact_number = COALESCE($18, alternate_contact_number),
            emergency_contact_name = COALESCE($19, emergency_contact_name),
            emergency_contact_number = COALESCE($20, emergency_contact_number),
            emergency_relationship = COALESCE($21, emergency_relationship),
            source = COALESCE($22, source),
            current_salary = COALESCE($23, current_salary),
            expected_salary = COALESCE($24, expected_salary),
            linkedin_profile_link = COALESCE($25, linkedin_profile_link),
            resume = COALESCE($26, resume),

            updated_at = TIMEZONE(
                'Asia/Kolkata',
                CURRENT_TIMESTAMP
            )

        WHERE id = $27
        RETURNING *;
    `;

    const values = [
        normalizeValue(data.first_name),
        normalizeValue(data.middle_name),
        normalizeValue(data.last_name),
        normalizeValue(data.username),
        normalizeValue(data.candidate_id),
        normalizeValue(data.date_of_birth),
        normalizeValue(data.gender),
        normalizeValue(data.blood_group),
        normalizeValue(data.family_members_count),
        normalizeValue(data.marital_status),
        normalizeValue(data.anniversary_date),
        normalizeValue(data.dependent_children),
        normalizeValue(data.email_id),
        normalizeValue(data.current_address),
        normalizeValue(data.permanent_address),
        normalizeValue(data.image),
        normalizeValue(data.mobile_number),
        normalizeValue(data.alternate_contact_number),
        normalizeValue(data.emergency_contact_name),
        normalizeValue(data.emergency_contact_number),
        normalizeValue(data.emergency_relationship),
        normalizeValue(data.source),
        normalizeValue(data.current_salary),
        normalizeValue(data.expected_salary),
        normalizeValue(data.linkedin_profile_link),
        normalizeValue(data.resume),
        id
    ];

    const { rows } = await pool.query(query, values);

    return rows[0];
};
