import { pool } from "../../database.js";
import { decryptPayrollFields } from "../../utils/payrollEncryption.js";

/* ================= CREATE TABLE ================= */
export const initializeCategoryTable = async () => {
    const query = `
        CREATE TABLE IF NOT EXISTS category (
            id SERIAL PRIMARY KEY,
            category_name VARCHAR(255) NOT NULL,
            work_location INTEGER,
            username VARCHAR(255),
            is_active BOOLEAN DEFAULT TRUE,
            required_fields JSONB DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `;

    await pool.query(query);

    await pool.query(`
        ALTER TABLE category
        ADD COLUMN IF NOT EXISTS work_location INTEGER;

        ALTER TABLE category
        ADD COLUMN IF NOT EXISTS username VARCHAR(255);

        ALTER TABLE category
        ADD COLUMN IF NOT EXISTS category_image TEXT;

        ALTER TABLE category
        ADD COLUMN IF NOT EXISTS required_fields JSONB
        DEFAULT '{}'::jsonb;
    `);

    await pool.query(`
        UPDATE category c
        SET work_location = wl.id
        FROM work_location wl
        WHERE
            c.work_location IS NOT NULL
            AND TRIM(c.work_location::TEXT) <> ''
            AND LOWER(TRIM(c.work_location::TEXT))
                = LOWER(TRIM(wl.location));
    `);

    await pool.query(`
        DO $$
        BEGIN

            IF EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'category'
                  AND column_name = 'work_location'
                  AND data_type = 'character varying'
            ) THEN

                ALTER TABLE category
                ALTER COLUMN work_location TYPE INTEGER
                USING (
                    CASE
                        WHEN TRIM(work_location) ~ '^[0-9]+$'
                        THEN TRIM(work_location)::INTEGER
                        ELSE NULL
                    END
                );

            END IF;

        END
        $$;
    `);

    await pool.query(`
        SELECT setval(
            pg_get_serial_sequence('category', 'id'),
            COALESCE((SELECT MAX(id) FROM category), 1),
            true
        );
    `);

    console.log("✅ category table ready");
};

/* ================= CREATE CATEGORY ================= */
export const createCategoryModel = async ({
    category_name,
    category_image,
    work_location,
    username,       
    required_fields = {}
}) => {

    const workLocationId =
        await getWorkLocationId(work_location);

    if (
        work_location !== null &&
        work_location !== undefined &&
        work_location !== "" &&
        !workLocationId
    ) {
        throw new Error(
            `Work location not found: "${work_location}"`
        );
    }

    let requiredFieldsValue = {};

    if (
        typeof required_fields === "string" &&
        required_fields.trim() !== ""
    ) {
        try {
            requiredFieldsValue =
                JSON.parse(required_fields);
        } catch (error) {
            throw new Error(
                "Invalid required_fields JSON format."
            );
        }
    } else if (
        required_fields !== null &&
        typeof required_fields === "object"
    ) {
        requiredFieldsValue = required_fields;
    }

    const { rows } = await pool.query(
        `
        INSERT INTO category (
            category_name,
            category_image,
            work_location,
            username,
            required_fields
        )
        VALUES (
            $1,
            $2,
            $3,
            $4,
            $5::jsonb
        )
        RETURNING *;
        `,
        [
            category_name?.trim(),

            category_image
                ? String(category_image).trim()
                : null,

            workLocationId,

            username
                ? String(username).trim()
                : null,

            JSON.stringify(requiredFieldsValue)
        ]
    );

    return rows[0];
};

/* ================= GET ALL ================= */
export const getAllCategoryModel = async (work_location) => {

    let query = `
        SELECT
            c.id,
            c.category_name,
            c.category_image,
            c.work_location AS work_location_id,
            wl.location AS work_location,
            c.username,
            c.is_active,
            c.required_fields,
            c.created_at,
            c.updated_at
        FROM category c

        LEFT JOIN work_location wl
            ON wl.id = c.work_location

        WHERE 1 = 1
    `;

    const values = [];

    if (
        work_location !== undefined &&
        work_location !== null &&
        String(work_location).trim() !== ""
    ) {

        const workLocationId =
            await getWorkLocationId(work_location);

        if (!workLocationId) {
            return [];
        }

        values.push(Number(workLocationId));

        query += `
            AND c.work_location = $${values.length}
        `;
    }

    query += `
        ORDER BY c.id DESC
    `;

    const { rows } = await pool.query(
        query,
        values
    );

    return rows;
};

/* =========================================================
   CHECK DUPLICATE CATEGORY
   SAME CATEGORY NAME + SAME WORK LOCATION
========================================================= */
export const checkDuplicateCategory = async ({
    category_name,
    work_location,
    excludeId = null
}) => {

    if (
        category_name === undefined ||
        category_name === null ||
        String(category_name).trim() === ""
    ) {
        return null;
    }

    const cleanCategoryName =
        String(category_name).trim();

    const workLocationId =
        await getWorkLocationId(work_location);

    if (
        work_location !== null &&
        work_location !== undefined &&
        String(work_location).trim() !== "" &&
        !workLocationId
    ) {
        throw new Error(
            `Work location not found: "${work_location}"`
        );
    }

    let query = `
        SELECT
            id,
            category_name,
            work_location
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
    `;

    const values = [
        cleanCategoryName,
        workLocationId
    ];

    /* ================= EXCLUDE CURRENT CATEGORY ================= */

    if (excludeId !== null && excludeId !== undefined) {
        values.push(excludeId);

        query += `
            AND id <> $${values.length}
        `;
    }

    query += `
        LIMIT 1
    `;

    const { rows } = await pool.query(
        query,
        values
    );

    return rows[0] || null;
};

/* ================= GET WORK LOCATION ID ================= */
export const getWorkLocationId = async (work_location) => {

    if (
        work_location === null ||
        work_location === undefined ||
        work_location === ""
    ) {
        return null;
    }

    /* Already an ID */
    if (/^\d+$/.test(String(work_location).trim())) {

        const { rows } = await pool.query(
            `
            SELECT id
            FROM work_location
            WHERE id = $1
            LIMIT 1
            `,
            [Number(work_location)]
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
        [work_location]
    );

    return rows[0]?.id || null;
};

/* =========================================================
   GET CATEGORY CONFIG FOR EMPLOYEE
========================================================= */
export const getEmployeeCategoryRequiredFields = async ({
    username
}) => {

    if (!username || String(username).trim() === "") {
        return null;
    }

    const { rows } = await pool.query(
        `
        SELECT
            ed.username,

            ed.category AS employment_category,
            ed.work_location AS employment_work_location,

            c.id AS category_id,
            c.category_name,
            c.work_location AS category_work_location_id,

            wl.location AS category_work_location,

            c.required_fields

        FROM employment_details ed

        LEFT JOIN category c
            ON (
                TRIM(ed.category::TEXT) = TRIM(c.id::TEXT)
                OR LOWER(TRIM(ed.category::TEXT))
                   = LOWER(TRIM(c.category_name))
            )

        LEFT JOIN work_location wl
            ON wl.id = c.work_location

        WHERE LOWER(TRIM(ed.username))
              = LOWER(TRIM($1))

        LIMIT 1;
        `,
        [username]
    );

    return rows[0] || null;
};

/* =========================================================
   CHECK CATEGORY + WORK LOCATION
========================================================= */
export const getMatchedCategoryConfig = async ({
    username
}) => {
    const employee = await getEmployeeCategoryRequiredFields({
        username
    });

    /* =====================================================
       NO EMPLOYMENT DETAILS
       → DO NOT VALIDATE
    ===================================================== */

    if (!employee) {
        return {
            shouldValidate: false,
            reason: "employment_details not found"
        };
    }

    /* =====================================================
       CATEGORY NOT FOUND
       → DO NOT VALIDATE
    ===================================================== */

    if (!employee.category_id) {
        return {
            shouldValidate: false,
            reason: "category not found"
        };
    }

    /* =====================================================
       CHECK WORK LOCATION
    ===================================================== */
    const employmentWorkLocation = employee.employment_work_location;
    const categoryWorkLocation = employee.category_work_location_id;

    const workLocationMatches =
        employmentWorkLocation === null ||
            employmentWorkLocation === undefined
            ? false
            : String(employmentWorkLocation).trim()
            === String(categoryWorkLocation).trim();

    /* =====================================================
       CATEGORY + WORK LOCATION MUST BOTH MATCH
    ===================================================== */
    if (!workLocationMatches) {
        return {
            shouldValidate: false,
            reason: "category matched but work_location did not match",
            employment_category:
                employee.employment_category,
            employment_work_location:
                employmentWorkLocation,
            category_id:
                employee.category_id,
            category_work_location:
                categoryWorkLocation
        };
    }

    return {
        shouldValidate: true,
        category_id: employee.category_id,
        category_name: employee.category_name,
        work_location: employee.category_work_location,
        required_fields: employee.required_fields || {}
    };
};

/* =========================================================
   EMPLOYEE REQUIRED FILED NAME 
========================================================= */
export const getEmployeeRequiredFieldNamesModel = async () => {
    const tables = [
        "personal_details",
        "identification_details",
        "bank_details",
        "educational_qualifications",
        "employment_details",
        "work_experience"
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

        requiredFields[
            row.table_name
        ].fields.push(
            row.column_name
        );
    }

    return requiredFields;
};

/* =========================================================
   CHECK VALUE EMPTY
========================================================= */
const isEmptyValue = (value) => {
    if (
        value === undefined ||
        value === null
    ) {
        return true;
    }

    if (
        typeof value === "string" &&
        value.trim() === ""
    ) {
        return true;
    }

    return false;
};

export const validateEmployeeCategoryRequiredFields = async ({
    personalDetailsId
}) => {

    /* ================= GET EMPLOYEE ================= */

    const employeeResult = await pool.query(
        `
        SELECT
            pd.id,
            pd.username,
            ed.category,
            ed.work_location
        FROM personal_details pd
        LEFT JOIN employment_details ed
            ON ed.personal_details_id = pd.id
        WHERE pd.id = $1
        LIMIT 1
        `,
        [personalDetailsId]
    );

    const employee = employeeResult.rows[0];

    if (!employee) {
        return {
            valid: false,
            shouldValidate: false,
            missing: [],
            reason: "Employee not found"
        };
    }

    /* ================= CATEGORY ================= */

    const categoryResult = await pool.query(
        `
        SELECT
            c.id,
            c.category_name,
            c.work_location,
            c.required_fields,
            wl.location AS work_location_name
        FROM category c
        LEFT JOIN work_location wl
            ON wl.id = c.work_location
        WHERE
            (
                TRIM(c.id::TEXT) =
                TRIM($1::TEXT)
                OR
                LOWER(TRIM(c.category_name)) =
                LOWER(TRIM($1::TEXT))
            )
            AND c.work_location = $2
        LIMIT 1
        `,
        [
            employee.category,
            employee.work_location
        ]
    );

    const category = categoryResult.rows[0];

    if (!category) {
        return {
            valid: true,
            shouldValidate: false,
            missing: [],
            reason: "Category not found or work location mismatch"
        };
    }

    const requiredFields =
        category.required_fields || {};

    /* ================= LOAD ACTUAL TABLE DATA ================= */

    const [
        personalResult,
        employmentResult,
        identificationResult,
        bankResult,
        educationResult,
        experienceResult,
        salaryResult
    ] = await Promise.all([

        pool.query(
            `
            SELECT *
            FROM personal_details
            WHERE id = $1
            LIMIT 1
            `,
            [personalDetailsId]
        ),

        pool.query(
            `
            SELECT *
            FROM employment_details
            WHERE personal_details_id = $1
            LIMIT 1
            `,
            [personalDetailsId]
        ),

        pool.query(
            `
            SELECT *
            FROM identification_details
            WHERE personal_details_id = $1
            LIMIT 1
            `,
            [personalDetailsId]
        ),

        pool.query(
            `
            SELECT *
            FROM bank_details
            WHERE personal_details_id = $1
            LIMIT 1
            `,
            [personalDetailsId]
        ),

        pool.query(
            `
            SELECT *
            FROM educational_qualifications
            WHERE personal_details_id = $1
            `,
            [personalDetailsId]
        ),

        pool.query(
            `
            SELECT *
            FROM work_experience
            WHERE personal_details_id = $1
            `,
            [personalDetailsId]
        ),
    ]);

    const employeeData = {
        personal_details:
            personalResult.rows[0] || null,

        employment_details:
            employmentResult.rows[0] || null,

        identification_details:
            identificationResult.rows[0] || null,

        bank_details:
            bankResult.rows[0] || null,

        educational_qualifications:
            educationResult.rows,

        work_experience:
            experienceResult.rows
    };

    /* ================= VALIDATE ================= */

    const missing = [];

    const isEmptyValue = (value) => {

        if (
            value === undefined ||
            value === null
        ) {
            return true;
        }

        if (
            typeof value === "string" &&
            value.trim() === ""
        ) {
            return true;
        }

        return false;
    };

    for (
        const [tableName, tableConfig]
        of Object.entries(requiredFields)
    ) {

        if (
            !tableConfig ||
            tableConfig.required !== true
        ) {
            continue;
        }

        const tableData =
            employeeData[tableName];

        /* ================= TABLE MISSING ================= */

        if (
            !tableData ||
            (
                Array.isArray(tableData) &&
                tableData.length === 0
            )
        ) {

            missing.push({
                table: tableName,
                field: null,
                message:
                    `${tableName} is required`
            });

            continue;
        }

        const fields =
            tableConfig.fields || {};

        /* ================= ARRAY TABLE ================= */

        if (Array.isArray(tableData)) {

            for (
                const [fieldName, isRequired]
                of Object.entries(fields)
            ) {

                if (isRequired !== true) {
                    continue;
                }

                const hasValidValue =
                    tableData.some(row =>
                        !isEmptyValue(
                            row[fieldName]
                        )
                    );

                if (!hasValidValue) {

                    missing.push({
                        table: tableName,
                        field: fieldName,
                        message:
                            `${tableName}.${fieldName} is required`
                    });
                }
            }

            continue;
        }

        /* ================= NORMAL TABLE ================= */

        for (
            const [fieldName, isRequired]
            of Object.entries(fields)
        ) {

            if (isRequired !== true) {
                continue;
            }

            const value =
                tableData[fieldName];

            if (isEmptyValue(value)) {

                missing.push({
                    table: tableName,
                    field: fieldName,
                    message:
                        `${tableName}.${fieldName} is required`
                });
            }
        }
    }

    return {
        valid: missing.length === 0,
        shouldValidate: true,
        category_id: category.id,
        category_name: category.category_name,
        work_location:
            category.work_location_name,
        missing
    };
};

/* ================= UPDATE ================= */
export const updateCategoryModel = async (
    id,
    {
        category_name,
        category_image,
        work_location,
        required_fields
    }
) => {

    const workLocationId =
        await getWorkLocationId(work_location);

    if (
        work_location !== null &&
        work_location !== undefined &&
        work_location !== "" &&
        !workLocationId
    ) {
        throw new Error(
            `Work location not found: "${work_location}"`
        );
    }

    /*
     * Make sure required_fields is an OBJECT.
     *
     * If frontend sends JSON string:
     * '{"bank_details":{"required":true}}'
     *
     * convert it into:
     * {
     *   bank_details: {
     *      required: true
     *   }
     * }
     */
    let requiredFieldsValue = null;

    if (required_fields !== undefined) {

        if (
            typeof required_fields === "string" &&
            required_fields.trim() !== ""
        ) {
            try {
                requiredFieldsValue =
                    JSON.parse(required_fields);
            } catch (error) {
                throw new Error(
                    "Invalid required_fields JSON format."
                );
            }
        } else if (
            required_fields !== null &&
            typeof required_fields === "object"
        ) {
            requiredFieldsValue = required_fields;
        }
    }

    const { rows } = await pool.query(
        `
        UPDATE category
        SET

            category_name =
                COALESCE(
                    NULLIF($1, ''),
                    category_name
                ),

            category_image =
                COALESCE(
                    NULLIF($2, ''),
                    category_image
                ),

            work_location =
                COALESCE(
                    $3,
                    work_location
                ),

            required_fields =
                COALESCE(
                    $4::jsonb,
                    required_fields
                ),

            updated_at = CURRENT_TIMESTAMP

        WHERE id = $5

        RETURNING *;
        `,
        [
            category_name?.trim() || null,

            category_image !== undefined &&
            category_image !== null
                ? String(category_image).trim() || null
                : null,

            workLocationId,

            requiredFieldsValue !== null
                ? JSON.stringify(requiredFieldsValue)
                : null,

            id
        ]
    );

    return rows[0];
};

/* =====================================================
   UPDATE CATEGORY REFERENCE EVERYWHERE
===================================================== */
export const updateCategoryEverywhere = async (
    oldCategoryId,
    newCategoryId
) => {

    const client = await pool.connect();

    try {

        await client.query("BEGIN");

        /* =====================================================
           FIND ALL TABLES HAVING category COLUMN
        ===================================================== */
        const tablesResult = await client.query(`
            SELECT
                table_schema,
                table_name,
                data_type
            FROM information_schema.columns
            WHERE column_name = 'category'
              AND table_schema NOT IN (
                  'pg_catalog',
                  'information_schema'
              )
            ORDER BY table_schema, table_name;
        `);

        const updatedTables = [];

        /* =====================================================
           UPDATE CATEGORY ID
        ===================================================== */
        for (const table of tablesResult.rows) {

            const schema = table.table_schema;
            const tableName = table.table_name;
            const dataType = table.data_type;

            let result;

            /* ================= INTEGER CATEGORY ================= */

            if (
                dataType === "integer" ||
                dataType === "smallint" ||
                dataType === "bigint"
            ) {

                result = await client.query(
                    `
                    UPDATE "${schema}"."${tableName}"
                    SET category = $1
                    WHERE category = $2
                    `,
                    [
                        newCategoryId,
                        oldCategoryId
                    ]
                );

            }

            /* ================= STRING CATEGORY ================= */

            else if (
                dataType === "character varying" ||
                dataType === "text"
            ) {

                /*
                 * Legacy tables which still store category name.
                 */
                result = await client.query(
                    `
                    UPDATE "${schema}"."${tableName}"
                    SET category = (
                        SELECT category_name
                        FROM category
                        WHERE id = $1
                    )
                    WHERE LOWER(TRIM(category))
                          = LOWER(TRIM(
                              SELECT category_name
                              FROM category
                              WHERE id = $2
                          ))
                    `,
                    [
                        newCategoryId,
                        oldCategoryId
                    ]
                );

            }

            if (result && result.rowCount > 0) {

                updatedTables.push({
                    table: `${schema}.${tableName}`,
                    rowsUpdated: result.rowCount
                });

            }
        }

        await client.query("COMMIT");

        return {
            oldCategoryId,
            newCategoryId,
            updatedTables
        };

    } catch (error) {

        await client.query("ROLLBACK");

        throw error;

    } finally {

        client.release();

    }
};

/* ================= TOGGLE CATEGORY STATUS ================= */
export const toggleCategoryStatusModel = async (id) => {

    /* ================= GET CATEGORY ================= */

    const { rows } = await pool.query(
        `
        SELECT *
        FROM category
        WHERE id = $1
        `,
        [id]
    );

    if (!rows.length) {
        return null;
    }

    const category = rows[0];

    /* =====================================================
       IF CATEGORY IS ACTIVE
       CHECK WHETHER IT IS USED BY ANY EMPLOYEE
    ===================================================== */

    if (category.is_active === true) {

        const usedResult = await pool.query(
            `
            SELECT
                COUNT(*)::INT AS count
            FROM employment_details
            WHERE category IS NOT NULL
              AND TRIM(category::TEXT) = TRIM($1::TEXT)
            `,
            [id]
        );

        const usedCount =
            Number(usedResult.rows[0]?.count || 0);

        /* ================= PREVENT DEACTIVATION ================= */

        if (usedCount > 0) {

            return {
                blocked: true,
                used_count: usedCount,
                message:
                    `This category is currently used by ${usedCount} employee(s), so it cannot be deactivated.`
            };
        }
    }

    /* ================= TOGGLE STATUS ================= */

    const newStatus = !category.is_active;

    const updateResult = await pool.query(
        `
        UPDATE category
        SET
            is_active = $1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
        RETURNING *;
        `,
        [newStatus, id]
    );

    return updateResult.rows[0];
};