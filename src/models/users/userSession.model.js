import { pool } from "../../database.js";
import { addUserSessionEditLogModel } from "../history/user_session_edit_log.model.js";

const ONLINE_INTERVAL = "60 seconds";

export const getClientEnvironment = (userAgent = "") => {
    const ua = String(userAgent || "");

    let operating_system = null;
    if (/windows nt/i.test(ua)) operating_system = "Windows";
    else if (/android/i.test(ua)) operating_system = "Android";
    else if (/iphone|ipad|ipod/i.test(ua)) operating_system = "iOS";
    else if (/mac os x|macintosh/i.test(ua)) operating_system = "Mac";
    else if (/cros/i.test(ua)) operating_system = "Chrome OS";
    else if (/linux/i.test(ua)) operating_system = "Linux";

    let browser_name = null;
    if (/edg\//i.test(ua)) browser_name = "Edge";
    else if (/brave/i.test(ua)) browser_name = "Brave";
    else if (/opr\/|opera/i.test(ua)) browser_name = "Opera";
    else if (/vivaldi/i.test(ua)) browser_name = "Vivaldi";
    else if (/samsungbrowser/i.test(ua)) browser_name = "Samsung Internet";
    else if (/firefox|fxios/i.test(ua)) browser_name = "Firefox";
    else if (/chrome|crios|chromium/i.test(ua)) browser_name = "Chrome";
    else if (/safari/i.test(ua)) browser_name = "Safari";

    return { operating_system, browser_name };
};

const SESSION_LOG_FIELDS = [
    "last_login_at",
    "last_logout_at",
    "browser_name",
    "operating_system"
];

const loadSessionLogSnapshot = async (userId) => {
    const { rows } = await pool.query(
        `
        SELECT
            us.id,
            ed.username,
            TO_CHAR(
                us.last_login_at AT TIME ZONE 'Asia/Kolkata',
                'YYYY-MM-DD HH24:MI:SS.MS'
            ) AS last_login_at,
            TO_CHAR(
                us.last_logout_at AT TIME ZONE 'Asia/Kolkata',
                'YYYY-MM-DD HH24:MI:SS.MS'
            ) AS last_logout_at,
            us.operating_system,
            us.browser_name
        FROM user_sessions us
        LEFT JOIN employment_details ed
            ON ed.personal_details_id = us.user_id
        WHERE us.user_id = $1
        LIMIT 1;
        `,
        [userId]
    );

    return rows[0] || null;
};

const logSessionFieldChanges = async (oldRow, newRow) => {
    if (!newRow?.id) return;

    const username = newRow.username || oldRow?.username || null;

    for (const field of SESSION_LOG_FIELDS) {
        const oldValue = oldRow?.[field] ?? null;
        const newValue = newRow[field] ?? null;
        const oldText = oldValue == null ? null : String(oldValue);
        const newText = newValue == null ? null : String(newValue);
        if (oldText === newText) continue;

        await addUserSessionEditLogModel({
            table_name: "user_sessions",
            record_id: newRow.id,
            username,
            edited_by: username,
            field_name: field,
            old_value: oldText,
            new_value: newText
        });
    }
};

export const initializeUserSessionsTable = async () => {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS user_sessions (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL,
            session_id VARCHAR(255) NOT NULL UNIQUE,
            last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_login_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_logout_at TIMESTAMPTZ,
            ip_address VARCHAR(100),
            user_agent TEXT,
            operating_system VARCHAR(100),
            browser_name VARCHAR(100),
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);

    await pool.query(`
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'user_sessions'
                  AND column_name = 'login_at'
            ) THEN
                ALTER TABLE user_sessions
                    RENAME COLUMN login_at TO last_login_at;
            END IF;

            IF EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'user_sessions'
                  AND column_name = 'logout_at'
            ) THEN
                ALTER TABLE user_sessions
                    RENAME COLUMN logout_at TO last_logout_at;
            END IF;
        END
        $$;
    `);

    await pool.query(`
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'user_sessions'
                  AND column_name = 'device_name'
            ) THEN
                ALTER TABLE user_sessions
                    RENAME COLUMN device_name TO operating_system;
            END IF;
        END
        $$;
    `);

    await pool.query(`
        ALTER TABLE user_sessions
            ADD COLUMN IF NOT EXISTS operating_system VARCHAR(100),
            ADD COLUMN IF NOT EXISTS browser_name VARCHAR(100);
    `);

    await pool.query(`
        DELETE FROM user_sessions us
        WHERE us.id NOT IN (
            SELECT MAX(id)
            FROM user_sessions
            GROUP BY user_id
        );
    `);

    await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_user_sessions_user_id_unique
        ON user_sessions(user_id);
    `);
    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_user_sessions_last_seen
        ON user_sessions(last_seen_at);
    `);
    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_user_sessions_active
        ON user_sessions(is_active);
    `);

    console.log("✅ user_sessions table ready");
};

export const createUserSessionModel = async ({
    user_id,
    session_id,
    ip_address = null,
    user_agent = null,
    operating_system = null,
    browser_name = null
}) => {
    const previous = await loadSessionLogSnapshot(user_id);
    const { rows } = await pool.query(
        `
        INSERT INTO user_sessions (
            user_id,
            session_id,
            last_seen_at,
            last_login_at,
            last_logout_at,
            ip_address,
            user_agent,
            operating_system,
            browser_name,
            is_active,
            updated_at
        )
        VALUES ($1, $2, NOW(), NOW(), NULL, $3, $4, $5, $6, TRUE, NOW())
        ON CONFLICT (user_id) DO UPDATE SET
            session_id = EXCLUDED.session_id,
            last_seen_at = NOW(),
            last_login_at = NOW(),
            ip_address = EXCLUDED.ip_address,
            user_agent = EXCLUDED.user_agent,
            operating_system = COALESCE(EXCLUDED.operating_system, user_sessions.operating_system),
            browser_name = COALESCE(EXCLUDED.browser_name, user_sessions.browser_name),
            is_active = TRUE,
            updated_at = NOW()
        RETURNING *;
        `,
        [
            user_id,
            session_id,
            ip_address,
            user_agent,
            operating_system,
            browser_name
        ]
    );

    const current = await loadSessionLogSnapshot(user_id);
    await logSessionFieldChanges(previous, current);

    return rows[0];
};

export const expireStaleUserSessionsModel = async () => {
    const { rows } = await pool.query(
        `
        UPDATE user_sessions
        SET
            is_active = FALSE,
            updated_at = NOW()
        WHERE is_active = TRUE
          AND last_seen_at < NOW() - INTERVAL '${ONLINE_INTERVAL}'
        RETURNING id, user_id;
        `
    );

    return rows;
};

export const touchUserSessionModel = async ({
    session_id,
    user_id,
    operating_system = null,
    browser_name = null
}) => {
    const previous = await loadSessionLogSnapshot(user_id);
    const { rows } = await pool.query(
        `
        UPDATE user_sessions
        SET
            last_seen_at = NOW(),
            is_active = TRUE,
            operating_system = COALESCE($2, operating_system),
            browser_name = COALESCE($3, browser_name),
            updated_at = NOW()
        WHERE user_id = $1
          AND (
              is_active = TRUE
              OR last_logout_at IS NULL
              OR last_logout_at < last_login_at
          )
        RETURNING *;
        `,
        [user_id, operating_system, browser_name]
    );

    const current = await loadSessionLogSnapshot(user_id);
    await logSessionFieldChanges(previous, current);

    return rows[0] ?? null;
};

export const logoutUserSessionModel = async ({ session_id, user_id }) => {
    const previous = await loadSessionLogSnapshot(user_id);
    const { rows } = await pool.query(
        `
        UPDATE user_sessions
        SET
            is_active = FALSE,
            last_logout_at = NOW(),
            updated_at = NOW()
        WHERE session_id = $1
          AND user_id = $2
          AND is_active = TRUE
        RETURNING *;
        `,
        [session_id, user_id]
    );

    const current = await loadSessionLogSnapshot(user_id);
    await logSessionFieldChanges(previous, current);

    return rows[0] ?? null;
};

export const getOnlineStatusCountsModel = async () => {
    const { rows } = await pool.query(
        `
        SELECT
            COUNT(*)::int AS total_users,
            COUNT(*) FILTER (
                WHERE EXISTS (
                    SELECT 1
                    FROM user_sessions us
                    WHERE us.user_id = pd.id
                      AND us.is_active = TRUE
                      AND us.last_seen_at >= NOW() - INTERVAL '${ONLINE_INTERVAL}'
                )
            )::int AS online_users,
            COUNT(*) FILTER (
                WHERE NOT EXISTS (
                    SELECT 1
                    FROM user_sessions us
                    WHERE us.user_id = pd.id
                      AND us.is_active = TRUE
                      AND us.last_seen_at >= NOW() - INTERVAL '${ONLINE_INTERVAL}'
                )
            )::int AS offline_users
        FROM personal_details pd
        INNER JOIN employment_details ed
            ON ed.personal_details_id = pd.id
        LEFT JOIN master_employee me
            ON me.personal_details_id = pd.id
        WHERE me.id IS NULL
           OR LOWER(TRIM(COALESCE(me.status, 'active'))) = 'active';
        `
    );

    return rows[0];
};

const asFilterList = (value) => {
    if (value == null || value === "") return [];
    const raw = Array.isArray(value) ? value : [value];
    return [...new Set(
        raw
            .flatMap(item => String(item).split(","))
            .map(item => item.trim())
            .filter(Boolean)
    )];
};

const appendUserListFilters = ({
    name = null,
    browser_name = null,
    operating_system = null,
    work_location = null
} = {}, values) => {
    let sql = "";
    const names = asFilterList(name);
    const browsers = asFilterList(browser_name);
    const systems = asFilterList(operating_system);
    const locations = asFilterList(work_location);

    if (names.length) {
        const nameClauses = names.map((item) => {
            values.push(`%${item}%`);
            const param = `$${values.length}`;
            return `(
                COALESCE(ed.username, '') ILIKE ${param}
                OR COALESCE(pd.first_name, '') ILIKE ${param}
                OR COALESCE(pd.middle_name, '') ILIKE ${param}
                OR COALESCE(pd.last_name, '') ILIKE ${param}
                OR CONCAT_WS(' ', pd.first_name, pd.middle_name, pd.last_name) ILIKE ${param}
            )`;
        });
        sql += ` AND (${nameClauses.join(" OR ")})`;
    }

    if (browsers.length) {
        const browserClauses = browsers.map((item) => {
            values.push(`%${item}%`);
            return `COALESCE(us.browser_name, '') ILIKE $${values.length}`;
        });
        sql += ` AND (${browserClauses.join(" OR ")})`;
    }

    if (systems.length) {
        const systemClauses = systems.map((item) => {
            values.push(`%${item}%`);
            return `COALESCE(us.operating_system, '') ILIKE $${values.length}`;
        });
        sql += ` AND (${systemClauses.join(" OR ")})`;
    }

    if (locations.length) {
        const locationClauses = locations.map((item) => {
            const locationId = Number(item);
            if (
                Number.isInteger(locationId) &&
                locationId > 0 &&
                String(locationId) === item
            ) {
                values.push(locationId);
                return `ed.work_location = $${values.length}`;
            }
            values.push(item);
            return `LOWER(TRIM(COALESCE(wl.location, ''))) = LOWER(TRIM($${values.length}))`;
        });
        sql += ` AND (${locationClauses.join(" OR ")})`;
    }

    return sql;
};

export const getOnlineUsersModel = async (filters = {}) => {
    const values = [];
    const filterSql = appendUserListFilters(filters, values);
    const { rows } = await pool.query(
        `
        SELECT
            pd.id AS user_id,
            ed.username,
            pd.first_name,
            pd.middle_name,
            pd.last_name,
            pd.image,
            TO_CHAR(
                MAX(us.last_seen_at) AT TIME ZONE 'Asia/Kolkata',
                'YYYY-MM-DD HH24:MI:SS.MS'
            ) AS last_seen_at,
            TO_CHAR(
                MAX(us.last_login_at) AT TIME ZONE 'Asia/Kolkata',
                'YYYY-MM-DD HH24:MI:SS.MS'
            ) AS last_login_at,
            TO_CHAR(
                MAX(us.last_logout_at) AT TIME ZONE 'Asia/Kolkata',
                'YYYY-MM-DD HH24:MI:SS.MS'
            ) AS last_logout_at,
            MAX(us.operating_system) AS operating_system,
            MAX(us.browser_name) AS browser_name
        FROM user_sessions us
        INNER JOIN personal_details pd
            ON pd.id = us.user_id
        INNER JOIN employment_details ed
            ON ed.personal_details_id = pd.id
        LEFT JOIN work_location wl
            ON wl.id = ed.work_location
        LEFT JOIN master_employee me
            ON me.personal_details_id = pd.id
        WHERE us.is_active = TRUE
          AND us.last_seen_at >= NOW() - INTERVAL '${ONLINE_INTERVAL}'
          AND (
              me.id IS NULL
              OR LOWER(TRIM(COALESCE(me.status, 'active'))) = 'active'
          )
          ${filterSql}
        GROUP BY pd.id, ed.username, pd.first_name, pd.middle_name, pd.last_name
        ORDER BY last_seen_at DESC;
        `,
        values
    );

    return rows;
};

export const getOfflineUsersModel = async (filters = {}) => {
    const values = [];
    const filterSql = appendUserListFilters(filters, values);
    const { rows } = await pool.query(
        `
        SELECT
            pd.id AS user_id,
            ed.username,
            pd.first_name,
            pd.middle_name,
            pd.last_name,
            pd.image,
            TO_CHAR(
                MAX(us.last_seen_at) AT TIME ZONE 'Asia/Kolkata',
                'YYYY-MM-DD HH24:MI:SS.MS'
            ) AS last_seen_at,
            TO_CHAR(
                MAX(us.last_login_at) AT TIME ZONE 'Asia/Kolkata',
                'YYYY-MM-DD HH24:MI:SS.MS'
            ) AS last_login_at,
            TO_CHAR(
                MAX(us.last_logout_at) AT TIME ZONE 'Asia/Kolkata',
                'YYYY-MM-DD HH24:MI:SS.MS'
            ) AS last_logout_at,
            MAX(us.operating_system) AS operating_system,
            MAX(us.browser_name) AS browser_name
        FROM personal_details pd
        INNER JOIN employment_details ed
            ON ed.personal_details_id = pd.id
        LEFT JOIN work_location wl
            ON wl.id = ed.work_location
        LEFT JOIN master_employee me
            ON me.personal_details_id = pd.id
        LEFT JOIN user_sessions us
            ON us.user_id = pd.id
        WHERE (
              me.id IS NULL
              OR LOWER(TRIM(COALESCE(me.status, 'active'))) = 'active'
          )
          AND NOT EXISTS (
              SELECT 1
              FROM user_sessions active
              WHERE active.user_id = pd.id
                AND active.is_active = TRUE
                AND active.last_seen_at >= NOW() - INTERVAL '${ONLINE_INTERVAL}'
          )
          ${filterSql}
        GROUP BY pd.id, ed.username, pd.first_name, pd.middle_name, pd.last_name
        ORDER BY last_seen_at DESC NULLS LAST;
        `,
        values
    );

    return rows;
};

export const getUserSessionOldDataModel = async ({ username = null } = {}) => {
    const values = [];
    let usernameFilter = "";
    const usernames = asFilterList(username).map(item => item.toLowerCase());

    if (usernames.length) {
        values.push(usernames);
        usernameFilter = `
            WHERE LOWER(TRIM(COALESCE(ed.username, l.username))) = ANY($${values.length}::text[])
        `;
    }

    const { rows } = await pool.query(
        `
        SELECT
            l.id,
            l.field_name,
            NULLIF(TRIM(l.old_value), '') AS old_value,
            l.created_at,
            pd.id AS user_id,
            COALESCE(ed.username, l.username) AS username,
            pd.first_name,
            pd.last_name,
            pd.image,
            TO_CHAR(
                us.last_seen_at AT TIME ZONE 'Asia/Kolkata',
                'YYYY-MM-DD HH24:MI:SS.MS'
            ) AS last_seen_at,
            TO_CHAR(
                us.last_login_at AT TIME ZONE 'Asia/Kolkata',
                'YYYY-MM-DD HH24:MI:SS.MS'
            ) AS session_last_login_at,
            TO_CHAR(
                us.last_logout_at AT TIME ZONE 'Asia/Kolkata',
                'YYYY-MM-DD HH24:MI:SS.MS'
            ) AS session_last_logout_at,
            NULLIF(TRIM(us.operating_system), '') AS session_operating_system,
            NULLIF(TRIM(us.browser_name), '') AS session_browser_name,
            CASE
                WHEN us.is_active = TRUE
                 AND us.last_seen_at >= NOW() - INTERVAL '${ONLINE_INTERVAL}'
                THEN 'online'
                ELSE 'offline'
            END AS status
        FROM user_session_edit_log l
        LEFT JOIN user_sessions us
            ON us.id = l.record_id
        LEFT JOIN personal_details pd
            ON pd.id = us.user_id
        LEFT JOIN employment_details ed
            ON ed.personal_details_id = pd.id
        ${usernameFilter}
        ORDER BY l.created_at DESC, l.id DESC;
        `,
        values
    );

    const loggedFields = new Set([
        "last_login_at",
        "last_logout_at",
        "operating_system",
        "browser_name"
    ]);
    const groups = [];

    for (const row of rows) {
        const createdAt = new Date(row.created_at).getTime();
        const current = groups[groups.length - 1];
        const sameChange = current
            && current.user_id === row.user_id
            && current.username === row.username
            && Number.isFinite(createdAt)
            && Math.abs(current.changedAt - createdAt) <= 2000
            && loggedFields.has(row.field_name)
            && !current.changedFields.has(row.field_name);

        if (sameChange) {
            current[row.field_name] = row.old_value;
            current.changedFields.add(row.field_name);
            continue;
        }

        groups.push({
            user_id: row.user_id,
            username: row.username,
            first_name: row.first_name,
            last_name: row.last_name,
            image: row.image,
            last_seen_at: row.last_seen_at,
            last_login_at: row.field_name === "last_login_at" ? row.old_value : null,
            last_logout_at: row.field_name === "last_logout_at" ? row.old_value : null,
            operating_system: row.field_name === "operating_system" ? row.old_value : null,
            browser_name: row.field_name === "browser_name" ? row.old_value : null,
            status: row.status,
            changedAt: createdAt,
            changedFields: new Set(
                loggedFields.has(row.field_name) ? [row.field_name] : []
            ),
            session_last_login_at: row.session_last_login_at,
            session_last_logout_at: row.session_last_logout_at,
            session_operating_system: row.session_operating_system,
            session_browser_name: row.session_browser_name
        });
    }

    const stateByUser = new Map();
    const sessionFields = [
        "last_login_at",
        "last_logout_at",
        "operating_system",
        "browser_name"
    ];

    return groups.map((group) => {
        const key = `${group.user_id ?? ""}:${group.username ?? ""}`;
        if (!stateByUser.has(key)) {
            stateByUser.set(key, {
                last_login_at: group.session_last_login_at,
                last_logout_at: group.session_last_logout_at,
                operating_system: group.session_operating_system,
                browser_name: group.session_browser_name
            });
        }

        const state = stateByUser.get(key);
        const item = {
            user_id: group.user_id,
            username: group.username,
            first_name: group.first_name,
            last_name: group.last_name,
            image: group.image,
            last_seen_at: group.last_seen_at,
            status: group.status
        };

        for (const field of sessionFields) {
            if (group.changedFields.has(field)) {
                item[field] = group[field];
                state[field] = group[field];
            } else {
                item[field] = state[field] ?? null;
            }
        }

        return item;
    });
};
