import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import JSZip from 'jszip';
import FileManagerModel from '../../models/filemanager/fileManager.model.js';
import { writeFileManagerLog } from '../../models/filemanager/fileManagerLog.model.js';
import ProjectFileManagerModel from '../../models/filemanager/projectFileManager.model.js';
import FinancialYearFileManagerModel from '../../models/filemanager/financialYearFileManager.model.js';
import {
    getUserIdFromReq,
    getUsernameFromReq,
} from '../../utils/audit.utils.js';
import { pool } from '../../config/db.js';
import {
    attachThumbnailMeta,
    buildThumbnailMeta,
    getOrCreateThumbnail,
    generateExtensionThumbnail,
    isOfficeTempLockFile,
    isGoogleNativeFile,
} from '../../services/filemanager/thumbnail.service.js';
import {
    getExistingGoogleAuthForUser,
    getDriveClient,
    mapGoogleApiAuthError,
    GoogleAuthError,
} from '../../services/filemanager/googleAuth.service.js';
import { generatePublicId } from '../../utils/fileManagerPublicId.js';
import FileManagerSettingModel from '../../models/filemanager/fileManagerSetting.model.js';
import {
    attachCreatedByUser,
    attachCreatedByUserOne,
} from '../../utils/fileManagerCreatedBy.js';
import { withIstTimestamps } from '../../utils/time.utils.js';
import { listDiskChildren, classifyDiskDirent } from '../../services/filemanager/diskChildren.js';

const RECYCLE_BIN_FOLDER = 'Recycle Bin';
const FILE_MANAGER_API_BASE = '/api/file-manager';
const THUMBNAIL_CACHE = 'public, max-age=86400';

function isGoogleCloudItem(item) {
    const source = String(item?.file_source || 'local').toLowerCase();
    return (
        source.startsWith('google_') ||
        source === 'gsheet' ||
        source === 'gdocs' ||
        source === 'gdoc' ||
        Boolean(item?.google_file_id)
    );
}

function attachGoogleFileMeta(item) {
    if (!item) return item;
    const source = String(item.file_source || 'local').toLowerCase() || 'local';
    const isGoogle =
        source.startsWith('google_') ||
        source === 'gsheet' ||
        source === 'gdocs' ||
        source === 'gdoc' ||
        Boolean(item.google_file_id);
    const url = item.url || null;
    // Docs/Sheets/Slides (including .url shortcuts tagged gsheet/gdoc) get WebP thumbs
    const googleThumbOk = isGoogleNativeFile(item);
    const showGooglePreview = (isGoogle || googleThumbOk) && url;
    return {
        ...item,
        file_source: source,
        google_file_id: item.google_file_id || null,
        google_drive_folder_id: item.google_drive_folder_id || null,
        url,
        preview_url: showGooglePreview
            ? url
            : item.preview_url || null,
        thumbnail_url: googleThumbOk
            ? (item.thumbnail_url ||
                (item.id != null
                    ? `/api/file-manager/files/${item.id}/thumbnail`
                    : null))
            : isGoogle
                ? null
                : item.thumbnail_url,
        thumbnail_available: googleThumbOk
            ? Boolean(item.thumbnail_available ?? true)
            : isGoogle
                ? false
                : Boolean(item.thumbnail_available),
    };
}

function attachListMeta(items) {
    return attachThumbnailMeta(items)
        .map(attachGoogleFileMeta)
        .map(withIstTimestamps);
}

function attachItemMeta(item) {
    if (!item) return item;
    return withIstTimestamps(attachGoogleFileMeta(item));
}

/** Nested access block for file-manager folder/file responses. */
function buildOwnerAccess(isOwner) {
    const all = Boolean(isOwner);
    return {
        role: all ? 'owner' : null,
        is_owner: all,
    };
}

function isItemOwner(item, actor) {
    if (!item || !actor) return false;
    if (actor.isAdmin) return true;
    if (
        actor.ownerId != null &&
        Number(item.owner_id) === Number(actor.ownerId)
    ) {
        return true;
    }
    const itemUser = String(item.username || '')
        .trim()
        .toLowerCase();
    const actorUser = String(actor.username || '')
        .trim()
        .toLowerCase();
    return Boolean(itemUser && actorUser && itemUser === actorUser);
}

function attachItemAccess(item, actor) {
    if (!item) return item;
    return withIstTimestamps({
        ...item,
        access: buildOwnerAccess(isItemOwner(item, actor)),
    });
}

/** Owner / share role for direct folder-link resolution. */
async function attachItemAccessResolved(item, actor) {
    if (!item) return item;
    if (isItemOwner(item, actor)) {
        return withIstTimestamps({
            ...item,
            access: buildOwnerAccess(true),
        });
    }
    if (isScopedTreeItem(item)) {
        const role = await getScopedRoleChain(item, actor);
        if (role) {
            return withIstTimestamps({
                ...item,
                access: {
                    role,
                    is_owner: role === 'owner',
                },
            });
        }
    }
    try {
        const FileManagerPermissionModel = (
            await import('../../models/filemanager/fileManagerPermission.model.js')
        ).default;
        const uid = actor?.ownerId != null ? Number(actor.ownerId) : null;
        const uname = String(actor?.username || '').trim();
        const chain = [];
        let cursor = item;
        let guard = 0;
        while (cursor && guard < 64) {
            chain.push(Number(cursor.id));
            const parentId =
                cursor.parent_id != null ? Number(cursor.parent_id) : null;
            if (!parentId || !Number.isFinite(parentId)) break;
            cursor = await FileManagerModel.findById(parentId, {
                anyScope: true,
            });
            guard += 1;
        }
        const permMap = await FileManagerPermissionModel.findUserForItems(
            chain,
            { userId: uid, username: uname },
        );
        for (const id of chain) {
            const share = permMap.get(id);
            const role = String(share?.role || '')
                .trim()
                .toLowerCase();
            if (['owner', 'editor', 'viewer'].includes(role)) {
                return withIstTimestamps({
                    ...item,
                    access: {
                        role,
                        is_owner: role === 'owner',
                    },
                });
            }
        }
    } catch {
        /* ignore share lookup errors */
    }
    return withIstTimestamps({
        ...item,
        access: { role: null, is_owner: false },
    });
}

function attachListAccess(items, actor) {
    return (items || []).map((item) => attachItemAccess(item, actor));
}

function buildShareAccessFromRow(row = {}) {
    const role = String(row.role || '')
        .trim()
        .toLowerCase();
    const isOwner = Boolean(row.is_owner) || role === 'owner';
    return {
        role: isOwner ? 'owner' : role || 'viewer',
        is_owner: isOwner,
    };
}

/**
 * Financial-year roots the current user OWNS (My Folder / folders/:id/children).
 * Shared FY folders belong only on GET /file-manager/shared-with-me.
 * Project folders nest under FY via parent_id — not listed at personal root.
 */
async function loadAccessibleProjectAndFyFolders(actor) {
    const userId = actor?.ownerId != null ? Number(actor.ownerId) : null;
    const username = String(actor?.username || '').trim();
    if ((!userId || !Number.isFinite(userId)) && !username) return [];

    const fyRows = await FinancialYearFileManagerModel.findOwnedByUser({
        userId,
        username,
    });

    return (fyRows || []).map((row) => {
        const id = Number(row.id);
        const name = String(
            row.folder_name || row.year_code || id,
        ).trim();
        const access = buildShareAccessFromRow({
            role: 'owner',
            is_owner: true,
        });
        return {
            id,
            public_id: row.public_id || null,
            name,
            item_type: 'folder',
            parent_id: null,
            scope: 'financial_year',
            source: 'financial_year',
            share_type: 'financial_year',
            year_code: row.year_code ?? null,
            financial_year: row.year_code ?? row.financial_year ?? null,
            owner_id: row.owner_id ?? null,
            username: row.username ?? null,
            relative_path: row.relative_path || null,
            absolute_path: row.absolute_path || null,
            assigned_by_username: null,
            role: access.role,
            access: {
                current_username: username || null,
                role: access.role,
                is_owner: true,
            },
            storage_name: null,
            mime_type: null,
            extension: null,
            size: null,
            is_deleted: false,
            file_source: 'financial_year',
            created_by: row.created_by ?? null,
            updated_by: row.updated_by ?? null,
            created_at: row.created_at ?? null,
            updated_at: row.updated_at ?? null,
        };
    });
}

function isScopedTreeItem(item) {
    if (!item) return false;
    const scope = String(item.scope || 'file_manager')
        .trim()
        .toLowerCase();
    return (
        scope === 'project' ||
        scope === 'financial_year' ||
        item.scope_root_id != null ||
        item.project_id != null ||
        item.financial_year_id != null ||
        Boolean(item.project_code)
    );
}

async function getScopedRoleChain(folder, actor) {
    if (!folder || !actor) return null;
    if (actor.isAdmin) return 'owner';
    if (isItemOwner(folder, actor)) return 'owner';
    const uid = actor.ownerId != null ? Number(actor.ownerId) : null;
    const uname = String(actor.username || '').trim();
    if ((!uid || !Number.isFinite(uid)) && !uname) return null;
    try {
        const FileManagerPermissionModel = (
            await import('../../models/filemanager/fileManagerPermission.model.js')
        ).default;
        const chain = [];
        let cursor = folder;
        let guard = 0;
        while (cursor && guard < 64) {
            chain.push(Number(cursor.id));
            const parentId =
                cursor.parent_id != null ? Number(cursor.parent_id) : null;
            if (!parentId || !Number.isFinite(parentId)) break;
            cursor = await FileManagerModel.findById(parentId, {
                anyScope: true,
            });
            guard += 1;
        }
        const permMap = await FileManagerPermissionModel.findUserForItems(
            chain,
            { userId: uid, username: uname },
        );
        for (const id of chain) {
            const share = permMap.get(id);
            const role = String(share?.role || '')
                .trim()
                .toLowerCase();
            if (['owner', 'editor', 'viewer'].includes(role)) return role;
        }
        return null;
    } catch {
        return null;
    }
}

async function canViewScopedFolder(folder, actor) {
    const role = await getScopedRoleChain(folder, actor);
    return role != null;
}

/** Upload / create under project or FY requires owner or editor. */
async function canModifyScopedFolder(folder, actor) {
    const role = await getScopedRoleChain(folder, actor);
    return role === 'owner' || role === 'editor';
}

function resolveItemAbsoluteDir(item) {
    const storedAbs = String(item?.absolute_path || '').trim();
    if (storedAbs) return path.resolve(storedAbs);
    if (item?.relative_path) return absolutePath(item.relative_path);
    throw new Error('Parent folder has no absolute_path or relative_path');
}

/** Absolute file path: prefer DB absolute_path (project/FY), else personal root + relative_path. */
function resolveItemAbsoluteFilePath(item, { recycle = false } = {}) {
    if (recycle) {
        const recyclePath = String(item?.recycle_path || '').trim();
        if (recyclePath) {
            try {
                return absolutePath(recyclePath);
            } catch {
                /* fall through */
            }
        }
    }
    const storedAbs = String(item?.absolute_path || '').trim();
    if (storedAbs && fs.existsSync(storedAbs) && fs.statSync(storedAbs).isFile()) {
        return path.resolve(storedAbs);
    }
    if (storedAbs && isScopedTreeItem(item)) {
        return path.resolve(storedAbs);
    }
    const rel = recycle
        ? item?.recycle_path || item?.relative_path
        : item?.relative_path;
    return absolutePath(rel);
}

/** Owner/admin, shared project/FY, or personal share (viewer+). */
async function canAccessItemForRead(item, actor) {
    if (!item || !actor) return false;
    if (actor.isAdmin) return true;
    if (assertOwner(item, actor.ownerId, false)) return true;
    if (isScopedTreeItem(item)) {
        return canViewScopedFolder(item, actor);
    }
    // Personal folders shared with this user
    try {
        const resolved = await attachItemAccessResolved(item, actor);
        const role = String(resolved?.access?.role || '')
            .trim()
            .toLowerCase();
        return ['owner', 'editor', 'viewer'].includes(role);
    } catch {
        return false;
    }
}

/** Owner/admin, or owner/editor on project/FY (for rename / delete / move). */
async function canAccessItemForWrite(item, actor) {
    if (!item || !actor) return false;
    if (actor.isAdmin) return true;
    if (assertOwner(item, actor.ownerId, false)) return true;
    if (isScopedTreeItem(item)) {
        return canModifyScopedFolder(item, actor);
    }
    return false;
}

/** Disk path for a folder or file (project absolute_path preferred). */
function resolveItemDiskPath(item) {
    if (!item) throw new Error('Item is required');
    const type = String(item.item_type || '')
        .trim()
        .toLowerCase();
    if (type === 'folder') return resolveItemAbsoluteDir(item);
    return resolveItemAbsoluteFilePath(item);
}

/**
 * Resolve parent for upload/create. Personal + project/FY (anyScope).
 * @returns {{ parent?: object, error?: 'not_found'|'forbid' }}
 */
async function resolveWritableParent(parentId, actor) {
    const parent = await FileManagerModel.findById(parentId, {
        anyScope: true,
    });
    if (
        !parent ||
        String(parent.item_type || '')
            .trim()
            .toLowerCase() !== 'folder' ||
        parent.is_deleted
    ) {
        return { error: 'not_found' };
    }
    if (isScopedTreeItem(parent)) {
        if (!(await canModifyScopedFolder(parent, actor))) {
            return { error: 'forbid' };
        }
    } else if (!assertOwner(parent, actor.ownerId, actor.isAdmin)) {
        return { error: 'forbid' };
    }
    return { parent };
}

/** Walk up to the project root row (scope_root_id IS NULL). */
async function resolveProjectFolderId(parent) {
    if (parent?.scope_root_id != null) {
        return Number(parent.scope_root_id);
    }
    let cursor = parent;
    let guard = 0;
    while (cursor && guard < 64) {
        const asRoot = await ProjectFileManagerModel.findById(cursor.id);
        if (asRoot) return Number(cursor.id);
        const parentId =
            cursor.parent_id != null ? Number(cursor.parent_id) : null;
        if (!parentId || !Number.isFinite(parentId)) break;
        cursor = await FileManagerModel.findById(parentId, {
            anyScope: true,
        });
        guard += 1;
    }
    throw new Error('Project folder root not found for upload parent');
}

/** Primary File Manager Settings owner (access=true preferred). */
async function resolveSettingsPrimaryOwner(fallback = null) {
    try {
        const owners = await FileManagerSettingModel.findActiveOwners();
        const withAccess = (owners || []).find((o) => o.access === true);
        const primary = withAccess || (owners || [])[0] || null;
        if (primary?.owner_id != null && String(primary.username || '').trim()) {
            return {
                owner_id: Number(primary.owner_id),
                username: String(primary.username).trim(),
                owners: owners || [],
            };
        }
    } catch (err) {
        console.warn(
            'resolveSettingsPrimaryOwner failed:',
            err?.message || err,
        );
    }
    if (fallback?.owner_id != null || fallback?.username) {
        return {
            owner_id:
                fallback.owner_id != null ? Number(fallback.owner_id) : null,
            username: String(fallback.username || '').trim() || null,
            owners: [],
        };
    }
    return { owner_id: null, username: null, owners: [] };
}

/**
 * Editor upload ownership + shares:
 * - item owner = File Manager Settings owner (not the editor)
 * - created_by = current username
 * - inherit parent shares; settings owners → owner + is_childshare true;
 *   uploading editor → editor + is_childshare true (unless already settings owner)
 */
async function applyScopedUploadOwnershipAndShares({
    itemId,
    parentId,
    actorUsername,
    actorUserId = null,
}) {
    const id = Number(itemId);
    if (!Number.isFinite(id) || id <= 0) return;

    try {
        const { default: FileManagerPermissionModel } = await import(
            '../../models/filemanager/fileManagerPermission.model.js'
        );

        // Parent shares with is_childshare (or already inherited) → this item
        if (parentId != null) {
            await FileManagerPermissionModel.inheritFromParent(id, parentId);
        }

        const settings = await resolveSettingsPrimaryOwner();
        const assignedBy =
            String(actorUsername || '').trim() || 'system';

        for (const owner of settings.owners || []) {
            const oid = Number(owner.owner_id);
            const uname = String(owner.username || '').trim();
            if (!oid || !uname) continue;
            await FileManagerPermissionModel.upsertUser({
                item_id: id,
                user_id: oid,
                username: uname,
                role: 'owner',
                assigned_by_username: assignedBy,
                is_childshare: true,
            });
        }

        const uid = actorUserId != null ? Number(actorUserId) : null;
        const uname = String(actorUsername || '').trim();
        const isSettingsOwner =
            uid &&
            (settings.owners || []).some(
                (o) => Number(o.owner_id) === uid,
            );
        if (uid && Number.isFinite(uid) && uid > 0 && uname && !isSettingsOwner) {
            await FileManagerPermissionModel.upsertUser({
                item_id: id,
                user_id: uid,
                username: uname,
                role: 'editor',
                assigned_by_username: assignedBy,
                is_childshare: true,
            });
        }
    } catch (err) {
        console.warn(
            'applyScopedUploadOwnershipAndShares skipped:',
            err?.message || err,
        );
    }
}

/** Persist an uploaded file under a project/FY parent (correct scope + absolute_path). */
async function createScopedUploadedFile({
    parent,
    displayName,
    storageName,
    relativePath,
    absolutePath: absPath,
    mimeType = null,
    extension = null,
    size = null,
    actorUsername,
    actorUserId = null,
}) {
    const scope = String(parent.scope || '')
        .trim()
        .toLowerCase();
    const isProject =
        scope === 'project' ||
        parent.scope_root_id != null ||
        parent.project_id != null;

    const settingsOwner = await resolveSettingsPrimaryOwner({
        owner_id: parent.owner_id,
        username: parent.username,
    });
    const createdBy = String(actorUsername || '').trim() || 'system';

    if (isProject) {
        const projectFolderId = await resolveProjectFolderId(parent);
        const created = await ProjectFileManagerModel.createItem({
            project_folder_id: projectFolderId,
            parent_id: parent.id,
            folder_name: displayName,
            relative_path: relativePath,
            absolute_path: absPath,
            item_type: 'file',
            owner_id: settingsOwner.owner_id,
            username: settingsOwner.username,
            created_by: createdBy,
            updated_by: createdBy,
        });
        // createItem does not set mime/size — patch after insert
        if (created?.id) {
            try {
                await pool.query(
                    `
                    UPDATE file_manager_items
                    SET
                        storage_name = COALESCE($2, storage_name),
                        mime_type = COALESCE($3, mime_type),
                        extension = COALESCE($4, extension),
                        size = COALESCE($5, size),
                        updated_by = COALESCE($6, updated_by),
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = $1
                    `,
                    [
                        created.id,
                        storageName || null,
                        mimeType,
                        extension,
                        size,
                        createdBy,
                    ],
                );
            } catch (err) {
                console.warn(
                    'createScopedUploadedFile meta update skipped:',
                    err?.message || err,
                );
            }
            await applyScopedUploadOwnershipAndShares({
                itemId: created.id,
                parentId: parent.id,
                actorUsername: createdBy,
                actorUserId,
            });
            return {
                ...created,
                name: displayName,
                storage_name: storageName,
                mime_type: mimeType,
                extension,
                size,
                item_type: 'file',
                scope: 'project',
                created_by: createdBy,
                updated_by: createdBy,
                owner_id: settingsOwner.owner_id,
                username: settingsOwner.username,
            };
        }
        return created;
    }

    // FY (or other scoped) parent — settings owner + created_by = editor
    const result = await pool.query(
        `
        INSERT INTO file_manager_items (
            owner_id, username, parent_id, name, item_type,
            storage_name, relative_path, absolute_path,
            mime_type, extension, size,
            created_by, updated_by, scope,
            financial_year_id, year_code, financial_year,
            project_file_manager_path, public_id, file_source
        ) VALUES (
            $1, $2, $3, $4, 'file',
            $5, $6, $7,
            $8, $9, $10,
            $11, $11, $12,
            $13, $14, $15,
            $16, $17, 'local'
        )
        RETURNING *
        `,
        [
            settingsOwner.owner_id ?? parent.owner_id ?? null,
            settingsOwner.username ?? parent.username ?? null,
            parent.id,
            displayName,
            storageName,
            relativePath,
            absPath,
            mimeType,
            extension,
            size,
            createdBy,
            parent.scope || 'financial_year',
            parent.financial_year_id ?? null,
            parent.year_code ?? null,
            parent.financial_year ?? parent.year_code ?? null,
            parent.project_file_manager_path ?? parent.absolute_path ?? null,
            generatePublicId(),
        ],
    );
    const created = result.rows[0];
    if (created?.id) {
        await applyScopedUploadOwnershipAndShares({
            itemId: created.id,
            parentId: parent.id,
            actorUsername: createdBy,
            actorUserId,
        });
    }
    return created;
}

/** Create a folder under a project/FY parent (correct scope + absolute_path). */
async function createScopedUploadedFolder({
    parent,
    name,
    relativePath,
    absolutePath: absPath,
    actorUsername,
    actorUserId = null,
}) {
    const scope = String(parent.scope || '')
        .trim()
        .toLowerCase();
    const isProject =
        scope === 'project' ||
        parent.scope_root_id != null ||
        parent.project_id != null;

    const settingsOwner = await resolveSettingsPrimaryOwner({
        owner_id: parent.owner_id,
        username: parent.username,
    });
    const createdBy = String(actorUsername || '').trim() || 'system';

    let created;
    if (isProject) {
        const projectFolderId = await resolveProjectFolderId(parent);
        created = await ProjectFileManagerModel.createItem({
            project_folder_id: projectFolderId,
            parent_id: parent.id,
            folder_name: name,
            relative_path: relativePath,
            absolute_path: absPath,
            item_type: 'folder',
            owner_id: settingsOwner.owner_id,
            username: settingsOwner.username,
            created_by: createdBy,
            updated_by: createdBy,
        });
    } else {
        const result = await pool.query(
            `
            INSERT INTO file_manager_items (
                owner_id, username, parent_id, name, item_type,
                relative_path, absolute_path,
                created_by, updated_by, scope,
                financial_year_id, year_code, financial_year,
                project_file_manager_path, public_id, is_active
            ) VALUES (
                $1, $2, $3, $4, 'folder',
                $5, $6,
                $7, $7, $8,
                $9, $10, $11,
                $12, $13, TRUE
            )
            RETURNING *
            `,
            [
                settingsOwner.owner_id ?? parent.owner_id ?? null,
                settingsOwner.username ?? parent.username ?? null,
                parent.id,
                name,
                relativePath,
                absPath,
                createdBy,
                parent.scope || 'financial_year',
                parent.financial_year_id ?? null,
                parent.year_code ?? null,
                parent.financial_year ?? parent.year_code ?? null,
                parent.project_file_manager_path ?? parent.absolute_path ?? null,
                generatePublicId(),
            ],
        );
        created = result.rows[0];
    }

    if (created?.id) {
        await applyScopedUploadOwnershipAndShares({
            itemId: created.id,
            parentId: parent.id,
            actorUsername: createdBy,
            actorUserId,
        });
    }
    return created;
}

/** True when listing the user's personal root (not Recycle Bin / nested). */
function isUserPersonalRootFolder(folder, actor) {
    if (!folder || folder.item_type !== 'folder') return false;
    if (folder.parent_id != null) return false;
    if (folder.is_deleted) return false;
    if (
        isRecycleBinPath(folder.relative_path) ||
        isRecycleBinPath(folder.recycle_path)
    ) {
        return false;
    }
    return isItemOwner(folder, actor);
}

function getConfiguredStoragePath() {
    return String(
        process.env.FILEMANAGER_PATH ||
            '',
    )
        .trim()
        .replace(/^["']|["']$/g, '');
}

function getStorageRoot() {
    const fromEnv = getConfiguredStoragePath();
    if (!fromEnv) {
        throw new Error(
            'FILEMANAGER_PATH (or FILEMANAGER_PATH) is not configured in .env',
        );
    }
    const root = path.resolve(fromEnv);
    if (!fs.existsSync(root)) {
        fs.mkdirSync(root, { recursive: true });
    }
    return root;
}

/** Only the .env storage root — not item relative paths. */
function getFileManagerPathValue() {
    const fromEnv = getConfiguredStoragePath()
        .replace(/\\/g, '/')
        .replace(/\/+$/, '');
    if (!fromEnv) {
        throw new Error(
            'FILEMANAGER_PATH (or FILEMANAGER_PATH) is not configured in .env',
        );
    }
    return fromEnv;
}

/**
 * Resolve Content-Type + Content-Disposition from extension column.
 * Images / video / pdf / audio / text → inline; Office/spreadsheet → not auto-downloaded by /view.
 * `.url` (Internet Shortcut) → redirect to the target URL on view.
 */
function looksLikeUuidFileName(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(\.[^.]+)?$/i.test(
        String(value || '').trim(),
    );
}

/** Proper user-facing filename for download/view (never prefer UUID storage_name). */
function getPublicFileName(item) {
    const displayName = String(item?.name || '').trim();
    const storageName = String(item?.storage_name || '').trim();
    const pathBase = path.basename(String(item?.relative_path || '').replace(/\\/g, '/'));

    const candidates = [displayName, storageName, pathBase, `file-${item?.id || 'download'}`];
    for (const candidate of candidates) {
        if (!candidate) continue;
        if (looksLikeUuidFileName(candidate)) continue;
        return candidate.replace(/["\r\n]/g, '_');
    }
    // Last resort: display name even if UUID-like
    return (displayName || storageName || pathBase || `file-${item?.id || 'download'}`).replace(
        /["\r\n]/g,
        '_',
    );
}

function buildContentDisposition(disposition, filename) {
    const safe = String(filename || 'file').replace(/["\r\n]/g, '_');
    return `${disposition}; filename="${encodeURIComponent(safe)}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

function resolveViewByExtension(item) {
    const ext = String(item.extension || getExtension(item.name) || getExtension(item.storage_name) || '')
        .trim()
        .toLowerCase()
        .replace(/^\./, '');
    const filename = getPublicFileName(item);
    const storedMime = item.mime_type ? String(item.mime_type).trim() : '';

    const imageExts = new Set([
        'jpg', 'jpeg', 'jpe', 'jfif', 'png', 'ico', 'cur', 'gif', 'webp', 'bmp', 'svg', 'tif', 'tiff',
    ]);
    const videoExts = new Set(['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v']);
    const audioExts = new Set(['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'wma']);
    const pdfExts = new Set(['pdf']);
    const urlExts = new Set(['url']);
    const textExts = new Set([
        'txt', 'text', 'log', 'md', 'markdown', 'json', 'xml', 'html', 'htm',
        'css', 'js', 'ts', 'jsx', 'tsx', 'yml', 'yaml', 'ini', 'env', 'sql',
        'sh', 'bat', 'ps1', 'py', 'java', 'c', 'cpp', 'h', 'cs', 'go', 'rs',
        'php', 'rb', 'toml', 'conf', 'cfg',
    ]);
    const spreadsheetExts = new Set(['xls', 'xlsx', 'xlsm', 'csv', 'ods']);
    const officeExts = new Set([
        'doc', 'docx', 'ppt', 'pptx', 'rtf', 'odt', 'odp',
    ]);

    const mimeByExt = {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        jpe: 'image/jpeg',
        jfif: 'image/jpeg',
        png: 'image/png',
        ico: 'image/x-icon',
        cur: 'image/x-icon',
        gif: 'image/gif',
        webp: 'image/webp',
        bmp: 'image/bmp',
        svg: 'image/svg+xml',
        mp4: 'video/mp4',
        mov: 'video/quicktime',
        webm: 'video/webm',
        mkv: 'video/x-matroska',
        avi: 'video/x-msvideo',
        m4v: 'video/x-m4v',
        mp3: 'audio/mpeg',
        wav: 'audio/wav',
        ogg: 'audio/ogg',
        m4a: 'audio/mp4',
        aac: 'audio/aac',
        flac: 'audio/flac',
        wma: 'audio/x-ms-wma',
        pdf: 'application/pdf',
        url: 'application/internet-shortcut',
        txt: 'text/plain',
        text: 'text/plain',
        log: 'text/plain',
        md: 'text/markdown',
        json: 'application/json',
        xml: 'application/xml',
        html: 'text/html',
        htm: 'text/html',
        css: 'text/css',
        js: 'text/javascript',
        ts: 'text/plain',
        csv: 'text/csv',
        doc: 'application/msword',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        xls: 'application/vnd.ms-excel',
        xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ppt: 'application/vnd.ms-powerpoint',
        pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        rtf: 'application/rtf',
        zip: 'application/zip',
    };

    let category = 'download';
    let disposition = 'attachment';
    if (imageExts.has(ext)) {
        category = 'image';
        disposition = 'inline';
    } else if (videoExts.has(ext)) {
        category = 'video';
        disposition = 'inline';
    } else if (pdfExts.has(ext)) {
        category = 'pdf';
        disposition = 'inline';
    } else if (audioExts.has(ext)) {
        category = 'audio';
        disposition = 'inline';
    } else if (urlExts.has(ext)) {
        category = 'url';
        disposition = 'inline';
    } else if (spreadsheetExts.has(ext)) {
        category = 'spreadsheet';
        disposition = 'attachment';
    } else if (textExts.has(ext)) {
        category = 'text';
        disposition = 'inline';
    } else if (officeExts.has(ext)) {
        category = 'office';
        disposition = 'attachment';
    }

    const contentType = mimeByExt[ext] || (
        category === 'download' ? 'application/octet-stream' : (storedMime || 'application/octet-stream')
    );

    const safeName = filename.replace(/["\r\n]/g, '_');
    const contentDisposition = buildContentDisposition(disposition, safeName);

    return {
        ext,
        category,
        contentType,
        disposition,
        contentDisposition,
        filename: safeName,
        inline: disposition === 'inline',
    };
}

function buildFileMediaUrls(id) {
    const base = `${FILE_MANAGER_API_BASE}/files/${id}`;
    return {
        thumbnail_url: `${base}/thumbnail`,
        view_url: `${base}/view`,
        download_url: `${base}/download`,
    };
}

/**
 * Load file item for media endpoints. Sends response and returns null on failure.
 * @param {{ allowRecycleBin?: boolean }} [options]
 *   allowRecycleBin — also allow soft-deleted Recycle Bin files the user can access
 */
async function loadAccessibleFile(
    req,
    res,
    { allowRecycleBin = false, allowMissingDisk = false } = {},
) {
    const { ownerId, username, isAdmin } = await resolveActor(req);
    if (ownerId == null) {
        unauthorized(res);
        return null;
    }

    const actor = { ownerId, username, isAdmin };

    // Project / FY files are outside personal scope — must use anyScope
    let item = await FileManagerModel.findById(req.params.id, {
        includeDeleted: allowRecycleBin,
        anyScope: true,
    });

    if (!item) {
        notFound(res, 'File not found');
        return null;
    }

    if (item.is_deleted) {
        if (!allowRecycleBin || !item.recycle_path) {
            notFound(res, 'File not found');
            return null;
        }
        const deletedBy = String(item.deleted_by || '').trim().toLowerCase();
        const me = String(username || '').trim().toLowerCase();
        const canSeeRecycle =
            isAdmin ||
            (me && deletedBy === me) ||
            Number(item.owner_id) === Number(ownerId);
        if (!canSeeRecycle) {
            forbid(res);
            return null;
        }
    }

    if (item.item_type !== 'file') {
        res.status(400).json({
            success: false,
            message: 'Only files are allowed',
        });
        return null;
    }

    if (
        !item.is_deleted &&
        !(await canAccessItemForRead(item, actor))
    ) {
        forbid(res);
        return null;
    }

    // Google Docs/Sheets may only have a .url shortcut (or nothing) on disk —
    // thumbnail generation exports from Drive, so missing local bytes is OK.
    // Thumbnails also allow missing disk → extension-label image fallback.
    const googleNative = isGoogleNativeFile(item);

    let abs = null;
    let stat = null;
    try {
        abs = resolveItemAbsoluteFilePath(item, {
            recycle: Boolean(item.is_deleted),
        });
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
            stat = fs.statSync(abs);
        } else if (!googleNative && !allowMissingDisk) {
            res.status(404).json({
                success: false,
                message: 'Physical file missing on storage',
            });
            return null;
        } else {
            abs = null;
        }
    } catch {
        if (!googleNative && !allowMissingDisk) {
            res.status(404).json({
                success: false,
                message: 'Physical file missing on storage',
            });
            return null;
        }
        abs = null;
        stat = null;
    }

    return {
        item,
        abs,
        stat,
        view: resolveViewByExtension(item),
    };
}

/**
 * Parse Windows Internet Shortcut (.url) contents → target URL.
 * Expects lines like: URL=https://example.com
 */
function parseInternetShortcutUrl(raw) {
    const text = String(raw || '');
    const match = text.match(/^\s*URL\s*=\s*(.+?)\s*$/im);
    if (!match) return null;
    const target = String(match[1] || '').trim().replace(/^["']|["']$/g, '');
    return target || null;
}

/** Only allow http(s) redirects from .url shortcuts (block javascript:, file:, etc.). */
function isSafeExternalRedirectUrl(target) {
    try {
        const parsed = new URL(String(target || '').trim());
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        return false;
    }
}

function normalizeFsPath(p) {
    return path.resolve(p).replace(/[/\\]+$/, '').toLowerCase();
}

function absolutePath(relativePath) {
    const root = getStorageRoot();
    const abs = path.resolve(root, String(relativePath || '').replace(/^[/\\]+/, ''));
    const rootNorm = normalizeFsPath(root);
    const absNorm = normalizeFsPath(abs);
    if (absNorm !== rootNorm && !absNorm.startsWith(`${rootNorm}${path.sep}`)) {
        throw new Error('Invalid storage path');
    }
    return abs;
}

function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}

/** Remove multer diskStorage temp file when upload is skipped or fails. */
function cleanupUploadedTempFile(file) {
    const tempPath = file?.path;
    if (!tempPath || typeof tempPath !== 'string') return;
    try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch (err) {
        console.warn('cleanupUploadedTempFile failed:', err?.message || err);
    }
}

/**
 * Move a multer temp file into final storage (rename, with copy fallback).
 * Also supports memoryStorage buffers for backward compatibility.
 */
async function moveUploadedFile(srcPathOrFile, destAbs) {
    ensureDir(path.dirname(destAbs));

    // Called as moveUploadedFile(file.path, abs) or moveUploadedFile(file, abs)
    if (srcPathOrFile && typeof srcPathOrFile === 'object') {
        const file = srcPathOrFile;
        if (file.path) {
            if (!fs.existsSync(file.path)) {
                throw new Error('Uploaded temp file not found');
            }
            safeMovePath(file.path, destAbs);
            return;
        }
        if (file.buffer) {
            await fs.promises.writeFile(destAbs, file.buffer);
            return;
        }
        throw new Error('Uploaded file has no path or buffer');
    }

    const srcPath = srcPathOrFile;
    if (!srcPath || typeof srcPath !== 'string') {
        throw new Error('Uploaded temp file path is missing');
    }
    if (!fs.existsSync(srcPath)) {
        throw new Error('Uploaded temp file not found');
    }
    safeMovePath(srcPath, destAbs);
}

/** Persist one uploaded file (disk temp or memory buffer) to final path. */
async function persistUploadedFile(file, destAbs) {
    await moveUploadedFile(file, destAbs);
}

/**
 * Ensure physical + DB Recycle Bin for a user:
 * - FILEMANAGER_PATH/Recycle Bin
 * - FILEMANAGER_PATH/Recycle Bin/{username}
 * Also ensures Recycle Bin/{user} rows for every existing user root.
 */
async function ensureUserRecycleBinFolder(username, ownerId) {
    const safe = ownFolderName(username);
    if (!safe || ownerId == null) return null;

    const fmPath = getFileManagerPathValue();
    ensureDir(absolutePath(RECYCLE_BIN_FOLDER));
    const abs = absolutePath(joinRelative(RECYCLE_BIN_FOLDER, safe));
    ensureDir(abs);

    // Current user folder row
    const { root, folder } = await FileManagerModel.ensureUserRecycleBinFolder({
        ownerId: Number(ownerId),
        username: safe,
        filemanagerPath: fmPath,
        updatedBy: safe,
    });

    // All other user roots also get Recycle Bin/{username} DB + disk folders
    const all = await FileManagerModel.ensureAllUserRecycleBinFolders({
        filemanagerPath: fmPath,
        updatedBy: safe,
    });
    for (const f of all.folders || []) {
        try {
            ensureDir(absolutePath(f.relative_path));
        } catch {
            /* ignore invalid path */
        }
    }

    return {
        recycle_bin_path: abs,
        recycle_bin_root: root || all.root,
        recycle_bin_folder: folder,
        recycle_bin_user_folders: all.folders || [],
    };
}

/**
 * Merge structural DB recycle user folders with on-disk Recycle Bin/{username} dirs.
 */
function mergeRecycleBinUserFoldersFromDisk(dbFolders = []) {
    const byKey = new Map();
    for (const folder of dbFolders) {
        const key = String(folder.username || folder.name || '')
            .trim()
            .toLowerCase();
        if (!key) continue;
        byKey.set(key, folder);
    }

    try {
        const recycleAbs = absolutePath(RECYCLE_BIN_FOLDER);
        if (fs.existsSync(recycleAbs) && fs.statSync(recycleAbs).isDirectory()) {
            for (const entry of fs.readdirSync(recycleAbs, { withFileTypes: true })) {
                if (classifyDiskDirent(recycleAbs, entry) !== 'dir') continue;
                const rawName = entry.name;
                if (!rawName || rawName.startsWith('.')) continue;
                const key = rawName.trim().toLowerCase();
                if (!key) continue;
                if (byKey.has(key)) continue;
                byKey.set(key, {
                    id: null,
                    item_type: 'user_folder',
                    name: rawName,
                    username: rawName,
                    owner_id: null,
                    parent_id: null,
                    relative_path: joinRelative(RECYCLE_BIN_FOLDER, rawName),
                    deleted_count: 0,
                    deleted_at: null,
                    latest_deleted_at: null,
                    is_deleted: false,
                    thumbnail_available: false,
                    thumbnail_url: null,
                });
            }
        }
    } catch (err) {
        console.warn('mergeRecycleBinUserFoldersFromDisk:', err.message);
    }

    return [...byKey.values()].sort((a, b) =>
        String(a.name || '').localeCompare(String(b.name || ''), undefined, {
            sensitivity: 'base',
        }),
    );
}

/**
 * Move file/folder on disk. Windows often returns EPERM on rename across
 * locked folders; fall back to copy + remove.
 */
function safeMovePath(srcAbs, destAbs) {
    if (!fs.existsSync(srcAbs)) return;
    if (fs.existsSync(destAbs)) {
        throw new Error('Target already exists in storage');
    }
    ensureDir(path.dirname(destAbs));
    try {
        fs.renameSync(srcAbs, destAbs);
        return;
    } catch (err) {
        const code = err?.code;
        if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EXDEV' && code !== 'EBUSY') {
            throw err;
        }
    }

    const stat = fs.statSync(srcAbs);
    if (stat.isDirectory()) {
        fs.cpSync(srcAbs, destAbs, { recursive: true, force: false, errorOnExist: true });
        fs.rmSync(srcAbs, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } else {
        fs.copyFileSync(srcAbs, destAbs);
        fs.rmSync(srcAbs, { force: true, maxRetries: 5, retryDelay: 100 });
    }
}

function sanitizeFolderName(name) {
    return String(name || '')
        .trim()
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
        .replace(/\s+/g, ' ')
        .slice(0, 255);
}

/** Google Sheet/Doc title — spaces OK; block path separators. */
function sanitizeGoogleItemName(name) {
    return String(name || '')
        .trim()
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
        .replace(/\s+/g, ' ')
        .replace(/\.+$/g, '')
        .slice(0, 255);
}

function getExtension(filename) {
    const base = path.basename(String(filename || ''));
    const idx = base.lastIndexOf('.');
    if (idx <= 0 || idx === base.length - 1) return null;
    return base.slice(idx + 1).toLowerCase().slice(0, 20);
}

function joinRelative(parentRelative, segment) {
    const parent = String(parentRelative || '').replace(/\\/g, '/').replace(/\/+$/, '');
    const child = String(segment || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    return parent ? `${parent}/${child}` : child;
}

function normalizeFmPath(p) {
    return String(p || '')
        .trim()
        .replace(/\\/g, '/')
        .replace(/\/+$/, '')
        .toLowerCase();
}

/** Keep only rows for the current FILEMANAGER_PATH that still exist on disk. */
function filterExistingOnDisk(items, { allowMissingDisk = false } = {}) {
    const currentPath = normalizeFmPath(getFileManagerPathValue());
    return (items || []).filter((item) => {
        // Google / cloud files have no local NAS path — always keep in listings
        const source = String(item?.file_source || 'local').toLowerCase();
        if (source !== 'local' && item?.google_file_id) return true;
        if (item?.url && source.startsWith('google_')) return true;

        const scope = String(item?.scope || 'file_manager')
            .trim()
            .toLowerCase();
        const isScopedTree =
            scope === 'project' || scope === 'financial_year';

        // Project / FY trees use PROJECT_FILE_MANAGER_PATH — never filter by
        // personal FILEMANAGER_PATH. allowMissingDisk also skips disk checks.
        if (isScopedTree || allowMissingDisk) return true;

        const itemPath = normalizeFmPath(item.filemanager_path);
        // Personal NAS: only show data belonging to the active FILEMANAGER_PATH
        if (!itemPath || itemPath !== currentPath) return false;
        try {
            const rel =
                item.is_deleted && item.recycle_path
                    ? item.recycle_path
                    : item.relative_path;
            const abs = absolutePath(rel);
            return fs.existsSync(abs);
        } catch {
            return false;
        }
    });
}

/** True when folder/item lives under Recycle Bin (structural or soft-deleted). */
function isRecycleBinPath(relativePath) {
    const norm = normalizeRelativePath(relativePath).toLowerCase();
    return (
        norm === RECYCLE_BIN_FOLDER.toLowerCase() ||
        norm.startsWith(`${RECYCLE_BIN_FOLDER.toLowerCase()}/`)
    );
}

async function lookupUserByFolderName(folderName) {
    const name = String(folderName || '').trim();
    if (!name) return null;
    const result = await pool.query(
        `
        SELECT id, username
        FROM personal_details
        WHERE LOWER(TRIM(username)) = LOWER(TRIM($1))
        LIMIT 1
        `,
        [name],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
        id: Number(row.id),
        username: String(row.username || name).trim(),
    };
}

function readShortcutUrl(fileAbs) {
    try {
        const text = fs.readFileSync(fileAbs, 'utf8');
        const match = text.match(/^URL=(.+)$/im);
        return match?.[1] ? String(match[1]).trim() : null;
    } catch {
        return null;
    }
}

function googleMetaFromShortcutUrl(fileName, fileAbs) {
    const ext = getExtension(fileName);
    const url = ext === 'url' ? readShortcutUrl(fileAbs) : null;
    if (!url) {
        return { extension: ext, mimeType: null, fileSource: 'local', url: null };
    }
    if (/docs\.google\.com\/spreadsheets/i.test(url)) {
        return {
            extension: 'gsheet',
            mimeType: 'application/vnd.google-apps.spreadsheet',
            fileSource: 'gsheet',
            url,
        };
    }
    if (/docs\.google\.com\/document/i.test(url)) {
        return {
            extension: 'gdoc',
            mimeType: 'application/vnd.google-apps.document',
            fileSource: 'gdocs',
            url,
        };
    }
    return {
        extension: 'url',
        mimeType: 'application/internet-shortcut',
        fileSource: 'local',
        url,
    };
}

/**
 * Disk Recycle Bin/{user} → web recycle bin rows.
 * Covers files restored from the Windows Recycle Bin back into that folder.
 */
async function syncPhysicalRecycleBinToDatabase({
    ownerId,
    username,
    actorUsername,
}) {
    const binUser = ownFolderName(username);
    const binOwnerId = Number(ownerId);
    if (!binUser || !Number.isFinite(binOwnerId) || binOwnerId <= 0) return;

    const fmPath = getFileManagerPathValue();
    const binRel = joinRelative(RECYCLE_BIN_FOLDER, binUser);
    let binAbs;
    try {
        binAbs = absolutePath(binRel);
    } catch {
        return;
    }
    if (!fs.existsSync(binAbs)) return;

    const { folder } = await FileManagerModel.ensureUserRecycleBinFolder({
        ownerId: binOwnerId,
        username: binUser,
        filemanagerPath: fmPath,
        updatedBy: actorUsername || binUser,
    });
    const deletedBy = actorUsername || binUser;
    const storageRoot = getStorageRoot();

    async function walk(dirAbs, parentId) {
        let entries = [];
        try {
            entries = fs.readdirSync(dirAbs, { withFileTypes: true });
        } catch (err) {
            console.warn('Recycle Bin disk sync skipped:', err?.message || err);
            return;
        }

        for (const entry of entries) {
            const rawName = entry.name;
            if (!rawName || rawName.startsWith('.') || rawName.startsWith('~$')) {
                continue;
            }
            const kind = classifyDiskDirent(dirAbs, entry);
            const isDir = kind === 'dir';
            const isFile = kind === 'file';
            if (!isDir && !isFile) continue;

            const childAbs = path.join(dirAbs, rawName);
            const rel = path
                .relative(storageRoot, childAbs)
                .replace(/\\/g, '/')
                .replace(/^\/+/, '');
            if (!rel) continue;

            const prefix = `${RECYCLE_BIN_FOLDER}/${binUser}/`;
            const originalPath = rel.toLowerCase().startsWith(prefix.toLowerCase())
                ? `${binUser}/${rel.slice(prefix.length)}`
                : joinRelative(binUser, rawName);

            let existing = await FileManagerModel.findDeletedByRecyclePath(rel);
            if (!existing) {
                existing = await FileManagerModel.findAnyByRelativePath(
                    rel,
                    fmPath,
                );
            }

            let rowId = existing?.id ?? null;
            if (existing?.is_deleted && existing.recycle_path) {
                if (!existing.absolute_path) {
                    await FileManagerModel.setAbsolutePath(existing.id, childAbs);
                }
            } else if (!existing) {
                let size = null;
                try {
                    const st = fs.statSync(childAbs);
                    size = isFile ? st.size : null;
                } catch {
                    size = null;
                }
                const meta = isFile
                    ? googleMetaFromShortcutUrl(rawName, childAbs)
                    : {
                          extension: null,
                          mimeType: null,
                          fileSource: 'local',
                          url: null,
                      };
                try {
                    const created =
                        await FileManagerModel.insertRecoveredRecycleItem({
                            ownerId: binOwnerId,
                            username: binUser,
                            parentId,
                            name: rawName,
                            itemType: isDir ? 'folder' : 'file',
                            relativePath: rel,
                            recyclePath: rel,
                            originalPath,
                            absolutePath: childAbs,
                            filemanagerPath: fmPath,
                            deletedBy,
                            extension: meta.extension,
                            mimeType: meta.mimeType,
                            size,
                            fileSource: meta.fileSource,
                            url: meta.url,
                            storageName: isFile ? rawName : null,
                        });
                    rowId = created?.id ?? null;
                } catch (err) {
                    console.warn(
                        'Recycle Bin disk row skipped:',
                        rawName,
                        err?.message || err,
                    );
                }
            }

            if (isDir && rowId) {
                await walk(childAbs, rowId);
            }
        }
    }

    await walk(binAbs, folder?.id ?? null);
}

/**
 * Sync one directory from FILEMANAGER_PATH (disk → DB) so the UI shows
 * whatever exists at the configured Windows path (e.g. D:\\NASTEST).
 * Never throws on duplicate keys — GET /children must stay read-safe.
 */
async function syncFsChildren({
    parentId,
    parentRelative,
    defaultOwnerId,
    defaultUsername,
    actorUsername,
}) {
    const abs = parentRelative
        ? absolutePath(parentRelative)
        : getStorageRoot();

    if (!fs.existsSync(abs)) return;
    const stat = fs.statSync(abs);
    if (!stat.isDirectory()) return;

    // Never sync inside Recycle Bin — deleted files stay soft-deleted DB rows only.
    // Structural Recycle Bin / Recycle Bin/{user} rows are created via ensure APIs.
    const parentNorm = normalizeRelativePath(parentRelative || '').toLowerCase();
    if (
        parentNorm === RECYCLE_BIN_FOLDER.toLowerCase() ||
        parentNorm.startsWith(`${RECYCLE_BIN_FOLDER.toLowerCase()}/`)
    ) {
        return;
    }

    const fmPath = getFileManagerPathValue();
    let entries = [];
    try {
        entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch (err) {
        console.error('syncFsChildren readdir failed:', abs, err.message);
        return;
    }

    for (const entry of entries) {
        const rawName = entry.name;
        if (!rawName || rawName === '.' || rawName === '..') continue;
        if (rawName.startsWith('.')) continue;
        // Microsoft Office lock/temp owner files (e.g. ~$Requirement.docx) — not real docs
        if (rawName.startsWith('~$')) continue;

        const name = sanitizeFolderName(rawName) || rawName;
        if (!name) continue;

        const kind = classifyDiskDirent(abs, entry);
        const isDir = kind === 'dir';
        const isFile = kind === 'file';
        if (!isDir && !isFile) continue;

        // Physical Recycle Bin at storage root is not a browsable DB folder
        if (
            parentId == null &&
            isDir &&
            String(rawName).trim().toLowerCase() === RECYCLE_BIN_FOLDER.toLowerCase()
        ) {
            continue;
        }

        // Keep on-disk name in relative_path so FILEMANAGER_PATH resolves correctly
        const diskName = rawName;
        const relativePath = joinRelative(parentRelative, diskName);
        const entryAbs = path.join(abs, diskName);

        let ownerId = defaultOwnerId;
        let username = defaultUsername;
        if (parentId == null && isDir) {
            const matched = await lookupUserByFolderName(diskName);
            if (matched) {
                ownerId = matched.id;
                username = matched.username;
            }
        }

        // Prefer current path + username match; fall back to relative_path / parent+name
        let existing =
            (await FileManagerModel.findSiblingByName({
                parentId,
                name: diskName,
                username,
                filemanagerPath: fmPath,
            })) ||
            (await FileManagerModel.findByRelativePath(relativePath)) ||
            (await FileManagerModel.findChildByName({
                parentId,
                name: diskName,
            }));

        let size = null;
        let extension = null;
        try {
            const st = fs.statSync(entryAbs);
            size = isFile ? st.size : null;
            extension = isFile ? getExtension(diskName) : null;
        } catch {
            /* ignore */
        }

        if (!existing) {
            try {
                await FileManagerModel.create({
                    owner_id: ownerId,
                    username,
                    parent_id: parentId,
                    name: diskName,
                    item_type: isDir ? 'folder' : 'file',
                    storage_name: isFile ? diskName : null,
                    relative_path: relativePath,
                    filemanager_path: fmPath,
                    mime_type: null,
                    extension,
                    size,
                    created_by: actorUsername || username,
                    updated_by: actorUsername || username,
                });
            } catch (err) {
                // Unique race / stale row — ignore so GET children does not 500
                if (err?.code !== '23505') {
                    console.error('syncFsChildren create failed:', diskName, err.message);
                }
            }
            continue;
        }

        const existingPathNorm = String(existing.filemanager_path || '')
            .replace(/\\/g, '/')
            .replace(/\/+$/, '')
            .toLowerCase();
        const fmNorm = String(fmPath).toLowerCase();

        // Stale row from another FILEMANAGER_PATH: do not update path onto a
        // colliding unique key — soft-delete stale if current-path row exists.
        if (existingPathNorm && existingPathNorm !== fmNorm) {
            const currentPathRow = await FileManagerModel.findSiblingByName({
                parentId,
                name: diskName,
                username: existing.username || username,
                filemanagerPath: fmPath,
            });
            if (currentPathRow && Number(currentPathRow.id) !== Number(existing.id)) {
                try {
                    await FileManagerModel.softDelete(
                        existing.id,
                        actorUsername || username,
                    );
                } catch (err) {
                    console.error('syncFsChildren softDelete stale failed:', err.message);
                }
                continue;
            }
        }

        const patch = {};
        if (existingPathNorm !== fmNorm) {
            patch.filemanager_path = fmPath;
        }
        if (String(existing.relative_path || '').replace(/\\/g, '/') !== relativePath) {
            patch.relative_path = relativePath;
        }
        if (existing.parent_id == null && parentId == null) {
            if (Number(existing.owner_id) !== Number(ownerId)) patch.owner_id = ownerId;
            if (String(existing.username || '') !== String(username)) patch.username = username;
        }
        if (isFile && size != null && Number(existing.size) !== Number(size)) {
            patch.size = size;
        }
        if (Object.keys(patch).length) {
            try {
                await FileManagerModel.update(existing.id, {
                    ...patch,
                    updated_by: actorUsername || username,
                });
            } catch (err) {
                // Path/name unique conflict — soft-delete this stale row instead of 500
                if (err?.code === '23505') {
                    try {
                        await FileManagerModel.softDelete(
                            existing.id,
                            actorUsername || username,
                        );
                    } catch (softErr) {
                        console.error(
                            'syncFsChildren conflict softDelete failed:',
                            softErr.message,
                        );
                    }
                } else {
                    console.error('syncFsChildren update failed:', diskName, err.message);
                }
            }
        }
    }

    // Soft-delete leftover Microsoft Office lock files (~$...) already in DB
    try {
        const children = await FileManagerModel.findChildren(parentId);
        for (const child of children || []) {
            if (!isOfficeTempLockFile(child.name)) continue;
            try {
                await FileManagerModel.softDelete(
                    child.id,
                    actorUsername || child.username || 'system',
                );
            } catch (err) {
                console.error('syncFsChildren lock-file cleanup failed:', err.message);
            }
        }
    } catch (err) {
        console.error('syncFsChildren lock-file scan failed:', err.message);
    }
}

/**
 * File Manager owner_id / user_id = personal_details.id (login personalDetailsId),
 * NOT employment_details.id (JWT user.id).
 */
async function resolvePersonalDetailsIdForFileManager(req) {
    if (req?._fmPersonalDetailsId != null) {
        const cached = Number(req._fmPersonalDetailsId);
        if (Number.isFinite(cached) && cached > 0) return cached;
    }

    const u = req?.user || {};
    for (const key of [
        'personalDetailsId',
        'personal_details_id',
        'personalDetails_id',
    ]) {
        const n = Number(u?.[key]);
        if (Number.isFinite(n) && n > 0) {
            if (req) req._fmPersonalDetailsId = n;
            return n;
        }
    }

    const username = getUsernameFromReq(req);
    if (username) {
        const byName = await pool.query(
            `
            SELECT id
            FROM personal_details
            WHERE LOWER(TRIM(username)) = LOWER(TRIM($1))
            LIMIT 1
            `,
            [username],
        );
        if (byName.rows[0]?.id != null) {
            const n = Number(byName.rows[0].id);
            if (Number.isFinite(n) && n > 0) {
                if (req) req._fmPersonalDetailsId = n;
                return n;
            }
        }
    }

    const authId = getUserIdFromReq(req);
    if (authId != null) {
        // JWT id might already be personal_details.id
        const asPd = await pool.query(
            `SELECT id FROM personal_details WHERE id = $1 LIMIT 1`,
            [authId],
        );
        if (asPd.rows[0]?.id != null) {
            const n = Number(asPd.rows[0].id);
            if (Number.isFinite(n) && n > 0) {
                if (req) req._fmPersonalDetailsId = n;
                return n;
            }
        }

        // Map employment_details.id → personal_details_id
        const fromEmp = await pool.query(
            `
            SELECT personal_details_id
            FROM employment_details
            WHERE id = $1
            LIMIT 1
            `,
            [authId],
        );
        const pd = fromEmp.rows[0]?.personal_details_id;
        const n = Number(pd);
        if (Number.isFinite(n) && n > 0) {
            if (req) req._fmPersonalDetailsId = n;
            return n;
        }
    }

    return null;
}

async function resolveActor(req) {
    if (req?._fmActor) return req._fmActor;

    const ownerId = await resolvePersonalDetailsIdForFileManager(req);
    const username = getUsernameFromReq(req);
    const access = Number(req?.user?.access ?? 0);
    const isAdmin = access === 1;
    const actor = { ownerId, username, access, isAdmin };
    if (req) req._fmActor = actor;
    return actor;
}

function unauthorized(res) {
    return res.status(401).json({
        success: false,
        message: 'Authentication required (user id and username)',
    });
}

function notFound(res, message = 'Item not found') {
    return res.status(404).json({ success: false, message });
}

function forbid(res, message = 'Access denied') {
    return res.status(403).json({ success: false, message });
}

function canAccessItem(item, ownerId, isAdmin) {
    if (!item) return false;
    if (isAdmin) return true;
    return Number(item.owner_id) === Number(ownerId);
}

function assertOwner(item, ownerId, isAdmin = false) {
    return canAccessItem(item, ownerId, isAdmin);
}

/**
 * Duplicate when same parent + username + current FILEMANAGER_PATH.
 * Stale DB rows (missing on disk) are soft-deleted and not treated as duplicates.
 */
async function findActiveDuplicate({
    parentId,
    name,
    username,
    excludeId = null,
    anyScope = false,
}) {
    const fmPath = anyScope ? null : getFileManagerPathValue();
    const dup = await FileManagerModel.findSiblingByName({
        parentId,
        name,
        username: anyScope ? null : username,
        filemanagerPath: fmPath,
        excludeId,
        anyScope,
    });
    if (!dup) return null;

    // Google / cloud items have no NAS file — still a real duplicate
    if (isGoogleCloudItem(dup)) return dup;

    try {
        const abs = String(dup.absolute_path || '').trim()
            ? path.resolve(dup.absolute_path)
            : absolutePath(dup.relative_path);
        if (fs.existsSync(abs)) return dup;
    } catch {
        /* treat as stale */
    }

    await FileManagerModel.softDelete(dup.id, username || dup.username || null);
    return null;
}

function normalizeRelativePath(p) {
    return String(p || '')
        .replace(/\\/g, '/')
        .replace(/^\/+|\/+$/g, '');
}

function removeEmptyRecycleParents(startAbs) {
    const root = getStorageRoot();
    const rootNorm = normalizeFsPath(root);
    let current = path.resolve(startAbs);
    for (let i = 0; i < 8; i += 1) {
        const parent = path.dirname(current);
        const parentNorm = normalizeFsPath(parent);
        if (parentNorm === rootNorm || !parentNorm.startsWith(`${rootNorm}${path.sep}`)) {
            break;
        }
        if (!fs.existsSync(parent)) {
            current = parent;
            continue;
        }
        try {
            const entries = fs.readdirSync(parent);
            if (entries.length > 0) break;
            fs.rmdirSync(parent);
        } catch {
            break;
        }
        current = parent;
    }
}

/**
 * Soft-delete a file or folder tree into the *deleting user's* Recycle Bin.
 * Disk: FILEMANAGER_PATH/Recycle Bin/{deletedBy}/…
 * DB: parent_id of deleted root → Recycle Bin/{deletedBy} folder row
 *     original_path = pre-delete relative_path
 *     recycle_path = Recycle Bin/{deletedBy}/…
 * Item owner_id/username stay (settings owner); deleted_by = actor.
 * Project/system files must land in the deleter's bin so they appear in
 * "My Recycle Bin", not only the settings-owner folder.
 */
/** "photo(1).png" → "photo(2).png", "Docs" → "Docs(1)", "a.png" → "a(1).png". */
function nextIncrementedLeafName(leaf) {
    const name = String(leaf || '');
    const match = name.match(/^(.*)\((\d+)\)(\.[^.]+)?$/);
    if (match) {
        return `${match[1]}(${Number(match[2]) + 1})${match[3] || ''}`;
    }
    return incrementedRecycleLeafName(name, 1);
}

/** "photo.png" → "photo(1).png", "Docs" → "Docs(1)" (counter 0 = unchanged). */
function incrementedRecycleLeafName(leaf, counter) {
    const name = String(leaf || '');
    if (!counter) return name;
    const dotIdx = name.lastIndexOf('.');
    if (dotIdx > 0) {
        return `${name.slice(0, dotIdx)}(${counter})${name.slice(dotIdx)}`;
    }
    return `${name}(${counter})`;
}

async function softDeleteItem(item, actorUsername, actorOwnerId = null) {
    if (!item || item.is_deleted) {
        throw new Error('Item not found');
    }
    // Personal user root only — project/FY roots may be deleted when permitted
    if (item.parent_id == null && !isScopedTreeItem(item)) {
        throw new Error('Cannot delete the user root folder');
    }
    if (
        String(item.name || '').trim().toLowerCase() === RECYCLE_BIN_FOLDER.toLowerCase()
    ) {
        throw new Error('Cannot delete the Recycle Bin folder');
    }

    const deletedBy = ownFolderName(actorUsername);
    if (!deletedBy) {
        throw new Error('deleted_by username is required');
    }

    const oldRelative = normalizeRelativePath(item.relative_path);
    // Structural Recycle Bin folders (DB rows) — not soft-deleted recycle items
    if (
        !item.is_deleted &&
        !item.recycle_path &&
        (oldRelative.toLowerCase() === RECYCLE_BIN_FOLDER.toLowerCase() ||
            oldRelative
                .toLowerCase()
                .startsWith(`${RECYCLE_BIN_FOLDER.toLowerCase()}/`))
    ) {
        throw new Error('Cannot delete the Recycle Bin folder');
    }

    if (
        oldRelative.toLowerCase() === RECYCLE_BIN_FOLDER.toLowerCase() ||
        oldRelative.toLowerCase().startsWith(`${RECYCLE_BIN_FOLDER.toLowerCase()}/`)
    ) {
        throw new Error('Item is already in Recycle Bin');
    }

    // Bin folder = who deleted (self), not the item's settings/project owner
    const binUsername = deletedBy;
    const binOwnerId =
        actorOwnerId != null && Number.isFinite(Number(actorOwnerId))
            ? Number(actorOwnerId)
            : Number(item.owner_id);
    if (!Number.isFinite(binOwnerId) || binOwnerId <= 0) {
        throw new Error('Actor owner_id is required for Recycle Bin');
    }

    // Ensure that deleting user's Recycle Bin folder exists on disk + DB
    const fmPath = getFileManagerPathValue();
    ensureDir(absolutePath(RECYCLE_BIN_FOLDER));
    const userRecycleAbs = absolutePath(
        joinRelative(RECYCLE_BIN_FOLDER, binUsername),
    );
    ensureDir(userRecycleAbs);

    const { folder: userRecycleFolder } =
        await FileManagerModel.ensureUserRecycleBinFolder({
            ownerId: binOwnerId,
            username: binUsername,
            filemanagerPath: fmPath,
            updatedBy: deletedBy,
        });

    // Always store under Recycle Bin/{deletedBy}/…
    // Keep original relative structure under the deleter's bin (not item owner).
    const oldLower = oldRelative.toLowerCase();
    const binLower = binUsername.toLowerCase();
    let pathUnderUser = oldRelative;
    if (oldLower === binLower) {
        pathUnderUser = binUsername;
    } else if (oldLower.startsWith(`${binLower}/`)) {
        pathUnderUser = `${binUsername}/${oldRelative.slice(binUsername.length + 1)}`;
    } else {
        // Strip a leading personal-owner segment if present, then nest under deleter
        const itemOwnerSeg = ownFolderName(item.username || '');
        let rest = oldRelative;
        if (
            itemOwnerSeg &&
            oldLower.startsWith(`${itemOwnerSeg.toLowerCase()}/`)
        ) {
            rest = oldRelative.slice(itemOwnerSeg.length + 1);
        }
        pathUnderUser = joinRelative(binUsername, rest);
    }
    // Already in the bin with the same name? Keep deleting as
    // "name(1).ext", "name(2).ext", … instead of blocking with 409.
    const pathUnderUserParts = pathUnderUser.split('/').filter(Boolean);
    const baseLeaf = pathUnderUserParts[pathUnderUserParts.length - 1] || '';
    const parentParts = pathUnderUserParts.slice(0, -1);
    let recycleCounter = 0;
    let newRelative = joinRelative(RECYCLE_BIN_FOLDER, pathUnderUser);
    let newAbs = absolutePath(newRelative);
    while (
        fs.existsSync(newAbs) ||
        (await FileManagerModel.findDeletedByRecyclePath(newRelative))
    ) {
        recycleCounter += 1;
        const candidateLeaf = incrementedRecycleLeafName(
            baseLeaf,
            recycleCounter,
        );
        const candidatePathUnderUser = [...parentParts, candidateLeaf].join(
            '/',
        );
        newRelative = joinRelative(
            RECYCLE_BIN_FOLDER,
            candidatePathUnderUser,
        );
        newAbs = absolutePath(newRelative);
    }
    const recycleDisplayName =
        recycleCounter > 0
            ? incrementedRecycleLeafName(baseLeaf, recycleCounter)
            : null;

    // Project/FY items live under absolute_path; personal under FILEMANAGER_PATH
    let oldAbs;
    try {
        oldAbs = resolveItemDiskPath(item);
    } catch {
        oldAbs = absolutePath(oldRelative);
    }

    // Move local NAS objects. Google Sheet/Doc .url shortcuts are real files:
    // move the shortcut, or write it into the Recycle Bin if it was never saved.
    const shortcutSource = findExistingShortcutFile(item, oldAbs);
    if (shortcutSource && fs.existsSync(shortcutSource)) {
        if (
            path.resolve(shortcutSource).toLowerCase() !==
            path.resolve(newAbs).toLowerCase()
        ) {
            ensureDir(path.dirname(newAbs));
            safeMovePath(shortcutSource, newAbs);
        }
    } else if (isGoogleShortcutFile(item)) {
        writeInternetShortcutFile(newAbs, item.url);
    } else if (fs.existsSync(oldAbs)) {
        safeMovePath(oldAbs, newAbs);
    } else if (item.item_type === 'folder' && !isGoogleCloudItem(item)) {
        ensureDir(newAbs);
    }

    const deleted = await FileManagerModel.markMovedToRecycleBin(item.id, {
        deletedBy,
        oldRelativePrefix: oldRelative,
        newRelativePrefix: newRelative,
        recycleParentId: userRecycleFolder?.id || null,
        filemanagerPath: fmPath,
    });

    // Show the incremented name in the Recycle Bin (restore keeps this
    // current name — it does not revert to the original name).
    let deletedRoot =
        deleted.find((r) => Number(r.id) === Number(item.id)) ||
        deleted[0] ||
        null;
    if (recycleDisplayName && deletedRoot && !isGoogleCloudItem(item)) {
        try {
            deletedRoot =
                (await FileManagerModel.updateDeletedRootDisplayName(
                    item.id,
                    recycleDisplayName,
                )) || deletedRoot;
        } catch (renameErr) {
            console.warn(
                'Recycle Bin increment rename skipped:',
                renameErr?.message || renameErr,
            );
        }
    }

    if (deletedRoot && fs.existsSync(newAbs)) {
        const stamped = await FileManagerModel.setAbsolutePath(
            deletedRoot.id,
            newAbs,
        );
        if (stamped) deletedRoot.absolute_path = stamped.absolute_path;
    }

    return {
        deleted_count: deleted.length,
        item: deletedRoot,
    };
}

function isGoogleShortcutFile(item) {
    if (!item || String(item.item_type || '').toLowerCase() === 'folder') {
        return false;
    }
    const source = String(item.file_source || '')
        .trim()
        .toLowerCase();
    if (
        [
            'google_doc',
            'google_docs',
            'google_sheet',
            'google_sheets',
            'gdocs',
            'gdoc',
            'gsheet',
        ].includes(source)
    ) {
        return true;
    }
    const label = `${item.name || ''} ${item.storage_name || ''} ${item.relative_path || ''}`;
    return /\.url$/i.test(label) && Boolean(item.url || item.google_file_id);
}

function writeInternetShortcutFile(destAbs, url) {
    const target = String(url || '').trim();
    const dest = String(destAbs || '').trim();
    if (!target || !dest) return false;
    ensureDir(path.dirname(dest));
    fs.writeFileSync(dest, `[InternetShortcut]\r\nURL=${target}\r\n`, 'utf8');
    return true;
}

/** Locate a Google .url that was saved under another path than relative_path. */
function findExistingShortcutFile(item, preferredAbs) {
    const candidates = [];
    const push = (value) => {
        const text = String(value || '').trim();
        if (text) candidates.push(text);
    };
    push(preferredAbs);
    push(item?.absolute_path);
    const storage = String(item?.storage_name || '').trim();
    const rel = String(item?.original_path || item?.relative_path || '').trim();
    if (rel) {
        try {
            push(absolutePath(rel));
            if (storage) push(path.join(path.dirname(absolutePath(rel)), storage));
        } catch {
            /* ignore bad relative path */
        }
    }
    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
                return candidate;
            }
        } catch {
            /* ignore */
        }
    }
    return null;
}

async function ensureDeletedShortcutOnDisk(item) {
    if (!isGoogleShortcutFile(item)) return item;
    const rel = String(item.recycle_path || item.relative_path || '').trim();
    if (!rel) return item;
    let dest;
    try {
        dest = absolutePath(rel);
    } catch {
        return item;
    }
    if (!fs.existsSync(dest)) {
        const source = findExistingShortcutFile(item, null);
        if (source) {
            ensureDir(path.dirname(dest));
            safeMovePath(source, dest);
        } else if (item.url) {
            writeInternetShortcutFile(dest, item.url);
        }
    }
    if (fs.existsSync(dest)) {
        const stamped = await FileManagerModel.setAbsolutePath(item.id, dest);
        if (stamped?.absolute_path) item.absolute_path = stamped.absolute_path;
    }
    return item;
}

/**
 * Restore a Recycle Bin item back to original_path and clear deleted fields.
 * Re-attaches parent_id from original_path (was moved under Recycle Bin/{user}).
 */
async function restoreRecycleItem(item) {
    const originalRelative = normalizeRelativePath(item.original_path || item.relative_path);
    const recycleRelative = normalizeRelativePath(
        item.recycle_path || item.relative_path,
    );
    if (!originalRelative) {
        throw new Error('original_path is missing; cannot restore');
    }

    // Keep the current Recycle Bin name on restore — do NOT revert
    // "success(2).png" back to "success.png". The restored file/folder
    // is placed in the original parent folder with its bin leaf name.
    const originalParts = originalRelative.split('/').filter(Boolean);
    const parentDir = originalParts.slice(0, -1).join('/');
    const recycleParts = recycleRelative.split('/').filter(Boolean);
    let finalLeaf =
        recycleParts[recycleParts.length - 1] ||
        String(item.name || originalParts[originalParts.length - 1] || '');
    let restoredRelative = parentDir
        ? `${parentDir}/${finalLeaf}`
        : finalLeaf;

    // If that name is already taken in the original folder, go to the
    // next increment: success(2) → success(3), Docs → Docs(1), …
    while (
        (await FileManagerModel.findActiveByRelativePath(
            restoredRelative,
            getFileManagerPathValue(),
        )) ||
        fs.existsSync(absolutePath(restoredRelative))
    ) {
        finalLeaf = nextIncrementedLeafName(finalLeaf);
        restoredRelative = parentDir
            ? `${parentDir}/${finalLeaf}`
            : finalLeaf;
    }

    const recycleAbs = absolutePath(recycleRelative);
    const targetAbs = absolutePath(restoredRelative);

    if (fs.existsSync(recycleAbs)) {
        safeMovePath(recycleAbs, targetAbs);
        removeEmptyRecycleParents(path.dirname(recycleAbs));
    } else if (isGoogleShortcutFile(item) && item.url) {
        writeInternetShortcutFile(targetAbs, item.url);
    } else if (item.item_type === 'folder') {
        ensureDir(targetAbs);
    }

    const restored = await FileManagerModel.restoreFromRecycleBin(
        item.id,
        item.deleted_by,
    );

    // Re-link deleted root to its original parent folder (from original_path)
    let restoredRoot =
        restored.find((r) => Number(r.id) === Number(item.id)) || restored[0] || null;
    if (restoredRoot) {
        // Root (and descendants) now point at original_path — rewrite the
        // prefix when the kept bin name differs from the original name.
        if (restoredRelative !== originalRelative) {
            try {
                const rewritten =
                    await FileManagerModel.rewriteTreePathPrefixes({
                        id: item.id,
                        oldRelative: originalRelative,
                        newRelative: restoredRelative,
                    });
                restoredRoot =
                    rewritten.find((r) => Number(r.id) === Number(item.id)) ||
                    restoredRoot;
            } catch (rewriteErr) {
                console.warn(
                    'Restore path-prefix rewrite skipped:',
                    rewriteErr?.message || rewriteErr,
                );
            }
        }

        // Display name stays as the current bin name (e.g. success(2).png)
        if (finalLeaf && restoredRoot.name !== finalLeaf && !isGoogleCloudItem(item)) {
            try {
                const renamed = await FileManagerModel.update(
                    restoredRoot.id,
                    {
                        name: finalLeaf,
                        ...(String(restoredRoot.item_type || '').toLowerCase() ===
                        'file'
                            ? { storage_name: finalLeaf }
                            : {}),
                        updated_by:
                            item.deleted_by || restoredRoot.username,
                    },
                );
                if (renamed) {
                    restoredRoot.name = renamed.name;
                    if (renamed.storage_name != null) {
                        restoredRoot.storage_name = renamed.storage_name;
                    }
                }
            } catch (renameErr) {
                console.warn(
                    'Restore keep-name update skipped:',
                    renameErr?.message || renameErr,
                );
            }
        }

        const parts = restoredRelative.split('/').filter(Boolean);
        let parentId = null;
        if (parts.length > 1) {
            const parentRel = parts.slice(0, -1).join('/');
            const parent = await FileManagerModel.findActiveByRelativePath(
                parentRel,
                getFileManagerPathValue(),
            );
            parentId = parent?.id != null ? Number(parent.id) : null;
        }
        if (Number(restoredRoot.parent_id) !== parentId) {
            await FileManagerModel.update(restoredRoot.id, {
                parent_id: parentId,
                updated_by: item.deleted_by || restoredRoot.username,
            });
            restoredRoot.parent_id = parentId;
        }
        restoredRoot.relative_path = restoredRelative;
        if (fs.existsSync(targetAbs)) {
            const stamped = await FileManagerModel.setAbsolutePath(
                restoredRoot.id,
                targetAbs,
            );
            if (stamped?.absolute_path) {
                restoredRoot.absolute_path = stamped.absolute_path;
            }
        }
    }

    return {
        restored_count: restored.length,
        item: restoredRoot,
    };
}

/**
 * Move a file or folder into the Windows Recycle Bin.
 * fs.rm deletes it outright, so the operating system Recycle Bin stays empty.
 */
function sendToOperatingSystemRecycleBin(targetPath) {
    const target = path.resolve(String(targetPath || '').trim());
    if (!target || !fs.existsSync(target)) return false;

    if (process.platform === 'win32') {
        const isDir = fs.statSync(target).isDirectory();
        const method = isDir ? 'DeleteDirectory' : 'DeleteFile';
        const command = [
            'Add-Type -AssemblyName Microsoft.VisualBasic',
            `[Microsoft.VisualBasic.FileIO.FileSystem]::${method}($env:FM_RECYCLE_TARGET, 'OnlyErrorDialogs', 'SendToRecycleBin')`,
        ].join('; ');
        try {
            execFileSync(
                'powershell.exe',
                ['-NoProfile', '-NonInteractive', '-Command', command],
                {
                    env: { ...process.env, FM_RECYCLE_TARGET: target },
                    windowsHide: true,
                    timeout: 30000,
                },
            );
            if (!fs.existsSync(target)) return true;
        } catch (err) {
            console.warn(
                'Windows Recycle Bin move failed:',
                err?.message || err,
            );
        }
    }

    fs.rmSync(target, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
    });
    return false;
}

/**
 * Permanently remove a Recycle Bin item from disk and DB.
 */
async function permanentDeleteRecycleItem(item) {
    const recycleRelative = normalizeRelativePath(
        item.recycle_path || item.relative_path,
    );
    const recycleAbs = absolutePath(recycleRelative);

    if (fs.existsSync(recycleAbs)) {
        sendToOperatingSystemRecycleBin(recycleAbs);
        removeEmptyRecycleParents(path.dirname(recycleAbs));
    }

    const deleted = await FileManagerModel.permanentDeleteFromRecycleBin(
        item.id,
        item.deleted_by,
    );
    return {
        deleted_count: deleted.length,
        item: deleted.find((r) => Number(r.id) === Number(item.id)) || deleted[0] || null,
    };
}

/**
 * Permanently remove any file/folder from disk + DB (no Recycle Bin).
 * Handles active items (relative/absolute path) and already-binned items
 * (recycle_path). Folder deletes remove the whole tree.
 */
async function permanentDeleteItemForever(item) {
    if (!item) {
        throw new Error('Item not found');
    }
    if (item.parent_id == null && !isScopedTreeItem(item)) {
        const err = new Error('Cannot permanently delete the user root folder');
        err.status = 400;
        throw err;
    }
    const nameNorm = String(item.name || '').trim().toLowerCase();
    const relNorm = normalizeRelativePath(item.relative_path).toLowerCase();
    if (
        !item.is_deleted &&
        (nameNorm === RECYCLE_BIN_FOLDER.toLowerCase() ||
            relNorm === RECYCLE_BIN_FOLDER.toLowerCase() ||
            relNorm.startsWith(`${RECYCLE_BIN_FOLDER.toLowerCase()}/`))
    ) {
        const err = new Error('Cannot permanently delete the Recycle Bin folder');
        err.status = 400;
        throw err;
    }

    // Disk path: binned items live at recycle_path, others at their live path
    let diskAbs = null;
    try {
        diskAbs = item.is_deleted
            ? resolveItemAbsoluteFilePath(item, { recycle: true })
            : resolveItemDiskPath(item);
    } catch {
        const fallbackRel = item.is_deleted
            ? item.recycle_path || item.relative_path
            : item.relative_path;
        try {
            diskAbs = fallbackRel ? absolutePath(fallbackRel) : null;
        } catch {
            diskAbs = String(item.absolute_path || '').trim()
                ? path.resolve(item.absolute_path)
                : null;
        }
    }

    if (diskAbs && fs.existsSync(diskAbs)) {
        sendToOperatingSystemRecycleBin(diskAbs);
        if (item.is_deleted) {
            try {
                removeEmptyRecycleParents(path.dirname(diskAbs));
            } catch {
                /* ignore */
            }
        }
    }

    const deleted = await FileManagerModel.permanentDeleteTree(item.id);
    return {
        deleted_count: deleted.length,
        item: {
            id: item.id,
            public_id: item.public_id || null,
            name: item.name,
            item_type: item.item_type,
            parent_id: item.parent_id ?? null,
        },
    };
}

/** Own folder name is always derived from username — never a custom duplicate root. */
function ownFolderName(username) {
    return sanitizeFolderName(username);
}

/**
 * Find the user's single root folder (by owner, or matching username folder name).
 * Does not create anything.
 */
async function findExistingOwnRoot(ownerId, username) {
    const safeName = ownFolderName(username);
    const fmPath = getFileManagerPathValue();

    let root = await FileManagerModel.findRootByOwner(ownerId, fmPath);
    if (root) return root;

    // Fallback: any root for owner (may be old path) — only if relative name matches
    root = await FileManagerModel.findRootByOwner(ownerId);
    if (root) {
        const absOk = (() => {
            try {
                const abs = absolutePath(root.relative_path);
                return fs.existsSync(abs);
            } catch {
                return false;
            }
        })();
        if (absOk) {
            return FileManagerModel.update(root.id, {
                filemanager_path: fmPath,
                updated_by: username,
            });
        }
    }

    root =
        (await FileManagerModel.findByRelativePath(safeName)) ||
        (await FileManagerModel.findChildByName({
            parentId: null,
            name: safeName,
        }));

    if (!root) return null;

    // Same username folder on disk/DB — claim for this user if needed
    if (
        String(root.name).toLowerCase() === String(safeName).toLowerCase()
    ) {
        if (
            Number(root.owner_id) !== Number(ownerId) ||
            normalizeFmPath(root.filemanager_path) !== normalizeFmPath(fmPath)
        ) {
            root = await FileManagerModel.update(root.id, {
                owner_id: ownerId,
                username,
                filemanager_path: fmPath,
                updated_by: username,
            });
        }
        return root;
    }

    return null;
}

class FileManagerController {
    /* ================= USER ROOT ================= */

    /** Check whether the logged-in user already has a root folder (no create). */
    static async getMyFolder(req, res) {
        try {
            const { ownerId, username, isAdmin } = await resolveActor(req);
            if (ownerId == null || !username) return unauthorized(res);

            await syncFsChildren({
                parentId: null,
                parentRelative: '',
                defaultOwnerId: ownerId,
                defaultUsername: username,
                actorUsername: username,
            });

            const safeName = ownFolderName(username);
            const root = await findExistingOwnRoot(ownerId, username);

            if (!root) {
                return res.json({
                    success: true,
                    exists: false,
                    data: null,
                    suggested_name: safeName,
                    filemanager_path: getFileManagerPathValue(),
                    is_admin: isAdmin,
                    message: 'Your folder was not found. You can create it.',
                });
            }

            // Only treat as "exists" if the folder is still on disk under FILEMANAGER_PATH
            let abs = null;
            try {
                abs = absolutePath(root.relative_path);
            } catch {
                abs = null;
            }
            if (!abs || !fs.existsSync(abs)) {
                return res.json({
                    success: true,
                    exists: false,
                    data: null,
                    suggested_name: safeName,
                    filemanager_path: getFileManagerPathValue(),
                    is_admin: isAdmin,
                    message: 'Your folder was not found on disk. You can create it.',
                });
            }

            await syncFsChildren({
                parentId: root.id,
                parentRelative: root.relative_path,
                defaultOwnerId: Number(root.owner_id),
                defaultUsername: root.username || username,
                actorUsername: username,
            });

            return res.json({
                success: true,
                exists: true,
                data: attachItemAccess(root, { ownerId, username, isAdmin }),
                storage_path: abs,
                filemanager_path: getFileManagerPathValue(),
                is_admin: isAdmin,
            });
        } catch (error) {
            console.error('getMyFolder error:', error);
            return res.status(500).json({
                success: false,
                message: error.message || 'Failed to check user folder',
            });
        }
    }

 
 

    /* ================= FOLDERS ================= */
   

    static async getFolder(req, res) {
        try {
            const actor = await resolveActor(req);
            const { ownerId, isAdmin } = actor;
            if (ownerId == null) return unauthorized(res);

            const item = await FileManagerModel.findByIdOrPublicId(
                req.params.id,
                {
                    anyScope: true,
                },
            );
            if (!item || item.item_type !== 'folder') {
                return notFound(res, 'Folder not found');
            }
            if (!(await canAccessItemForRead(item, actor))) {
                return forbid(res);
            }

            return res.json({
                success: true,
                data: await attachItemAccessResolved(item, actor),
            });
        } catch (error) {
            console.error('getFolder error:', error);
            return res.status(500).json({
                success: false,
                message: error.message || 'Failed to get folder',
            });
        }
    }

    static async updateFolder(req, res) {
        try {
            const { ownerId, username, isAdmin } = await resolveActor(req);
            if (ownerId == null || !username) return unauthorized(res);

            const actor = { ownerId, username, isAdmin };
            const item = await FileManagerModel.findById(req.params.id, {
                anyScope: true,
            });
            if (!item || item.item_type !== 'folder') {
                return notFound(res, 'Folder not found');
            }
            if (!(await canAccessItemForWrite(item, actor))) {
                return forbid(res);
            }

            // Personal root only — project/FY roots may be renamed by editors
            if (item.parent_id == null && !isScopedTreeItem(item)) {
                return res.status(400).json({
                    success: false,
                    message: 'Cannot rename the user root folder',
                });
            }

            const name = sanitizeFolderName(req.body?.name);
            if (!name) {
                return res.status(400).json({
                    success: false,
                    message: 'Folder name is required',
                });
            }
            if (name.toLowerCase() === RECYCLE_BIN_FOLDER.toLowerCase()) {
                return res.status(400).json({
                    success: false,
                    message: `"${RECYCLE_BIN_FOLDER}" is a reserved system folder`,
                });
            }

            const scoped = isScopedTreeItem(item);
            const itemOwnerId = Number(item.owner_id);
            const duplicate = await findActiveDuplicate({
                parentId: item.parent_id,
                name,
                username: item.username || username,
                excludeId: item.id,
                anyScope: scoped,
            });
            if (duplicate) {
                return res.status(409).json({
                    success: false,
                    message: 'A folder or file with this name already exists here',
                });
            }

            const parent =
                item.parent_id != null
                    ? await FileManagerModel.findById(item.parent_id, {
                          anyScope: true,
                      })
                    : null;
            if (item.parent_id != null && !parent) {
                return notFound(res, 'Parent folder not found');
            }

            const oldRelative = item.relative_path;
            const newRelative = parent
                ? joinRelative(parent.relative_path, name)
                : name;

            let oldAbs = null;
            let newAbs = null;
            if (oldRelative !== newRelative) {
                oldAbs = resolveItemDiskPath(item);
                newAbs = scoped
                    ? path.join(
                          parent
                              ? resolveItemAbsoluteDir(parent)
                              : path.dirname(oldAbs),
                          name,
                      )
                    : absolutePath(newRelative);
                if (fs.existsSync(oldAbs)) {
                    safeMovePath(oldAbs, newAbs);
                } else {
                    ensureDir(newAbs);
                }
                await FileManagerModel.updatePathPrefixes({
                    oldRelative,
                    newRelative,
                    oldAbsolute: oldAbs,
                    newAbsolute: newAbs,
                    rootId: scoped
                        ? item.scope_root_id || item.id
                        : null,
                    ownerId: scoped ? null : itemOwnerId,
                });
            }

            const updated = await FileManagerModel.update(item.id, {
                name,
                relative_path: newRelative,
                ...(newAbs ? { absolute_path: newAbs } : {}),
                ...(scoped
                    ? {}
                    : { filemanager_path: getFileManagerPathValue() }),
                updated_by: username,
            });

            await writeFileManagerLog({
                action: 'UPDATE',
                entityType: 'folder',
                itemId: item.id,
                itemName: name,
                fieldName: 'name',
                oldValue: item.name,
                newValue: name,
                updatedBy: username,
                updatedByUserId: ownerId,
            });

            return res.json({
                success: true,
                data: attachItemAccess(updated, actor),
            });
        } catch (error) {
            console.error('updateFolder error:', error);
            return res.status(500).json({
                success: false,
                message: error.message || 'Failed to update folder',
            });
        }
    }

    static async deleteFolder(req, res) {
        try {
            const { ownerId, username, isAdmin } = await resolveActor(req);
            if (ownerId == null || !username) return unauthorized(res);

            const actor = { ownerId, username, isAdmin };
            const item = await FileManagerModel.findById(req.params.id, {
                anyScope: true,
            });
            if (!item || item.item_type !== 'folder') {
                return notFound(res, 'Folder not found');
            }
            if (!(await canAccessItemForWrite(item, actor))) {
                return forbid(res);
            }

            if (item.parent_id == null && !isScopedTreeItem(item)) {
                return res.status(400).json({
                    success: false,
                    message: 'Cannot delete the user root folder',
                });
            }

            const result = await softDeleteItem(item, username, ownerId);
            await writeFileManagerLog({
                action: 'DELETE',
                entityType: 'folder',
                itemId: item.id,
                itemName: item.name,
                fieldName: 'folder',
                oldValue: item.name,
                newValue: null,
                updatedBy: username,
                updatedByUserId: ownerId,
            });
            return res.json({
                success: true,
                message: 'Folder moved to Recycle Bin',
                data: {
                    deleted_count: result.deleted_count,
                    item: result.item,
                },
            });
        } catch (error) {
            console.error('deleteFolder error:', error);
            const status = error.status || (
                /Cannot delete|deleted_by|already in Recycle Bin/i.test(error.message || '') ? 400 : 500
            );
            return res.status(status).json({
                success: false,
                message: error.message || 'Failed to delete folder',
            });
        }
    }

    static async getFolderChildren(req, res) {
        try {
            const { ownerId, username, isAdmin } = await resolveActor(req);
            if (ownerId == null) return unauthorized(res);

            const actor = { ownerId, username, isAdmin };

            const folderId = Number(req.params.id);
            if (!Number.isFinite(folderId) || folderId <= 0) {
                return notFound(res, 'Folder not found');
            }

            // Prefer any-scope lookup (unified project / FY / personal rows)
            let folder = await FileManagerModel.findById(folderId, {
                anyScope: true,
            });
            // Soft-deleted Recycle Bin folders (e.g. Recycle Bin/GPV/SQL) must still open
            if (!folder) {
                folder = await FileManagerModel.findById(folderId, {
                    includeDeleted: true,
                    anyScope: true,
                });
            }
            if (
                !folder ||
                String(folder.item_type || '')
                    .trim()
                    .toLowerCase() !== 'folder'
            ) {
                return notFound(res, 'Folder not found');
            }

            const scope = String(folder.scope || 'file_manager')
                .trim()
                .toLowerCase();
            const isScopedTree =
                scope === 'project' ||
                scope === 'financial_year' ||
                folder.scope_root_id != null ||
                folder.project_id != null ||
                folder.financial_year_id != null ||
                Boolean(folder.project_code);
            const isPersonalScope = !isScopedTree;

            // Project/FY rows wrongly soft-deleted by personal-root cleanup —
            // revive on open when there is no recycle_path.
            if (
                folder.is_deleted &&
                isScopedTree &&
                !folder.recycle_path
            ) {
                folder =
                    (await FileManagerModel.reviveIfWronglySoftDeleted(
                        folderId,
                    )) || folder;
            }

            const inRecycle =
                Boolean(folder.is_deleted && folder.recycle_path) ||
                isRecycleBinPath(folder.relative_path) ||
                isRecycleBinPath(folder.recycle_path);

            if (folder.is_deleted) {
                if (!folder.recycle_path || !inRecycle) {
                    return notFound(res, 'Folder not found');
                }
                const deletedBy = String(folder.deleted_by || '')
                    .trim()
                    .toLowerCase();
                const actorName = String(username || '').trim().toLowerCase();
                if (
                    !isAdmin &&
                    Number(folder.owner_id) !== Number(ownerId) &&
                    deletedBy !== actorName
                ) {
                    return forbid(res);
                }
            } else if (isPersonalScope) {
                if (!assertOwner(folder, ownerId, isAdmin)) {
                    return forbid(res);
                }
            } else if (!(await canViewScopedFolder(folder, actor))) {
                return forbid(res);
            }

            // Personal NAS: sync disk→DB (skip Recycle Bin)
            if (isPersonalScope && !inRecycle) {
                try {
                    await syncFsChildren({
                        parentId: folder.id,
                        parentRelative: folder.relative_path,
                        defaultOwnerId: Number(folder.owner_id),
                        defaultUsername: folder.username || '',
                        actorUsername:
                            getUsernameFromReq(req) || folder.username || '',
                    });
                } catch (syncErr) {
                    console.error(
                        'getFolderChildren sync skipped:',
                        syncErr.message,
                    );
                }
            }

            // Project / FY: register physical disk folders into DB automatically
            if (!isPersonalScope && !inRecycle) {
                try {
                    const {
                        syncProjectFolderLevelFromDisk,
                        ensureProjectRootFromDisk,
                    } = await import('./projectFileManager.controller.js');
                    const actorName =
                        getUsernameFromReq(req) || folder.username || 'system';

                    if (scope === 'financial_year') {
                        const fyAbs = String(folder.absolute_path || '').trim();
                        const fyCode = String(
                            folder.year_code || folder.financial_year || '',
                        ).trim();
                        if (fyAbs && fs.existsSync(fyAbs) && fyCode) {
                            const projectRoots =
                                await ProjectFileManagerModel.listRootsByParentId(
                                    folder.id,
                                );
                            const known = new Set(
                                (projectRoots || []).map((r) =>
                                    String(
                                        r.folder_name ||
                                            r.name ||
                                            r.project_code ||
                                            '',
                                    )
                                        .trim()
                                        .toLowerCase(),
                                ),
                            );
                            for (const child of listDiskChildren(
                                path.resolve(fyAbs),
                            )) {
                                if (child.item_type !== 'folder') continue;
                                const key = String(child.name || '')
                                    .trim()
                                    .toLowerCase();
                                if (!key || known.has(key)) continue;
                                const registered =
                                    await ensureProjectRootFromDisk({
                                        folderName: child.name,
                                        absolutePath: child.absolute_path,
                                        fyFolderId: folder.id,
                                        financialYear: fyCode,
                                        assignedByUsername: actorName,
                                    });
                                if (registered?.id) known.add(key);
                            }
                        }
                    } else {
                        const rootId =
                            folder.scope_root_id != null
                                ? Number(folder.scope_root_id)
                                : Number(folder.id);
                        let projectRoot =
                            folder.scope_root_id != null
                                ? await ProjectFileManagerModel.findById(rootId)
                                : await ProjectFileManagerModel.findById(
                                      folder.id,
                                  );
                        if (!projectRoot && folder.scope_root_id == null) {
                            projectRoot = folder;
                        }
                        const parentAbs = String(
                            folder.absolute_path || '',
                        ).trim();
                        if (
                            projectRoot?.id &&
                            parentAbs &&
                            fs.existsSync(parentAbs)
                        ) {
                            await syncProjectFolderLevelFromDisk({
                                projectRoot,
                                parentItemId: folder.id,
                                parentAbsolutePath: parentAbs,
                                parentRelativePath:
                                    folder.relative_path || null,
                            });
                        }
                    }
                } catch (syncErr) {
                    console.warn(
                        'getFolderChildren project/FY disk→DB sync skipped:',
                        syncErr?.message || syncErr,
                    );
                }
            }

            // Recycle Bin must list project/FY deletes too (they keep scope=project)
            const childRows = await FileManagerModel.findChildren(
                        folder.id,
                isPersonalScope && !isAdmin && !inRecycle ? ownerId : null,
                isPersonalScope && !inRecycle
                    ? getFileManagerPathValue()
                    : null,
                {
                    includeDeleted: inRecycle,
                    anyScope: !isPersonalScope || inRecycle,
                },
            );

            // Recycle Bin/{username}: also include deletes whose parent_id was not
            // re-linked (legacy) but recycle_path is under this user bin.
            let recycleExtra = [];
            const recycleUserFolder =
                inRecycle &&
                !folder.is_deleted &&
                normalizeRelativePath(folder.relative_path)
                    .toLowerCase()
                    .startsWith(`${RECYCLE_BIN_FOLDER.toLowerCase()}/`) &&
                !normalizeRelativePath(folder.relative_path)
                    .slice(RECYCLE_BIN_FOLDER.length + 1)
                    .includes('/');
            if (recycleUserFolder) {
                const binUser = String(folder.username || folder.name || '')
                    .trim();
                if (binUser) {
                    try {
                        recycleExtra =
                            await FileManagerModel.findRecycleBinItems({
                                username: binUser,
                                filemanagerPath: getFileManagerPathValue(),
                            });
                    } catch (extraErr) {
                        console.warn(
                            'getFolderChildren recycle merge skipped:',
                            extraErr?.message || extraErr,
                        );
                    }
                }
            }

            const byId = new Map();
            for (const row of [...(childRows || []), ...(recycleExtra || [])]) {
                const id = Number(row?.id);
                if (!id || byId.has(id)) continue;
                byId.set(id, row);
            }

            let children = attachListAccess(
                attachListMeta(
                    filterExistingOnDisk([...byId.values()], {
                        allowMissingDisk: inRecycle || !isPersonalScope,
                    }),
                ),
                actor,
            );

            // At personal root: also surface accessible project + FY roots
            // (those roots keep parent_id = null in their own rows)
            let project_fy_count = 0;
            if (
                isPersonalScope &&
                !inRecycle &&
                isUserPersonalRootFolder(folder, actor)
            ) {
                try {
                    const external = await loadAccessibleProjectAndFyFolders(
                        actor,
                    );
                    project_fy_count = (external || []).length;
                    children = [...children, ...(external || [])];
                } catch (mergeErr) {
                    console.error(
                        'getFolderChildren project/FY merge skipped:',
                        mergeErr.message,
                    );
                }
            }

            const folderAccess = isPersonalScope
                ? buildOwnerAccess(isItemOwner(folder, actor))
                : buildShareAccessFromRow({
                      role: folder.role || folder.access?.role || 'viewer',
                      is_owner: isItemOwner(folder, actor),
                  });

            // Optional filter: item_type=folder|file
            const itemTypeRaw = String(req.query.item_type || '')
                .trim()
                .toLowerCase();
            if (itemTypeRaw === 'folder' || itemTypeRaw === 'file') {
                children = children.filter(
                    (row) =>
                        String(row?.item_type || '')
                            .trim()
                            .toLowerCase() === itemTypeRaw,
                );
            }

            const total = children.length;
            const rawLimit = Number(req.query.limit ?? req.query.page_size);
            const rawPage = Number(req.query.page ?? 1);
            const limit = Number.isFinite(rawLimit)
                ? Math.min(Math.max(Math.trunc(rawLimit), 1), 200)
                : 48;
            const page = Number.isFinite(rawPage)
                ? Math.max(Math.trunc(rawPage), 1)
                : 1;
            const totalPages = Math.max(1, Math.ceil(total / limit) || 1);
            const safePage = Math.min(page, totalPages);
            const offset = (safePage - 1) * limit;
            const pageRows = children.slice(offset, offset + limit);
            const hasMore = offset + pageRows.length < total;

            const dataWithCreator = await attachCreatedByUser(pageRows);

            return res.json({
                success: true,
                data: dataWithCreator,
                folder: {
                    ...attachItemAccess(folder, actor),
                    access: folderAccess,
                },
                access: folderAccess,
                filemanager_path: getFileManagerPathValue(),
                is_admin: isAdmin,
                is_recycle_bin: inRecycle,
                pagination: {
                    page: safePage,
                    limit,
                    total,
                    total_pages: totalPages,
                    has_more: hasMore,
                    offset,
                },
                meta: {
                    scope,
                    project_fy_count,
                    includes_project_and_financial_year: project_fy_count > 0,
                    item_type: itemTypeRaw || null,
                },
            });
        } catch (error) {
            console.error('getFolderChildren error:', error);
            return res.status(500).json({
                success: false,
                message: error.message || 'Failed to list folder children',
            });
        }
    }

    /* ================= FILES ================= */
    static async uploadFile(req, res) {
        try {
            const { ownerId, username, isAdmin } = await resolveActor(req);
            if (ownerId == null || !username) return unauthorized(res);

            const fieldFiles = req.files && typeof req.files === 'object'
                ? req.files
                : {};
            const files = [
                ...(Array.isArray(fieldFiles.file) ? fieldFiles.file : []),
                ...(Array.isArray(fieldFiles.files) ? fieldFiles.files : []),
                ...(req.file ? [req.file] : []),
            ];

            if (!files.length) {
                return res.status(400).json({
                    success: false,
                    message:
                        'At least one file is required (field name: file or files)',
                });
            }

            let parentId = req.body?.parent_id != null
                ? Number(req.body.parent_id)
                : null;

            const actor = { ownerId, username, isAdmin };
            let parent = null;
            if (parentId == null || Number.isNaN(parentId)) {
                parent = await FileManagerModel.findRootByOwner(
                    ownerId,
                    getFileManagerPathValue(),
                );
                if (!parent) {
                    return res.status(400).json({
                        success: false,
                        message: 'User root folder not found. Call POST /my-folder first.',
                    });
                }
            } else {
                const resolved = await resolveWritableParent(parentId, actor);
                if (resolved.error === 'not_found') {
                    return notFound(res, 'Parent folder not found');
                }
                if (resolved.error === 'forbid') return forbid(res);
                parent = resolved.parent;
            }

            const scopedParent = isScopedTreeItem(parent);
            const targetOwnerId = Number(parent.owner_id);
            const targetUsername = String(parent.username || username).trim() || username;
            // Optional override only applies when uploading a single file
            const singleNameOverride =
                files.length === 1
                    ? sanitizeFolderName(req.body?.name || '')
                    : '';

            const uploaded = [];
            const skipped = [];
            const errors = [];

            for (const file of files) {
                try {
                    const displayName = sanitizeFolderName(
                        singleNameOverride || file.originalname || 'upload',
                    );
                    if (!displayName) {
                        skipped.push({
                            name: file.originalname || null,
                            reason: 'File name is required',
                        });
                        continue;
                    }

                    const duplicate = await findActiveDuplicate({
                        parentId: parent.id,
                        name: displayName,
                        username: targetUsername,
                        anyScope: scopedParent,
                    });
                    if (duplicate) {
                        skipped.push({
                            name: displayName,
                            reason: 'A folder or file with this name already exists here',
                        });
                        cleanupUploadedTempFile(file);
                        continue;
                    }

                    const extension =
                        getExtension(file.originalname) || getExtension(displayName);
                    const storageName = displayName;
                    const relativePath = joinRelative(parent.relative_path, storageName);
                    const abs = scopedParent
                        ? path.join(resolveItemAbsoluteDir(parent), storageName)
                        : absolutePath(relativePath);
                    ensureDir(path.dirname(abs));
                    if (fs.existsSync(abs)) {
                        skipped.push({
                            name: displayName,
                            reason: 'A file with this name already exists on storage',
                        });
                        cleanupUploadedTempFile(file);
                        continue;
                    }

                    await persistUploadedFile(file, abs);

                    let created;
                    if (scopedParent) {
                        created = await createScopedUploadedFile({
                            parent,
                            displayName,
                            storageName,
                            relativePath,
                            absolutePath: abs,
                            mimeType: file.mimetype || null,
                            extension,
                            size: file.size ?? file.buffer?.length ?? null,
                            actorUsername: username,
                            actorUserId: ownerId,
                        });
                    } else {
                        created = await FileManagerModel.create({
                        owner_id: targetOwnerId,
                        username: targetUsername,
                        parent_id: parent.id,
                        name: displayName,
                        item_type: 'file',
                        storage_name: storageName,
                        relative_path: relativePath,
                        filemanager_path: getFileManagerPathValue(),
                        mime_type: file.mimetype || null,
                        extension,
                        size: file.size ?? file.buffer?.length ?? null,
                        created_by: username,
                        updated_by: username,
                    });
                    }
                    uploaded.push(created);
                } catch (err) {
                    cleanupUploadedTempFile(file);
                    errors.push({
                        name: file?.originalname || null,
                        reason: err?.message || 'Failed to upload file',
                    });
                }
            }

            const counts = {
                uploaded: uploaded.length,
                skipped: skipped.length,
                errors: errors.length,
                total_files: files.length,
            };

            if (!uploaded.length) {
                const status = errors.length ? 500 : 409;
                return res.status(status).json({
                    success: false,
                    message:
                        skipped[0]?.reason ||
                        errors[0]?.reason ||
                        'No files were uploaded',
                    data: [],
                    skipped,
                    errors,
                    counts,
                });
            }

            // Backward compatible: one successful file → single object in `data`
            if (uploaded.length === 1 && !skipped.length && !errors.length) {
                return res.status(201).json({
                    success: true,
                    data: await attachCreatedByUserOne(uploaded[0]),
                    counts,
                });
            }

            return res.status(201).json({
                success: true,
                data: await attachCreatedByUser(uploaded),
                skipped,
                errors,
                counts,
                message: `${counts.uploaded} of ${counts.total_files} file(s) uploaded`,
            });
        } catch (error) {
            console.error('uploadFile error:', error);
            return res.status(500).json({
                success: false,
                message: error.message || 'Failed to upload file',
            });
        }
    }

    /**
     * Upload a whole folder (multiple files + relative paths).
     * multipart: files[] (optional when the folder is empty), paths[] (or paths JSON),
     * parent_id, optional folder_name.
     * A path ending with "/" is a folder and is created even when it has no file.
     */
    static async uploadFolder(req, res) {
        try {
            const { ownerId, username, isAdmin } = await resolveActor(req);
    
            if (ownerId == null || !username) {
                for (const file of Array.isArray(req.files) ? req.files : []) {
                    cleanupUploadedTempFile(file);
                }
                return unauthorized(res);
            }
    
            const files = Array.isArray(req.files) ? req.files : [];
    
            let parentId =
                req.body?.parent_id != null
                    ? Number(req.body.parent_id)
                    : null;
    
            const actor = { ownerId, username, isAdmin };
            let parent = null;
    
            if (parentId == null || Number.isNaN(parentId)) {
                parent = await FileManagerModel.findRootByOwner(
                    ownerId,
                    getFileManagerPathValue()
                );
    
                if (!parent) {
                    for (const file of files) cleanupUploadedTempFile(file);
                    return res.status(400).json({
                        success: false,
                        message:
                            'User root folder not found. Call POST /my-folder first.',
                    });
                }
            } else {
                const resolved = await resolveWritableParent(parentId, actor);
                if (resolved.error === 'not_found') {
                    for (const file of files) cleanupUploadedTempFile(file);
                    return notFound(res, 'Parent folder not found');
                }
                if (resolved.error === 'forbid') {
                    for (const file of files) cleanupUploadedTempFile(file);
                    return forbid(res);
                }
                parent = resolved.parent;
            }
            const scopedParent = isScopedTreeItem(parent);
    
            const targetOwnerId = Number(parent.owner_id);
            const targetUsername =
                String(parent.username || username).trim() || username;
    
            const fmPath = getFileManagerPathValue();
    
            // ---------------------------------------------------------
            // Optional wrapper folder
            // ---------------------------------------------------------
    
            const wrapperName = sanitizeFolderName(
                req.body?.folder_name || ''
            );
            let createdWrapper = null;
    
            if (wrapperName) {
                let wrapper = await findActiveDuplicate({
                    parentId: parent.id,
                    name: wrapperName,
                    username: targetUsername,
                    anyScope: scopedParent,
                });
    
                if (wrapper && wrapper.item_type !== 'folder') {
                    for (const file of files) cleanupUploadedTempFile(file);
                    return res.status(409).json({
                        success: false,
                        message: `A file named "${wrapperName}" already exists here`,
                    });
                }
    
                if (!wrapper) {
                    const relativePath = joinRelative(
                        parent.relative_path,
                        wrapperName
                    );
    
                    const abs = scopedParent
                        ? path.join(resolveItemAbsoluteDir(parent), wrapperName)
                        : absolutePath(relativePath);
    
                    ensureDir(abs);
    
                    wrapper = scopedParent
                        ? await createScopedUploadedFolder({
                              parent,
                              name: wrapperName,
                              relativePath,
                              absolutePath: abs,
                              actorUsername: username,
                              actorUserId: ownerId,
                          })
                        : await FileManagerModel.create({
                        owner_id: targetOwnerId,
                        username: targetUsername,
                        parent_id: parent.id,
                        name: wrapperName,
                        item_type: 'folder',
                        storage_name: null,
                        relative_path: relativePath,
                        filemanager_path: fmPath,
                        created_by: username,
                        updated_by: username,
                    });
                    createdWrapper = wrapper;
                }
    
                parent = wrapper;
            }
    
            // ---------------------------------------------------------
            // Parse folder paths
            // ---------------------------------------------------------
    
            let pathsRaw =
                req.body?.paths ??
                req.body?.['paths[]'] ??
                null;
    
            let paths = [];
    
            if (typeof pathsRaw === 'string') {
                const trimmed = pathsRaw.trim();
    
                if (trimmed.startsWith('[')) {
                    try {
                        paths = JSON.parse(trimmed);
                    } catch {
                        paths = [trimmed];
                    }
                } else {
                    paths = [trimmed];
                }
            } else if (Array.isArray(pathsRaw)) {
                paths = pathsRaw;
            }
    
            const folderPaths = [];
            const filePaths = [];
            for (const entry of paths) {
                const text = String(entry ?? '').replace(/\\/g, '/');
                if (text.trim().endsWith('/')) folderPaths.push(text);
                else filePaths.push(text);
            }
            paths = filePaths;

            if (paths.length && files.length && paths.length !== files.length) {
                for (const file of files) cleanupUploadedTempFile(file);
                return res.status(400).json({
                    success: false,
                    message: `paths length (${paths.length}) must match files length (${files.length})`,
                });
            }

            if (!files.length && !folderPaths.length && !wrapperName) {
                return res.status(400).json({
                    success: false,
                    message: 'Files or folder_name are required',
                });
            }
    
            // ---------------------------------------------------------
            // Folder cache
            // ---------------------------------------------------------
    
            const folderCache = new Map();
    
            folderCache.set(
                String(parent.relative_path).replace(/\\/g, '/'),
                parent
            );
    
            async function ensureFolderUnder(baseFolder, folderName) {
                const name = sanitizeFolderName(folderName);
    
                if (!name) {
                    return {
                        folder: baseFolder,
                        created: false,
                    };
                }
    
                const relativePath = joinRelative(
                    baseFolder.relative_path,
                    name
                );
    
                const cacheKey = relativePath.replace(/\\/g, '/');
    
                if (folderCache.has(cacheKey)) {
                    return {
                        folder: folderCache.get(cacheKey),
                        created: false,
                    };
                }
    
                let existing = await findActiveDuplicate({
                    parentId: baseFolder.id,
                    name,
                    username: targetUsername,
                    anyScope: scopedParent || isScopedTreeItem(baseFolder),
                });
    
                if (existing && existing.item_type === 'folder') {
                    folderCache.set(cacheKey, existing);
    
                    return {
                        folder: existing,
                        created: false,
                    };
                }
    
                if (existing && existing.item_type !== 'folder') {
                    throw new Error(
                        `Cannot create folder "${name}": a file with that name exists`
                    );
                }
    
                const underScoped =
                    scopedParent || isScopedTreeItem(baseFolder);
                const abs = underScoped
                    ? path.join(resolveItemAbsoluteDir(baseFolder), name)
                    : absolutePath(relativePath);
    
                ensureDir(abs);
    
                existing = underScoped
                    ? await createScopedUploadedFolder({
                          parent: baseFolder,
                          name,
                          relativePath,
                          absolutePath: abs,
                          actorUsername: username,
                          actorUserId: ownerId,
                      })
                    : await FileManagerModel.create({
                    owner_id: targetOwnerId,
                    username: targetUsername,
                    parent_id: baseFolder.id,
                    name,
                    item_type: 'folder',
                    storage_name: null,
                    relative_path: relativePath,
                    filemanager_path: fmPath,
                    created_by: username,
                    updated_by: username,
                });
    
                folderCache.set(cacheKey, existing);
    
                return {
                    folder: existing,
                    created: true,
                };
            }
    
            // ---------------------------------------------------------
            // Result arrays
            // ---------------------------------------------------------
    
            const uploaded = [];
            const foldersCreated = [];
            const skipped = [];
            const errors = [];

            if (createdWrapper) {
                foldersCreated.push({
                    id: createdWrapper.id,
                    name: createdWrapper.name,
                    relative_path: createdWrapper.relative_path,
                });
            }
    
            // ---------------------------------------------------------
            // Process files
            // ---------------------------------------------------------
    
            for (let i = 0; i < files.length; i += 1) {
                const file = files[i];
    
                try {
                    const rawPath = String(
                        paths[i] ||
                            file.originalname ||
                            file.fieldname ||
                            `file-${i}`
                    )
                        .replace(/\\/g, '/')
                        .replace(/^\/+|\/+$/g, '');
    
                    const segments = rawPath
                        .split('/')
                        .map((s) => s.trim())
                        .filter(Boolean)
                        .map((s) => sanitizeFolderName(s))
                        .filter(Boolean);
    
                    if (!segments.length) {
                        skipped.push({
                            path: rawPath,
                            reason: 'Empty path',
                        });
    
                        continue;
                    }
    
                    const fileName = segments[segments.length - 1];
    
                    const dirSegments = segments.slice(0, -1);
    
                    // -------------------------------------------------
                    // Create required folders
                    // -------------------------------------------------
    
                    let current = parent;
    
                    for (const seg of dirSegments) {
                        const {
                            folder,
                            created,
                        } = await ensureFolderUnder(
                            current,
                            seg
                        );
    
                        current = folder;
    
                        if (
                            created &&
                            !foldersCreated.find(
                                (f) =>
                                    Number(f.id) === Number(folder.id)
                            )
                        ) {
                            foldersCreated.push({
                                id: folder.id,
                                name: folder.name,
                                relative_path:
                                    folder.relative_path,
                            });
                        }
                    }
    
                    // -------------------------------------------------
                    // Check DB duplicate
                    // -------------------------------------------------
    
                    const underScoped =
                        scopedParent || isScopedTreeItem(current);
                    const duplicate =
                        await findActiveDuplicate({
                            parentId: current.id,
                            name: fileName,
                            username: targetUsername,
                            anyScope: underScoped,
                        });
    
                    if (duplicate) {
                        skipped.push({
                            path: rawPath,
                            reason:
                                'A folder or file with this name already exists here',
                        });
    
                        // Remove temporary upload
                        cleanupUploadedTempFile(file);
    
                        continue;
                    }
    
                    // -------------------------------------------------
                    // Final storage path
                    // -------------------------------------------------
    
                    const relativePath = joinRelative(
                        current.relative_path,
                        fileName
                    );
    
                    const abs = underScoped
                        ? path.join(
                              resolveItemAbsoluteDir(current),
                              fileName,
                          )
                        : absolutePath(relativePath);
    
                    ensureDir(path.dirname(abs));
    
                    // -------------------------------------------------
                    // Check physical storage
                    // -------------------------------------------------
    
                    if (fs.existsSync(abs)) {
                        skipped.push({
                            path: rawPath,
                            reason:
                                'A file with this name already exists on storage',
                        });
    
                        cleanupUploadedTempFile(file);
    
                        continue;
                    }
    
                    // -------------------------------------------------
                    // IMPORTANT:
                    // Move temporary file to final storage.
                    //
                    // DO NOT use:
                    // fs.writeFileSync(abs, file.buffer)
                    //
                    // The uploaded file is already stored on disk by
                    // multer diskStorage.
                    // -------------------------------------------------
    
                    await moveUploadedFile(
                        file.path,
                        abs
                    );
    
                    const extension =
                        getExtension(file.originalname) ||
                        getExtension(fileName);
    
                    // -------------------------------------------------
                    // Save metadata
                    // -------------------------------------------------
    
                    const createdFile = underScoped
                        ? await createScopedUploadedFile({
                              parent: current,
                              displayName: fileName,
                              storageName: fileName,
                              relativePath,
                              absolutePath: abs,
                              mimeType: file.mimetype || null,
                              extension,
                              size: file.size ?? null,
                              actorUsername: username,
                              actorUserId: ownerId,
                          })
                        : await FileManagerModel.create({
                            owner_id: targetOwnerId,
                            username: targetUsername,
                            parent_id: current.id,
                            name: fileName,
                            item_type: 'file',
                            storage_name: fileName,
                            relative_path: relativePath,
                            filemanager_path: fmPath,
                            mime_type:
                                file.mimetype || null,
                            extension,
                            size:
                                file.size ??
                                null,
                            created_by: username,
                            updated_by: username,
                        });
    
                    uploaded.push(createdFile);
                } catch (err) {
                    console.error(
                        `uploadFolder file ${i} error:`,
                        err
                    );
    
                    // Cleanup temporary upload if it still exists
                    cleanupUploadedTempFile(file);
    
                    errors.push({
                        path:
                            paths[i] ||
                            file?.originalname ||
                            `index-${i}`,
                        reason:
                            err.message ||
                            'Upload failed',
                    });
                }
            }

            for (const rawEmpty of folderPaths) {
                try {
                    const segments = String(rawEmpty || '')
                        .replace(/\\/g, '/')
                        .replace(/^\/+|\/+$/g, '')
                        .split('/')
                        .map((segment) => segment.trim())
                        .filter(Boolean)
                        .map((segment) => sanitizeFolderName(segment))
                        .filter(Boolean);

                    let current = parent;
                    for (const seg of segments) {
                        const { folder, created } = await ensureFolderUnder(
                            current,
                            seg,
                        );
                        current = folder;
                        if (
                            created &&
                            !foldersCreated.find(
                                (item) => Number(item.id) === Number(folder.id),
                            )
                        ) {
                            foldersCreated.push({
                                id: folder.id,
                                name: folder.name,
                                relative_path: folder.relative_path,
                            });
                        }
                    }
                } catch (err) {
                    errors.push({
                        path: String(rawEmpty || ''),
                        reason: err.message || 'Failed to create empty folder',
                    });
                }
            }
    
            // ---------------------------------------------------------
            // Response
            // ---------------------------------------------------------
    
            return res.status(201).json({
                success: true,
                message: uploaded.length
                    ? `Uploaded ${uploaded.length} file(s)`
                    : `Created ${foldersCreated.length} folder(s)`,
    
                data: {
                    parent_id: parent.id,
    
                    uploaded,
    
                    folders_created:
                        foldersCreated,
    
                    skipped,
    
                    errors,
    
                    counts: {
                        uploaded:
                            uploaded.length,
    
                        folders_created:
                            foldersCreated.length,
    
                        skipped:
                            skipped.length,
    
                        errors:
                            errors.length,
    
                        total_files:
                            files.length,
                    },
                },
    
                filemanager_path: fmPath,
            });
        } catch (error) {
            console.error(
                'uploadFolder error:',
                error
            );

            const leftover = Array.isArray(req.files) ? req.files : [];
            for (const file of leftover) cleanupUploadedTempFile(file);
    
            return res.status(500).json({
                success: false,
                message:
                    error.message ||
                    'Failed to upload folder',
            });
        }
    }

    static async getFile(req, res) {
        try {
            const { ownerId, username, isAdmin } = await resolveActor(req);
            if (ownerId == null) return unauthorized(res);

            const actor = { ownerId, username, isAdmin };
            // Accept numeric id or public_id (production docs resolve /fileManager/folders/{public_id})
            const item = await FileManagerModel.findByIdOrPublicId(
                req.params.id,
                {
                    anyScope: true,
                },
            );
            const itemType = String(item?.item_type || '')
                .trim()
                .toLowerCase();
            if (!item || itemType === 'folder' || itemType === '') {
                return notFound(res, 'File not found');
            }
            if (!(await canAccessItemForRead(item, actor))) {
                return forbid(res);
            }

            return res.json({
                success: true,
                data: attachItemMeta({
                    ...item,
                    ...buildFileMediaUrls(item.id),
                    ...buildThumbnailMeta(item),
                    category: isGoogleCloudItem(item)
                        ? 'google'
                        : resolveViewByExtension(item).category,
                }),
            });
        } catch (error) {
            console.error('getFile error:', error);
            return res.status(500).json({
                success: false,
                message: error.message || 'Failed to get file',
            });
        }
    }

    static async updateFile(req, res) {
        try {
            const { ownerId, username, isAdmin } = await resolveActor(req);
            if (ownerId == null || !username) return unauthorized(res);

            const actor = { ownerId, username, isAdmin };
            const item = await FileManagerModel.findById(req.params.id, {
                anyScope: true,
            });
            if (!item || item.item_type !== 'file') {
                return notFound(res, 'File not found');
            }
            if (!(await canAccessItemForWrite(item, actor))) {
                return forbid(res);
            }

            const name = sanitizeFolderName(req.body?.name);
            if (!name) {
                return res.status(400).json({
                    success: false,
                    message: 'File name is required',
                });
            }

            const scoped = isScopedTreeItem(item);
            const duplicate = await findActiveDuplicate({
                parentId: item.parent_id,
                name,
                username: item.username || username,
                excludeId: item.id,
                anyScope: scoped,
            });
            if (duplicate) {
                return res.status(409).json({
                    success: false,
                    message: 'A folder or file with this name already exists here',
                });
            }

            const parent = item.parent_id
                ? await FileManagerModel.findById(item.parent_id, {
                      anyScope: true,
                  })
                : null;
            const newRelative = parent
                ? joinRelative(parent.relative_path, name)
                : name;

            let newAbs = null;
            if (item.relative_path !== newRelative) {
                const oldAbs = resolveItemDiskPath(item);
                newAbs = scoped
                    ? path.join(
                          parent
                              ? resolveItemAbsoluteDir(parent)
                              : path.dirname(oldAbs),
                          name,
                      )
                    : absolutePath(newRelative);
                if (fs.existsSync(newAbs)) {
                    return res.status(409).json({
                        success: false,
                        message: 'A file with this name already exists on storage',
                    });
                }
                if (fs.existsSync(oldAbs)) {
                    safeMovePath(oldAbs, newAbs);
                }
            }

            const updated = await FileManagerModel.update(item.id, {
                name,
                storage_name: name,
                relative_path: newRelative,
                ...(newAbs ? { absolute_path: newAbs } : {}),
                ...(scoped
                    ? {}
                    : { filemanager_path: getFileManagerPathValue() }),
                extension: getExtension(name),
                updated_by: username,
            });

            await writeFileManagerLog({
                action: 'UPDATE',
                entityType: 'file',
                itemId: item.id,
                itemName: name,
                fieldName: 'name',
                oldValue: item.name,
                newValue: name,
                updatedBy: username,
                updatedByUserId: ownerId,
            });

            return res.json({ success: true, data: updated });
        } catch (error) {
            console.error('updateFile error:', error);
            return res.status(500).json({
                success: false,
                message: error.message || 'Failed to update file',
            });
        }
    }

    /**
     * File branch of POST /api/file-manager/items/:id/replace
     * multipart: file (single)
     * Old physical file is deleted and the same DB row is updated,
     * so listings immediately display the new file (same id / parent).
     */
    static async replaceFile(req, res) {
        const uploadedFiles = [
            ...(Array.isArray(req.files?.file) ? req.files.file : []),
            ...(Array.isArray(req.files?.files) ? req.files.files : []),
            ...(req.file ? [req.file] : []),
        ];
        try {
            const { ownerId, username, isAdmin } = await resolveActor(req);
            if (ownerId == null || !username) {
                uploadedFiles.forEach(cleanupUploadedTempFile);
                return unauthorized(res);
            }

            const actor = { ownerId, username, isAdmin };
            const item = await FileManagerModel.findByIdOrPublicId(
                req.params.id,
                { anyScope: true },
            );
            if (
                !item ||
                String(item.item_type || '').trim().toLowerCase() !== 'file'
            ) {
                uploadedFiles.forEach(cleanupUploadedTempFile);
                return notFound(res, 'File not found');
            }
            if (!(await canAccessItemForWrite(item, actor))) {
                uploadedFiles.forEach(cleanupUploadedTempFile);
                return forbid(res);
            }
            if (isGoogleCloudItem(item)) {
                uploadedFiles.forEach(cleanupUploadedTempFile);
                return res.status(400).json({
                    success: false,
                    message: 'Google files cannot be replaced with a local file',
                });
            }
            if (uploadedFiles.length !== 1) {
                uploadedFiles.forEach(cleanupUploadedTempFile);
                return res.status(400).json({
                    success: false,
                    message:
                        uploadedFiles.length > 1
                            ? 'Replace accepts exactly one file'
                            : 'At least one file is required (field name: file)',
                });
            }

            const file = uploadedFiles[0];
            const displayName = sanitizeFolderName(
                req.body?.name || file.originalname || '',
            );
            if (!displayName) {
                cleanupUploadedTempFile(file);
                return res.status(400).json({
                    success: false,
                    message: 'File name is required',
                });
            }

            const scoped = isScopedTreeItem(item);
            const duplicate = await findActiveDuplicate({
                parentId: item.parent_id,
                name: displayName,
                username: item.username || username,
                excludeId: item.id,
                anyScope: scoped,
            });
            if (duplicate) {
                cleanupUploadedTempFile(file);
                return res.status(409).json({
                    success: false,
                    message:
                        'A folder or file with this name already exists here',
                });
            }

            const parent = item.parent_id
                ? await FileManagerModel.findById(item.parent_id, {
                      anyScope: true,
                  })
                : null;
            const newRelative = parent
                ? joinRelative(parent.relative_path, displayName)
                : displayName;
            const oldAbs = resolveItemDiskPath(item);
            const newAbs = scoped
                ? path.join(
                      parent
                          ? resolveItemAbsoluteDir(parent)
                          : path.dirname(oldAbs),
                      displayName,
                  )
                : absolutePath(newRelative);
            const samePath =
                path.resolve(oldAbs).toLowerCase() ===
                path.resolve(newAbs).toLowerCase();

            if (!samePath && fs.existsSync(newAbs)) {
                cleanupUploadedTempFile(file);
                return res.status(409).json({
                    success: false,
                    message: 'A file with this name already exists on storage',
                });
            }

            // Stage new file first, send the old file to the Windows Recycle Bin, then show the new file.
            const stagingAbs = `${newAbs}.replace-${Date.now()}-${Math.random()
                .toString(36)
                .slice(2, 8)}`;
            try {
                await persistUploadedFile(file, stagingAbs);
                if (fs.existsSync(oldAbs)) {
                    sendToOperatingSystemRecycleBin(oldAbs);
                }
                safeMovePath(stagingAbs, newAbs);
            } catch (err) {
                cleanupUploadedTempFile(file);
                try {
                    if (fs.existsSync(stagingAbs)) {
                        fs.rmSync(stagingAbs, { force: true });
                    }
                } catch {
                    /* ignore staging cleanup */
                }
                throw err;
            }

            let updated;
            try {
                updated = await FileManagerModel.update(item.id, {
                    name: displayName,
                    storage_name: displayName,
                    relative_path: newRelative,
                    absolute_path: newAbs,
                    ...(scoped
                        ? {}
                        : { filemanager_path: getFileManagerPathValue() }),
                    mime_type: file.mimetype || null,
                    extension:
                        getExtension(file.originalname) ||
                        getExtension(displayName),
                    size: file.size ?? file.buffer?.length ?? null,
                    file_source: 'local',
                    google_file_id: null,
                    google_drive_folder_id: null,
                    url: null,
                    updated_by: username,
                });
            } catch (dbErr) {
                // New file is already in place; keep it and surface the error.
                console.error('replaceFile DB update failed:', dbErr);
                throw dbErr;
            }

            await writeFileManagerLog({
                action: 'UPDATE',
                entityType: 'file',
                itemId: item.id,
                itemName: updated?.name || item.name,
                fieldName: 'file',
                oldValue: item.name,
                newValue: file?.originalname || updated?.name || item.name,
                updatedBy: username,
                updatedByUserId: ownerId,
            });

            return res.json({
                success: true,
                message: 'File replaced successfully',
                data: await attachCreatedByUserOne(
                    attachItemMeta({
                        ...updated,
                        ...buildFileMediaUrls(updated.id),
                        ...buildThumbnailMeta(updated),
                    }),
                ),
            });
        } catch (error) {
            uploadedFiles.forEach(cleanupUploadedTempFile);
            console.error('replaceFile error:', error);
            return res.status(500).json({
                success: false,
                message: error.message || 'Failed to replace file',
            });
        }
    }

    static async deleteFile(req, res) {
        try {
            const { ownerId, username, isAdmin } = await resolveActor(req);
            if (ownerId == null || !username) return unauthorized(res);

            const actor = { ownerId, username, isAdmin };
            const item = await FileManagerModel.findById(req.params.id, {
                anyScope: true,
            });
            if (!item || item.item_type !== 'file') {
                return notFound(res, 'File not found');
            }
            if (!(await canAccessItemForWrite(item, actor))) {
                return forbid(res);
            }

            const result = await softDeleteItem(item, username, ownerId);
            await writeFileManagerLog({
                action: 'DELETE',
                entityType: 'file',
                itemId: item.id,
                itemName: item.name,
                fieldName: 'file',
                oldValue: item.name,
                newValue: null,
                updatedBy: username,
                updatedByUserId: ownerId,
            });
            return res.json({
                success: true,
                message: 'File moved to Recycle Bin',
                data: result.item,
            });
        } catch (error) {
            console.error('deleteFile error:', error);
            const status = error.status || (
                /Cannot delete|deleted_by/i.test(error.message || '') ? 400 : 500
            );
            return res.status(status).json({
                success: false,
                message: error.message || 'Failed to delete file',
            });
        }
    }

    /**
     * GET /api/file-manager/folders/:id/download
     * Zip the folder (and nested files/folders) and download as .zip.
     * Supports personal, project, and financial-year folders (any scope).
     */
    static async downloadFolder(req, res) {
        try {
            const { ownerId, username, isAdmin } = await resolveActor(req);
            if (ownerId == null) return unauthorized(res);

            const folderId = Number(req.params.id);
            if (!Number.isFinite(folderId) || folderId <= 0) {
                return notFound(res, 'Folder not found');
            }

            // Project / FY / personal — unified file_manager_items
            const item = await FileManagerModel.findById(folderId, {
                anyScope: true,
            });
            if (
                !item ||
                String(item.item_type || '')
                    .trim()
                    .toLowerCase() !== 'folder'
            ) {
                return notFound(res, 'Folder not found');
            }
            if (item.is_deleted) {
                return notFound(res, 'Folder not found');
            }

            const actor = { ownerId, username, isAdmin };
            const isOwner = isItemOwner(item, actor) || Boolean(isAdmin);
            if (!isOwner) {
                const canView = await canViewScopedFolder(item, actor);
                if (!canView) return forbid(res);
            }

            // Prefer DB absolute_path (project/FY); fall back to personal storage root
            let abs = null;
            const storedAbs = String(item.absolute_path || '').trim();
            if (storedAbs) {
                abs = path.resolve(storedAbs);
            } else if (item.relative_path) {
                try {
                    abs = absolutePath(item.relative_path);
                } catch {
                    abs = null;
                }
            }
            if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
                return res.status(404).json({
                    success: false,
                    message: 'Physical folder missing on storage',
                });
            }

            const folderName =
                sanitizeFolderName(item.name) ||
                sanitizeFolderName(path.basename(abs)) ||
                `folder-${item.id}`;

            const zip = new JSZip();
            const rootFolder = zip.folder(folderName);

            async function addDirectory(dirAbs, zipNode) {
                const entries = await fs.promises.readdir(dirAbs, {
                    withFileTypes: true,
                });
                for (const entry of entries) {
                    const name = String(entry.name || '');
                    if (
                        !name ||
                        name === '.' ||
                        name === '..' ||
                        name.startsWith('~$') ||
                        name === '.DS_Store' ||
                        name === 'Thumbs.db'
                    ) {
                        continue;
                    }
                    const full = path.join(dirAbs, name);
                    const kind = classifyDiskDirent(dirAbs, entry);
                    if (kind === 'dir') {
                        const child = zipNode.folder(name);
                        if (child) await addDirectory(full, child);
                    } else if (kind === 'file') {
                        const data = await fs.promises.readFile(full);
                        zipNode.file(name, data);
                    }
                }
            }

            if (rootFolder) {
                await addDirectory(abs, rootFolder);
            }

            const buffer = await zip.generateAsync({
                type: 'nodebuffer',
                compression: 'DEFLATE',
                compressionOptions: { level: 6 },
            });

            const zipName = `${folderName}.zip`;
            res.setHeader('Content-Type', 'application/zip');
            res.setHeader(
                'Content-Disposition',
                buildContentDisposition('attachment', zipName),
            );
            res.setHeader('Content-Length', String(buffer.length));
            return res.send(buffer);
        } catch (error) {
            console.error('downloadFolder error:', error);
            return res.status(500).json({
                success: false,
                message: error.message || 'Failed to download folder',
            });
        }
    }

    static async downloadFile(req, res) {
        try {
            const { ownerId, username, isAdmin } = await resolveActor(req);
            if (ownerId == null) return unauthorized(res);

            const actor = { ownerId, username, isAdmin };
            const item = await FileManagerModel.findById(req.params.id, {
                anyScope: true,
            });
            if (!item || item.item_type !== 'file') {
                return notFound(res, 'File not found');
            }
            if (!(await canAccessItemForRead(item, actor))) {
                return forbid(res);
            }

            if (isGoogleCloudItem(item)) {
                return res.status(422).json({
                    success: false,
                    message: 'Google cloud files cannot be downloaded from the server. Open the Google URL instead.',
                    url: item.url || null,
                    file_source: item.file_source || 'google_sheet',
                });
            }

            const abs = resolveItemAbsoluteFilePath(item);
            if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
                return res.status(404).json({
                    success: false,
                    message: 'Physical file missing on storage',
                });
            }

            if (item.mime_type) {
                res.setHeader('Content-Type', item.mime_type);
            }
            const downloadName = getPublicFileName(item);
            res.setHeader(
                'Content-Disposition',
                buildContentDisposition('attachment', downloadName),
            );
            return res.sendFile(path.resolve(abs));
        } catch (error) {
            console.error('downloadFile error:', error);
            return res.status(500).json({
                success: false,
                message: error.message || 'Failed to download file',
            });
        }
    }

    /**
     * View / preview file by extension:
     * GET /api/file-manager/files/:id/view
     * - Auth required; admin or owner only
     * - Soft-deleted / non-file → 404
     * - Path = FILEMANAGER_PATH + relative_path (traversal blocked)
     * - MIME + inline/attachment from extension
     * - ?meta=true or Accept: application/json → JSON metadata (no binary)
     */
    
    static async viewFile(req, res) {
        try {
            const { ownerId, username, isAdmin } = await resolveActor(req);
            if (ownerId == null) return unauthorized(res);

            const actor = { ownerId, username, isAdmin };
            const item = await FileManagerModel.findById(req.params.id, {
                anyScope: true,
            });
            // Soft-deleted rows are excluded by findById → treat as not found
            if (!item || item.is_deleted) {
                return notFound(res, 'File not found');
            }
            if (item.item_type !== 'file') {
                return res.status(400).json({
                    success: false,
                    message: 'Only files can be viewed',
                });
            }
            if (!(await canAccessItemForRead(item, actor))) {
                return forbid(res);
            }

            if (isGoogleCloudItem(item)) {
                const url = item.url || null;
                if (!url) {
                    return res.status(422).json({
                        success: false,
                        viewable: false,
                        message: 'This file cannot be viewed',
                    });
                }
                return res.redirect(url);
            }

            // Prefer DB absolute_path (project/FY); fall back to personal storage root
            const abs = resolveItemAbsoluteFilePath(item);
            let stat;
            try {
                if (!fs.existsSync(abs)) {
                    return res.status(404).json({
                        success: false,
                        message: 'Physical file missing on storage',
                    });
                }
                stat = fs.statSync(abs);
                if (!stat.isFile()) {
                    return res.status(404).json({
                        success: false,
                        message: 'Physical file missing on storage',
                    });
                }
            } catch {
                return res.status(404).json({
                    success: false,
                    message: 'Physical file missing on storage',
                });
            }

            const view = resolveViewByExtension(item);
            // Only ?meta=true returns JSON. Do NOT key off Accept: application/json —
            // axios/fetch clients send that by default and would skip the .url redirect.
            const wantMeta = String(req.query.meta || '').toLowerCase() === 'true';

            // .url Internet Shortcut → redirect to target page (http/https only)
            let redirectUrl = null;
            if (view.category === 'url') {
                let raw = '';
                try {
                    raw = fs.readFileSync(abs, 'utf8');
                } catch (err) {
                    return res.status(500).json({
                        success: false,
                        message: err.message || 'Failed to read .url shortcut',
                    });
                }
                redirectUrl = parseInternetShortcutUrl(raw);
                if (!redirectUrl || !isSafeExternalRedirectUrl(redirectUrl)) {
                    return res.status(400).json({
                        success: false,
                        message:
                            'Invalid or unsupported URL in .url file (http/https required)',
                    });
                }
            }

            if (wantMeta) {
                const canViewInline = Boolean(view.inline) &&
                    !['office', 'spreadsheet', 'download'].includes(view.category);
                return res.json({
                    success: true,
                    data: {
                        id: item.id,
                        name: getPublicFileName(item),
                        extension: view.ext || item.extension,
                        category: view.category,
                        mime_type: view.contentType,
                        disposition: canViewInline ? 'inline' : 'none',
                        inline: canViewInline,
                        viewable: canViewInline,
                        size: stat.size,
                        relative_path: item.relative_path,
                        filemanager_path: getFileManagerPathValue(),
                        view_url: `/api/file-manager/files/${item.id}/view`,
                        ...(redirectUrl ? { redirect_url: redirectUrl } : {}),
                        // Never include download_url here — frontend must not auto-call download from view
                    },
                });
            }

            if (view.category === 'url' && redirectUrl) {
                res.setHeader('X-File-Category', 'url');
                res.setHeader('X-File-Extension', 'url');
                res.setHeader('X-Redirect-Url', redirectUrl);
                return res.redirect(302, redirectUrl);
            }

            // Hard block: docx / xlsx / ppt / csv / zip / etc. — message only, never download/stream
            const noViewExts = new Set([
                'doc', 'docx', 'xls', 'xlsx', 'xlsm', 'ppt', 'pptx',
                'csv', 'rtf', 'odt', 'ods', 'odp', 'zip', 'rar', '7z', 'exe',
            ]);
            const extKey = String(view.ext || item.extension || '').toLowerCase().replace(/^\./, '');
            const cannotView =
                noViewExts.has(extKey) ||
                !view.inline ||
                ['office', 'spreadsheet', 'download'].includes(view.category);

            if (cannotView) {
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.setHeader('Cache-Control', 'no-store');
                return res.status(415).json({
                    success: false,
                    viewable: false,
                    extension: extKey || null,
                    name: getPublicFileName(item),
                    message: 'This file cannot be viewed',
                });
            }

            res.setHeader('Content-Type', view.contentType);
            res.setHeader(
                'Content-Disposition',
                buildContentDisposition('inline', getPublicFileName(item)),
            );
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('X-File-Category', view.category);
            res.setHeader('X-File-Extension', view.ext || '');
            res.setHeader('Content-Length', String(stat.size));

            if (view.category === 'video' || view.category === 'audio') {
                res.setHeader('Accept-Ranges', 'bytes');
            }

            const stream = fs.createReadStream(abs);
            stream.on('error', (err) => {
                console.error('viewFile stream error:', err);
                if (!res.headersSent) {
                    res.status(500).json({
                        success: false,
                        message: 'Failed to stream file',
                    });
                } else {
                    res.destroy(err);
                }
            });
            return stream.pipe(res);
        } catch (error) {
            console.error('viewFile error:', error);
            if (!res.headersSent) {
                return res.status(500).json({
                    success: false,
                    message: error.message || 'Failed to view file',
                });
            }
            return undefined;
        }
    }

    /**
     * Google Drive-style thumbnail — image binary only (never original file / never JSON success body).
     * GET /api/file-manager/files/:id/thumbnail
     * Local files: render from disk. Google Sheet/Doc: export via Drive API then render.
     */
    static async getThumbnail(req, res) {
        const sendThumb = (buffer, contentType, variant) => {
            if (res.headersSent) return undefined;
            const body = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
            res.setHeader('Content-Type', contentType || 'image/webp');
            res.setHeader('Content-Length', String(body.length));
            res.setHeader('Content-Disposition', 'inline');
            res.setHeader('Cache-Control', THUMBNAIL_CACHE);
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('X-File-Variant', variant || 'thumbnail');
            return res.status(200).send(body);
        };

        try {
            // Recycle Bin + missing disk OK — we always can serve extension image
            const loaded = await loadAccessibleFile(req, res, {
                allowRecycleBin: true,
                allowMissingDisk: true,
            });
            if (!loaded) return undefined;

            const { item, abs, stat } = loaded;
            const ext =
                item.extension || getExtension(item.name) || 'FILE';
            const { ownerId } = await resolveActor(req);

            let googleDrive;
            if (isGoogleNativeFile(item)) {
                try {
                    const { auth } = await getExistingGoogleAuthForUser(ownerId);
                    googleDrive = getDriveClient(auth);
                } catch (err) {
                    // No Google auth → still return extension image (never fail API)
                    console.warn(
                        'getThumbnail google auth skipped:',
                        err?.message || err,
                    );
                    const buffer = await generateExtensionThumbnail(ext);
                    return sendThumb(buffer, 'image/webp', 'extension-thumbnail');
                }
            }

            try {
                // No local file → extension-label image (do not 404)
                if (!abs && !isGoogleNativeFile(item)) {
                    const buffer = await generateExtensionThumbnail(ext);
                    return sendThumb(buffer, 'image/webp', 'extension-thumbnail');
                }

                const { buffer, contentType } = await getOrCreateThumbnail({
                    itemId: item.id,
                    absPath: abs,
                    fileName: item.name,
                    extension: ext,
                    storageRoot: getStorageRoot(),
                    stat,
                    item,
                    googleDrive,
                });

                return sendThumb(
                    buffer,
                    contentType || 'image/webp',
                    'thumbnail',
                );
            } catch (err) {
                console.warn(
                    'getThumbnail fallback to extension image:',
                    err.message,
                    err?.cause?.message || '',
                );
                const buffer = await generateExtensionThumbnail(ext);
                return sendThumb(buffer, 'image/webp', 'extension-thumbnail');
            }
        } catch (error) {
            console.error('getThumbnail error:', error);
            if (res.headersSent) return undefined;
            try {
                const buffer = await generateExtensionThumbnail('FILE');
                return sendThumb(buffer, 'image/webp', 'extension-thumbnail');
            } catch {
                return res.status(200).send(
                    Buffer.from(
                        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
                        'base64',
                    ),
                );
            }
        }
    }

    /* ================= FAVORITES ================= */
    /** GET /api/file-manager/favorites — only the signed-in user's favorites. */
    static async listFavorites(req, res) {
        try {
            const { ownerId, username, isAdmin } = await resolveActor(req);
            if (ownerId == null || !username) return unauthorized(res);

            const rows = await FileManagerModel.findFavorites({
                userId: ownerId,
            });
            const actor = { ownerId, username, isAdmin };
            return res.json({
                success: true,
                data: attachListAccess(attachListMeta(rows), actor),
            });
        } catch (error) {
            console.error('listFavorites error:', error);
            return res.status(500).json({
                success: false,
                message: error.message || 'Failed to list favorites',
            });
        }
    }

    /**
     * POST /api/file-manager/favorites
     * Body: { id|item_id|public_id, is_favorite: true|false }
     * Stored for the signed-in user only. Omitted is_favorite defaults to true.
     */
    static async setFavorite(req, res) {
        try {
            const { ownerId, username, isAdmin } = await resolveActor(req);
            if (ownerId == null || !username) return unauthorized(res);

            const rawId =
                req.params?.id ??
                req.body?.id ??
                req.body?.item_id ??
                req.body?.itemId ??
                req.body?.public_id ??
                req.body?.publicId ??
                null;
            const item = await FileManagerModel.findByIdOrPublicId(rawId, {
                anyScope: true,
            });
            if (!item) return notFound(res, 'Item not found');

            const actor = { ownerId, username, isAdmin };
            if (!(await canAccessItemForRead(item, actor))) return forbid(res);

            const rawFlag =
                req.body?.is_favorite ??
                req.body?.isFavorite ??
                req.body?.favorite;
            let isFavorite = true;
            if (rawFlag != null && String(rawFlag).trim() !== '') {
                if (rawFlag === true || rawFlag === false) {
                    isFavorite = rawFlag;
                } else {
                    const text = String(rawFlag).trim().toLowerCase();
                    if (['true', '1', 'yes'].includes(text)) isFavorite = true;
                    else if (['false', '0', 'no'].includes(text)) {
                        isFavorite = false;
                    } else {
                        return res.status(400).json({
                            success: false,
                            message: 'is_favorite must be true or false',
                        });
                    }
                }
            }

            const alreadyFavorite = await FileManagerModel.userHasFavorite(
                item.id,
                ownerId,
            );
            const updated = await FileManagerModel.setFavorite(
                item.id,
                ownerId,
                isFavorite,
                username,
            );
            if (!updated) return notFound(res, 'Item not found');

            await writeFileManagerLog({
                action: 'UPDATE',
                entityType: item.item_type === 'folder' ? 'folder' : 'file',
                itemId: item.id,
                itemName: item.name,
                fieldName: 'is_favorite',
                oldValue: alreadyFavorite,
                newValue: isFavorite,
                updatedBy: username,
                updatedByUserId: ownerId,
            });

            return res.json({
                success: true,
                message: isFavorite
                    ? 'Moved to favorites'
                    : 'Removed from favorites',
                data: attachItemAccess(updated, actor),
            });
        } catch (error) {
            console.error('setFavorite error:', error);
            return res.status(500).json({
                success: false,
                message: error.message || 'Failed to update favorite',
            });
        }
    }

    /* ================= COMMON ================= */
    static async getItems(req, res) {
        try {
            const { ownerId, username, isAdmin } = await resolveActor(req);
            if (ownerId == null) return unauthorized(res);

            const itemType = req.query.item_type || null;
            let parentId = undefined;
            let parent = null;

            if (Object.prototype.hasOwnProperty.call(req.query, 'parent_id')) {
                const raw = req.query.parent_id;
                if (raw === '' || raw === 'null' || raw == null) {
                    parentId = null;
                } else {
                    parentId = Number(raw);
                    if (Number.isNaN(parentId)) {
                        return res.status(400).json({
                            success: false,
                            message: 'Invalid parent_id',
                        });
                    }
                    parent = await FileManagerModel.findById(parentId);
                    if (!parent || parent.item_type !== 'folder') {
                        return notFound(res, 'Parent folder not found');
                    }
                    if (!assertOwner(parent, ownerId, isAdmin)) return forbid(res);
                }
            } else if (isAdmin) {
                // Admin default: all folders/files at FILEMANAGER_PATH root
                parentId = null;
            } else {
                // User default: children of their own root
                const root = await FileManagerModel.findRootByOwner(
                    ownerId,
                    getFileManagerPathValue(),
                );
                if (!root) {
                    return res.json({
                        success: true,
                        data: [],
                        filemanager_path: getFileManagerPathValue(),
                        is_admin: false,
                    });
                }
                parent = root;
                parentId = root.id;
            }

            // Always reflect the live Windows folder from .env
            try {
                if (parentId == null) {
                    await syncFsChildren({
                        parentId: null,
                        parentRelative: '',
                        defaultOwnerId: ownerId,
                        defaultUsername: username || 'system',
                        actorUsername: username || 'system',
                    });
                } else if (parent) {
                    await syncFsChildren({
                        parentId: parent.id,
                        parentRelative: parent.relative_path,
                        defaultOwnerId: Number(parent.owner_id),
                        defaultUsername: parent.username || username || '',
                        actorUsername: username || parent.username || '',
                    });
                }
            } catch (syncErr) {
                console.error('getItems sync skipped:', syncErr.message);
            }

            const actor = { ownerId, username, isAdmin };
            let items = attachListAccess(
                attachListMeta(
                filterExistingOnDisk(
                    await FileManagerModel.findItems({
                        ownerId: isAdmin ? null : ownerId,
                        parentId,
                        itemType,
                        filemanagerPath: getFileManagerPathValue(),
                    }),
                ),
                ),
                actor,
            );

            // Root listing (user default root or explicit parent = personal root)
            const wantFolders =
                !itemType ||
                String(itemType).toLowerCase() === 'folder';
            const atPersonalRoot =
                wantFolders &&
                parent &&
                isUserPersonalRootFolder(parent, actor);

            let project_fy_count = 0;
            if (atPersonalRoot) {
                try {
                    const external = await loadAccessibleProjectAndFyFolders(
                        actor,
                    );
                    // Roots stay parent_id = null; clients open via folder id
                    project_fy_count = (external || []).length;
                    items = [...items, ...(external || [])];
                } catch (mergeErr) {
                    console.error(
                        'getItems project/FY merge skipped:',
                        mergeErr.message,
                    );
                }
            }

            return res.json({
                success: true,
                data: items,
                filemanager_path: getFileManagerPathValue(),
                is_admin: isAdmin,
                meta: {
                    project_fy_count,
                    includes_project_and_financial_year: project_fy_count > 0,
                },
            });
        } catch (error) {
            console.error('getItems error:', error);
            return res.status(500).json({
                success: false,
                message: error.message || 'Failed to list items',
            });
        }
    }

    /**
     * GET /api/file-manager/search
     * Filters (any combination, at least one required):
     *   type | item_type = file | folder
     *   username
     *   name | file_name | q | query  (file or folder name)
     */
    static async search(req, res) {
        try {
            const { ownerId, username, isAdmin } = await resolveActor(req);
            if (ownerId == null || !username) return unauthorized(res);

            const name = String(
                req.query.name ??
                    req.query.file_name ??
                    req.query.fileName ??
                    req.query.q ??
                    req.query.query ??
                    '',
            ).trim();
            const type = String(
                req.query.type ?? req.query.item_type ?? '',
            )
                .trim()
                .toLowerCase();
            const usernameFilter = String(req.query.username ?? '').trim();

            if (!name && !type && !usernameFilter) {
                return res.status(400).json({
                    success: false,
                    message: 'Provide type, username, or file name',
                });
            }
            if (type && type !== 'file' && type !== 'folder') {
                return res.status(400).json({
                    success: false,
                    message: 'type must be file or folder',
                });
            }
            if (
                !isAdmin &&
                usernameFilter &&
                usernameFilter.toLowerCase() !==
                    String(username).trim().toLowerCase()
            ) {
                return forbid(res, 'You can only search your own files');
            }

            const actor = { ownerId, username, isAdmin };
            const items = attachListAccess(
                attachListMeta(
                    filterExistingOnDisk(
                        await FileManagerModel.search({
                            ownerId: isAdmin ? null : ownerId,
                            q: name,
                            username: usernameFilter || null,
                            itemType: type || null,
                            limit: req.query.limit,
                            filemanagerPath: getFileManagerPathValue(),
                        }),
                    ),
                ),
                actor,
            );

            return res.json({
                success: true,
                data: items,
                filters: {
                    type: type || null,
                    username: usernameFilter || null,
                    name: name || null,
                },
                filemanager_path: getFileManagerPathValue(),
                is_admin: isAdmin,
            });
        } catch (error) {
            console.error('search error:', error);
            return res.status(500).json({
                success: false,
                message: error.message || 'Failed to search',
            });
        }
    }

    static async moveItem(req, res) {
        try {
            const { ownerId, username, isAdmin } = await resolveActor(req);
            if (ownerId == null || !username) return unauthorized(res);

            // Accept JSON, x-www-form-urlencoded, or multipart form-data
            // Aliases: id → item_id, parent_id → target_parent_id
            const rawItemId =
                req.body?.item_id ??
                req.body?.itemId ??
                req.body?.id ??
                req.query?.item_id ??
                req.query?.id;
            const rawTargetParentId =
                req.body?.target_parent_id ??
                req.body?.targetParentId ??
                req.body?.parent_id ??
                req.body?.parentId ??
                req.query?.target_parent_id ??
                req.query?.parent_id;

            const itemId = Number(rawItemId);
            const targetParentId = Number(rawTargetParentId);

            if (rawItemId == null || rawItemId === '' || Number.isNaN(itemId) || itemId <= 0) {
                return res.status(400).json({
                    success: false,
                    message: 'item_id is required (alias: id)',
                });
            }
            if (
                rawTargetParentId == null ||
                rawTargetParentId === '' ||
                Number.isNaN(targetParentId) ||
                targetParentId <= 0
            ) {
                return res.status(400).json({
                    success: false,
                    message: 'target_parent_id is required (alias: parent_id)',
                });
            }

            const actor = { ownerId, username, isAdmin };
            const item = await FileManagerModel.findById(itemId, {
                anyScope: true,
            });
            if (!item) return notFound(res, 'Item not found');
            if (!(await canAccessItemForWrite(item, actor))) {
                return forbid(res);
            }

            if (item.parent_id == null && !isScopedTreeItem(item)) {
                return res.status(400).json({
                    success: false,
                    message: 'Cannot move the user root folder',
                });
            }

            const target = await FileManagerModel.findById(targetParentId, {
                anyScope: true,
            });
            if (!target || target.item_type !== 'folder') {
                return notFound(res, 'Target folder not found');
            }
            if (!(await canAccessItemForWrite(target, actor))) {
                return forbid(res);
            }

            if (Number(item.parent_id) === Number(target.id)) {
                return res.json({ success: true, data: item, message: 'Already in target folder' });
            }

            if (item.item_type === 'folder') {
                const looping = await FileManagerModel.isDescendantOf(target.id, item.id);
                if (looping) {
                    return res.status(400).json({
                        success: false,
                        message: 'Cannot move a folder into itself or its descendant',
                    });
                }
            }

            const scopedItem = isScopedTreeItem(item);
            const scopedTarget = isScopedTreeItem(target);
            const targetOwnerId = Number(target.owner_id);
            const targetUsername = String(target.username || item.username || '').trim();

            const duplicate = await findActiveDuplicate({
                parentId: target.id,
                name: item.name,
                username: targetUsername || item.username || username,
                excludeId: item.id,
                anyScope: scopedItem || scopedTarget,
            });
            if (duplicate) {
                return res.status(409).json({
                    success: false,
                    message: 'An item with this name already exists in the target folder',
                });
            }

            const leafName = item.item_type === 'file'
                ? (item.storage_name || path.basename(item.relative_path || item.name))
                : item.name;
            const oldRelative = item.relative_path;
            const newRelative = joinRelative(target.relative_path, leafName);

            const oldAbs = resolveItemDiskPath(item);
            const newAbs =
                scopedItem || scopedTarget
                    ? path.join(resolveItemAbsoluteDir(target), leafName)
                    : absolutePath(newRelative);
            if (fs.existsSync(oldAbs)) {
                safeMovePath(oldAbs, newAbs);
            } else if (item.item_type === 'folder') {
                ensureDir(newAbs);
            }

            if (item.item_type === 'folder' && oldRelative !== newRelative) {
                await FileManagerModel.updatePathPrefixes({
                    oldRelative,
                    newRelative,
                    oldAbsolute: oldAbs,
                    newAbsolute: newAbs,
                    rootId: scopedItem
                        ? item.scope_root_id || item.id
                        : null,
                    ownerId: scopedItem ? null : Number(item.owner_id),
                });
            }

            const updated = await FileManagerModel.update(item.id, {
                parent_id: target.id,
                owner_id: targetOwnerId,
                username: targetUsername || item.username,
                relative_path: newRelative,     
                absolute_path: newAbs,
                ...(scopedItem || scopedTarget
                    ? {}
                    : { filemanager_path: getFileManagerPathValue() }),
                updated_by: username,
            });

            await writeFileManagerLog({
                action: 'UPDATE',
                entityType: item.item_type === 'folder' ? 'folder' : 'file',
                itemId: item.id,
                itemName: item.name,
                fieldName: 'parent_id',
                oldValue: item.parent_id,
                newValue: target.id,
                updatedBy: username,
                updatedByUserId: ownerId,
            });

            return res.json({ success: true, data: updated });
        } catch (error) {
            console.error('moveItem error:', error);
            return res.status(500).json({
                success: false,
                message: error.message || 'Failed to move item',
            });
        }
    }

    /**
     * List Recycle Bin.
     * Admin (no username): all user Recycle Bin folders (AAM, TMM, …).
     * Admin ?username= / non-admin: deleted items for that scope.
     */
    static async getRecycleBin(req, res) {
        try {
            const { ownerId, username, isAdmin } = await resolveActor(req);
            if (ownerId == null || !username) return unauthorized(res);

            const usernameFilter = String(
                req.query.username ?? req.query.user ?? '',
            ).trim() || null;
            const deletedByFilter = String(
                req.query.deleted_by ?? req.query.deletedBy ?? '',
            ).trim() || null;
            const wantFlat =
                String(req.query.flat || '').toLowerCase() === 'true' ||
                String(req.query.flat || '') === '1';

            // Non-admin: always scoped to own deletions
            let deletedBy = deletedByFilter;
            let ownerUsername = usernameFilter;

            if (!isAdmin) {
                deletedBy = username;
                if (
                    ownerUsername &&
                    ownerUsername.toLowerCase() !== String(username).toLowerCase()
                ) {
                    return forbid(
                        res,
                        'You can only view your own Recycle Bin items',
                    );
                }
                if (!ownerUsername) ownerUsername = null;
            }

            const fmPath = getFileManagerPathValue();

            // Admin root: ensure every user has Recycle Bin/{username}, then list all folders
            if (isAdmin && !ownerUsername && !deletedByFilter && !wantFlat) {
                try {
                    ensureDir(absolutePath(RECYCLE_BIN_FOLDER));
                    const ensured =
                        await FileManagerModel.ensureAllUserRecycleBinFolders({
                            filemanagerPath: fmPath,
                            updatedBy: username,
                        });
                    for (const f of ensured.folders || []) {
                        try {
                            ensureDir(absolutePath(f.relative_path));
                        } catch {
                            /* ignore */
                        }
                    }
                } catch (ensureErr) {
                    console.warn(
                        'getRecycleBin ensure user folders:',
                        ensureErr.message,
                    );
                }

                const folders = mergeRecycleBinUserFoldersFromDisk(
                    await FileManagerModel.findRecycleBinUserFolders({
                        filemanagerPath: fmPath,
                    }),
                );

                return res.json({
                    success: true,
                    view: 'user_folders',
                    data: folders,
                    filters: {
                        username: null,
                        deleted_by: null,
                    },
                    filemanager_path: fmPath,
                    is_admin: true,
                });
            }

            const syncName = !isAdmin
                ? username
                : ownerUsername || deletedBy || null;
            if (syncName) {
                try {
                    const matched = await lookupUserByFolderName(syncName);
                    await syncPhysicalRecycleBinToDatabase({
                        ownerId: matched?.id || ownerId,
                        username: matched?.username || syncName,
                        actorUsername: matched?.username || syncName,
                    });
                } catch (syncErr) {
                    console.warn(
                        'Physical Recycle Bin sync skipped:',
                        syncErr?.message || syncErr,
                    );
                }
            }

            const items = await FileManagerModel.findRecycleBinItems({
                deletedBy: isAdmin ? deletedBy : username,
                username: isAdmin ? ownerUsername : ownerUsername,
                filemanagerPath: fmPath,
            });
            for (const item of items || []) {
                try {
                    await ensureDeletedShortcutOnDisk(item);
                } catch (shortcutErr) {
                    console.warn(
                        'Recycle Bin shortcut file skipped:',
                        shortcutErr?.message || shortcutErr,
                    );
                }
            }

            return res.json({
                success: true,
                view: 'items',
                data: attachListMeta(items),
                filters: {
                    username: ownerUsername,
                    deleted_by: isAdmin ? deletedBy : username,
                },
                filemanager_path: fmPath,
                is_admin: isAdmin,
            });
        } catch (error) {
            console.error('getRecycleBin error:', error);
            return res.status(500).json({
                success: false,
                message: error.message || 'Failed to list Recycle Bin',
            });
        }
    }

    /** Restore an item the current user deleted back to original_path. */
    static async restoreFromRecycleBin(req, res) {
        try {
            const { ownerId, username } = await resolveActor(req);
            if (ownerId == null || !username) return unauthorized(res);

            const item = await FileManagerModel.findDeletedByIdForUser(
                req.params.id,
                username,
            );
            if (!item) {
                return notFound(res, 'Recycle Bin item not found');
            }

            const result = await restoreRecycleItem(item);
            await writeFileManagerLog({
                action: 'UPDATE',
                entityType: item.item_type === 'folder' ? 'folder' : 'file',
                itemId: item.id,
                itemName: item.name,
                fieldName: 'restore',
                oldValue: 'Recycle Bin',
                newValue: item.original_path || item.relative_path || item.name,
                updatedBy: username,
                updatedByUserId: ownerId,
            });
            return res.json({
                success: true,
                message: 'Item restored',
                data: {
                    restored_count: result.restored_count,
                    item: result.item,
                },
            });
        } catch (error) {
            console.error('restoreFromRecycleBin error:', error);
            const status = error.status || 500;
            return res.status(status).json({
                success: false,
                message: error.message || 'Failed to restore item',
            });
        }
    }

    /** Permanently delete an item the current user deleted. */
    static async permanentDeleteFromRecycleBin(req, res) {
        try {
            const { ownerId, username } = await resolveActor(req);
            if (ownerId == null || !username) return unauthorized(res);

            const item = await FileManagerModel.findDeletedByIdForUser(
                req.params.id,
                username,
            );
            if (!item) {
                return notFound(res, 'Recycle Bin item not found');
            }

            const result = await permanentDeleteRecycleItem(item);
            await writeFileManagerLog({
                action: 'DELETE',
                entityType: item.item_type === 'folder' ? 'folder' : 'file',
                itemId: item.id,
                itemName: item.name,
                fieldName: 'permanent',
                oldValue: item.name,
                newValue: null,
                updatedBy: username,
                updatedByUserId: ownerId,
            });
            return res.json({
                success: true,
                message: 'Item permanently deleted',
                data: {
                    deleted_count: result.deleted_count,
                    id: item.id,
                },
            });
        } catch (error) {
            console.error('permanentDeleteFromRecycleBin error:', error);
            return res.status(500).json({
                success: false,
                message: error.message || 'Failed to permanently delete item',
            });
        }
    }

    /**
     * Permanent delete (no Recycle Bin) — shared by file + folder routes.
     * Requires ?confirm=true (or body { confirm: true }).
     */
    static async permanentDeleteItem(req, res, expectedType = null) {
        try {
            const { ownerId, username, isAdmin } = await resolveActor(req);
            if (ownerId == null || !username) return unauthorized(res);

            const confirmed =
                String(req.query?.confirm ?? '').trim().toLowerCase() ===
                    'true' ||
                req.body?.confirm === true ||
                String(req.body?.confirm ?? '').trim().toLowerCase() ===
                    'true';
            if (!confirmed) {
                return res.status(400).json({
                    success: false,
                    message:
                        'Permanent delete is irreversible. Pass ?confirm=true to continue',
                });
            }

            const actor = { ownerId, username, isAdmin };
            const item = await FileManagerModel.findByIdOrPublicId(
                req.params.id,
                { includeDeleted: true, anyScope: true },
            );
            const itemType = String(item?.item_type || '')
                .trim()
                .toLowerCase();
            if (!item || (expectedType && itemType !== expectedType)) {
                return notFound(
                    res,
                    expectedType === 'folder'
                        ? 'Folder not found'
                        : expectedType === 'file'
                          ? 'File not found'
                          : 'Item not found',
                );
            }
            if (!(await canAccessItemForWrite(item, actor))) {
                return forbid(res);
            }

            const result = await permanentDeleteItemForever(item);
            await writeFileManagerLog({
                action: 'DELETE',
                entityType: itemType === 'folder' ? 'folder' : 'file',
                itemId: item.id,
                itemName: item.name,
                fieldName: 'permanent',
                oldValue: item.name,
                newValue: null,
                updatedBy: username,
                updatedByUserId: ownerId,
            });
            return res.json({
                success: true,
                message:
                    itemType === 'folder'
                        ? 'Folder permanently deleted'
                        : 'File permanently deleted',
                data: {
                    deleted_count: result.deleted_count,
                    id: result.item.id,
                    public_id: result.item.public_id,
                    name: result.item.name,
                    item_type: result.item.item_type,
                },
            });
        } catch (error) {
            console.error('permanentDeleteItem error:', error);
            const status = error.status || 500;
            return res.status(status).json({
                success: false,
                message: error.message || 'Failed to permanently delete item',
            });
        }
    }

    /** DELETE /api/file-manager/items/:id/permanent?confirm=true — file or folder by id */
    static async permanentDelete(req, res) {
        return FileManagerController.permanentDeleteItem(req, res, null);
    }

    /**
     * POST /api/file-manager/items/:id/replace — one common replace by id.
     * - file id   → single file replace (old file deleted, same row updated)
     * - folder id → old folder contents deleted (disk + DB), new folder
     *               files uploaded under the same folder id
     * multipart: file/files (optional when folder_name or a path ending with /
     *            is sent), paths (JSON/array; a path ending with / is a folder),
     *            folder_name (wrapper prefix to strip from paths; also allows
     *            replacing with an empty folder),
     *            name (optional new name for a replaced file/folder)
     */
    static async replaceItem(req, res) {
        const collected = [
            ...(Array.isArray(req.files?.file) ? req.files.file : []),
            ...(Array.isArray(req.files?.files) ? req.files.files : []),
            ...(Array.isArray(req.files) ? req.files : []),
            ...(req.file ? [req.file] : []),
        ];
        try {
            const { ownerId, username, isAdmin } = await resolveActor(req);
            if (ownerId == null || !username) {
                collected.forEach(cleanupUploadedTempFile);
                return unauthorized(res);
            }

            const actor = { ownerId, username, isAdmin };
            const item = await FileManagerModel.findByIdOrPublicId(
                req.params.id,
                { anyScope: true },
            );
            if (!item) {
                collected.forEach(cleanupUploadedTempFile);
                return notFound(res, 'Item not found');
            }

            const itemType = String(item.item_type || '')
                .trim()
                .toLowerCase();

            // File: reuse the single-file replace flow
            if (itemType === 'file') {
                return FileManagerController.replaceFile(req, res);
            }
            if (itemType !== 'folder') {
                collected.forEach(cleanupUploadedTempFile);
                return notFound(res, 'Item not found');
            }

            // ---- Folder replace ----
            if (!(await canAccessItemForWrite(item, actor))) {
                collected.forEach(cleanupUploadedTempFile);
                return forbid(res);
            }

            let pathsRaw = req.body?.paths ?? req.body?.['paths[]'] ?? null;
            let paths = [];
            if (typeof pathsRaw === 'string') {
                const trimmed = pathsRaw.trim();
                if (trimmed.startsWith('[')) {
                    try {
                        paths = JSON.parse(trimmed);
                    } catch {
                        paths = [trimmed];
                    }
                } else {
                    paths = [trimmed];
                }
            } else if (Array.isArray(pathsRaw)) {
                paths = pathsRaw;
            }

            const folderPaths = [];
            const filePaths = [];
            for (const entry of paths) {
                const text = String(entry ?? '').replace(/\\/g, '/');
                if (text.trim().endsWith('/')) folderPaths.push(text);
                else filePaths.push(text);
            }
            paths = filePaths;

            if (paths.length && collected.length && paths.length !== collected.length) {
                collected.forEach(cleanupUploadedTempFile);
                return res.status(400).json({
                    success: false,
                    message: `paths length (${paths.length}) must match files length (${collected.length})`,
                });
            }

            const wrapperName = sanitizeFolderName(req.body?.folder_name || '');
            if (!collected.length && !folderPaths.length && !wrapperName) {
                return res.status(400).json({
                    success: false,
                    message: 'Files or folder_name are required',
                });
            }
            const scoped = isScopedTreeItem(item);
            const fmPath = getFileManagerPathValue();
            const targetOwnerId = Number(item.owner_id);
            const targetUsername =
                String(item.username || username).trim() || username;

            // Optional rename of the folder itself
            let root = item;
            const requestedName = sanitizeFolderName(req.body?.name || '');
            let rootAbs = resolveItemDiskPath(item);
            if (requestedName && requestedName !== item.name) {
                const parent = item.parent_id
                    ? await FileManagerModel.findById(item.parent_id, {
                          anyScope: true,
                      })
                    : null;
                const duplicate = await findActiveDuplicate({
                    parentId: item.parent_id,
                    name: requestedName,
                    username: targetUsername,
                    excludeId: item.id,
                    anyScope: scoped,
                });
                if (duplicate) {
                    collected.forEach(cleanupUploadedTempFile);
                    return res.status(409).json({
                        success: false,
                        message:
                            'A folder or file with this name already exists here',
                    });
                }
                const newRelative = parent
                    ? joinRelative(parent.relative_path, requestedName)
                    : requestedName;
                const newAbs = scoped
                    ? path.join(
                          parent
                              ? resolveItemAbsoluteDir(parent)
                              : path.dirname(rootAbs),
                          requestedName,
                      )
                    : absolutePath(newRelative);
                if (fs.existsSync(newAbs)) {
                    collected.forEach(cleanupUploadedTempFile);
                    return res.status(409).json({
                        success: false,
                        message:
                            'A folder with this name already exists on storage',
                    });
                }
                // Whole previous folder goes to the Windows Recycle Bin, then the new folder is created.
                if (fs.existsSync(rootAbs)) {
                    sendToOperatingSystemRecycleBin(rootAbs);
                }
                ensureDir(newAbs);
                const deletedOld =
                    await FileManagerModel.permanentDeleteDescendants(item.id);
                root =
                    (await FileManagerModel.update(item.id, {
                        name: requestedName,
                        storage_name: null,
                        relative_path: newRelative,
                        absolute_path: newAbs,
                        ...(scoped ? {} : { filemanager_path: fmPath }),
                        updated_by: username,
                    })) || item;
                rootAbs = newAbs;

                return FileManagerController.finishFolderReplace(req, res, {
                    root,
                    rootAbs,
                    collected,
                    paths,
                    folderPaths,
                    wrapperName,
                    scoped,
                    fmPath,
                    targetOwnerId,
                    targetUsername,
                    actor,
                    deletedOldCount: deletedOld.length,
                });
            }

            // Whole previous folder goes to the Windows Recycle Bin, then an empty folder is created for the new files.
            if (fs.existsSync(rootAbs)) {
                sendToOperatingSystemRecycleBin(rootAbs);
            }
            ensureDir(rootAbs);
            const deletedOld =
                await FileManagerModel.permanentDeleteDescendants(item.id);

            return FileManagerController.finishFolderReplace(req, res, {
                root,
                rootAbs,
                collected,
                paths,
                folderPaths,
                wrapperName,
                scoped,
                fmPath,
                targetOwnerId,
                targetUsername,
                actor,
                deletedOldCount: deletedOld.length,
            });
        } catch (error) {
            collected.forEach(cleanupUploadedTempFile);
            console.error('replaceItem error:', error);
            return res.status(500).json({
                success: false,
                message: error.message || 'Failed to replace item',
            });
        }
    }

    /** Upload the new folder contents after old contents were deleted. */
    static async finishFolderReplace(req, res, ctx) {
        const {
            root,
            rootAbs,
            collected,
            paths,
            folderPaths = [],
            wrapperName,
            scoped,
            fmPath,
            targetOwnerId,
            targetUsername,
            actor,
            deletedOldCount,
        } = ctx;
        const username = actor.username;

        ensureDir(rootAbs);
        const folderCache = new Map();
        folderCache.set(
            String(root.relative_path).replace(/\\/g, '/'),
            root,
        );
        const foldersCreated = [];

        async function ensureFolderUnder(baseFolder, folderName) {
            const name = sanitizeFolderName(folderName);
            if (!name) return baseFolder;
            const relativePath = joinRelative(baseFolder.relative_path, name);
            const cacheKey = relativePath.replace(/\\/g, '/');
            if (folderCache.has(cacheKey)) return folderCache.get(cacheKey);

            const underScoped = scoped || isScopedTreeItem(baseFolder);
            const abs = underScoped
                ? path.join(resolveItemAbsoluteDir(baseFolder), name)
                : absolutePath(relativePath);
            ensureDir(abs);
            const created = underScoped
                ? await createScopedUploadedFolder({
                      parent: baseFolder,
                      name,
                      relativePath,
                      absolutePath: abs,
                      actorUsername: username,
                      actorUserId: actor.ownerId,
                  })
                : await FileManagerModel.create({
                      owner_id: targetOwnerId,
                      username: targetUsername,
                      parent_id: baseFolder.id,
                      name,
                      item_type: 'folder',
                      storage_name: null,
                      relative_path: relativePath,
                      filemanager_path: fmPath,
                      created_by: username,
                      updated_by: username,
                  });
            folderCache.set(cacheKey, created);
            foldersCreated.push({
                id: created.id,
                name: created.name,
                relative_path: created.relative_path,
            });
            return created;
        }

        const uploaded = [];
        const skipped = [];
        const errors = [];

        for (let i = 0; i < collected.length; i += 1) {
            const file = collected[i];
            try {
                let rawPath = String(
                    paths[i] || file.originalname || `file-${i}`,
                )
                    .replace(/\\/g, '/')
                    .replace(/^\/+|\/+$/g, '');
                if (
                    wrapperName &&
                    rawPath.toLowerCase().startsWith(`${wrapperName.toLowerCase()}/`)
                ) {
                    rawPath = rawPath.slice(wrapperName.length + 1);
                }
                const segments = rawPath
                    .split('/')
                    .map((s) => sanitizeFolderName(s))
                    .filter(Boolean);
                if (!segments.length) {
                    skipped.push({ path: rawPath, reason: 'Empty path' });
                    cleanupUploadedTempFile(file);
                    continue;
                }

                const fileName = segments[segments.length - 1];
                let current = root;
                for (const seg of segments.slice(0, -1)) {
                    current = await ensureFolderUnder(current, seg);
                }

                const underScoped = scoped || isScopedTreeItem(current);
                const duplicate = await findActiveDuplicate({
                    parentId: current.id,
                    name: fileName,
                    username: targetUsername,
                    anyScope: underScoped,
                });
                if (duplicate) {
                    skipped.push({
                        path: rawPath,
                        reason:
                            'A folder or file with this name already exists here',
                    });
                    cleanupUploadedTempFile(file);
                    continue;
                }

                const relativePath = joinRelative(
                    current.relative_path,
                    fileName,
                );
                const abs = underScoped
                    ? path.join(resolveItemAbsoluteDir(current), fileName)
                    : absolutePath(relativePath);
                ensureDir(path.dirname(abs));
                if (fs.existsSync(abs)) {
                    skipped.push({
                        path: rawPath,
                        reason: 'A file with this name already exists on storage',
                    });
                    cleanupUploadedTempFile(file);
                    continue;
                }

                await persistUploadedFile(file, abs);
                const extension =
                    getExtension(file.originalname) || getExtension(fileName);
                const createdFile = underScoped
                    ? await createScopedUploadedFile({
                          parent: current,
                          displayName: fileName,
                          storageName: fileName,
                          relativePath,
                          absolutePath: abs,
                          mimeType: file.mimetype || null,
                          extension,
                          size: file.size ?? null,
                          actorUsername: username,
                          actorUserId: actor.ownerId,
                      })
                    : await FileManagerModel.create({
                          owner_id: targetOwnerId,
                          username: targetUsername,
                          parent_id: current.id,
                          name: fileName,
                          item_type: 'file',
                          storage_name: fileName,
                          relative_path: relativePath,
                          filemanager_path: fmPath,
                          mime_type: file.mimetype || null,
                          extension,
                          size: file.size ?? null,
                          created_by: username,
                          updated_by: username,
                      });
                uploaded.push(createdFile);
            } catch (err) {
                cleanupUploadedTempFile(file);
                errors.push({
                    path: paths[i] || file?.originalname || `index-${i}`,
                    reason: err?.message || 'Failed to upload file',
                });
            }
        }

        for (const rawEmpty of folderPaths) {
            try {
                let rawPath = String(rawEmpty || '').replace(/\\/g, '/');
                if (
                    wrapperName &&
                    rawPath.toLowerCase().startsWith(`${wrapperName.toLowerCase()}/`)
                ) {
                    rawPath = rawPath.slice(wrapperName.length + 1);
                }
                const segments = rawPath
                    .replace(/^\/+|\/+$/g, '')
                    .split('/')
                    .map((segment) => segment.trim())
                    .filter(Boolean)
                    .map((segment) => sanitizeFolderName(segment))
                    .filter(Boolean);

                let current = root;
                for (const seg of segments) {
                    current = await ensureFolderUnder(current, seg);
                }
            } catch (err) {
                errors.push({
                    path: String(rawEmpty || ''),
                    reason: err?.message || 'Failed to create empty folder',
                });
            }
        }

        const updatedRoot =
            (await FileManagerModel.findById(root.id, { anyScope: true })) ||
            root;

        return res.json({
            success: true,
            message: 'Folder replaced successfully',
            data: {
                item: attachItemMeta(updatedRoot),
                uploaded: await attachCreatedByUser(uploaded),
                folders_created: foldersCreated,
                skipped,
                errors,
                counts: {
                    deleted_old: deletedOldCount,
                    uploaded: uploaded.length,
                    folders_created: foldersCreated.length,
                    skipped: skipped.length,
                    errors: errors.length,
                    total_files: collected.length,
                },
            },
        });
    }

    /**
     * GET /file-manager/google-sheets
     * All Google Sheets for the logged-in user (created/owned) + project sheets assigned to them.
     * Query: search, limit, source=user|project|all, all=true (admin)
     */
    static async listGoogleSheets(req, res) {
        try {
            const { ownerId, username, isAdmin } = await resolveActor(req);
            if (ownerId == null || !username) return unauthorized(res);

            const search = req.query?.search || req.query?.q || null;
            const limit = req.query?.limit;
            const source = String(req.query?.source || 'all')
                .trim()
                .toLowerCase();
            const allowAll =
                isAdmin &&
                ['1', 'true', 'yes'].includes(
                    String(req.query?.all || '').trim().toLowerCase(),
                );

            const wantUser = source === 'all' || source === 'user' || source === 'my';
            const wantProject =
                source === 'all' || source === 'project' || source === 'assigned';

            const [userSheets, projectSheets] = await Promise.all([
                wantUser
                    ? FileManagerModel.listGoogleSheets({
                          ownerId,
                          username,
                          search,
                          limit,
                          allowAll,
                      })
                    : Promise.resolve([]),
                wantProject
                    ? ProjectFileManagerModel.listGoogleSheetsForUser({
                          userId: ownerId,
                          username,
                          search,
                          limit,
                          allowAll,
                      })
                    : Promise.resolve([]),
            ]);

            const data = [
                ...userSheets.map((row) => ({
                    id: row.id,
                    public_id: row.public_id || null,
                    name: row.name,
                    item_type: row.item_type || 'file',
                    file_source: row.file_source || 'google_sheet',
                    google_file_id: row.google_file_id || null,
                    url: row.url || null,
                    owner_id: row.owner_id,
                    username: row.username,
                    parent_id: row.parent_id,
                    relative_path: row.relative_path,
                    created_at: row.created_at,
                    updated_at: row.updated_at,
                    source: 'user_folder',
                })),
                ...projectSheets.map((row) => ({
                    id: row.id,
                    public_id: row.public_id || null,
                    name: row.name,
                    item_type: row.item_type || 'google_sheet',
                    file_source: 'google_sheet',
                    google_file_id: row.google_file_id || null,
                    url: row.url || null,
                    owner_id: row.owner_id,
                    username: row.folder_username,
                    parent_id: row.parent_id,
                    project_folder_id: row.project_folder_id,
                    project_code: row.project_code,
                    relative_path: row.relative_path,
                    created_at: row.created_at,
                    updated_at: row.updated_at,
                    source: 'project_folder',
                })),
            ];

            return res.json({
                success: true,
                count: data.length,
                data,
            });
        } catch (error) {
            console.error('listGoogleSheets error:', error);
            return res.status(500).json({
                success: false,
                message: error.message || 'Failed to list Google Sheets',
            });
        }
    }
}

export {
    RECYCLE_BIN_FOLDER,
    resolveActor,
    unauthorized,
    notFound,
    forbid,
    assertOwner,
    canAccessItemForWrite,
    sanitizeFolderName,
    sanitizeGoogleItemName,
    isRecycleBinPath,
    findActiveDuplicate,
    joinRelative,
    absolutePath,
    ensureDir,
    getFileManagerPathValue,
    attachGoogleFileMeta,
    syncFsChildren,
    ownFolderName,
    findExistingOwnRoot,
    ensureUserRecycleBinFolder,
    isScopedTreeItem,
    resolveWritableParent,
    resolveItemAbsoluteDir,
    createScopedUploadedFolder,
};

export default FileManagerController;
