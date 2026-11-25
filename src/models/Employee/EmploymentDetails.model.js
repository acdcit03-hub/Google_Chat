import { pool } from "../../database.js";

/* ================= CREATE TABLE ================= */
export const initializeEmploymentDetailsTable = async () => {
    const query = `
        CREATE TABLE IF NOT EXISTS employment_details (
            id SERIAL PRIMARY KEY,
            personal_details_id INTEGER NOT NULL,
            employment_id VARCHAR(100),
            shift_id INTEGER,
            rfid VARCHAR(100),
            designation VARCHAR(255),
            department VARCHAR(255),
            sub_department VARCHAR(255),
            category INTEGER,
            date_of_joining DATE,
            work_email VARCHAR(255),
            company_mobile_number VARCHAR(20),
            employment_type VARCHAR(100),
            internship_start_time TIME,
            internship_end_time TIME,
            internship_duration VARCHAR(100),
            noc_letter TEXT,
            offer_letter TEXT,
            work_location INTEGER,
            reporting_manager VARCHAR(255),
            probation_period VARCHAR(100),
            notice_period VARCHAR(100),
            bond INTEGER,
            has_experience BOOLEAN DEFAULT FALSE,
            show_in_attendance BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT TIMEZONE('Asia/Kolkata',CURRENT_TIMESTAMP),
            updated_at TIMESTAMP DEFAULT TIMEZONE('Asia/Kolkata',CURRENT_TIMESTAMP)
        )
    `;

    await pool.query(query);

    await pool.query(`
        DO $$
        BEGIN
            /* Rename internship_start_time */
            IF EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'employment_details'
                  AND column_name = 'internship_start_time'
            )
            AND NOT EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'employment_details'
                  AND column_name = 'internship_start_date'
            ) THEN
                ALTER TABLE employment_details
                RENAME COLUMN internship_start_time
                TO internship_start_date;
            END IF;
    
            /* Rename internship_end_time */
            IF EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'employment_details'
                  AND column_name = 'internship_end_time'
            )
            AND NOT EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'employment_details'
                  AND column_name = 'internship_end_date'
            ) THEN
                ALTER TABLE employment_details
                RENAME COLUMN internship_end_time
                TO internship_end_date;
            END IF;
        END
        $$;
    `);

    await pool.query(`
        ALTER TABLE employment_details
        ADD COLUMN IF NOT EXISTS username VARCHAR(50),
        ADD COLUMN IF NOT EXISTS password VARCHAR(255),
        ADD COLUMN IF NOT EXISTS access SMALLINT DEFAULT 0 CHECK (access IN (0,1)),
        ADD COLUMN IF NOT EXISTS show_in_attendance BOOLEAN DEFAULT false,
        ADD COLUMN IF NOT EXISTS internship_start_date DATE,
        ADD COLUMN IF NOT EXISTS internship_end_date DATE,
        ADD COLUMN IF NOT EXISTS internship_duration VARCHAR(100),
        ADD COLUMN IF NOT EXISTS noc_letter TEXT,
        ADD COLUMN IF NOT EXISTS offer_letter TEXT,
        ADD COLUMN IF NOT EXISTS company_mobile_number VARCHAR(20),
        ADD COLUMN IF NOT EXISTS shift_id INTEGER;
    `);

    await pool.query(`
        ALTER TABLE employment_details
        ALTER COLUMN internship_start_date TYPE DATE
            USING NULL::DATE,
        ALTER COLUMN internship_end_date TYPE DATE
            USING NULL::DATE;
    `);

    /* ================= FIX WORK LOCATION ================= */
    await pool.query(`
        UPDATE employment_details ed
        SET work_location = wl.id
        FROM work_location wl
        WHERE LOWER(TRIM(ed.work_location::TEXT))
              = LOWER(TRIM(wl.location))
          AND ed.work_location IS NOT NULL;
    `);

    /* ================= FIX BOND ================= */
    await pool.query(`
        UPDATE employment_details ed
        SET bond = bo.id
        FROM bond_options bo
        WHERE LOWER(TRIM(ed.bond::TEXT))
              = LOWER(TRIM(bo.bond_duration))
          AND ed.bond IS NOT NULL;
    `);

    /* ================= FIX CATEGORY ================= */
    await pool.query(`
        UPDATE employment_details ed
        SET category = c.id
        FROM category c
        WHERE LOWER(TRIM(ed.category::TEXT))
              = LOWER(TRIM(c.category_name))
          AND ed.category IS NOT NULL;
    `);

    /* ================= FIX DEPARTMENT ================= */
    await pool.query(`
        UPDATE employment_details ed
        SET department = ds.id
        FROM department_structure ds
        WHERE LOWER(TRIM(ed.department::TEXT))
              = LOWER(TRIM(ds.name))
          AND ed.department IS NOT NULL;
    `);

    /* ================= FIX DESIGNATION ================= */
    await pool.query(`
        UPDATE employment_details ed
        SET designation = ds.id
        FROM department_structure ds
        WHERE LOWER(TRIM(ed.designation::TEXT))
              = LOWER(TRIM(ds.name))
          AND ed.designation IS NOT NULL;
    `);

    /* ================= FIX SUB DEPARTMENT ================= */
    await pool.query(`
        UPDATE employment_details ed
        SET sub_department = ds.id
        FROM department_structure ds
        WHERE LOWER(TRIM(ed.sub_department::TEXT))
              = LOWER(TRIM(ds.name))
          AND ed.sub_department IS NOT NULL;
    `);

    await pool.query(`
        DO $$
        BEGIN
            /* ================= WORK LOCATION ================= */
            IF EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'employment_details'
                  AND column_name = 'work_location'
                  AND data_type = 'character varying'
            ) THEN

                ALTER TABLE employment_details
                ALTER COLUMN work_location TYPE INTEGER
                USING (
                    CASE
                        WHEN TRIM(work_location) ~ '^[0-9]+$'
                        THEN TRIM(work_location)::INTEGER
                        ELSE NULL
                    END
                );

            END IF;

            /* ================= BOND ================= */
            IF EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'employment_details'
                  AND column_name = 'bond'
                  AND data_type = 'character varying'
            ) THEN

                ALTER TABLE employment_details
                ALTER COLUMN bond TYPE INTEGER
                USING (
                    CASE
                        WHEN TRIM(bond) ~ '^[0-9]+$'
                        THEN TRIM(bond)::INTEGER
                        ELSE NULL
                    END
                );

            END IF;

            /* ================= CATEGORY ================= */
            IF EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'employment_details'
                  AND column_name = 'category'
                  AND data_type = 'character varying'
            ) THEN
        
                ALTER TABLE employment_details
                ALTER COLUMN category TYPE INTEGER
                USING (
                    CASE
                        WHEN TRIM(category) ~ '^[0-9]+$'
                        THEN TRIM(category)::INTEGER
                        ELSE NULL
                    END
                );
        
            END IF;

            /* ================= DESIGNATION TYPE ================= */
            IF EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'employment_details'
                  AND column_name = 'designation'
                  AND data_type = 'character varying'
            ) THEN

                ALTER TABLE employment_details
                ALTER COLUMN designation TYPE INTEGER
                USING (
                    CASE
                        WHEN TRIM(designation) ~ '^[0-9]+$'
                        THEN TRIM(designation)::INTEGER
                        ELSE NULL
                    END
                );

            END IF;


            /* ================= DEPARTMENT TYPE ================= */
            IF EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'employment_details'
                  AND column_name = 'department'
                  AND data_type = 'character varying'
            ) THEN
                
                ALTER TABLE employment_details
                ALTER COLUMN department TYPE INTEGER
                USING (
                    CASE
                        WHEN TRIM(department) ~ '^[0-9]+$'
                        THEN TRIM(department)::INTEGER
                        ELSE NULL
                    END
                );
                
            END IF;
            
            
            /* ================= SUB_DEPARTMENT TYPE ================= */
            IF EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'employment_details'
                  AND column_name = 'sub_department'
                  AND data_type = 'character varying'
            ) THEN
                
                ALTER TABLE employment_details
                ALTER COLUMN sub_department TYPE INTEGER
                USING (
                    CASE
                        WHEN TRIM(sub_department) ~ '^[0-9]+$'
                        THEN TRIM(sub_department)::INTEGER
                        ELSE NULL
                    END
                );
                
            END IF;

        END
        $$;
    `);

    await pool.query(`
        ALTER TABLE employment_details
        DROP COLUMN IF EXISTS shift_name,
        DROP COLUMN IF EXISTS shift_type,
        DROP COLUMN IF EXISTS working_start_time,
        DROP COLUMN IF EXISTS working_end_time;
    `);

    await pool.query(`
        SELECT setval(
            pg_get_serial_sequence('employment_details', 'id'),
            COALESCE((SELECT MAX(id) FROM employment_details), 1),
            true
        );
    `);

    console.log("✅ employment_details table ready");
};

/* =========================================================
   INTEGER HELPER
========================================================= */
const toNullableInteger = (value) => {
    if (
        value === null ||
        value === undefined ||
        String(value).trim() === ""
    ) {
        return null;
    }

    const number = Number(value);

    if (!Number.isInteger(number)) {
        return null;
    }

    return number;
};

/* =========================================================
   ADD
========================================================= */
export const addEmploymentDetailsModel = async ({
    personal_details_id,
    employment_id = null,
    shift_id = null,
    username = null,
    password = null,
    access = 0,
    rfid = null,
    designation = null,
    department = null,
    sub_department = null,
    category = null,
    date_of_joining = null,
    work_email = null,
    company_mobile_number = null,
    employment_type = null,
    internship_start_date = null,
    internship_end_date = null,
    internship_duration = null,
    noc_letter = null,
    offer_letter = null,
    work_location = null,
    reporting_manager = null,
    probation_period = null,
    notice_period = null,
    bond = null,
    has_experience = false,
    show_in_attendance = true
}) => {

    /* ================= CHECK EXISTING ================= */

    const existingQuery = `
        SELECT id
        FROM employment_details
        WHERE personal_details_id = $1
        LIMIT 1
    `;

    const existingResult = await pool.query(
        existingQuery,
        [personal_details_id]
    );

    if (existingResult.rows.length > 0) {
        return {
            alreadyExists: true,
            data: existingResult.rows[0]
        };
    }

    /* ================= GET USERNAME ================= */

    if (!username) {
        const usernameResult = await pool.query(
            `
            SELECT username
            FROM personal_details
            WHERE id = $1
            LIMIT 1
            `,
            [personal_details_id]
        );

        username = usernameResult.rows[0]?.username || null;
    }

    /* ================= INSERT ================= */

    const query = `
        INSERT INTO employment_details (
            personal_details_id,
            employment_id,
            shift_id,
            username,
            password,
            access,
            rfid,
            designation,
            department,
            sub_department,
            category,
            date_of_joining,
            work_email,
            company_mobile_number,
            employment_type,
            internship_start_date,
            internship_end_date,
            internship_duration,
            noc_letter,
            offer_letter,
            work_location,
            reporting_manager,
            probation_period,
            notice_period,
            bond,
            has_experience,
            show_in_attendance
        )
        VALUES (
            $1,
            $2,
            $3::INTEGER,
            $4,
            $5,
            $6::SMALLINT,
            $7,
            $8::INTEGER,
            $9::INTEGER,
            $10::INTEGER,
            $11::INTEGER,
            $12::DATE,
            $13,
            $14,
            $15,
            $16::DATE,
            $17::DATE,
            $18,
            $19,
            $20,
            $21::INTEGER,
            $22,
            $23,
            $24,
            $25::INTEGER,
            $26::BOOLEAN,
            $27::BOOLEAN
        )
        RETURNING *;
    `;

    const values = [
        personal_details_id,
        employment_id,
        toNullableInteger(shift_id),
        username,
        password,
        access,
        rfid,
        toNullableInteger(designation),
        toNullableInteger(department),
        toNullableInteger(sub_department),
        toNullableInteger(category),
        date_of_joining,
        work_email,
        company_mobile_number,
        employment_type,
        internship_start_date,
        internship_end_date,
        internship_duration,
        noc_letter,
        offer_letter,
        work_location,
        reporting_manager,
        probation_period,
        notice_period,
        bond,
        has_experience,
        show_in_attendance
    ];

    const result = await pool.query(query, values);

    return {
        alreadyExists: false,
        data: result.rows[0]
    };
};

/* =========================================================
   GET ALL
========================================================= */
export const getAllEmploymentDetailsModel = async () => {
    const { rows } = await pool.query(`
        SELECT
            ed.*,

            /* ================= SHIFT ================= */
            ed.shift_id,
            epc.working_start_time,
            epc.working_end_time,
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

            /* ================= WORK LOCATION ================= */
            wl.id AS location_id,
            wl.location AS work_location_name,

            /* ================= CATEGORY ================= */
            c.id AS category_id,
            c.category_name,

            /* ================= DESIGNATION ================= */
            ds.id AS designation_id,
            ds.name AS designation_name,

            /* ================= DEPARTMENT ================= */
            dep.id AS department_id,
            dep.name AS department_name,

            /* ================= SUB DEPARTMENT ================= */
            subdep.id AS sub_department_id,
            subdep.name AS sub_department_name

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

        /* ================= SHIFT ================= */
        LEFT JOIN shift_configurations sc
            ON sc.id = ed.shift_id

        /* ================= WORK LOCATION ================= */
        LEFT JOIN work_location wl
            ON wl.id = ed.work_location

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

        ORDER BY ed.id DESC
    `);

    return rows.map(row => ({
        ...row,

        /* ================= SHIFT ================= */
        shift_name:
            row.shift_config_name,

        shift_type:
            row.shift_config_type,

        /* ================= WORK LOCATION ================= */
        work_location:
            row.work_location_name ??
            row.work_location,

        /* ================= CATEGORY ================= */
        category:
            row.category_name ??
            row.category,

        /* ================= DESIGNATION ================= */
        designation:
            row.designation_name ??
            row.designation,

        /* ================= DEPARTMENT ================= */
        department:
            row.department_name ??
            row.department,

        /* ================= SUB DEPARTMENT ================= */
        sub_department:
            row.sub_department_name ??
            row.sub_department
    }));
};

/* =========================================================
   GET SHIFT CONFIGURATION ID
========================================================= */
export const getShiftConfigurationId = async (
    shiftName,
    shiftType
) => {

    /* ================= CLEAN VALUE ================= */
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

    const cleanShiftName = cleanValue(shiftName);
    const cleanShiftType = cleanValue(shiftType);

    /* ================= VALIDATION ================= */
    if (!cleanShiftName || !cleanShiftType) {
        return null;
    }

    /* =====================================================
       FIND SHIFT CONFIGURATION

       Supports:

       shift_name = "ACDC TECH"
       shift_type = "General"

       OR

       shift_name = 2
       shift_type = 2
    ===================================================== */

    const { rows } = await pool.query(
        `
        SELECT id
        FROM shift_configurations
        WHERE
            (
                id::TEXT = $1
                OR LOWER(TRIM(shift_name))
                    = LOWER(TRIM($1))
            )
            AND
            (
                id::TEXT = $2
                OR LOWER(TRIM(shift_type))
                    = LOWER(TRIM($2))
            )
        LIMIT 1
        `,
        [
            cleanShiftName,
            cleanShiftType
        ]
    );

    return rows[0]?.id || null;
};

/* =========================================================
   GET WORK LOCATION ID
========================================================= */
export const getWorkLocationId = async (work_location) => {
    if (
        work_location === null ||
        work_location === undefined ||
        String(work_location).trim() === ""
    ) {
        return null;
    }

    const value = String(work_location).trim();

    /* Already ID */

    if (/^\d+$/.test(value)) {

        const { rows } = await pool.query(
            `
            SELECT id
            FROM work_location
            WHERE id = $1
            LIMIT 1
            `,
            [Number(value)]
        );

        return rows[0]?.id || null;
    }

    /* Location name */

    const { rows } = await pool.query(
        `
        SELECT id
        FROM work_location
        WHERE LOWER(TRIM(location))
              = LOWER(TRIM($1))
        LIMIT 1
        `,
        [value]
    );

    return rows[0]?.id || null;
};

/* =========================================================
   GET BOND ID
========================================================= */
export const getBondId = async (bond) => {
    if (
        bond === null ||
        bond === undefined ||
        String(bond).trim() === ""
    ) {
        return null;
    }

    const value =
        String(bond).trim();

    /* Already ID */

    if (/^\d+$/.test(value)) {

        const { rows } = await pool.query(
            `
            SELECT id
            FROM bond_options
            WHERE id = $1
            LIMIT 1
            `,
            [Number(value)]
        );

        return rows[0]?.id || null;
    }

    /* Bond name */

    const { rows } = await pool.query(
        `
        SELECT id
        FROM bond_options
        WHERE LOWER(TRIM(bond_duration))
              = LOWER(TRIM($1))
        LIMIT 1
        `,
        [value]
    );

    return rows[0]?.id || null;
};

/* =========================================================
   GET CATEGORY ID
   CATEGORY NAME + WORK LOCATION
========================================================= */
export const getCategoryId = async (
    category,
    workLocation
) => {

    if (
        category === null ||
        category === undefined ||
        String(category).trim() === ""
    ) {
        return null;
    }

    const categoryValue =
        String(category).trim();

    /* =====================================================
       RESOLVE WORK LOCATION ID
    ===================================================== */
    const workLocationId =
        await getWorkLocationId(workLocation);

    if (
        workLocation !== null &&
        workLocation !== undefined &&
        String(workLocation).trim() !== "" &&
        !workLocationId
    ) {
        throw new Error(
            `Work location not found: "${workLocation}"`
        );
    }

    /* =====================================================
       CATEGORY ID
       If numeric ID is passed, validate it belongs to
       the selected work location.
    ===================================================== */
    if (/^\d+$/.test(categoryValue)) {

        const { rows } = await pool.query(
            `
            SELECT id
            FROM category
            WHERE id = $1
              AND (
                    work_location = $2
                    OR (
                        work_location IS NULL
                        AND $2 IS NULL
                    )
              )
            LIMIT 1
            `,
            [
                Number(categoryValue),
                workLocationId
            ]
        );

        return rows[0]?.id || null;
    }

    /* =====================================================
       CATEGORY NAME + WORK LOCATION
    ===================================================== */
    const { rows } = await pool.query(
        `
        SELECT id
        FROM category
        WHERE
            LOWER(TRIM(category_name))
                = LOWER(TRIM($1))
            AND
            (
                work_location = $2
                OR (
                    work_location IS NULL
                    AND $2 IS NULL
                )
            )
        LIMIT 1
        `,
        [
            categoryValue,
            workLocationId
        ]
    );

    return rows[0]?.id || null;
};


/* =========================================================
   GET BY ID
========================================================= */
export const getEmploymentDetailsByIdModel = async (id) => {
    const { rows } = await pool.query(
        `
        SELECT
            ed.id,
            ed.personal_details_id,
            ed.employment_id,
            ed.rfid,

            /* ================= DESIGNATION ================= */
            ed.designation,
            ds.name AS designation_name,

            /* ================= DEPARTMENT ================= */
            ed.department,
            dep.name AS department_name,

            /* ================= SUB DEPARTMENT ================= */
            ed.sub_department,
            subdep.name AS sub_department_name,

            /* ================= CATEGORY ================= */
            ed.category,
            c.category_name,

            /* ================= BASIC ================= */
            ed.date_of_joining,
            ed.work_email,
            ed.company_mobile_number,
            ed.employment_type,

            /* ================= INTERNSHIP ================= */
            ed.internship_start_date,
            ed.internship_end_date,
            ed.internship_duration,
            ed.noc_letter,
            ed.offer_letter,

            /* ================= SHIFT ================= */
            ed.shift_id,
            epc.working_start_time,
            epc.working_end_time,
            sc.shift_name,
            sc.shift_type,
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

            /* ================= LOCATION ================= */
            ed.work_location,
            wl.location AS work_location_name,

            /* ================= OTHER ================= */
            ed.reporting_manager,
            ed.probation_period,
            ed.notice_period,
            ed.bond,
            ed.has_experience,
            ed.show_in_attendance,
            ed.created_at,
            ed.updated_at,
            ed.username,
            ed.password,
            ed.access

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

        LEFT JOIN shift_configurations sc
            ON sc.id = ed.shift_id

        LEFT JOIN work_location wl
            ON wl.id = ed.work_location

        LEFT JOIN category c
            ON c.id = ed.category

        LEFT JOIN department_structure ds
            ON ds.id = ed.designation

        LEFT JOIN department_structure dep
            ON dep.id = ed.department

        LEFT JOIN department_structure subdep
            ON subdep.id = ed.sub_department

        WHERE ed.id = $1

        LIMIT 1
        `,
        [Number(id)]
    );

    return rows[0] || null;
};

/* =========================================================
   GENERATE EMPLOYMENT ID
========================================================= */
export const generateEmploymentId = async (
    workLocation,
    joiningDate,
    category
) => {

    if (
        !workLocation ||
        !joiningDate
    ) {
        throw new Error(
            "Work location and joining date are required"
        );
    }

    const workLocationId = await getWorkLocationId(workLocation);

    if (!workLocationId) {
        throw new Error(
            `Work location not found: ${workLocation}`
        );
    }

    const {
        rows: locationRows
    } = await pool.query(
        `
            SELECT
                id,
                location
            FROM work_location
            WHERE id = $1
            LIMIT 1
        `,
        [workLocationId]
    );

    if (!locationRows.length) {
        throw new Error(
            `Work location not found: ${workLocationId}`
        );
    }

    const locationName = locationRows[0].location;

    /* =====================================================
       LOCATION CODE
    ===================================================== */
    const locationCode =
        String(locationName)
            .trim()
            .replace(/\s+/g, "")
            .charAt(0)
            .toUpperCase();

    if (!locationCode) {
        throw new Error(
            "Invalid work location name"
        );
    }

    /* =====================================================
       CATEGORY
    ===================================================== */
    let categoryName = "";

    if (category) {

        const {
            rows: categoryRows
        } = await pool.query(
            `
                SELECT
                    category_name
                FROM category
                WHERE id = $1
                LIMIT 1
            `,
            [category]
        );

        categoryName = categoryRows[0]?.category_name || "";
    }

    /* =====================================================
       PREFIX
    ===================================================== */
    const categoryPrefix =
        categoryName
            .trim()
            .replace(/\s+/g, "")
            .substring(0, 2)
            .toUpperCase();

    if (!categoryPrefix) {
        throw new Error(
            `Invalid category name: ${categoryName}`
        );
    }

    const prefix = `${categoryPrefix}${locationCode}`;

    /* =====================================================
       JOINING DATE
    ===================================================== */
    const date = new Date(joiningDate);

    if (Number.isNaN(date.getTime())) {
        throw new Error(
            `Invalid joining date: ${joiningDate}`
        );
    }

    const month =
        String(date.getMonth() + 1)
            .padStart(2, "0");

    const year =
        String(date.getFullYear())
            .slice(-2);

    /* =====================================================
       FIND LAST SERIAL
    ===================================================== */
    const {
        rows
    } = await pool.query(
        `
            SELECT
                employment_id
            FROM employment_details
            WHERE employment_id LIKE $1
            ORDER BY
                CAST(
                    SUBSTRING(
                        employment_id
                        FROM LENGTH($2) + 1
                        FOR 3
                    ) AS INTEGER
                ) DESC
            LIMIT 1
        `,
        [
            `${prefix}%`,
            prefix
        ]
    );

    let serial = 1;

    if (rows.length) {
        const lastEmploymentId =
            String(
                rows[0].employment_id
            );

        const serialPart =
            lastEmploymentId.substring(
                prefix.length,
                prefix.length + 3
            );

        const lastSerial = Number(serialPart);

        if (
            Number.isInteger(lastSerial) &&
            lastSerial >= 1
        ) {
            serial = lastSerial + 1;
        }
    }

    /* =====================================================
       FINAL EMPLOYMENT ID
    ===================================================== */
    return (
        `${prefix}` +
        `${String(serial).padStart(3, "0")}` +
        `${month}${year}`
    );
};

/* =========================================================
   UPDATE EMPLOYMENT ID
========================================================= */
export const updateEmploymentId = async (
    existingEmployeeId,
    workLocation,
    joiningDate,
    category
) => {

    if (!existingEmployeeId) {
        return generateEmploymentId(
            workLocation,
            joiningDate,
            category
        );
    }

    const workLocationId = await getWorkLocationId(workLocation);

    const { rows } =
        await pool.query(
            `
            SELECT location
            FROM work_location
            WHERE id = $1
            LIMIT 1
            `,
            [workLocationId]
        );

    const locationName =
        rows[0]?.location || "";

    const locationCode =
        locationName
            .trim()
            .replace(/\s+/g, "")
            .charAt(0)
            .toUpperCase();

    let categoryName = "";

    const categoryId = await getCategoryId(category);

    if (categoryId) {
        const { rows: categoryRows } =
            await pool.query(
                `
                SELECT category_name
                FROM category
                WHERE id = $1
                LIMIT 1
                `,
                [categoryId]
            );

        categoryName =
            categoryRows[0]?.category_name || "";
    }

    const prefix =
        categoryName.toLowerCase() === "intern"
            ? `IN${locationCode}`
            : `EM${locationCode}`;

    const serial =
        String(existingEmployeeId)
            .match(/\d{3}/)?.[0] || "001";

    const date =
        new Date(joiningDate);

    const month =
        String(date.getMonth() + 1)
            .padStart(2, "0");

    const year =
        String(date.getFullYear())
            .slice(-2);

    return `${prefix}${serial}${month}${year}`;
};


/* =========================================================
   GET SHIFT TIME
========================================================= */
export const getShiftByNameAndTypeModel = async (
    shift_name,
    shift_type
) => {

    const { rows } = await pool.query(
        `
        SELECT
            start_time,
            end_time
        FROM shift_configurations
        WHERE id = $1
        LIMIT 1
        `,
        [Number(shift_name)]
    );

    return rows[0] || null;
};

/* ================= UPDATE EMPLOYMENT DETSILA ================= */
export const updateEmploymentDetailsModel = async (
    id,
    data
) => {
    const query = `
        UPDATE employment_details
        SET
            employment_id = $1,
            rfid = $2,
            username = $3,
            password = $4,
            access = $5::SMALLINT,
            designation = $6::INTEGER,
            department = $7::INTEGER,
            sub_department = $8::INTEGER,
            category = $9::INTEGER,
            date_of_joining = $10::DATE,
            work_email = $11,
            company_mobile_number = $12,
            employment_type = $13,
            internship_start_date = $14::DATE,
            internship_end_date = $15::DATE,
            internship_duration = $16,
            noc_letter = $17,
            offer_letter = $18,
            work_location = $19::INTEGER,
            reporting_manager = $20,
            probation_period = $21,
            notice_period = $22,
            bond = $23::INTEGER,
            has_experience = $24::BOOLEAN,
            show_in_attendance = $25::BOOLEAN,
            shift_id = $26::INTEGER,
            updated_at =
                TIMEZONE(
                    'Asia/Kolkata',
                    CURRENT_TIMESTAMP
                )

        WHERE id = $27

        RETURNING *;
    `;

    const values = [
        data.employment_id ?? null,
        data.rfid ?? null,
        data.username ?? null,
        data.password ?? null,
        toNullableInteger(data.access),
        toNullableInteger(data.designation),
        toNullableInteger(data.department),
        toNullableInteger(data.sub_department),
        toNullableInteger(data.category),
        data.date_of_joining ?? null,
        data.work_email ?? null,
        data.company_mobile_number ?? null,
        data.employment_type ?? null,
        data.internship_start_date ?? null,
        data.internship_end_date ?? null,
        data.internship_duration ?? null,
        data.noc_letter ?? null,
        data.offer_letter ?? null,
        toNullableInteger(data.work_location),
        data.reporting_manager ?? null,
        data.probation_period ?? null,
        data.notice_period ?? null,
        toNullableInteger(data.bond),

        data.has_experience === undefined ||
            data.has_experience === null
            ? null
            : (
                data.has_experience === true ||
                data.has_experience === "true"
            ),

        data.show_in_attendance === undefined ||
            data.show_in_attendance === null
            ? null
            : (
                data.show_in_attendance === true ||
                data.show_in_attendance === "true" ||
                data.show_in_attendance === 1 ||
                data.show_in_attendance === "1"
            ),

        toNullableInteger(data.shift_id),
        toNullableInteger(id)
    ];

    const { rows } = await pool.query(
        query,
        values
    );

    return rows[0] || null;
};


/* =========================================================
   RFID
========================================================= */
export const getUsernameByRFID = async (rfid) => {
    const { rows } = await pool.query(
        `
        SELECT
            ed.rfid,
            pd.username
        FROM employment_details ed

        INNER JOIN personal_details pd
            ON pd.id = ed.personal_details_id

        WHERE TRIM(ed.rfid)
              = TRIM($1)

        LIMIT 1
        `,
        [rfid]
    );

    return rows[0]?.username || "Unregistered";
};


/* =========================================================
   GET EMPLOYEE BY RFID
========================================================= */
export const getEmployeeByRFID = async (rfid) => {

    const { rows } = await pool.query(
        `
        SELECT
            ed.employment_id,
            ed.rfid,
            pd.username
        FROM employment_details ed

        INNER JOIN personal_details pd
            ON pd.id = ed.personal_details_id

        WHERE TRIM(ed.rfid)
              = TRIM($1)

        LIMIT 1
        `,
        [rfid]
    );

    return rows[0] || null;
};


/* =========================================================
   GET EMPLOYEE BY USERNAME
========================================================= */
export const getEmployeeByUsername = async (username) => {

    const { rows } = await pool.query(
        `
        SELECT
            ed.id,
            ed.employment_id,
            ed.rfid,

            pd.username,
            pd.first_name,
            pd.middle_name,
            pd.last_name

        FROM employment_details ed

        INNER JOIN personal_details pd
            ON pd.id = ed.personal_details_id

        WHERE LOWER(TRIM(pd.username))
              = LOWER(TRIM($1))

        LIMIT 1
        `,
        [username]
    );

    return rows[0] || null;
};

export const findWorkEmailByUsername = async (username) => {
    const result = await pool.query(
        `
        SELECT NULLIF(TRIM(ed.work_email), '') AS work_email
        FROM employment_details ed
        LEFT JOIN personal_details pd
            ON pd.id = ed.personal_details_id
        WHERE LOWER(TRIM(COALESCE(ed.username, pd.username, '')))
            = LOWER(TRIM($1))
        ORDER BY
            CASE
                WHEN NULLIF(TRIM(ed.work_email), '') IS NULL THEN 1
                ELSE 0
            END,
        ed.updated_at DESC NULLS LAST
        LIMIT 1
        `,
        [username]
    );
    return result.rows[0]?.work_email || "";
};