import { pool } from "../../database.js";

/* ================= CREATE TABLE ================= */
export const initializeDepartmentStructureTable = async () => {
    const query = `
        CREATE TABLE IF NOT EXISTS department_structure (
            id SERIAL PRIMARY KEY,
            parent_id INTEGER NULL,
            name VARCHAR(255) NOT NULL,
            description TEXT,
            username VARCHAR(255),
            is_active BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMP DEFAULT TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP),
            updated_at TIMESTAMP DEFAULT TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP),
            CONSTRAINT fk_department_parent
                FOREIGN KEY (parent_id)
                REFERENCES department_structure(id)
                ON DELETE CASCADE
        );
    `;

    await pool.query(query);

    await pool.query(`
        ALTER TABLE department_structure
        ADD COLUMN IF NOT EXISTS work_location VARCHAR(255);

        ALTER TABLE department_structure
        ADD COLUMN IF NOT EXISTS username VARCHAR(255);
    `);

    await pool.query(`
        UPDATE department_structure ds
        SET work_location = wl.id
        FROM work_location wl
        WHERE
            ds.work_location IS NOT NULL
            AND TRIM(ds.work_location::TEXT) <> ''
            AND LOWER(TRIM(ds.work_location::TEXT))
                = LOWER(TRIM(wl.location));
    `);

    await pool.query(`
        DO $$
        BEGIN

            IF EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'department_structure'
                  AND column_name = 'work_location'
                  AND data_type = 'character varying'
            ) THEN

                ALTER TABLE department_structure
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
            pg_get_serial_sequence('department_structure', 'id'),
            COALESCE((SELECT MAX(id) FROM department_structure), 1),
            true
        );
    `);

    console.log("✅ department_structure table ready");
};

/* ================= ADD ================= */
export const addDepartmentStructureModel = async ({
    parent_id,
    name,
    work_location,
    description,
    is_active,
    username
}) => {

    let locationId = null;

    /* =====================================================
       WORK LOCATION
       Supports:
       1. ID   -> 1
       2. NAME -> ACDC TECH
       3. NAME -> EMBLEPCB
       4. NULL
    ===================================================== */

    if (
        work_location !== null &&
        work_location !== undefined &&
        String(work_location).trim() !== "" &&
        String(work_location).trim().toLowerCase() !== "null" &&
        String(work_location).trim().toLowerCase() !== "undefined" &&
        String(work_location).trim().toLowerCase() !== "nan"
    ) {

        const locationValue =
            String(work_location).trim();

        const parsedLocationId =
            Number(locationValue);

        /* =================================================
           CASE 1: WORK LOCATION ID
        ================================================= */

        if (
            Number.isInteger(parsedLocationId) &&
            parsedLocationId > 0
        ) {

            const locationResult =
                await pool.query(
                    `
                        SELECT id
                        FROM work_location
                        WHERE id = $1
                        LIMIT 1
                    `,
                    [parsedLocationId]
                );

            if (!locationResult.rows.length) {
                throw new Error(
                    `Work location ID "${parsedLocationId}" not found`
                );
            }

            locationId =
                locationResult.rows[0].id;
        }

        /* =================================================
           CASE 2: WORK LOCATION NAME
        ================================================= */

        else {

            const locationResult =
                await pool.query(
                    `
                        SELECT id
                        FROM work_location
                        WHERE LOWER(TRIM(location))
                            =
                            LOWER(TRIM($1))
                        LIMIT 1
                    `,
                    [locationValue]
                );

            if (!locationResult.rows.length) {
                throw new Error(
                    `Work location "${locationValue}" not found`
                );
            }

            locationId =
                locationResult.rows[0].id;
        }
    }

    /* =====================================================
       INSERT
    ===================================================== */

    const { rows } = await pool.query(
        `
            INSERT INTO department_structure (
                parent_id,
                name,
                work_location,
                description,
                is_active,
                username
            )
            VALUES (
                $1,
                $2,
                $3,
                $4,
                $5,
                $6
            )
            RETURNING *;
        `,
        [
            parent_id || null,
            name?.trim(),
            locationId,
            description?.trim() || null,
            is_active ?? true,
            username || null
        ]
    );

    return rows[0];
};

/* ================= GET ALL ================= */
export const getAllDepartmentStructureModel = async (
    departmentName = null,
    childName = null,
    work_location = null
) => {

    let query = `
        SELECT
            ds.id,
            ds.parent_id,
            ds.name,
            ds.description,
            ds.is_active,

            /* ================= WORK LOCATION ================= */
            ds.work_location AS work_location_id,
            wl.location AS work_location,

            /* ================= DESIGNATION COUNT ================= */
            (
                SELECT COUNT(*)
                FROM department_structure designation
                WHERE designation.parent_id = ds.id
                  AND designation.is_active = true
            ) AS designation_count,

            ds.created_at,
            ds.updated_at

        FROM department_structure ds

        LEFT JOIN work_location wl
            ON wl.id = ds.work_location

        WHERE 1 = 1
    `;

    const values = [];
    let count = 1;

    /* ================= WORK LOCATION FILTER ================= */
    if (
        work_location !== null &&
        work_location !== undefined &&
        String(work_location).trim() !== "" &&
        String(work_location).trim().toLowerCase() !== "nan" &&
        String(work_location).trim().toLowerCase() !== "null" &&
        String(work_location).trim().toLowerCase() !== "undefined"
    ) {

        const locationValue = String(work_location).trim();
        const locationId = Number(locationValue);

        /* ================= LOCATION ID ================= */
        if (
            Number.isInteger(locationId) &&
            locationId > 0
        ) {
            query += `
                AND ds.work_location = $${count}
            `;

            values.push(locationId);
            count++;

        }

        /* ================= LOCATION NAME ================= */
        else {
            query += `
                AND LOWER(TRIM(wl.location))
                    =
                    LOWER(TRIM($${count}))
            `;

            values.push(locationValue);
            count++;
        }
    }

    /* ================= ORDER ================= */
    query += `
        ORDER BY ds.id ASC
    `;

    const { rows } = await pool.query(
        query,
        values
    );

    /* =====================================================
       BUILD TREE
    ===================================================== */
    const buildTree = (items, parentId) => {
        return items
            .filter(item =>
                item.parent_id === parentId
            )
            .map(item => ({
                ...item,
                children: buildTree(
                    items,
                    item.id
                )
            }));
    };

    /* =====================================================
       ROOT DEPARTMENT
    ===================================================== */
    const root = departmentName
        ? rows.find(
            d =>
                String(d.name || "")
                    .trim()
                    .toLowerCase()
                ===
                String(departmentName)
                    .trim()
                    .toLowerCase()
        )
        : null;

    /* =====================================================
       NO ROOT FILTER
    ===================================================== */
    if (!root) {
        return buildTree(
            rows,
            null
        );
    }

    /* =====================================================
       ROOT TREE
    ===================================================== */
    const tree = {
        ...root,
        children: buildTree(
            rows,
            root.id
        )
    };

    /* =====================================================
       CHILD FILTER
    ===================================================== */
    if (childName) {
        const findNode = (
            node,
            name
        ) => {

            if (
                String(node.name || "")
                    .trim()
                    .toLowerCase()
                ===
                String(name)
                    .trim()
                    .toLowerCase()
            ) {
                return node;
            }

            for (
                const child
                of node.children || []
            ) {
                const found =
                    findNode(
                        child,
                        name
                    );

                if (found) {
                    return found;
                }
            }
            return null;
        };

        return (
            findNode(
                tree,
                childName
            ) || null
        );
    }

    return tree;
};

/* =========================================================
   GET DEPARTMENT STRUCTURE ID
========================================================= */
export const getDepartmentStructureId = async (
    value,
    workLocationId = null,
    parentId = null
) => {
    if (
        value === undefined ||
        value === null ||
        String(value).trim() === ""
    ) {
        return null;
    }

    const inputValue = String(value).trim();

    /* =====================================================
       IF ID IS PASSED
    ===================================================== */
    if (/^\d+$/.test(inputValue)) {
        const { rows } = await pool.query(
            `
                SELECT id
                FROM department_structure
                WHERE id = $1
                  AND is_active = TRUE
                LIMIT 1
            `,
            [Number(inputValue)]
        );

        if (!rows.length) {
            throw new Error(
                `Department structure not found: "${inputValue}"`
            );
        }

        return rows[0].id;
    }

    /* =====================================================
       FIND BY NAME
    ===================================================== */
    const { rows } = await pool.query(
        `
            SELECT
                ds.id,
                ds.name,
                ds.work_location,
                ds.parent_id
            FROM department_structure ds
            WHERE
                LOWER(
                    REGEXP_REPLACE(
                        TRIM(ds.name),
                        '\\s+',
                        ' ',
                        'g'
                    )
                )
                =
                LOWER(
                    REGEXP_REPLACE(
                        TRIM($1),
                        '\\s+',
                        ' ',
                        'g'
                    )
                )

                AND ds.is_active = TRUE

                AND (
                    $2::INTEGER IS NULL
                    OR ds.work_location = $2
                )

                AND (
                    $3::INTEGER IS NULL
                    OR ds.parent_id = $3
                )

            ORDER BY ds.id
            LIMIT 1
        `,
        [
            inputValue,
            workLocationId || null,
            parentId || null
        ]
    );

    if (!rows.length) {
        throw new Error(
            `Designation not found: "${inputValue}"`
        );
    }

    return rows[0].id;
};

/* ================= GET BY ID ================= */
export const getDepartmentStructureByIdModel = async (
    id
) => {

    const { rows } = await pool.query(`
        SELECT
            ds.id,
            ds.parent_id,
            ds.name,
            ds.description,
            ds.is_active,

            /* ================= WORK LOCATION ================= */

            ds.work_location AS work_location_id,
            wl.location AS work_location,

            ds.created_at,
            ds.updated_at

        FROM department_structure ds

        LEFT JOIN work_location wl
            ON wl.id = ds.work_location

        ORDER BY ds.id ASC
    `);

    /* =====================================================
       BUILD TREE
    ===================================================== */

    const buildTree = (
        items,
        parentId
    ) => {

        return items
            .filter(item =>
                item.parent_id === parentId
            )
            .map(item => ({
                ...item,
                children: buildTree(
                    items,
                    item.id
                )
            }));
    };

    /* =====================================================
       FIND DEPARTMENT
    ===================================================== */

    const department = rows.find(
        item =>
            item.id === Number(id)
    );

    if (!department) {
        return null;
    }

    return {
        ...department,

        children: buildTree(
            rows,
            department.id
        )
    };
};


/* ================= GET SUB DEPARTMENTS ================= */
export const getSubDepartmentsModel = async (
    department
) => {

    const { rows } = await pool.query(
        `
            SELECT

                /* ================= CHILD ================= */

                child.id,

                child.name AS sub_department,

                child.description,

                child.is_active,

                /* ================= WORK LOCATION ================= */

                child.work_location
                    AS work_location_id,

                wl.location
                    AS work_location

            FROM department_structure parent

            INNER JOIN department_structure child
                ON child.parent_id = parent.id

            LEFT JOIN work_location wl
                ON wl.id = child.work_location

            WHERE LOWER(TRIM(parent.name))
                =
                LOWER(TRIM($1))

              AND child.is_active = TRUE

            ORDER BY child.name ASC;
        `,
        [department]
    );

    return rows;
};

/* ================= UPDATE ================= */
export const updateDepartmentStructureModel = async (
    id,
    {
        parent_id,
        name,
        work_location,
        description,
        is_active,
        username
    }
) => {

    let locationId = null;

    /* =====================================================
       WORK LOCATION
       Supports:
       1. ID      -> 1
       2. NAME    -> ACDC TECH
       3. NAME    -> EMBLEPCB
       4. NULL
    ===================================================== */

    if (
        work_location !== null &&
        work_location !== undefined &&
        String(work_location).trim() !== "" &&
        String(work_location).trim().toLowerCase() !== "null" &&
        String(work_location).trim().toLowerCase() !== "undefined"
    ) {

        const locationValue = String(work_location).trim();

        const parsedLocationId = Number(locationValue);

        /* ================= ID ================= */

        if (
            Number.isInteger(parsedLocationId) &&
            parsedLocationId > 0
        ) {

            /* Verify ID exists */
            const locationResult = await pool.query(
                `
                    SELECT id
                    FROM work_location
                    WHERE id = $1
                    LIMIT 1
                `,
                [parsedLocationId]
            );

            if (!locationResult.rows.length) {
                throw new Error("Work location not found");
            }

            locationId = parsedLocationId;

        }

        /* ================= LOCATION NAME ================= */

        else {

            const locationResult = await pool.query(
                `
                    SELECT id
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

            locationId = locationResult.rows[0].id;
        }
    }

    /* =====================================================
       UPDATE
    ===================================================== */

    const { rows } = await pool.query(
        `
            UPDATE department_structure
            SET
                parent_id = $1,
                name = $2,
                work_location = $3,
                description = $4,
                is_active = $5,
                username = COALESCE($6, username),
                updated_at = TIMEZONE(
                    'Asia/Kolkata',
                    CURRENT_TIMESTAMP
                )
            WHERE id = $7
            RETURNING *;
        `,
        [
            parent_id || null,
            name?.trim(),
            locationId,
            description || null,
            is_active ?? true,
            username || null,
            id
        ]
    );

    return rows[0];
};

/* =====================================================
   UPDATE DEPARTMENT NAME EVERYWHERE
===================================================== */
export const updateDepartmentEverywhere = async (
    oldDepartmentName,
    newDepartmentName
) => {

    const client = await pool.connect();

    try {

        await client.query("BEGIN");

        /* =====================================================
           VALIDATION
        ===================================================== */

        const oldName = oldDepartmentName?.trim();
        const newName = newDepartmentName?.trim();

        if (!oldName || !newName) {
            throw new Error(
                "Old department name and new department name are required"
            );
        }

        /* =====================================================
           COLUMNS TO UPDATE
        ===================================================== */

        const fields = [
            "designation",
            "department",
            "sub_department"
        ];

        /* =====================================================
           FIND ALL TABLES HAVING THESE COLUMNS
        ===================================================== */

        const tablesResult = await client.query(
            `
                SELECT
                    table_schema,
                    table_name,
                    column_name,
                    data_type
                FROM information_schema.columns

                WHERE column_name = ANY($1)

                AND table_schema NOT IN (
                    'pg_catalog',
                    'information_schema'
                )

                /* Don't update this master table */
                AND NOT (
                    table_schema = 'public'
                    AND table_name = 'department_structure'
                )

                ORDER BY
                    table_schema,
                    table_name,
                    column_name;
            `,
            [fields]
        );

        const updatedTables = [];

        /* =====================================================
           UPDATE EACH TABLE / COLUMN
        ===================================================== */

        for (const row of tablesResult.rows) {

            const schema = row.table_schema;
            const tableName = row.table_name;
            const columnName = row.column_name;

            /* =================================================
               ONLY UPDATE TEXT COLUMNS
            ================================================= */

            if (
                ![
                    "character varying",
                    "character",
                    "text"
                ].includes(row.data_type)
            ) {
                continue;
            }

            const result = await client.query(
                `
                    UPDATE "${schema}"."${tableName}"

                    SET
                        "${columnName}" = $1

                    WHERE
                        LOWER(TRIM("${columnName}"::TEXT))
                        =
                        LOWER(TRIM($2::TEXT))
                `,
                [
                    newName,
                    oldName
                ]
            );

            /* =================================================
               STORE UPDATE INFORMATION
            ================================================= */

            if (result.rowCount > 0) {

                updatedTables.push({
                    table: `${schema}.${tableName}`,
                    column: columnName,
                    rowsUpdated: result.rowCount
                });
            }
        }

        /* =====================================================
           COMMIT
        ===================================================== */

        await client.query("COMMIT");

        return {
            success: true,
            oldDepartmentName: oldName,
            newDepartmentName: newName,
            updatedTables
        };

    } catch (error) {

        /* =====================================================
           ROLLBACK
        ===================================================== */

        await client.query("ROLLBACK");

        throw error;

    } finally {

        client.release();
    }
};

/* ================= TOGGLE DEPARTMENT STATUS ================= */
export const toggleDepartmentStructureStatusModel = async (id) => {

    /* ================= GET DEPARTMENT ================= */

    const departmentResult = await pool.query(
        `
        SELECT
            id,
            parent_id,
            name,
            is_active,
            work_location
        FROM department_structure
        WHERE id = $1
        `,
        [id]
    );

    if (!departmentResult.rows.length) {
        return null;
    }

    const department = departmentResult.rows[0];

    /* =====================================================
       ONLY CHECK WHEN DEACTIVATING
       true -> false
    ===================================================== */

    if (department.is_active === true) {

        const childUsageResult = await pool.query(
            `
            SELECT
                ds.id,
                ds.name,
                COUNT(DISTINCT ed.id)::INT AS used_count

            FROM department_structure ds

            INNER JOIN employment_details ed
                ON (
                    ed.department = ds.id
                    OR ed.sub_department = ds.id
                    OR ed.designation = ds.id
                )

            WHERE ds.parent_id = $1

            GROUP BY
                ds.id,
                ds.name

            HAVING COUNT(DISTINCT ed.id) > 0

            ORDER BY ds.id
            `,
            [id]
        );

        if (childUsageResult.rows.length > 0) {

            const usedChildren =
                childUsageResult.rows.map(row => ({
                    id: row.id,
                    name: row.name,
                    used_count: Number(row.used_count)
                }));

            return {
                blocked: true,
                reason: "SUB_DEPARTMENT_IN_USE",
                message:
                    `Department "${department.name}" cannot be deactivated because its sub-department(s) are currently being used by employee(s).`,
                used_children: usedChildren
            };
        }

        const employeeUsageResult = await pool.query(
            `
            SELECT
                COUNT(DISTINCT ed.id)::INT AS count
            FROM employment_details ed

            WHERE
                ed.department = $1
                OR ed.sub_department = $1
                OR ed.designation = $1
            `,
            [id]
        );

        const usedCount =
            Number(employeeUsageResult.rows[0]?.count || 0);

        if (usedCount > 0) {

            return {
                blocked: true,
                reason: "DEPARTMENT_IN_USE",
                used_count: usedCount,
                message:
                    `"${department.name}" is currently used by ${usedCount} employee(s), so it cannot be deactivated.`
            };
        }
    }


    /* ================= TOGGLE ================= */

    const newStatus = !department.is_active;

    const updateResult = await pool.query(
        `
        UPDATE department_structure
        SET
            is_active = $1,
            updated_at = TIMEZONE(
                'Asia/Kolkata',
                CURRENT_TIMESTAMP
            )
        WHERE id = $2

        RETURNING *;
        `,
        [newStatus, id]
    );

    return updateResult.rows[0];
};

/* ================= DELETE ================= */
export const deleteDepartmentStructureModel = async (id) => {

    // Check if department has child departments
    const { rows: children } = await pool.query(
        `
        SELECT id
        FROM department_structure
        WHERE parent_id = $1
        LIMIT 1;
        `,
        [id]
    );

    if (children.length > 0) {
        throw new Error(
            "Cannot delete this department because it has child departments."
        );
    }

    // Delete department
    const { rows } = await pool.query(
        `
        DELETE FROM department_structure
        WHERE id = $1
        RETURNING *;
        `,
        [id]
    );

    return rows[0];
};

export const getActiveUsersWorkEmailModel = async ({
    name = null,
    work_location = null,
    department = null,
    work_email = null,
    usernames = null
} = {}) => {
    const nameValue =
        name == null || String(name).trim() === ""
            ? null
            : `%${String(name).trim().toLowerCase()}%`;

    const locationValue =
        work_location == null ||
        String(work_location).trim() === "" ||
        String(work_location).trim().toLowerCase() === "all"
            ? null
            : String(work_location).trim();

    const getSearchValue = (value, matchId = false) => {
        if (
            value == null ||
            String(value).trim() === "" ||
            String(value).trim().toLowerCase() === "all"
        ) {
            return null;
        }

        const searchValue = String(value).trim().toLowerCase();
        return matchId && /^\d+$/.test(searchValue)
            ? searchValue
            : `%${searchValue}%`;
    };

    const departmentValue =
        department == null ||
        String(department).trim() === "" ||
        String(department).trim().toLowerCase() === "all"
            ? null  
            : String(department).trim();
    const workEmailValue = getSearchValue(work_email);

    const usernameList = Array.isArray(usernames)
        ? [...new Set(
            usernames
                .map(username => String(username || "").trim().toLowerCase())
                .filter(Boolean)
        )]
        : null;

    if (usernameList?.length === 0) {
        return [];
    }

    const { rows } = await pool.query(`
        SELECT
            ds.id AS department_id,
            ds.name AS department_name,

            COALESCE(
                NULLIF(TRIM(ed.username), ''),
                pd.username
            ) AS username,

            NULLIF(
                TRIM(CONCAT_WS(' ', pd.first_name, pd.middle_name, pd.last_name)),
                ''
            ) AS name,

            NULLIF(TRIM(pd.first_name), '') AS first_name,
            NULLIF(TRIM(pd.middle_name), '') AS middle_name,
            NULLIF(TRIM(pd.last_name), '') AS last_name,

            CASE
                WHEN NULLIF(TRIM(pd.image), '') IS NOT NULL
                THEN TRIM(pd.image)
                ELSE NULLIF(TRIM(c.category_image), '')
            END AS image,

            NULLIF(TRIM(ed.company_mobile_number), '') AS company_mobile_number,
            NULLIF(TRIM(ed.employment_id), '') AS employment_id,

            ed.designation AS designation_id,
            NULLIF(TRIM(dsg.name), '') AS designation,

            NULLIF(TRIM(ed.work_email), '') AS work_email,

            ed.work_location AS work_location_id,
            NULLIF(TRIM(wl.location), '') AS work_location

        FROM employment_details ed

        INNER JOIN personal_details pd
            ON pd.id = ed.personal_details_id

        INNER JOIN master_employee me
            ON me.personal_details_id = pd.id

        INNER JOIN department_structure ds
            ON ds.id = ed.department

        LEFT JOIN department_structure dsg
            ON dsg.id = ed.designation

        LEFT JOIN work_location wl
            ON wl.id = ed.work_location

        LEFT JOIN category c
            ON c.id = ed.category

        WHERE LOWER(TRIM(COALESCE(me.status, ''))) = 'active'

          AND (
                $1::TEXT IS NULL
                OR LOWER(TRIM(CONCAT_WS(
                    ' ', pd.first_name, pd.middle_name, pd.last_name
                ))) LIKE $1
                OR LOWER(COALESCE(
                    NULLIF(TRIM(ed.username), ''), pd.username
                )) LIKE $1
                OR LOWER(COALESCE(pd.first_name, '')) LIKE $1
                OR LOWER(COALESCE(pd.middle_name, '')) LIKE $1
                OR LOWER(COALESCE(pd.last_name, '')) LIKE $1
          )

          AND (
                $2::TEXT IS NULL
                OR (
                    $2::TEXT ~ '^[0-9]+$'
                    AND wl.id = $2::INTEGER
                )
                OR LOWER(TRIM(wl.location)) = LOWER(TRIM($2::TEXT))
          )

          AND (
                $3::TEXT[] IS NULL
                OR LOWER(TRIM(
                    COALESCE(NULLIF(TRIM(ed.username), ''), pd.username)
                )) = ANY($3::TEXT[])
          )

          AND (
                $4::TEXT IS NULL
                OR (
                    $4::TEXT ~ '^[0-9]+$'
                    AND (
                        ds.id::TEXT = $4
                        OR dsg.id::TEXT = $4
                    )
                )
                OR LOWER(TRIM(ds.name)) = LOWER(TRIM($4))
                OR LOWER(TRIM(dsg.name)) = LOWER(TRIM($4))
          )

          AND (
                $5::TEXT IS NULL
                OR LOWER(TRIM(COALESCE(ed.work_email, ''))) LIKE $5
          )

        ORDER BY
            CASE
                WHEN NULLIF(TRIM(ed.employment_id), '') IS NULL THEN 1
                ELSE 0
            END ASC,
            UPPER(TRIM(ed.employment_id)) ASC;
    `, [
        nameValue,
        locationValue,
        usernameList,
        departmentValue,
        workEmailValue
    ]);

    return rows.map(row => ({
        username: row.username,
        name: row.name,
        first_name: row.first_name,
        middle_name: row.middle_name,
        last_name: row.last_name,
        image: row.image,
        company_mobile_number: row.company_mobile_number,
        employment_id: row.employment_id,
        department_id: row.department_id,
        department: row.department_name,
        designation_id: row.designation_id,
        designation: row.designation,
        work_email: row.work_email,
        work_location: row.work_location
    }));
};
