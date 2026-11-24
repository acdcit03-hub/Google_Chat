import { pool } from '../../config/db.js';
import { FILE_MANAGER_SCOPES } from './fileManagerScopes.js';
import { initializeFileManagerPermissionsTable } from './fileManagerPermission.model.js';
import { generatePublicId } from '../../utils/fileManagerPublicId.js';

async function tableExists(tableName) {
    const result = await pool.query(
        `
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = $1
        LIMIT 1
        `,
        [tableName],
    );
    return result.rowCount > 0;
}

async function columnExists(tableName, columnName) {
    const result = await pool.query(
        `
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = $1
          AND column_name = $2
        LIMIT 1
        `,
        [tableName, columnName],
    );
    return result.rowCount > 0;
}

/**
 * Extend file_manager_items for scope-based FY / project / personal rows,
 * create file_manager_permissions, migrate legacy 5 tables, then drop them.
 */
export const initializeUnifiedFileManagerSchema = async () => {
    // ---- columns on file_manager_items ----
    await pool.query(`
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'file_manager_items' AND column_name = 'scope'
            ) THEN
                ALTER TABLE file_manager_items
                    ADD COLUMN scope VARCHAR(40) NOT NULL DEFAULT 'file_manager';
            END IF;

            IF NOT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'file_manager_items' AND column_name = 'scope_root_id'
            ) THEN
                ALTER TABLE file_manager_items
                    ADD COLUMN scope_root_id BIGINT NULL;
            END IF;

            IF NOT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'file_manager_items' AND column_name = 'project_id'
            ) THEN
                ALTER TABLE file_manager_items ADD COLUMN project_id BIGINT NULL;
            END IF;

            IF NOT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'file_manager_items' AND column_name = 'project_code'
            ) THEN
                ALTER TABLE file_manager_items ADD COLUMN project_code VARCHAR(100) NULL;
            END IF;

            IF NOT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'file_manager_items' AND column_name = 'financial_year'
            ) THEN
                ALTER TABLE file_manager_items ADD COLUMN financial_year VARCHAR(20) NULL;
            END IF;

            IF NOT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'file_manager_items' AND column_name = 'financial_year_id'
            ) THEN
                ALTER TABLE file_manager_items ADD COLUMN financial_year_id BIGINT NULL;
            END IF;

            IF NOT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'file_manager_items' AND column_name = 'year_code'
            ) THEN
                ALTER TABLE file_manager_items ADD COLUMN year_code VARCHAR(20) NULL;
            END IF;

            IF NOT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'file_manager_items' AND column_name = 'absolute_path'
            ) THEN
                ALTER TABLE file_manager_items ADD COLUMN absolute_path TEXT NULL;
            END IF;

            IF NOT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'file_manager_items' AND column_name = 'category_id'
            ) THEN
                ALTER TABLE file_manager_items ADD COLUMN category_id BIGINT NULL;
            END IF;

            IF NOT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'file_manager_items' AND column_name = 'category_name'
            ) THEN
                ALTER TABLE file_manager_items ADD COLUMN category_name VARCHAR(255) NULL;
            END IF;

            IF NOT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'file_manager_items' AND column_name = 'template_id'
            ) THEN
                ALTER TABLE file_manager_items ADD COLUMN template_id BIGINT NULL;
            END IF;

            IF NOT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'file_manager_items' AND column_name = 'display_order'
            ) THEN
                ALTER TABLE file_manager_items
                    ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0;
            END IF;

            IF NOT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'file_manager_items' AND column_name = 'is_active'
            ) THEN
                ALTER TABLE file_manager_items
                    ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE;
            END IF;

            IF NOT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'file_manager_items' AND column_name = 'pcb_code'
            ) THEN
                ALTER TABLE file_manager_items ADD COLUMN pcb_code VARCHAR(100) NULL;
            END IF;

            IF NOT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'file_manager_items' AND column_name = 'project_pcb_code'
            ) THEN
                ALTER TABLE file_manager_items ADD COLUMN project_pcb_code VARCHAR(200) NULL;
            END IF;

            IF NOT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'file_manager_items' AND column_name = 'google_sheet_url'
            ) THEN
                ALTER TABLE file_manager_items ADD COLUMN google_sheet_url TEXT NULL;
            END IF;

            IF NOT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'file_manager_items' AND column_name = 'project_file_manager_path'
            ) THEN
                ALTER TABLE file_manager_items
                    ADD COLUMN project_file_manager_path TEXT NULL;
            END IF;

            IF NOT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'file_manager_items' AND column_name = 'legacy_source'
            ) THEN
                ALTER TABLE file_manager_items ADD COLUMN legacy_source VARCHAR(80) NULL;
            END IF;

            IF NOT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'file_manager_items' AND column_name = 'legacy_id'
            ) THEN
                ALTER TABLE file_manager_items ADD COLUMN legacy_id BIGINT NULL;
            END IF;

            -- URL-safe public id (16 random bytes, base64url) for shareable links
            IF NOT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'file_manager_items' AND column_name = 'public_id'
            ) THEN
                ALTER TABLE file_manager_items
                    ADD COLUMN public_id VARCHAR(32) NULL;
            END IF;
        END $$;
    `);

    await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_file_manager_items_public_id
            ON file_manager_items (public_id)
            WHERE public_id IS NOT NULL
    `);

    // Backfill missing public_id values (16-byte base64url)
    try {
        const missing = await pool.query(
            `
            SELECT id
            FROM file_manager_items
            WHERE public_id IS NULL OR TRIM(public_id) = ''
            ORDER BY id ASC
            LIMIT 5000
            `,
        );
        for (const row of missing.rows) {
            let attempts = 0;
            while (attempts < 5) {
                attempts += 1;
                const publicId = generatePublicId();
                try {
                    await pool.query(
                        `
                        UPDATE file_manager_items
                        SET public_id = $2
                        WHERE id = $1
                          AND (public_id IS NULL OR TRIM(public_id) = '')
                        `,
                        [row.id, publicId],
                    );
                    break;
                } catch (err) {
                    if (String(err?.code) !== '23505') throw err;
                }
            }
        }
        if (missing.rows.length) {
            console.log(
                `✅ Backfilled public_id on ${missing.rows.length} file_manager_items`,
            );
        }
    } catch (err) {
        console.warn(
            '⚠️ Could not backfill file_manager_items.public_id:',
            err?.message || err,
        );
    }

    // Allow NULL owner/username for shared FY/project roots
    await pool.query(`
        ALTER TABLE file_manager_items
            ALTER COLUMN owner_id DROP NOT NULL;
    `).catch(() => {});
    await pool.query(`
        ALTER TABLE file_manager_items
            ALTER COLUMN username DROP NOT NULL;
    `).catch(() => {});

    // Relax item_type CHECK (project rows may be google_sheet, etc.)
    await pool.query(`
        DO $$
        DECLARE
            r RECORD;
        BEGIN
            FOR r IN
                SELECT c.conname
                FROM pg_constraint c
                JOIN pg_class t ON t.oid = c.conrelid
                WHERE t.relname = 'file_manager_items'
                  AND c.contype = 'c'
                  AND pg_get_constraintdef(c.oid) ILIKE '%item_type%'
            LOOP
                EXECUTE format(
                    'ALTER TABLE file_manager_items DROP CONSTRAINT %I',
                    r.conname
                );
            END LOOP;
        END $$;
    `);

    // scope_root_id self-FK (optional)
    await pool.query(`
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM information_schema.table_constraints
                WHERE table_name = 'file_manager_items'
                  AND constraint_name = 'fk_file_manager_scope_root'
            ) THEN
                ALTER TABLE file_manager_items
                    ADD CONSTRAINT fk_file_manager_scope_root
                    FOREIGN KEY (scope_root_id)
                    REFERENCES file_manager_items(id)
                    ON DELETE CASCADE;
            END IF;
        EXCEPTION WHEN others THEN
            NULL;
        END $$;
    `);

    await pool.query(`
        UPDATE file_manager_items
        SET scope = 'file_manager'
        WHERE scope IS NULL OR TRIM(scope) = ''
    `);

    // Personal-root uniqueness must ignore FY/project roots
    await pool.query(`DROP INDEX IF EXISTS uq_file_manager_one_root_per_owner;`);
    try {
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
            '⚠️ Could not recreate uq_file_manager_one_root_per_owner:',
            err.message,
        );
    }

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_file_manager_scope
            ON file_manager_items(scope);
        CREATE INDEX IF NOT EXISTS idx_file_manager_scope_root
            ON file_manager_items(scope_root_id);
        CREATE INDEX IF NOT EXISTS idx_file_manager_project_id
            ON file_manager_items(project_id)
            WHERE project_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_file_manager_financial_year_id
            ON file_manager_items(financial_year_id)
            WHERE financial_year_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_file_manager_year_code
            ON file_manager_items(LOWER(year_code))
            WHERE year_code IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_file_manager_legacy
            ON file_manager_items(legacy_source, legacy_id)
            WHERE legacy_id IS NOT NULL;
    `);

    try {
        await pool.query(`
            DROP INDEX IF EXISTS uq_fm_project_root_project_id;
        `);
        await pool.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS uq_fm_project_root_project_id
                ON file_manager_items(project_id)
                WHERE scope = 'project'
                  AND scope_root_id IS NULL
                  AND is_deleted = FALSE
                  AND project_id IS NOT NULL;
        `);
        await pool.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS uq_fm_fy_financial_year_id
                ON file_manager_items(financial_year_id)
                WHERE scope = 'financial_year'
                  AND is_deleted = FALSE
                  AND financial_year_id IS NOT NULL;
        `);
        await pool.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS uq_fm_fy_year_code
                ON file_manager_items(LOWER(TRIM(year_code)))
                WHERE scope = 'financial_year'
                  AND is_deleted = FALSE
                  AND year_code IS NOT NULL;
        `);
    } catch (err) {
        console.warn('⚠️ Could not create scoped unique indexes:', err.message);
    }

    // ---- unified permissions table (role: owner | editor | viewer) ----
    await initializeFileManagerPermissionsTable();

    // Seed permissions from personal folder users if not yet migrated
    if (await tableExists('file_manager_item_folder_users')) {
        await pool.query(`
            INSERT INTO file_manager_permissions (
                item_id, user_id, username,
                role,
                assigned_by_username, assigned_at
            )
            SELECT
                u.item_id, u.user_id, u.username,
                CASE
                    WHEN COALESCE(u.can_delete, FALSE) THEN 'owner'
                    WHEN COALESCE(u.can_create, FALSE) OR COALESCE(u.can_rename, FALSE)
                        THEN 'editor'
                    ELSE 'viewer'
                END,
                u.assigned_by_username, u.assigned_at
            FROM file_manager_item_folder_users u
            WHERE EXISTS (
                SELECT 1 FROM file_manager_items i WHERE i.id = u.item_id
            )
            ON CONFLICT (item_id, user_id) DO NOTHING
        `);
    }

    await migrateLegacyScopedTables();
    await dropLegacyScopedTables();

    // Revive project/FY rows soft-deleted by older personal-root cleanup
    try {
        await pool.query(`
            UPDATE file_manager_items
            SET
                is_deleted = FALSE,
                deleted_at = NULL,
                deleted_by = NULL,
                updated_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
            WHERE is_deleted = TRUE
              AND recycle_path IS NULL
              AND LOWER(TRIM(COALESCE(scope, ''))) IN ('project', 'financial_year')
        `);
    } catch (err) {
        console.warn(
            '⚠️ Could not revive scoped folders during unify:',
            err.message,
        );
    }

    // Project nested items: parent_id must point at parent (root uses scope_root_id)
    try {
        await pool.query(`
            UPDATE file_manager_items
            SET parent_id = scope_root_id,
                updated_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
            WHERE scope = 'project'
              AND scope_root_id IS NOT NULL
              AND parent_id IS NULL
              AND is_deleted = FALSE
        `);
    } catch (err) {
        console.warn(
            '⚠️ Could not normalize project parent_id during unify:',
            err.message,
        );
    }

    console.log(
        '✅ Unified file_manager_items + file_manager_permissions ready',
    );
};

async function migrateLegacyScopedTables() {
    const hasFyFolders = await tableExists(
        'financial_year_file_manager_folders',
    );
    const hasProjectFolders = await tableExists(
        'project_file_manager_folders',
    );
    if (!hasFyFolders && !hasProjectFolders) return;

    await pool.query(`
        CREATE TABLE IF NOT EXISTS file_manager_legacy_id_map (
            legacy_table VARCHAR(80) NOT NULL,
            legacy_id BIGINT NOT NULL,
            new_id BIGINT NOT NULL
                REFERENCES file_manager_items(id)
                ON DELETE CASCADE,
            PRIMARY KEY (legacy_table, legacy_id)
        );
    `);

    // ---- FY folders ----
    if (hasFyFolders) {
        const fyRows = await pool.query(
            `SELECT * FROM financial_year_file_manager_folders ORDER BY id ASC`,
        );
        for (const row of fyRows.rows) {
            const existing = await pool.query(
                `
                SELECT new_id FROM file_manager_legacy_id_map
                WHERE legacy_table = 'financial_year_file_manager_folders'
                  AND legacy_id = $1
                `,
                [row.id],
            );
            if (existing.rows[0]) continue;

            const byFy = await pool.query(
                `
                SELECT id FROM file_manager_items
                WHERE scope = $1
                  AND financial_year_id = $2
                  AND is_deleted = FALSE
                LIMIT 1
                `,
                [FILE_MANAGER_SCOPES.FINANCIAL_YEAR, row.financial_year_id],
            );
            let newId = byFy.rows[0]?.id;
            if (!newId) {
                const inserted = await pool.query(
                    `
                    INSERT INTO file_manager_items (
                        owner_id, username, parent_id, name, item_type,
                        storage_name, relative_path, filemanager_path,
                        created_by, updated_by, scope, absolute_path,
                        financial_year_id, year_code, financial_year,
                        project_file_manager_path, is_active,
                        legacy_source, legacy_id, public_id
                    ) VALUES (
                        $1, $2, NULL, $3, 'folder',
                        NULL, $4, $5,
                        COALESCE($2, 'system'), COALESCE($2, 'system'),
                        $6, $7,
                        $8, $9, $9,
                        $10, TRUE,
                        'financial_year_file_manager_folders', $11, $12
                    )
                    RETURNING id
                    `,
                    [
                        row.owner_id ?? null,
                        row.username ?? null,
                        row.folder_name || row.year_code,
                        row.relative_path,
                        row.project_file_manager_path || null,
                        FILE_MANAGER_SCOPES.FINANCIAL_YEAR,
                        row.absolute_path,
                        row.financial_year_id,
                        row.year_code,
                        row.project_file_manager_path,
                        row.id,
                        generatePublicId(),
                    ],
                );
                newId = inserted.rows[0].id;
            }
            await pool.query(
                `
                INSERT INTO file_manager_legacy_id_map (legacy_table, legacy_id, new_id)
                VALUES ('financial_year_file_manager_folders', $1, $2)
                ON CONFLICT DO NOTHING
                `,
                [row.id, newId],
            );
        }

        if (await tableExists('financial_year_file_manager_folder_users')) {
            await pool.query(`
                INSERT INTO file_manager_permissions (
                    item_id, user_id, username,
                    role,
                    assigned_by_username, assigned_at
                )
                SELECT
                    m.new_id, u.user_id, u.username,
                    CASE
                        WHEN COALESCE(u.can_delete, FALSE) THEN 'owner'
                        WHEN COALESCE(u.can_create, FALSE) OR COALESCE(u.can_rename, FALSE)
                            THEN 'editor'
                        ELSE 'viewer'
                    END,
                    u.assigned_by_username, u.assigned_at
                FROM financial_year_file_manager_folder_users u
                INNER JOIN file_manager_legacy_id_map m
                    ON m.legacy_table = 'financial_year_file_manager_folders'
                   AND m.legacy_id = u.fy_folder_id
                ON CONFLICT (item_id, user_id) DO NOTHING
            `);
        }
    }

    // ---- Project folders (roots) ----
    if (hasProjectFolders) {
        const projectRows = await pool.query(
            `SELECT * FROM project_file_manager_folders ORDER BY id ASC`,
        );
        for (const row of projectRows.rows) {
            const existing = await pool.query(
                `
                SELECT new_id FROM file_manager_legacy_id_map
                WHERE legacy_table = 'project_file_manager_folders'
                  AND legacy_id = $1
                `,
                [row.id],
            );
            if (existing.rows[0]) continue;

            const byProject = await pool.query(
                `
                SELECT id FROM file_manager_items
                WHERE scope = $1
                  AND project_id = $2
                  AND scope_root_id IS NULL
                  AND is_deleted = FALSE
                LIMIT 1
                `,
                [FILE_MANAGER_SCOPES.PROJECT, row.project_id],
            );
            let newId = byProject.rows[0]?.id;
            if (!newId) {
                const inserted = await pool.query(
                    `
                    INSERT INTO file_manager_items (
                        owner_id, username, parent_id, name, item_type,
                        storage_name, relative_path, filemanager_path,
                        created_by, updated_by, scope, absolute_path,
                        project_id, project_code, financial_year,
                        category_id, category_name, is_active,
                        legacy_source, legacy_id, public_id
                    ) VALUES (
                        $1, $2, NULL, $3, 'folder',
                        NULL, $4, $5,
                        COALESCE($2, 'system'), COALESCE($2, 'system'),
                        $6, $7,
                        $8, $9, $10,
                        $11, $12, TRUE,
                        'project_file_manager_folders', $13, $14
                    )
                    RETURNING id
                    `,
                    [
                        row.owner_id ?? null,
                        row.username ?? null,
                        row.folder_name || row.project_code,
                        row.relative_path,
                        row.absolute_path
                            ? String(row.absolute_path).replace(
                                  /[\\/][^\\/]+$/,
                                  '',
                              )
                            : null,
                        FILE_MANAGER_SCOPES.PROJECT,
                        row.absolute_path,
                        row.project_id,
                        row.project_code,
                        row.financial_year,
                        row.category_id ?? null,
                        row.category_name ?? null,
                        row.id,
                        generatePublicId(),
                    ],
                );
                newId = inserted.rows[0].id;
            }
            await pool.query(
                `
                INSERT INTO file_manager_legacy_id_map (legacy_table, legacy_id, new_id)
                VALUES ('project_file_manager_folders', $1, $2)
                ON CONFLICT DO NOTHING
                `,
                [row.id, newId],
            );
        }

        if (await tableExists('project_file_manager_folder_users')) {
            await pool.query(`
                INSERT INTO file_manager_permissions (
                    item_id, user_id, username,
                    role,
                    assigned_by_username, assigned_at
                )
                SELECT
                    m.new_id, u.user_id, u.username,
                    CASE
                        WHEN COALESCE(u.can_delete, FALSE) THEN 'owner'
                        WHEN COALESCE(u.can_create, FALSE) OR COALESCE(u.can_rename, FALSE)
                            THEN 'editor'
                        ELSE 'viewer'
                    END,
                    u.assigned_by_username, u.assigned_at
                FROM project_file_manager_folder_users u
                INNER JOIN file_manager_legacy_id_map m
                    ON m.legacy_table = 'project_file_manager_folders'
                   AND m.legacy_id = u.project_folder_id
                ON CONFLICT (item_id, user_id) DO NOTHING
            `);
        }
    }

    // ---- Project items (nested) — parents before children by id ----
    if (await tableExists('project_file_manager_items')) {
        const items = await pool.query(
            `
            SELECT *
            FROM project_file_manager_items
            ORDER BY id ASC
            `,
        );

        for (const row of items.rows) {
            const existing = await pool.query(
                `
                SELECT new_id FROM file_manager_legacy_id_map
                WHERE legacy_table = 'project_file_manager_items'
                  AND legacy_id = $1
                `,
                [row.id],
            );
            if (existing.rows[0]) continue;

            const rootMap = await pool.query(
                `
                SELECT new_id FROM file_manager_legacy_id_map
                WHERE legacy_table = 'project_file_manager_folders'
                  AND legacy_id = $1
                `,
                [row.project_folder_id],
            );
            const rootId = rootMap.rows[0]?.new_id;
            if (!rootId) continue;

            let parentId = null;
            if (row.parent_id != null) {
                const parentMap = await pool.query(
                    `
                    SELECT new_id FROM file_manager_legacy_id_map
                    WHERE legacy_table = 'project_file_manager_items'
                      AND legacy_id = $1
                    `,
                    [row.parent_id],
                );
                parentId = parentMap.rows[0]?.new_id ?? null;
                // If parent not migrated yet, skip and retry later
                if (parentId == null) continue;
            }

            const rootMeta = await pool.query(
                `
                SELECT owner_id, username, project_id, project_code, financial_year
                FROM file_manager_items
                WHERE id = $1
                `,
                [rootId],
            );
            const root = rootMeta.rows[0] || {};
            const itemType = String(row.item_type || 'folder')
                .trim()
                .toLowerCase();
            const isFileLike =
                itemType === 'file' ||
                itemType.startsWith('google_') ||
                Boolean(row.google_file_id);

            const inserted = await pool.query(
                `
                INSERT INTO file_manager_items (
                    owner_id, username, parent_id, name, item_type,
                    storage_name, relative_path, filemanager_path,
                    created_by, updated_by, scope, scope_root_id,
                    absolute_path, project_id, project_code, financial_year,
                    template_id, display_order, is_active,
                    google_file_id, google_sheet_url, url,
                    pcb_code, project_pcb_code, file_source,
                    legacy_source, legacy_id, public_id
                ) VALUES (
                    $1, $2, $3, $4, $5,
                    NULL, $6, NULL,
                    COALESCE($2, 'system'), COALESCE($2, 'system'),
                    $7, $8,
                    $9, $10, $11, $12,
                    $13, $14, $15,
                    $16, $17, $17,
                    $18, $19, $20,
                    'project_file_manager_items', $21, $22
                )
                RETURNING id
                `,
                [
                    root.owner_id ?? null,
                    root.username ?? null,
                    parentId,
                    row.folder_name,
                    isFileLike && itemType === 'folder' ? 'file' : itemType,
                    row.relative_path,
                    FILE_MANAGER_SCOPES.PROJECT,
                    rootId,
                    row.absolute_path,
                    root.project_id ?? null,
                    root.project_code ?? null,
                    root.financial_year ?? null,
                    row.template_id ?? null,
                    row.display_order ?? 0,
                    row.is_active !== false,
                    row.google_file_id ?? null,
                    row.google_sheet_url ?? null,
                    row.pcb_code ?? null,
                    row.project_pcb_code ?? null,
                    itemType.startsWith('google_')
                        ? itemType
                        : row.google_file_id
                          ? 'google_sheet'
                          : 'local',
                    row.id,
                    generatePublicId(),
                ],
            );

            await pool.query(
                `
                INSERT INTO file_manager_legacy_id_map (legacy_table, legacy_id, new_id)
                VALUES ('project_file_manager_items', $1, $2)
                ON CONFLICT DO NOTHING
                `,
                [row.id, inserted.rows[0].id],
            );
        }

        // Second pass for any skipped children whose parents are now mapped
        const pending = await pool.query(
            `
            SELECT i.*
            FROM project_file_manager_items i
            WHERE NOT EXISTS (
                SELECT 1 FROM file_manager_legacy_id_map m
                WHERE m.legacy_table = 'project_file_manager_items'
                  AND m.legacy_id = i.id
            )
            ORDER BY i.id ASC
            `,
        );
        for (const row of pending.rows) {
            const rootMap = await pool.query(
                `
                SELECT new_id FROM file_manager_legacy_id_map
                WHERE legacy_table = 'project_file_manager_folders'
                  AND legacy_id = $1
                `,
                [row.project_folder_id],
            );
            const rootId = rootMap.rows[0]?.new_id;
            if (!rootId) continue;

            let parentId = null;
            if (row.parent_id != null) {
                const parentMap = await pool.query(
                    `
                    SELECT new_id FROM file_manager_legacy_id_map
                    WHERE legacy_table = 'project_file_manager_items'
                      AND legacy_id = $1
                    `,
                    [row.parent_id],
                );
                parentId = parentMap.rows[0]?.new_id ?? null;
                if (parentId == null) continue;
            }

            const rootMeta = await pool.query(
                `SELECT owner_id, username, project_id, project_code, financial_year
                 FROM file_manager_items WHERE id = $1`,
                [rootId],
            );
            const root = rootMeta.rows[0] || {};
            const itemType = String(row.item_type || 'folder')
                .trim()
                .toLowerCase();

            const inserted = await pool.query(
                `
                INSERT INTO file_manager_items (
                    owner_id, username, parent_id, name, item_type,
                    relative_path, created_by, updated_by,
                    scope, scope_root_id, absolute_path,
                    project_id, project_code, financial_year,
                    template_id, display_order, is_active,
                    google_file_id, google_sheet_url, url,
                    pcb_code, project_pcb_code, file_source,
                    legacy_source, legacy_id, public_id
                ) VALUES (
                    $1, $2, $3, $4, $5,
                    $6, COALESCE($2, 'system'), COALESCE($2, 'system'),
                    $7, $8, $9,
                    $10, $11, $12,
                    $13, $14, $15,
                    $16, $17, $17,
                    $18, $19, $20,
                    'project_file_manager_items', $21, $22
                )
                RETURNING id
                `,
                [
                    root.owner_id ?? null,
                    root.username ?? null,
                    parentId,
                    row.folder_name,
                    itemType,
                    row.relative_path,
                    FILE_MANAGER_SCOPES.PROJECT,
                    rootId,
                    row.absolute_path,
                    root.project_id ?? null,
                    root.project_code ?? null,
                    root.financial_year ?? null,
                    row.template_id ?? null,
                    row.display_order ?? 0,
                    row.is_active !== false,
                    row.google_file_id ?? null,
                    row.google_sheet_url ?? null,
                    row.pcb_code ?? null,
                    row.project_pcb_code ?? null,
                    itemType.startsWith('google_')
                        ? itemType
                        : row.google_file_id
                          ? 'google_sheet'
                          : 'local',
                    row.id,
                    generatePublicId(),
                ],
            );
            await pool.query(
                `
                INSERT INTO file_manager_legacy_id_map (legacy_table, legacy_id, new_id)
                VALUES ('project_file_manager_items', $1, $2)
                ON CONFLICT DO NOTHING
                `,
                [row.id, inserted.rows[0].id],
            );
        }
    }

    console.log('✅ Migrated legacy FY/project file-manager tables into file_manager_items');
}

async function dropLegacyScopedTables() {
    // Drop dependent user / item tables first
    const drops = [
        'project_file_manager_folder_users',
        'project_file_manager_items',
        'project_file_manager_folders',
        'financial_year_file_manager_folder_users',
        'financial_year_file_manager_folders',
        'file_manager_item_folder_users',
    ];

    for (const table of drops) {
        if (!(await tableExists(table))) continue;
        try {
            await pool.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
            console.log(`✅ Dropped legacy table ${table}`);
        } catch (err) {
            console.warn(`⚠️ Could not drop ${table}:`, err.message);
        }
    }
}

export {
    tableExists,
    columnExists,
};
