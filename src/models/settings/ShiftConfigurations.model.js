import { pool } from "../../database.js";

/* ================= CREATE TABLE ================= */
export const initializeShiftTable = async () => {
    const query = `
        CREATE TABLE IF NOT EXISTS shift_configurations (
          id SERIAL PRIMARY KEY,
          shift_name VARCHAR(255) NOT NULL,
          shift_type VARCHAR(100) NOT NULL,
          start_time TIME NOT NULL,
          end_time TIME NOT NULL,
          break_start_time TIME,
          break_end_time TIME,
          shift_reset_time TIME,
          early_leave_count_time INTEGER DEFAULT 0,
          late_arrival_count_time INTEGER DEFAULT 0,
          days VARCHAR(255),
          work_location VARCHAR(255),
          description TEXT,
          created_by VARCHAR(255),
          status BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMP DEFAULT TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP),
          updated_at TIMESTAMP DEFAULT TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
        );
    `;

    await pool.query(query);

    await pool.query(`
        ALTER TABLE shift_configurations
        ADD COLUMN IF NOT EXISTS break_start_time TIME,
        ADD COLUMN IF NOT EXISTS break_end_time TIME,
        ADD COLUMN IF NOT EXISTS shift_reset_time TIME,
        ADD COLUMN IF NOT EXISTS work_location VARCHAR(255),
        ADD COLUMN IF NOT EXISTS early_leave_count_time INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS late_arrival_count_time INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS days text[];
    `);

    await pool.query(`
        DO $$
        BEGIN

            IF EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'shift_configurations'
                  AND column_name = 'work_location'
                  AND data_type = 'character varying'
            ) THEN

                /* =========================================
                   OLD LOCATION NAME -> LOCATION ID
                ========================================= */

                UPDATE shift_configurations sc
                SET work_location = wl.id::VARCHAR
                FROM work_location wl
                WHERE
                    sc.work_location IS NOT NULL
                    AND TRIM(sc.work_location) <> ''
                    AND LOWER(
                        REPLACE(
                            TRIM(sc.work_location),
                            ' ',
                            ''
                        )
                    )
                    =
                    LOWER(
                        REPLACE(
                            TRIM(wl.location),
                            ' ',
                            ''
                        )
                    );

                /* =========================================
                   INVALID / UNMATCHED VALUES -> NULL
                ========================================= */

                UPDATE shift_configurations
                SET work_location = NULL
                WHERE
                    work_location IS NOT NULL
                    AND TRIM(work_location) <> ''
                    AND work_location !~ '^[0-9]+$';

                /* =========================================
                   VARCHAR -> INTEGER
                ========================================= */

                ALTER TABLE shift_configurations
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
        DO $$
        BEGIN

            -- =====================================================
            -- ADD DAYS COLUMN IF IT DOES NOT EXIST
            -- =====================================================

            IF NOT EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'shift_configurations'
                  AND column_name = 'days'
            ) THEN

                ALTER TABLE shift_configurations
                ADD COLUMN days TEXT[];

            END IF;


            -- =====================================================
            -- CONVERT OLD VARCHAR/TEXT DAYS TO TEXT[]
            -- =====================================================

            IF EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'shift_configurations'
                  AND column_name = 'days'
                  AND data_type IN (
                      'character varying',
                      'text',
                      'character'
                  )
            ) THEN

                ALTER TABLE shift_configurations
                ALTER COLUMN days TYPE TEXT[]
                USING (
                    CASE

                        WHEN days IS NULL
                             OR TRIM(days::TEXT) = ''
                        THEN NULL

                        WHEN TRIM(days::TEXT) LIKE '[%'
                        THEN
                            string_to_array(
                                REPLACE(
                                    REPLACE(
                                        REPLACE(
                                            TRIM(days::TEXT),
                                            '[',
                                            ''
                                        ),
                                        ']',
                                        ''
                                    ),
                                    '"',
                                    ''
                                ),
                                ','
                            )

                        ELSE
                            string_to_array(
                                days::TEXT,
                                ','
                            )

                    END
                );

            END IF;

        END
        $$;
    `);

    await pool.query(`
      SELECT setval(
          pg_get_serial_sequence('shift_configurations', 'id'),
          COALESCE((SELECT MAX(id) FROM shift_configurations), 1),
          true
      );
    `);

    console.log("✅ shift_configurations table ready");
};

const trimString = (value) =>
    typeof value === 'string' ? value.trim() : null;

/* ================= ADD SHIFT ================= */
export const addShiftModel = async (data) => {

    const client = await pool.connect();

    try {

        await client.query("BEGIN");

        /* =====================================================
           RESOLVE WORK LOCATION ID
        ===================================================== */

        let workLocationId = null;

        if (
            data.work_location !== undefined &&
            data.work_location !== null &&
            String(data.work_location).trim() !== ""
        ) {

            const locationValue =
                String(data.work_location).trim();

            const locationResult = await client.query(
                `
                SELECT
                    id,
                    location
                FROM work_location
                WHERE
                    LOWER(
                        REPLACE(
                            TRIM(location),
                            ' ',
                            ''
                        )
                    )
                    =
                    LOWER(
                        REPLACE(
                            TRIM($1),
                            ' ',
                            ''
                        )
                    )
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

        const duplicateShiftResult = await client.query(
            `
                SELECT id
                FROM shift_configurations
                WHERE LOWER(TRIM(shift_name)) = LOWER(TRIM($1))
                  AND LOWER(TRIM(shift_type)) = LOWER(TRIM($2))
                  AND work_location IS NOT DISTINCT FROM $3
                LIMIT 1
            `,
            [
                trimString(data.shift_name),
                trimString(data.shift_type),
                workLocationId
            ]
        );

        if (duplicateShiftResult.rows.length) {
            throw new Error(
                `Shift "${data.shift_name}" with type "${data.shift_type}" already exists for this work location`
            );
        }

        /* =====================================================
           INSERT SHIFT
        ===================================================== */

        const query = `
            INSERT INTO shift_configurations (
                shift_name,
                shift_type,
                start_time,
                end_time,
                break_start_time,
                break_end_time,
                shift_reset_time,
                early_leave_count_time,
                late_arrival_count_time,
                days,
                description,
                created_by,
                status,
                work_location
            )

            VALUES (
                $1,$2,
                $3,$4,
                $5,$6,$7,
                $8,$9,
                $10,$11,$12,
                $13,$14
            )

            RETURNING *;
        `;

        const values = [
            trimString(data.shift_name),

            trimString(data.shift_type),

            data.start_time,
            data.end_time,

            data.break_start_time || null,
            data.break_end_time || null,
            data.shift_reset_time || null,

            /* ================= NEW ================= */
            data.early_leave_count_time !== undefined &&
                data.early_leave_count_time !== null &&
                data.early_leave_count_time !== ""
                ? Number(data.early_leave_count_time)
                : 0,

            data.late_arrival_count_time !== undefined &&
                data.late_arrival_count_time !== null &&
                data.late_arrival_count_time !== ""
                ? Number(data.late_arrival_count_time)
                : 0,

            data.days || null,

            /* ================= EXISTING ================= */
            data.description || null,
            data.created_by || null,
            data.status ?? true,

            workLocationId
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

/* ================= GET SHIFTS ================= */
export const getAllShiftsModel = async ({
    work_location = null
}) => {

    const values = [];
    let count = 1;

    let query = `
        SELECT
            sc.*,
            wl.location AS work_location
        FROM shift_configurations sc

        LEFT JOIN work_location wl
            ON wl.id = sc.work_location

        WHERE 1 = 1
    `;

    if (work_location) {

        query += `
            AND wl.location ILIKE $${count}
        `;

        values.push(`%${work_location}%`);
        count++;
    }

    query += `
        ORDER BY sc.id DESC
    `;

    const { rows } =
        await pool.query(query, values);

    return rows;
};

/* ================= UPDATE SHIFT ================= */
export const updateShiftModel = async (id, data) => {

    const client = await pool.connect();

    try {

        await client.query("BEGIN");

        /* =====================================================
           RESOLVE WORK LOCATION
        ===================================================== */

        let workLocationId = null;

        if (
            data.work_location !== undefined &&
            data.work_location !== null &&
            String(data.work_location).trim() !== ""
        ) {

            const locationValue =
                String(data.work_location).trim();

            let locationResult;

            /* =================================================
               IF FRONTEND SENDS ID
            ================================================= */

            if (/^\d+$/.test(locationValue)) {

                locationResult = await client.query(
                    `
                    SELECT id, location
                    FROM work_location
                    WHERE id = $1
                    LIMIT 1
                    `,
                    [Number(locationValue)]
                );

            }

            /* =================================================
               IF FRONTEND SENDS LOCATION NAME
               Example: ACDC TECH
            ================================================= */

            else {

                locationResult = await client.query(
                    `
                    SELECT id, location
                    FROM work_location
                    WHERE LOWER(
                        REPLACE(TRIM(location), ' ', '')
                    )
                    =
                    LOWER(
                        REPLACE(TRIM($1), ' ', '')
                    )
                    LIMIT 1
                    `,
                    [locationValue]
                );
            }

            if (!locationResult.rows.length) {

                throw new Error(
                    `Work location "${locationValue}" not found`
                );
            }

            workLocationId =
                locationResult.rows[0].id;

        } else {

            /*
             * No new work location supplied.
             * Keep existing value.
             */
            workLocationId = null;
        }

        /* =====================================================
           CHECK DUPLICATE SHIFT ON UPDATE
        ===================================================== */

        const duplicateShiftResult = await client.query(
            `
                SELECT id
                FROM shift_configurations
                WHERE LOWER(TRIM(shift_name)) = LOWER(TRIM($1))
                  AND LOWER(TRIM(shift_type)) = LOWER(TRIM($2))
                  AND work_location IS NOT DISTINCT FROM $3
                  AND id <> $4
                LIMIT 1
            `,
            [
                trimString(data.shift_name),
                trimString(data.shift_type),
                workLocationId,
                Number(id)
            ]
        );

        if (duplicateShiftResult.rows.length) {
            throw new Error(
                `Shift "${data.shift_name}" with type "${data.shift_type}" already exists for this work location`
            );
        }

        /* =====================================================
           UPDATE
        ===================================================== */

        /* ================= UPDATE ================= */

        const query = `
            UPDATE shift_configurations

            SET

                shift_name = COALESCE(
                    NULLIF($1::TEXT, ''),
                    shift_name
                ),

                shift_type = COALESCE(
                    NULLIF($2::TEXT, ''),
                    shift_type
                ),

                work_location = COALESCE(
                    $3::INTEGER,
                    work_location
                ),

                start_time = COALESCE(
                    $4::TIME,
                    start_time
                ),

                end_time = COALESCE(
                    $5::TIME,
                    end_time
                ),

                break_start_time = COALESCE(
                    $6::TIME,
                    break_start_time
                ),

                break_end_time = COALESCE(
                    $7::TIME,
                    break_end_time
                ),

                shift_reset_time = COALESCE(
                    $8::TIME,
                    shift_reset_time
                ),
            
                early_leave_count_time = COALESCE(
                    $9::INTEGER,
                    early_leave_count_time
                ),

                late_arrival_count_time = COALESCE(
                    $10::INTEGER,
                    late_arrival_count_time
                ),

                days = COALESCE(
                    $11::TEXT[],
                    days
                ),

                /* ================= EXISTING ================= */

                description = COALESCE(
                    $12::TEXT,
                    description
                ),

                status = COALESCE(
                    $13::BOOLEAN,
                    status
                ),

                updated_at = TIMEZONE(
                    'Asia/Kolkata',
                    CURRENT_TIMESTAMP
                )

            WHERE id = $14

            RETURNING *;
        `;

        const values = [

            trimString(data.shift_name) || null,

            trimString(data.shift_type) || null,

            workLocationId,

            data.start_time === undefined
                ? null
                : data.start_time,

            data.end_time === undefined
                ? null
                : data.end_time,

            data.break_start_time === undefined
                ? null
                : data.break_start_time,

            data.break_end_time === undefined
                ? null
                : data.break_end_time,

            data.shift_reset_time === undefined
                ? null
                : data.shift_reset_time,

            data.early_leave_count_time === undefined ||
                data.early_leave_count_time === null ||
                data.early_leave_count_time === ""
                ? null
                : Number(data.early_leave_count_time),

            data.late_arrival_count_time === undefined ||
                data.late_arrival_count_time === null ||
                data.late_arrival_count_time === ""
                ? null
                : Number(data.late_arrival_count_time),

            Array.isArray(data.days)
                ? data.days
                    .map(day =>
                        String(day)
                            .trim()
                            .toUpperCase()
                    )
                    .filter(Boolean)
                : null,

            /* ================= EXISTING ================= */

            data.description === undefined
                ? null
                : data.description,

            data.status === undefined
                ? null
                : data.status,

            Number(id)
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

/* =====================================================
   UPDATE SHIFT VALUES EVERYWHERE
===================================================== */
export const updateShiftEverywhere = async (
    oldShift,
    newShift
) => {

    const client = await pool.connect();

    try {

        await client.query("BEGIN");

        /* =====================================================
           FIELDS WHICH SHOULD BE SYNCED
        ===================================================== */

        const fields = [
            "shift_name",
            "shift_type",
            "start_time",
            "end_time",
            "break_start_time",
            "break_end_time",
            "shift_reset_time",
            "early_leave_count_time",
            "late_arrival_count_time",
            "days",
            "description",
            "created_by",
            "status",
            "work_location"
        ];

        /* =====================================================
           TIME FIELDS
        ===================================================== */

        const timeFields = [
            "start_time",
            "end_time",
            "break_start_time",
            "break_end_time",
            "shift_reset_time"
        ];

        /* =====================================================
           RESOLVE OLD WORK LOCATION ID
        ===================================================== */

        let oldLocationId = null;

        if (
            oldShift.work_location !== undefined &&
            oldShift.work_location !== null &&
            String(oldShift.work_location).trim() !== ""
        ) {

            const oldLocationValue =
                String(oldShift.work_location).trim();

            if (/^\d+$/.test(oldLocationValue)) {

                oldLocationId = Number(oldLocationValue);

            } else {

                const oldLocationResult =
                    await client.query(
                        `
                        SELECT id
                        FROM work_location
                        WHERE LOWER(
                            REPLACE(TRIM(location), ' ', '')
                        )
                        =
                        LOWER(
                            REPLACE(TRIM($1), ' ', '')
                        )
                        LIMIT 1
                        `,
                        [oldLocationValue]
                    );

                if (!oldLocationResult.rows.length) {
                    throw new Error(
                        `Old work location "${oldLocationValue}" not found`
                    );
                }

                oldLocationId =
                    oldLocationResult.rows[0].id;
            }
        }

        /* =====================================================
           RESOLVE NEW WORK LOCATION ID
        ===================================================== */

        let newLocationId = null;

        if (
            newShift.work_location !== undefined &&
            newShift.work_location !== null &&
            String(newShift.work_location).trim() !== ""
        ) {

            const newLocationValue =
                String(newShift.work_location).trim();

            if (/^\d+$/.test(newLocationValue)) {

                newLocationId = Number(newLocationValue);

            } else {

                const newLocationResult =
                    await client.query(
                        `
                        SELECT id
                        FROM work_location
                        WHERE LOWER(
                            REPLACE(TRIM(location), ' ', '')
                        )
                        =
                        LOWER(
                            REPLACE(TRIM($1), ' ', '')
                        )
                        LIMIT 1
                        `,
                        [newLocationValue]
                    );

                if (!newLocationResult.rows.length) {
                    throw new Error(
                        `New work location "${newLocationValue}" not found`
                    );
                }

                newLocationId =
                    newLocationResult.rows[0].id;
            }
        }

        /* =====================================================
           FIND TABLES
        ===================================================== */

        const tablesResult = await client.query(
            `
            SELECT
                table_schema,
                table_name,
                column_name,
                data_type,
                udt_name
            FROM information_schema.columns
            WHERE column_name = ANY($1)
              AND table_schema NOT IN (
                  'pg_catalog',
                  'information_schema'
              )
            ORDER BY
                table_schema,
                table_name;
            `,
            [fields]
        );

        /* =====================================================
           GROUP BY TABLE
        ===================================================== */

        const tableMap = {};

        for (const row of tablesResult.rows) {

            const key =
                `${row.table_schema}.${row.table_name}`;

            if (!tableMap[key]) {

                tableMap[key] = {
                    schema: row.table_schema,
                    table: row.table_name,
                    columns: []
                };
            }

            tableMap[key].columns.push({
                name: row.column_name,
                dataType: row.data_type,
                udtName: row.udt_name
            });
        }

        const updatedTables = [];

        /* =====================================================
           UPDATE EACH TABLE
        ===================================================== */

        for (const tableData of Object.values(tableMap)) {

            const {
                schema,
                table,
                columns
            } = tableData;

            const setParts = [];
            const whereParts = [];
            const values = [];

            let parameterIndex = 1;

            /* =================================================
               SET VALUES
            ================================================= */

            for (const column of columns) {

                const field = column.name;

                let oldValue =
                    oldShift[field];

                let newValue =
                    newShift[field];

                /* =================================================
                   TIME FIELD

                   IMPORTANT:
                   Only update TIME datatype.

                   Do NOT update:
                   timestamp
                   timestamptz
                   date
                ================================================= */

                if (timeFields.includes(field)) {

                    if (
                        column.dataType !==
                        "time without time zone" &&
                        column.dataType !==
                        "time with time zone"
                    ) {
                        continue;
                    }

                    if (
                        newValue !== undefined &&
                        newValue !== null &&
                        newValue !== ""
                    ) {
                        newValue =
                            String(newValue);
                    }

                    if (
                        oldValue !== undefined &&
                        oldValue !== null &&
                        oldValue !== ""
                    ) {
                        oldValue =
                            String(oldValue);
                    }
                }

                /* =================================================
                   WORK LOCATION
                ================================================= */

                if (field === "work_location") {

                    const isInteger =
                        [
                            "integer",
                            "bigint",
                            "smallint"
                        ].includes(column.dataType)
                        ||
                        [
                            "int2",
                            "int4",
                            "int8"
                        ].includes(column.udtName);

                    const isText =
                        [
                            "character varying",
                            "text",
                            "character"
                        ].includes(column.dataType);

                    if (isInteger) {

                        oldValue =
                            oldLocationId;

                        newValue =
                            newLocationId;

                    } else if (isText) {

                        if (oldLocationId !== null) {

                            const oldLocation =
                                await client.query(
                                    `
                                    SELECT location
                                    FROM work_location
                                    WHERE id = $1
                                    LIMIT 1
                                    `,
                                    [oldLocationId]
                                );

                            oldValue =
                                oldLocation.rows[0]?.location ??
                                null;
                        }

                        if (newLocationId !== null) {

                            const newLocation =
                                await client.query(
                                    `
                                    SELECT location
                                    FROM work_location
                                    WHERE id = $1
                                    LIMIT 1
                                    `,
                                    [newLocationId]
                                );

                            newValue =
                                newLocation.rows[0]?.location ??
                                null;
                        }
                    }
                }

                /* =================================================
                   DAYS

                   Support:
                   ["MON","TUE"]

                   and old DB VARCHAR/TEXT
                ================================================= */

                if (field === "days") {

                    if (column.udtName === "_text") {

                        if (Array.isArray(newValue)) {

                            newValue =
                                newValue
                                    .map(day =>
                                        String(day)
                                            .trim()
                                            .toUpperCase()
                                    )
                                    .filter(Boolean);

                        } else if (
                            typeof newValue === "string" &&
                            newValue.trim() !== ""
                        ) {

                            newValue =
                                newValue
                                    .replace(/[\[\]"]/g, "")
                                    .split(",")
                                    .map(day =>
                                        day
                                            .trim()
                                            .toUpperCase()
                                    )
                                    .filter(Boolean);
                        }

                        if (Array.isArray(oldValue)) {

                            oldValue =
                                oldValue
                                    .map(day =>
                                        String(day)
                                            .trim()
                                            .toUpperCase()
                                    )
                                    .filter(Boolean);
                        }
                    }

                    else if (
                        [
                            "character varying",
                            "text",
                            "character"
                        ].includes(column.dataType)
                    ) {

                        if (Array.isArray(newValue)) {

                            newValue =
                                newValue.join(",");

                        } else if (
                            newValue !== undefined &&
                            newValue !== null
                        ) {

                            newValue =
                                String(newValue);
                        }

                        if (Array.isArray(oldValue)) {

                            oldValue =
                                oldValue.join(",");
                        } else if (
                            oldValue !== undefined &&
                            oldValue !== null
                        ) {

                            oldValue =
                                String(oldValue);
                        }
                    }
                }

                /* =================================================
                   TEXT COLUMNS
                ================================================= */

                if (
                    [
                        "character varying",
                        "text",
                        "character"
                    ].includes(column.dataType)
                    &&
                    field !== "days"
                ) {

                    if (
                        newValue !== undefined &&
                        newValue !== null
                    ) {
                        newValue =
                            String(newValue);
                    }

                    if (
                        oldValue !== undefined &&
                        oldValue !== null
                    ) {
                        oldValue =
                            String(oldValue);
                    }
                }

                /* =================================================
                   BOOLEAN
                ================================================= */

                if (column.dataType === "boolean") {

                    if (
                        newValue !== undefined &&
                        newValue !== null
                    ) {

                        newValue =
                            newValue === true ||
                            newValue === "true";
                    }

                    if (
                        oldValue !== undefined &&
                        oldValue !== null
                    ) {

                        oldValue =
                            oldValue === true ||
                            oldValue === "true";
                    }
                }

                /* =================================================
                   INTEGER
                ================================================= */

                if (
                    [
                        "integer",
                        "bigint",
                        "smallint"
                    ].includes(column.dataType)
                ) {

                    if (
                        newValue !== undefined &&
                        newValue !== null &&
                        newValue !== ""
                    ) {

                        if (
                            !/^-?\d+$/.test(
                                String(newValue)
                            )
                        ) {
                            continue;
                        }

                        newValue =
                            Number(newValue);
                    }

                    if (
                        oldValue !== undefined &&
                        oldValue !== null &&
                        oldValue !== ""
                    ) {

                        if (
                            !/^-?\d+$/.test(
                                String(oldValue)
                            )
                        ) {
                            continue;
                        }

                        oldValue =
                            Number(oldValue);
                    }
                }

                /* =================================================
                   NEVER SYNC DATE / TIMESTAMP
                ================================================= */

                if (
                    column.dataType === "timestamp without time zone" ||
                    column.dataType === "timestamp with time zone" ||
                    column.dataType === "date"
                ) {
                    continue;
                }

                /* =================================================
                   UPDATE ONLY IF VALUE CHANGED
                ================================================= */

                if (
                    oldValue !== undefined &&
                    newValue !== undefined &&
                    String(oldValue ?? "") !==
                    String(newValue ?? "")
                ) {

                    setParts.push(
                        `"${field}" = $${parameterIndex}`
                    );

                    values.push(newValue);

                    parameterIndex++;
                }
            }

            /* =================================================
               NO SET
            ================================================= */

            if (!setParts.length) {
                continue;
            }

            /* =================================================
               WHERE VALUES
            ================================================= */

            for (const column of columns) {

                const field =
                    column.name;

                let oldValue =
                    oldShift[field];

                /* =================================================
                   DO NOT USE TIME FIELD AGAINST TIMESTAMP
                ================================================= */

                if (timeFields.includes(field)) {

                    if (
                        column.dataType !==
                        "time without time zone" &&
                        column.dataType !==
                        "time with time zone"
                    ) {
                        continue;
                    }

                    if (
                        oldValue !== undefined &&
                        oldValue !== null
                    ) {
                        oldValue =
                            String(oldValue);
                    }
                }

                /* =================================================
                   WORK LOCATION
                ================================================= */

                if (field === "work_location") {

                    const isInteger =
                        [
                            "integer",
                            "bigint",
                            "smallint"
                        ].includes(column.dataType)
                        ||
                        [
                            "int2",
                            "int4",
                            "int8"
                        ].includes(column.udtName);

                    if (isInteger) {

                        oldValue = oldLocationId;

                    } else if (
                        [
                            "character varying",
                            "text",
                            "character"
                        ].includes(column.dataType)
                    ) {

                        if (oldLocationId !== null) {
                            const oldLocation =
                                await client.query(
                                    `
                                    SELECT location
                                    FROM work_location
                                    WHERE id = $1
                                    LIMIT 1
                                    `,
                                    [oldLocationId]
                                );

                            oldValue = oldLocation.rows[0]?.location ?? null;
                        }
                    }
                }

                /* =================================================
                   DAYS
                ================================================= */
                if (field === "days") {
                    if (
                        column.udtName === "_text"
                    ) {
                        if (Array.isArray(oldValue)) {
                            oldValue =
                                oldValue
                                    .map(day =>
                                        String(day)
                                            .trim()
                                            .toUpperCase()
                                    )
                                    .filter(Boolean);
                        }

                    } else if (
                        [
                            "character varying",
                            "text",
                            "character"
                        ].includes(column.dataType)
                    ) {
                        if (Array.isArray(oldValue)) {
                            oldValue = oldValue.join(",");
                        }
                    }
                }

                /* =================================================
                   TEXT
                ================================================= */
                if (
                    [
                        "character varying",
                        "text",
                        "character"
                    ].includes(column.dataType)
                    &&
                    field !== "days"
                ) {
                    if (
                        oldValue !== undefined &&
                        oldValue !== null
                    ) {
                        oldValue = String(oldValue);
                    }
                }

                /* =================================================
                   INTEGER
                ================================================= */
                if (
                    [
                        "integer",
                        "bigint",
                        "smallint"
                    ].includes(column.dataType)
                ) {
                    if (
                        oldValue !== undefined &&
                        oldValue !== null &&
                        oldValue !== ""
                    ) {
                        if (
                            !/^-?\d+$/.test(
                                String(oldValue)
                            )
                        ) {
                            continue;
                        }

                        oldValue = Number(oldValue);
                    }
                }

                /* =================================================
                   BOOLEAN
                ================================================= */
                if (column.dataType === "boolean") {
                    if (
                        oldValue !== undefined &&
                        oldValue !== null
                    ) {

                        oldValue =
                            oldValue === true ||
                            oldValue === "true";
                    }
                }

                /* =================================================
                   NEVER USE DATE / TIMESTAMP
                ================================================= */
                if (
                    column.dataType === "timestamp without time zone" ||
                    column.dataType === "timestamp with time zone" ||
                    column.dataType === "date"
                ) {
                    continue;
                }

                /* =================================================
                   WHERE
                ================================================= */
                if (oldValue !== undefined) {
                    whereParts.push(
                        `"${field}" IS NOT DISTINCT FROM $${parameterIndex}`
                    );

                    values.push(oldValue);

                    parameterIndex++;
                }
            }

            /* =================================================
               NO WHERE
            ================================================= */
            if (!whereParts.length) {
                continue;
            }

            /* =================================================
               EXECUTE
            ================================================= */
            const query = `
                UPDATE "${schema}"."${table}"
                SET
                    ${setParts.join(", ")}
                WHERE
                    ${whereParts.join(" AND ")}
            `;

            const result =
                await client.query(
                    query,
                    values
                );

            if (result.rowCount > 0) {
                updatedTables.push({
                    table: `${schema}.${table}`,
                    rowsUpdated: result.rowCount,

                    updatedFields:
                        setParts.map(
                            part =>
                                part
                                    .split(" = ")[0]
                                    .replaceAll('"', "")
                        )
                });
            }
        }

        /* =====================================================
           COMMIT
        ===================================================== */
        await client.query("COMMIT");

        return {
            oldShift,
            newShift,
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
export const toggleShiftStatusModel = async (id) => {
    /* ================= CHECK SHIFT ================= */
    const shiftResult = await pool.query(
        `
        SELECT *
        FROM shift_configurations
        WHERE id = $1
        `,
        [id]
    );

    if (!shiftResult.rows.length) {
        return null;
    }

    const shift = shiftResult.rows[0];

    /* =====================================================
       IF SHIFT IS CURRENTLY ACTIVE
       CHECK WHETHER IT IS USED BY ANY EMPLOYEE
    ===================================================== */
    if (shift.status === true) {
        const usedShiftResult = await pool.query(
            `
            SELECT
                COUNT(*)::INT AS count
            FROM employee_payroll_config
            WHERE shift_id = $1
            `,
            [id]
        );

        const usedCount =
            Number(usedShiftResult.rows[0]?.count || 0);

        /* ================= PREVENT DEACTIVATION ================= */
        if (usedCount > 0) {
            return {
                blocked: true,
                used_count: usedCount,
                message: `This shift is currently used by ${usedCount} employee(s), so it cannot be deactivated.`
            };
        }
    }

    /* ================= TOGGLE STATUS ================= */
    const newStatus = !shift.status;
    const result = await pool.query(
        `
        UPDATE shift_configurations
        SET
            status = $1,
            updated_at = TIMEZONE(
                'Asia/Kolkata',
                CURRENT_TIMESTAMP
            )
        WHERE id = $2
        RETURNING *;
        `,
        [newStatus, id]
    );

    return result.rows[0];
};