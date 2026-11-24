import { pool } from "../../database.js";

/* ================= CREATE TABLE ================= */
export const initializeBondOptionTable = async () => {
    const query = `
        CREATE TABLE IF NOT EXISTS bond_options (
          id SERIAL PRIMARY KEY,
          bond_duration VARCHAR(255) NOT NULL,
          created_by VARCHAR(255),
          status BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMP DEFAULT TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP),
          updated_at TIMESTAMP DEFAULT TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
        );
    `;

    await pool.query(query);

    await pool.query(`
        ALTER TABLE bond_options
        ADD COLUMN IF NOT EXISTS work_location INTEGER;
    `);

    /* ================= FIX WORK LOCATION ================= */
    const updateQuery = `
        UPDATE bond_options bo
        SET work_location = wl.id
        FROM work_location wl
        WHERE TRIM(UPPER(bo.work_location::text))
            = TRIM(UPPER(wl.location::text))
    `;

    await pool.query(updateQuery);

    await pool.query(`
        DO $$
        BEGIN

        /* ================= CATEGORY ================= */
            IF EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'bond_options'
                  AND column_name = 'work_location'
                  AND data_type = 'character varying'
            ) THEN
        
                ALTER TABLE bond_options
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
            pg_get_serial_sequence('bond_options', 'id'),
            COALESCE((SELECT MAX(id) FROM bond_options), 1),
            true
        );
    `);

    console.log("✅ bond_options table ready");
};

/* ================= ADD ================= */
export const addBondOptionModel = async (data) => {

    const client = await pool.connect();

    try {

        await client.query("BEGIN");

        let workLocationId = null;

        /* ================= RESOLVE LOCATION ================= */

        if (
            data.work_location !== undefined &&
            data.work_location !== null &&
            String(data.work_location).trim() !== ""
        ) {

            const locationValue =
                String(data.work_location).trim();

            const locationResult = await client.query(
                `
                SELECT id, location
                FROM work_location
                WHERE LOWER(TRIM(location))
                    = LOWER(TRIM($1))
                LIMIT 1
                `,
                [locationValue]
            );

            if (!locationResult.rows.length) {
                throw new Error(
                    `Work location "${locationValue}" not found`
                );
            }

            workLocationId =
                locationResult.rows[0].id;
        }

        /* ================= INSERT ================= */

        const query = `
            INSERT INTO bond_options (
                bond_duration,
                work_location,
                created_by,
                status
            )
            VALUES ($1, $2, $3, $4)
            RETURNING *;
        `;

        const values = [
            String(data.bond_duration || "").trim(),
            workLocationId,
            data.created_by || null,
            data.status ?? true
        ];

        const { rows } =
            await client.query(query, values);

        await client.query("COMMIT");

        return rows[0];

    } catch (error) {

        await client.query("ROLLBACK");

        throw error;

    } finally {

        client.release();
    }
};

/* ================= GET ================= */
export const getAllBondOptionsModel = async ({
    work_location = null
}) => {

    const values = [];
    let count = 1;

    let query = `
        SELECT
            bo.id,
            bo.bond_duration,
            bo.work_location,
            wl.location AS work_location,
            bo.created_by,
            bo.status,
            bo.created_at,
            bo.updated_at

        FROM bond_options bo

        LEFT JOIN work_location wl
            ON wl.id = bo.work_location

        WHERE 1 = 1
    `;

    if (work_location) {

        query += `
            AND LOWER(TRIM(wl.location))
                = LOWER(TRIM($${count}))
        `;

        values.push(String(work_location).trim());
        count++;
    }

    query += `
        ORDER BY bo.id DESC
    `;

    const { rows } =
        await pool.query(query, values);

    return rows;
};

/* ================= GET BY ID ================= */
export const getBondOptionByIdModel = async (id) => {
    const { rows } = await pool.query(`
        SELECT *
        FROM bond_options
        WHERE id = $1
    `,
        [id]
    );

    return rows[0];
};

/* =====================================================
   CHECK DUPLICATE BOND DURATION
===================================================== */
export const checkDuplicateBondDurationModel = async (
    bondId,
    bondDuration,
    workLocationId
) => {

    const locationId = Number(workLocationId);
    const currentBondId = Number(bondId);

    if (!Number.isInteger(locationId)) {
        throw new Error(
            `Invalid work location ID: ${workLocationId}`
        );
    }

    if (!Number.isInteger(currentBondId)) {
        throw new Error(
            `Invalid bond ID: ${bondId}`
        );
    }

    const { rows } = await pool.query(
        `
        SELECT id
        FROM bond_options
        WHERE work_location = $1
          AND LOWER(TRIM(bond_duration))
              = LOWER(TRIM($2))
          AND id <> $3
        LIMIT 1
        `,
        [
            locationId,
            String(bondDuration || "").trim(),
            currentBondId
        ]
    );

    return rows.length > 0;
};

/* ================= UPDATE ================= */
export const updateBondOptionModel = async (id, data) => {
    const query = `
        UPDATE bond_options
        SET
          bond_duration = COALESCE(NULLIF($1, ''), bond_duration),
          work_location = COALESCE($2, work_location),
          status = COALESCE($3, status),
          updated_at = TIMEZONE(
            'Asia/Kolkata',
            CURRENT_TIMESTAMP
          )
        WHERE id = $4
        RETURNING *;
    `;

    const values = [
        data.bond_duration?.trim() || null,
        data.work_location === undefined ? null : data.work_location,
        data.status === undefined ? null : data.status,
        id
    ];

    const { rows } = await pool.query(
        query,
        values
    );

    return rows[0];
};

/* =====================================================
   UPDATE BOND DURATION EVERYWHERE
===================================================== */
export const updateBondEverywhere = async (
    bondId,
    oldBondDuration,
    newBondDuration,
    workLocation
) => {

    const client = await pool.connect();

    try {

        await client.query("BEGIN");

        const location =
            String(workLocation || "").trim();

        const oldDuration =
            String(oldBondDuration || "").trim();

        const newDuration =
            String(newBondDuration || "").trim();

        if (!location) {
            throw new Error(
                "Work location is required."
            );
        }

        /* =====================================================
           FIND TABLES
        ===================================================== */

        const tablesResult = await client.query(`
            SELECT
                c.table_schema,
                c.table_name,
                c.data_type,

                EXISTS (
                    SELECT 1
                    FROM information_schema.columns wc
                    WHERE wc.table_schema = c.table_schema
                      AND wc.table_name = c.table_name
                      AND wc.column_name = 'work_location'
                ) AS has_work_location

            FROM information_schema.columns c

            WHERE c.column_name = 'bond'
              AND c.table_schema NOT IN (
                  'pg_catalog',
                  'information_schema'
              )

            ORDER BY
                c.table_schema,
                c.table_name;
        `);

        const updatedTables = [];

        /* =====================================================
           UPDATE
        ===================================================== */

        for (const table of tablesResult.rows) {

            const {
                table_schema: schema,
                table_name: tableName,
                data_type: dataType,
                has_work_location: hasWorkLocation
            } = table;

            /* Only tables with work_location */
            if (!hasWorkLocation) {
                continue;
            }

            let result;

            /* =================================================
               INTEGER
            ================================================= */

            if (
                dataType === "integer" ||
                dataType === "bigint" ||
                dataType === "smallint"
            ) {

                const oldNumber =
                    oldDuration.match(/\d+/)?.[0];

                const newNumber =
                    newDuration.match(/\d+/)?.[0];

                if (
                    oldNumber === undefined ||
                    newNumber === undefined
                ) {
                    continue;
                }

                result = await client.query(
                    `
                    UPDATE "${schema}"."${tableName}"
                    SET bond = $1
                    WHERE bond = $2
                      AND LOWER(TRIM(work_location::text))
                          = LOWER(TRIM($3::text))
                    `,
                    [
                        Number(newNumber),
                        Number(oldNumber),
                        location
                    ]
                );

            }

            /* =================================================
               TEXT
            ================================================= */

            else {

                result = await client.query(
                    `
                    UPDATE "${schema}"."${tableName}"
                    SET bond = $1
                    WHERE LOWER(TRIM(bond::text))
                          = LOWER(TRIM($2::text))
                      AND LOWER(TRIM(work_location::text))
                          = LOWER(TRIM($3::text))
                    `,
                    [
                        newDuration,
                        oldDuration,
                        location
                    ]
                );
            }

            if (result.rowCount > 0) {

                updatedTables.push({
                    table:
                        `${schema}.${tableName}`,

                    dataType,

                    workLocation:
                        location,

                    rowsUpdated:
                        result.rowCount
                });
            }
        }

        await client.query("COMMIT");

        return {
            oldBondDuration: oldDuration,
            newBondDuration: newDuration,
            workLocation: location,
            updatedTables
        };

    } catch (error) {

        await client.query("ROLLBACK");

        throw error;

    } finally {

        client.release();
    }
};

/* ================= TOGGLE STATUS ================= */
export const toggleBondOptionStatusModel = async (id) => {

    /* ================= GET BOND OPTION ================= */
    const { rows } = await pool.query(
        `
        SELECT *
        FROM bond_options
        WHERE id = $1
        `,
        [id]
    );

    if (!rows.length) {
        return null;
    }

    const bondOption = rows[0];

    /* =====================================================
       IF CURRENTLY ACTIVE
       CHECK WHETHER IT IS USED BY ANY EMPLOYEE
    ===================================================== */
    if (bondOption.status === true) {

        const usedResult = await pool.query(
            `
            SELECT
                COUNT(*)::INT AS count
            FROM employment_details
            WHERE bond IS NOT NULL
              AND TRIM(bond::TEXT) = TRIM($1::TEXT)
            `,
            [id]
        );

        const usedCount = Number(usedResult.rows[0]?.count || 0);

        /* ================ PREVENT DEACTIVATION ================= */
        if (usedCount > 0) {
            return {
                blocked: true,
                used_count: usedCount,
                message:
                    `This bond option is currently used by ${usedCount} employee(s), so it cannot be deactivated.`
            };
        }
    }

    /* ================= TOGGLE STATUS ================= */
    const newStatus = !bondOption.status;

    const updateRes = await pool.query(
        `
        UPDATE bond_options
        SET
            status = $1,
            updated_at = TIMEZONE(
                'Asia/Kolkata',
                CURRENT_TIMESTAMP
            )
        WHERE id = $2
        RETURNING *
        `,
        [newStatus, id]
    );

    return updateRes.rows[0];
};