import { pool } from '../../config/db.js';
import FileManagerModel from './fileManager.model.js';
import { FILE_MANAGER_SCOPES } from './fileManagerScopes.js';

export const PERMISSION_ROLES = Object.freeze({
    OWNER: 'owner',
    EDITOR: 'editor',
    VIEWER: 'viewer',
});

const ROLE_RANK = Object.freeze({
    [PERMISSION_ROLES.VIEWER]: 1,
    [PERMISSION_ROLES.EDITOR]: 2,
    [PERMISSION_ROLES.OWNER]: 3,
});

export function normalizePermissionRole(value, fallback = PERMISSION_ROLES.VIEWER) {
    const raw = String(value || '')
        .trim()
        .toLowerCase();
    if (raw === PERMISSION_ROLES.OWNER || raw === 'owners') {
        return PERMISSION_ROLES.OWNER;
    }
    if (raw === PERMISSION_ROLES.EDITOR || raw === 'edit') {
        return PERMISSION_ROLES.EDITOR;
    }
    if (raw === PERMISSION_ROLES.VIEWER || raw === 'view') {
        return PERMISSION_ROLES.VIEWER;
    }
    return fallback;
}

/** Normalize role metadata for API responses (role-only, no can_* flags). */
export function capabilitiesForRole(role) {
    const r = normalizePermissionRole(role, PERMISSION_ROLES.VIEWER);
    return {
        role: r,
        is_owner: r === PERMISSION_ROLES.OWNER,
    };
}

/** True when the user has any share role on an item. */
export function hasPermissionRole(row) {
    if (!row) return false;
    const r = normalizePermissionRole(row.role, null);
    return (
        r === PERMISSION_ROLES.OWNER ||
        r === PERMISSION_ROLES.EDITOR ||
        r === PERMISSION_ROLES.VIEWER
    );
}

export function roleAllowsEdit(role) {
    const r = normalizePermissionRole(role, null);
    return r === PERMISSION_ROLES.OWNER || r === PERMISSION_ROLES.EDITOR;
}

export function roleAllowsDelete(role) {
    return normalizePermissionRole(role, null) === PERMISSION_ROLES.OWNER;
}

export function roleRank(role) {
    return ROLE_RANK[normalizePermissionRole(role)] || 0;
}

async function migratePermissionColumns() {
    await pool.query(`
        ALTER TABLE file_manager_permissions
            ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'viewer'
    `);

    // Google Drive–style cascade: null = directly shared; set = inherited from that item
    await pool.query(`
        ALTER TABLE file_manager_permissions
            ADD COLUMN IF NOT EXISTS inherited_from_item_id BIGINT NULL
            REFERENCES file_manager_items(id)
            ON DELETE CASCADE
    `);
    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_fm_permissions_inherited_from
            ON file_manager_permissions(inherited_from_item_id)
    `);

    // true = share all children; false = this folder/file only
    await pool.query(`
        ALTER TABLE file_manager_permissions
            ADD COLUMN IF NOT EXISTS is_childshare BOOLEAN NOT NULL DEFAULT TRUE
    `);

    const cols = await pool.query(
        `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'file_manager_permissions'
          AND column_name = ANY($1::text[])
        `,
        [
            [
                'can_view',
                'can_edit',
                'can_delete',
                'can_create',
                'can_rename',
                'can_download',
            ],
        ],
    );
    const names = new Set(cols.rows.map((r) => r.column_name));

    // Backfill role from legacy boolean flags when role is still default/null
    if (
        names.has('can_delete') ||
        names.has('can_edit') ||
        names.has('can_create') ||
        names.has('can_rename')
    ) {
        const deleteExpr = names.has('can_delete')
            ? 'COALESCE(can_delete, FALSE)'
            : 'FALSE';
        const editExpr = names.has('can_edit')
            ? 'COALESCE(can_edit, FALSE)'
            : names.has('can_create') || names.has('can_rename')
              ? `(COALESCE(${names.has('can_create') ? 'can_create' : 'FALSE'}, FALSE) OR COALESCE(${names.has('can_rename') ? 'can_rename' : 'FALSE'}, FALSE))`
              : 'FALSE';

        await pool.query(`
            UPDATE file_manager_permissions
            SET role = CASE
                WHEN ${deleteExpr} THEN 'owner'
                WHEN ${editExpr} THEN 'editor'
                ELSE 'viewer'
            END
            WHERE role IS NULL
               OR TRIM(role) = ''
               OR LOWER(TRIM(role)) = 'viewer'
        `);
    }

    await pool.query(`
        UPDATE file_manager_permissions
        SET role = LOWER(TRIM(role))
        WHERE role IS NOT NULL
    `);

    await pool.query(`
        UPDATE file_manager_permissions
        SET role = 'viewer'
        WHERE role IS NULL
           OR LOWER(TRIM(role)) NOT IN ('owner', 'editor', 'viewer')
    `);

    for (const col of [
        'can_view',
        'can_edit',
        'can_delete',   
        'can_create',
        'can_rename',
        'can_download',
    ]) {
        if (names.has(col)) {
            await pool.query(
                `ALTER TABLE file_manager_permissions DROP COLUMN IF EXISTS ${col}`,
            );
        }
    }

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_fm_permissions_role
            ON file_manager_permissions(LOWER(role))
    `);
}

export const initializeFileManagerPermissionsTable = async () => {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS file_manager_permissions (
            id BIGSERIAL PRIMARY KEY,

            item_id BIGINT NOT NULL
                REFERENCES file_manager_items(id)
                ON DELETE CASCADE,

            user_id BIGINT NOT NULL,
            username VARCHAR(100) NOT NULL,

            role VARCHAR(20) NOT NULL DEFAULT 'viewer',

            assigned_by_username VARCHAR(100) NOT NULL,
            assigned_at TIMESTAMP DEFAULT TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP),

            inherited_from_item_id BIGINT NULL
                REFERENCES file_manager_items(id)
                ON DELETE CASCADE,

            is_childshare BOOLEAN NOT NULL DEFAULT TRUE,

            UNIQUE (item_id, user_id),
            CONSTRAINT file_manager_permissions_role_check
                CHECK (LOWER(role) IN ('owner', 'editor', 'viewer'))
        );

        CREATE INDEX IF NOT EXISTS idx_fm_permissions_item
            ON file_manager_permissions(item_id);
        CREATE INDEX IF NOT EXISTS idx_fm_permissions_user
            ON file_manager_permissions(user_id);
        CREATE INDEX IF NOT EXISTS idx_fm_permissions_username
            ON file_manager_permissions(LOWER(username));
        CREATE INDEX IF NOT EXISTS idx_fm_permissions_role
            ON file_manager_permissions(LOWER(role));
    `);

    await migratePermissionColumns();

    // Existing tables may predate the CHECK constraint
    try {
        await pool.query(`
            ALTER TABLE file_manager_permissions
                DROP CONSTRAINT IF EXISTS file_manager_permissions_role_check
        `);
        await pool.query(`
            ALTER TABLE file_manager_permissions
                ADD CONSTRAINT file_manager_permissions_role_check
                CHECK (LOWER(role) IN ('owner', 'editor', 'viewer'))
        `);
    } catch {
        /* constraint may already exist with same definition */
    }
};

/** Attach role metadata for API consumers (no can_* flags). */
function withRoleCapabilities(row) {
    if (!row) return row;
    const caps = capabilitiesForRole(row.role);
    return {
        id: row.id,
        item_id: row.item_id,
        user_id: row.user_id,
        username: row.username,
        role: caps.role,
        assigned_by_username: row.assigned_by_username,
        assigned_at: row.assigned_at,
        inherited_from_item_id:
            row.inherited_from_item_id != null
                ? Number(row.inherited_from_item_id)
                : null,
        is_childshare:
            row.is_childshare == null
                ? true
                : Boolean(row.is_childshare),
        is_owner: caps.is_owner,
        project_folder_id: row.item_id,
        fy_folder_id: row.item_id,
        access: {
            role: caps.role,
            is_owner: caps.is_owner,
        },
    };
}

function parseIsChildShare(value, fallback = true) {
    if (value == null) return Boolean(fallback);
    if (typeof value === 'boolean') return value;
    const raw = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on'].includes(raw)) return true;
    if (['0', 'false', 'no', 'n', 'off'].includes(raw)) return false;
    return Boolean(fallback);
}

class FileManagerPermissionModel {
    /**
     * Permissions apply to any active folder or file row in file_manager_items.
     * @param {number} itemId
     * @param {string|null} expectedScope
     * @param {{ foldersOnly?: boolean }} [options]
     */
    static async assertItem(
        itemId,
        expectedScope = null,
        { foldersOnly = false } = {},
    ) {
        const item = await FileManagerModel.findById(itemId, {
            includeDeleted: false,
            anyScope: true,
        });
        if (!item) {
            const err = new Error('File manager item not found');
            err.status = 404;
            throw err;
        }
        const itemType = String(item.item_type || '')
            .trim()
            .toLowerCase();
        if (foldersOnly && itemType !== 'folder') {
            const err = new Error(
                'Permissions apply to folders only (item_type must be folder)',
            );
            err.status = 400;
            throw err;
        }
        if (item.is_deleted) {
            const err = new Error(
                'Cannot assign permissions on a deleted item',
            );
            err.status = 400;
            throw err;
        }
        if (
            expectedScope &&
            String(item.scope || FILE_MANAGER_SCOPES.FILE_MANAGER) !==
                expectedScope
        ) {
            const err = new Error(
                `Item scope mismatch (expected ${expectedScope})`,
            );
            err.status = 400;
            throw err;
        }
        return item;
    }

    /** @deprecated Prefer assertItem — kept for older folder-only callers. */
    static async assertFolderItem(itemId, expectedScope = null) {
        return FileManagerPermissionModel.assertItem(itemId, expectedScope, {
            foldersOnly: false,
        });
    }

    static async listUsers(itemId) {
        const result = await pool.query(
            `
            SELECT *
            FROM file_manager_permissions
            WHERE item_id = $1
            ORDER BY
                CASE LOWER(role)
                    WHEN 'owner' THEN 1
                    WHEN 'editor' THEN 2
                    ELSE 3
                END,
                LOWER(username) ASC,
                id ASC
            `,
            [itemId],
        );
        return result.rows.map(withRoleCapabilities);
    }

    static async findUser(itemId, userId) {
        const result = await pool.query(
            `
            SELECT *
            FROM file_manager_permissions
            WHERE item_id = $1
              AND user_id = $2
            `,
            [itemId, userId],
        );
        return withRoleCapabilities(result.rows[0] || null);
    }

    /**
     * Current user's permission rows for many items (by user_id and/or username).
     * @returns {Map<number, object>} item_id → permission row with role caps
     */
    static async findUserForItems(itemIds, { userId = null, username = null } = {}) {
        const ids = [...new Set((itemIds || []).map(Number).filter((n) => n > 0))];
        const map = new Map();
        if (!ids.length) return map;

        const uid = userId != null ? Number(userId) : null;
        const uname = String(username || '').trim().toLowerCase();
        if (!Number.isFinite(uid) && !uname) return map;

        const result = await pool.query(
            `
            SELECT *
            FROM file_manager_permissions
            WHERE item_id = ANY($1::bigint[])
              AND (
                    ($2::bigint IS NOT NULL AND user_id = $2)
                 OR ($3::text <> '' AND LOWER(TRIM(username)) = $3)
              )
            `,
            [ids, Number.isFinite(uid) ? uid : null, uname],
        );
        for (const row of result.rows) {
            map.set(Number(row.item_id), withRoleCapabilities(row));
        }
        return map;
    }

    /** item_ids that have at least one permission row assigned. */
    static async itemIdsWithAnyPermission(itemIds) {
        const ids = [...new Set((itemIds || []).map(Number).filter((n) => n > 0))];
        if (!ids.length) return new Set();
        const result = await pool.query(
            `
            SELECT DISTINCT item_id
            FROM file_manager_permissions
            WHERE item_id = ANY($1::bigint[])
            `,
            [ids],
        );
        return new Set(result.rows.map((r) => Number(r.item_id)));
    }

    /**
     * All item ids that receive a share when folder `itemId` is shared:
     * the item itself + every descendant (parent_id tree) + project children
     * linked via scope_root_id when sharing a project root.
     */
    
    static async listCascadeItemIds(itemId) {
        const rootId = Number(itemId);
        if (!Number.isFinite(rootId) || rootId <= 0) return [];
        const result = await pool.query(
            `
            WITH RECURSIVE tree AS (
                SELECT id, scope, scope_root_id
                FROM file_manager_items
                WHERE id = $1
                  AND is_deleted = FALSE
                UNION ALL
                SELECT c.id, c.scope, c.scope_root_id
                FROM file_manager_items c
                INNER JOIN tree t ON c.parent_id = t.id
                WHERE c.is_deleted = FALSE
            ),
            scoped AS (
                SELECT i.id
                FROM file_manager_items i
                INNER JOIN tree t ON t.id = $1
                WHERE i.scope_root_id = $1
                  AND i.is_deleted = FALSE
                  AND t.scope_root_id IS NULL
            )
            SELECT DISTINCT id
            FROM (
                SELECT id FROM tree
                UNION
                SELECT id FROM scoped
            ) x
            ORDER BY id ASC
            `,
            [rootId],
        );
        return result.rows.map((r) => Number(r.id)).filter((n) => n > 0);
    }

    /** Remove rows that were cascaded from a parent share (inherited_from = root). */
    static async clearInheritedFrom(rootItemId, userId) {
        const rootId = Number(rootItemId);
        const uid = Number(userId);
        if (!Number.isFinite(rootId) || !Number.isFinite(uid)) return 0;
        const result = await pool.query(
            `
            DELETE FROM file_manager_permissions
            WHERE user_id = $2
              AND inherited_from_item_id = $1
            RETURNING id
            `,
            [rootId, uid],
        );
        return result.rowCount || 0;
    }

    /**
     * is_childshare=false: remove this user's permission on every descendant
     * (cascaded or leftover), so children are not shared.
     */
    static async clearAllChildSharesForUser(rootItemId, userId) {
        const rootId = Number(rootItemId);
        const uid = Number(userId);
        if (!Number.isFinite(rootId) || !Number.isFinite(uid)) return 0;
        const ids = await FileManagerPermissionModel.listCascadeItemIds(rootId);
        const childIds = ids.filter((id) => id !== rootId);
        if (!childIds.length) {
            return FileManagerPermissionModel.clearInheritedFrom(rootId, uid);
        }
        const result = await pool.query(
            `
            DELETE FROM file_manager_permissions
            WHERE user_id = $2
              AND (
                    inherited_from_item_id = $1
                 OR item_id = ANY($3::bigint[])
              )
            RETURNING id
            `,
            [rootId, uid, childIds],
        );
        return result.rowCount || 0;
    }

    /**
     * Upsert role on a folder/file.
     * is_childshare=true  → apply the same role to children that do not
     *   already have their own share (inherited rows, or rows with
     *   is_childshare=true). A direct child share (for example editor on
     *   one folder) is left unchanged.
     * is_childshare=false → share this item only. Existing child
     *   permissions are not updated or removed.
     */
    static async upsertUser({
        item_id,
        user_id,
        username,
        role,
        assigned_by_username,
        expected_scope = null,
        cascade = null,
        is_childshare = null,
        inherited_from_item_id = null,
    }) {
        const item = await FileManagerPermissionModel.assertItem(
            item_id,
            expected_scope,
            { foldersOnly: false },
        );
        const itemScope = String(item.scope || '')
            .trim()
            .toLowerCase();
        // Project root and financial-year folders copy their role onto
        // every child when child share is on. Other folders keep a child's
        // own direct share.
        const forceSameChildRole =
            itemScope === 'financial_year' ||
            (itemScope === 'project' && item.scope_root_id == null);

        const normalizedRole = normalizePermissionRole(
            role,
            PERMISSION_ROLES.VIEWER,
        );
        const rootId = Number(item_id);
        const uid = Number(user_id);
        const uname = String(username).trim();
        const assignedBy =
            String(assigned_by_username || '').trim() || 'system';
        const inheritedFrom =
            inherited_from_item_id != null
                ? Number(inherited_from_item_id)
                : null;
        // Inherited child rows never cascade further; direct shares honor is_childshare
        const childShare =
            inheritedFrom != null
                ? false
                : parseIsChildShare(
                      is_childshare != null ? is_childshare : cascade,
                      true,
                  );

        const result = await pool.query(
            `
            INSERT INTO file_manager_permissions (
                item_id,
                user_id,
                username,
                role,
                assigned_by_username,
                inherited_from_item_id,
                is_childshare
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (item_id, user_id)
            DO UPDATE SET
                username = EXCLUDED.username,
                role = EXCLUDED.role,
                assigned_by_username = EXCLUDED.assigned_by_username,
                inherited_from_item_id = EXCLUDED.inherited_from_item_id,
                is_childshare = EXCLUDED.is_childshare,
                assigned_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
            RETURNING *
            `,
            [
                rootId,
                uid,
                uname,
                normalizedRole,
                assignedBy,
                inheritedFrom,
                childShare,
            ],
        );
        const rootRow = withRoleCapabilities(result.rows[0]);

        if (inheritedFrom == null && childShare) {
            const ids = await FileManagerPermissionModel.listCascadeItemIds(
                rootId,
            );
            const childIds = ids.filter((id) => id !== rootId);
            if (childIds.length) {
                await pool.query(
                    `
                    INSERT INTO file_manager_permissions (
                        item_id,
                        user_id,
                        username,
                        role,
                        assigned_by_username,
                        inherited_from_item_id,
                        is_childshare
                    )
                    SELECT
                        x.item_id,
                        $2::bigint,
                        $3::varchar,
                        $4::varchar,
                        $5::varchar,
                        $1::bigint,
                        FALSE
                    FROM unnest($6::bigint[]) AS x(item_id)
                    ON CONFLICT (item_id, user_id)
                    DO UPDATE SET
                        username = EXCLUDED.username,
                        role = EXCLUDED.role,
                        assigned_by_username = EXCLUDED.assigned_by_username,
                        inherited_from_item_id = EXCLUDED.inherited_from_item_id,
                        is_childshare = FALSE,
                        assigned_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
                    WHERE $7::boolean = TRUE
                       OR file_manager_permissions.inherited_from_item_id IS NOT NULL
                       OR file_manager_permissions.is_childshare = TRUE
                    `,
                    [
                        rootId,
                        uid,
                        uname,
                        normalizedRole,
                        assignedBy,
                        childIds,
                        forceSameChildRole,
                    ],
                );
            }
        }
        // is_childshare=false: this item only. Do not delete or rewrite
        // permissions already saved on child folders/files.

        return rootRow;
    }

    /**
     * Copy parent permissions onto a new child only when parent share
     * has is_childshare=true (or the parent row itself was inherited).
     */
    static async inheritFromParent(newItemId, parentId) {
        const childId = Number(newItemId);
        const pid = Number(parentId);
        if (
            !Number.isFinite(childId) ||
            childId <= 0 ||
            !Number.isFinite(pid) ||
            pid <= 0
        ) {
            return [];
        }
        const result = await pool.query(
            `
            INSERT INTO file_manager_permissions (
                item_id,
                user_id,
                username,
                role,
                assigned_by_username,
                inherited_from_item_id,
                is_childshare
            )
            SELECT
                $1::bigint,
                p.user_id,
                p.username,
                p.role,
                p.assigned_by_username,
                COALESCE(p.inherited_from_item_id, p.item_id),
                FALSE
            FROM file_manager_permissions p
            WHERE p.item_id = $2
              AND (
                    p.is_childshare = TRUE
                 OR p.inherited_from_item_id IS NOT NULL
              )
            ON CONFLICT (item_id, user_id)
            DO UPDATE SET
                username = EXCLUDED.username,
                role = EXCLUDED.role,
                assigned_by_username = EXCLUDED.assigned_by_username,
                inherited_from_item_id = EXCLUDED.inherited_from_item_id,
                is_childshare = FALSE,
                assigned_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
            RETURNING *
            `,
            [childId, pid],
        );
        return result.rows.map(withRoleCapabilities);
    }

    static async updateUserPermissions(itemId, userId, fields = {}) {
        const current = await FileManagerPermissionModel.findUser(
            itemId,
            userId,
        );
        if (!current) return null;

        const nextRole =
            fields.role != null && String(fields.role).trim() !== ''
                ? normalizePermissionRole(fields.role, PERMISSION_ROLES.VIEWER)
                : current.role;
        const nextUsername =
            fields.username != null
                ? String(fields.username).trim()
                : current.username;
        const nextChildShare =
            fields.is_childshare != null
                ? parseIsChildShare(fields.is_childshare, current.is_childshare)
                : Boolean(current.is_childshare);

        // Re-use upsert so cascade / clearInherited stay consistent
        return FileManagerPermissionModel.upsertUser({
            item_id: itemId,
            user_id: userId,
            username: nextUsername,
            role: nextRole,
            assigned_by_username: current.assigned_by_username || 'system',
            is_childshare: nextChildShare,
            inherited_from_item_id: current.inherited_from_item_id,
        });
    }

    static async removeUser(itemId, userId, { cascade = true } = {}) {
        const rootId = Number(itemId);
        const uid = Number(userId);

        if (!cascade) {
            const result = await pool.query(
                `
                DELETE FROM file_manager_permissions
                WHERE item_id = $1
                  AND user_id = $2
                RETURNING *
                `,
                [rootId, uid],
            );
            return withRoleCapabilities(result.rows[0] || null);
        }

        const result = await pool.query(
            `
            DELETE FROM file_manager_permissions
            WHERE user_id = $2
              AND (
                    item_id = $1
                 OR inherited_from_item_id = $1
                 OR item_id = ANY(
                        SELECT id FROM (
                            WITH RECURSIVE tree AS (
                                SELECT id FROM file_manager_items
                                WHERE id = $1
                                  AND is_deleted = FALSE
                                UNION ALL
                                SELECT c.id
                                FROM file_manager_items c
                                INNER JOIN tree t ON c.parent_id = t.id
                                WHERE c.is_deleted = FALSE
                            )
                            SELECT id FROM tree
                        ) d
                 )
              )
            RETURNING *
            `,
            [rootId, uid],
        );
        const root = result.rows.find((r) => Number(r.item_id) === rootId);
        return withRoleCapabilities(root || result.rows[0] || null);
    }

    /**
     * Direct shares only (inherited_from_item_id IS NULL) for Shared with me.
     * Owned items are excluded when include_owned is false.
     */
    static async findDirectShares({
        userId = null,
        username = null,
        include_owned = false,
        scope = null,
    } = {}) {
        const params = [];
        const where = [
            `LOWER(COALESCE(u.role, 'viewer')) IN ('owner', 'editor', 'viewer')`,
            `u.inherited_from_item_id IS NULL`,
            `f.is_deleted = FALSE`,
            // Keep directly shared descendants under any shared ancestor.
            `(
                f.parent_id IS NULL
                OR NOT EXISTS (
                    WITH RECURSIVE shared_ancestors AS (
                        SELECT ancestor.id, ancestor.parent_id
                        FROM file_manager_items ancestor
                        WHERE ancestor.id = f.parent_id
                          AND ancestor.is_deleted = FALSE
                        UNION
                        SELECT ancestor.id, ancestor.parent_id
                        FROM file_manager_items ancestor
                        INNER JOIN shared_ancestors
                            ON ancestor.id = shared_ancestors.parent_id
                        WHERE ancestor.is_deleted = FALSE
                    )
                    SELECT 1
                    FROM shared_ancestors
                    INNER JOIN file_manager_permissions p
                        ON p.item_id = shared_ancestors.id
                    WHERE p.inherited_from_item_id IS NULL
                      AND LOWER(COALESCE(p.role, '')) IN ('owner', 'editor', 'viewer')
                      AND (
                            p.user_id = u.user_id
                         OR LOWER(TRIM(p.username)) = LOWER(TRIM(u.username))
                      )
                )
            )`,
        ];

        const uname = String(username || '').trim();
        const uid = userId != null ? Number(userId) : null;

        if (uname && uid && Number.isFinite(uid) && uid > 0) {
            params.push(uname);
            params.push(uid);
            where.push(
                `(LOWER(TRIM(u.username)) = LOWER(TRIM($${params.length - 1})) OR u.user_id = $${params.length})`,
            );
        } else if (uname) {
            params.push(uname);
            where.push(
                `LOWER(TRIM(u.username)) = LOWER(TRIM($${params.length}))`,
            );
        } else if (uid && Number.isFinite(uid) && uid > 0) {
            params.push(uid);
            where.push(`u.user_id = $${params.length}`);
        } else {
            return [];
        }

        if (scope) {
            params.push(String(scope).trim());
            where.push(`f.scope = $${params.length}`);
        }

        if (!include_owned) {
            if (uid && Number.isFinite(uid) && uid > 0) {
                params.push(uid);
                where.push(
                    `(f.owner_id IS NULL OR f.owner_id IS DISTINCT FROM $${params.length})`,
                );
            }
            if (uname) {
                params.push(uname);
                where.push(
                    `(f.username IS NULL OR LOWER(TRIM(f.username)) IS DISTINCT FROM LOWER(TRIM($${params.length})))`,
                );
                params.push(uname);
                where.push(
                    `(u.assigned_by_username IS NULL OR LOWER(TRIM(u.assigned_by_username)) IS DISTINCT FROM LOWER(TRIM($${params.length})))`,
                );
            }
        }

        const result = await pool.query(
            `
            SELECT
                f.*,
                f.name AS folder_name,
                u.id AS share_id,
                u.user_id AS access_user_id,
                u.username AS access_username,
                u.role,
                u.assigned_by_username,
                u.assigned_at,
                u.inherited_from_item_id,
                CASE
                    WHEN LOWER(COALESCE(u.role, '')) = 'owner' THEN TRUE
                    ELSE FALSE
                END AS is_owner,
                COALESCE(f.scope, 'file_manager') AS share_type
            FROM file_manager_permissions u
            INNER JOIN file_manager_items f
                ON f.id = u.item_id
            WHERE ${where.join(' AND ')}
            ORDER BY u.assigned_at DESC NULLS LAST, f.updated_at DESC NULLS LAST, f.id DESC
            `,
            params,
        );
        return result.rows;
    }
}

export default FileManagerPermissionModel;
