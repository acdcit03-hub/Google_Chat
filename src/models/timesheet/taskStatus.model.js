import { pool } from '../../config/db.js';
import { TASK_STATUSES } from './task.model.js';

/** Details a status can ask the user for when a task is moved into it. */
export const STATUS_FIELD_KEYS = [];

export const REMOVED_STATUS_FIELD_KEYS = ['start_date', 'target_hour', 'stop_date', 'reason', 'completion_date', 'total_hour'];
const SYSTEM_REQUIRED_FIELDS = {
    Completed: [],
};

const SYSTEM_VARIANTS = {
    New: 'received',
    Schedule: 'urgent',
    'In Progress': 'issue',
    'On Hold': 'termreq',
    Stopped: 'terminated',
    Review: 'review',
    Completed: 'inPurchase',
};

/** Statuses added after the first release: created once on databases that already have statuses. */
const ADDED_SYSTEM_STATUSES = ['On Hold', 'Stopped'];

class TaskStatusModel {
    static async initializeTable() {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS task_statuses (
                id SERIAL PRIMARY KEY,
                name VARCHAR(50) NOT NULL,
                variant VARCHAR(30) NOT NULL DEFAULT 'received',
                sort_order INTEGER NOT NULL DEFAULT 0,
                is_system BOOLEAN NOT NULL DEFAULT FALSE,
                is_active BOOLEAN NOT NULL DEFAULT TRUE,
                show_start BOOLEAN NOT NULL DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            -- Migration for databases created before the active/inactive toggle existed.
            ALTER TABLE task_statuses ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
            ALTER TABLE task_statuses ADD COLUMN IF NOT EXISTS show_start BOOLEAN NOT NULL DEFAULT TRUE;
            -- NULL = "never configured"; the defaults below are applied exactly once.
            ALTER TABLE task_statuses ADD COLUMN IF NOT EXISTS required_fields TEXT[];
            -- Hex colour picked in Settings (e.g. #62da9e). NULL = automatic.
            ALTER TABLE task_statuses ADD COLUMN IF NOT EXISTS color VARCHAR(7);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_task_statuses_name ON task_statuses (LOWER(name));
        `);

                await pool.query(`
                        UPDATE task_statuses
                        SET show_start = FALSE
                        WHERE show_start = TRUE
                            AND id <> (
                                SELECT id FROM task_statuses
                                WHERE show_start = TRUE
                                ORDER BY sort_order ASC, id ASC
                                LIMIT 1
                            )
                `);
        await pool.query(
            'CREATE UNIQUE INDEX IF NOT EXISTS idx_task_statuses_single_play ON task_statuses ((show_start)) WHERE show_start = TRUE',
        );

        await pool.query(
            `INSERT INTO task_statuses (name, variant, sort_order, is_system, show_start)
             SELECT s.name, COALESCE(NULLIF(s.variant, ''), 'received'), (s.ord - 1)::int, TRUE, s.ord = 1
             FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS s(name, variant, ord)
             WHERE NOT EXISTS (SELECT 1 FROM task_statuses)`,
            [
                TASK_STATUSES,
                TASK_STATUSES.map((name) => SYSTEM_VARIANTS[name] || 'received'),
            ],
        );

        // Rename the old "Stop" system status to "Stopped" (it is a built-in status, so it cannot be edited in Settings).
        // Tasks are moved first; if "Stopped" already exists, the old "Stop" row is dropped instead of renamed.
        await pool.query(`UPDATE tasks SET status = 'Stopped' WHERE LOWER(status) = 'stop'`);
        if (await TaskStatusModel.findByName('Stopped')) {
            await pool.query(`DELETE FROM task_statuses WHERE LOWER(name) = 'stop'`);
        } else {
            await pool.query(`UPDATE task_statuses SET name = 'Stopped', updated_at = CURRENT_TIMESTAMP WHERE LOWER(name) = 'stop'`);
        }

        // Existing databases were seeded before "On Hold" and "Stopped" existed: add whichever is missing.
        // They are placed after "In Progress" (or at the end when that status is not found).
        for (const name of ADDED_SYSTEM_STATUSES) {
            if (await TaskStatusModel.findByName(name)) continue;
            const anchor = await pool.query(
                `SELECT sort_order FROM task_statuses
                 WHERE LOWER(name) IN ('on hold', 'in progress') ORDER BY sort_order DESC LIMIT 1`,
            );
            const sortOrder = anchor.rows.length
                ? anchor.rows[0].sort_order + 1
                : (await pool.query('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM task_statuses')).rows[0].next;
            // Make room so the new status sits right after the anchor without a sort_order clash.
            if (anchor.rows.length) {
                await pool.query('UPDATE task_statuses SET sort_order = sort_order + 1 WHERE sort_order >= $1', [sortOrder]);
            }
            await pool.query(
                `INSERT INTO task_statuses (name, variant, sort_order, is_system, show_start, required_fields)
                 VALUES ($1, $2, $3, TRUE, FALSE, '{}')`,
                [name, SYSTEM_VARIANTS[name] || 'received', sortOrder],
            );
        }

        // Backfill any existing rows that somehow have a null/empty variant.
        await pool.query(
            `UPDATE task_statuses SET variant = 'received' WHERE variant IS NULL OR BTRIM(variant) = ''`,
        );

        for (const [name, fields] of Object.entries(SYSTEM_REQUIRED_FIELDS)) {
            await pool.query(
                'UPDATE task_statuses SET required_fields = $2::text[] WHERE required_fields IS NULL AND is_system AND name = $1',
                [name, fields],
            );
        }
        await pool.query("UPDATE task_statuses SET required_fields = '{}' WHERE required_fields IS NULL");

        // Remove the retired prompts (Start Date / Target Hour / Stop Date / Reason) from every status,
        // so moving a task to In Progress never opens a modal or fails validation again.
        await pool.query(
            `UPDATE task_statuses
             SET required_fields = ARRAY(
                 SELECT f FROM unnest(required_fields) AS f WHERE f <> ALL($1::text[])
             )
             WHERE required_fields && $1::text[]`,
            [REMOVED_STATUS_FIELD_KEYS],
        );
    }

    /** All statuses (Settings page). Pass { activeOnly: true } for dropdowns / cards / board. */
    static async findAll({ activeOnly = false } = {}) {
        const result = await pool.query(
            `SELECT * FROM task_statuses ${activeOnly ? 'WHERE is_active = TRUE' : ''} ORDER BY sort_order ASC, id ASC`,
        );
        return result.rows;
    }

    static async findNames({ activeOnly = false } = {}) {
        const result = await pool.query(
            `SELECT name FROM task_statuses ${activeOnly ? 'WHERE is_active = TRUE' : ''} ORDER BY sort_order ASC, id ASC`,
        );
        return result.rows.map((row) => row.name);
    }

    /** First active status in board order - used as the default for new tasks. */
    static async findFirstActiveName() {
        const result = await pool.query(
            'SELECT name FROM task_statuses WHERE is_active = TRUE ORDER BY sort_order ASC, id ASC LIMIT 1',
        );
        return result.rows[0]?.name ?? null;
    }

    /** Active status row by (case-insensitive) name, or undefined. */
    static async findActiveByName(name) {
        const result = await pool.query(
            'SELECT * FROM task_statuses WHERE LOWER(name) = LOWER($1) AND is_active = TRUE',
            [String(name ?? '').trim()],
        );
        return result.rows[0];
    }

    static async countActive() {
        const result = await pool.query('SELECT COUNT(*)::int AS total FROM task_statuses WHERE is_active = TRUE');
        return result.rows[0].total;
    }

    static async findById(id) {
        const result = await pool.query('SELECT * FROM task_statuses WHERE id = $1', [id]);
        return result.rows[0];
    }

    static async findByName(name, excludeId = null) {
        const result = await pool.query(
            'SELECT * FROM task_statuses WHERE LOWER(name) = LOWER($1) AND id IS DISTINCT FROM $2',
            [name, excludeId],
        );
        return result.rows[0];
    }

    /** Another status that has saved this exact colour, or undefined. */
    static async findByColor(color, excludeId = null) {
        const result = await pool.query(
            'SELECT * FROM task_statuses WHERE LOWER(color) = LOWER($1) AND id IS DISTINCT FROM $2',
            [color, excludeId],
        );
        return result.rows[0];
    }

    static async countTasksUsing(name) {
        const result = await pool.query('SELECT COUNT(*)::int AS total FROM tasks WHERE LOWER(status) = LOWER($1)', [name]);
        return result.rows[0].total;
    }

    static async create({ name, variant = 'received', color = null, is_active = true, show_start = false, required_fields = [] }) {
        const result = await pool.query(
            `INSERT INTO task_statuses (name, variant, is_active, show_start, required_fields, color, sort_order)
             VALUES ($1, $2, $3, $4, $5::text[], $6, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM task_statuses))
             RETURNING *`,
            [name, variant, is_active, show_start, required_fields, color],
        );
        return result.rows[0];
    }

    /** Updates a status; a rename is applied to the tasks that use it in the same transaction. */
    static async update(id, { name, variant, is_active, show_start, required_fields, color }) {
        // `color` may be set to null on purpose, so track whether it was sent at all.
        const colorProvided = color !== undefined;
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('LOCK TABLE task_statuses IN SHARE ROW EXCLUSIVE MODE');
            const before = (await client.query('SELECT name FROM task_statuses WHERE id = $1 FOR UPDATE', [id])).rows[0];
            if (!before) {
                await client.query('ROLLBACK');
                return null;
            }
            if (show_start === true) {
                await client.query(
                    'UPDATE task_statuses SET show_start = FALSE WHERE id <> $1 AND show_start = TRUE',
                    [id],
                );
            }
            const updated = (await client.query(
                `UPDATE task_statuses
                 SET name = COALESCE($2, name),
                     variant = COALESCE($3, variant),
                     is_active = COALESCE($4, is_active),
                     show_start = COALESCE($5, show_start),
                     required_fields = COALESCE($6::text[], required_fields),
                     color = CASE WHEN $7::boolean THEN $8 ELSE color END,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1 RETURNING *`,
                [id, name ?? null, variant ?? null, is_active ?? null, show_start ?? null, required_fields ?? null, colorProvided, color ?? null],
            )).rows[0];
            if (updated.name !== before.name) {
                await client.query('UPDATE tasks SET status = $1 WHERE LOWER(status) = LOWER($2)', [updated.name, before.name]);
            }
            await client.query('COMMIT');
            return updated;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    static async delete(id) {
        const result = await pool.query('DELETE FROM task_statuses WHERE id = $1 RETURNING id', [id]);
        return result.rows[0];
    }

    static async reorder(ids) {
        await pool.query(
            `UPDATE task_statuses t SET sort_order = (v.ord - 1)::int
             FROM unnest($1::int[]) WITH ORDINALITY AS v(id, ord)
             WHERE t.id = v.id`,
            [ids],
        );
    }
}

export default TaskStatusModel;