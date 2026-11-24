import { pool } from '../../config/db.js';

/* ================= CREATE TABLE ================= */
export const initializeFileManagerSettingTable = async () => {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS file_manager_settings (
            id BIGSERIAL PRIMARY KEY,

            owner_id BIGINT NOT NULL,
            username VARCHAR(100) NOT NULL,

            access BOOLEAN DEFAULT FALSE,
            status BOOLEAN DEFAULT TRUE,

            created_at TIMESTAMP DEFAULT TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP),
            updated_at TIMESTAMP DEFAULT TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP),

            UNIQUE (owner_id)
        );

        CREATE INDEX IF NOT EXISTS idx_file_manager_settings_owner_id
            ON file_manager_settings(owner_id);

        CREATE INDEX IF NOT EXISTS idx_file_manager_settings_username
            ON file_manager_settings(LOWER(username));

        CREATE INDEX IF NOT EXISTS idx_file_manager_settings_status
            ON file_manager_settings(status);

        CREATE INDEX IF NOT EXISTS idx_file_manager_settings_access
            ON file_manager_settings(access);
    `);

    // Migrate legacy VARCHAR access -> BOOLEAN (0/1)
    await pool.query(`
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_name = 'file_manager_settings'
                  AND column_name = 'access'
                  AND data_type = 'character varying'
            ) THEN
                ALTER TABLE file_manager_settings
                    ALTER COLUMN access DROP DEFAULT;

                ALTER TABLE file_manager_settings
                    ALTER COLUMN access TYPE BOOLEAN
                    USING (
                        CASE
                            WHEN LOWER(TRIM(access::text)) IN ('1', 'true', 'yes', 'y', 'on', 'full', 'active')
                                THEN TRUE
                            WHEN LOWER(TRIM(access::text)) IN ('0', 'false', 'no', 'n', 'off', 'inactive', '')
                                THEN FALSE
                            ELSE FALSE
                        END
                    );

                ALTER TABLE file_manager_settings
                    ALTER COLUMN access SET DEFAULT FALSE;
            END IF;
        END $$;
    `);
};

function parseOwnerId(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
}

/** Boolean from 0/1, true/false, '0'/'1'. */
function toBool(value, fallback = true) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    const s = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on', 'active'].includes(s)) return true;
    if (['0', 'false', 'no', 'n', 'off', 'inactive'].includes(s)) return false;
    return fallback;
}

class FileManagerSettingModel {
    static async findAll({ status = null, search = null } = {}) {
        const params = [];
        const where = [];

        if (status !== null && status !== undefined && status !== '') {
            params.push(toBool(status, true));
            where.push(`status = $${params.length}`);
        }

        if (search) {
            params.push(`%${String(search).trim()}%`);
            where.push(
                `(username ILIKE $${params.length} OR CAST(owner_id AS TEXT) ILIKE $${params.length})`,
            );
        }

        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

        const result = await pool.query(
            `
            SELECT *
            FROM file_manager_settings
            ${whereSql}
            ORDER BY username ASC, id ASC
            `,
            params,
        );
        return result.rows;
    }

    static async findById(id) {
        const result = await pool.query(
            `SELECT * FROM file_manager_settings WHERE id = $1`,
            [id],
        );
        return result.rows[0] || null;
    }

    static async findByOwnerId(ownerId) {
        const result = await pool.query(
            `SELECT * FROM file_manager_settings WHERE owner_id = $1`,
            [ownerId],
        );
        return result.rows[0] || null;
    }

    static async findActiveOwners() {
        const result = await pool.query(
            `
            SELECT *
            FROM file_manager_settings
            WHERE status = TRUE
            ORDER BY username ASC, id ASC
            `,
        );
        return result.rows;
    }

    /**
     * Upsert selected owner into settings.
     * Unique on owner_id — re-selecting updates access/status/username.
     */
    static async upsert({ owner_id, username, access, status }) {
        const ownerId = parseOwnerId(owner_id);
        const name = String(username || '').trim();
        if (!ownerId || !name) {
            throw new Error('owner_id and username are required');
        }

        const result = await pool.query(
            `
            INSERT INTO file_manager_settings (
                owner_id,
                username,
                access,
                status
            ) VALUES ($1, $2, $3, $4)
            ON CONFLICT (owner_id)
            DO UPDATE SET
                username = EXCLUDED.username,
                access = EXCLUDED.access,
                status = EXCLUDED.status,
                updated_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
            RETURNING *
            `,
            [
                ownerId,
                name,
                toBool(access, false),
                toBool(status, true),
            ],
        );
        return result.rows[0];
    }

    /** Replace all selected owners in one transaction. */
    static async replaceAll(owners = []) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('DELETE FROM file_manager_settings');

            const rows = [];
            for (const raw of owners) {
                if (!raw || typeof raw !== 'object') continue;
                const ownerId = parseOwnerId(raw.owner_id ?? raw.ownerId);
                const name = String(
                    raw.username ?? raw.user_name ?? '',
                ).trim();
                if (!ownerId || !name) continue;

                const result = await client.query(
                    `
                    INSERT INTO file_manager_settings (
                        owner_id,
                        username,
                        access,
                        status
                    ) VALUES ($1, $2, $3, $4)
                    ON CONFLICT (owner_id)
                    DO UPDATE SET
                        username = EXCLUDED.username,
                        access = EXCLUDED.access,
                        status = EXCLUDED.status,
                        updated_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
                    RETURNING *
                    `,
                    [
                        ownerId,
                        name,
                        toBool(raw.access, false),
                        toBool(raw.status, true),
                    ],
                );
                rows.push(result.rows[0]);
            }

            await client.query('COMMIT');
            return rows;
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    static async update(id, { owner_id, username, access, status } = {}) {
        const existing = await FileManagerSettingModel.findById(id);
        if (!existing) return null;

        let nextOwnerId = existing.owner_id;
        if (owner_id !== undefined && owner_id !== null && owner_id !== '') {
            const parsed = parseOwnerId(owner_id);
            if (!parsed) {
                throw new Error('Valid owner_id is required');
            }
            nextOwnerId = parsed;
        }

        const result = await pool.query(
            `
            UPDATE file_manager_settings
            SET
                owner_id = $2,
                username = $3,
                access = $4,
                status = $5,
                updated_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
            WHERE id = $1
            RETURNING *
            `,
            [
                id,
                nextOwnerId,
                username !== undefined
                    ? String(username).trim()
                    : existing.username,
                access !== undefined
                    ? toBool(access, false)
                    : existing.access,
                status !== undefined ? toBool(status, true) : existing.status,
            ],
        );
        return result.rows[0] || null;
    }

    static async remove(id) {
        const result = await pool.query(
            `DELETE FROM file_manager_settings WHERE id = $1 RETURNING *`,
            [id],
        );
        return result.rows[0] || null;
    }

    static async removeByOwnerId(ownerId) {
        const result = await pool.query(
            `DELETE FROM file_manager_settings WHERE owner_id = $1 RETURNING *`,
            [ownerId],
        );
        return result.rows[0] || null;
    }
}

export default FileManagerSettingModel;
