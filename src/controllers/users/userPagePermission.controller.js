import UserPagePermissionModel from '../../models/users/userPagePermission.model.js';
import { findPersonalDetailsByIdModel } from '../../models/Employee/PersonalDetails.model.js';
import { pool } from '../../config/db.js';

import { broadcastForceLogout } from '../../config/socket.js';
import { getUserIdFromReq, writeAuditLog } from '../../utils/audit.utils.js';
import { enrichPermissionRowsWithLocationNames } from '../../utils/userPermission.utils.js';

/** Accept { permissions: [...] }, a single row with pageId, or a root-level array. */
function normalizePermissionRequestBody(body) {
    if (Array.isArray(body)) {
        return {
            username: '',
            permissions: body,
            locationPermissions: {}
        };
    }

    if (body && typeof body === 'object') {
        if (Array.isArray(body.permissions)) {
            return {
                username: body.username,
                permissions: body.permissions,
                locationPermissions: body.locationPermissions ?? {}
            };
        }

        const pageId = body.pageId ?? body.page_id;
        if (pageId) {
            return {
                username: body.username,
                permissions: [body],
                locationPermissions: body.locationPermissions ?? {}
            };
        }
    }

    return {
        username: body?.username,
        permissions: [],
        locationPermissions: body?.locationPermissions ?? {}
    };
}

async function resolvePersonalDetails(idOrUsername) {
    let personalDetails = null;
    if (idOrUsername && !isNaN(Number(idOrUsername))) {
        personalDetails = await findPersonalDetailsByIdModel(Number(idOrUsername));
    }
    if (!personalDetails && idOrUsername) {
        const result = await pool.query(
            `SELECT id, username, first_name, middle_name, last_name, email_id 
             FROM personal_details WHERE LOWER(TRIM(username)) = LOWER(TRIM($1)) LIMIT 1`,
            [String(idOrUsername)]
        );
        personalDetails = result.rows[0] ?? null;
    }
    return personalDetails;
}

/**
 * Shared upsert for page + location permissions.
 * user_id = personal_details.id; username stored on each row.
 */
async function saveUserPermissions(userIdOrUsername, body, req) {
    const normalized = normalizePermissionRequestBody(body);
    const permissionsList = normalized.permissions;
    const locationPermissions = normalized.locationPermissions;

    const personalDetails = await resolvePersonalDetails(userIdOrUsername);

    if (!personalDetails) {
        return { status: 404, payload: { success: false, message: 'Employee not found in personal details' } };
    }

    const userId = personalDetails.id;

    if (!Array.isArray(permissionsList)) {
        return {
            status: 400,
            payload: { success: false, message: 'permissions must be an array' }
        };
    }

    const targetUsername =
        (normalized.username && String(normalized.username).trim()) ||
        personalDetails.username ||
        '';

    try {
        await UserPagePermissionModel.syncUserIdForUsername(targetUsername, userId);
    } catch (syncErr) {
        console.error('Permission user_id sync skipped (save):', syncErr.message || syncErr);
    }

    const before = await UserPagePermissionModel.getByUsername(
        targetUsername,
        userId,
    );

    // NEW: index existing rows so we can fall back to the current DB value
    // instead of `false` for any field the incoming payload omits.
    const existingByKey = new Map();
    for (const row of before ?? []) {
        const key = `${row.page_id ?? row.pageId}:${row.location_id ?? row.locationId ?? 0}`;
        existingByKey.set(key, row);
    }
    const getExisting = (pageId, locationId = 0) =>
        existingByKey.get(`${pageId}:${locationId}`) ?? null;

    const hasLocationPermissions =
        (Array.isArray(locationPermissions) && locationPermissions.length > 0) ||
        (locationPermissions &&
            typeof locationPermissions === 'object' &&
            Object.keys(locationPermissions).length > 0);

    if (permissionsList.length === 0 && !hasLocationPermissions) {
        return {
            status: 400,
            payload: {
                success: false,
                message:
                    'No permissions to save. Send { permissions: [...] } or a single object with pageId.'
            }
        };
    }

    if (permissionsList.length > 0) {
        await UserPagePermissionModel.upsertBulk(
            userId,
            permissionsList.map((p) => {
                const pageId = p.pageId ?? p.page_id;
                const locationId = p.locationId ?? p.location_id ?? 0;
                const existing = getExisting(pageId, locationId);

                return {
                    ...p,
                    pageId,
                    username: p.username || targetUsername,
                    label: p.label || p.label_name || '',
                    canView: p.canView ?? p.can_view ?? existing?.can_view ?? false,
                    canAdd: p.canAdd ?? p.can_add ?? existing?.can_add ?? false,
                    canEdit: p.canEdit ?? p.can_edit ?? existing?.can_edit ?? false,
                    canDelete: p.canDelete ?? p.can_delete ?? existing?.can_delete ?? false,
                    canHead: p.canHead ?? p.can_head ?? existing?.can_head ?? false,
                    canExport: p.canExport ?? p.can_export ?? existing?.can_export ?? false,
                    canOrganization:
                        p.canOrganization ?? p.can_organization ?? existing?.can_organization ?? false,
                    locationId,
                    locationName: p.locationName ?? p.location_name ?? ''
                };
            })
        );
    }

    const locationEntries = Array.isArray(locationPermissions)
        ? locationPermissions.map((item) => ({
            locationId: Number(item.locationId),
            locationName: item.locationName || item.location_name || '',
            pages: item.permissions || {}
        }))
        : Object.entries(locationPermissions).map(([locationId, pages]) => ({
            locationId: Number(locationId),
            locationName: pages?.locationName || pages?.location_name || '',
            pages: pages?.permissions || pages || {}
        }));

    for (const loc of locationEntries) {
        const rows = Object.entries(loc.pages).map(([pageId, perm]) => {
            const existing = getExisting(pageId, loc.locationId);

            return {
                pageId,
                locationId: loc.locationId,
                locationName: loc.locationName,
                username: perm.username || targetUsername,
                label: perm.label || '',
                ...perm, // let explicit incoming fields win first
                canExport: perm.canExport ?? perm.can_export ?? existing?.can_export ?? false,
                canOrganization:
                    perm.canOrganization ?? perm.can_organization ?? existing?.can_organization ?? false,
            };
        });

        if (rows.length > 0) {
            await UserPagePermissionModel.upsertBulk(userId, rows);
        }
    }

    const permissions = await UserPagePermissionModel.getByUsername(
        targetUsername,
        userId,
    );

    if (targetUsername) {
        broadcastForceLogout(targetUsername);
    }

    try {
        await writeAuditLog(req, {
            action: 'UPDATE',
            tableName: 'user_page_permissions',
            tableOfId: parseInt(userId, 10),
            tableOfColumn: 'permissions',
            oldValue: before,
            newValue: permissions,
            userId: getUserIdFromReq(req)
        });
    } catch (e) {
        console.error('Audit log write failed:', e.message || e);
    }

    return {
        status: 200,
        payload: { success: true, permissions }
    };
}

/**
 * GET /api/users/username/:username/permissions
 * Loads by username first (not user_id alone).
 */
async function getUserPermissionsByUsername(req, res) {
    try {
        const userIdOrUsername = req.params.username;
        const personalDetails = await resolvePersonalDetails(userIdOrUsername);

        if (!personalDetails) {
            return res.status(404).json({
                success: false,
                message: 'Employee not found in personal details'
            });
        }

        const userId = personalDetails.id;
        const username = String(personalDetails.username ?? userIdOrUsername ?? '').trim();

        // Heal rows saved under an old personal_details.id for the same username.
        try {
            await UserPagePermissionModel.syncUserIdForUsername(username, userId);
        } catch (syncErr) {
            console.error('Permission user_id sync skipped:', syncErr.message || syncErr);
        }

        const dbPermissions = await UserPagePermissionModel.getByUsername(
            username,
            userId,
        );
        const permissions =
            await enrichPermissionRowsWithLocationNames(dbPermissions);

        return res.json({
            success: true,
            permissions
        });
    } catch (err) {
        console.error('Error fetching user permissions:', err);

        return res.status(500).json({
            success: false,
            message: 'Failed to fetch permissions'
        });
    }
}

/**
 * POST /api/users/username/:username/permissions
 * Body: single row with pageId, { permissions: [...] }, or locationPermissions
 */
async function createUserPermissionsByUsername(req, res) {
    try {
        const result = await saveUserPermissions(req.params.username, req.body, req);

        if (result.status === 200) {
            return res.status(201).json({
                ...result.payload,
                message: 'Permissions saved successfully'
            });
        }

        return res.status(result.status).json(result.payload);
    } catch (err) {
        console.error('Error creating user permissions:', err);

        return res.status(500).json({
            success: false,
            message: 'Failed to save permissions'
        });
    }
}

/**
 * PUT /api/users/username/:username/permissions
 * Body: { permissions: [...], locationPermissions?: [...] }
 */
async function updateUserPermissionsByUsername(req, res) {
    try {
        const result = await saveUserPermissions(req.params.username, req.body, req);
        return res.status(result.status).json(result.payload);
    } catch (err) {
        console.error('Error updating user permissions:', err);

        return res.status(500).json({
            success: false,
            message: 'Failed to update permissions'
        });
    }
}

export {
    getUserPermissionsByUsername,
    createUserPermissionsByUsername,
    updateUserPermissionsByUsername
};