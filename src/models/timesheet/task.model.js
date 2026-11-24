import {pool}from "../../config/db.js";
import { writeTaskLog } from '../history/Tasklog.model.js';

/** The built-in task statuses, in board order. Seeds the task_statuses table on a fresh database. */
export const TASK_STATUSES = ['New', 'Schedule', 'In Progress', 'On Hold', 'Stopped', 'Review', 'Completed'];
export const TASK_PRIORITIES = ['Low', 'Medium', 'High'];

const REVIEW_AT_SQL = `(
    SELECT MAX(h.created_at)::timestamptz FROM task_status_history h
    WHERE h.task_id = tasks.id
      AND LOWER(TRIM(h.new_status)) = 'review'
)`;

// Completion date & time: when the task was last moved to Completed (only while it is still Completed).
const COMPLETED_AT_SQL = `(
    SELECT MAX(h.created_at)::timestamptz FROM task_status_history h
    WHERE h.task_id = tasks.id
      AND LOWER(TRIM(tasks.status)) = 'completed'
      AND LOWER(TRIM(h.new_status)) = 'completed'
)`;

const REMOVED_TASK_COLUMNS = ['start_date', 'start_time', 'stop_date', 'reason', 'completion_date', 'total_hour', 'serial_no'];

const TASK_WORKED_HMS_SQL = (taskIdExpr) => `(
    SELECT lpad((w.secs / 3600)::text, 2, '0') || ':' ||
           lpad(((w.secs % 3600) / 60)::text, 2, '0') || ':' ||
           lpad((w.secs % 60)::text, 2, '0')
    FROM (
        SELECT COALESCE(SUM(EXTRACT(EPOCH FROM TRIM(ts.duration)::interval)), 0)::bigint AS secs
        FROM "TIMESHEET" ts
        WHERE ts.task_id = ${taskIdExpr}
          AND ts.duration ~ '^[0-9]{1,4}:[0-9]{2}(:[0-9]{2})?$'
    ) w
)`;

class TaskModel {
    static async initializeTable() {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS tasks (
                id SERIAL PRIMARY KEY,
                serial_number VARCHAR(50),
                title VARCHAR(255),
                project_category VARCHAR(50),
                project_id INTEGER,
                project_code VARCHAR(100),
                project_by VARCHAR(255),
                process_id INTEGER,
                process_name VARCHAR(255),
                description TEXT,
                status VARCHAR(50) DEFAULT 'New',
                priority VARCHAR(20) DEFAULT 'Medium',
                assigned_by VARCHAR(255),
                assigned_to TEXT,
                assigned_at TIMESTAMPTZ,
                target_completion_at TIMESTAMPTZ,
                target_hour VARCHAR(16),
                created_by VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Migration: make sure old databases receive new columns.
        await pool.query(`
            ALTER TABLE tasks ADD COLUMN IF NOT EXISTS serial_number VARCHAR(50);
            ALTER TABLE tasks ADD COLUMN IF NOT EXISTS title VARCHAR(255);
            ALTER TABLE tasks ADD COLUMN IF NOT EXISTS target_hour VARCHAR(16);
            -- Target Hours is stored as text "h:mm:ss" (1:30:00). Old databases kept decimal hours (NUMERIC):
            -- convert them once (1.5 -> '1:30:00'); runs only while the column is still numeric.
            DO $$
            BEGIN
                IF (
                    SELECT data_type FROM information_schema.columns
                    WHERE table_schema = current_schema() AND table_name = 'tasks' AND column_name = 'target_hour'
                ) = 'numeric' THEN
                    ALTER TABLE tasks ALTER COLUMN target_hour TYPE VARCHAR(16) USING (
                        CASE
                            WHEN target_hour IS NULL OR target_hour <= 0 THEN NULL
                            ELSE (ROUND(target_hour * 3600)::bigint / 3600)::text
                                 || ':' || LPAD(((ROUND(target_hour * 3600)::bigint % 3600) / 60)::text, 2, '0')
                                 || ':' || LPAD((ROUND(target_hour * 3600)::bigint % 60)::text, 2, '0')
                        END
                    );
                END IF;
            END $$;
            ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;
            ALTER TABLE tasks ADD COLUMN IF NOT EXISTS target_completion_at TIMESTAMPTZ;
            ALTER TABLE tasks ADD COLUMN IF NOT EXISTS priority VARCHAR(20) DEFAULT 'Medium';
            -- A task saved without a status starts as New (older databases defaulted to 'schedule').
            ALTER TABLE tasks ALTER COLUMN status SET DEFAULT 'New';
            ALTER TABLE tasks ADD COLUMN IF NOT EXISTS reject_reason TEXT;
            -- Only the reason is stored (who / when are not kept).
            ALTER TABLE tasks DROP COLUMN IF EXISTS rejected_by;
            ALTER TABLE tasks DROP COLUMN IF EXISTS rejected_at;
            ALTER TABLE tasks DROP COLUMN IF EXISTS status_reason_by;
            ALTER TABLE tasks DROP COLUMN IF EXISTS status_reason_at;
        `);
        await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS status_reason TEXT;`);
        await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS duration VARCHAR(50);`);
        await pool.query(`ALTER TABLE tasks DROP COLUMN IF EXISTS serial_no;`);
        await pool.query(`
            UPDATE tasks SET duration = ${TASK_WORKED_HMS_SQL('tasks.id')}
            WHERE EXISTS (SELECT 1 FROM "TIMESHEET" ts WHERE ts.task_id = tasks.id)
              AND duration IS DISTINCT FROM ${TASK_WORKED_HMS_SQL('tasks.id')};
        `);
        await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS resumed_from_hold BOOLEAN DEFAULT FALSE;`);
        
        await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS was_rejected BOOLEAN DEFAULT FALSE;`);
        await pool.query(`UPDATE tasks SET was_rejected = TRUE WHERE COALESCE(reject_reason, '') <> '' AND was_rejected IS NOT TRUE;`);
        await pool.query(`
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = current_schema() AND table_name = 'tasks' AND column_name = 'assigned_date'
                ) THEN
                    UPDATE tasks
                    SET assigned_at = (assigned_date + COALESCE("time", TIME '00:00'))
                    WHERE assigned_at IS NULL AND assigned_date IS NOT NULL;

                    DROP INDEX IF EXISTS idx_tasks_assigned_date;
                    ALTER TABLE tasks DROP COLUMN IF EXISTS assigned_date;
                    ALTER TABLE tasks DROP COLUMN IF EXISTS "time";
                END IF;

                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = current_schema() AND table_name = 'tasks' AND column_name = 'target_completion_date'
                ) THEN
                    UPDATE tasks
                    SET target_completion_at = (
                        target_completion_date
                        + COALESCE(
                            (SELECT NULLIF(to_jsonb(t) ->> 'target_completion_time', '')::time FROM tasks t WHERE t.id = tasks.id),
                            TIME '00:00'
                        )
                    )
                    WHERE target_completion_at IS NULL AND target_completion_date IS NOT NULL;

                    ALTER TABLE tasks DROP COLUMN IF EXISTS target_completion_date;
                    ALTER TABLE tasks DROP COLUMN IF EXISTS target_completion_time;
                END IF;
            END $$;
        `);
        await pool.query(`
            ALTER TABLE tasks
                ALTER COLUMN assigned_to TYPE TEXT
                USING assigned_to::TEXT;
        `);
        await pool.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_indexes WHERE indexname = 'uq_tasks_serial_number'
                ) THEN
                    IF EXISTS (
                        SELECT 1 FROM tasks WHERE serial_number IS NOT NULL
                        GROUP BY serial_number HAVING COUNT(*) > 1
                    ) THEN
                        RAISE WARNING 'uq_tasks_serial_number NOT created: duplicate task serial numbers exist. Fix them, then restart.';
                    ELSE
                        CREATE UNIQUE INDEX uq_tasks_serial_number ON tasks(serial_number)
                            WHERE serial_number IS NOT NULL;
                    END IF;
                END IF;
            END $$;
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_tasks_project_code ON tasks(project_code);
            CREATE INDEX IF NOT EXISTS idx_tasks_serial_number ON tasks(serial_number);
            CREATE INDEX IF NOT EXISTS idx_tasks_project_category ON tasks(project_category);
            CREATE INDEX IF NOT EXISTS idx_tasks_process_id ON tasks(process_id);
            CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to ON tasks(assigned_to);
            CREATE INDEX IF NOT EXISTS idx_tasks_assigned_by ON tasks(assigned_by);
            CREATE INDEX IF NOT EXISTS idx_tasks_assigned_at ON tasks(assigned_at);
            CREATE INDEX IF NOT EXISTS idx_tasks_created_by ON tasks(created_by);
            CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
            CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);

            ALTER TABLE "TIMESHEET" ADD COLUMN IF NOT EXISTS task_id INTEGER;
            ALTER TABLE "TIMESHEET" ADD COLUMN IF NOT EXISTS task_serial_number VARCHAR(50);
            CREATE INDEX IF NOT EXISTS idx_timesheet_task_id ON "TIMESHEET"(task_id);
            CREATE INDEX IF NOT EXISTS idx_timesheet_task_serial_number ON "TIMESHEET"(task_serial_number);
            -- "is_working" asks for the ONGOING rows of every task; this tiny partial index answers that
            -- without scanning the whole timesheet (the condition is written exactly like the queries).
            CREATE INDEX IF NOT EXISTS idx_timesheet_task_ongoing ON "TIMESHEET"(task_id)
                WHERE stop_time IS NULL OR TRIM(stop_time::text) = '' OR stop_time::text = 'Ongoing';
            -- Permission lookups match LOWER(TRIM(username)) on every task request.
            CREATE INDEX IF NOT EXISTS idx_user_page_permissions_username_lower
                ON user_page_permissions (LOWER(TRIM(COALESCE(username, ''))));

            CREATE OR REPLACE FUNCTION update_tasks_updated_at()
            RETURNS TRIGGER AS $$
            BEGIN
                NEW.updated_at = CURRENT_TIMESTAMP;
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;

            DROP TRIGGER IF EXISTS trigger_update_tasks_updated_at ON tasks;

            CREATE TRIGGER trigger_update_tasks_updated_at
                BEFORE UPDATE ON tasks
                FOR EACH ROW
                EXECUTE FUNCTION update_tasks_updated_at();
        `);

        // Board card order of each user (drag & drop): { "<status id>": [task ids in order] }.
        await pool.query(`
            CREATE TABLE IF NOT EXISTS task_board_preferences (
                username VARCHAR(255) PRIMARY KEY,
                task_order JSONB NOT NULL DEFAULT '{}'::jsonb,
                collapsed_columns JSONB NOT NULL DEFAULT '[]'::jsonb,
                updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await pool.query(`
            ALTER TABLE task_board_preferences
            ADD COLUMN IF NOT EXISTS collapsed_columns JSONB NOT NULL DEFAULT '[]'::jsonb;
        `);
    }

    /** The saved board preference of one user. */
    static async findBoardPreference(username) {
        const result = await pool.query(
            'SELECT task_order, collapsed_columns FROM task_board_preferences WHERE LOWER(username) = LOWER($1)',
            [username],
        );
        return {
            card_order: result.rows[0]?.task_order ?? {},
            collapsed_columns: Array.isArray(result.rows[0]?.collapsed_columns)
                ? result.rows[0].collapsed_columns
                : [],
        };
    }

    /** Saves (replaces) the board card order and collapsed columns of one user. */
    static async saveBoardPreference(username, taskOrder, collapsedColumns) {
        const result = await pool.query(
            `INSERT INTO task_board_preferences (username, task_order, collapsed_columns, updated_at)
             VALUES (LOWER($1), $2::jsonb, $3::jsonb, CURRENT_TIMESTAMP)
             ON CONFLICT (username)
             DO UPDATE SET
                task_order = EXCLUDED.task_order,
                collapsed_columns = EXCLUDED.collapsed_columns,
                updated_at = CURRENT_TIMESTAMP
             RETURNING task_order, collapsed_columns`,
            [username, JSON.stringify(taskOrder), JSON.stringify(collapsedColumns)],
        );
        return {
            card_order: result.rows[0]?.task_order ?? taskOrder,
            collapsed_columns: Array.isArray(result.rows[0]?.collapsed_columns)
                ? result.rows[0].collapsed_columns
                : collapsedColumns,
        };
    }

    static async syncIdSequence() {
        const maxResult = await pool.query('SELECT COALESCE(MAX(id), 0) AS max_id FROM tasks');
        const maxId = parseInt(maxResult.rows[0].max_id, 10) || 0;

        const seqResult = await pool.query(`SELECT pg_get_serial_sequence('tasks', 'id') AS sequence_name`);
        const sequenceName = seqResult.rows[0]?.sequence_name;

        if (sequenceName) {
            await pool.query('SELECT setval($1, $2, true)', [sequenceName, maxId]);
        }

        return maxId;
    }

    static async findUserPhotos(usernames = []) {
        const values = [];
        let filter = '';

        if (usernames.length) {
            values.push(usernames.map((name) => name.toLowerCase()));
            filter = 'AND LOWER(TRIM(pd.username)) = ANY($1::text[])';
        }

        const result = await pool.query(
            `
            SELECT
                pd.username,
                NULLIF(TRIM(pd.image), '') AS profile_image
            FROM personal_details pd
            LEFT JOIN master_employee me
                ON me.personal_details_id = pd.id
            WHERE pd.username IS NOT NULL
              AND NULLIF(TRIM(pd.image), '') IS NOT NULL
              AND LOWER(TRIM(me.status)) IN ('active', 'pending_approval')
              ${filter}
            `,
            values,
        );

        return result.rows;
    }

    /** Latest serial_number matching PREFIX-YEARCODE-%, used to compute the next one. */
    static async findLatestSerialNumber(prefix, yearCode, db = pool) {
        const pattern = `${prefix}-${yearCode}-%`;

        const result = await db.query(
            `
            SELECT serial_number
            FROM tasks
            WHERE serial_number LIKE $1
            ORDER BY
                CAST(
                    NULLIF(regexp_replace(TRIM(serial_number), '^.*-', ''), '')
                    AS INTEGER
                ) DESC NULLS LAST
            LIMIT 1
            `,
            [pattern],
        );

        return result.rows[0];
    }

    static parseAssignedTo(value) {
        if (value === null || value === undefined) return [];

        if (Array.isArray(value)) {
            return value.map((item) => String(item).trim()).filter(Boolean);
        }

        const stringValue = String(value).trim();
        if (!stringValue) return [];

        try {
            const parsed = JSON.parse(stringValue);
            if (Array.isArray(parsed)) {
                return parsed.map((item) => String(item).trim()).filter(Boolean);
            }
        } catch {
            // Not JSON - fall through to the comma / single-value parsing below.
        }

        if (stringValue.includes(',')) {
            return stringValue.split(',').map((item) => item.trim()).filter(Boolean);
        }

        return [stringValue];
    }
    static toDateString(value) {
        if (value instanceof Date) {
            if (Number.isNaN(value.getTime())) return null;
            const pad = (n) => String(n).padStart(2, '0');
            return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
        }
        return value ?? null;
    }

    /** timestamptz -> ISO string (UTC), the browser shows it in the user's own time zone. */
    static toIsoString(value) {
        if (value === null || value === undefined || value === '') return null;
        const date = value instanceof Date ? value : new Date(value);
        return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }

    /**
     * Target Hours: the database keeps decimal hours (3.0675), the API shows "HH:MM:SS" (03:04:03).
     * null / '' / invalid -> null.
     */
    static hoursToHms(value) {
        if (value === null || value === undefined || String(value).trim() === '') return null;
        const text = String(value).trim();
        const hours = text.includes(':') ? TaskModel.hmsToHours(text) : Number(text);
        if (hours === null || !Number.isFinite(hours) || hours < 0) return null;
        const total = Math.round(hours * 3600);
        const pad = (n) => String(n).padStart(2, '0');
        return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
    }

    /** "HH:MM:SS" (or "HH:MM") -> decimal hours, null when it is not a valid time. */
    static hmsToHours(text) {
        const match = /^(\d+)(?::(\d{1,2}))?(?::(\d{1,2}))?$/.exec(String(text).trim());
        if (!match) return null;
        const [, h, m = '0', s = '0'] = match;
        if (Number(m) > 59 || Number(s) > 59) return null;
        return (Number(h) * 3600 + Number(m) * 60 + Number(s)) / 3600;
    }

    /**
     * Target Hours as it is STORED and returned: text "h:mm:ss" (hours without a leading zero), e.g. 1:30:00.
     * Accepts "H:MM:SS" / "HH:MM:SS" / "HH:MM" or decimal hours (old data). null / '' / invalid / zero -> null.
     */
    static toStoredHms(value) {
        if (value === null || value === undefined || String(value).trim() === '') return null;
        const text = String(value).trim();
        const hours = text.includes(':') ? TaskModel.hmsToHours(text) : Number(text);
        if (hours === null || !Number.isFinite(hours) || hours < 0) return null;
        const total = Math.round(hours * 3600);
        if (total <= 0) return null;
        const pad = (n) => String(n).padStart(2, '0');
        return `${Math.floor(total / 3600)}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
    }

    /** Accepts "HH:MM:SS" or decimal hours (number / numeric string) -> decimal hours for the database. */
    static toDecimalHours(value) {
        if (value === null || value === undefined || String(value).trim() === '') return null;
        const text = String(value).trim();
        const hours = text.includes(':') ? TaskModel.hmsToHours(text) : parseFloat(text);
        return Number.isFinite(hours) && hours >= 0 ? hours : null;
    }
    /** Store the task's total worked time (sum of its timesheet durations) in tasks.duration. */
    static async recalculateDuration(taskId) {
        const id = parseInt(taskId, 10);
        if (!Number.isFinite(id)) return null;
        const result = await pool.query(
            `UPDATE tasks SET duration = ${TASK_WORKED_HMS_SQL('$1')}
             WHERE id = $1 RETURNING duration`,
            [id],
        );
        return result.rows[0]?.duration ?? null;
    }

    static formatRow(task) {
        if (!task) return task;
        // Old columns that may still exist in the database are never sent to the client.
        const row = { ...task };
        for (const key of REMOVED_TASK_COLUMNS) delete row[key];
        return {
            ...row,
            // ONE assigned user as plain text (old rows saved as a JSON array / comma list -> first user).
            assigned_to: TaskModel.parseAssignedTo(task.assigned_to)[0] ?? null,
            assigned_at: TaskModel.toIsoString(task.assigned_at),
            target_completion_at: TaskModel.toIsoString(task.target_completion_at),
            review_at: TaskModel.toIsoString(task.review_at),
            completed_at: TaskModel.toIsoString(task.completed_at),
            target_hour: TaskModel.toStoredHms(task.target_hour),
        };
    }

    /** Convert the assigned user to database format: ONE plain username (no JSON array). */
    static serializeAssignedTo(value) {
        return this.parseAssignedTo(value)[0] ?? null;
    }

    /** Lower-case, trimmed, unique user names from an array or a comma separated string. */
    static cleanUserList(value) {
        const list = Array.isArray(value) ? value : String(value ?? '').split(',');
        return [...new Set(list.map((v) => String(v ?? '').trim().toLowerCase()).filter(Boolean))];
    }

    static buildFilters(filters = {}) {
        const {
            project_category, project_code, project_id, project_by,
            process_id, process_name, status, created_by, assigned_by,
            assigned_to, search, target_completion_date, serial_number,
            title, assigned_date, mine, view, priority, q, teamUsernames, includeCreator,
            priority_kind, assigned_user, date_filter, tz,
            assigned_users, creator_users, related_users,
        } = filters;

        const conditions = [];
        const params = [];

        if (serial_number) {
            params.push(serial_number.trim());
            conditions.push(`TRIM(UPPER(serial_number)) = TRIM(UPPER($${params.length}))`);
        }
        if (title) {
            params.push(`%${title}%`);
            conditions.push(`title ILIKE $${params.length}`);
        }

        if (project_category) {
            params.push(project_category.trim());
            conditions.push(`TRIM(UPPER(project_category)) = TRIM(UPPER($${params.length}))`);
        }

        if (project_id) {
            params.push(parseInt(project_id, 10));
            conditions.push(`project_id = $${params.length}`);
        }

        if (project_code) {
            params.push(project_code.trim());
            conditions.push(`TRIM(UPPER(project_code)) = TRIM(UPPER($${params.length}))`);
        }

        if (project_by) {
            params.push(`%${project_by}%`);
            conditions.push(`project_by ILIKE $${params.length}`);
        }

        if (process_id) {
            params.push(parseInt(process_id, 10));
            conditions.push(`process_id = $${params.length}`);
        } else if (process_name) {
            params.push(`%${process_name}%`);
            conditions.push(`process_name ILIKE $${params.length}`);
        }

        if (status) {
            params.push(status.trim());
            conditions.push(`TRIM(UPPER(status)) = TRIM(UPPER($${params.length}))`);
        }

        if (priority) {
            params.push(priority.trim());
            conditions.push(`TRIM(UPPER(priority)) = TRIM(UPPER($${params.length}))`);
        }

        // Stat card filters (Priority / User / Date), same meaning as the cards on the board.
        // Priority: an empty or unknown priority counts as Medium (the form's default).
        const priorityKind = String(priority_kind ?? '').trim().toLowerCase();
        if (priorityKind === 'medium') {
            conditions.push(`TRIM(UPPER(COALESCE(priority, ''))) NOT IN ('HIGH', 'LOW')`);
        } else if (priorityKind === 'high' || priorityKind === 'low') {
            params.push(priorityKind);
            conditions.push(`TRIM(LOWER(COALESCE(priority, ''))) = $${params.length}::text`);
        }

        // User: exact username (old rows may still hold a JSON array / list of users).
        const assignedUser = String(assigned_user ?? '').trim().toLowerCase();
        if (assignedUser) {
            params.push(assignedUser);
            const idx = params.length;
            conditions.push(`(
                LOWER(TRIM(COALESCE(assigned_to, ''))) = $${idx}::text
                OR position('"' || $${idx}::text || '"' IN LOWER(COALESCE(assigned_to, ''))) > 0
            )`);
        }

        // "Search user..." box (Assigned To list): a task matches when ANY ticked user is assigned to it.
        // assigned_to may hold a single name, a JSON array or a comma list, so all three are checked.
        const assignedList = TaskModel.cleanUserList(assigned_users);
        if (assignedList.length > 0) {
            params.push(assignedList);
            const idx = params.length;
            conditions.push(`EXISTS (
                SELECT 1 FROM unnest($${idx}::text[]) AS au(u)
                WHERE LOWER(TRIM(COALESCE(assigned_to, ''))) = au.u
                   OR position('"' || au.u || '"' IN LOWER(COALESCE(assigned_to, ''))) > 0
                   OR position(',' || au.u || ',' IN ',' || REGEXP_REPLACE(LOWER(COALESCE(assigned_to, '')), '\\s*,\\s*', ',', 'g') || ',') > 0
            )`);
        }

        // "Search user..." box in the Assigned to Me view (Created By list): same name the card shows
        // under "Created By" = assigned_by, falling back to created_by.
        const creatorList = TaskModel.cleanUserList(creator_users);
        if (creatorList.length > 0) {
            params.push(creatorList);
            conditions.push(
                `LOWER(TRIM(COALESCE(NULLIF(TRIM(assigned_by), ''), created_by, ''))) = ANY($${params.length}::text[])`,
            );
        }

        // Combined user search: match when the name is either assigned to the task or created it.
        const relatedList = TaskModel.cleanUserList(related_users);
        if (relatedList.length > 0) {
            params.push(relatedList);
            const idx = params.length;
            conditions.push(`(
                EXISTS (
                    SELECT 1 FROM unnest($${idx}::text[]) AS au(u)
                    WHERE LOWER(TRIM(COALESCE(assigned_to, ''))) = au.u
                       OR position('"' || au.u || '"' IN LOWER(COALESCE(assigned_to, ''))) > 0
                       OR position(',' || au.u || ',' IN ',' || REGEXP_REPLACE(LOWER(COALESCE(assigned_to, '')), '\\s*,\\s*', ',', 'g') || ',') > 0
                )
                OR LOWER(TRIM(COALESCE(NULLIF(TRIM(assigned_by), ''), created_by, ''))) = ANY($${idx}::text[])
            )`);
        }

        // Date: the ASSIGNED day (in the viewer's time zone) - Past / Yesterday / Today / Tomorrow / This Week.
        const dateSql = TaskModel.assignedDayCondition(date_filter, tz, params);
        if (dateSql) conditions.push(dateSql);

        if (created_by) {
            params.push(`%${created_by}%`);
            conditions.push(`created_by ILIKE $${params.length}`);
        }

        if (assigned_by) {
            params.push(`%${assigned_by}%`);
            conditions.push(`assigned_by ILIKE $${params.length}`);
        }

        // assigned_to is stored as JSON text, so search inside the JSON string.
        if (assigned_to) {
            const assignedUsers = Array.isArray(assigned_to) ? assigned_to : [assigned_to];
            const assignedConditions = [];

            for (const user of assignedUsers) {
                if (!user) continue;
                params.push(`%${String(user).trim()}%`);
                assignedConditions.push(`assigned_to ILIKE $${params.length}`);
            }

            if (assignedConditions.length > 0) {
                conditions.push(`(${assignedConditions.join(' OR ')})`);
            }
        }

        if (search) {
            params.push(`%${search}%`);
            conditions.push(`(
                title ILIKE $${params.length}
                OR description ILIKE $${params.length}
                OR project_code ILIKE $${params.length}
            )`);
        }

        // One box searches title, project, process and users.
        // Each tag (separated by "|") is searched on its own; a task is shown if it matches ANY tag (OR).
        if (q && String(q).trim()) {
            const terms = String(q).split('|').map((t) => t.trim()).filter(Boolean);
            const termConditions = terms.map((term) => {
                params.push(`%${term}%`);
                const idx = params.length;
                return `(
                    title ILIKE $${idx}
                    OR project_code ILIKE $${idx}
                    OR process_name ILIKE $${idx}
                    OR assigned_to ILIKE $${idx}
                    OR assigned_by ILIKE $${idx}
                    OR created_by ILIKE $${idx}
                )`;
            });
            if (termConditions.length > 0) {
                conditions.push(`(${termConditions.join(' OR ')})`);
            }
        }

        // The date filters take YYYY-MM-DD and match the day of the stored timestamp.
        if (target_completion_date) {
            params.push(target_completion_date);
            conditions.push(`target_completion_at::date = $${params.length}::date`);
        }

        if (assigned_date) {
            params.push(assigned_date);
            conditions.push(`assigned_at::date = $${params.length}::date`);
        }

    
        if (mine) {
            const me = String(mine).trim();
            if (me) {
                const esc = (v) => v.replace(/[\\%_]/g, (c) => `\\${c}`);
                const lower = me.toLowerCase();

                const mode = String(view ?? 'all').trim().toLowerCase();
                const needAssigned = mode !== 'created';   
                const needCreated = mode !== 'assigned';   

                params.push(lower);
                const exactIdx = params.length;                 
                let jsonIdx = 0;
                let csvIdx = 0;
                if (needAssigned) {
                    params.push(`%${esc(JSON.stringify(me))}%`);
                    jsonIdx = params.length;                   
                    params.push(`%,${esc(lower.replace(/\s+/g, ''))},%`);
                    csvIdx = params.length;                    
                }

                const assignedToMe = needAssigned ? `(
                    LOWER(TRIM(COALESCE(assigned_to, ''))) = $${exactIdx}
                    OR assigned_to ILIKE $${jsonIdx}
                    OR (',' || REGEXP_REPLACE(LOWER(COALESCE(assigned_to, '')), '\\s*,\\s*', ',', 'g') || ',') LIKE $${csvIdx}
                )` : '';

                const createdByMe = needCreated
                    ? `(LOWER(TRIM(COALESCE(assigned_by, ''))) = $${exactIdx}${
                        includeCreator ? ` OR LOWER(TRIM(COALESCE(created_by, ''))) = $${exactIdx}` : ''
                    })`
                    : '';

                if (mode === 'assigned') {
                    if (Array.isArray(teamUsernames) && teamUsernames.length > 0) {
                        conditions.push(assignedToMe);
                    } else {
                        conditions.push(assignedToMe);
                    }
                } else if (mode === 'created') {
                    if (Array.isArray(teamUsernames) && teamUsernames.length > 0) {
                        conditions.push(createdByMe);
                    } else {
                        conditions.push(createdByMe);
                    }
                } else {
                    // Head right: also the tasks assigned to the members of my department.
                    let teamAssigned = '';
                    if (Array.isArray(teamUsernames) && teamUsernames.length > 0) {
                        params.push(teamUsernames.map((u) => String(u).trim().toLowerCase()).filter(Boolean));
                        const teamIdx = params.length;
                        // Head right: tasks assigned to a department member, or assigned / created by one.
                        teamAssigned = ` OR LOWER(TRIM(COALESCE(assigned_by, ''))) = ANY($${teamIdx}::text[])
                            OR LOWER(TRIM(COALESCE(created_by, ''))) = ANY($${teamIdx}::text[])
                            OR EXISTS (
                            SELECT 1 FROM unnest($${teamIdx}::text[]) AS tm(u)
                            WHERE LOWER(TRIM(COALESCE(assigned_to, ''))) = tm.u
                               OR position('"' || tm.u || '"' IN LOWER(COALESCE(assigned_to, ''))) > 0
                               OR position(',' || tm.u || ',' IN ',' || REGEXP_REPLACE(LOWER(COALESCE(assigned_to, '')), '\\s*,\\s*', ',', 'g') || ',') > 0
                        )`;
                    }
                    conditions.push(`(${assignedToMe} OR ${createdByMe}${teamAssigned})`); // everything I can see
                }
            }
        }

        // Organization "All" scope has no mine/team restriction.  In that scope,
        // Assigned/Created are global views and must still filter by task ownership.
        if (!mine) {
            const globalView = String(view ?? '').trim().toLowerCase();
            if (globalView === 'assigned') {
                conditions.push(`TRIM(COALESCE(assigned_to, '')) <> ''`);
            } else if (globalView === 'created') {
                conditions.push(`(
                    TRIM(COALESCE(assigned_by, '')) <> ''
                    OR TRIM(COALESCE(created_by, '')) <> ''
                )`);
            }
        }

        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

        return { where, params };
    }

    /** SQL for the assigned-day of a task / today in the given time zone. */
    static assignedDaySql(zoneParam) {
        return {
            day: `(assigned_at AT TIME ZONE ${zoneParam})::date`,
            today: `(NOW() AT TIME ZONE ${zoneParam})::date`,
        };
    }

    /** WHERE part for a date card (past | yesterday | today | tomorrow | week); null for anything else. Adds its own param. */
    static assignedDayCondition(kind, tz, params) {
        const name = String(kind ?? '').trim().toLowerCase();
        if (!['past', 'yesterday', 'today', 'tomorrow', 'week'].includes(name)) return null;

        params.push(tz || 'UTC');
        const { day, today } = TaskModel.assignedDaySql(`$${params.length}::text`);

        switch (name) {
            case 'past': return `${day} < ${today}`;
            case 'yesterday': return `${day} = ${today} - 1`;
            case 'today': return `${day} = ${today}`;
            case 'tomorrow': return `${day} = ${today} + 1`;
            // Monday -> Sunday of the current week.
            default: return `(${day} >= date_trunc('week', ${today})::date AND ${day} < date_trunc('week', ${today})::date + 7)`;
        }
    }

   
    static async dimensionCounts(filters = {}, tz = 'UTC') {
        const base = {
            ...filters, priority_kind: undefined, date_filter: undefined, assigned_user: undefined, priority: undefined,
            assigned_users: undefined, creator_users: undefined, related_users: undefined,
        };

        const { where, params } = TaskModel.buildFilters(base);
        params.push(tz || 'UTC');
        const { day, today } = TaskModel.assignedDaySql(`$${params.length}::text`);
        const weekStart = `date_trunc('week', ${today})::date`;

        const summary = await pool.query(
            `SELECT
                COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE TRIM(UPPER(COALESCE(priority, ''))) = 'HIGH')::int AS high,
                COUNT(*) FILTER (WHERE TRIM(UPPER(COALESCE(priority, ''))) = 'LOW')::int AS low,
                COUNT(*) FILTER (WHERE ${day} < ${today})::int AS past,
                COUNT(*) FILTER (WHERE ${day} = ${today} - 1)::int AS yesterday,
                COUNT(*) FILTER (WHERE ${day} = ${today})::int AS today,
                COUNT(*) FILTER (WHERE ${day} = ${today} + 1)::int AS tomorrow,
                COUNT(*) FILTER (WHERE ${day} >= ${weekStart} AND ${day} < ${weekStart} + 7)::int AS week
             FROM tasks ${where}`,
            params,
        );
        const row = summary.rows[0] ?? {};

        const userFilters = TaskModel.buildFilters(base);
        const users = await pool.query(
            `SELECT assigned_to, COUNT(*)::int AS count FROM tasks ${userFilters.where} GROUP BY assigned_to`,
            userFilters.params,
        );
        const user = {};
        const display = new Map();
        for (const { assigned_to, count } of users.rows) {
            for (const name of TaskModel.parseAssignedTo(assigned_to)) {
                const clean = String(name).trim();
                if (!clean) continue;
                const key = clean.toLowerCase();
                if (!display.has(key)) display.set(key, clean);
                user[display.get(key)] = (user[display.get(key)] ?? 0) + count;
            }
        }

        // Creators ("Created By" list of the Assigned to Me view) with their task counts.
        const creators = await pool.query(
            `SELECT COALESCE(NULLIF(TRIM(assigned_by), ''), TRIM(created_by), '') AS creator, COUNT(*)::int AS count
             FROM tasks ${userFilters.where} GROUP BY 1`,
            userFilters.params,
        );
        const creator = {};
        const creatorDisplay = new Map();
        for (const { creator: name, count } of creators.rows) {
            const clean = String(name ?? '').trim();
            if (!clean) continue;
            const key = clean.toLowerCase();
            if (!creatorDisplay.has(key)) creatorDisplay.set(key, clean);
            creator[creatorDisplay.get(key)] = (creator[creatorDisplay.get(key)] ?? 0) + count;
        }

        // Combined user-search count: one task is counted once per matching creator or assignee,
        // including tasks that match both roles for the same user.
        const relatedRows = await pool.query(
            `SELECT id, assigned_to,
                    COALESCE(NULLIF(TRIM(assigned_by), ''), TRIM(created_by), '') AS creator
             FROM tasks ${userFilters.where}`,
            userFilters.params,
        );
        const related = {};
        const relatedDisplay = new Map();
        for (const row of relatedRows.rows) {
            const names = new Map();
            for (const name of TaskModel.parseAssignedTo(row.assigned_to)) {
                const clean = String(name).trim();
                if (clean) names.set(clean.toLowerCase(), clean);
            }
            const creator = String(row.creator ?? '').trim();
            if (creator) names.set(creator.toLowerCase(), creator);

            for (const [key, clean] of names) {
                if (!relatedDisplay.has(key)) relatedDisplay.set(key, clean);
                const displayName = relatedDisplay.get(key);
                related[displayName] = (related[displayName] ?? 0) + 1;
            }
        }

        const total = row.total ?? 0;
        return {
            total,
            priority: { high: row.high ?? 0, medium: total - (row.high ?? 0) - (row.low ?? 0), low: row.low ?? 0 },
            date: {
                past: row.past ?? 0, yesterday: row.yesterday ?? 0, today: row.today ?? 0,
                tomorrow: row.tomorrow ?? 0, week: row.week ?? 0,
            },
            user,
            creator,
            related,
        };
    }

    /** Get all tasks. */
    static async findAll(filters = {}) {
        const { where, params } = TaskModel.buildFilters(filters);

        // is_working: true while a timer is running on the task (started and not paused / stopped).
        // running_since: when that timer was started (used to show the task that started first, first).
        const result = await pool.query(
            `SELECT tasks.*,
                EXISTS (
                    SELECT 1 FROM "TIMESHEET" ts
                    WHERE ts.task_id = tasks.id
                      AND (ts.stop_time IS NULL OR TRIM(ts.stop_time::text) = '' OR ts.stop_time::text = 'Ongoing')
                ) AS is_working,
                (
                    SELECT MIN(ts.created_at) FROM "TIMESHEET" ts
                    WHERE ts.task_id = tasks.id
                      AND (ts.stop_time IS NULL OR TRIM(ts.stop_time::text) = '' OR ts.stop_time::text = 'Ongoing')
                ) AS running_since,
                ${REVIEW_AT_SQL} AS review_at,
                ${COMPLETED_AT_SQL} AS completed_at
             FROM tasks ${where} ORDER BY id DESC`,
            params,
        );

        return result.rows.map((task) => (TaskModel.formatRow(task)));
    }

    static async countByStatus(filters = {}) {
        const { where, params } = TaskModel.buildFilters({ ...filters, status: undefined });

        const result = await pool.query(
            `SELECT status, COUNT(*)::int AS count FROM tasks ${where} GROUP BY status`,
            params,
        );

        const counts = {};
        for (const row of result.rows) counts[row.status ?? ''] = row.count;

        return counts;
    }


    static async countPendingReview(username, reviewStatus = 'Review') {
        const name = String(username ?? '').trim();
        if (!name) return 0;

        const isSuperAdmin = name.toLowerCase() === 'admin';
        const { where, params } = TaskModel.buildFilters(
            isSuperAdmin ? {} : { mine: name },
        );

        params.push(reviewStatus);
        const statusIdx = params.length;
        params.push(name);
        const reviewerIdx = params.length;

        const result = await pool.query(
            `SELECT COUNT(*)::int AS count
             FROM tasks
             ${where ? `${where} AND` : 'WHERE'}
               LOWER(TRIM(COALESCE(status, ''))) = LOWER(TRIM($${statusIdx}))
               AND LOWER(TRIM(COALESCE(assigned_by, created_by, ''))) = LOWER($${reviewerIdx})`,
            params,
        );

        return result.rows[0]?.count ?? 0;
    }

    static async findTimeEntries(taskId) {
        const result = await pool.query(
            `SELECT id, task_id, date, user_name, project_code, process_name,
                    start_time, stop_time, duration, notes
             FROM "TIMESHEET"
             WHERE task_id = $1
             ORDER BY id ASC`,
            [parseInt(taskId, 10)],
        );

        return result.rows;
    }

    static normalizeProcessKey(value) {
        return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    }

    /** Trailing "(PCBCODE)" on a saved process_name, e.g. "DESIGN(0350626)". */
    static parsePcbCodeFromProcessName(value) {
        const raw = String(value ?? '').trim();
        const match = raw.match(/^.+\(([^)]+)\)\s*$/);
        if (match?.[1]?.trim()) return match[1].trim();
        // New format: "395004/PLANNING/SOW/test" (PCB code first, then the process path)
        const leading = raw.match(/^(\d{4,})\s*\/\s*.+$/);
        return leading?.[1]?.trim() || '';
    }

    static splitProcessSegments(value) {
        let raw = String(value ?? '').trim();
        const pcb = TaskModel.parsePcbCodeFromProcessName(raw);
        if (pcb) {
            // old format "SOW(395004)" -> drop the suffix; new format "395004/SOW" -> drop the prefix
            raw = raw.replace(/\(\s*[^)]*\)\s*$/, '').trim();
            const slash = raw.indexOf('/');
            if (slash > 0 && raw.slice(0, slash).trim() === pcb) {
                raw = raw.slice(slash + 1).trim();
            }
        }
        return raw
            .split('/')
            .map((part) => TaskModel.normalizeProcessKey(part))
            .filter(Boolean);
    }


    static async findByProcessScope(opts = {}) {
        const {
            project_id, project_code, process_id, process_path,
            category_letter, pcb_code,
        } = opts;
        const includeParents = opts.include_parents !== false;
        const includeChildren = opts.include_children !== false;
        // true  -> also return tasks of the same process from OTHER projects
        const allProjects = opts.all_projects === true;

        // ---- 1. Which project is "current" ------------------------------
        const pid = parseInt(project_id, 10);
        const hasPid = Number.isFinite(pid) && pid > 0;
        const pcode = String(project_code ?? '').trim();
        if (!hasPid && !pcode) return { process: null, tasks: [] };

        const isCurrentProject = (row) =>
            (hasPid && row.project_id != null && Number(row.project_id) === pid) ||
            (pcode &&
                TaskModel.normalizeProcessKey(row.project_code) ===
                TaskModel.normalizeProcessKey(pcode));

        // ---- 2. Categories tree (id / parent_id / letter / name) --------
        const catResult = await pool.query(
            'SELECT id, parent_id, letter, name FROM categories ORDER BY id ASC',
        );
        const categories = catResult.rows;
        const byId = new Map(categories.map((c) => [Number(c.id), c]));
        const childrenOf = new Map();
        for (const c of categories) {
            const key = c.parent_id == null ? null : Number(c.parent_id);
            if (!childrenOf.has(key)) childrenOf.set(key, []);
            childrenOf.get(key).push(c);
        }

        // Root -> node chain WITHOUT the project-category root ("R&D (R)").
        const chainFor = (id) => {
            const chain = [];
            const seen = new Set();
            let cur = byId.get(Number(id));
            while (cur && !seen.has(Number(cur.id))) {
                seen.add(Number(cur.id));
                chain.unshift(cur);
                cur = cur.parent_id != null ? byId.get(Number(cur.parent_id)) : null;
            }
            if (chain.length > 1 && chain[0].parent_id == null) chain.shift();
            return chain;
        };

        // ---- 3. Resolve the selected process ----------------------------
        let targetId = null;
        const wantedId = parseInt(process_id, 10);
        if (Number.isFinite(wantedId) && byId.has(wantedId)) {
            targetId = wantedId;
        } else {
            const segs = TaskModel.splitProcessSegments(process_path);
            if (segs.length > 0) {
                const letter = String(category_letter ?? '').trim().toUpperCase();
                let roots = childrenOf.get(null) || [];
                if (letter) {
                    roots = roots.filter(
                        (r) => String(r.letter ?? '').trim().toUpperCase() === letter,
                    );
                }
                for (const root of roots) {
                    let cur = root;
                    for (const seg of segs) {
                        cur = (childrenOf.get(Number(cur.id)) || []).find(
                            (c) => TaskModel.normalizeProcessKey(c.name) === seg,
                        );
                        if (!cur) break;
                    }
                    if (cur) { targetId = Number(cur.id); break; }
                }
            }
        }

        const ancestorIds = new Map(); 
        const descendantIds = new Map(); 
        let targetSegments = TaskModel.splitProcessSegments(process_path);
        let resolvedProcess = null;

        if (targetId != null) {
            const chain = chainFor(targetId);
            targetSegments = chain.map((c) => TaskModel.normalizeProcessKey(c.name));
            chain.slice(0, -1).forEach((c, idx, arr) => {
                ancestorIds.set(Number(c.id), arr.length - idx);
            });

            const queue = [{ id: targetId, depth: 0 }];
            while (queue.length) {
                const { id, depth } = queue.shift();
                for (const child of childrenOf.get(id) || []) {
                    const cid = Number(child.id);
                    if (descendantIds.has(cid)) continue;
                    descendantIds.set(cid, depth + 1);
                    queue.push({ id: cid, depth: depth + 1 });
                }
            }

            resolvedProcess = {
                id: targetId,
                name: byId.get(targetId).name,
                path: chain.map((c) => String(c.name).trim()).join('/'),
                path_segments: chain.map((c) => String(c.name).trim()),
            };
        } else if (targetSegments.length > 0) {
            resolvedProcess = {
                id: null,
                name: String(process_path ?? '').split('/').pop().trim(),
                path: String(process_path ?? '').trim(),
                path_segments: String(process_path ?? '').split('/').map((s) => s.trim()).filter(Boolean),
            };
        }

        if (!resolvedProcess) return { process: null, tasks: [] };

        // ---- 3b. Load candidate tasks ------------------------------------
        let taskRows;
        if (allProjects) {
            // Same process family used in ANY project. Narrow in SQL first so
            // we don't pull the whole tasks table.
            const family = [
                ...(targetId != null
                    ? [targetId, ...ancestorIds.keys(), ...descendantIds.keys()]
                    : []),
            ];
            const lastSeg = resolvedProcess.path_segments[resolvedProcess.path_segments.length - 1] || '';
            const allCatIds = categories.map((c) => Number(c.id));
            const result = await pool.query(
                `
                SELECT * FROM tasks
                WHERE process_id = ANY($1::int[])
                   OR process_id IS NULL
                   OR NOT (process_id = ANY($2::int[]))
                   OR process_name ILIKE $3
                ORDER BY id ASC
                `,
                [family, allCatIds, `%${lastSeg}%`],
            );
            taskRows = result.rows;
        } else {
            const params = [];
            const conditions = [];
            if (hasPid) {
                params.push(pid);
                conditions.push(`project_id = $${params.length}`);
            }
            if (pcode) {
                params.push(pcode);
                conditions.push(`TRIM(UPPER(project_code)) = TRIM(UPPER($${params.length}))`);
            }
            const result = await pool.query(
                `SELECT * FROM tasks WHERE (${conditions.join(' OR ')}) ORDER BY id ASC`,
                params,
            );
            taskRows = result.rows;
        }

        // ---- 4. Classify each task --------------------------------------
        const wantedPcb = TaskModel.normalizeProcessKey(pcb_code);
        const rank = { parent: 0, self: 1, child: 2 };
        const matched = [];

        for (const row of taskRows) {
            if (wantedPcb) {
                const taskPcb = TaskModel.normalizeProcessKey(
                    TaskModel.parsePcbCodeFromProcessName(row.process_name),
                );
                if (taskPcb !== wantedPcb) continue;
            }

            let relation = null;
            let distance = 0;
            let taskPath = '';

            const taskCatId = row.process_id != null ? Number(row.process_id) : null;

            if (targetId != null && taskCatId != null && byId.has(taskCatId)) {
                // Reliable path: compare category ids.
                if (taskCatId === targetId) {
                    relation = 'self';
                } else if (ancestorIds.has(taskCatId)) {
                    relation = 'parent';
                    distance = ancestorIds.get(taskCatId);
                } else if (descendantIds.has(taskCatId)) {
                    relation = 'child';
                    distance = descendantIds.get(taskCatId);
                }
                if (relation) {
                    taskPath = chainFor(taskCatId).map((c) => String(c.name).trim()).join('/');
                }
            } else {
                // Fallback: compare saved process_name paths.
                const segs = TaskModel.splitProcessSegments(row.process_name);
                if (segs.length > 0) {
                    const t = targetSegments;
                    const isPrefix = (a, b) => a.length <= b.length && a.every((s, i) => s === b[i]);

                    if (segs.length === t.length && isPrefix(segs, t)) {
                        relation = 'self';
                    } else if (segs.length < t.length && isPrefix(segs, t)) {
                        relation = 'parent';
                        distance = t.length - segs.length;
                    } else if (segs.length > t.length && isPrefix(t, segs)) {
                        relation = 'child';
                        distance = segs.length - t.length;
                    } else if (segs.length === 1) {
                        // Name saved as only the last segment ("SCHEMATIC").
                        const idx = t.lastIndexOf(segs[0]);
                        if (idx === t.length - 1) {
                            relation = 'self';
                        } else if (idx >= 0) {
                            relation = 'parent';
                            distance = t.length - 1 - idx;
                        }
                    }
                    taskPath = String(row.process_name ?? '').trim();
                }
            }

            if (!relation) continue;
            if (relation === 'parent' && !includeParents) continue;
            if (relation === 'child' && !includeChildren) continue;

            matched.push({
                ...TaskModel.formatRow(row),
                relation,
                relation_distance: distance,
                process_path: taskPath,
                is_current_project: Boolean(isCurrentProject(row)),
            });
        }

        matched.sort((a, b) => {
            if (rank[a.relation] !== rank[b.relation]) return rank[a.relation] - rank[b.relation];
            if (a.relation === 'parent' && a.relation_distance !== b.relation_distance) {
                return b.relation_distance - a.relation_distance; // top-most parent first
            }
            if (a.relation === 'child' && a.relation_distance !== b.relation_distance) {
                return a.relation_distance - b.relation_distance;
            }
            // This project's tasks before other projects' tasks.
            if (a.is_current_project !== b.is_current_project) {
                return a.is_current_project ? -1 : 1;
            }
            return Number(a.id) - Number(b.id);
        });

        return { process: resolvedProcess, tasks: matched };
    }

    /** Find task by ID. */
    static async findById(id) {
        const result = await pool.query(
            `SELECT tasks.*, ${REVIEW_AT_SQL} AS review_at, ${COMPLETED_AT_SQL} AS completed_at FROM tasks WHERE tasks.id = $1`,
            [id],
        );
        if (!result.rows[0]) return null;

        const task = result.rows[0];
        return TaskModel.formatRow(task);
    }

    /** Create task. */
    static async create(data, db = pool) {
        const {
            serial_number, title, project_category, project_id, project_code,
            project_by, process_id, process_name, description, status, priority,
            created_by, assigned_by, assigned_to, assigned_at,
            target_completion_at, target_hour,
        } = data;

        // assigned_to is optional
        const serializedAssignedTo = assigned_to
            ? TaskModel.serializeAssignedTo(assigned_to)
            : null;

        const insertSql = `
    INSERT INTO tasks (
        serial_number, title, project_category, project_id,
        project_code, project_by, process_id, process_name,
        description, status, priority, created_by,
        assigned_by, assigned_to, assigned_at,
        target_completion_at, target_hour
    )
    VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
        $13, $14, $15::timestamptz, $16::timestamptz, $17
    )
    RETURNING *
`;

        const params = [
            serial_number || null,
            title || null,
            project_category || null,
            project_id ? parseInt(project_id, 10) : null,
            project_code || null,
            project_by || null,
            process_id ? parseInt(process_id, 10) : null,
            process_name || null,
            description || null,
            status || 'New',
            priority || 'Medium',
            created_by || null,
            assigned_by || null,
            serializedAssignedTo,
            // Only the date & time the user picked is saved; when none is given it stays empty (NULL).
            assigned_at || null,
            target_completion_at || null,
            TaskModel.toStoredHms(target_hour),
        ];

        try {
            const result = await db.query(insertSql, params);
            const task = result.rows[0];

            return TaskModel.formatRow(task);
        } catch (error) {
            if (db === pool && error.code === '23505' && error.constraint === 'tasks_pkey') {
                await TaskModel.syncIdSequence();

                const retry = await db.query(insertSql, params);
                const task = retry.rows[0];

                return TaskModel.formatRow(task);
            }

            throw error;
        }
    }

    /** Runs `work(client)` in ONE transaction: COMMIT when it finishes, ROLLBACK when it throws. */
    static async inTransaction(work) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const result = await work(client);
            await client.query('COMMIT');
            return result;
        } catch (error) {
            try { await client.query('ROLLBACK'); } catch { /* connection already closed */ }
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Runs `attempt`; when the id sequence is behind the table (tasks_pkey clash) it is re-synced and
     * `attempt` runs once more. `onSerialClash` decides what a serial-number clash means.
     */
    static async withCreateRetry(attempt, onSerialClash) {
        try {
            return await attempt();
        } catch (error) {
            if (error.code === '23505' && error.constraint === 'tasks_pkey') {
                await TaskModel.syncIdSequence();
                return attempt();
            }
            if (error.code === '23505' && error.constraint === 'uq_tasks_serial_number') {
                return onSerialClash();
            }
            throw error;
        }
    }

    static buildNextSerial(latest, prefix, yearCode) {
        let nextNumber = 1;
        let padLen = 3;
        const lastPart = String(latest?.serial_number?.split('-').pop() ?? '').trim();
        const lastNum = parseInt(lastPart, 10);
        if (!Number.isNaN(lastNum)) {
            nextNumber = lastNum + 1;
            padLen = Math.max(3, lastPart.length, String(nextNumber).length);
        }
        return `${prefix}-${yearCode}-${String(nextNumber).padStart(padLen, '0')}`;
    }

    static async createWithSerial(data, serial_number) {
        const serialTaken = () => {
            const err = new Error('SERIAL_TAKEN');
            err.code = 'SERIAL_TAKEN';
            return err;
        };
        const attempt = () => TaskModel.inTransaction(async (client) => {
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['task_serial:custom']);
            const dup = await client.query(
                'SELECT 1 FROM tasks WHERE TRIM(UPPER(serial_number)) = TRIM(UPPER($1)) LIMIT 1',
                [serial_number],
            );
            if (dup.rows.length) throw serialTaken();
            return TaskModel.create({ ...data, serial_number }, client);
        });

        return TaskModel.withCreateRetry(attempt, () => { throw serialTaken(); });
    }
    static async createWithNextSerial(data, { prefix, yearCode }) {
        const attempt = () => TaskModel.inTransaction(async (client) => {
            // One lock per prefix+year; released automatically at COMMIT / ROLLBACK.
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`task_serial:${prefix}-${yearCode}`]);
            const latest = await TaskModel.findLatestSerialNumber(prefix, yearCode, client);
            const serial_number = TaskModel.buildNextSerial(latest, prefix, yearCode);
            return TaskModel.create({ ...data, serial_number }, client);
        });

        // Extremely rare serial collision: the retry reads the new latest number.
        return TaskModel.withCreateRetry(attempt, attempt);
    }

    /** Update task. */
    static async update(id, data, editedBy = null) {
        const existing = await TaskModel.findById(id);
        if (!existing) return null;

        // Keep existing value when a field is not supplied.
        const merged = {
            serial_number: existing.serial_number, // never changed after creation
            title: data.title ?? existing.title,
            project_category: data.project_category ?? existing.project_category,
            project_id: data.project_id !== undefined ? data.project_id : existing.project_id,
            project_code: data.project_code ?? existing.project_code,
            project_by: data.project_by ?? existing.project_by,
            process_id: data.process_id !== undefined ? data.process_id : existing.process_id,
            process_name: data.process_name ?? existing.process_name,
            description: data.description ?? existing.description,
            status: data.status ?? existing.status,
            priority: data.priority ?? existing.priority,
            created_by: existing.created_by,
            assigned_by: data.assigned_by ?? existing.assigned_by,
            assigned_to: data.assigned_to !== undefined ? data.assigned_to : existing.assigned_to,
            // Assigned Date & Time only changes when one is sent (when the task is scheduled).
            assigned_at: data.assigned_at !== undefined ? data.assigned_at : existing.assigned_at,
            target_completion_at: data.target_completion_at !== undefined ? data.target_completion_at : existing.target_completion_at,
            target_hour: data.target_hour !== undefined ? data.target_hour : existing.target_hour,
            reject_reason: data.reject_reason !== undefined ? data.reject_reason : existing.reject_reason,
            status_reason: data.status_reason !== undefined ? data.status_reason : existing.status_reason,
            resumed_from_hold: data.resumed_from_hold !== undefined ? data.resumed_from_hold : existing.resumed_from_hold,
            was_rejected: data.was_rejected !== undefined ? data.was_rejected : existing.was_rejected,
        };

        const serializedAssignedTo = TaskModel.serializeAssignedTo(merged.assigned_to);
        const client = await pool.connect();
        let result;
        try {
            await client.query('BEGIN');
            // Lock the row and read it exactly as stored, so the "old" snapshot is always correct.
            const beforeRes = await client.query('SELECT to_jsonb(t) AS j FROM tasks t WHERE id = $1 FOR UPDATE', [id]);
            const beforeJson = beforeRes.rows[0]?.j || null;
            result = await client.query(
            `
            UPDATE tasks
            SET
                serial_number = $1, title = $2, project_category = $3, project_id = $4,
                project_code = $5, project_by = $6, process_id = $7, process_name = $8,
                description = $9, status = $10, priority = $11, created_by = $12,
                assigned_by = $13, assigned_to = $14, assigned_at = $15::timestamptz,
                target_completion_at = $16::timestamptz, target_hour = $17,
                reject_reason = $18,
                status_reason = $19,
                resumed_from_hold = $20,
                was_rejected = $21,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $22
            RETURNING *, to_jsonb(tasks) AS _log_json
            `,
            [
                merged.serial_number || null,
                merged.title || null,
                merged.project_category || null,
                merged.project_id ? parseInt(merged.project_id, 10) : null,
                merged.project_code || null,
                merged.project_by || null,
                merged.process_id ? parseInt(merged.process_id, 10) : null,
                merged.process_name || null,
                merged.description || null,
                merged.status || 'New',
                merged.priority || 'Medium',
                merged.created_by || null,
                merged.assigned_by || null,
                serializedAssignedTo,
                merged.assigned_at || null,
                merged.target_completion_at || null,
                TaskModel.toStoredHms(merged.target_hour),
                merged.reject_reason || null,
                merged.status_reason || null,
                merged.resumed_from_hold === true,
                merged.was_rejected === true,
                id,
            ],
            );
            if (result.rows[0] && beforeJson) {
                await writeTaskLog(client, beforeJson, result.rows[0]._log_json, editedBy);
            }
            await client.query('COMMIT');
        } catch (err) {
            try { await client.query('ROLLBACK'); } catch { /* connection already closed */ }
            throw err;
        } finally {
            client.release();
        }

        if (!result.rows[0]) return null;

        const { _log_json, ...task } = result.rows[0];
        return TaskModel.formatRow(task);
    }

    /** Earliest assigned_at among Schedule tasks (the next moment a task is due to auto-start), or null. */
    static async nextAutoStartAt() {
        const result = await pool.query(`
            SELECT MIN(assigned_at) AS next_at FROM tasks
            WHERE TRIM(UPPER(status)) = 'SCHEDULE' AND assigned_at IS NOT NULL
        `);
        return result.rows[0]?.next_at ?? null;
    }

    static async autoStartDueTasks() {
        return TaskModel.inTransaction(async (client) => {
            const due = await client.query(`
                SELECT id, to_jsonb(t) AS j FROM tasks t
                WHERE TRIM(UPPER(status)) = 'SCHEDULE'
                    AND assigned_at IS NOT NULL
                    AND assigned_at <= NOW()
                FOR UPDATE
            `);
            const beforeById = new Map(due.rows.map((r) => [r.id, r.j]));
            if (beforeById.size === 0) return [];

            const result = await client.query(`
                UPDATE tasks
                SET status = 'IN PROGRESS',
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ANY($1::int[])
                RETURNING *, to_jsonb(tasks) AS _log_json
            `, [[...beforeById.keys()]]);

            for (const row of result.rows) {
                await writeTaskLog(client, beforeById.get(row.id), row._log_json, 'system');
            }
            return result.rows.map(({ _log_json, ...task }) => TaskModel.formatRow(task));
        });
    }
}

export default TaskModel;