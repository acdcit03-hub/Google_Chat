import { pool } from '../../config/db.js';
import FileManagerPermissionModel from './fileManagerPermission.model.js';
import FileManagerSettingModel from './fileManagerSetting.model.js';
import { FILE_MANAGER_SCOPES } from './fileManagerScopes.js';
import { generatePublicId } from '../../utils/fileManagerPublicId.js';
import {
    ensureFinancialYearFolderByCode,
    ensureFinancialYearFolders,
    getProjectFileManagerRootPath,
} from './financialYearFileManager.model.js';

/* Re-export FY folder helpers from dedicated financial-year file manager model. */
export {
    getProjectFileManagerRootPath,
    ensureFinancialYearFolders,
    ensureFinancialYearFolderByCode,
};

const PROJECT_SCOPE = FILE_MANAGER_SCOPES.PROJECT;

/**
 * Project root rows (one per project).
 * parent_id = financial_year folder id (not null) — only personal + FY are roots.
 */
const PROJECT_ROOT_WHERE = `
    f.scope = '${PROJECT_SCOPE}'
    AND f.scope_root_id IS NULL
    AND f.is_deleted = FALSE
`;

async function resolveFinancialYearParentId(financialYear) {
    const year = String(financialYear || '').trim();
    if (!year) return null;
    const result = await pool.query(
        `
        SELECT id
        FROM file_manager_items
        WHERE scope = $1
          AND parent_id IS NULL
          AND scope_root_id IS NULL
          AND is_deleted = FALSE
          AND LOWER(TRIM(COALESCE(year_code, financial_year, ''))) = LOWER(TRIM($2))
        ORDER BY id ASC
        LIMIT 1
        `,
        [FILE_MANAGER_SCOPES.FINANCIAL_YEAR, year],
    );
    return result.rows[0]?.id != null ? Number(result.rows[0].id) : null;
}

const PROJECT_FOLDER_SELECT = `
    f.id,
    f.public_id,
    f.parent_id,
    f.project_id,
    f.project_code,
    f.financial_year,
    f.category_id,
    f.category_name,
    f.name AS folder_name,
    f.name,
    f.item_type,
    f.storage_name,
    f.mime_type,
    f.extension,
    f.size,
    f.relative_path,
    f.absolute_path,
    f.google_drive_folder_id,
    f.owner_id,
    f.username,
    f.created_by,
    f.updated_by,
    f.created_at,
    f.updated_at,
    f.scope,
    f.filemanager_path
`;

const PROJECT_ITEM_SELECT = `
    i.id,
    i.public_id,
    i.scope_root_id AS project_folder_id,
    i.parent_id,
    i.template_id,
    i.name AS folder_name,
    i.name,
    i.relative_path,
    i.absolute_path,
    i.google_drive_folder_id,
    i.item_type,
    i.display_order,
    i.is_active,
    i.google_file_id,
    COALESCE(i.google_sheet_url, i.url) AS google_sheet_url,
    i.url,
    i.pcb_code,
    i.project_pcb_code,
    i.owner_id,
    i.username,
    i.created_by,
    i.updated_by,
    i.storage_name,
    i.mime_type,
    i.extension,
    i.size,
    i.file_source,
    i.created_at,
    i.updated_at,
    i.scope,
    i.scope_root_id,
    i.project_id,
    i.project_code,
    i.financial_year
`;

/* Legacy init — tables dropped; unified schema owns DDL. */
export const initializeProjectFileManagerTables = async () => {
    try {
        // 1) Project roots → parent_id = matching financial_year folder
        await pool.query(`
            UPDATE file_manager_items p
            SET parent_id = fy.id,
                updated_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
            FROM file_manager_items fy
            WHERE p.scope = '${PROJECT_SCOPE}'
              AND p.scope_root_id IS NULL
              AND p.is_deleted = FALSE
              AND fy.scope = '${FILE_MANAGER_SCOPES.FINANCIAL_YEAR}'
              AND fy.parent_id IS NULL
              AND fy.scope_root_id IS NULL
              AND fy.is_deleted = FALSE
              AND LOWER(TRIM(COALESCE(fy.year_code, fy.financial_year, '')))
                  = LOWER(TRIM(COALESCE(p.financial_year, '')))
              AND (
                    p.parent_id IS NULL
                 OR p.parent_id IS DISTINCT FROM fy.id
              )
        `);

        // 2) Nested project items with null parent_id → parent = project root
        await pool.query(`
            UPDATE file_manager_items
            SET parent_id = scope_root_id,
                updated_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
            WHERE scope = '${PROJECT_SCOPE}'
              AND scope_root_id IS NOT NULL
              AND parent_id IS NULL
              AND is_deleted = FALSE
        `);
    } catch (err) {
        console.warn(
            '⚠️ Could not normalize project parent_id hierarchy:',
            err.message,
        );
    }
};

function toBool(value, fallback = false) {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    const s = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
    if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
    return fallback;
}

function diskPathKey(value) {
    return String(value || '')
        .replace(/\\/g, '/')
        .trim()
        .toLowerCase();
}

function isGoogleShortcutRow(row) {
    const source = String(row?.file_source || '')
        .trim()
        .toLowerCase();
    return (
        source === 'google_sheet' ||
        source === 'google_doc' ||
        source === 'google_docs' ||
        source === 'gsheet' ||
        source === 'gdocs' ||
        source === 'gdoc'
    );
}

/**
 * One physical shortcut must be one row. Disk sync also inserts Name.url
 * beside the Google Sheet/Doc row that already points at that path.
 * Keep the Google row and hide the local copy.
 */
function collapseSameDiskFile(rows) {
    const groups = new Map();
    const alone = [];
    for (const row of rows || []) {
        const key = diskPathKey(row?.absolute_path);
        if (!key) {
            alone.push(row);
            continue;
        }
        const list = groups.get(key) || [];
        list.push(row);
        groups.set(key, list);
    }

    const kept = [...alone];
    const hiddenIds = [];
    for (const list of groups.values()) {
        if (list.length < 2) {
            kept.push(list[0]);
            continue;
        }
        const google = list.find(isGoogleShortcutRow);
        const winner = google || list[0];
        kept.push(winner);
        for (const row of list) {
            if (Number(row.id) !== Number(winner.id)) {
                hiddenIds.push(Number(row.id));
            }
        }
    }

    kept.sort((a, b) => {
        const aFolder =
            String(a.item_type || '').toLowerCase() === 'folder' ? 0 : 1;
        const bFolder =
            String(b.item_type || '').toLowerCase() === 'folder' ? 0 : 1;
        if (aFolder !== bFolder) return aFolder - bFolder;
        return Number(a.id) - Number(b.id);
    });
    return { rows: kept, hiddenIds };
}

class ProjectFileManagerModel {
    /* ---------- project folders (scope=project roots) ---------- */

    static async findAll({ financial_year = null, search = null } = {}) {
        const params = [];
        const where = [PROJECT_ROOT_WHERE.trim()];

        if (financial_year) {
            params.push(String(financial_year).trim());
            where.push(`f.financial_year = $${params.length}`);
        }
        if (search) {
            params.push(`%${String(search).trim().toLowerCase()}%`);
            where.push(`LOWER(f.project_code) LIKE $${params.length}`);
        }

        const result = await pool.query(
            `
            SELECT ${PROJECT_FOLDER_SELECT}
            FROM file_manager_items f
            WHERE ${where.join(' AND ')}
            ORDER BY f.updated_at DESC, f.id DESC
            `,
            params,
        );
        return result.rows;
    }

    static async findById(id) {
        const result = await pool.query(
            `
            SELECT ${PROJECT_FOLDER_SELECT}
            FROM file_manager_items f
            WHERE f.id = $1
              AND ${PROJECT_ROOT_WHERE}
            `,
            [id],
        );
        return result.rows[0] || null;
    }

    /** Project roots directly under a financial-year folder (parent_id = fy folder id). */
    static async listRootsByParentId(parentId) {
        const pid = Number(parentId);
        if (!Number.isFinite(pid) || pid <= 0) return [];
        const result = await pool.query(
            `
            SELECT ${PROJECT_FOLDER_SELECT}
            FROM file_manager_items f
            WHERE f.parent_id = $1
              AND ${PROJECT_ROOT_WHERE}
            ORDER BY f.name ASC, f.id ASC
            `,
            [pid],
        );
        return result.rows;
    }

    static async findByProjectId(projectId) {
        const result = await pool.query(
            `
            SELECT ${PROJECT_FOLDER_SELECT}
            FROM file_manager_items f
            WHERE f.project_id = $1
              AND ${PROJECT_ROOT_WHERE}
            LIMIT 1
            `,
            [projectId],
        );
        return result.rows[0] || null;
    }

    static async findByProjectCode(projectCode) {
        const code = String(projectCode || '').trim();
        if (!code) return null;
        const result = await pool.query(
            `
            SELECT ${PROJECT_FOLDER_SELECT}
            FROM file_manager_items f
            WHERE LOWER(TRIM(f.project_code)) = LOWER(TRIM($1))
              AND ${PROJECT_ROOT_WHERE}
            ORDER BY f.id DESC
            LIMIT 1
            `,
            [code],
        );
        return result.rows[0] || null;
    }

    static async create({
        project_id,
        project_code,
        financial_year,
        category_id = null,
        category_name = null,
        folder_name,
        relative_path,
        absolute_path,
        owner_id = null,
        username = null,
        parent_id = null,
        google_drive_folder_id = null,
    }) {
        const name = String(folder_name).trim();
        const uname = username != null ? String(username).trim() || null : null;
        const actor = uname || 'system';
        const absPath = String(absolute_path).trim();
        const fyCode = String(financial_year).trim();
        const fyParentId =
            parent_id != null
                ? Number(parent_id)
                : await resolveFinancialYearParentId(fyCode);

        if (!fyParentId || !Number.isFinite(fyParentId)) {
            const err = new Error(
                `Financial year folder not found for ${fyCode}. Ensure FY folders exist first.`,
            );
            err.status = 400;
            throw err;
        }

        const result = await pool.query(
            `
            INSERT INTO file_manager_items (
                owner_id,
                username,
                parent_id,
                name,
                item_type,
                relative_path,
                absolute_path,
                google_drive_folder_id,
                filemanager_path,
                created_by,
                updated_by,
                scope,
                scope_root_id,
                project_id,
                project_code,
                financial_year,
                category_id,
                category_name,
                is_active,
                public_id
            ) VALUES (
                $1, $2, $3, $4, 'folder',
                $5, $6, $7, $8,
                $9, $10,
                $11, NULL,
                $12, $13, $14,
                $15, $16, TRUE,
                $17
            )
            RETURNING
                id, public_id, project_id, project_code, financial_year,
                category_id, category_name, parent_id,
                name AS folder_name, name, relative_path, absolute_path,
                owner_id, username, created_at, updated_at, scope,
                google_drive_folder_id
            `,
            [
                owner_id != null ? Number(owner_id) : null,
                uname,
                fyParentId,
                name,
                String(relative_path).trim(),
                absPath,
                google_drive_folder_id,
                getProjectFileManagerRootPath(),
                actor,
                actor,
                PROJECT_SCOPE,
                project_id != null && Number.isFinite(Number(project_id))
                    ? Number(project_id)
                    : null,
                String(project_code).trim(),
                fyCode,
                category_id != null ? Number(category_id) : null,
                category_name != null ? String(category_name).trim() : null,
                generatePublicId(),
            ],
        );
        const created = result.rows[0];
        if (created?.id && fyParentId) {
            try {
                await FileManagerPermissionModel.inheritFromParent(
                    created.id,
                    fyParentId,
                );
            } catch (err) {
                console.warn(
                    '⚠️ Could not inherit project root permissions:',
                    err?.message || err,
                );
            }
        }
        return created;
    }

    static async update(id, fields = {}) {
        const columnMap = {
            project_code: 'project_code',
            financial_year: 'financial_year',
            category_id: 'category_id',
            category_name: 'category_name',
            folder_name: 'name',
            relative_path: 'relative_path',
            absolute_path: 'absolute_path',
            owner_id: 'owner_id',
            username: 'username',
            google_drive_folder_id: 'google_drive_folder_id',
        };
        const sets = [];
        const params = [];

        for (const [key, column] of Object.entries(columnMap)) {
            if (
                Object.prototype.hasOwnProperty.call(fields, key) &&
                fields[key] !== undefined
            ) {
                let value = fields[key];
                if (key === 'category_id' || key === 'owner_id') {
                    value = value == null ? null : Number(value);
                } else if (value != null) {
                    value = String(value).trim();
                }
                params.push(value);
                sets.push(`${column} = $${params.length}`);
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
            UPDATE file_manager_items f
            SET ${sets.join(', ')}
            WHERE f.id = $${params.length}
              AND ${PROJECT_ROOT_WHERE}
            RETURNING
                f.id, f.project_id, f.project_code, f.financial_year,
                f.category_id, f.category_name,
                f.name AS folder_name, f.name, f.relative_path, f.absolute_path,
                f.owner_id, f.username, f.created_at, f.updated_at, f.scope,
                f.google_drive_folder_id
            `,
            params,
        );
        return result.rows[0] || null;
    }

    /**
     * Apply File Manager Settings owners onto a project root
     * (row owner_id/username + permission role=owner).
     */
    static async applyFileManagerOwners(
        projectFolderId,
        assignedByUsername = 'system',
    ) {
        const id = Number(projectFolderId);
        if (!Number.isFinite(id) || id <= 0) {
            return { owners: [], entry: null };
        }

        const settingsOwners =
            await FileManagerSettingModel.findActiveOwners();
        const owners = (settingsOwners || []).filter(
            (o) => o.status !== false,
        );
        if (!owners.length) {
            return {
                owners: [],
                entry: await ProjectFileManagerModel.findById(id),
            };
        }

        const accessOwners = owners.filter((o) => Boolean(o.access));
        const primaryOwners = accessOwners.length ? accessOwners : owners;
        const primary = primaryOwners[0];
        const primaryOwnerId = Number(primary.owner_id);
        const primaryUsername = String(primary.username || '').trim();

        if (primaryOwnerId && primaryUsername) {
            await pool.query(
                `
                UPDATE file_manager_items
                SET owner_id = $1,
                    username = $2,
                    updated_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
                WHERE id = $3
                  AND scope = '${PROJECT_SCOPE}'
                  AND scope_root_id IS NULL
                  AND is_deleted = FALSE
                `,
                [primaryOwnerId, primaryUsername, id],
            );
        }

        const assignedBy =
            String(assignedByUsername || '').trim() || 'system';

        for (const owner of owners) {
            const oid = Number(owner.owner_id);
            const uname = String(owner.username || '').trim();
            if (!oid || !uname) continue;
            await ProjectFileManagerModel.upsertUser({
                project_folder_id: id,
                user_id: oid,
                username: uname,
                role: 'owner',
                assigned_by_username: assignedBy,
                is_childshare: true,
            });
        }

        return {
            owners,
            entry: await ProjectFileManagerModel.findById(id),
        };
    }

    /** Apply settings owners to every project root row. */
    static async applyFileManagerOwnersToAll(
        assignedByUsername = 'system',
    ) {
        const folders = await ProjectFileManagerModel.findAll();
        const results = [];
        for (const folder of folders || []) {
            const synced =
                await ProjectFileManagerModel.applyFileManagerOwners(
                    folder.id,
                    assignedByUsername,
                );
            results.push({
                project_folder_id: folder.id,
                project_code: folder.project_code,
                owner_id: synced.entry?.owner_id ?? null,
                username: synced.entry?.username ?? null,
                owners_count: (synced.owners || []).length,
            });
        }
        return results;
    }

    static async delete(id) {
        const result = await pool.query(
            `
            DELETE FROM file_manager_items f
            WHERE f.id = $1
              AND ${PROJECT_ROOT_WHERE}
            RETURNING
                f.id, f.project_id, f.project_code, f.financial_year,
                f.name AS folder_name, f.relative_path, f.absolute_path
            `,
            [id],
        );
        return result.rows[0] || null;
    }

    /* ---------- project items (children under project root) ---------- */

    static async listItems(projectFolderId) {
        const result = await pool.query(
            `
            SELECT ${PROJECT_ITEM_SELECT}
            FROM file_manager_items i
            WHERE i.scope = $2
              AND i.scope_root_id = $1
              AND i.is_deleted = FALSE
            ORDER BY i.display_order ASC, i.id ASC
            `,
            [Number(projectFolderId), PROJECT_SCOPE],
        );
        return result.rows;
    }

    static async listRootItems(projectFolderId) {
        const rootId = Number(projectFolderId);
        const result = await pool.query(
            `
            SELECT ${PROJECT_ITEM_SELECT}
            FROM file_manager_items i
            WHERE i.scope = $2
              AND i.scope_root_id = $1
              AND i.parent_id = $1
              AND i.is_deleted = FALSE
            ORDER BY i.display_order ASC, i.id ASC
            `,
            [rootId, PROJECT_SCOPE],
        );
        return result.rows;
    }

    static async listChildrenItems(projectFolderId, parentId = null) {
        const rootId = Number(projectFolderId);
        const effectiveParent =
            parentId != null ? Number(parentId) : rootId;
        const root = await this.findById(rootId);

        // Google docs/sheets created in a shared project folder were saved
        // with the personal scope. Attach them to this project so
        // item_type=file still returns them after a refresh.
        if (root) {
            await pool.query(
                `
                UPDATE file_manager_items
                SET
                    scope = $3,
                    scope_root_id = $1,
                    project_id = COALESCE(project_id, $4),
                    project_code = COALESCE(project_code, $5),
                    financial_year = COALESCE(financial_year, $6),
                    updated_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
                WHERE is_deleted = FALSE
                  AND parent_id = $2
                  AND id <> $1
                  AND (
                        scope IS DISTINCT FROM $3
                     OR scope_root_id IS DISTINCT FROM $1
                  )
                `,
                [
                    rootId,
                    effectiveParent,
                    PROJECT_SCOPE,
                    root.project_id ?? null,
                    root.project_code ?? null,
                    root.financial_year ?? null,
                ],
            );
        }

        const result = await pool.query(
            `
            SELECT ${PROJECT_ITEM_SELECT}
            FROM file_manager_items i
            WHERE i.is_deleted = FALSE
              AND i.parent_id = $2
              AND i.id <> $1
            ORDER BY
                CASE WHEN LOWER(COALESCE(i.item_type, 'folder')) = 'folder'
                    THEN 0 ELSE 1 END,
                i.display_order ASC,
                i.id ASC
            `,
            [rootId, effectiveParent],
        );
        const { rows, hiddenIds } = collapseSameDiskFile(result.rows);
        if (hiddenIds.length) {
            await pool.query(
                `
                UPDATE file_manager_items
                SET
                    is_deleted = TRUE,
                    deleted_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP),
                    deleted_by = 'shortcut-dedupe'
                WHERE id = ANY($1::bigint[])
                  AND is_deleted = FALSE
                `,
                [hiddenIds],
            );
        }
        return rows;
    }

    static async findItemById(itemId) {
        const id = Number(itemId);
        if (!Number.isFinite(id) || id <= 0) return null;
        const result = await pool.query(
            `
            SELECT ${PROJECT_ITEM_SELECT}
            FROM file_manager_items i
            WHERE i.id = $1
              AND i.scope = $2
              AND i.scope_root_id IS NOT NULL
              AND i.is_deleted = FALSE
            `,
            [id, PROJECT_SCOPE],
        );
        return result.rows[0] || null;
    }

    static async updateItemGoogleDriveFolderId(itemId, googleDriveFolderId) {
        const id = Number(itemId);
        const folderId = String(googleDriveFolderId || '').trim();
        if (!Number.isFinite(id) || id <= 0 || !folderId) return null;

        const result = await pool.query(
            `
            UPDATE file_manager_items AS i
            SET google_drive_folder_id = $1,
                updated_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
            WHERE i.id = $2
              AND i.scope = $3
              AND i.scope_root_id IS NOT NULL
              AND i.is_deleted = FALSE
            RETURNING ${PROJECT_ITEM_SELECT}
            `,
            [folderId, id, PROJECT_SCOPE],
        );
        return result.rows[0] || null;
    }

    static async findItemByParentAndName(
        projectFolderId,
        parentId,
        folderName,
    ) {
        const name = String(folderName || '').trim();
        if (!name || !projectFolderId) return null;

        const rootId = Number(projectFolderId);
        const effectiveParent =
            parentId != null ? Number(parentId) : rootId;
        const result = await pool.query(
            `
            SELECT ${PROJECT_ITEM_SELECT}
            FROM file_manager_items i
            WHERE i.scope = $4
              AND i.scope_root_id = $1
              AND i.parent_id = $2
              AND LOWER(TRIM(i.name)) = LOWER(TRIM($3))
              AND i.is_deleted = FALSE
            LIMIT 1
            `,
            [rootId, effectiveParent, name, PROJECT_SCOPE],
        );
        return result.rows[0] || null;
    }

    /** Match a disk file to the Google shortcut row that already points at it. */
    static async findItemByParentAndDiskName(
        projectFolderId,
        parentId,
        diskName,
        absolutePath = null,
    ) {
        const byName = await this.findItemByParentAndName(
            projectFolderId,
            parentId,
            diskName,
        );
        if (byName) return byName;

        const raw = String(diskName || '').trim();
        const bare = raw.toLowerCase().endsWith('.url')
            ? raw.slice(0, -4)
            : raw;
        if (bare && bare.toLowerCase() !== raw.toLowerCase()) {
            const shortcut = await this.findItemByParentAndName(
                projectFolderId,
                parentId,
                bare,
            );
            if (shortcut) return shortcut;
        }

        const abs = String(absolutePath || '').trim();
        if (!abs) return null;
        const rootId = Number(projectFolderId);
        const effectiveParent =
            parentId != null ? Number(parentId) : rootId;
        const result = await pool.query(
            `
            SELECT ${PROJECT_ITEM_SELECT}
            FROM file_manager_items i
            WHERE i.is_deleted = FALSE
              AND i.parent_id = $2
              AND i.id <> $1
              AND LOWER(REPLACE(COALESCE(i.absolute_path, ''), '\\', '/'))
                  = LOWER(REPLACE($3, '\\', '/'))
            LIMIT 1
            `,
            [rootId, effectiveParent, abs],
        );
        return result.rows[0] || null;
    }

    static async findItemByGoogleFileId(googleFileId) {
        const gid = String(googleFileId || '').trim();
        if (!gid) return null;
        const result = await pool.query(
            `
            SELECT
                ${PROJECT_ITEM_SELECT},
                f.project_code,
                f.owner_id,
                f.username AS folder_username
            FROM file_manager_items i
            INNER JOIN file_manager_items f
                ON f.id = i.scope_root_id
               AND f.scope = $2
               AND f.scope_root_id IS NULL
            WHERE i.google_file_id = $1
              AND i.scope = $2
              AND i.is_deleted = FALSE
            ORDER BY i.id DESC
            LIMIT 1
            `,
            [gid, PROJECT_SCOPE],
        );
        return result.rows[0] || null;
    }

    static async createItem({
        project_folder_id,
        parent_id = null,
        template_id = null,
        folder_name,
        relative_path,
        absolute_path,
        item_type = 'folder',
        display_order = 0,
        is_active = true,
        google_file_id = null,
        google_drive_folder_id = null,
        google_sheet_url = null,
        pcb_code = null,
        project_pcb_code = null,
        file_source = null,
        // Editor uploads: keep settings/root owner; stamp actor as created_by
        created_by = null,
        updated_by = null,
        owner_id = null,
        username = null,
    }) {
        const root = await this.findById(project_folder_id);
        if (!root) {
            const err = new Error('Project file manager folder not found');
            err.status = 404;
            throw err;
        }

        const type = String(item_type || 'folder')
            .trim()
            .toLowerCase();
        const sheetUrl =
            google_sheet_url != null
                ? String(google_sheet_url).trim() || null
                : null;
        // Item owner = settings/project root owner (never the uploading editor)
        const ownerUsername =
            username != null && String(username).trim()
                ? String(username).trim()
                : root.username != null
                  ? String(root.username).trim() || null
                  : null;
        const ownerId =
            owner_id != null && Number.isFinite(Number(owner_id))
                ? Number(owner_id)
                : root.owner_id ?? null;
        const createdBy =
            String(created_by || '').trim() || ownerUsername || 'system';
        const updatedBy =
            String(updated_by || created_by || '').trim() ||
            ownerUsername ||
            'system';
        const explicitSource = String(file_source || '')
            .trim()
            .toLowerCase();
        const fileSource = explicitSource
            ? explicitSource
            : type.startsWith('google_')
              ? type
              : google_file_id
                ? 'gsheet'
                : 'local';
        // Root-level project children use parent_id = project root id (not null)
        const effectiveParentId =
            parent_id != null
                ? Number(parent_id)
                : Number(project_folder_id);

        const result = await pool.query(
            `
            INSERT INTO file_manager_items (
                owner_id,
                username,
                parent_id,
                name,
                item_type,
                relative_path,
                absolute_path,
                google_drive_folder_id,
                filemanager_path,
                created_by,
                updated_by,
                scope,
                scope_root_id,
                project_id,
                project_code,
                financial_year,
                template_id,
                display_order,
                is_active,
                google_file_id,
                google_sheet_url,
                url,
                pcb_code,
                project_pcb_code,
                file_source,
                public_id
            ) VALUES (
                $1, $2, $3, $4, $5,
                $6, $7, $8, $9,
                $10, $11,
                $12, $13,
                $14, $15, $16,
                $17, $18, $19,
                $20, $21, $22,
                $23, $24,
                $25, $26
            )
            RETURNING
                id,
                public_id,
                scope_root_id AS project_folder_id,
                parent_id,
                template_id,
                name AS folder_name,
                name,
                relative_path,
                absolute_path,
                item_type,
                display_order,
                is_active,
                google_drive_folder_id,
                google_file_id,
                COALESCE(google_sheet_url, url) AS google_sheet_url,
                pcb_code,
                project_pcb_code,
                owner_id,
                username,
                created_by,
                updated_by,
                created_at,
                updated_at
            `,
            [
                ownerId,
                ownerUsername,
                effectiveParentId,
                String(folder_name).trim(),
                type,
                String(relative_path).trim(),
                String(absolute_path).trim(),
                google_drive_folder_id != null
                    ? String(google_drive_folder_id).trim() || null
                    : root.google_drive_folder_id ?? null,
                getProjectFileManagerRootPath(),
                createdBy,
                updatedBy,
                PROJECT_SCOPE,
                Number(project_folder_id),
                root.project_id ?? null,
                root.project_code ?? null,
                root.financial_year ?? null,
                template_id != null ? Number(template_id) : null,
                Number(display_order) || 0,
                toBool(is_active, true),
                google_file_id != null
                    ? String(google_file_id).trim() || null
                    : null,
                sheetUrl,
                sheetUrl,
                pcb_code != null ? String(pcb_code).trim() || null : null,
                project_pcb_code != null
                    ? String(project_pcb_code).trim() || null
                    : null,
                fileSource,
                generatePublicId(),
            ],
        );
        const created = result.rows[0];
        if (
            created?.id &&
            (fileSource === 'gsheet' || fileSource === 'gdocs')
        ) {
            const extension = fileSource === 'gsheet' ? 'gsheet' : 'gdoc';
            const mimeType =
                fileSource === 'gsheet'
                    ? 'application/vnd.google-apps.spreadsheet'
                    : 'application/vnd.google-apps.document';
            await pool.query(
                `
                UPDATE file_manager_items
                SET extension = $2, mime_type = $3
                WHERE id = $1
                `,
                [created.id, extension, mimeType],
            );
            created.extension = extension;
            created.mime_type = mimeType;
        }
        if (created?.id && effectiveParentId) {
            try {
                await FileManagerPermissionModel.inheritFromParent(
                    created.id,
                    effectiveParentId,
                );
            } catch (err) {
                console.warn(
                    '⚠️ Could not inherit project item permissions:',
                    err?.message || err,
                );
            }
        }
        return created;
    }

    /* ---------- users / permissions (file_manager_permissions) ---------- */

    static async listUsers(projectFolderId) {
        return FileManagerPermissionModel.listUsers(projectFolderId);
    }

    static async findUser(projectFolderId, userId) {
        return FileManagerPermissionModel.findUser(projectFolderId, userId);
    }

    static async findUserAccess(projectFolderId, userId) {
        return this.findUser(projectFolderId, userId);
    }

    static async upsertUser({
        project_folder_id,
        user_id,
        username,
        role,
        assigned_by_username,
        is_childshare = true,
    }) {
        return FileManagerPermissionModel.upsertUser({
            item_id: project_folder_id,
            user_id,
            username,
            role,
            assigned_by_username,
            is_childshare:
                is_childshare == null ? true : Boolean(is_childshare),
            expected_scope: PROJECT_SCOPE,
        });
    }

    static async updateUserPermissions(projectFolderId, userId, fields = {}) {
        return FileManagerPermissionModel.updateUserPermissions(
            projectFolderId,
            userId,
            fields,
        );
    }

    static async removeUser(projectFolderId, userId) {
        return FileManagerPermissionModel.removeUser(projectFolderId, userId);
    }

    static async findAccessibleByUser(userId) {
        const result = await pool.query(
            `
            SELECT
                ${PROJECT_FOLDER_SELECT},
                u.role,
                u.assigned_at,
                u.assigned_by_username,
                u.username AS access_username,
                u.user_id AS access_user_id
            FROM file_manager_permissions u
            INNER JOIN file_manager_items f
                ON f.id = u.item_id
            WHERE u.user_id = $1
              AND LOWER(COALESCE(u.role, 'viewer')) IN ('owner', 'editor', 'viewer')
              AND ${PROJECT_ROOT_WHERE}
            ORDER BY f.updated_at DESC, f.id DESC
            `,
            [userId],
        );
        return result.rows;
    }

    static async listGoogleSheetsForUser({
        userId,
        username = null,
        search = null,
        limit = 100,
        allowAll = false,
    } = {}) {
        const params = [];
        const where = [
            `i.scope = '${PROJECT_SCOPE}'`,
            `i.scope_root_id IS NOT NULL`,
            `i.is_deleted = FALSE`,
            `i.is_active IS DISTINCT FROM FALSE`,
            `(
                LOWER(TRIM(COALESCE(i.item_type, ''))) = 'google_sheet'
                OR (
                    COALESCE(i.google_sheet_url, i.url) IS NOT NULL
                    AND TRIM(COALESCE(i.google_sheet_url, i.url, '')) <> ''
                )
            )`,
            `f.scope = '${PROJECT_SCOPE}'`,
            `f.scope_root_id IS NULL`,
            `f.is_deleted = FALSE`,
        ];

        if (!allowAll) {
            const oid = userId != null ? Number(userId) : null;
            const uname = String(username || '').trim().toLowerCase();
            if (oid && Number.isFinite(oid) && oid > 0) {
                params.push(oid);
                where.push(`(
                    f.owner_id = $${params.length}
                    OR EXISTS (
                        SELECT 1
                        FROM file_manager_permissions u
                        WHERE u.item_id = f.id
                          AND u.user_id = $${params.length}
                          AND LOWER(COALESCE(u.role, 'viewer')) IN ('owner', 'editor', 'viewer')
                    )
                )`);
            } else if (uname) {
                params.push(uname);
                where.push(`(
                    LOWER(TRIM(COALESCE(f.username, ''))) = $${params.length}
                    OR EXISTS (
                        SELECT 1
                        FROM file_manager_permissions u
                        WHERE u.item_id = f.id
                          AND LOWER(TRIM(COALESCE(u.username, ''))) = $${params.length}
                          AND LOWER(COALESCE(u.role, 'viewer')) IN ('owner', 'editor', 'viewer')
                    )
                )`);
            } else {
                return [];
            }
        }

        const q = String(search || '').trim();
        if (q) {
            params.push(`%${q}%`);
            where.push(
                `(i.name ILIKE $${params.length}
                  OR COALESCE(i.google_sheet_url, i.url, '') ILIKE $${params.length}
                  OR COALESCE(f.project_code, '') ILIKE $${params.length})`,
            );
        }

        const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
        params.push(lim);

        const result = await pool.query(
            `
            SELECT
                i.id,
                i.public_id,
                i.scope_root_id AS project_folder_id,
                i.parent_id,
                i.name AS name,
                i.item_type,
                i.relative_path,
                i.absolute_path,
                i.google_file_id,
                COALESCE(i.google_sheet_url, i.url) AS url,
                i.pcb_code,
                i.project_pcb_code,
                i.display_order,
                i.is_active,
                i.created_at,
                i.updated_at,
                f.project_code,
                f.category_name,
                f.owner_id,
                f.username AS folder_username
            FROM file_manager_items i
            INNER JOIN file_manager_items f
                ON f.id = i.scope_root_id
            WHERE ${where.join(' AND ')}
            ORDER BY i.updated_at DESC NULLS LAST, i.id DESC
            LIMIT $${params.length}
            `,
            params,
        );
        return result.rows;
    }

    static async findSharedWithMe({
        userId = null,
        username = null,
        assigned_by = null,
        project_code = null,
        financial_year = null,
        search = null,
        include_owned = false,
    } = {}) {
        const params = [];
        const where = [
            `LOWER(COALESCE(u.role, 'viewer')) IN ('owner', 'editor', 'viewer')`,
            `f.scope = '${PROJECT_SCOPE}'`,
            `f.is_deleted = FALSE`,
            // Direct shares only — cascaded child rows use inherited_from_item_id
            `u.inherited_from_item_id IS NULL`,
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

        // Shared-with-me: never return folders the current user owns,
        // and never return rows they assigned to themselves.
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

        const sharedBy = String(assigned_by || '').trim();
        if (sharedBy) {
            params.push(sharedBy);
            where.push(
                `LOWER(TRIM(u.assigned_by_username)) = LOWER(TRIM($${params.length}))`,
            );
        }

        const projectCode = String(project_code || '').trim();
        if (projectCode) {
            params.push(projectCode);
            where.push(
                `LOWER(TRIM(f.project_code)) = LOWER(TRIM($${params.length}))`,
            );
        }

        const fy = String(financial_year || '').trim();
        if (fy) {
            params.push(fy);
            where.push(`f.financial_year = $${params.length}`);
        }

        const q = String(search || '').trim();
        if (q) {
            params.push(`%${q.toLowerCase()}%`);
            where.push(
                `(LOWER(COALESCE(f.project_code, '')) LIKE $${params.length}
                  OR LOWER(COALESCE(f.name, '')) LIKE $${params.length}
                  OR LOWER(COALESCE(f.category_name, '')) LIKE $${params.length}
                  OR LOWER(COALESCE(u.assigned_by_username, '')) LIKE $${params.length})`,
            );
        }

        const result = await pool.query(
            `
            SELECT
                ${PROJECT_FOLDER_SELECT},
                u.id AS share_id,
                u.user_id AS access_user_id,
                u.username AS access_username,
                u.role,
                u.assigned_by_username,
                u.assigned_at,
                (LOWER(COALESCE(u.role, '')) = 'owner') AS is_owner
            FROM file_manager_permissions u
            INNER JOIN file_manager_items f
                ON f.id = u.item_id
            WHERE ${where.join(' AND ')}
            ORDER BY u.assigned_at DESC NULLS LAST, f.updated_at DESC, f.id DESC
            `,
            params,
        );
        return result.rows;
    }
}

export default ProjectFileManagerModel;
