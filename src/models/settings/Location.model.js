import { pool } from "../../database.js";

/* ================= CREATE LOCATION TABLE ================= */
export const initializeLocationTable = async () => {

  const query = `
    CREATE TABLE IF NOT EXISTS work_location(
      id SERIAL PRIMARY KEY,
      location VARCHAR(255) NOT NULL,
      address TEXT,
      city VARCHAR(255),
      state VARCHAR(255),
      zip VARCHAR(50),
      created_by VARCHAR(255),
      status BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP),
      updated_at TIMESTAMP DEFAULT TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
    )
  `;

  await pool.query(query);

  await pool.query(`
        SELECT setval(
            pg_get_serial_sequence('work_location', 'id'),
            COALESCE((SELECT MAX(id) FROM work_location), 1),
            true
        );
    `);

  console.log("✅ location table ready");
};

/* ================= INSERT LOCATION ================= */
export const locationItems = async (data) => {
  const query = `
    INSERT INTO work_location
    (
      location,
      address,
      city,
      state,
      zip,
      created_by,
      status
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    RETURNING *;
  `;

  const values = [
    data.location,
    data.address || null,
    data.city || null,
    data.state || null,
    data.zip || null,
    data.created_by || null,
    data.status ?? true,
  ];

  const { rows } = await pool.query(query, values);
  return rows[0];
};

/* ================= GET ALL LOCATION ================= */
export const GetLocation = async (status = null) => {
  let query = `
    SELECT *
    FROM work_location
    WHERE 1=1
  `;

  const values = [];
  let count = 1;

  /* ================= STATUS FILTER ================= */
  if (status !== null && status !== undefined) {
    query += ` AND status = $${count}`;
    values.push(status); // already boolean
    count++;
  }

  query += ` ORDER BY location ASC`;

  const { rows } = await pool.query(query, values);
  return rows;
};

/* =========================================================
   GET WORK LOCATION ID BY LOCATION NAME
========================================================= */
export const getWorkLocationIdByNameModel = async (locationName) => {
    if (!locationName) {
        return null;
    }

    const query = `
        SELECT id
        FROM work_location
        WHERE LOWER(TRIM(location)) = LOWER(TRIM($1))
        LIMIT 1;
    `;

    const result = await pool.query(query, [locationName]);

    return result.rows[0]?.id || null;
};

/* ================= UPDATE LOCATION ================= */
export const updateLocationById = async (id, data) => {
  const query = `
    UPDATE work_location
    SET
      location = COALESCE(NULLIF($1, ''), location),
      address = COALESCE($2, address),
      city = COALESCE($3, city),
      state = COALESCE($4, state),
      zip = COALESCE($5, zip),
      created_by = COALESCE($6, created_by),
      status = COALESCE($7, status),
      updated_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
    WHERE id = $8
    RETURNING *
  `;

  const values = [
    data.location?.trim() || null,
    data.address === undefined ? null : data.address,
    data.city === undefined ? null : data.city,
    data.state === undefined ? null : data.state,
    data.zip === undefined ? null : data.zip,
    data.created_by === undefined ? null : data.created_by,
    data.status === undefined ? null : data.status,
    id
  ];

  const result = await pool.query(query, values);
  return result.rows[0];
};

/* ================= UPDATE LOCATION EVERYWHERE ================= */
export const updateWorkLocationEverywhere = async (
    locationId,
    oldLocation,
    newLocation
) => {

    const client = await pool.connect();

    try {

        /* ================= VALIDATION ================= */

        const numericLocationId = Number(locationId);
        const hasLocationId =
            Number.isInteger(numericLocationId) &&
            numericLocationId > 0;

        if (
            typeof oldLocation !== "string" ||
            !oldLocation.trim()
        ) {
            throw new Error("Old work location is required");
        }

        if (
            typeof newLocation !== "string" ||
            !newLocation.trim()
        ) {
            throw new Error("New work location is required");
        }

        const cleanOldLocation = oldLocation.trim();
        const cleanNewLocation = newLocation.trim();

        /* ================= SAME NAME CHECK ================= */

        if (
            cleanOldLocation.toLowerCase() ===
            cleanNewLocation.toLowerCase()
        ) {
            throw new Error(
                `New work location "${cleanNewLocation}" is same as old work location`
            );
        }

        await client.query("BEGIN");

        /* =====================================================
           1. FIND EXISTING LOCATION BY ID (preferred) OR NAME
        ===================================================== */

        const locationResult = await client.query(
            hasLocationId
                ? `
                    SELECT
                        id,
                        location
                    FROM work_location
                    WHERE id = $1
                    LIMIT 1
                `
                : `
                    SELECT
                        id,
                        location
                    FROM work_location
                    WHERE LOWER(TRIM(location))
                        = LOWER(TRIM($1))
                    LIMIT 1
                `,
            hasLocationId
                ? [numericLocationId]
                : [cleanOldLocation]
        );

        if (locationResult.rows.length === 0) {
            throw new Error(
                `Work location "${cleanOldLocation}" not found`
            );
        }

        const id = locationResult.rows[0].id;
        const actualOldLocation = locationResult.rows[0].location;

        /* =====================================================
           2. CHECK NEW LOCATION ALREADY EXISTS
        ===================================================== */

        const duplicateResult = await client.query(
            `
            SELECT
                id,
                location
            FROM work_location
            WHERE LOWER(TRIM(location))
                = LOWER(TRIM($1))
              AND id <> $2
            LIMIT 1
            `,
            [cleanNewLocation, id]
        );

        if (duplicateResult.rows.length > 0) {

            throw new Error(
                `Work location "${duplicateResult.rows[0].location}" already exists`
            );
        }

        /* =====================================================
           3. UPDATE LOCATION
        ===================================================== */

        const updateResult = await client.query(
            `
            UPDATE work_location
            SET
                location = $1,
                updated_at = TIMEZONE(
                    'Asia/Kolkata',
                    CURRENT_TIMESTAMP
                )
            WHERE id = $2
            RETURNING
                id,
                location
            `,
            [
                cleanNewLocation,
                id
            ]
        );

        if (updateResult.rows.length === 0) {
            throw new Error(
                `Failed to update work location "${actualOldLocation}"`
            );
        }

        await client.query("COMMIT");

        return {
            oldLocation: actualOldLocation,
            newLocation: updateResult.rows[0].location,
            locationId: id,
            updated: true
        };

    } catch (error) {

        await client.query("ROLLBACK");
        throw error;

    } finally {

        client.release();
    }
};

/* ================= TOGGLE LOCATION STATUS ================= */
export const toggleLocationStatusModel = async (id) => {

    /* ================= GET LOCATION ================= */

    const locationRes = await pool.query(
        `
        SELECT
            id,
            location,
            status
        FROM work_location
        WHERE id = $1
        `,
        [id]
    );

    if (!locationRes.rows.length) {
        return null;
    }

    const locationData = locationRes.rows[0];

    /* =====================================================
       IF LOCATION IS ACTIVE
       CHECK WHETHER IT IS USED BY ANY EMPLOYEE
    ===================================================== */

    if (locationData.status === true) {

        const usedResult = await pool.query(
            `
            SELECT
                COUNT(*)::INT AS count
            FROM employment_details
            WHERE work_location IS NOT NULL
              AND TRIM(work_location::TEXT) =
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
                    `This work location is currently used by ${usedCount} employee(s), so it cannot be deactivated.`
            };
        }
    }

    /* ================= TOGGLE ================= */

    const newStatus = !locationData.status;

    const result = await pool.query(
        `
        UPDATE work_location
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