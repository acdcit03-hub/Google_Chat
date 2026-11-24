import { wrapController } from '../../middleware/error.middleware.js';
import { writeFileManagerLog } from '../../models/filemanager/fileManagerLog.model.js';
import FileManagerPermissionModel, {
    normalizePermissionRole,
    PERMISSION_ROLES,
} from '../../models/filemanager/fileManagerPermission.model.js';
import { pool } from '../../config/db.js';
import { resolveActor, unauthorized } from './fileManager.controller.js';
import {
    attachCreatedByUserOne,
    pickItemCreatorFields,
} from '../../utils/fileManagerCreatedBy.js';

/**
 * Single permission API for folders AND files (any file_manager_items row).
 *
 *   GET|POST|PUT|DELETE /api/file-manager/permissions
 *
 * Role only: owner | editor | viewer
 */

function parseId(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
}

function readItemId(req) {
    return parseId(
        req.params?.itemId ??
            req.params?.id ??
            req.query.item_id ??
            req.query.itemId ??
            req.query.folder_id ??
            req.query.folderId ??
            req.query.id ??
            req.body?.item_id ??
            req.body?.itemId ??
            req.body?.folder_id ??
            req.body?.folderId ??
            req.body?.id ??
            null,
    );
}

function readUserId(req) {
    return parseId(
        req.params?.userId ??
            req.query.user_id ??
            req.query.userId ??
            req.body?.user_id ??
            req.body?.userId ??
            null,
    );
}

function readUsername(req) {
    return String(
        req.query.username ??
            req.query.user_name ??
            req.body?.username ??
            req.body?.user_name ??
            '',
    ).trim();
}

async function findPersonalDetailsByUserId(userId) {
    const id = parseId(userId);
    if (!id) return null;
    const result = await pool.query(
        `SELECT id, username FROM personal_details WHERE id = $1 LIMIT 1`,
        [id],
    );
    return result.rows[0] || null;
}

async function findPersonalDetailsByUsername(username) {
    const name = String(username || '').trim();
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
    return result.rows[0] || null;
}

async function resolveUserIdentity({ userId = null, username = null } = {}) {
    let id = parseId(userId);
    let name = String(username || '').trim();

    if (id && name) {
        return { user_id: id, username: name };
    }

    if (id && !name) {
        const row = await findPersonalDetailsByUserId(id);
        if (!row?.username) {
            return { error: `username not found for user_id ${id}` };
        }
        return {
            user_id: id,
            username: String(row.username).trim(),
        };
    }

    if (name && !id) {
        const row = await findPersonalDetailsByUsername(name);
        if (!row?.id) {
            return { error: `user_id not found for username "${name}"` };
        }
        return {
            user_id: Number(row.id),
            username: String(row.username || name).trim(),
        };
    }

    return { error: 'user_id or username is required' };
}

async function normalizeUserPayload(raw, assignedByUsername) {
    if (!raw || typeof raw !== 'object') return null;

    const identity = await resolveUserIdentity({
        userId: raw.user_id ?? raw.userId ?? raw.id,
        username: raw.username ?? raw.user_name ?? raw.user,
    });
    if (identity.error || !identity.user_id || !identity.username) {
        return {
            error:
                identity.error ||
                'Each user requires user_id or username',
        };
    }

    const roleRaw = raw.role ?? raw.permission_role ?? raw.permissionRole;
    if (roleRaw == null || String(roleRaw).trim() === '') {
        return {
            error: 'role is required (owner | editor | viewer)',
        };
    }

    const childShareRaw =
        raw.is_childshare ??
        raw.is_child_share ??
        raw.isChildShare ??
        raw.child_share ??
        raw.childShare;

    return {
        user_id: identity.user_id,
        username: identity.username,
        role: normalizePermissionRole(roleRaw, PERMISSION_ROLES.VIEWER),
        assigned_by_username: assignedByUsername,
        is_childshare:
            childShareRaw == null
                ? true
                : ['1', 'true', 'yes', 'y', 'on'].includes(
                      String(childShareRaw).trim().toLowerCase(),
                  ) || childShareRaw === true,
    };
}

function normalizeUsersList(body) {
    if (Array.isArray(body?.users)) return body.users;
    if (Array.isArray(body?.assign_users)) return body.assign_users;
    if (Array.isArray(body?.assignUsers)) return body.assignUsers;
    if (
        body &&
        typeof body === 'object' &&
        (body.user_id ||
            body.userId ||
            body.username ||
            body.user_name ||
            body.user)
    ) {
        return [body];
    }
    return [];
}

function permissionFieldsFromBody(body) {
    const fields = {};
    if (body?.username != null) fields.username = body.username;

    const roleRaw = body?.role ?? body?.permission_role ?? body?.permissionRole;
    if (roleRaw != null && String(roleRaw).trim() !== '') {
        fields.role = normalizePermissionRole(
            roleRaw,
            PERMISSION_ROLES.VIEWER,
        );
    }

    const childShareRaw =
        body?.is_childshare ??
        body?.is_child_share ??
        body?.isChildShare ??
        body?.child_share ??
        body?.childShare;
    if (childShareRaw != null) {
        fields.is_childshare =
            childShareRaw === true ||
            ['1', 'true', 'yes', 'y', 'on'].includes(
                String(childShareRaw).trim().toLowerCase(),
            );
    }

    return fields;
}

async function itemMeta(item) {
    if (!item) return null;
    return attachCreatedByUserOne({
        id: item.id,
        public_id: item.public_id || null,
        name: item.name,
        item_type: item.item_type,
        scope: item.scope || 'file_manager',
        parent_id: item.parent_id ?? null,
        project_id: item.project_id ?? null,
        project_code: item.project_code ?? null,
        financial_year: item.financial_year ?? item.year_code ?? null,
        ...pickItemCreatorFields(item),
    });
}

/**
 * Ensure the item's owner appears in the permissions list (role=owner).
 * Folder owner lives on file_manager_items.owner_id / username and may not
 * have a matching file_manager_permissions row.
 */
function withItemOwnerPermission(item, rows) {
    const list = Array.isArray(rows) ? [...rows] : [];
    const ownerId = parseId(item?.owner_id);
    const ownerUsername = String(item?.username || '').trim();
    if (!ownerId && !ownerUsername) return list;

    const matchIndex = list.findIndex((row) => {
        const uid = parseId(row?.user_id);
        const uname = String(row?.username || '')
            .trim()
            .toLowerCase();
        if (ownerId && uid === ownerId) return true;
        if (
            ownerUsername &&
            uname === ownerUsername.toLowerCase()
        ) {
            return true;
        }
        return false;
    });

    if (matchIndex >= 0) {
        const existing = list[matchIndex];
        list[matchIndex] = {
            ...existing,
            role: PERMISSION_ROLES.OWNER,
            is_owner: true,
            access: {
                role: PERMISSION_ROLES.OWNER,
                is_owner: true,
            },
        };
    } else {
        const itemId = parseId(item?.id);
        list.unshift({
            id: null,
            item_id: itemId,
            user_id: ownerId,
            username: ownerUsername || String(ownerId || ''),
            role: PERMISSION_ROLES.OWNER,
            assigned_by_username: null,
            assigned_at: null,
            inherited_from_item_id: null,
            is_childshare: true,
            is_owner: true,
            project_folder_id: itemId,
            fy_folder_id: itemId,
            access: {
                role: PERMISSION_ROLES.OWNER,
                is_owner: true,
            },
        });
    }

    list.sort((a, b) => {
        const rank = (row) => {
            const role = String(row?.role || '')
                .trim()
                .toLowerCase();
            if (role === PERMISSION_ROLES.OWNER) return 0;
            if (role === PERMISSION_ROLES.EDITOR) return 1;
            return 2;
        };
        const diff = rank(a) - rank(b);
        if (diff !== 0) return diff;
        return String(a?.username || '').localeCompare(
            String(b?.username || ''),
            undefined,
            { sensitivity: 'base' },
        );
    });

    return list;
}

class PermissionController {
    /** GET — list users on a folder or file */
    static async list(req, res) {
        const itemId = readItemId(req);
        if (!itemId) {
            return res.status(400).json({
                success: false,
                message: 'Valid item_id (or folder_id) is required',
            });
        }

        const item = await FileManagerPermissionModel.assertItem(itemId);
        const rows = withItemOwnerPermission(
            item,
            await FileManagerPermissionModel.listUsers(itemId),
        );

        return res.json({
            success: true,
            item_id: itemId,
            folder_id: itemId,
            item: await itemMeta(item),
            count: rows.length,
            data: rows,
        });
    }

    /** GET /permissions/access — one user’s role on a folder or file */
    static async getAccess(req, res) {
        const itemId = readItemId(req);
        if (!itemId) {
            return res.status(400).json({
                success: false,
                message: 'Valid item_id (or folder_id) is required',
            });
        }

        const identity = await resolveUserIdentity({
            userId: readUserId(req),
            username: readUsername(req),
        });
        if (identity.error) {
            return res.status(400).json({
                success: false,
                message: identity.error,
            });
        }

        const item = await FileManagerPermissionModel.assertItem(itemId);
        const access = await FileManagerPermissionModel.findUser(
            itemId,
            identity.user_id,
        );

        return res.json({
            success: true,
            item_id: itemId,
            folder_id: itemId,
            item: await itemMeta(item),
            user_id: identity.user_id,
            username: identity.username,
            data: access || {
                item_id: itemId,
                folder_id: itemId,
                user_id: identity.user_id,
                username: identity.username,
                role: null,
            },
        });
    }

    /**
     * POST — upsert role(s) on any folder or file.
     *
     * Body:
     *   { item_id|folder_id, user_id?, username?, role, is_childshare? }
     *   is_childshare=true  → share this item and update children that
     *     do not already have their own direct share
     *   is_childshare=false → share this item only; child shares stay
     *   { item_id|folder_id, users: [{ user_id, username, role, is_childshare? }] }
     */
    static async create(req, res) {
        const { ownerId, username } = await resolveActor(req);
        if (ownerId == null || !username) return unauthorized(res);

        const itemId = readItemId(req);
        if (!itemId) {
            return res.status(400).json({
                success: false,
                message: 'Valid item_id (or folder_id) is required',
            });
        }

        const item = await FileManagerPermissionModel.assertItem(itemId);
        const rawList = normalizeUsersList(req.body);
        if (!rawList.length) {
            return res.status(400).json({
                success: false,
                message:
                    'Provide user_id and/or username (or a users array)',
            });
        }

        // Top-level body flag applies when a user row omits is_childshare
        const bodyChildShare =
            req.body?.is_childshare ??
            req.body?.is_child_share ??
            req.body?.isChildShare;

        const saved = [];
        let anyChildShare = false;
        for (const raw of rawList) {
            const merged =
                raw && typeof raw === 'object'
                    ? {
                          ...raw,
                          is_childshare:
                              raw.is_childshare ??
                              raw.is_child_share ??
                              raw.isChildShare ??
                              bodyChildShare,
                      }
                    : raw;
            const payload = await normalizeUserPayload(merged, username);
            if (!payload || payload.error) {
                return res.status(400).json({
                    success: false,
                    message:
                        payload?.error ||
                        'Each user requires user_id, username, and role',
                });
            }
            if (payload.is_childshare) anyChildShare = true;
            const previous = await FileManagerPermissionModel.findUser(
                itemId,
                payload.user_id,
            );
            const row = await FileManagerPermissionModel.upsertUser({
                item_id: itemId,
                ...payload,
            });
            saved.push(row);
            await writeFileManagerLog({
                action: 'UPDATE',
                entityType: 'permission',
                itemId,
                itemName: item?.name || null,
                targetUsername: payload.username,
                fieldName: 'role',
                oldValue: previous
                    ? { role: previous.role, is_childshare: previous.is_childshare }
                    : null,
                newValue: {
                    role: payload.role,
                    is_childshare: payload.is_childshare,
                },
                updatedBy: username,
                updatedByUserId: ownerId,
            });
        }

        const cascadeIds = anyChildShare
            ? await FileManagerPermissionModel.listCascadeItemIds(itemId)
            : [itemId];

        return res.status(201).json({
            success: true,
            message: anyChildShare
                ? 'Permissions saved on this folder/file and all child folders/files'
                : 'Permissions saved on this folder/file only (children not shared)',
            item_id: itemId,
            folder_id: itemId,
            item: await itemMeta(item),
            is_childshare: anyChildShare,
            cascaded_item_count: cascadeIds.length,
            data: saved,
        });
    }

    /**
     * PUT /permissions/:itemId
     * PUT /permissions
     *
     * Body:
     *   { item_id|folder_id, user_id, username, role: 'owner'|'editor'|'viewer' }
     */
    static async update(req, res) {
        const { ownerId, username: actorUsername } = await resolveActor(req);
        const itemId = readItemId(req);
        if (!itemId) {
            return res.status(400).json({
                success: false,
                message: 'Valid item_id (or folder_id) is required',
            });
        }

        const username = readUsername(req);
        if (!username) {
            return res.status(400).json({
                success: false,
                message: 'username is required in the payload',
            });
        }

        const identity = await resolveUserIdentity({
            userId: readUserId(req),
            username,
        });
        if (identity.error) {
            return res.status(400).json({
                success: false,
                message: identity.error,
            });
        }

        const item = await FileManagerPermissionModel.assertItem(itemId);
        const current = await FileManagerPermissionModel.findUser(
            itemId,
            identity.user_id,
        );
        if (!current) {
            return res.status(404).json({
                success: false,
                message: 'User assignment not found on this item',
            });
        }

        const fields = permissionFieldsFromBody(req.body);
        fields.username = identity.username;
        if (!fields.role) {
            return res.status(400).json({
                success: false,
                message: 'role is required (owner | editor | viewer)',
            });
        }

        const updated = await FileManagerPermissionModel.updateUserPermissions(
            itemId,
            identity.user_id,
            fields,
        );

        await writeFileManagerLog({
            action: 'UPDATE',
            entityType: 'permission',
            itemId,
            itemName: item?.name || null,
            targetUsername: identity.username,
            fieldName: 'role',
            oldValue: {
                role: current.role,
                is_childshare: current.is_childshare,
            },
            newValue: {
                role: updated?.role ?? fields.role,
                is_childshare: updated?.is_childshare ?? fields.is_childshare,
            },
            updatedBy: actorUsername,
            updatedByUserId: ownerId,
        });

        return res.json({
            success: true,
            message: 'Permissions updated',
            item_id: itemId,
            folder_id: itemId,
            item: await itemMeta(item),
            user_id: identity.user_id,
            username: identity.username,
            data: updated,
        });
    }

    /** DELETE — remove a user’s role from a folder or file */
    static async remove(req, res) {
        const { ownerId, username: actorUsername } = await resolveActor(req);
        const itemId = readItemId(req);
        if (!itemId) {
            return res.status(400).json({
                success: false,
                message: 'Valid item_id (or folder_id) is required',
            });
        }

        const identity = await resolveUserIdentity({
            userId: readUserId(req),
            username: readUsername(req),
        });
        if (identity.error) {
            return res.status(400).json({
                success: false,
                message: identity.error,
            });
        }

        const item = await FileManagerPermissionModel.assertItem(itemId);
        const deleted = await FileManagerPermissionModel.removeUser(
            itemId,
            identity.user_id,
        );
        if (!deleted) {
            return res.status(404).json({
                success: false,
                message: 'User assignment not found on this item',
            });
        }

        await writeFileManagerLog({
            action: 'DELETE',
            entityType: 'permission',
            itemId,
            itemName: item?.name || null,
            targetUsername: identity.username,
            fieldName: 'role',
            oldValue: {
                role: deleted.role,
                is_childshare: deleted.is_childshare,
            },
            newValue: null,
            updatedBy: actorUsername,
            updatedByUserId: ownerId,
        });

        return res.json({
            success: true,
            message: 'User removed from permissions',
            item_id: itemId,
            folder_id: itemId,
            item: await itemMeta(item),
            user_id: identity.user_id,
            username: identity.username,
            data: deleted,
        });
    }
}

wrapController(PermissionController, [
    'list',
    'getAccess',
    'create',
    'update',
    'remove',
]);

export default PermissionController;
