import path from 'path';
import { pool } from '../../config/db.js';
import { generatePublicId } from '../../utils/fileManagerPublicId.js';

/* ================= CREATE TABLE (model only — not in database.js) ================= */
export const initializeFileManagerTable = async () => {
        await pool.query(`
        CREATE TABLE IF NOT EXISTS file_manager_items (
            id BIGSERIAL PRIMARY KEY,

            owner_id BIGINT NOT NULL,
            username VARCHAR(100) NOT NULL,

            parent_id BIGINT NULL,

            name VARCHAR(255) NOT NULL,

            item_type VARCHAR(20) NOT NULL
                CHECK (item_type IN ('folder', 'file')),

            storage_name VARCHAR(255),

            relative_path TEXT NOT NULL,

            filemanager_path TEXT,

            mime_type VARCHAR(150),

            extension VARCHAR(20),

            size BIGINT,

            created_by VARCHAR(100) NOT NULL,
            updated_by VARCHAR(100),

            created_at TIMESTAMP DEFAULT TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP),
            updated_at TIMESTAMP DEFAULT TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP),

            is_deleted BOOLEAN DEFAULT FALSE,

            is_favorite BOOLEAN NOT NULL DEFAULT FALSE,

            deleted_at TIMESTAMP NULL,
            deleted_by VARCHAR(100),

            original_path TEXT NULL,
            recycle_path TEXT NULL,

            CONSTRAINT fk_file_manager_parent
                FOREIGN KEY (parent_id)
                REFERENCES file_manager_items(id)
        );

        CREATE INDEX IF NOT EXISTS idx_file_manager_owner_id
            ON file_manager_items(owner_id);

        CREATE INDEX IF NOT EXISTS idx_file_manager_parent_id
            ON file_manager_items(parent_id);

        CREATE INDEX IF NOT EXISTS idx_file_manager_item_type
            ON file_manager_items(item_type);

        CREATE INDEX IF NOT EXISTS idx_file_manager_is_deleted
            ON file_manager_items(is_deleted);

        CREATE INDEX IF NOT EXISTS idx_file_manager_name
            ON file_manager_items(LOWER(name));
    `);

    // Existing tables skip CREATE TABLE — add/migrate columns BEFORE any query that uses them.
    await pool.query(`
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_name = 'file_manager_items'
                  AND column_name = 'created_by'
                  AND data_type = 'bigint'
            ) THEN
                ALTER TABLE file_manager_items
                    ALTER COLUMN created_by TYPE VARCHAR(100)
                    USING created_by::text;
            END IF;

            IF EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_name = 'file_manager_items'
                  AND column_name = 'updated_by'
                  AND data_type = 'bigint'
            ) THEN
                ALTER TABLE file_manager_items
                    ALTER COLUMN updated_by TYPE VARCHAR(100)
                    USING CASE
                        WHEN updated_by IS NULL THEN NULL
                        ELSE updated_by::text
                    END;
            END IF;

            IF NOT EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_name = 'file_manager_items'
                  AND column_name = 'filemanager_path'
            ) THEN
                ALTER TABLE file_manager_items
                    ADD COLUMN filemanager_path TEXT;
            END IF;

            IF NOT EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_name = 'file_manager_items'
                  AND column_name = 'deleted_by'
            ) THEN
                ALTER TABLE file_manager_items
                    ADD COLUMN deleted_by VARCHAR(100);
            END IF;

            IF NOT EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_name = 'file_manager_items'
                  AND column_name = 'original_path'
            ) THEN
                ALTER TABLE file_manager_items
                    ADD COLUMN original_path TEXT NULL;
            END IF;

            IF NOT EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_name = 'file_manager_items'
                  AND column_name = 'recycle_path'
            ) THEN
                ALTER TABLE file_manager_items
                    ADD COLUMN recycle_path TEXT NULL;
            END IF;

            IF NOT EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_name = 'file_manager_items'
                  AND column_name = 'file_source'
            ) THEN
                ALTER TABLE file_manager_items
                    ADD COLUMN file_source VARCHAR(30) DEFAULT 'local';
            END IF;

            IF NOT EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_name = 'file_manager_items'
                  AND column_name = 'google_file_id'
            ) THEN
                ALTER TABLE file_manager_items
                    ADD COLUMN google_file_id VARCHAR(255) NULL;
            END IF;

            IF NOT EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_name = 'file_manager_items'
                  AND column_name = 'google_drive_folder_id'
            ) THEN
                ALTER TABLE file_manager_items
                    ADD COLUMN google_drive_folder_id VARCHAR(255) NULL;
            END IF;

            IF NOT EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_name = 'file_manager_items'
                  AND column_name = 'url'
            ) THEN
                ALTER TABLE file_manager_items
                    ADD COLUMN url TEXT NULL;
            END IF;

            IF NOT EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_name = 'file_manager_items'
                  AND column_name = 'scope'
            ) THEN
                ALTER TABLE file_manager_items
                    ADD COLUMN scope VARCHAR(40) NOT NULL DEFAULT 'file_manager';
            END IF;

            IF NOT EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_name = 'file_manager_items'
                  AND column_name = 'is_favorite'
            ) THEN
                ALTER TABLE file_manager_items
                    ADD COLUMN is_favorite BOOLEAN NOT NULL DEFAULT FALSE;
            END IF;

            -- deletion_id removed: recycle path is Recycle Bin/{relative_path} only
            IF EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_name = 'file_manager_items'
                  AND column_name = 'deletion_id'
            ) THEN
                ALTER TABLE file_manager_items
                    DROP COLUMN deletion_id;
            END IF;
        END $$;
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_file_manager_is_favorite
            ON file_manager_items(is_favorite)
            WHERE is_favorite = TRUE AND is_deleted = FALSE;
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS file_manager_user_favorites (
            id BIGSERIAL PRIMARY KEY,
            item_id BIGINT NOT NULL
                REFERENCES file_manager_items(id) ON DELETE CASCADE,
            user_id BIGINT NOT NULL,
            username VARCHAR(100) NOT NULL,
            created_at TIMESTAMP DEFAULT TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP),
            CONSTRAINT uq_file_manager_user_favorite UNIQUE (item_id, user_id)
        );

        CREATE INDEX IF NOT EXISTS idx_fm_user_favorites_user
            ON file_manager_user_favorites(user_id, created_at DESC);
    `);

    await pool.query(`
        INSERT INTO file_manager_user_favorites (item_id, user_id, username)
        SELECT i.id, i.owner_id, i.username
        FROM file_manager_items i
        WHERE i.is_favorite = TRUE
          AND i.is_deleted = FALSE
          AND i.owner_id IS NOT NULL
          AND TRIM(COALESCE(i.username, '')) <> ''
        ON CONFLICT (item_id, user_id) DO NOTHING
    `);

    try {
        await pool.query(`
            UPDATE file_manager_items
            SET file_source = 'local'
            WHERE file_source IS NULL OR TRIM(file_source) = ''
        `);
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_file_manager_google_file_id
                ON file_manager_items(google_file_id)
                WHERE google_file_id IS NOT NULL;
        `);
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_file_manager_file_source
                ON file_manager_items(LOWER(TRIM(file_source)));
        `);
    } catch (err) {
        console.warn('⚠️ Could not create Google file-manager indexes:', err.message);
    }

    try {
        await pool.query(`DROP INDEX IF EXISTS idx_file_manager_deletion_id;`);
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_file_manager_deleted_by
                ON file_manager_items(LOWER(TRIM(deleted_by)))
                WHERE is_deleted = TRUE;
        `);
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_file_manager_recycle_path
                ON file_manager_items(recycle_path)
                WHERE recycle_path IS NOT NULL;
        `);
    } catch (err) {
        console.warn('⚠️ Could not create recycle-bin indexes:', err.message);
    }

    // Soft-delete duplicate PERSONAL own roots only (never project / FY roots).
    // Exclude system Recycle Bin root (not a user own-folder).
    await pool.query(`
        WITH RECURSIVE ranked AS (
            SELECT
                id,
                ROW_NUMBER() OVER (
                    PARTITION BY owner_id
                    ORDER BY id ASC
                ) AS rn
            FROM file_manager_items
            WHERE parent_id IS NULL
              AND item_type = 'folder'
              AND is_deleted = FALSE
              AND COALESCE(scope, 'file_manager') = 'file_manager'
              AND LOWER(TRIM(name)) <> LOWER('Recycle Bin')
              AND LOWER(REPLACE(TRIM(relative_path), '\\', '/')) <> LOWER('Recycle Bin')
        ),
        dup_roots AS (
            SELECT id FROM ranked WHERE rn > 1
        ),
        tree AS (
            SELECT id FROM file_manager_items
            WHERE id IN (SELECT id FROM dup_roots)
              AND is_deleted = FALSE
            UNION ALL
            SELECT c.id
            FROM file_manager_items c
            INNER JOIN tree t ON c.parent_id = t.id
            WHERE c.is_deleted = FALSE
              AND COALESCE(c.scope, 'file_manager') = 'file_manager'
        )
        UPDATE file_manager_items f
        SET
            is_deleted = TRUE,
            deleted_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP),
            updated_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP),
            updated_by = COALESCE(f.updated_by, 'system')
        FROM tree
        WHERE f.id = tree.id
    `);

    // Soft-delete duplicate names under same parent + username + filemanager_path (keep oldest)
    // Personal NAS scope only — project/FY trees use their own hierarchy.
    await pool.query(`
        WITH ranked AS (
            SELECT
                id,
                ROW_NUMBER() OVER (
                    PARTITION BY
                        parent_id,
                        LOWER(TRIM(username)),
                        LOWER(TRIM(name)),
                        LOWER(RTRIM(REPLACE(TRIM(COALESCE(filemanager_path, '')), '\\', '/'), '/'))
                    ORDER BY id ASC
                ) AS rn
            FROM file_manager_items
            WHERE is_deleted = FALSE
              AND parent_id IS NOT NULL
              AND COALESCE(scope, 'file_manager') = 'file_manager'
        )
        UPDATE file_manager_items f
        SET
            is_deleted = TRUE,
            deleted_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP),
            updated_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP),
            updated_by = COALESCE(f.updated_by, 'system')
        FROM ranked r
        WHERE f.id = r.id
          AND r.rn > 1
    `);

    // Revive project / FY folders wrongly soft-deleted by older personal-root cleanup
    // (no recycle_path = not a real recycle-bin delete).
    try {
        await pool.query(`
            UPDATE file_manager_items
            SET
                is_deleted = FALSE,
                deleted_at = NULL,
                deleted_by = NULL,
                updated_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP),
                updated_by = COALESCE(updated_by, 'system')
            WHERE is_deleted = TRUE
              AND recycle_path IS NULL
              AND LOWER(TRIM(COALESCE(scope, ''))) IN ('project', 'financial_year')
        `);
    } catch (err) {
        console.warn(
            '⚠️ Could not revive scoped file-manager folders:',
            err.message,
        );
    }

    try {
        // One active own-folder root per owner (system Recycle Bin root excluded)
        await pool.query(`
            DROP INDEX IF EXISTS uq_file_manager_one_root_per_owner;
        `);
        await pool.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS uq_file_manager_one_root_per_owner
                ON file_manager_items(owner_id)
                WHERE parent_id IS NULL
                  AND item_type = 'folder'
                  AND is_deleted = FALSE
                  AND COALESCE(scope, 'file_manager') = 'file_manager'
                  AND LOWER(TRIM(name)) <> LOWER('Recycle Bin');
        `);
    } catch (err) {
        console.warn(
            '⚠️ Could not create uq_file_manager_one_root_per_owner:',
            err.message,
        );
    }

    // Keep Recycle Bin as a real DB folder row (root + per-user children).
    // Revive any structural Recycle Bin rows previously soft-deleted by older init.
    try {
        await pool.query(`
            UPDATE file_manager_items
            SET
                is_deleted = FALSE,
                deleted_at = NULL,
                deleted_by = NULL,
                original_path = NULL,
                recycle_path = NULL,
                updated_by = COALESCE(updated_by, 'system'),
                updated_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
            WHERE item_type = 'folder'
              AND is_deleted = TRUE
              AND recycle_path IS NULL
              AND (
                    LOWER(TRIM(name)) = LOWER('Recycle Bin')
                 OR LOWER(REPLACE(TRIM(relative_path), '\\', '/')) = LOWER('Recycle Bin')
                 OR LOWER(REPLACE(TRIM(relative_path), '\\', '/'))
                        LIKE LOWER('Recycle Bin') || '/%'
              )
        `);
        await pool.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS uq_file_manager_global_recycle_bin
                ON file_manager_items (
                    LOWER(RTRIM(REPLACE(TRIM(COALESCE(filemanager_path, '')), '\\', '/'), '/'))
                )
                WHERE parent_id IS NULL
                  AND item_type = 'folder'
                  AND is_deleted = FALSE
                  AND LOWER(TRIM(name)) = LOWER('Recycle Bin');
        `);
    } catch (err) {
        console.warn(
            '⚠️ Could not prepare Recycle Bin DB folder indexes:',
            err.message,
        );
    }

    // Drop older uniqueness indexes that ignored username / filemanager_path
    await pool.query(`DROP INDEX IF EXISTS uq_file_manager_relative_path_active;`);
    await pool.query(`DROP INDEX IF EXISTS uq_file_manager_name_per_parent;`);

    try {
        // Duplicate only when parent + username + name + filemanager_path all match
        await pool.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS uq_file_manager_name_per_parent_user_path
                ON file_manager_items (
                    parent_id,
                    LOWER(TRIM(username)),
                    LOWER(TRIM(name)),
                    LOWER(RTRIM(REPLACE(TRIM(COALESCE(filemanager_path, '')), '\\', '/'), '/'))
                )
                WHERE is_deleted = FALSE
                  AND parent_id IS NOT NULL;
        `);
    } catch (err) {
        console.warn(
            '⚠️ Could not create uq_file_manager_name_per_parent_user_path:',
            err.message,
        );
    }

    // Keep the personal storage root separate from project/FY storage.
    const storageRoot = String(process.env.FILEMANAGER_PATH || '')
        .trim()
        .replace(/^["']|["']$/g, '')
        .replace(/\\/g, '/')
        .replace(/\/+$/, '');

    if (storageRoot) {
        await pool.query(
            `
            UPDATE file_manager_items
            SET filemanager_path = $1
            WHERE COALESCE(scope, 'file_manager') = 'file_manager'
              AND (
                    filemanager_path IS NULL
                 OR TRIM(filemanager_path) = ''
                 OR filemanager_path LIKE $1 || '/%'
              )
            `,
            [storageRoot],
        );
    }

    const projectStoragePath = String(
        process.env.PROJECT_FILE_MANAGER_PATH || '',
    )
        .trim()
        .replace(/^["']|["']$/g, '');

    if (projectStoragePath) {
        const projectStorageRoot = path
            .resolve(projectStoragePath)
            .replace(/\\/g, '/');
        await pool.query(
            `
            UPDATE file_manager_items
            SET filemanager_path = $1
            WHERE LOWER(TRIM(COALESCE(scope, ''))) IN ('project', 'financial_year')
              AND filemanager_path IS DISTINCT FROM $1
            `,
            [projectStorageRoot],
        );
    }

    console.log('✅ file_manager_items table ready');
};

const PERSONAL_SCOPE_SQL = `COALESCE(scope, 'file_manager') = 'file_manager'`;

class FileManagerModel {
    static async findById(
        id,
        { includeDeleted = false, anyScope = false } = {},
    ) {
        const numId = Number(id);
        if (!Number.isFinite(numId) || numId <= 0) return null;
        const params = [numId];
        let where = 'id = $1';
        if (!includeDeleted) {
            where += ' AND is_deleted = FALSE';
        }
        if (!anyScope) {
            where += ` AND ${PERSONAL_SCOPE_SQL}`;
        }
        const result = await pool.query(
            `SELECT * FROM file_manager_items WHERE ${where}`,
            params
        );
        return result.rows[0] || null;
    }

    /** Lookup by numeric id or public_id (direct folder links). */
    static async findByIdOrPublicId(
        idOrPublicId,
        { includeDeleted = false, anyScope = false } = {},
    ) {
        const raw = String(idOrPublicId ?? '').trim();
        if (!raw) return null;

        const byId = await this.findById(raw, { includeDeleted, anyScope });
        if (byId) return byId;

        const params = [raw];
        let where = 'public_id = $1';
        if (!includeDeleted) {
            where += ' AND is_deleted = FALSE';
        }
        if (!anyScope) {
            where += ` AND ${PERSONAL_SCOPE_SQL}`;
        }
        const result = await pool.query(
            `SELECT * FROM file_manager_items WHERE ${where} LIMIT 1`,
            params,
        );
        return result.rows[0] || null;
    }

    /** Clear soft-delete on project/FY rows that were never moved to Recycle Bin. */
    static async reviveIfWronglySoftDeleted(id) {
        const numId = Number(id);
        if (!Number.isFinite(numId) || numId <= 0) return null;
        const result = await pool.query(
            `
            UPDATE file_manager_items
            SET
                is_deleted = FALSE,
                deleted_at = NULL,
                deleted_by = NULL,
                updated_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP),
                updated_by = COALESCE(updated_by, 'system')
            WHERE id = $1
              AND is_deleted = TRUE
              AND recycle_path IS NULL
              AND LOWER(TRIM(COALESCE(scope, ''))) IN ('project', 'financial_year')
            RETURNING *
            `,
            [numId],
        );
        return result.rows[0] || null;
    }

    static async findAllRoots(filemanagerPath = null) {
        const params = [];
        let query = `
            SELECT * FROM file_manager_items
            WHERE parent_id IS NULL
              AND item_type = 'folder'
              AND is_deleted = FALSE
              AND ${PERSONAL_SCOPE_SQL}
              AND LOWER(TRIM(name)) <> LOWER('Recycle Bin')
              AND LOWER(REPLACE(TRIM(relative_path), '\\', '/')) <> LOWER('Recycle Bin')
        `;
        if (filemanagerPath) {
            const normalized = String(filemanagerPath)
                .replace(/\\/g, '/')
                .replace(/\/+$/, '')
                .toLowerCase();
            params.push(normalized);
            query += `
              AND LOWER(RTRIM(REPLACE(TRIM(COALESCE(filemanager_path, '')), '\\', '/'), '/'))
                  = $1
            `;
        }
        query += `
            ORDER BY LOWER(username) ASC, LOWER(name) ASC
        `;
        const result = await pool.query(query, params);
        return result.rows;
    }

    static async findRootByOwner(ownerId, filemanagerPath = null) {
        const params = [ownerId];
        let query = `
            SELECT * FROM file_manager_items
            WHERE owner_id = $1
              AND parent_id IS NULL
              AND item_type = 'folder'
              AND is_deleted = FALSE
              AND ${PERSONAL_SCOPE_SQL}
              AND LOWER(TRIM(name)) <> LOWER('Recycle Bin')
              AND LOWER(REPLACE(TRIM(relative_path), '\\', '/')) <> LOWER('Recycle Bin')
        `;
        if (filemanagerPath) {
            const normalized = String(filemanagerPath)
                .replace(/\\/g, '/')
                .replace(/\/+$/, '')
                .toLowerCase();
            params.push(normalized);
            query += `
              AND LOWER(RTRIM(REPLACE(TRIM(COALESCE(filemanager_path, '')), '\\', '/'), '/'))
                  = $${params.length}
            `;
        }
        query += `
            ORDER BY id ASC
            LIMIT 1
        `;
        const result = await pool.query(query, params);
        return result.rows[0] || null;
    }

    /** Match by relative_path (slash-normalized, case-insensitive on Windows). */
    static async findByRelativePath(relativePath) {
        const normalized = String(relativePath || '')
            .replace(/\\/g, '/')
            .replace(/^\/+|\/+$/g, '');
        if (!normalized) return null;

        const result = await pool.query(
            `
            SELECT * FROM file_manager_items
            WHERE is_deleted = FALSE
              AND ${PERSONAL_SCOPE_SQL}
              AND LOWER(REPLACE(relative_path, '\\', '/')) = LOWER($1)
            ORDER BY id ASC
            LIMIT 1
            `,
            [normalized]
        );
        return result.rows[0] || null;
    }

    /**
     * Find by relative_path including soft-deleted rows (for structural revive).
     */
    static async findAnyByRelativePath(relativePath, filemanagerPath = null) {
        const normalized = String(relativePath || '')
            .replace(/\\/g, '/')
            .replace(/^\/+|\/+$/g, '');
        if (!normalized) return null;

        const params = [normalized];
        let query = `
            SELECT * FROM file_manager_items
            WHERE LOWER(REPLACE(relative_path, '\\', '/')) = LOWER($1)
        `;
        if (filemanagerPath) {
            const fm = String(filemanagerPath)
                .replace(/\\/g, '/')
                .replace(/\/+$/, '')
                .toLowerCase();
            params.push(fm);
            query += `
              AND LOWER(RTRIM(REPLACE(TRIM(COALESCE(filemanager_path, '')), '\\', '/'), '/'))
                  = $${params.length}
            `;
        }
        query += `
            ORDER BY
                CASE WHEN is_deleted = FALSE THEN 0 ELSE 1 END,
                id ASC
            LIMIT 1
        `;
        const result = await pool.query(query, params);
        return result.rows[0] || null;
    }

    /** Revive a structural folder row (not a soft-deleted recycle item). */
    static async reviveStructuralFolder(id, { updatedBy = 'system' } = {}) {
        const result = await pool.query(
            `
            UPDATE file_manager_items
            SET
                is_deleted = FALSE,
                deleted_at = NULL,
                deleted_by = NULL,
                original_path = NULL,
                recycle_path = NULL,
                updated_by = $2,
                updated_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
            WHERE id = $1
              AND item_type = 'folder'
              AND recycle_path IS NULL
            RETURNING *
            `,
            [id, updatedBy],
        );
        return result.rows[0] || null;
    }

    /**
     * Ensure DB + conceptual root: Recycle Bin (parent_id NULL).
     * owner_id=0 / username=system — not a user own-folder.
     */
    static async ensureRecycleBinRoot({
        filemanagerPath,
        updatedBy = 'system',
    } = {}) {
        const fmPath = String(filemanagerPath || '').trim();
        const relativePath = 'Recycle Bin';

        let row = await this.findByRelativePath(relativePath);
        if (row) {
            if (
                fmPath &&
                String(row.filemanager_path || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() !==
                    fmPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
            ) {
                row = await this.update(row.id, {
                    filemanager_path: fmPath,
                    updated_by: updatedBy,
                });
            }
            return row;
        }

        const any = await this.findAnyByRelativePath(relativePath, fmPath || null);
        if (any && any.recycle_path == null) {
            const revived = await this.reviveStructuralFolder(any.id, {
                updatedBy,
            });
            if (revived) {
                if (fmPath) {
                    return this.update(revived.id, {
                        filemanager_path: fmPath,
                        name: 'Recycle Bin',
                        parent_id: null,
                        updated_by: updatedBy,
                    });
                }
                return revived;
            }
        }

        try {
            return await this.create({
                owner_id: 0,
                username: 'system',
                parent_id: null,
                name: 'Recycle Bin',
                item_type: 'folder',
                storage_name: null,
                relative_path: relativePath,
                filemanager_path: fmPath || null,
                created_by: updatedBy,
                updated_by: updatedBy,
            });
        } catch (err) {
            if (err?.code === '23505') {
                return (
                    (await this.findByRelativePath(relativePath)) ||
                    (await this.findChildByName({
                        parentId: null,
                        name: 'Recycle Bin',
                    }))
                );
            }
            throw err;
        }
    }

    /**
     * Ensure DB row for Recycle Bin/{username} under the Recycle Bin root.
     */
    static async ensureUserRecycleBinFolder({
        ownerId,
        username,
        filemanagerPath,
        updatedBy = null,
    } = {}) {
        const safeName = String(username || '').trim();
        if (!safeName || ownerId == null) {
            throw new Error('ownerId and username are required for user Recycle Bin folder');
        }
        const fmPath = String(filemanagerPath || '').trim();
        const by = String(updatedBy || safeName).trim() || safeName;
        const relativePath = `Recycle Bin/${safeName}`;

        const root = await this.ensureRecycleBinRoot({
            filemanagerPath: fmPath,
            updatedBy: by,
        });

        let row = await this.findByRelativePath(relativePath);
        if (row) {
            const patch = {};
            if (Number(row.parent_id) !== Number(root.id)) patch.parent_id = root.id;
            if (Number(row.owner_id) !== Number(ownerId)) patch.owner_id = ownerId;
            if (String(row.username || '') !== safeName) patch.username = safeName;
            if (
                fmPath &&
                String(row.filemanager_path || '')
                    .replace(/\\/g, '/')
                    .replace(/\/+$/, '')
                    .toLowerCase() !==
                    fmPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
            ) {
                patch.filemanager_path = fmPath;
            }
            if (Object.keys(patch).length) {
                patch.updated_by = by;
                row = await this.update(row.id, patch);
            }
            return { root, folder: row };
        }

        const any = await this.findAnyByRelativePath(relativePath, fmPath || null);
        if (any && any.recycle_path == null) {
            let revived = await this.reviveStructuralFolder(any.id, {
                updatedBy: by,
            });
            if (revived) {
                revived = await this.update(revived.id, {
                    parent_id: root.id,
                    owner_id: ownerId,
                    username: safeName,
                    name: safeName,
                    relative_path: relativePath,
                    filemanager_path: fmPath || revived.filemanager_path,
                    updated_by: by,
                });
                return { root, folder: revived };
            }
        }

        try {
            const folder = await this.create({
                owner_id: ownerId,
                username: safeName,
                parent_id: root.id,
                name: safeName,
                item_type: 'folder',
                storage_name: null,
                relative_path: relativePath,
                filemanager_path: fmPath || null,
                created_by: by,
                updated_by: by,
            });
            return { root, folder };
        } catch (err) {
            if (err?.code === '23505') {
                const existing =
                    (await this.findByRelativePath(relativePath)) ||
                    (await this.findChildByName({
                        parentId: root.id,
                        name: safeName,
                    }));
                return { root, folder: existing };
            }
            throw err;
        }
    }

    /** Active user own-folder roots (excludes Recycle Bin system root). */
    static async findAllUserRoots(filemanagerPath = null) {
        const params = [];
        let query = `
            SELECT * FROM file_manager_items
            WHERE parent_id IS NULL
              AND item_type = 'folder'
              AND is_deleted = FALSE
              AND ${PERSONAL_SCOPE_SQL}
              AND LOWER(TRIM(name)) <> LOWER('Recycle Bin')
              AND LOWER(REPLACE(TRIM(relative_path), '\\', '/')) <> LOWER('Recycle Bin')
              AND owner_id > 0
        `;
        if (filemanagerPath) {
            const normalized = String(filemanagerPath)
                .replace(/\\/g, '/')
                .replace(/\/+$/, '')
                .toLowerCase();
            params.push(normalized);
            query += `
              AND LOWER(RTRIM(REPLACE(TRIM(COALESCE(filemanager_path, '')), '\\', '/'), '/'))
                  = $1
            `;
        }
        query += ` ORDER BY LOWER(username) ASC, id ASC`;
        const result = await pool.query(query, params);
        return result.rows;
    }

    /**
     * Ensure Recycle Bin/{username} DB rows for every active user root.
     */
    static async ensureAllUserRecycleBinFolders({
        filemanagerPath,
        updatedBy = 'system',
    } = {}) {
        const roots = await this.findAllUserRoots(filemanagerPath);
        const folders = [];
        let recycleRoot = null;
        for (const userRoot of roots) {
            const { root, folder } = await this.ensureUserRecycleBinFolder({
                ownerId: Number(userRoot.owner_id),
                username: userRoot.username || userRoot.name,
                filemanagerPath,
                updatedBy,
            });
            recycleRoot = root;
            if (folder) folders.push(folder);
        }
        if (!recycleRoot) {
            recycleRoot = await this.ensureRecycleBinRoot({
                filemanagerPath,
                updatedBy,
            });
        }
        return { root: recycleRoot, folders };
    }

    /** Child under a parent (or root) by name — any owner. */
    static async findChildByName({ parentId, name }) {
        const params = [String(name || '').trim()];
        let query = `
            SELECT * FROM file_manager_items
            WHERE is_deleted = FALSE
              AND ${PERSONAL_SCOPE_SQL}
              AND LOWER(TRIM(name)) = LOWER(TRIM($1))
        `;
        if (parentId == null) {
            query += ' AND parent_id IS NULL';
        } else {
            params.push(parentId);
            query += ` AND parent_id = $${params.length}`;
        }
        query += ' ORDER BY id ASC LIMIT 1';
        const result = await pool.query(query, params);
        return result.rows[0] || null;
    }

    /**
     * Duplicate only when ALL match:
     * 1) same parent folder
     * 2) same username
     * 3) same filemanager_path
     * Different FILEMANAGER_PATH → allowed.
     */
    static async findSiblingByName({
        parentId,
        name,
        username = null,
        filemanagerPath = null,
        excludeId = null,
        anyScope = false,
    }) {
        const trimmed = String(name || '').trim();
        if (!trimmed) return null;

        const params = [trimmed];
        let query = `
            SELECT * FROM file_manager_items
            WHERE is_deleted = FALSE
              ${anyScope ? '' : `AND ${PERSONAL_SCOPE_SQL}`}
              AND LOWER(TRIM(name)) = LOWER(TRIM($1))
        `;

        if (parentId == null || parentId === '' || Number.isNaN(Number(parentId))) {
            query += ' AND parent_id IS NULL';
        } else {
            params.push(Number(parentId));
            query += ` AND parent_id = $${params.length}`;
        }

        if (username != null && String(username).trim() !== '') {
            params.push(String(username).trim());
            query += ` AND LOWER(TRIM(username)) = LOWER(TRIM($${params.length}))`;
        }

        if (filemanagerPath != null && String(filemanagerPath).trim() !== '') {
            const normalized = String(filemanagerPath)
                .replace(/\\/g, '/')
                .replace(/\/+$/, '')
                .toLowerCase();
            params.push(normalized);
            query += `
              AND LOWER(RTRIM(REPLACE(TRIM(COALESCE(filemanager_path, '')), '\\', '/'), '/'))
                  = $${params.length}
            `;
        }

        if (excludeId != null && !Number.isNaN(Number(excludeId))) {
            params.push(Number(excludeId));
            query += ` AND id != $${params.length}`;
        }

        query += ' ORDER BY id ASC LIMIT 1';
        const result = await pool.query(query, params);
        return result.rows[0] || null;
    }

    static async create(item) {
        const {
            owner_id,
            username,
            parent_id = null,
            name,
            item_type,
            storage_name = null,
            relative_path,
            filemanager_path = null,
            mime_type = null,
            extension = null,
            size = null,
            created_by,
            updated_by = null,
            file_source = 'local',
            google_file_id = null,
            google_drive_folder_id = null,
            url = null,
            absolute_path = null,
        } = item;

        let driveFolderId = google_drive_folder_id;
        if (driveFolderId == null && parent_id != null) {
            const parentResult = await pool.query(
                `
                SELECT google_drive_folder_id
                FROM file_manager_items
                WHERE id = $1
                  AND is_deleted = FALSE
                LIMIT 1
                `,
                [parent_id],
            );
            driveFolderId =
                parentResult.rows[0]?.google_drive_folder_id ?? null;
        }

        const result = await pool.query(
            `
            INSERT INTO file_manager_items (
                owner_id,
                username,
                parent_id,
                name,
                item_type,
                storage_name,
                relative_path,
                filemanager_path,
                mime_type,
                extension,
                size,
                created_by,
                updated_by,
                file_source,
                google_file_id,
                google_drive_folder_id,
                url,
                absolute_path,
                scope,
                public_id
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, 'file_manager', $19
            )
            RETURNING *
            `,
            [
                owner_id,
                username,
                parent_id,
                name.trim(),
                item_type,
                storage_name,
                relative_path,
                filemanager_path,
                mime_type,
                extension,
                size,
                created_by,
                updated_by,
                file_source || 'local',
                google_file_id,
                driveFolderId,
                url,
                absolute_path != null ? String(absolute_path).trim() || null : null,
                generatePublicId(),
            ]
        );
        const created = result.rows[0];
        // Google Drive–style: new child inherits parent share roles
        if (created?.id && parent_id != null) {
            try {
                const { default: FileManagerPermissionModel } = await import(
                    './fileManagerPermission.model.js'
                );
                await FileManagerPermissionModel.inheritFromParent(
                    created.id,
                    parent_id,
                );
            } catch (err) {
                console.warn(
                    '⚠️ Could not inherit file manager permissions:',
                    err?.message || err,
                );
            }
        }
        return created;
    }

    /** Same parent already has this name or its .url shortcut. */
    static async findChildByNameOrUrl(parentId, baseName) {
        const bare = String(baseName || '')
            .trim()
            .replace(/\.url$/i, '');
        const id = Number(parentId);
        if (!bare || !Number.isFinite(id) || id <= 0) return null;
        const names = [bare.toLowerCase(), `${bare.toLowerCase()}.url`];
        const result = await pool.query(
            `
            SELECT *
            FROM file_manager_items
            WHERE parent_id = $1
              AND is_deleted = FALSE
              AND LOWER(TRIM(name)) = ANY($2::text[])
            ORDER BY id ASC
            LIMIT 1
            `,
            [id, names],
        );
        return result.rows[0] || null;
    }

    /**
     * Point a new shortcut at the parent folder on disk and, for project/FY
     * parents, keep the row in that scope so disk sync does not insert a second file.
     */
    static async placeShortcutInParent(itemId, parent, absolutePath) {
        const id = Number(itemId);
        if (!Number.isFinite(id) || id <= 0 || !parent) return null;
        const scope = String(parent.scope || 'file_manager')
            .trim()
            .toLowerCase();
        const isProject =
            scope === 'project' ||
            parent.scope_root_id != null ||
            parent.project_id != null;
        const isFy =
            !isProject &&
            (scope === 'financial_year' || parent.financial_year_id != null);
        const childScope = isProject
            ? 'project'
            : isFy
              ? 'financial_year'
              : 'file_manager';
        const scopeRootId =
            isProject || isFy
                ? parent.scope_root_id != null
                    ? Number(parent.scope_root_id)
                    : Number(parent.id)
                : null;
        const result = await pool.query(
            `
            UPDATE file_manager_items
            SET
                absolute_path = COALESCE($2, absolute_path),
                scope = $3,
                scope_root_id = $4,
                project_id = COALESCE($5, project_id),
                project_code = COALESCE($6, project_code),
                financial_year = COALESCE($7, financial_year),
                financial_year_id = COALESCE($8, financial_year_id),
                year_code = COALESCE($9, year_code),
                updated_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
            WHERE id = $1
            RETURNING *
            `,
            [
                id,
                absolutePath != null ? String(absolutePath).trim() || null : null,
                childScope,
                scopeRootId,
                parent.project_id ?? null,
                parent.project_code ?? null,
                parent.financial_year ?? parent.year_code ?? null,
                parent.financial_year_id ?? null,
                parent.year_code ?? null,
            ],
        );
        return result.rows[0] || null;
    }

    static async update(id, fields) {
        const allowed = [
            'name',
            'parent_id',
            'owner_id',
            'username',
            'storage_name',
            'relative_path',
            'absolute_path',
            'filemanager_path',
            'mime_type',
            'extension',
            'size',
            'updated_by',
            'file_source',
            'google_file_id',
            'google_drive_folder_id',
            'url',
            'is_favorite',
        ];

        const sets = [];
        const params = [];

        for (const key of allowed) {
            if (Object.prototype.hasOwnProperty.call(fields, key)) {
                params.push(fields[key]);
                sets.push(`${key} = $${params.length}`);
            }
        }

        if (!sets.length) {
            return this.findById(id);
        }

        sets.push(
            "updated_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)",
        );
        params.push(id);

        const result = await pool.query(
            `
            UPDATE file_manager_items
            SET ${sets.join(', ')}
            WHERE id = $${params.length}
              AND is_deleted = FALSE
            RETURNING *
            `,
            params
        );
        return result.rows[0] || null;
    }

    static async setAbsolutePath(id, absolutePath) {
        const numId = Number(id);
        const abs = String(absolutePath || '').trim();
        if (!Number.isFinite(numId) || numId <= 0 || !abs) return null;
        const result = await pool.query(
            `
            UPDATE file_manager_items
            SET
                absolute_path = $2,
                updated_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
            WHERE id = $1
            RETURNING *
            `,
            [numId, abs],
        );
        return result.rows[0] || null;
    }

    /** Favorites for one user. The same file can be favorited by other users separately. */
    static async findFavorites({ userId } = {}) {
        const uid = Number(userId);
        if (!Number.isFinite(uid) || uid <= 0) return [];
        const result = await pool.query(
            `
            SELECT i.*, TRUE AS is_favorite
            FROM file_manager_items i
            INNER JOIN file_manager_user_favorites f
                ON f.item_id = i.id
               AND f.user_id = $1
            WHERE i.is_deleted = FALSE
            ORDER BY f.created_at DESC, i.id DESC
            `,
            [uid],
        );
        return result.rows;
    }

    static async userHasFavorite(itemId, userId) {
        const id = Number(itemId);
        const uid = Number(userId);
        if (!Number.isFinite(id) || id <= 0) return false;
        if (!Number.isFinite(uid) || uid <= 0) return false;
        const result = await pool.query(
            `
            SELECT 1
            FROM file_manager_user_favorites
            WHERE item_id = $1 AND user_id = $2
            LIMIT 1
            `,
            [id, uid],
        );
        return result.rowCount > 0;
    }

    static async setFavorite(id, userId, isFavorite, username = null) {
        const numId = Number(id);
        const uid = Number(userId);
        if (!Number.isFinite(numId) || numId <= 0) return null;
        if (!Number.isFinite(uid) || uid <= 0) return null;
        const by =
            username != null && String(username).trim()
                ? String(username).trim()
                : null;
        if (!by) return null;

        if (isFavorite) {
            await pool.query(
                `
                INSERT INTO file_manager_user_favorites (item_id, user_id, username)
                VALUES ($1, $2, $3)
                ON CONFLICT (item_id, user_id) DO UPDATE
                    SET username = EXCLUDED.username
                `,
                [numId, uid, by],
            );
        } else {
            await pool.query(
                `
                DELETE FROM file_manager_user_favorites
                WHERE item_id = $1 AND user_id = $2
                `,
                [numId, uid],
            );
        }

        const result = await pool.query(
            `
            SELECT *
            FROM file_manager_items
            WHERE id = $1
              AND is_deleted = FALSE
            `,
            [numId],
        );
        const row = result.rows[0];
        if (!row) return null;
        return { ...row, is_favorite: Boolean(isFavorite) };
    }

    /**
     * Soft-delete one item (internal / stale cleanup — no recycle move metadata).
     * @param {number} id
     * @param {string|null} deletedBy - username from auth / x-username header
     */
    static async softDelete(id, deletedBy = null) {
        const by = deletedBy != null && String(deletedBy).trim()
            ? String(deletedBy).trim()
            : null;
        const result = await pool.query(
            `
            UPDATE file_manager_items
            SET
                is_deleted = TRUE,
                deleted_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP),
                deleted_by = COALESCE($2, deleted_by),
                updated_by = COALESCE($2, updated_by),
                updated_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
            WHERE id = $1
              AND is_deleted = FALSE
            RETURNING *
            `,
            [id, by]
        );
        return result.rows[0] || null;
    }

    /**
     * Soft-delete an item and all non-deleted descendants (folders + files).
     * Internal / stale cleanup — no recycle move metadata.
     * @param {number} id
     * @param {string|null} deletedBy - username from auth / x-username header
     */
    static async softDeleteTree(id, deletedBy = null) {
        const by = deletedBy != null && String(deletedBy).trim()
            ? String(deletedBy).trim()
            : null;
        const result = await pool.query(
            `
            WITH RECURSIVE tree AS (
                SELECT id FROM file_manager_items
                WHERE id = $1 AND is_deleted = FALSE
                UNION ALL
                SELECT c.id
                FROM file_manager_items c
                INNER JOIN tree t ON c.parent_id = t.id
                WHERE c.is_deleted = FALSE
            )
            UPDATE file_manager_items f
            SET
                is_deleted = TRUE,
                deleted_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP),
                deleted_by = COALESCE($2, f.deleted_by),
                updated_by = COALESCE($2, f.updated_by),
                updated_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
            FROM tree
            WHERE f.id = tree.id
            RETURNING f.*
            `,
            [id, by]
        );
        return result.rows;
    }

    /**
     * Move an item (and descendants) into Recycle Bin metadata after a disk move.
     * original_path = pre-delete relative_path
     * recycle_path / relative_path = Recycle Bin/{original relative_path}
     * Root item parent_id → user's Recycle Bin/{username} folder (recycleParentId).
     * owner_id is preserved; deleted_by is who deleted it.
     */
    static async markMovedToRecycleBin(id, {
        deletedBy,
        oldRelativePrefix,
        newRelativePrefix,
        recycleParentId = null,
        filemanagerPath = null,
    }) {
        const by = String(deletedBy || '').trim();
        const oldPrefix = String(oldRelativePrefix || '').replace(/\\/g, '/').replace(/\/+$/, '');
        const newPrefix = String(newRelativePrefix || '').replace(/\\/g, '/').replace(/\/+$/, '');

        if (!by || !oldPrefix || !newPrefix) {
            throw new Error('Recycle Bin move requires deletedBy and path prefixes');
        }

        const params = [id, by, oldPrefix, newPrefix];
        let parentSql = 'f.parent_id';
        if (recycleParentId != null && Number(recycleParentId) > 0) {
            params.push(Number(recycleParentId));
            parentSql = `CASE WHEN f.id = $1 THEN $${params.length} ELSE f.parent_id END`;
        }

        let fmPathSql = 'f.filemanager_path';
        const fmPath = String(filemanagerPath || '').trim();
        if (fmPath) {
            params.push(fmPath);
            fmPathSql = `$${params.length}`;
        }

        const result = await pool.query(
            `
            WITH RECURSIVE tree AS (
                SELECT id FROM file_manager_items
                WHERE id = $1 AND is_deleted = FALSE
                UNION ALL
                SELECT c.id
                FROM file_manager_items c
                INNER JOIN tree t ON c.parent_id = t.id
                WHERE c.is_deleted = FALSE
            )
            UPDATE file_manager_items f
            SET
                original_path = REPLACE(f.relative_path, '\\', '/'),
                relative_path = $4 || SUBSTRING(REPLACE(f.relative_path, '\\', '/') FROM LENGTH($3) + 1),
                recycle_path = $4 || SUBSTRING(REPLACE(f.relative_path, '\\', '/') FROM LENGTH($3) + 1),
                parent_id = ${parentSql},
                filemanager_path = ${fmPathSql},
                is_deleted = TRUE,
                deleted_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP),
                deleted_by = $2,
                updated_by = $2,
                updated_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
            FROM tree
            WHERE f.id = tree.id
            RETURNING f.*
            `,
            params,
        );
        return result.rows;
    }

    /** Deleted row already using this recycle_path (case-insensitive). */
    static async findDeletedByRecyclePath(recyclePath) {
        const normalized = String(recyclePath || '')
            .replace(/\\/g, '/')
            .replace(/^\/+|\/+$/g, '');
        if (!normalized) return null;
        const result = await pool.query(
            `
            SELECT * FROM file_manager_items
            WHERE is_deleted = TRUE
              AND LOWER(REPLACE(recycle_path, '\\', '/')) = LOWER($1)
            LIMIT 1
            `,
            [normalized]
        );
        return result.rows[0] || null;
    }

    /** Rename a soft-deleted root (e.g. "file(1).png" Recycle Bin increment). */
    static async updateDeletedRootDisplayName(id, name) {
        const displayName = String(name || '').trim();
        if (!displayName) return null;
        const result = await pool.query(
            `
            UPDATE file_manager_items
            SET
                name = $2,
                storage_name = CASE
                    WHEN item_type = 'file' THEN $2
                    ELSE storage_name
                END,
                updated_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
            WHERE id = $1
              AND is_deleted = TRUE
            RETURNING *
            `,
            [id, displayName]
        );
        return result.rows[0] || null;
    }

    /**
     * Admin Recycle Bin root: all user Recycle Bin folders
     * (structural rows Recycle Bin/{username}), with deleted item counts.
     */
    static async findRecycleBinUserFolders({ filemanagerPath = null } = {}) {
        const params = [];
        let query = `
            SELECT
                uf.id,
                uf.name,
                uf.username,
                uf.owner_id,
                uf.relative_path,
                uf.parent_id,
                uf.filemanager_path,
                uf.item_type,
                uf.created_at,
                uf.updated_at,
                COALESCE(stats.deleted_count, 0)::int AS deleted_count,
                stats.latest_deleted_at
            FROM file_manager_items uf
            INNER JOIN file_manager_items rb
                ON rb.id = uf.parent_id
               AND rb.is_deleted = FALSE
               AND rb.item_type = 'folder'
               AND LOWER(TRIM(rb.name)) = LOWER('Recycle Bin')
               AND rb.recycle_path IS NULL
            LEFT JOIN LATERAL (
                SELECT
                    COUNT(*)::int AS deleted_count,
                    MAX(d.deleted_at) AS latest_deleted_at
                FROM file_manager_items d
                LEFT JOIN file_manager_items dp ON d.parent_id = dp.id
                WHERE d.is_deleted = TRUE
                  AND d.recycle_path IS NOT NULL
                  AND (
                        -- Prefer deleter's bin (self), not settings/item owner
                        LOWER(TRIM(COALESCE(d.deleted_by, '')))
                            = LOWER(TRIM(uf.username))
                     OR d.parent_id = uf.id
                     OR LOWER(REPLACE(TRIM(COALESCE(d.recycle_path, '')), '\\', '/'))
                            LIKE LOWER('Recycle Bin/' || TRIM(uf.username) || '/%')
                  )
                  AND (
                        d.parent_id = uf.id
                     OR d.parent_id IS NULL
                     OR dp.id IS NULL
                     OR dp.is_deleted = FALSE
                     OR dp.recycle_path IS NULL
                  )
            ) stats ON TRUE
            WHERE uf.is_deleted = FALSE
              AND uf.item_type = 'folder'
              AND uf.recycle_path IS NULL
              AND LOWER(REPLACE(TRIM(uf.relative_path), '\\', '/'))
                    LIKE LOWER('Recycle Bin') || '/%'
              AND LOWER(REPLACE(TRIM(uf.relative_path), '\\', '/'))
                    NOT LIKE LOWER('Recycle Bin') || '/%/%'
        `;

        if (filemanagerPath) {
            const normalized = String(filemanagerPath)
                .replace(/\\/g, '/')
                .replace(/\/+$/, '')
                .toLowerCase();
            params.push(normalized);
            query += `
              AND LOWER(RTRIM(REPLACE(TRIM(COALESCE(uf.filemanager_path, '')), '\\', '/'), '/'))
                  = $${params.length}
            `;
        }

        query += `
            ORDER BY LOWER(uf.username) ASC, uf.id ASC
        `;

        const result = await pool.query(query, params);
        return result.rows.map((row) => ({
            id: row.id != null ? Number(row.id) : null,
            item_type: row.item_type || 'folder',
            name: row.name || row.username,
            username: row.username,
            owner_id: row.owner_id != null ? Number(row.owner_id) : null,
            parent_id: row.parent_id != null ? Number(row.parent_id) : null,
            relative_path: row.relative_path,
            filemanager_path: row.filemanager_path,
            deleted_count: Number(row.deleted_count) || 0,
            deleted_at: row.latest_deleted_at,
            latest_deleted_at: row.latest_deleted_at,
            created_at: row.created_at,
            updated_at: row.updated_at,
            is_deleted: false,
            thumbnail_available: false,
            thumbnail_url: null,
        }));
    }

    /**
     * Top-level Recycle Bin entries.
     * Optional filters: deletedBy, username (bin folder / who deleted).
     * Descendants of a deleted folder are hidden (shown via the deleted root only).
     *
     * Note: do NOT require filemanager_path match — project/FY deletes often had
     * null filemanager_path and were invisible in Recycle Bin.
     */
    static async findRecycleBinItems({
        deletedBy = null,
        username = null,
        filemanagerPath = null,
    } = {}) {
        const params = [];
        let query = `
            SELECT f.*
            FROM file_manager_items f
            LEFT JOIN file_manager_items p ON f.parent_id = p.id
            WHERE f.is_deleted = TRUE
              AND f.recycle_path IS NOT NULL
              AND (
                    f.parent_id IS NULL
                 OR p.id IS NULL
                 OR p.is_deleted = FALSE
                 OR p.recycle_path IS NULL
              )
        `;

        if (deletedBy != null && String(deletedBy).trim() !== '') {
            params.push(String(deletedBy).trim());
            query += `
              AND LOWER(TRIM(f.deleted_by)) = LOWER(TRIM($${params.length}))
            `;
        }

        // Admin opens Recycle Bin/{username}: match that user's bin folder /
        // deleted_by, not the item's settings owner (project files stay owned by ADMIN).
        if (username != null && String(username).trim() !== '') {
            const uname = String(username).trim();
            params.push(uname);
            const uIdx = params.length;
            params.push(`Recycle Bin/${uname}`);
            const prefixExact = params.length;
            params.push(`Recycle Bin/${uname}/%`);
            const prefixLike = params.length;
            query += `
              AND (
                    LOWER(TRIM(f.deleted_by)) = LOWER(TRIM($${uIdx}))
                 OR LOWER(REPLACE(TRIM(COALESCE(f.recycle_path, '')), '\\', '/'))
                        = LOWER($${prefixExact})
                 OR LOWER(REPLACE(TRIM(COALESCE(f.recycle_path, '')), '\\', '/'))
                        LIKE LOWER($${prefixLike})
              )
            `;
        }

        // Soft filter: include matching path OR missing path (legacy project deletes)
        if (filemanagerPath) {
            const normalized = String(filemanagerPath)
                .replace(/\\/g, '/')
                .replace(/\/+$/, '')
                .toLowerCase();
            params.push(normalized);
            query += `
              AND (
                    f.filemanager_path IS NULL
                 OR TRIM(f.filemanager_path) = ''
                 OR LOWER(RTRIM(REPLACE(TRIM(f.filemanager_path), '\\', '/'), '/'))
                        = $${params.length}
              )
            `;
        }

        query += `
            ORDER BY f.deleted_at DESC NULLS LAST, LOWER(f.name) ASC
        `;

        const result = await pool.query(query, params);
        return result.rows;
    }

    /**
     * Register a file or folder that exists on disk under Recycle Bin/{user}
     * (for example after Windows Recycle Bin restore) so the web bin lists it.
     */
    static async insertRecoveredRecycleItem({
        ownerId,
        username,
        parentId,
        name,
        itemType,
        relativePath,
        recyclePath,
        originalPath,
        absolutePath = null,
        filemanagerPath = null,
        deletedBy,
        extension = null,
        mimeType = null,
        size = null,
        fileSource = 'local',
        url = null,
        storageName = null,
    }) {
        const result = await pool.query(
            `
            INSERT INTO file_manager_items (
                owner_id,
                username,
                parent_id,
                name,
                item_type,
                storage_name,
                relative_path,
                filemanager_path,
                mime_type,
                extension,
                size,
                created_by,
                updated_by,
                file_source,
                url,
                absolute_path,
                scope,
                public_id,
                is_deleted,
                deleted_at,
                deleted_by,
                original_path,
                recycle_path
            ) VALUES (
                $1, $2, $3, $4, $5,
                $6, $7, $8, $9, $10, $11,
                $12, $12, $13, $14, $15,
                'file_manager', $16,
                TRUE,
                TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP),
                $17, $18, $19
            )
            RETURNING *
            `,
            [
                ownerId,
                username,
                parentId,
                name,
                itemType,
                storageName,
                relativePath,
                filemanagerPath,
                mimeType,
                extension,
                size,
                deletedBy,
                fileSource,
                url,
                absolutePath,
                generatePublicId(),
                deletedBy,
                originalPath,
                recyclePath,
            ],
        );
        return result.rows[0] || null;
    }

    /** Deleted item visible to the user who deleted it. */
    static async findDeletedByIdForUser(id, deletedBy) {
        const by = String(deletedBy || '').trim();
        if (!by) return null;
        const result = await pool.query(
            `
            SELECT * FROM file_manager_items
            WHERE id = $1
              AND is_deleted = TRUE
              AND recycle_path IS NOT NULL
              AND LOWER(TRIM(deleted_by)) = LOWER(TRIM($2))
            LIMIT 1
            `,
            [id, by]
        );
        return result.rows[0] || null;
    }

    /**
     * Restore a deleted item (+ deleted descendants).
     * Caller must move the physical root from recycle_path → original_path first.
     */
    static async restoreFromRecycleBin(id, deletedBy) {
        const by = String(deletedBy || '').trim();
        const result = await pool.query(
            `
            WITH RECURSIVE tree AS (
                SELECT id
                FROM file_manager_items
                WHERE id = $1
                  AND is_deleted = TRUE
                  AND recycle_path IS NOT NULL
                  AND LOWER(TRIM(deleted_by)) = LOWER(TRIM($2))
                UNION ALL
                SELECT c.id
                FROM file_manager_items c
                INNER JOIN tree t ON c.parent_id = t.id
                WHERE c.is_deleted = TRUE
                  AND c.recycle_path IS NOT NULL
            )
            UPDATE file_manager_items f
            SET
                relative_path = COALESCE(f.original_path, f.relative_path),
                is_deleted = FALSE,
                deleted_at = NULL,
                deleted_by = NULL,
                original_path = NULL,
                recycle_path = NULL,
                updated_by = $2,
                updated_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
            FROM tree
            WHERE f.id = tree.id
            RETURNING f.*
            `,
            [id, by]
        );
        return result.rows;
    }

    /**
     * Permanently remove a deleted item (+ deleted descendants).
     */
    static async permanentDeleteFromRecycleBin(id, deletedBy) {
        const by = String(deletedBy || '').trim();
        const result = await pool.query(
            `
            WITH RECURSIVE tree AS (
                SELECT id
                FROM file_manager_items
                WHERE id = $1
                  AND is_deleted = TRUE
                  AND recycle_path IS NOT NULL
                  AND LOWER(TRIM(deleted_by)) = LOWER(TRIM($2))
                UNION ALL
                SELECT c.id
                FROM file_manager_items c
                INNER JOIN tree t ON c.parent_id = t.id
                WHERE c.is_deleted = TRUE
                  AND c.recycle_path IS NOT NULL
            ),
            deleted AS (
                DELETE FROM file_manager_items f
                USING tree
                WHERE f.id = tree.id
                RETURNING f.*
            )
            SELECT * FROM deleted
            `,
            [id, by]
        );
        return result.rows;
    }

    /**
     * Permanently remove an item (+ all descendants, active or deleted).
     * Used by DELETE /items/:id/permanent (file or folder by id).
     * Permissions cascade via FK ON DELETE CASCADE.
     */
    static async permanentDeleteTree(id) {
        const result = await pool.query(
            `
            WITH RECURSIVE tree AS (
                SELECT id
                FROM file_manager_items
                WHERE id = $1
                UNION ALL
                SELECT c.id
                FROM file_manager_items c
                INNER JOIN tree t ON c.parent_id = t.id
            ),
            deleted AS (
                DELETE FROM file_manager_items f
                USING tree
                WHERE f.id = tree.id
                RETURNING f.*
            )
            SELECT * FROM deleted
            `,
            [id]
        );
        return result.rows;
    }

    /**
     * Permanently remove all descendants of an item (not the item itself).
     * Used by folder replace: old contents deleted, folder row kept.
     */
    static async permanentDeleteDescendants(id) {
        const result = await pool.query(
            `
            WITH RECURSIVE tree AS (
                SELECT id
                FROM file_manager_items
                WHERE parent_id = $1
                UNION ALL
                SELECT c.id
                FROM file_manager_items c
                INNER JOIN tree t ON c.parent_id = t.id
            ),
            deleted AS (
                DELETE FROM file_manager_items f
                USING tree
                WHERE f.id = tree.id
                RETURNING f.*
            )
            SELECT * FROM deleted
            `,
            [id]
        );
        return result.rows;
    }

    /**
     * Rewrite relative_path (+ absolute_path) for a restored root and all
     * its active descendants when the root leaf changes (e.g. bin keeps
     * "success(2).png" instead of reverting to "success.png").
     */
    static async rewriteTreePathPrefixes({
        id,
        oldRelative,
        newRelative,
        oldAbsolute = null,
        newAbsolute = null,
    } = {}) {
        const oldRel = String(oldRelative || '').replace(/\\/g, '/').replace(/\/+$/, '');
        const newRel = String(newRelative || '').replace(/\\/g, '/').replace(/\/+$/, '');
        if (!oldRel || !newRel || oldRel === newRel) return [];
        const params = [id, oldRel, newRel];
        let absSql = '';
        if (oldAbsolute && newAbsolute) {
            params.push(
                String(oldAbsolute).replace(/\\/g, '/'),
                String(newAbsolute).replace(/\\/g, '/'),
            );
            absSql = `,
                absolute_path = CASE
                    WHEN absolute_path IS NULL OR TRIM(absolute_path) = '' THEN absolute_path
                    WHEN REPLACE(absolute_path, '\\', '/') = $4
                      OR REPLACE(absolute_path, '\\', '/') LIKE $4 || '/%'
                    THEN $5 || SUBSTRING(REPLACE(absolute_path, '\\', '/') FROM LENGTH($4) + 1)
                    ELSE absolute_path
                END`;
        }
        const result = await pool.query(
            `
            WITH RECURSIVE tree AS (
                SELECT id FROM file_manager_items
                WHERE id = $1 AND is_deleted = FALSE
                UNION ALL
                SELECT c.id
                FROM file_manager_items c
                INNER JOIN tree t ON c.parent_id = t.id
                WHERE c.is_deleted = FALSE
            )
            UPDATE file_manager_items f
            SET
                relative_path = $3 || SUBSTRING(REPLACE(f.relative_path, '\\', '/') FROM LENGTH($2) + 1)
                ${absSql},
                updated_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
            FROM tree
            WHERE f.id = tree.id
            RETURNING f.*
            `,
            params,
        );
        return result.rows;
    }

    /** Active sibling check also used on restore to detect conflicts at original_path. */
    static async findActiveByRelativePath(relativePath, filemanagerPath = null) {
        const normalized = String(relativePath || '')
            .replace(/\\/g, '/')
            .replace(/^\/+|\/+$/g, '');
        if (!normalized) return null;

        const params = [normalized];
        let query = `
            SELECT * FROM file_manager_items
            WHERE is_deleted = FALSE
              AND LOWER(REPLACE(relative_path, '\\', '/')) = LOWER($1)
        `;
        if (filemanagerPath) {
            const fm = String(filemanagerPath)
                .replace(/\\/g, '/')
                .replace(/\/+$/, '')
                .toLowerCase();
            params.push(fm);
            query += `
              AND LOWER(RTRIM(REPLACE(TRIM(COALESCE(filemanager_path, '')), '\\', '/'), '/'))
                  = $${params.length}
            `;
        }
        query += ' ORDER BY id ASC LIMIT 1';
        const result = await pool.query(query, params);
        return result.rows[0] || null;
    }

    static async findChildren(
        parentId,
        ownerId = null,
        filemanagerPath = null,
        { includeDeleted = false, anyScope = false } = {},
    ) {
        const params = [parentId];
        let query = `
            SELECT * FROM file_manager_items
            WHERE parent_id = $1
        `;
        // Recycle Bin lists project/FY deletes (scope stays project) — never
        // force personal-only when includeDeleted is on.
        if (!anyScope && !includeDeleted) {
            query += ` AND ${PERSONAL_SCOPE_SQL}`;
        }
        if (includeDeleted) {
            // Recycle Bin browsing: active structural folders OR soft-deleted recycle items
            query += `
              AND (
                    is_deleted = FALSE
                 OR (is_deleted = TRUE AND recycle_path IS NOT NULL)
              )
            `;
        } else {
            query += ` AND is_deleted = FALSE`;
        }
        // Soft-deleted recycle items keep original owner_id (settings owner);
        // do not filter by owner when browsing Recycle Bin.
        if (ownerId != null && !includeDeleted) {
            params.push(ownerId);
            query += ` AND owner_id = $${params.length}`;
        }
        if (filemanagerPath && !anyScope && !includeDeleted) {
            const normalized = String(filemanagerPath)
                .replace(/\\/g, '/')
                .replace(/\/+$/, '')
                .toLowerCase();
            params.push(normalized);
            query += `
              AND LOWER(RTRIM(REPLACE(TRIM(COALESCE(filemanager_path, '')), '\\', '/'), '/'))
                  = $${params.length}
            `;
        }
        query += `
            ORDER BY
                CASE WHEN item_type = 'folder' THEN 0 ELSE 1 END,
                LOWER(name) ASC,
                display_order ASC NULLS LAST,
                id ASC
        `;
        const result = await pool.query(query, params);
        return result.rows;
    }

    static async findItems({
        ownerId = null,
        parentId = undefined,
        itemType = null,
        filemanagerPath = null,
    } = {}) {
        const params = [];
        let query = `
            SELECT * FROM file_manager_items
            WHERE is_deleted = FALSE
              AND ${PERSONAL_SCOPE_SQL}
        `;

        if (ownerId != null) {
            params.push(ownerId);
            query += ` AND owner_id = $${params.length}`;
        }

        if (parentId === null) {
            // Recycle Bin is a system root — only via GET /recycle-bin, never in parent_id=null lists
            query += `
              AND parent_id IS NULL
              AND LOWER(TRIM(name)) <> LOWER('Recycle Bin')
              AND LOWER(REPLACE(TRIM(relative_path), '\\', '/')) <> LOWER('Recycle Bin')
            `;
        } else if (parentId !== undefined) {
            params.push(parentId);
            query += ` AND parent_id = $${params.length}`;
        }

        if (itemType) {
            params.push(itemType);
            query += ` AND item_type = $${params.length}`;
        }

        if (filemanagerPath) {
            const normalized = String(filemanagerPath)
                .replace(/\\/g, '/')
                .replace(/\/+$/, '')
                .toLowerCase();
            params.push(normalized);
            // Strict: only the active FILEMANAGER_PATH (never old /uploads rows)
            query += `
              AND LOWER(RTRIM(REPLACE(TRIM(COALESCE(filemanager_path, '')), '\\', '/'), '/'))
                  = $${params.length}
            `;
        }

        query += `
            ORDER BY
                CASE WHEN item_type = 'folder' THEN 0 ELSE 1 END,
                LOWER(name) ASC
        `;

        const result = await pool.query(query, params);
        return result.rows;
    }

    static async search({
        ownerId = null,
        q = '',
        username = null,
        itemType = null,
        limit = 100,
        filemanagerPath = null,
    }) {
        const params = [];
        let query = `
            SELECT * FROM file_manager_items
            WHERE is_deleted = FALSE
              AND LOWER(TRIM(name)) <> LOWER('Recycle Bin')
              AND LOWER(REPLACE(TRIM(relative_path), '\\', '/')) <> LOWER('Recycle Bin')
              AND LOWER(REPLACE(TRIM(relative_path), '\\', '/'))
                    NOT LIKE LOWER('Recycle Bin') || '/%'
        `;

        const name = String(q || '').trim();
        if (name) {
            params.push(`%${name}%`);
            query += `
              AND (
                    LOWER(name) LIKE LOWER($${params.length})
                 OR LOWER(COALESCE(storage_name, '')) LIKE LOWER($${params.length})
                 OR LOWER(relative_path) LIKE LOWER($${params.length})
                 OR LOWER(COALESCE(extension, '')) LIKE LOWER($${params.length})
              )
            `;
        }

        const user = String(username || '').trim();
        if (user) {
            params.push(user);
            query += ` AND LOWER(TRIM(username)) = LOWER($${params.length})`;
        }

        if (ownerId != null) {
            params.push(ownerId);
            query += ` AND owner_id = $${params.length}`;
        }

        if (itemType) {
            params.push(itemType);
            query += ` AND item_type = $${params.length}`;
        }

        if (filemanagerPath) {
            const normalized = String(filemanagerPath)
                .replace(/\\/g, '/')
                .replace(/\/+$/, '')
                .toLowerCase();
            params.push(normalized);
            query += `
              AND (
                    COALESCE(scope, 'file_manager') <> 'file_manager'
                 OR LOWER(RTRIM(REPLACE(TRIM(COALESCE(filemanager_path, '')), '\\', '/'), '/'))
                    = $${params.length}
              )
            `;
        }

        params.push(Math.min(Math.max(Number(limit) || 100, 1), 500));
        query += `
            ORDER BY
                CASE WHEN item_type = 'folder' THEN 0 ELSE 1 END,
                LOWER(name) ASC
            LIMIT $${params.length}
        `;

        const result = await pool.query(query, params);
        return result.rows;
    }

    /** Descendants whose relative_path must be rewritten after move/rename. */
    static async findDescendants(id) {
        const result = await pool.query(
            `
            WITH RECURSIVE tree AS (
                SELECT * FROM file_manager_items
                WHERE parent_id = $1 AND is_deleted = FALSE
                UNION ALL
                SELECT c.*
                FROM file_manager_items c
                INNER JOIN tree t ON c.parent_id = t.id
                WHERE c.is_deleted = FALSE
            )
            SELECT * FROM tree
            ORDER BY relative_path ASC
            `,
            [id]
        );
        return result.rows;
    }

    static async updateRelativePathPrefix(oldPrefix, newPrefix, ownerId) {
        const result = await pool.query(
            `
            UPDATE file_manager_items
            SET
                relative_path = $2 || SUBSTRING(relative_path FROM LENGTH($1) + 1),
                updated_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
            WHERE owner_id = $3
              AND is_deleted = FALSE
              AND (
                    relative_path = $1
                 OR relative_path LIKE $1 || '/%'
              )
            RETURNING *
            `,
            [oldPrefix, newPrefix, ownerId]
        );
        return result.rows;
    }

    /** Rewrite relative_path (+ optional absolute_path) under a renamed/moved folder. */
    static async updatePathPrefixes({
        oldRelative,
        newRelative,
        oldAbsolute = null,
        newAbsolute = null,
        rootId = null,
        ownerId = null,
    } = {}) {
        const oldRel = String(oldRelative || '')
            .replace(/\\/g, '/')
            .replace(/\/+$/, '');
        const newRel = String(newRelative || '')
            .replace(/\\/g, '/')
            .replace(/\/+$/, '');
        if (!oldRel || !newRel) return [];

        const params = [oldRel, newRel];
        let where = `
            is_deleted = FALSE
            AND (
                  REPLACE(relative_path, '\\', '/') = $1
               OR REPLACE(relative_path, '\\', '/') LIKE $1 || '/%'
            )
        `;
        if (rootId != null && Number.isFinite(Number(rootId))) {
            params.push(Number(rootId));
            where += ` AND (id = $${params.length} OR scope_root_id = $${params.length})`;
        } else if (ownerId != null && Number.isFinite(Number(ownerId))) {
            params.push(Number(ownerId));
            where += ` AND owner_id = $${params.length}`;
        }

        const oldAbs = oldAbsolute
            ? String(oldAbsolute).replace(/[/\\]+$/, '')
            : null;
        const newAbs = newAbsolute
            ? String(newAbsolute).replace(/[/\\]+$/, '')
            : null;

        let absSql = '';
        if (oldAbs && newAbs) {
            params.push(oldAbs.replace(/\\/g, '/'), newAbs.replace(/\\/g, '/'));
            const oldAbsIdx = params.length - 1;
            const newAbsIdx = params.length;
            absSql = `,
                absolute_path = CASE
                    WHEN absolute_path IS NULL OR TRIM(absolute_path) = '' THEN absolute_path
                    WHEN REPLACE(absolute_path, '\\', '/') = $${oldAbsIdx}
                      OR REPLACE(absolute_path, '\\', '/') LIKE $${oldAbsIdx} || '/%'
                    THEN $${newAbsIdx} || SUBSTRING(
                        REPLACE(absolute_path, '\\', '/')
                        FROM LENGTH($${oldAbsIdx}) + 1
                    )
                    ELSE absolute_path
                END`;
        }

        const result = await pool.query(
            `
            UPDATE file_manager_items
            SET
                relative_path = $2 || SUBSTRING(
                    REPLACE(relative_path, '\\', '/')
                    FROM LENGTH($1) + 1
                )
                ${absSql},
                updated_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
            WHERE ${where}
            RETURNING *
            `,
            params,
        );
        return result.rows;
    }

    static async isDescendantOf(itemId, possibleAncestorId) {
        if (itemId == null || possibleAncestorId == null) return false;
        if (Number(itemId) === Number(possibleAncestorId)) return true;

        const result = await pool.query(
            `
            WITH RECURSIVE ancestors AS (
                SELECT id, parent_id FROM file_manager_items
                WHERE id = $1 AND is_deleted = FALSE
                UNION ALL
                SELECT p.id, p.parent_id
                FROM file_manager_items p
                INNER JOIN ancestors a ON p.id = a.parent_id
                WHERE p.is_deleted = FALSE
            )
            SELECT 1 FROM ancestors WHERE id = $2 LIMIT 1
            `,
            [itemId, possibleAncestorId]
        );
        return result.rows.length > 0;
    }

    /**
     * List Google Sheets for a user (created/owned) — active only.
     * Admin/all: pass ownerId=null and username=null with allowAll=true.
     */
    static async listGoogleSheets({
        ownerId = null,
        username = null,
        search = null,
        limit = 100,
        allowAll = false,
    } = {}) {
        const params = [];
        const where = [
            `is_deleted = FALSE`,
            `(
                LOWER(TRIM(COALESCE(file_source, ''))) IN ('google_sheet', 'google_sheets')
                OR LOWER(TRIM(COALESCE(extension, ''))) = 'gsheet'
                OR (
                    url IS NOT NULL
                    AND TRIM(url) <> ''
                    AND url ILIKE '%/spreadsheets/d/%'
                )
            )`,
        ];

        if (!allowAll) {
            const oid = ownerId != null ? Number(ownerId) : null;
            const uname = String(username || '').trim();
            if (oid && Number.isFinite(oid) && oid > 0) {
                params.push(oid);
                where.push(`owner_id = $${params.length}`);
            } else if (uname) {
                params.push(uname.toLowerCase());
                where.push(`LOWER(TRIM(username)) = $${params.length}`);
            } else {
                return [];
            }
        }

        const q = String(search || '').trim();
        if (q) {
            params.push(`%${q}%`);
            where.push(
                `(name ILIKE $${params.length} OR COALESCE(url, '') ILIKE $${params.length})`,
            );
        }

        const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
        params.push(lim);

        const result = await pool.query(
            `
            SELECT *
            FROM file_manager_items
            WHERE ${where.join(' AND ')}
            ORDER BY updated_at DESC NULLS LAST, id DESC
            LIMIT $${params.length}
            `,
            params,
        );
        return result.rows;
    }
}

export default FileManagerModel;
