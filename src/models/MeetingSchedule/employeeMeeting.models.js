import { pool } from "../../database.js";

/* =========================================================
   INITIALIZE EMPLOYEE MEETING TABLE
========================================================= */

export const initializeEmployeeMeetingTable = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS employee_meeting (
                id SERIAL PRIMARY KEY,
                meeting_type VARCHAR(100),
                cancelled_meeting_id INTEGER,
                work_location INTEGER,
                date DATE NOT NULL,
                start_time TIME NOT NULL,
                end_time TIME NOT NULL,
                conduct_person_name VARCHAR(255),
                meeting_members JSONB DEFAULT '[]'::jsonb,
                meeting_status VARCHAR(50) DEFAULT 'scheduled',
                username VARCHAR(255),
                note TEXT,
                meeting_cancelled_reason TEXT,
                created_at TIMESTAMP DEFAULT (
                    CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata'
                ),

                updated_at TIMESTAMP DEFAULT (
                    CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata'
                )
            );
        `);

        console.log("✅ employee_meeting table initialized");
    } catch (error) {
        console.error(
            "❌ Error initializing employee_meeting table:",
            error
        );
    }
};


/* =========================================================
   CREATE MEETING
========================================================= */

export const createEmployeeMeetingModel = async ({
    meeting_type = null,
    cancelled_meeting_id = null,
    meeting_cancelled_reason = null,
    date,
    start_time,
    end_time,
    conduct_person_name = null,
    meeting_members = [],
    meeting_status = "scheduled",
    username = null,
    note = null,
    work_location = null
}) => {

    const query = `
        INSERT INTO employee_meeting (
            meeting_type,
            cancelled_meeting_id,
            meeting_cancelled_reason,
            date,
            start_time,
            end_time,
            conduct_person_name,
            meeting_members,
            meeting_status,
            username,
            note,
            work_location
        )
        VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9, $10, $11, $12
        )
        RETURNING *;
    `;

    const values = [
        meeting_type,
        cancelled_meeting_id,
        meeting_cancelled_reason,
        date,
        start_time,
        end_time,
        conduct_person_name,
        JSON.stringify(meeting_members || []),
        meeting_status,
        username,
        note,
        work_location
    ];

    const result = await pool.query(query, values);

    return result.rows[0];
};


/* =========================================================
   GET ALL MEETINGS
========================================================= */

export const getEmployeeMeetingsModel = async ({
    date = null,
    meeting_status = null,
    meeting_type = null,
    username = null,
    work_location = null,
    page = 1,
    limit = 20
} = {}) => {

    page = Number(page) || 1;
    limit = Number(limit) || 20;

    const offset = (page - 1) * limit;

    const conditions = [];
    const values = [];

    let index = 1;

    if (date) {
        conditions.push(`em.date = $${index++}`);
        values.push(date);
    }

    if (meeting_status) {
        conditions.push(`em.meeting_status = $${index++}`);
        values.push(meeting_status);
    }

    if (meeting_type) {
        conditions.push(`em.meeting_type = $${index++}`);
        values.push(meeting_type);
    }

    if (username) {
        conditions.push(`em.username = $${index++}`);
        values.push(username);
    }

    if (
        work_location !== null &&
        work_location !== undefined
    ) {
        conditions.push(`em.work_location = $${index++}`);
        values.push(work_location);
    }

    const whereClause =
        conditions.length > 0
            ? `WHERE ${conditions.join(" AND ")}`
            : "";


    /* =====================================================
       COUNT
    ===================================================== */

    const countQuery = `
        SELECT COUNT(*)::INTEGER AS total
        FROM employee_meeting em
        ${whereClause};
    `;

    const countResult =
        await pool.query(countQuery, values);

    const total =
        countResult.rows[0]?.total || 0;


    /* =====================================================
       GET ALL MEETINGS
    ===================================================== */

    const dataQuery = `
        SELECT
            em.*,

            wl.location AS work_location,
            (
                /* Only past: Schedule/empty → true,
                   status updated → false. Future → false. */
                (
                    CURRENT_TIMESTAMP
                    AT TIME ZONE 'Asia/Kolkata'
                ) >= (em.date + em.end_time)
                AND (
                    em.meeting_status IS NULL
                    OR BTRIM(em.meeting_status) = ''
                    OR LOWER(BTRIM(em.meeting_status))
                        IN ('schedule', 'scheduled')
                )
            ) AS is_pending

        FROM employee_meeting em

        LEFT JOIN work_location wl
            ON wl.id = em.work_location

        ${whereClause}

        ORDER BY
            em.date DESC,
            em.start_time DESC,
            em.id DESC

        LIMIT $${index++}
        OFFSET $${index++};
    `;

    values.push(limit);
    values.push(offset);

    const dataResult =
        await pool.query(dataQuery, values);


    return {
        meetings: dataResult.rows,

        pagination: {
            page,
            limit,
            total,
            total_pages: Math.ceil(total / limit)
        }
    };
};


/* =========================================================
   GET MEETING BY ID
========================================================= */

export const getEmployeeMeetingByIdModel = async (id) => {

    const query = `
        SELECT
            em.*,

            wl.location AS work_location,
            (
                /* Only past: Schedule/empty → true,
                   status updated → false. Future → false. */
                (
                    CURRENT_TIMESTAMP
                    AT TIME ZONE 'Asia/Kolkata'
                ) >= (em.date + em.end_time)
                AND (
                    em.meeting_status IS NULL
                    OR BTRIM(em.meeting_status) = ''
                    OR LOWER(BTRIM(em.meeting_status))
                        IN ('schedule', 'scheduled')
                )
            ) AS is_pending

        FROM employee_meeting em

        LEFT JOIN work_location wl
            ON wl.id = em.work_location

        WHERE em.id = $1;
    `;

    const result =
        await pool.query(query, [id]);

    return result.rows[0] || null;
};


/* =========================================================
   UPDATE MEETING
========================================================= */

export const updateEmployeeMeetingModel = async (
    id,
    data
) => {

    const allowedFields = [
        "meeting_type",
        "cancelled_meeting_id",
        "meeting_cancelled_reason",
        "date",
        "start_time",
        "end_time",
        "conduct_person_name",
        "meeting_members",
        "meeting_status",
        "username",
        "note",
        "work_location"
    ];

    const updates = [];
    const values = [];

    let index = 1;

    for (const field of allowedFields) {

        if (data[field] !== undefined) {

            let value = data[field];

            if (field === "meeting_members") {
                value = JSON.stringify(value || []);
            }

            updates.push(`${field} = $${index++}`);
            values.push(value);
        }
    }

    if (updates.length === 0) {
        return null;
    }

    updates.push(`
        updated_at = CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata'
    `);

    values.push(id);

    const query = `
        UPDATE employee_meeting
        SET ${updates.join(", ")}
        WHERE id = $${index}
        RETURNING *;
    `;

    const result = await pool.query(query, values);

    return result.rows[0] || null;
};

/* =========================================================
   DELETE MEETING
========================================================= */

export const deleteEmployeeMeetingModel = async (id) => {

    const query = `
        DELETE FROM employee_meeting
        WHERE id = $1
        RETURNING *;
    `;

    const result = await pool.query(query, [id]);

    return result.rows[0] || null;
};