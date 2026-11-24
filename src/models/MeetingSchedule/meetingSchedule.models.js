import { pool } from "../../database.js";

/* =========================================================
   CREATE MEETING SCHEDULE TABLE
========================================================= */
export const initializeMeetingScheduleTable = async () => {
    const query = `
        CREATE TABLE IF NOT EXISTS meeting_schedule (
            id SERIAL PRIMARY KEY,
            candidate_id INTEGER,
            schedule_date DATE NOT NULL,
            start_time TIME NOT NULL,
            end_time TIME NOT NULL,
            scheduled_person_name VARCHAR(255) NOT NULL,
            candidate_person_name VARCHAR(255) NOT NULL,
            meeting_status VARCHAR(255),
            meeting_cancelled_reason TEXT,
            cancelled_meeting_id INTEGER,
            meeting_type VARCHAR(255),
            meeting_mode VARCHAR(255),
            note TEXT,
            resume TEXT,
            work_location INTEGER,
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

    /* =====================================================
       ADD TABLE
    ===================================================== */
    await pool.query(`
        ALTER TABLE meeting_schedule
        ADD COLUMN IF NOT EXISTS meeting_status VARCHAR(255),
        ADD COLUMN IF NOT EXISTS candidate_id INTEGER,
        ADD COLUMN IF NOT EXISTS meeting_cancelled_reason TEXT,
        ADD COLUMN IF NOT EXISTS cancelled_meeting_id INTEGER,
        ADD COLUMN IF NOT EXISTS meeting_type VARCHAR(255),
        ADD COLUMN IF NOT EXISTS meeting_mode VARCHAR(255),
        ADD COLUMN IF NOT EXISTS candidate_status_at_create VARCHAR(255);
    `);

    /* =====================================================
       MIGRATE OLD COLUMN IF REQUIRED
    ===================================================== */
    await pool.query(`
        DO $$
        BEGIN

            IF EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_name = 'meeting_schedule'
                  AND column_name = 'candidate_person_name'
            )
            AND NOT EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_name = 'meeting_schedule'
                  AND column_name = 'conduct_person_name'
            )
            THEN

                ALTER TABLE meeting_schedule
                RENAME COLUMN candidate_person_name
                TO conduct_person_name;

            END IF;

        END
        $$;
    `);

    console.log("✅ meeting_schedule table ready");
};

/* =========================================================
   CREATE MEETING
========================================================= */
export const createMeetingScheduleModel = async ({
    candidate_id = null,
    schedule_date,
    start_time,
    end_time,
    scheduled_person_name,
    conduct_person_name,
    meeting_status = null,
    meeting_cancelled_reason = null,
    cancelled_meeting_id = null,
    meeting_type = null,
    meeting_mode = null,
    note = null,
    resume = null,
    work_location = null,
    created_by = null,
    candidate_status_at_create = null
}) => {
    let statusAtCreate =
        candidate_status_at_create == null ||
        String(candidate_status_at_create).trim() === ""
            ? null
            : String(candidate_status_at_create).trim();

    /* Latest-meeting is_busy: snapshot vs candidate.candidate_status */
    if (
        statusAtCreate == null &&
        candidate_id != null &&
        Number.isFinite(Number(candidate_id))
    ) {
        const statusResult = await pool.query(
            `
            SELECT NULLIF(TRIM(candidate_status), '') AS candidate_status
            FROM candidate
            WHERE id = $1
            LIMIT 1;
            `,
            [Number(candidate_id)]
        );
        statusAtCreate =
            statusResult.rows[0]?.candidate_status || null;
    }

    const query = `
        INSERT INTO meeting_schedule (
         candidate_id,
            schedule_date,
            start_time,
            end_time,
            scheduled_person_name,
            conduct_person_name,
            meeting_status,
            meeting_cancelled_reason,
            cancelled_meeting_id,
            meeting_type,
            meeting_mode,
            note,
            resume,
            work_location,
            created_by,
            candidate_status_at_create
        )
        VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
            $10,
            $11,
            $12,
            $13,
            $14,
            $15,
            $16
        )
        RETURNING *;
    `;

    const values = [
        candidate_id ?? null,
        schedule_date,
        start_time,
        end_time,
        scheduled_person_name,
        conduct_person_name,
        meeting_status,
        meeting_cancelled_reason ?? null,
        cancelled_meeting_id ?? null,
        meeting_type ?? null,
        meeting_mode ?? null,
        note,
        resume,
        work_location,
        created_by,
        statusAtCreate
    ];

    const result = await pool.query(
        query,
        values
    );

    return result.rows[0];
};

/* =========================================================
   GET ALL MEETINGS
========================================================= */
export const getMeetingScheduleModel = async ({
    schedule_date = null,
    scheduled_person_name = null,
    conduct_person_name = null,
    work_location = null
} = {}) => {

    let query = `
        SELECT
            ms.id,
            ms.candidate_id,
            ms.schedule_date,
            ms.start_time,
            ms.end_time,
            ms.scheduled_person_name,
            ms.conduct_person_name,
            ms.meeting_status,
            COALESCE(
                NULLIF(BTRIM(ms.meeting_cancelled_reason), ''),
                NULLIF(BTRIM(ms_prev.meeting_cancelled_reason), ''),
                NULLIF(BTRIM(ms_prev.note), '')
            ) AS meeting_cancelled_reason,
            ms.cancelled_meeting_id,
            ms.meeting_type,
            ms.meeting_mode,
            ms.note,
            ms.resume,
            ms.work_location AS work_location_id,
            wl.location AS work_location,
            ms.created_by,
            ms.created_at,
            ms.updated_at,
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
            ) AS is_pending
        FROM meeting_schedule ms

        LEFT JOIN work_location wl
            ON wl.id = ms.work_location

        LEFT JOIN meeting_schedule ms_prev
            ON ms_prev.id = ms.cancelled_meeting_id

        WHERE 1 = 1
          /* Reschedule thi cancel thai meeting hide */
          AND NOT EXISTS (
              SELECT 1
              FROM meeting_schedule ms_next
              WHERE ms_next.cancelled_meeting_id = ms.id
          )
    `;

    const values = [];
    let index = 1;

    /* =====================================================
       DATE FILTER
    ===================================================== */
    if (
        schedule_date !== null &&
        schedule_date !== undefined &&
        String(schedule_date).trim() !== ""
    ) {

        query += `
            AND ms.schedule_date = $${index}
        `;

        values.push(schedule_date);
        index++;
    }

    /* =====================================================
       SCHEDULED PERSON FILTER
    ===================================================== */
    if (
        scheduled_person_name !== null &&
        scheduled_person_name !== undefined &&
        String(scheduled_person_name).trim() !== ""
    ) {

        query += `
            AND LOWER(ms.scheduled_person_name)
                LIKE LOWER($${index})
        `;

        values.push(
            `%${String(
                scheduled_person_name
            ).trim()}%`
        );

        index++;
    }

    /* =====================================================
       CONDUCT PERSON FILTER
    ===================================================== */
    if (
        conduct_person_name !== null &&
        conduct_person_name !== undefined &&
        String(conduct_person_name).trim() !== ""
    ) {

        query += `
            AND LOWER(ms.conduct_person_name)
                LIKE LOWER($${index})
        `;

        values.push(
            `%${String(
                conduct_person_name
            ).trim()}%`
        );

        index++;
    }

    /* =====================================================
       WORK LOCATION FILTER
    ===================================================== */
    if (
        work_location !== null &&
        work_location !== undefined &&
        String(work_location).trim() !== ""
    ) {

        query += `
            AND LOWER(wl.location)
                LIKE LOWER($${index})
        `;

        values.push(
            `%${String(
                work_location
            ).trim()}%`
        );

        index++;
    }

    query += `
        ORDER BY
            ms.schedule_date DESC,
            ms.start_time DESC,
            ms.id DESC
    `;

    const result = await pool.query(
        query,
        values
    );

    return result.rows;
};

/* =========================================================
   GET MEETING BY ID
========================================================= */
export const getMeetingScheduleByIdModel = async (id) => {
    const query = `
        SELECT
            ms.id,
            ms.candidate_id,
            ms.schedule_date,
            ms.start_time,
            ms.end_time,
            ms.scheduled_person_name,
            ms.conduct_person_name,
            ms.meeting_status,
            COALESCE(
                NULLIF(BTRIM(ms.meeting_cancelled_reason), ''),
                NULLIF(BTRIM(ms_prev.meeting_cancelled_reason), ''),
                NULLIF(BTRIM(ms_prev.note), '')
            ) AS meeting_cancelled_reason,
            ms.cancelled_meeting_id,
            ms.meeting_type,
            ms.meeting_mode,
            ms.note,
            ms.resume,
            ms.work_location,
            ms.created_by,
            ms.created_at,
            ms.updated_at,
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
            ) AS is_pending

        FROM meeting_schedule ms
        LEFT JOIN meeting_schedule ms_prev
            ON ms_prev.id = ms.cancelled_meeting_id
        WHERE ms.id = $1;
    `;

    const result = await pool.query(
        query,
        [id]
    );

    return result.rows[0];
};

/* =========================================================
   GET MEETINGS BY MONTH
========================================================= */
export const getMeetingScheduleByMonthModel = async (
    year,
    month,
    work_location = null
) => {
    const query = `
        SELECT
            ms.id,
            ms.candidate_id,

            /* Candidate username */
            c.username AS candidate_username,
            c.first_name,
            c.middle_name,
            c.last_name,
            TRIM(
                CONCAT_WS(
                    ' ',
                    c.first_name,
                    c.middle_name,
                    c.last_name
                )
            ) AS candidate_full_name,

            ms.schedule_date::TEXT AS schedule_date,
            ms.start_time,
            ms.end_time,
            ms.scheduled_person_name,
            ms.conduct_person_name,
            ms.meeting_status,

            /* Reschedule meeting par purani cancelled reason */
            COALESCE(
                NULLIF(BTRIM(ms.meeting_cancelled_reason), ''),
                NULLIF(BTRIM(previous_ms.meeting_cancelled_reason), ''),
                NULLIF(BTRIM(previous_ms.note), '')
            ) AS meeting_cancelled_reason,

            ms.cancelled_meeting_id,

            COALESCE(
                NULLIF(BTRIM(previous_ms.meeting_cancelled_reason), ''),
                NULLIF(BTRIM(previous_ms.note), '')
            ) AS cancelled_meeting_reason,

            ms.meeting_type,
            ms.meeting_mode,
            ms.note,
            ms.resume,

            ms.work_location AS work_location_id,
            wl.location AS work_location,

            ms.created_by,
            ms.created_at,
            ms.updated_at,
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
            ) AS is_pending

        FROM meeting_schedule ms

        /* =====================================================
           WORK LOCATION
        ===================================================== */
        LEFT JOIN work_location wl
            ON wl.id = ms.work_location

        /* =====================================================
           CANDIDATE
        ===================================================== */
        LEFT JOIN candidate c
            ON c.id = ms.candidate_id

        /* =====================================================
           PREVIOUS / CANCELLED MEETING
        ===================================================== */
        LEFT JOIN meeting_schedule previous_ms
            ON previous_ms.id = ms.cancelled_meeting_id

        WHERE
            EXTRACT(
                YEAR FROM ms.schedule_date
            ) = $1

            AND EXTRACT(
                MONTH FROM ms.schedule_date
            ) = $2

            /* Reschedule thi cancel thai meeting hide */
            AND NOT EXISTS (
                SELECT 1
                FROM meeting_schedule ms_next
                WHERE ms_next.cancelled_meeting_id = ms.id
            )
    `;

    const values = [
        year,
        month
    ];

    let finalQuery = query;

    /* =====================================================
       WORK LOCATION FILTER
    ===================================================== */
    if (
        work_location !== null &&
        work_location !== undefined &&
        String(work_location).trim() !== ""
    ) {
        finalQuery += `
            AND LOWER(wl.location)
                LIKE LOWER($3)
        `;

        values.push(
            `%${String(
                work_location
            ).trim()}%`
        );
    }

    finalQuery += `
        ORDER BY
            ms.schedule_date ASC,
            ms.start_time ASC,
            ms.id ASC
    `;

    const result = await pool.query(
        finalQuery,
        values
    );

    return result.rows;
};


/* =========================================================
   GET MEETINGS BY USERNAME / DEPARTMENT + MONTH
========================================================= */
export const getMeetingScheduleByUsername = async (
    username,
    year,
    month,
    work_location = null,
    department = null
) => {

    const query = `
        SELECT
            ms.id,
            ms.candidate_id,

            /* =================================================
               CANDIDATE DETAILS
            ================================================= */
            c.username AS candidate_username,

            TRIM(
                CONCAT_WS(
                    ' ',
                    c.first_name,
                    c.middle_name,
                    c.last_name
                )
            ) AS candidate_full_name,

            ms.schedule_date::TEXT AS schedule_date,
            ms.start_time,
            ms.end_time,

            /* =================================================
               SCHEDULED PERSON
            ================================================= */
            ms.scheduled_person_name AS scheduled_person_name,

            /* =================================================
               CONDUCT PERSON
            ================================================= */
            ms.conduct_person_name AS conduct_person_name,

            ms.meeting_status,

            /* =================================================
               CANCEL REASON
            ================================================= */
            COALESCE(
                NULLIF(BTRIM(ms.meeting_cancelled_reason), ''),
                NULLIF(BTRIM(previous_ms.meeting_cancelled_reason), ''),
                NULLIF(BTRIM(previous_ms.note), '')
            ) AS meeting_cancelled_reason,

            ms.cancelled_meeting_id,

            /* =================================================
               PREVIOUS MEETING REASON
            ================================================= */
            COALESCE(
                NULLIF(BTRIM(previous_ms.meeting_cancelled_reason), ''),
                NULLIF(BTRIM(previous_ms.note), '')
            ) AS cancelled_meeting_reason,

            ms.meeting_type,
            ms.meeting_mode,
            ms.note,
            ms.resume,

            ms.work_location AS work_location_id,
            wl.location AS work_location,

            ms.created_by,
            ms.created_at,
            ms.updated_at,

            /* =================================================
               PENDING STATUS
            ================================================= */
            (
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
            ) AS is_pending

        FROM meeting_schedule ms

        /* =================================================
           WORK LOCATION
        ================================================= */
        LEFT JOIN work_location wl
            ON wl.id = ms.work_location

        /* =================================================
           CANDIDATE
        ================================================= */
        LEFT JOIN candidate c
            ON c.id = ms.candidate_id

        /* =================================================
           PREVIOUS / CANCELLED MEETING
        ================================================= */
        LEFT JOIN meeting_schedule previous_ms
            ON previous_ms.id = ms.cancelled_meeting_id

        WHERE

            /* =================================================
               YEAR
            ================================================= */
            EXTRACT(YEAR FROM ms.schedule_date) = $1

            /* =================================================
               MONTH
            ================================================= */
            AND EXTRACT(MONTH FROM ms.schedule_date) = $2

            /* =================================================
               HIDE RESCHEDULED OLD MEETINGS
            ================================================= */
            AND NOT EXISTS (
                SELECT 1
                FROM meeting_schedule ms_next
                WHERE ms_next.cancelled_meeting_id = ms.id
            )

            /* =================================================
               USER / DEPARTMENT FILTER
            ================================================= */
            AND (
                /* ---------------------------------------------
                   USER-SPECIFIC MEETINGS
                --------------------------------------------- */
                (
                    $3::TEXT IS NOT NULL
                    AND (
                        LOWER(TRIM(ms.scheduled_person_name))
                            = LOWER(TRIM($3))

                        OR EXISTS (
                            SELECT 1
                            FROM unnest(
                                string_to_array(
                                    COALESCE(ms.conduct_person_name, ''),
                                    ','
                                )
                            ) AS conduct_username
                            WHERE LOWER(TRIM(conduct_username))
                                = LOWER(TRIM($3))
                        )
                    )
                )

                OR

                /* ---------------------------------------------
                   DEPARTMENT-WIDE MEETINGS
                --------------------------------------------- */
                (
                    $4::TEXT IS NOT NULL

                    AND (
                        /* Scheduled person department */
                        EXISTS (
                            SELECT 1
                            FROM personal_details scheduled_pd
                            JOIN employment_details scheduled_ed
                                ON scheduled_ed.personal_details_id =
                                   scheduled_pd.id
                            JOIN department_structure scheduled_ds
                                ON scheduled_ds.id =
                                   scheduled_ed.department
                            WHERE LOWER(TRIM(scheduled_pd.username))
                                = LOWER(TRIM(ms.scheduled_person_name))
                            AND (
                                CASE
                                    WHEN $4 ~ '^[0-9]+$'
                                    THEN scheduled_ed.department = $4::INTEGER
                                    ELSE LOWER(TRIM(scheduled_ds.name::TEXT))
                                         = LOWER(TRIM($4))
                                END
                            )
                        )

                        OR

                        /* Any conduct person department */
                        EXISTS (
                            SELECT 1
                            FROM unnest(
                                string_to_array(
                                    COALESCE(ms.conduct_person_name, ''),
                                    ','
                                )
                            ) AS conduct_username

                            JOIN personal_details conduct_pd
                                ON LOWER(TRIM(conduct_pd.username))
                                   = LOWER(TRIM(conduct_username))

                            JOIN employment_details conduct_ed
                                ON conduct_ed.personal_details_id =
                                   conduct_pd.id

                            JOIN department_structure conduct_ds
                                ON conduct_ds.id =
                                   conduct_ed.department

                            WHERE (
                                CASE
                                    WHEN $4 ~ '^[0-9]+$'
                                    THEN conduct_ed.department = $4::INTEGER
                                    ELSE LOWER(TRIM(conduct_ds.name::TEXT))
                                         = LOWER(TRIM($4))
                                END
                            )
                        )
                    )
                )
            )
    `;

    const values = [
        year,
        month,
        username ? String(username).trim() : null,
        department !== null &&
        department !== undefined &&
        String(department).trim() !== "" &&
        String(department).trim().toLowerCase() !== "all"
            ? String(department).trim()
            : null
    ];

    let finalQuery = query;

    /* =====================================================
       WORK LOCATION FILTER
    ===================================================== */
    if (
        work_location !== null &&
        work_location !== undefined &&
        String(work_location).trim() !== "" &&
        String(work_location).trim().toLowerCase() !== "all"
    ) {
        finalQuery += `
            AND LOWER(TRIM(wl.location))
                LIKE LOWER(TRIM($5))
        `;

        values.push(
            `%${String(work_location).trim()}%`
        );
    }

    /* =====================================================
       ORDER
    ===================================================== */
    finalQuery += `
        ORDER BY
            ms.schedule_date ASC,
            ms.start_time ASC,
            ms.id ASC
    `;

    /* =====================================================
       EXECUTE QUERY
    ===================================================== */
    const result = await pool.query(
        finalQuery,
        values
    );

    return result.rows;
};


/* =========================================================
   UPDATE MEETING
========================================================= */
export const updateMeetingScheduleModel = async (
    id,
    {
        candidate_id,
        schedule_date,
        start_time,
        end_time,
        scheduled_person_name,
        conduct_person_name,
        meeting_status,
        meeting_cancelled_reason,
        cancelled_meeting_id,
        meeting_type,
        meeting_mode,
        note,
        resume,
        work_location
    }
) => {
    const query = `
        UPDATE meeting_schedule
        SET
            candidate_id = COALESCE($1, candidate_id),
            schedule_date = COALESCE($2, schedule_date),
            start_time = COALESCE($3, start_time),
            end_time = COALESCE($4, end_time),
            scheduled_person_name = COALESCE($5, scheduled_person_name),
            conduct_person_name = COALESCE($6, conduct_person_name),
            meeting_status = COALESCE($7, meeting_status),
            meeting_cancelled_reason = COALESCE($8,  meeting_cancelled_reason),
            cancelled_meeting_id = COALESCE($9, cancelled_meeting_id),
            meeting_type = COALESCE($10, meeting_type),
            meeting_mode = COALESCE($11, meeting_mode),
            note = COALESCE($12, note),
            resume = COALESCE($13, resume),
            work_location = COALESCE($14, work_location),
            updated_at = TIMEZONE(
                'Asia/Kolkata',
                CURRENT_TIMESTAMP
            )
        WHERE id = $15
        RETURNING *;
    `;

    const values = [
        candidate_id ?? null,
        schedule_date ?? null,
        start_time ?? null,
        end_time ?? null,
        scheduled_person_name ?? null,
        conduct_person_name ?? null,
        meeting_status ?? null,
        meeting_cancelled_reason ?? null,
        cancelled_meeting_id ?? null,
        meeting_type ?? null,
        meeting_mode ?? null,
        note ?? null,
        resume ?? null,
        work_location ?? null,
        id
    ];

    const result = await pool.query(
        query,
        values
    );

    return result.rows[0] || null;
};

/* =========================================================
   DELETE MEETING
========================================================= */
export const deleteMeetingScheduleModel = async (id) => {
    const query = `
        DELETE FROM meeting_schedule
        WHERE id = $1
        RETURNING *;
    `;

    const result = await pool.query(
        query,
        [id]
    );

    return result.rows[0] || null;
};

/* =========================================================
   GET LATEST MEETING PER CANDIDATE
========================================================= */
export const getLatestMeetingModel = async () => {
    const query = `
        WITH latest_meeting AS (
            SELECT
                ms.id,
                ms.candidate_id,
                ms.schedule_date,
                ms.start_time,
                ms.end_time,
                ms.created_at,
                ms.candidate_status_at_create,
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
                ) AS is_pending,
                LOWER(TRIM(COALESCE(c.candidate_status, '')))
                    AS current_candidate_status
            FROM meeting_schedule ms
            INNER JOIN (
                SELECT DISTINCT ON (candidate_id)
                    candidate_id,
                    id AS latest_id
                FROM meeting_schedule ms_pick
                WHERE ms_pick.candidate_id IS NOT NULL
                  /* Reschedule thi cancel thai meeting latest nathi */
                  AND NOT EXISTS (
                      SELECT 1
                      FROM meeting_schedule ms_next
                      WHERE ms_next.cancelled_meeting_id = ms_pick.id
                  )
                ORDER BY
                    candidate_id,
                    schedule_date DESC,
                    start_time DESC,
                    id DESC
            ) latest
                ON latest.latest_id = ms.id
            LEFT JOIN candidate c
                ON c.id = ms.candidate_id
        ),
        latest_with_busy AS (
            SELECT
                lm.*,
                /* Date+end_time past → false.
                   candidate_status update → false.
                   Else (still within/before meeting + status same) → true. */
                (
                    (
                        CURRENT_TIMESTAMP
                        AT TIME ZONE 'Asia/Kolkata'
                    ) < (lm.schedule_date + lm.end_time)
                    AND CASE
                        WHEN lm.candidate_status_at_create IS NOT NULL
                             AND BTRIM(lm.candidate_status_at_create) <> ''
                        THEN lm.current_candidate_status
                             = LOWER(TRIM(lm.candidate_status_at_create))
                        ELSE NOT EXISTS (
                            SELECT 1
                            FROM meeting_edit_log mel
                            WHERE mel.record_id = lm.id
                              AND LOWER(TRIM(mel.field_name)) =
                                  'candidate_status'
                              AND mel.created_at >= lm.created_at
                        )
                        AND NOT EXISTS (
                            SELECT 1
                            FROM employee_edit_log eel
                            WHERE eel.action = 'UPDATE'
                              AND eel.created_at >= lm.created_at
                              AND eel.description ILIKE
                                  ('Candidate ID ' || lm.candidate_id || ' %')
                              AND COALESCE(
                                    LOWER(TRIM(
                                        eel.old_value->>'candidate_status'
                                    )),
                                    ''
                                  )
                                  IS DISTINCT FROM
                                  COALESCE(
                                    LOWER(TRIM(
                                        eel.new_value->>'candidate_status'
                                    )),
                                    ''
                                  )
                        )
                    END
                ) AS is_busy
            FROM latest_meeting lm
        )
        SELECT
            lb.candidate_id,
            lb.is_busy,
            lb.is_pending,
            TO_CHAR(lb.schedule_date, 'YYYY-MM-DD') AS schedule_date,
            TO_CHAR(lb.start_time, 'HH24:MI:SS') AS start_time,
            TO_CHAR(lb.end_time, 'HH24:MI:SS') AS end_time
        FROM latest_with_busy lb
        ORDER BY
            lb.candidate_id ASC
    `;

    const { rows } = await pool.query(query);
    return rows;
};
