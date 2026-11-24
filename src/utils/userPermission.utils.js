import UserPagePermissionModel from '../models/users/userPagePermission.model.js';
import { pool } from '../config/db.js';

async function getUsernamesForPage(pageId) {
    const result = await pool.query(
        `SELECT DISTINCT username
         FROM (
           SELECT NULLIF(TRIM(p.username), '') AS username
           FROM user_page_permissions p
           WHERE p.page_id = $1 AND p.can_view = true
           UNION
           SELECT NULLIF(TRIM(pd.username), '') AS username
           FROM user_page_permissions p
           JOIN personal_details pd ON pd.id = p.user_id
           WHERE p.page_id = $1 AND p.can_view = true
         ) u
         WHERE username IS NOT NULL AND username <> ''`,
        [pageId],
    );
    return result.rows.map((r) => r.username).filter(Boolean);
}

async function getPersonalDetailsIdByUsername(username) {
    const result = await pool.query(
        `SELECT id FROM personal_details WHERE LOWER(TRIM(username)) = LOWER(TRIM($1)) LIMIT 1`,
        [username],
    );
    return result.rows[0]?.id ?? null;
}

async function fetchStoreLocationNameMap() {
    const nameById = new Map();
    const baseUrl = (process.env.NEXT_PUBLIC_STORE_API || '').trim().replace(/\/$/, '');
    if (!baseUrl) return nameById;

    for (const status of ['active', 'deactive']) {
        try {
            const res = await fetch(`${baseUrl}/store/all-location?status=${status}`);
            if (!res.ok) continue;

            const json = await res.json();
            const rows = Array.isArray(json?.data)
                ? json.data
                : Array.isArray(json)
                    ? json
                    : [];

            for (const row of rows) {
                const id = Number(row.id);
                const name = row.location ?? row.location_name ?? row.locationName;
                if (!Number.isNaN(id) && name) {
                    nameById.set(id, String(name));
                }
            }
        } catch (err) {
            console.error(`Failed to fetch ${status} store locations:`, err.message || err);
        }
    }

    return nameById;
}

function buildUserPermissionPayload(dbPermissions, locationNameById = new Map()) {
    const permissions = {};
    const locationPermissionsMap = {};

    for (const p of dbPermissions) {
        const locationId = Number(p.locationId ?? p.location_id ?? 0);
        const pageId = p.pageId ?? p.page_id;
        if (!pageId) continue;

        const permissionObj = {
            canView: !!p.canView,
            canAdd: !!p.canAdd,
            canEdit: !!p.canEdit,
            canDelete: !!p.canDelete,
            canHead: !!p.canHead,
            canExport: !!p.canExport,
            canOrganization: !!p.canOrganization,
            label: String(p.label ?? '')
        };

        if (locationId > 0) {
            if (!locationPermissionsMap[locationId]) {
                const storedName = p.locationName ?? p.location_name ?? '';
                const resolvedName =
                    locationNameById.get(locationId) || storedName || '';

                locationPermissionsMap[locationId] = {
                    id: locationId,
                    locationId,
                    locationName: resolvedName,
                    location_name: resolvedName,
                    permissions: {}
                };
            }

            locationPermissionsMap[locationId].permissions[pageId] = permissionObj;
        } else {
            permissions[pageId] = permissionObj;
        }
    }

    return {
        permissions,
        locationPermissions: Object.values(locationPermissionsMap)
    };
}

async function buildUserPermissionsFromDb(userId) {
    const dbPermissions = await UserPagePermissionModel.getByUserId(userId);
    const locationIds = [
        ...new Set(
            dbPermissions
                .map((p) => Number(p.locationId ?? p.location_id ?? 0))
                .filter((id) => id > 0)
        )
    ];

    const locationNameById =
        locationIds.length > 0 ? await fetchStoreLocationNameMap() : new Map();

    return buildUserPermissionPayload(dbPermissions, locationNameById);
}

async function enrichPermissionRowsWithLocationNames(dbPermissions) {
    const locationIds = [
        ...new Set(
            dbPermissions
                .map((p) => Number(p.locationId ?? p.location_id ?? 0))
                .filter((id) => id > 0)
        )
    ];

    const locationNameById =
        locationIds.length > 0 ? await fetchStoreLocationNameMap() : new Map();

    return dbPermissions.map((p) => {
        const locationId = Number(p.locationId ?? p.location_id ?? 0);
        const storedName = p.locationName ?? p.location_name ?? '';
        const resolvedName =
            locationId > 0
                ? locationNameById.get(locationId) || storedName || ''
                : storedName;

        return {
            ...p,
            username: String(p.username ?? ''),
            locationId,
            locationName: resolvedName,
            label: String(p.label ?? ''),
            canExport: Boolean(p.canExport ?? p.can_export),
            canOrganization: Boolean(p.canOrganization ?? p.can_organization)
        };
    });
}

export {
    fetchStoreLocationNameMap,
    buildUserPermissionPayload,
    buildUserPermissionsFromDb,
    enrichPermissionRowsWithLocationNames,
    getUsernamesForPage,
    getPersonalDetailsIdByUsername,
};
