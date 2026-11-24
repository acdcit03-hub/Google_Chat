import { pool } from "../../database.js";

/* ================= CREATE TABLE ================= */
export const initializeEducationTable = async () => {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS education (
            id SERIAL PRIMARY KEY,
            education_name VARCHAR(255) NOT NULL,
            work_location VARCHAR(255),
            username VARCHAR(255),
            is_active BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        );
    `);

    /* ================= WORK LOCATION ================= */
    await pool.query(`
        ALTER TABLE education
        ADD COLUMN IF NOT EXISTS work_location INTEGER;

        ALTER TABLE education
        ADD COLUMN IF NOT EXISTS username VARCHAR(255);
    `);

    /* ================= REMOVE OLD UNIQUE ================= */
    await pool.query(`
        ALTER TABLE education
        DROP CONSTRAINT IF EXISTS education_education_name_key;
    `);

    /* ================= REMOVE OLD COMPOSITE CONSTRAINT ================= */
    await pool.query(`
        ALTER TABLE education
        DROP CONSTRAINT IF EXISTS education_name_work_location_unique;
    `);

    /* ================= ADD CORRECT UNIQUE ================= */
    await pool.query(`
        ALTER TABLE education
        ADD CONSTRAINT education_name_work_location_unique
        UNIQUE (education_name, work_location);
    `);

    await pool.query(`
        UPDATE education e
        SET work_location = wl.id
        FROM work_location wl
        WHERE
            e.work_location IS NOT NULL
            AND TRIM(e.work_location::TEXT) <> ''
            AND LOWER(TRIM(e.work_location::TEXT))
                = LOWER(TRIM(wl.location));
    `);

    await pool.query(`
        DO $$
        BEGIN

            IF EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'education'
                  AND column_name = 'work_location'
                  AND data_type = 'character varying'
            ) THEN

                ALTER TABLE education
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

    /* ================= FIX SEQUENCE ================= */
    await pool.query(`
        SELECT setval(
            pg_get_serial_sequence('education', 'id'),
            COALESCE((SELECT MAX(id) FROM education), 1),
            true
        );
    `);

    console.log("✅ Education table ready");
};

/* ================= CREATE ================= */

export const createEducationModel = async ({
    education_name,
    work_location,
    username
}) => {

    /* =====================================================
       FIND WORK LOCATION ID
       Frontend can send:
       ACDC TECH
       EMBLEPCB
       OR
       1
       2
    ===================================================== */

    let workLocationId = null;

    if (
        work_location !== null &&
        work_location !== undefined &&
        String(work_location).trim() !== ""
    ) {

        const locationValue = String(work_location).trim();

        const locationId = Number(locationValue);

        if (
            Number.isInteger(locationId) &&
            locationId > 0
        ) {

            const { rows } = await pool.query(
                `
                SELECT id
                FROM work_location
                WHERE id = $1
                `,
                [locationId]
            );

            if (!rows.length) {
                throw new Error("Work location not found");
            }

            workLocationId = rows[0].id;

        } else {

            const { rows } = await pool.query(
                `
                SELECT id
                FROM work_location
                WHERE LOWER(TRIM(location))
                    = LOWER(TRIM($1))
                LIMIT 1
                `,
                [locationValue]
            );

            if (!rows.length) {
                throw new Error(
                    `Work location "${locationValue}" not found`
                );
            }

            workLocationId = rows[0].id;
        }
    }

    const { rows } = await pool.query(
        `
        INSERT INTO education
        (
            education_name,
            work_location,
            username
        )
        VALUES
        (
            $1,
            $2,
            $3
        )
        RETURNING *;
        `,
        [
            education_name?.trim(),
            workLocationId,
            username || null
        ]
    );

    return rows[0];
};


/* ================= GET ALL ================= */

export const getAllEducationModel = async (work_location = null) => {

    const values = [];

    let query = `
        SELECT
            e.id,
            e.education_name,

            e.work_location AS work_location_id,

            wl.location AS work_location,

            e.is_active,
            e.created_at,
            e.updated_at

        FROM education e

        LEFT JOIN work_location wl
            ON wl.id = e.work_location

        WHERE 1 = 1
    `;

    /* ================= WORK LOCATION FILTER ================= */

    if (
        work_location !== null &&
        work_location !== undefined &&
        String(work_location).trim() !== "" &&
        String(work_location).trim().toLowerCase() !== "nan"
    ) {

        const locationValue = String(work_location).trim();

        const locationId = Number(locationValue);

        if (
            Number.isInteger(locationId) &&
            locationId > 0
        ) {

            values.push(locationId);

            query += `
                AND e.work_location = $${values.length}
            `;

        } else {

            values.push(locationValue);

            query += `
                AND LOWER(TRIM(wl.location))
                    = LOWER(TRIM($${values.length}))
            `;
        }
    }

    query += `
        ORDER BY e.id DESC;
    `;

    const { rows } = await pool.query(query, values);

    return rows;
};


/* ================= UPDATE ================= */

export const updateEducationModel = async (
    id,
    {
        education_name,
        work_location
    }
) => {

    let workLocationId = null;

    /* =====================================================
       WORK LOCATION
    ===================================================== */

    if (
        work_location !== null &&
        work_location !== undefined &&
        String(work_location).trim() !== ""
    ) {

        const locationValue = String(work_location).trim();

        const locationId = Number(locationValue);

        if (
            Number.isInteger(locationId) &&
            locationId > 0
        ) {

            const { rows } = await pool.query(
                `
                SELECT id
                FROM work_location
                WHERE id = $1
                `,
                [locationId]
            );

            if (!rows.length) {
                throw new Error("Work location not found");
            }

            workLocationId = rows[0].id;

        } else {

            const { rows } = await pool.query(
                `
                SELECT id
                FROM work_location
                WHERE LOWER(TRIM(location))
                    = LOWER(TRIM($1))
                LIMIT 1
                `,
                [locationValue]
            );

            if (!rows.length) {
                throw new Error(
                    `Work location "${locationValue}" not found`
                );
            }

            workLocationId = rows[0].id;
        }
    }

    const { rows } = await pool.query(
        `
        UPDATE education
        SET
            education_name =
                COALESCE(
                    NULLIF($1, ''),
                    education_name
                ),

            work_location =
                COALESCE(
                    $2,
                    work_location
                ),

            updated_at = CURRENT_TIMESTAMP

        WHERE id = $3

        RETURNING *;
        `,
        [
            education_name?.trim() || null,
            workLocationId,
            id
        ]
    );

    return rows[0];
};


/* =====================================================
   UPDATE EDUCATION EVERYWHERE
===================================================== */

export const updateEducationEverywhere = async (
    oldEducationName,
    newEducationName
) => {

    const client = await pool.connect();

    try {

        await client.query("BEGIN");

        /* =====================================================
           FIND ALL TABLES HAVING EDUCATION COLUMN
        ===================================================== */

        const tablesResult = await client.query(
            `
            SELECT DISTINCT
                table_schema,
                table_name,
                data_type

            FROM information_schema.columns

            WHERE column_name = 'education'

            AND table_schema NOT IN (
                'pg_catalog',
                'information_schema'
            )

            ORDER BY
                table_schema,
                table_name;
            `
        );

        const updatedTables = [];

        /* =====================================================
           UPDATE EACH TABLE
        ===================================================== */

        for (const table of tablesResult.rows) {

            const schema = table.table_schema;
            const tableName = table.table_name;
            const dataType = table.data_type;

            let result;

            /* =================================================
               INTEGER / SMALLINT / BIGINT
               
               These tables store EDUCATION ID
            ================================================= */

            if (
                dataType === "integer" ||
                dataType === "smallint" ||
                dataType === "bigint"
            ) {

                /*
                 * Find old education ID
                 * using education_name
                 */

                const oldEducationResult =
                    await client.query(
                        `
                        SELECT id
                        FROM education
                        WHERE LOWER(TRIM(education_name))
                            = LOWER(TRIM($1))
                        LIMIT 1
                        `,
                        [oldEducationName]
                    );

                if (
                    !oldEducationResult.rows.length
                ) {
                    continue;
                }

                const oldEducationId =
                    oldEducationResult.rows[0].id;

                /*
                 * Find new education ID
                 */

                const newEducationResult =
                    await client.query(
                        `
                        SELECT id
                        FROM education
                        WHERE LOWER(TRIM(education_name))
                            = LOWER(TRIM($1))
                        LIMIT 1
                        `,
                        [newEducationName]
                    );

                if (
                    !newEducationResult.rows.length
                ) {
                    continue;
                }

                const newEducationId =
                    newEducationResult.rows[0].id;

                /* =============================================
                   UPDATE ID
                ============================================= */

                result = await client.query(
                    `
                    UPDATE "${schema}"."${tableName}"

                    SET education = $1

                    WHERE education = $2
                    `,
                    [
                        newEducationId,
                        oldEducationId
                    ]
                );
            }

            /* =================================================
               VARCHAR / TEXT
               
               These tables store EDUCATION NAME
            ================================================= */

            else if (
                dataType === "character varying" ||
                dataType === "text"
            ) {

                result = await client.query(
                    `
                    UPDATE "${schema}"."${tableName}"

                    SET education = $1

                    WHERE LOWER(TRIM(education))
                        = LOWER(TRIM($2))
                    `,
                    [
                        newEducationName,
                        oldEducationName
                    ]
                );
            }

            /* =================================================
               OTHER TYPES
               
               Ignore unsupported types
            ================================================= */

            else {
                continue;
            }

            /* =================================================
               STORE UPDATE INFORMATION
            ================================================= */

            if (
                result &&
                result.rowCount > 0
            ) {

                updatedTables.push({
                    table:
                        `${schema}.${tableName}`,

                    dataType,

                    rowsUpdated:
                        result.rowCount
                });
            }
        }

        /* =====================================================
           COMMIT
        ===================================================== */

        await client.query("COMMIT");

        return {
            oldEducationName,
            newEducationName,
            updatedTables
        };

    } catch (error) {

        await client.query("ROLLBACK");

        throw error;

    } finally {

        client.release();
    }
};

/* ================= TOGGLE EDUCATION STATUS ================= */
export const toggleEducationStatusModel = async (id) => {

    /* ================= GET EDUCATION ================= */

    const { rows } = await pool.query(
        `
        SELECT *
        FROM education
        WHERE id = $1
        `,
        [id]
    );

    if (!rows.length) {
        return null;
    }

    const education = rows[0];

    /* =====================================================
       IF EDUCATION IS ACTIVE
       CHECK WHETHER IT IS USED
    ===================================================== */

    if (education.is_active === true) {

        const usedResult = await pool.query(
            `
            SELECT
                COUNT(*)::INT AS count
            FROM educational_qualifications
            WHERE education IS NOT NULL
              AND TRIM(education::TEXT) =
                  TRIM($1::TEXT)
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
                    `This education is currently used by ${usedCount} employee(s), so it cannot be deactivated.`
            };
        }
    }

    /* ================= TOGGLE STATUS ================= */

    const newStatus = !education.is_active;

    const updateResult = await pool.query(
        `
        UPDATE education
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