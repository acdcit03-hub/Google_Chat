import path from 'path';
import ProjectFileManagerModel from '../../models/filemanager/projectFileManager.model.js';
import FinancialYearFileManagerModel from '../../models/filemanager/financialYearFileManager.model.js';
import FileManagerModel from '../../models/filemanager/fileManager.model.js';
import FileManagerPermissionModel, {
    capabilitiesForRole,
    hasPermissionRole,
    PERMISSION_ROLES,
} from '../../models/filemanager/fileManagerPermission.model.js';
import { wrapController } from '../../middleware/error.middleware.js';
import { listDiskChildren } from '../../services/filemanager/diskChildren.js';
import {
    resolveActor,
    unauthorized,
    notFound,
    attachGoogleFileMeta,
} from './fileManager.controller.js';
import {
    ensureProjectRootFromDisk,
    syncProjectFolderLevelFromDisk,
} from './projectFileManager.controller.js';
import fs from 'fs';
import {
    attachCreatedByUser,
    pickItemCreatorFields,
} from '../../utils/fileManagerCreatedBy.js';

function parseId(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
}


/** page/limit from query — default 48, max 200 (same as personal folder children). */
function parsePaginationQuery(query = {}) {
    const rawLimit = Number(query.limit ?? query.page_size);
    const rawPage = Number(query.page ?? 1);
    const limit = Number.isFinite(rawLimit)
        ? Math.min(Math.max(Math.trunc(rawLimit), 1), 200)
        : 48;
    const page = Number.isFinite(rawPage)
        ? Math.max(Math.trunc(rawPage), 1)
        : 1;
    return { page, limit };
}

/** Optional query filter: item_type=folder|file */
function parseItemTypeFilter(query = {}) {
    const raw = String(query.item_type ?? query.itemType ?? '')
        .trim()
        .toLowerCase();
    if (raw === 'folder' || raw === 'file') return raw;
    return null;
}

function normalizeSharedItemType(itemType) {
    const t = String(itemType || 'folder')
        .trim()
        .toLowerCase();
    if (!t || t === 'folder') return 'folder';
    return 'file';
}

function filterRowsByItemType(rows, itemTypeFilter) {
    if (!itemTypeFilter) return Array.isArray(rows) ? rows : [];
    return (Array.isArray(rows) ? rows : []).filter(
        (row) =>
            normalizeSharedItemType(row?.item_type) === itemTypeFilter,
    );
}

function paginateRows(rows, { page, limit }) {
    const list = Array.isArray(rows) ? rows : [];
    const total = list.length;
    const totalPages = Math.max(1, Math.ceil(total / limit) || 1);
    const safePage = Math.min(page, totalPages);
    const offset = (safePage - 1) * limit;
    const data = list.slice(offset, offset + limit);
    return {
        data,
        pagination: {
            page: safePage,
            limit,
            total,
            total_pages: totalPages,
            has_more: offset + data.length < total,
            offset,
        },
    };
}

function fullAccessPermissions(assignedByUsername) {
    return {
        role: PERMISSION_ROLES.OWNER,
        assigned_by_username: assignedByUsername,
    };
}

/**
 * Access block for the *current* logged-in user on a shared item.
 * is_owner is derived ONLY from role === 'owner' — never invent owner.
 */
function buildShareAccessFromRole(role, currentUsername = null) {
    const username = String(currentUsername || '').trim();
    if (!role) {
        return {
            current_username: username || null,
            role: null,
            is_owner: false,
        };
    }
    const caps = capabilitiesForRole(role);
    return {
        current_username: username || null,
        role: caps.role,
        is_owner: caps.is_owner,
    };
}

/**
 * Child access under a shared parent:
 * 1) Explicit permission row on this item → that role
 *    (when parent is_childshare=false, only *direct* rows count — ignore stale cascade)
 * 2) Else inherit parent role only when parent is_childshare=true
 * 3) Never invent owner from folder ownership
 */
/**
 * Inherited permission rows are stored with is_childshare=false so they do not
 * start a new cascade. That flag must not hide the folder's own children.
 * A direct share still honors is_childshare.
 */
function listingSharesChildren(perm) {
    if (!perm) return true;
    if (perm.inherited_from_item_id != null) return true;
    if (perm.is_childshare == null) return true;
    return Boolean(perm.is_childshare);
}

function resolveChildAccess({
    userPerm,
    parentSharePerms,
    isAdmin,
    currentUsername,
}) {
    const parentSharesChildren =
        parentSharePerms?.is_childshare !== false &&
        Boolean(parentSharePerms?.role);

    let perm = userPerm && hasPermissionRole(userPerm) ? userPerm : null;
    // Specific share on parent: do not treat cascaded/inherited child rows as access
    if (
        perm &&
        parentSharePerms?.is_childshare === false &&
        perm.inherited_from_item_id != null
    ) {
        perm = null;
    }

    if (perm) {
        return buildShareAccessFromRole(perm.role, currentUsername);
    }
    if (parentSharesChildren) {
        return buildShareAccessFromRole(
            parentSharePerms.role,
            currentUsername,
        );
    }
    if (isAdmin) {
        return buildShareAccessFromRole(
            PERMISSION_ROLES.OWNER,
            currentUsername,
        );
    }
    return buildShareAccessFromRole(null, currentUsername);
}

function toSharedRootItem(row, shareType, currentUsername = null) {
    const id = Number(row.id);
    const isProject = shareType === 'project';
    const itemType = normalizeSharedItemType(row.item_type || 'folder');
    const name = String(
        row.name ||
            row.folder_name ||
            row.project_code ||
            row.year_code ||
            id,
    ).trim();
    const relative_path =
        row.relative_path ||
        (isProject
            ? `${row.financial_year || ''}/${row.project_code || name}`.replace(
                  /^\/+|\/+$/g,
                  '',
              )
            : row.year_code || name);

    const access = buildShareAccessFromRole(
        row.role,
        currentUsername || row.access_username,
    );

    return attachGoogleFileMeta({
        id,
        public_id: row.public_id || null,
        name,
        item_type: itemType,
        parent_id: row.parent_id != null ? Number(row.parent_id) : null,
        relative_path,
        absolute_path: row.absolute_path || null,
        share_type: shareType,
        project_id: row.project_id ?? null,
        project_code: row.project_code ?? null,
        financial_year: row.financial_year || row.year_code || null,
        year_code: row.year_code ?? null,
        owner_id: row.owner_id ?? null,
        username: row.username ?? null,
        role: access.role,
        assigned_by_username: row.assigned_by_username ?? null,
        assigned_at: row.assigned_at ?? null,
        is_owner: access.is_owner,
        inherited_from_item_id:
            row.inherited_from_item_id != null
                ? Number(row.inherited_from_item_id)
                : null,
        share_id: row.share_id ?? null,
        access_user_id: row.access_user_id ?? null,
        access_username: row.access_username ?? null,
        children_api:
            itemType === 'file'
                ? null
                : `/api/file-manager/shared-with-me/folders/${id}/children`,
        access,
        storage_name: row.storage_name ?? null,
        mime_type: row.mime_type ?? null,
        extension: row.extension ?? null,
        size: row.size ?? null,
        file_source: row.file_source ?? null,
        google_file_id: row.google_file_id ?? null,
        google_drive_folder_id: row.google_drive_folder_id ?? null,
        url: row.url ?? null,
        preview_url: row.preview_url ?? null,
        ...pickItemCreatorFields(row),
    });
}

function toProjectChildItem(
    item,
    projectFolderId,
    permissions = {},
    currentUsername = null,
) {
    const id = Number(item.id);
    const itemType = normalizeSharedItemType(item.item_type);
    const access = buildShareAccessFromRole(
        permissions.role,
        currentUsername,
    );
    return attachGoogleFileMeta({
        id,
        public_id: item.public_id || null,
        name: item.folder_name || item.name || String(id),
        item_type: itemType,
        parent_id: item.parent_id != null ? Number(item.parent_id) : null,
        relative_path: item.relative_path || null,
        absolute_path: item.absolute_path || null,
        share_type: 'project',
        project_folder_id: Number(projectFolderId),
        display_order: item.display_order ?? 0,
        role: access.role,
        is_owner: access.is_owner,
        children_api:
            itemType === 'file'
                ? null
                : `/api/file-manager/shared-with-me/folders/${id}/children`,
        access,
        ...pickItemCreatorFields(item),
        storage_name: item.storage_name ?? null,
        mime_type: item.mime_type ?? null,
        extension: item.extension ?? null,
        size: item.size ?? null,
        file_source: item.file_source ?? null,
        google_file_id: item.google_file_id ?? null,
        google_drive_folder_id: item.google_drive_folder_id ?? null,
        url: item.url ?? null,
        preview_url: item.preview_url ?? null,
    });
}

function toFyChildItem(
    child,
    fyFolderId,
    relativeBase,
    permissions = {},
    currentUsername = null,
    dbRow = null,
) {
    const name = child.name;
    const rel = relativeBase
        ? `${relativeBase}/${name}`.replace(/\\/g, '/')
        : name;
    const isFolder = child.item_type === 'folder';
    const access = buildShareAccessFromRole(
        permissions.role,
        currentUsername,
    );
    const dbId = dbRow?.id != null ? Number(dbRow.id) : null;
    const dbParentId =
        dbRow?.parent_id != null
            ? Number(dbRow.parent_id)
            : Number(fyFolderId);
    // Prefer project-folder children API when DB id exists
    const childrenApi = !isFolder
        ? null
        : dbId
          ? `/api/file-manager/shared-with-me/folders/${dbId}/children`
          : `/api/file-manager/shared-with-me/folders/${fyFolderId}/children?path=${encodeURIComponent(rel)}`;
    return attachGoogleFileMeta({
        id: dbId,
        public_id: dbRow?.public_id || null,
        name: dbRow?.folder_name || dbRow?.name || name,
        item_type: isFolder ? 'folder' : 'file',
        parent_id: dbId != null ? dbParentId : Number(fyFolderId),
        relative_path: dbRow?.relative_path || rel,
        absolute_path: dbRow?.absolute_path || child.absolute_path || null,
        size: child.size ?? null,
        share_type: dbId != null ? 'project' : 'financial_year',
        project_folder_id: dbId,
        project_id: dbRow?.project_id ?? null,
        project_code: dbRow?.project_code ?? null,
        owner_id: dbRow?.owner_id ?? null,
        username: dbRow?.username ?? null,
        fy_folder_id: Number(fyFolderId),
        role: access.role,
        is_owner: access.is_owner,
        children_api: childrenApi,
        access,
        ...pickItemCreatorFields(dbRow),
        file_source: dbRow?.file_source ?? child.file_source ?? null,
        google_file_id: dbRow?.google_file_id ?? child.google_file_id ?? null,
        google_drive_folder_id:
            dbRow?.google_drive_folder_id ??
            child.google_drive_folder_id ??
            null,
        url: dbRow?.url ?? child.url ?? null,
        preview_url: dbRow?.preview_url ?? child.preview_url ?? null,
    });
}

async function assertSharedAccess({
    shareType,
    folderId,
    userId,
    username,
    isAdmin,
}) {
    if (shareType === 'project') {
        const folder = await ProjectFileManagerModel.findById(folderId);
        if (!folder) {
            const err = new Error('Project file manager folder not found');
            err.status = 404;
            throw err;
        }
        const access = await ProjectFileManagerModel.findUser(folderId, userId);
        const byName =
            !access && username
                ? (
                      await ProjectFileManagerModel.listUsers(folderId)
                  ).find(
                      (u) =>
                          String(u.username || '')
                              .trim()
                              .toLowerCase() ===
                              String(username).trim().toLowerCase() &&
                          hasPermissionRole(u),
                  )
                : null;
        let perm = access || byName;
        // Inherit from parent FY only when that FY share includes children
        if (!hasPermissionRole(perm) && folder.parent_id != null) {
            const fyAccess = await FinancialYearFileManagerModel.findUser(
                Number(folder.parent_id),
                userId,
            );
            const fyByName =
                !fyAccess && username
                    ? (
                          await FinancialYearFileManagerModel.listUsers(
                              Number(folder.parent_id),
                          )
                      ).find(
                          (u) =>
                              String(u.username || '')
                                  .trim()
                                  .toLowerCase() ===
                                  String(username).trim().toLowerCase() &&
                              hasPermissionRole(u),
                      )
                    : null;
            const parentPerm = fyAccess || fyByName || null;
            const parentSharesChildren =
                hasPermissionRole(parentPerm) &&
                (parentPerm.is_childshare == null ||
                    Boolean(parentPerm.is_childshare));
            if (parentSharesChildren) {
                perm = parentPerm;
            }
        }
        // Stale cascade from a parent that no longer shares children → deny
        if (
            hasPermissionRole(perm) &&
            perm.inherited_from_item_id != null &&
            folder.parent_id != null &&
            Number(perm.inherited_from_item_id) === Number(folder.parent_id)
        ) {
            const parentDirect =
                await FinancialYearFileManagerModel.findUser(
                    Number(folder.parent_id),
                    userId,
                );
            if (
                hasPermissionRole(parentDirect) &&
                parentDirect.is_childshare === false
            ) {
                perm = null;
            }
        }
        if (!isAdmin && !hasPermissionRole(perm)) {
            const err = new Error(
                'You do not have access to this shared project folder',
            );
            err.status = 403;
            throw err;
        }
        // Shared-with-me: role/is_owner only from file_manager_permissions (or admin)
        const basePerm =
            perm ||
            (isAdmin ? fullAccessPermissions(username || 'admin') : null);
        const role =
            basePerm?.role ||
            (isAdmin ? PERMISSION_ROLES.OWNER : null);
        return {
            folder,
            permissions: {
                ...basePerm,
                role,
                is_childshare: listingSharesChildren(basePerm),
                is_owner:
                    Boolean(isAdmin) ||
                    String(role || '').toLowerCase() ===
                        PERMISSION_ROLES.OWNER,
                current_username: username || null,
            },
            shareType: 'project',
        };
    }

    if (
        shareType === 'financial_year' ||
        shareType === 'fy' ||
        shareType === 'year'
    ) {
        const folder = await FinancialYearFileManagerModel.findById(folderId);
        if (!folder) {
            const err = new Error('Financial year folder not found');
            err.status = 404;
            throw err;
        }
        const access = await FinancialYearFileManagerModel.findUser(
            folderId,
            userId,
        );
        const byName =
            !access && username
                ? (
                      await FinancialYearFileManagerModel.listUsers(folderId)
                  ).find(
                      (u) =>
                          String(u.username || '')
                              .trim()
                              .toLowerCase() ===
                              String(username).trim().toLowerCase() &&
                          hasPermissionRole(u),
                  )
                : null;
        const perm = access || byName;
        if (!isAdmin && !hasPermissionRole(perm)) {
            const err = new Error(
                'You do not have access to this shared financial year folder',
            );
            err.status = 403;
            throw err;
        }
        const basePerm =
            perm ||
            (isAdmin ? fullAccessPermissions(username || 'admin') : null);
        const role =
            basePerm?.role ||
            (isAdmin ? PERMISSION_ROLES.OWNER : null);
        return {
            folder,
            permissions: {
                ...basePerm,
                role,
                is_childshare: listingSharesChildren(basePerm),
                is_owner:
                    Boolean(isAdmin) ||
                    String(role || '').toLowerCase() ===
                        PERMISSION_ROLES.OWNER,
                current_username: username || null,
            },
            shareType: 'financial_year',
        };
    }

    const err = new Error(
        'Invalid share type. Use project or financial_year',
    );
    err.status = 400;
    throw err;
}

class SharedWithMeController {
    /**
     * GET /file-manager/shared-with-me
     * Root shared folders — browse children via
     * /file-manager/shared-with-me/folders/:folderId/children
     */
    static async list(req, res) {
        const actor = await resolveActor(req);
        if (actor.ownerId == null || !actor.username) {
            return unauthorized(res);
        }

        const filterUsername = String(
            req.query.username ?? req.query.user ?? '',
        ).trim();
        const filterUserId = parseId(
            req.query.user_id ?? req.query.userId ?? null,
        );

        const username = filterUsername || String(actor.username).trim();
        const userId = filterUserId || Number(actor.ownerId);

        const isAdmin = Boolean(actor.isAdmin);
        const actorName = String(actor.username).trim().toLowerCase();
        if (
            !isAdmin &&
            filterUsername &&
            filterUsername.toLowerCase() !== actorName
        ) {
            return res.status(403).json({
                success: false,
                message: 'You can only view folders shared with your username',
            });
        }
        if (
            !isAdmin &&
            filterUserId &&
            Number(filterUserId) !== Number(actor.ownerId)
        ) {
            return res.status(403).json({
                success: false,
                message: 'You can only view folders shared with your user id',
            });
        }

        // Shared-with-me = folders/files OTHER users shared with the current user.
        // Owned data belongs on GET /file-manager/folders/:id/children only.
        const include_owned = false;

        const rows = await ProjectFileManagerModel.findSharedWithMe({
            userId,
            username,
            assigned_by:
                req.query.assigned_by ??
                req.query.assignedBy ??
                req.query.shared_by ??
                req.query.sharedBy ??
                null,
            project_code:
                req.query.project_code ?? req.query.projectCode ?? null,
            financial_year:
                req.query.financial_year ?? req.query.financialYear ?? null,
            search: req.query.search ?? req.query.q ?? null,
            include_owned,
        });

        const projectShares = (rows || []).map((row) =>
            toSharedRootItem(row, 'project', username),
        );

        const fyRows = await FinancialYearFileManagerModel.findSharedWithMe({
            userId,
            username,
            assigned_by:
                req.query.assigned_by ??
                req.query.assignedBy ??
                req.query.shared_by ??
                req.query.sharedBy ??
                null,
            year_code:
                req.query.year_code ??
                req.query.yearCode ??
                req.query.financial_year ??
                req.query.financialYear ??
                null,
            search: req.query.search ?? req.query.q ?? null,
            include_owned,
        });

        const fyShares = (fyRows || []).map((row) =>
            toSharedRootItem(row, 'financial_year', username),
        );

        // Personal My Folder items shared with this user (direct shares only)
        const personalRows = await FileManagerPermissionModel.findDirectShares({
            userId,
            username,
            include_owned: false,
            scope: 'file_manager',
        });
        const personalShares = (personalRows || []).map((row) =>
            toSharedRootItem(row, 'file_manager', username),
        );

        const typeFilter = String(req.query.type ?? req.query.share_type ?? '')
            .trim()
            .toLowerCase();

        let data = [...projectShares, ...fyShares, ...personalShares];
        if (typeFilter === 'project') {
            data = projectShares;
        } else if (
            typeFilter === 'financial_year' ||
            typeFilter === 'fy' ||
            typeFilter === 'year'
        ) {
            data = fyShares;
        } else if (
            typeFilter === 'file_manager' ||
            typeFilter === 'personal' ||
            typeFilter === 'my_folder'
        ) {
            data = personalShares;
        }

        // Deduplicate by id (same folder should not appear twice)
        const seen = new Set();
        data = data.filter((row) => {
            const id = Number(row.id);
            if (!id || seen.has(id)) return false;
            seen.add(id);
            return true;
        });

        data.sort((a, b) => {
            const ta = new Date(a.assigned_at || 0).getTime();
            const tb = new Date(b.assigned_at || 0).getTime();
            return tb - ta;
        });

        const itemTypeFilter = parseItemTypeFilter(req.query);
        data = filterRowsByItemType(data, itemTypeFilter);

        data = await attachCreatedByUser(data);

        const { page, limit } = parsePaginationQuery(req.query);
        const paged = paginateRows(data, { page, limit });

        return res.json({
            success: true,
            message:
                'Folders/files shared with you by another owner (owned items excluded)',
            meta: {
                username,
                user_id: userId,
                item_type: itemTypeFilter || null,
                count: paged.pagination.total,
                project_count: projectShares.length,
                financial_year_count: fyShares.length,
                personal_count: personalShares.length,
                include_owned: false,
                note: 'Direct shares only (children inherit the same role in DB). Your own folders are on /file-manager/folders/:id/children.',
                browse: {
                    root: '/api/file-manager/shared-with-me',
                    children:
                        '/api/file-manager/shared-with-me/folders/{folderId}/children',
                    owned_children: '/api/file-manager/folders/{folderId}/children',
                    note: 'Open a shared folder via /file-manager/shared-with-me/folders/{folderId}/children',
                },
            },
            pagination: paged.pagination,
            data: paged.data,
        });
    }

    /**
     * GET /file-manager/shared-with-me/folders/:folderId/children
     *
     * folderId may be a shared project/FY root or a nested project folder item.
     * Project: optional ?parent_id= when browsing under a project root id
     * FY:      ?path= relative path under FY absolute_path
     */
    static async children(req, res) {
        const actor = await resolveActor(req);
        if (actor.ownerId == null || !actor.username) {
            return unauthorized(res);
        }

        const folderId = parseId(req.params.folderId);
        if (!folderId) {
            return res.status(400).json({
                success: false,
                message: 'Valid folderId is required',
            });
        }

        const accessArgs = {
            userId: Number(actor.ownerId),
            username: actor.username,
            isAdmin: Boolean(actor.isAdmin),
        };

        let shareType = null;
        let projectRootId = null;
        let listParentId = parseId(
            req.query.parent_id ?? req.query.parentId ?? null,
        );
        let resolved;

        try {
            const asProject = await ProjectFileManagerModel.findById(folderId);
            if (asProject) {
                shareType = 'project';
                projectRootId = folderId;
                resolved = await assertSharedAccess({
                    shareType: 'project',
                    folderId,
                    ...accessArgs,
                });
            } else {
                const asItem =
                    await ProjectFileManagerModel.findItemById(folderId);
                if (asItem) {
                    if (
                        String(asItem.item_type || '').toLowerCase() === 'file'
                    ) {
                        return res.status(400).json({
                            success: false,
                            message: 'Cannot list children of a file',
                        });
                    }
                    shareType = 'project';
                    projectRootId = Number(asItem.project_folder_id);
                    listParentId = folderId;
                    // Prefer permission on this nested folder; fall back to project root
                    const itemPermMap =
                        await FileManagerPermissionModel.findUserForItems(
                            [folderId],
                            {
                                userId: Number(accessArgs.userId),
                                username: accessArgs.username,
                            },
                        );
                    let itemPerm = itemPermMap.get(Number(folderId));
                    // Stale cascade from a parent that is_childshare=false → ignore
                    if (
                        itemPerm &&
                        hasPermissionRole(itemPerm) &&
                        itemPerm.inherited_from_item_id != null
                    ) {
                        const originPerm =
                            await FileManagerPermissionModel.findUser(
                                Number(itemPerm.inherited_from_item_id),
                                Number(accessArgs.userId),
                            );
                        if (
                            hasPermissionRole(originPerm) &&
                            originPerm.is_childshare === false
                        ) {
                            itemPerm = null;
                        }
                    }
                    if (itemPerm && hasPermissionRole(itemPerm)) {
                        const rootFolder =
                            await ProjectFileManagerModel.findById(
                                projectRootId,
                            );
                        if (!rootFolder) {
                            return notFound(
                                res,
                                'Project file manager folder not found',
                            );
                        }
                        const role = itemPerm.role;
                        resolved = {
                            folder: rootFolder,
                            permissions: {
                                ...itemPerm,
                                role,
                                is_childshare: listingSharesChildren(itemPerm),
                                is_owner:
                                    Boolean(accessArgs.isAdmin) ||
                                    String(role || '').toLowerCase() ===
                                        PERMISSION_ROLES.OWNER,
                                current_username:
                                    accessArgs.username || null,
                            },
                            shareType: 'project',
                        };
                    } else {
                        resolved = await assertSharedAccess({
                            shareType: 'project',
                            folderId: projectRootId,
                            ...accessArgs,
                        });
                    }
                } else {
                    const asFy =
                        await FinancialYearFileManagerModel.findById(folderId);
                    if (asFy) {
                        shareType = 'financial_year';
                        resolved = await assertSharedAccess({
                            shareType: 'financial_year',
                            folderId,
                            ...accessArgs,
                        });
                    } else {
                        // Personal / My Folder shared item
                        const asPersonal = await FileManagerModel.findById(
                            folderId,
                            { anyScope: true },
                        );
                        if (
                            !asPersonal ||
                            String(asPersonal.item_type || '')
                                .toLowerCase() === 'file'
                        ) {
                            return notFound(res, 'Shared folder not found');
                        }
                        const permMap =
                            await FileManagerPermissionModel.findUserForItems(
                                [folderId],
                                {
                                    userId: Number(accessArgs.userId),
                                    username: accessArgs.username,
                                },
                            );
                        const perm = permMap.get(Number(folderId));
                        if (
                            !accessArgs.isAdmin &&
                            !hasPermissionRole(perm)
                        ) {
                            return res.status(403).json({
                                success: false,
                                message:
                                    'You do not have access to this shared folder',
                            });
                        }
                        const role =
                            perm?.role ||
                            (accessArgs.isAdmin
                                ? PERMISSION_ROLES.OWNER
                                : null);
                        shareType = 'file_manager';
                        resolved = {
                            folder: asPersonal,
                            permissions: {
                                ...(perm || {}),
                                role,
                                is_owner:
                                    Boolean(accessArgs.isAdmin) ||
                                    String(role || '').toLowerCase() ===
                                        PERMISSION_ROLES.OWNER,
                                current_username:
                                    accessArgs.username || null,
                            },
                            shareType: 'file_manager',
                        };
                    }
                }
            }
        } catch (err) {
            return res.status(err.status || 500).json({
                success: false,
                message: err.message || 'Access denied',
            });
        }

        const { folder, permissions } = resolved;
        shareType = resolved.shareType || shareType || 'project';

        const currentUsername = String(actor.username || '').trim();
        const assignedRole = permissions?.role || null;
        const roleCaps = assignedRole
            ? capabilitiesForRole(assignedRole)
            : { role: null, is_owner: false };
        // Current-user permission on this share — only from assigned role
        const permFlags = {
            role: roleCaps.role,
            is_owner:
                Boolean(roleCaps.is_owner) ||
                String(assignedRole || '').toLowerCase() ===
                    PERMISSION_ROLES.OWNER,
            // Inherited rows are is_childshare=false; direct shares carry the flag
            is_childshare: listingSharesChildren(permissions),
            current_username: currentUsername || null,
        };

        if (shareType === 'file_manager') {
            const isAdmin = Boolean(actor.isAdmin);
            const items = await FileManagerModel.findChildren(
                folderId,
                null,
                null,
                { anyScope: true },
            );
            const childIds = (items || [])
                .map((item) => Number(item.id))
                .filter((id) => id > 0);
            const [userPermByItem, itemsWithAcl] = await Promise.all([
                FileManagerPermissionModel.findUserForItems(childIds, {
                    userId: Number(actor.ownerId),
                    username: currentUsername,
                }),
                FileManagerPermissionModel.itemIdsWithAnyPermission(childIds),
            ]);

            const data = (items || [])
                .map((item) => {
                    const itemId = Number(item.id);
                    const childAccess = resolveChildAccess({
                        userPerm: userPermByItem.get(itemId) || null,
                        parentSharePerms: permFlags,
                        isAdmin,
                        currentUsername,
                    });
                    if (childAccess.role == null && !isAdmin) {
                        return null;
                    }
                    const itemType = normalizeSharedItemType(item.item_type);
                    return attachGoogleFileMeta({
                        id: itemId,
                        public_id: item.public_id || null,
                        name: item.name,
                        item_type: itemType,
                        parent_id:
                            item.parent_id != null
                                ? Number(item.parent_id)
                                : folderId,
                        relative_path: item.relative_path || null,
                        absolute_path: null,
                        share_type: 'file_manager',
                        role: childAccess.role,
                        is_owner: childAccess.is_owner,
                        children_api:
                            itemType === 'file'
                                ? null
                                : `/api/file-manager/shared-with-me/folders/${itemId}/children`,
                        access: childAccess,
                        ...pickItemCreatorFields(item),
                        storage_name: item.storage_name ?? null,
                        mime_type: item.mime_type ?? null,
                        extension: item.extension ?? null,
                        size: item.size ?? null,
                        file_source: item.file_source ?? null,
                        google_file_id: item.google_file_id ?? null,
                        google_drive_folder_id:
                            item.google_drive_folder_id ?? null,
                        url: item.url ?? null,
                        preview_url: item.preview_url ?? null,
                    });
                })
                .filter(Boolean);

            const access = buildShareAccessFromRole(
                permFlags.role,
                currentUsername,
            );

            const itemTypeFilter = parseItemTypeFilter(req.query);
            const filteredData = filterRowsByItemType(data, itemTypeFilter);
            const enrichedData = await attachCreatedByUser(filteredData);
            const { page, limit } = parsePaginationQuery(req.query);
            const paged = paginateRows(enrichedData, { page, limit });

            return res.json({
                success: true,
                share_type: 'file_manager',
                folder_id: folderId,
                parent_id: folder.parent_id ?? null,
                folder: {
                    id: folder.id,
                    public_id: folder.public_id || null,
                    name: folder.name,
                    relative_path: folder.relative_path,
                },
                permissions: permFlags,
                access,
                pagination: paged.pagination,
                data: paged.data,
            });
        }

        if (shareType === 'project') {
            const rootId = projectRootId || folderId;
            let listParentItem = null;

            if (listParentId && listParentId !== rootId) {
                listParentItem =
                    await ProjectFileManagerModel.findItemById(listParentId);
                if (
                    !listParentItem ||
                    Number(listParentItem.project_folder_id) !== Number(rootId)
                ) {
                    return notFound(res, 'Folder item not found in this share');
                }
                if (
                    String(listParentItem.item_type || '').toLowerCase() ===
                    'file'
                ) {
                    return res.status(400).json({
                        success: false,
                        message: 'Cannot list children of a file',
                    });
                }
            }

            // Auto-register physical disk files/folders into DB if missing
            try {
                const parentAbs = String(
                    listParentItem?.absolute_path ||
                        folder?.absolute_path ||
                        '',
                ).trim();
                if (parentAbs && fs.existsSync(parentAbs)) {
                    await syncProjectFolderLevelFromDisk({
                        projectRoot: folder,
                        parentItemId:
                            listParentId && listParentId !== rootId
                                ? listParentId
                                : rootId,
                        parentAbsolutePath: parentAbs,
                        parentRelativePath:
                            listParentItem?.relative_path ||
                            folder?.relative_path ||
                            null,
                    });
                }
            } catch (syncErr) {
                console.warn(
                    '[SharedWithMe] project disk→DB sync skipped:',
                    syncErr?.message || syncErr,
                );
            }

            const items = await ProjectFileManagerModel.listChildrenItems(
                rootId,
                listParentId,
            );
            const childIds = (items || [])
                .map((item) => Number(item.id))
                .filter((id) => id > 0);
            const [userPermByItem, itemsWithAcl] = await Promise.all([
                FileManagerPermissionModel.findUserForItems(childIds, {
                    userId: Number(actor.ownerId),
                    username: currentUsername,
                }),
                FileManagerPermissionModel.itemIdsWithAnyPermission(childIds),
            ]);
            const isAdmin = Boolean(actor.isAdmin);

            // Prefer permission assigned on the folder being listed (nested item)
            let parentSharePerms = permFlags;
            if (listParentId && listParentId !== rootId) {
                const parentPermMap =
                    await FileManagerPermissionModel.findUserForItems(
                        [listParentId],
                        {
                            userId: Number(actor.ownerId),
                            username: currentUsername,
                        },
                    );
                let parentPerm = parentPermMap.get(Number(listParentId));
                if (
                    parentPerm &&
                    hasPermissionRole(parentPerm) &&
                    parentPerm.inherited_from_item_id != null
                ) {
                    const originPerm =
                        await FileManagerPermissionModel.findUser(
                            Number(parentPerm.inherited_from_item_id),
                            Number(actor.ownerId),
                        );
                    if (
                        !hasPermissionRole(originPerm) ||
                        originPerm.is_childshare === false
                    ) {
                        parentPerm = null;
                    }
                }
                if (parentPerm && hasPermissionRole(parentPerm)) {
                    parentSharePerms = {
                        role: parentPerm.role,
                        is_owner:
                            String(parentPerm.role || '').toLowerCase() ===
                            PERMISSION_ROLES.OWNER,
                        is_childshare: listingSharesChildren(parentPerm),
                        current_username: currentUsername || null,
                    };
                } else {
                    const parentAcl =
                        await FileManagerPermissionModel.itemIdsWithAnyPermission(
                            [listParentId],
                        );
                    if (parentAcl.has(Number(listParentId)) && !isAdmin) {
                        return res.status(403).json({
                            success: false,
                            message:
                                'You do not have access to this shared folder',
                        });
                    }
                }
            }

            const data = (items || [])
                .map((item) => {
                    const itemId = Number(item.id);
                    const childAccess = resolveChildAccess({
                        userPerm: userPermByItem.get(itemId) || null,
                        parentSharePerms,
                        isAdmin,
                        currentUsername,
                    });
                    // Hide children with no assigned/inherited role for this user
                    if (childAccess.role == null && !isAdmin) {
                        return null;
                    }
                    return toProjectChildItem(
                        item,
                        rootId,
                        {
                            role: childAccess.role,
                            is_owner: childAccess.is_owner,
                        },
                        currentUsername,
                    );
                })
                .filter(Boolean);

            const access = buildShareAccessFromRole(
                permFlags.role,
                currentUsername,
            );

            const itemTypeFilter = parseItemTypeFilter(req.query);
            const filteredProjectData = filterRowsByItemType(
                data,
                itemTypeFilter,
            );
            const enrichedProjectData =
                await attachCreatedByUser(filteredProjectData);
            const { page, limit } = parsePaginationQuery(req.query);
            const paged = paginateRows(enrichedProjectData, { page, limit });

            return res.json({
                success: true,
                share_type: 'project',
                folder_id: rootId,
                parent_id: listParentId,
                folder: {
                    id: folder.id,
                    public_id: folder.public_id || null,
                    name: folder.folder_name || folder.project_code,
                    relative_path: folder.relative_path,
                    absolute_path: folder.absolute_path,
                },
                permissions: permFlags,
                access,
                pagination: paged.pagination,
                data: paged.data,
            });
        }

        const relative = String(req.query.path || '')
            .trim()
            .replace(/^[/\\]+/, '')
            .replace(/\.\./g, '');
        const isAdmin = Boolean(actor.isAdmin);

        // FY root (no path): list project folders from DB so id/parent_id are real
        if (!relative) {
            const projectRoots =
                await ProjectFileManagerModel.listRootsByParentId(folderId);

            // Backfill File Manager Settings owner when project root has none
            for (let i = 0; i < (projectRoots || []).length; i += 1) {
                const row = projectRoots[i];
                if (row?.id && !(Number(row.owner_id) > 0)) {
                    try {
                        const synced =
                            await ProjectFileManagerModel.applyFileManagerOwners(
                                row.id,
                                currentUsername || 'system',
                            );
                        if (synced?.entry) projectRoots[i] = synced.entry;
                    } catch (err) {
                        console.warn(
                            '[SharedWithMe] project owner backfill failed:',
                            err?.message || err,
                        );
                    }
                }
            }

            // Disk-only folders: register into DB with settings owner
            const base = folder.absolute_path;
            const fyCode = String(
                folder.year_code || folder.financial_year || '',
            ).trim();
            if (base && permFlags.is_childshare !== false) {
                const diskChildren = listDiskChildren(path.resolve(base));
                const known = new Set(
                    (projectRoots || []).map((r) =>
                        String(r.folder_name || r.name || r.project_code || '')
                            .trim()
                            .toLowerCase(),
                    ),
                );
                for (const child of diskChildren) {
                    if (child.item_type !== 'folder') continue;
                    const key = String(child.name || '')
                        .trim()
                        .toLowerCase();
                    if (!key || known.has(key)) continue;
                    try {
                        const registered = await ensureProjectRootFromDisk({
                            folderName: child.name,
                            absolutePath: child.absolute_path,
                            fyFolderId: folderId,
                            financialYear: fyCode,
                            assignedByUsername: currentUsername || 'system',
                        });
                        if (registered?.id) {
                            projectRoots.push(registered);
                            known.add(key);
                            continue;
                        }
                    } catch (err) {
                        console.warn(
                            '[SharedWithMe] ensureProjectRootFromDisk failed:',
                            err?.message || err,
                        );
                    }
                }
            }

            const childIds = (projectRoots || [])
                .map((row) => Number(row.id))
                .filter((id) => id > 0);
            const [userPermByItem, itemsWithAcl] = await Promise.all([
                FileManagerPermissionModel.findUserForItems(childIds, {
                    userId: Number(actor.ownerId),
                    username: currentUsername,
                }),
                FileManagerPermissionModel.itemIdsWithAnyPermission(childIds),
            ]);

            const data = (projectRoots || [])
                .map((row) => {
                    const itemId = Number(row.id);
                    const childAccess = resolveChildAccess({
                        userPerm: userPermByItem.get(itemId) || null,
                        parentSharePerms: permFlags,
                        isAdmin,
                        currentUsername,
                    });
                    if (childAccess.role == null && !isAdmin) {
                        return null;
                    }
                    return toSharedRootItem(
                        {
                            ...row,
                            parent_id: Number(folderId),
                            role: childAccess.role,
                            is_owner: childAccess.is_owner,
                        },
                        'project',
                        currentUsername,
                    );
                })
                .filter(Boolean);

            // Still show unregistered disk folders (e.g. no settings owner yet)
            if (base && permFlags.is_childshare !== false) {
                const diskChildren = listDiskChildren(path.resolve(base));
                const known = new Set(
                    (projectRoots || []).map((r) =>
                        String(r.folder_name || r.name || r.project_code || '')
                            .trim()
                            .toLowerCase(),
                    ),
                );
                for (const child of diskChildren) {
                    const key = String(child.name || '')
                        .trim()
                        .toLowerCase();
                    if (!key || known.has(key)) continue;
                    data.push(
                        toFyChildItem(
                            child,
                            folderId,
                            '',
                            permFlags,
                            currentUsername,
                            null,
                        ),
                    );
                }
            }

            const access = buildShareAccessFromRole(
                permFlags.role,
                currentUsername,
            );

            const itemTypeFilter = parseItemTypeFilter(req.query);
            const filteredFyRootData = filterRowsByItemType(
                data,
                itemTypeFilter,
            );
            const enrichedFyRootData =
                await attachCreatedByUser(filteredFyRootData);
            const { page, limit } = parsePaginationQuery(req.query);
            const paged = paginateRows(enrichedFyRootData, { page, limit });

            return res.json({
                success: true,
                share_type: 'financial_year',
                folder_id: folderId,
                parent_id: null,
                path: '',
                folder: {
                    id: folder.id,
                    public_id: folder.public_id || null,
                    name: folder.folder_name || folder.year_code,
                    relative_path: folder.relative_path,
                    absolute_path: folder.absolute_path,
                },
                permissions: permFlags,
                access,
                pagination: paged.pagination,
                data: paged.data,
            });
        }

        const base = folder.absolute_path;
        const target = path.join(base, relative);
        const rootNorm = path.resolve(base);
        const targetNorm = path.resolve(target);
        if (
            targetNorm !== rootNorm &&
            !targetNorm.startsWith(`${rootNorm}${path.sep}`)
        ) {
            return res.status(400).json({
                success: false,
                message: 'Invalid path',
            });
        }

        // Path drill-down: match first segment to a DB project root for real ids
        const firstSeg = relative.split(/[/\\]/)[0];
        const projectRoots =
            await ProjectFileManagerModel.listRootsByParentId(folderId);
        const matchedRoot = (projectRoots || []).find(
            (r) =>
                String(r.folder_name || r.name || r.project_code || '')
                    .trim()
                    .toLowerCase() ===
                String(firstSeg || '')
                    .trim()
                    .toLowerCase(),
        );
        const dbByName = new Map(
            (projectRoots || []).map((r) => [
                String(r.folder_name || r.name || r.project_code || '')
                    .trim()
                    .toLowerCase(),
                r,
            ]),
        );

        const diskChildren = listDiskChildren(targetNorm);
        const data = diskChildren.map((child) => {
            const key = String(child.name || '')
                .trim()
                .toLowerCase();
            const dbRow =
                !relative.includes('/') && !relative.includes('\\')
                    ? dbByName.get(key) || null
                    : null;
            return toFyChildItem(
                child,
                folderId,
                relative,
                permFlags,
                currentUsername,
                dbRow ||
                    (matchedRoot && key ===
                        String(
                            matchedRoot.folder_name ||
                                matchedRoot.name ||
                                matchedRoot.project_code ||
                                '',
                        )
                            .trim()
                            .toLowerCase()
                        ? matchedRoot
                        : null),
            );
        });

        const access = buildShareAccessFromRole(
            permFlags.role,
            currentUsername,
        );

        const itemTypeFilter = parseItemTypeFilter(req.query);
        const filteredFyPathData = filterRowsByItemType(data, itemTypeFilter);
        const enrichedFyPathData = await attachCreatedByUser(filteredFyPathData);
        const { page, limit } = parsePaginationQuery(req.query);
        const paged = paginateRows(enrichedFyPathData, { page, limit });

        return res.json({
            success: true,
            share_type: 'financial_year',
            folder_id: folderId,
            path: relative || '',
            folder: {
                id: folder.id,
                public_id: folder.public_id || null,
                name: folder.folder_name || folder.year_code,
                relative_path: folder.relative_path,
                absolute_path: folder.absolute_path,
            },
            permissions: permFlags,
            access,
            pagination: paged.pagination,
            data: paged.data,
        });
    }
}

wrapController(SharedWithMeController, ['list', 'children']);

export default SharedWithMeController;
