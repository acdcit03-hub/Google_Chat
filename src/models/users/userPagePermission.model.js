import { pool } from '../../config/db.js';

/**
 * user_page_permissions: (user_id, page_id) -> can_view, can_add, can_edit, can_delete, can_head, can_organization
 * user_page_permissions: user_id = personal_details.id
 */
class UserPagePermissionModel {
    static async getById(id) {
        const result = await pool.query(
            `SELECT id, user_id as "userId", username, location_id as "locationId", location_name as "locationName", page_id as "pageId", label, can_view as "canView", can_add as "canAdd", can_edit as "canEdit", can_delete as "canDelete", can_head as "canHead", can_export as "canExport", can_organization as "canOrganization"
             FROM user_page_permissions WHERE id = $1`,
            [id]
        );
        return result.rows[0] || null;
    }

    static async getByUserId(userId) {
        const result = await pool.query(
            `
            SELECT
                id,
                user_id AS "userId",
                username,
                location_id AS "locationId",
                location_name AS "locationName",
                page_id AS "pageId",
                label,
                can_view AS "canView",
                can_add AS "canAdd",
                can_edit AS "canEdit",
                can_delete AS "canDelete",
                can_head AS "canHead",
                can_export AS "canExport",
                can_organization AS "canOrganization"
            FROM user_page_permissions
            WHERE user_id = $1
            ORDER BY location_id, page_id
            `,
            [userId]
        );

        return result.rows;
    }

    /**
     * Username-first permission load.
     * Reason: login/UI use username, but rows historically keyed by user_id.
     * If personal_details.id changed (recreate/rehire) while username stayed the same,
     * user_id-only lookup returns empty even though username permissions exist.
     */
    static async getByUsername(username, fallbackUserId = null) {
        const trimmed = String(username ?? '').trim();
        if (!trimmed) {
            return fallbackUserId != null
                ? UserPagePermissionModel.getByUserId(fallbackUserId)
                : [];
        }

        const result = await pool.query(
            `
            SELECT
                id,
                user_id AS "userId",
                username,
                location_id AS "locationId",
                location_name AS "locationName",
                page_id AS "pageId",
                label,
                can_view AS "canView",
                can_add AS "canAdd",
                can_edit AS "canEdit",
                can_delete AS "canDelete",
                can_head AS "canHead",
                can_export AS "canExport",
                can_organization AS "canOrganization",
                CASE
                    WHEN LOWER(TRIM(COALESCE(username, ''))) = LOWER(TRIM($1)) THEN 0
                    ELSE 1
                END AS match_rank
            FROM user_page_permissions
            WHERE LOWER(TRIM(COALESCE(username, ''))) = LOWER(TRIM($1))
               OR ($2::int IS NOT NULL AND user_id = $2)
            ORDER BY match_rank, location_id, page_id
            `,
            [trimmed, fallbackUserId],
        );

        // Prefer username-matched row when both username and old user_id rows exist.
        const byKey = new Map();
        for (const row of result.rows) {
            const key = `${Number(row.locationId) || 0}\0${String(row.pageId ?? '')}`;
            if (!byKey.has(key)) byKey.set(key, row);
        }
        return [...byKey.values()].map(({ match_rank: _rank, ...row }) => row);
    }

    /** Align stale user_id rows to current personal_details.id for this username. */
    static async syncUserIdForUsername(username, userId) {
        const trimmed = String(username ?? '').trim();
        const id = Number(userId);
        if (!trimmed || !Number.isFinite(id)) return 0;

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Drop stale rows that would collide with an already-correct (user_id, location, page) row.
            await client.query(
                `
                DELETE FROM user_page_permissions stale
                WHERE LOWER(TRIM(COALESCE(stale.username, ''))) = LOWER(TRIM($1))
                  AND stale.user_id IS DISTINCT FROM $2
                  AND EXISTS (
                    SELECT 1
                    FROM user_page_permissions keep
                    WHERE keep.user_id = $2
                      AND keep.location_id = stale.location_id
                      AND keep.page_id = stale.page_id
                  )
                `,
                [trimmed, id],
            );

            const result = await client.query(
                `
                UPDATE user_page_permissions
                SET user_id = $2,
                    username = $1,
                    updated_at = CURRENT_TIMESTAMP
                WHERE LOWER(TRIM(COALESCE(username, ''))) = LOWER(TRIM($1))
                  AND user_id IS DISTINCT FROM $2
                `,
                [trimmed, id],
            );

            await client.query('COMMIT');
            return result.rowCount || 0;
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }
    static async upsert(userId, pageId, locationId = 0, locationName = '', { canView = true, canAdd = false, canEdit = false, canDelete = false, canHead = false, canExport = false, canOrganization = false, label = '', username = '' } = {}) {
        await pool.query(
            `INSERT INTO user_page_permissions (user_id, username, location_id, location_name, page_id, label, can_view, can_add, can_edit, can_delete, can_head, can_export, can_organization, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CURRENT_TIMESTAMP)
             ON CONFLICT (user_id, location_id, page_id)
             DO UPDATE SET
                username = EXCLUDED.username,
                label = EXCLUDED.label,
                can_view = EXCLUDED.can_view,
                can_add = EXCLUDED.can_add,
                can_edit = EXCLUDED.can_edit,
                can_delete = EXCLUDED.can_delete,
                can_head = EXCLUDED.can_head,
                can_export = EXCLUDED.can_export,
                can_organization = EXCLUDED.can_organization,
                location_name = EXCLUDED.location_name,
                updated_at = CURRENT_TIMESTAMP`,
            [userId, String(username ?? ''), locationId, locationName, pageId, String(label ?? ''), !!canView, !!canAdd, !!canEdit, !!canDelete, !!canHead, !!canExport, !!canOrganization]
        );
    }

    static normalizePermissionRow(p) {
        return {
            username: String(p.username ?? '').trim(),
            locationId: Number(p.locationId) || 0,
            locationName: String(p.locationName ?? p.location_name ?? '').trim(),
            pageId: String(p.pageId ?? '').trim(),
            label: String(p.label ?? '').trim(),
            canView: Boolean(p.canView),
            canAdd: Boolean(p.canAdd),
            canEdit: Boolean(p.canEdit),
            canDelete: Boolean(p.canDelete),
            canHead: Boolean(p.canHead),
            canExport: Boolean(p.canExport),
            canOrganization: Boolean(p.canOrganization),
        };
    }

    static dedupePermissionRows(permissions) {
        const byKey = new Map();
        for (const raw of permissions) {
            const p = UserPagePermissionModel.normalizePermissionRow(raw);
            if (!p.pageId) continue;
            byKey.set(`${p.locationId}\0${p.pageId}`, p);
        }
        return [...byKey.values()];
    }

    static async upsertBulk(userId, permissions) {
        const rows = UserPagePermissionModel.dedupePermissionRows(permissions);
        if (rows.length === 0) return;

        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            for (const p of rows) {

                await client.query(
                    `
                    INSERT INTO user_page_permissions
                    (
                        user_id,
                        username,
                        location_id,
                        location_name,
                        page_id,
                        label,
                        can_view,
                        can_add,
                        can_edit,
                        can_delete,
                        can_head,
                        can_export,
                        can_organization,
                        updated_at
                    )
                    VALUES
                    (
                        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
                        CURRENT_TIMESTAMP
                    )
    
                    ON CONFLICT (user_id, location_id, page_id)
                    DO UPDATE SET
                        username = EXCLUDED.username,
                        label = EXCLUDED.label,
                        can_view = EXCLUDED.can_view,
                        can_add = EXCLUDED.can_add,
                        can_edit = EXCLUDED.can_edit,
                        can_delete = EXCLUDED.can_delete,
                        can_head = EXCLUDED.can_head,
                        can_export = EXCLUDED.can_export,
                        can_organization = EXCLUDED.can_organization,
                        location_name = EXCLUDED.location_name,
                        updated_at = CURRENT_TIMESTAMP
                    `,
                    [
                        userId,
                        p.username,
                        p.locationId,
                        p.locationName,
                        p.pageId,
                        p.label,
                        p.canView,
                        p.canAdd,
                        p.canEdit,
                        p.canDelete,
                        p.canHead,
                        p.canExport,
                        p.canOrganization,
                    ]
                );
            }

            await client.query('COMMIT');

        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    static async deleteByUserId(userId) {
        const result = await pool.query('DELETE FROM user_page_permissions WHERE user_id = $1 RETURNING user_id', [userId]);
        return result.rowCount;
    }
}

export default UserPagePermissionModel;
