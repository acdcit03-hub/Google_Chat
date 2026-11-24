import fs from 'fs';
import path from 'path';
import { pool } from '../../config/db.js';
import FileManagerSettingModel from './fileManagerSetting.model.js';
import FileManagerPermissionModel from './fileManagerPermission.model.js';
import { FILE_MANAGER_SCOPES } from './fileManagerScopes.js';
import { generatePublicId } from '../../utils/fileManagerPublicId.js';

const FY_SCOPE = FILE_MANAGER_SCOPES.FINANCIAL_YEAR;

/** SELECT list: unified `name` + legacy `folder_name` / `is_folder` aliases. */
const FY_FOLDER_SELECT = `
    f.*,
    f.name AS folder_name,
    TRUE AS is_folder
`;

const FY_ROOT_FILTER = `
    f.scope = '${FY_SCOPE}'
    AND f.is_deleted = FALSE
    AND f.parent_id IS NULL
`;

/* ================= PROJECT FILES ROOT (physical) ================= */
export function getProjectFileManagerRootPath() {
    const fromEnv = String(process.env.PROJECT_FILE_MANAGER_PATH || '')
        .trim()
        .replace(/^["']|["']$/g, '');
    if (!fromEnv) {
        throw new Error(
            'PROJECT_FILE_MANAGER_PATH is not configured in .env',
        );
    }
    return path.resolve(fromEnv);
}

function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}

function sanitizeFyFolderName(yearCode) {
    return String(yearCode || '')
        .trim()
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
        .replace(/\s+/g, ' ')
        .slice(0, 100);
}

/* ================= CREATE TABLE (legacy — unified schema elsewhere) ================= */
export const initializeFinancialYearFileManagerTable = async () => {
    // Unified file_manager_items + file_manager_permissions are initialized
    // via initializeUnifiedFileManagerSchema / database bootstrap.
};

class FinancialYearFileManagerModel {
    static async findAll() {
        const result = await pool.query(
            `
            SELECT ${FY_FOLDER_SELECT},
                fy.start_year,
                fy.end_year,
                fy.is_current,
                fy.is_active
            FROM file_manager_items f
            LEFT JOIN financial_years fy ON fy.id = f.financial_year_id
            WHERE ${FY_ROOT_FILTER}
            ORDER BY fy.start_year DESC NULLS LAST, f.id DESC
            `,
        );
        return result.rows;
    }

    static async findById(id) {
        const result = await pool.query(
            `
            SELECT ${FY_FOLDER_SELECT},
                fy.start_year,
                fy.end_year,
                fy.is_current,
                fy.is_active
            FROM file_manager_items f
            LEFT JOIN financial_years fy ON fy.id = f.financial_year_id
            WHERE f.id = $1
              AND ${FY_ROOT_FILTER}
            `,
            [id],
        );
        return result.rows[0] || null;
    }

    static async findByYearCode(yearCode) {
        const result = await pool.query(
            `
            SELECT ${FY_FOLDER_SELECT}
            FROM file_manager_items f
            WHERE ${FY_ROOT_FILTER}
              AND LOWER(TRIM(f.year_code)) = LOWER(TRIM($1))
            `,
            [String(yearCode).trim()],
        );
        return result.rows[0] || null;
    }

    static async findByFinancialYearId(financialYearId) {
        const result = await pool.query(
            `
            SELECT ${FY_FOLDER_SELECT}
            FROM file_manager_items f
            WHERE ${FY_ROOT_FILTER}
              AND f.financial_year_id = $1
            `,
            [financialYearId],
        );
        return result.rows[0] || null;
    }

    static async upsertFolder({
        financial_year_id,
        year_code,
        folder_name,
        relative_path,
        absolute_path,
        project_file_manager_path,
        is_folder = true,
        owner_id = undefined,
        username = undefined,
    }) {
        const fyId = Number(financial_year_id);
        const yearCodeVal = String(year_code).trim();
        const nameVal = String(folder_name).trim();
        const relativeVal = String(relative_path).trim();
        const absoluteVal = String(absolute_path).trim();
        const projectRootVal = String(project_file_manager_path).trim();
        const updateOwner = owner_id !== undefined || username !== undefined;
        const ownerIdVal =
            owner_id != null && owner_id !== ''
                ? Number(owner_id)
                : null;
        const usernameVal =
            username != null ? String(username).trim() || null : null;

        const existing =
            await FinancialYearFileManagerModel.findByFinancialYearId(fyId);

        let rowId;
        if (existing) {
            const sets = [
                'year_code = $1',
                'name = $2',
                'financial_year = $3',
                'relative_path = $4',
                'absolute_path = $5',
                'project_file_manager_path = $6',
                'filemanager_path = $6',
                "item_type = 'folder'",
                "updated_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)",
            ];
            const params = [
                yearCodeVal,
                nameVal,
                yearCodeVal,
                relativeVal,
                absoluteVal,
                projectRootVal,
            ];

            if (updateOwner) {
                params.push(ownerIdVal, usernameVal);
                sets.push(
                    `owner_id = $${params.length - 1}`,
                    `username = $${params.length}`,
                );
            }

            // Backfill public_id when missing on older FY rows
            if (!String(existing.public_id || '').trim()) {
                params.push(generatePublicId());
                sets.push(`public_id = $${params.length}`);
            }

            params.push(existing.id);
            await pool.query(
                `
                UPDATE file_manager_items
                SET ${sets.join(', ')}
                WHERE id = $${params.length}
                  AND scope = '${FY_SCOPE}'
                  AND is_deleted = FALSE
                `,
                params,
            );
            rowId = existing.id;
        } else {
            const createdBy =
                (updateOwner && usernameVal) || 'system';
            const insertParams = [
                ownerIdVal,
                usernameVal,
                nameVal,
                relativeVal,
                projectRootVal,
                createdBy,
                createdBy,
                absoluteVal,
                fyId,
                yearCodeVal,
                yearCodeVal,
                projectRootVal,
            ];
            const inserted = await pool.query(
                `
                INSERT INTO file_manager_items (
                    owner_id,
                    username,
                    parent_id,
                    name,
                    item_type,
                    relative_path,
                    filemanager_path,
                    created_by,
                    updated_by,
                    scope,
                    absolute_path,
                    financial_year_id,
                    year_code,
                    financial_year,
                    project_file_manager_path,
                    is_active,
                    public_id
                ) VALUES (
                    $1, $2, NULL, $3, 'folder', $4, $5, $6, $7,
                    '${FY_SCOPE}', $8, $9, $10, $11, $12, TRUE, $13
                )
                RETURNING id
                `,
                [...insertParams, generatePublicId()],
            );
            rowId = inserted.rows[0].id;
        }

        return FinancialYearFileManagerModel.findById(rowId);
    }

    /**
     * Apply File Manager Settings owners onto one FY folder:
     * - primary owner (access=true preferred) → owner_id / username
     * - every active settings owner → full folder_users permissions
     */
    static async applyFileManagerOwners(
        fyFolderId,
        assignedByUsername = 'system',
    ) {
        const id = Number(fyFolderId);
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
                entry: await FinancialYearFileManagerModel.findById(id),
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
                  AND scope = '${FY_SCOPE}'
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
            await FinancialYearFileManagerModel.upsertUser({
                fy_folder_id: id,
                user_id: oid,
                username: uname,
                role: 'owner',
                assigned_by_username: assignedBy,
            });
        }

        return {
            owners,
            entry: await FinancialYearFileManagerModel.findById(id),
        };
    }

    /** Apply settings owners to every FY folder row. */
    static async applyFileManagerOwnersToAll(
        assignedByUsername = 'system',
    ) {
        const folders = await FinancialYearFileManagerModel.findAll();
        const results = [];
        for (const folder of folders || []) {
            const synced =
                await FinancialYearFileManagerModel.applyFileManagerOwners(
                    folder.id,
                    assignedByUsername,
                );
            results.push({
                fy_folder_id: folder.id,
                year_code: folder.year_code,
                owner_id: synced.entry?.owner_id ?? null,
                username: synced.entry?.username ?? null,
                owners_count: (synced.owners || []).length,
            });
        }
        return results;
    }

    /**
     * Ensure PROJECT_FILE_MANAGER_PATH/{year_code} exists for every financial year,
     * upsert row in file_manager_items (scope = financial_year).
     */
    static async ensureFinancialYearFolders() {
        const root = getProjectFileManagerRootPath();
        ensureDir(root);

        const { rows } = await pool.query(
            `
            SELECT id, year_code
            FROM financial_years
            ORDER BY start_year ASC, id ASC
            `,
        );

        const results = [];
        for (const row of rows) {
            const folderName = sanitizeFyFolderName(row.year_code);
            if (!folderName) {
                results.push({
                    financial_year_id: row.id,
                    year_code: row.year_code,
                    is_folder: false,
                    path: null,
                    created: false,
                    entry: null,
                });
                continue;
            }

            const abs = path.join(root, folderName);
            let created = false;
            let exists = fs.existsSync(abs) && fs.statSync(abs).isDirectory();

            if (!exists) {
                ensureDir(abs);
                created = true;
                exists = true;
            }

            let entry = await FinancialYearFileManagerModel.upsertFolder({
                financial_year_id: row.id,
                year_code: row.year_code,
                folder_name: folderName,
                relative_path: folderName,
                absolute_path: abs,
                project_file_manager_path: root,
                is_folder: exists,
            });

            const synced =
                await FinancialYearFileManagerModel.applyFileManagerOwners(
                    entry.id,
                    'system',
                );
            entry = synced.entry || entry;

            results.push({
                financial_year_id: row.id,
                year_code: row.year_code,
                is_folder: exists,
                path: abs,
                created,
                entry,
            });
        }

        return { root, folders: results };
    }

    /** Create/ensure one FY folder + table entry by year_code. */
    static async ensureFinancialYearFolderByCode(yearCode) {
        const code = String(yearCode || '').trim();
        const folderName = sanitizeFyFolderName(code);
        if (!folderName) {
            return { is_folder: false, path: null, created: false, entry: null };
        }

        const fy = await pool.query(
            `SELECT id, year_code FROM financial_years WHERE year_code = $1`,
            [code],
        );
        const fyRow = fy.rows[0];
        if (!fyRow) {
            return {
                is_folder: false,
                path: null,
                created: false,
                entry: null,
                message: `financial_years row not found for ${code}`,
            };
        }

        const root = getProjectFileManagerRootPath();
        ensureDir(root);

        const abs = path.join(root, folderName);
        let created = false;
        if (!(fs.existsSync(abs) && fs.statSync(abs).isDirectory())) {
            ensureDir(abs);
            created = true;
        }

        let entry = await FinancialYearFileManagerModel.upsertFolder({
            financial_year_id: fyRow.id,
            year_code: code,
            folder_name: folderName,
            relative_path: folderName,
            absolute_path: abs,
            project_file_manager_path: root,
            is_folder: true,
        });

        const synced =
            await FinancialYearFileManagerModel.applyFileManagerOwners(
                entry.id,
                'system',
            );
        entry = synced.entry || entry;

        return {
            is_folder: true,
            path: abs,
            created,
            year_code: folderName,
            entry,
        };
    }

    /* ---------- users / permissions (file_manager_permissions) ---------- */

    static async listUsers(fyFolderId) {
        return FileManagerPermissionModel.listUsers(fyFolderId);
    }

    static async findUser(fyFolderId, userId) {
        return FileManagerPermissionModel.findUser(fyFolderId, userId);
    }

    static async upsertUser({
        fy_folder_id,
        user_id,
        username,
        role = 'viewer',
        assigned_by_username,
    }) {
        return FileManagerPermissionModel.upsertUser({
            item_id: fy_folder_id,
            user_id,
            username,
            role,
            assigned_by_username,
            expected_scope: FY_SCOPE,
        });
    }

    static async updateUserPermissions(fyFolderId, userId, fields = {}) {
        return FileManagerPermissionModel.updateUserPermissions(
            fyFolderId,
            userId,
            fields,
        );
    }

    static async removeUser(fyFolderId, userId) {
        return FileManagerPermissionModel.removeUser(fyFolderId, userId);
    }

    /**
     * FY folders shared with a user (username / user_id filter).
     */
    /**
     * FY roots owned by the current user (for My Folder / folders/:id/children).
     * Does not include folders only shared with them.
     */
    static async findOwnedByUser({ userId = null, username = null } = {}) {
        const params = [];
        const ownerClauses = [];
        const uid = userId != null ? Number(userId) : null;
        const uname = String(username || '').trim();

        if (uid && Number.isFinite(uid) && uid > 0) {
            params.push(uid);
            ownerClauses.push(`f.owner_id = $${params.length}`);
        }
        if (uname) {
            params.push(uname);
            ownerClauses.push(
                `LOWER(TRIM(f.username)) = LOWER(TRIM($${params.length}))`,
            );
        }
        if (!ownerClauses.length) return [];

        const result = await pool.query(
            `
            SELECT
                ${FY_FOLDER_SELECT},
                fy.start_year,
                fy.end_year,
                fy.is_current,
                fy.is_active,
                'owner'::text AS role,
                TRUE AS is_owner,
                'financial_year' AS share_type
            FROM file_manager_items f
            LEFT JOIN financial_years fy
                ON fy.id = f.financial_year_id
            WHERE ${FY_ROOT_FILTER}
              AND (${ownerClauses.join(' OR ')})
            ORDER BY fy.start_year DESC NULLS LAST, f.id DESC
            `,
            params,
        );
        return result.rows;
    }

    static async findSharedWithMe({
        userId = null,
        username = null,
        assigned_by = null,
        year_code = null,
        financial_year = null,
        search = null,
        include_owned = false,
    } = {}) {
        const params = [];
        const where = [
            `LOWER(COALESCE(u.role, 'viewer')) IN ('owner', 'editor', 'viewer')`,
            `f.scope = '${FY_SCOPE}'`,
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

        const yearCode = String(year_code || financial_year || '').trim();
        if (yearCode) {
            params.push(yearCode);
            where.push(
                `LOWER(TRIM(f.year_code)) = LOWER(TRIM($${params.length}))`,
            );
        }

        const q = String(search || '').trim();
        if (q) {
            params.push(`%${q.toLowerCase()}%`);
            where.push(
                `(LOWER(f.year_code) LIKE $${params.length}
                  OR LOWER(COALESCE(f.name, '')) LIKE $${params.length}
                  OR LOWER(COALESCE(u.assigned_by_username, '')) LIKE $${params.length})`,
            );
        }

        const result = await pool.query(
            `
            SELECT
                ${FY_FOLDER_SELECT},
                fy.start_year,
                fy.end_year,
                fy.is_current,
                fy.is_active,
                u.id AS share_id,
                u.user_id AS access_user_id,
                u.username AS access_username,
                u.role,
                u.assigned_by_username,
                u.assigned_at,
                'financial_year' AS share_type,
                (LOWER(COALESCE(u.role, '')) = 'owner') AS is_owner
            FROM file_manager_permissions u
            INNER JOIN file_manager_items f
                ON f.id = u.item_id
            LEFT JOIN financial_years fy
                ON fy.id = f.financial_year_id
            WHERE ${where.join(' AND ')}
            ORDER BY u.assigned_at DESC NULLS LAST, fy.start_year DESC NULLS LAST, f.id DESC
            `,
            params,
        );
        return result.rows;
    }
}

export const ensureFinancialYearFolders =
    FinancialYearFileManagerModel.ensureFinancialYearFolders.bind(
        FinancialYearFileManagerModel,
    );

export const ensureFinancialYearFolderByCode =
    FinancialYearFileManagerModel.ensureFinancialYearFolderByCode.bind(
        FinancialYearFileManagerModel,
    );

export default FinancialYearFileManagerModel;
