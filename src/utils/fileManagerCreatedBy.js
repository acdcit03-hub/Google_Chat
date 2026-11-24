import { pool } from '../config/db.js';
import { withIstTimestamps } from './time.utils.js';

/** Audit fields for file/folder list responses. */
export function pickItemCreatorFields(item) {
    if (!item) return {};
    return withIstTimestamps({
        owner_id: item.owner_id ?? null,
        username: item.username ?? null,
        created_by: item.created_by ?? null,
        updated_by: item.updated_by ?? null,
        created_at: item.created_at ?? null,
        updated_at: item.updated_at ?? null,
    });
}

/**
 * Adds `created_by_user: { user_id, username }` from personal_details (username match).
 */
export async function attachCreatedByUser(items) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return list;

    const nameKeys = new Set();
    for (const item of list) {
        const cb = String(item?.created_by || '').trim();
        if (cb) nameKeys.add(cb.toLowerCase());
    }

    const byName = new Map();
    if (nameKeys.size) {
        try {
            const result = await pool.query(
                `
                SELECT id, username
                FROM personal_details
                WHERE LOWER(TRIM(username)) = ANY($1::text[])
                `,
                [[...nameKeys]],
            );
            for (const row of result.rows || []) {
                const key = String(row.username || '')
                    .trim()
                    .toLowerCase();
                if (!key) continue;
                byName.set(key, {
                    user_id: Number(row.id),
                    username: String(row.username).trim(),
                });
            }
        } catch (err) {
            console.warn(
                'attachCreatedByUser lookup skipped:',
                err?.message || err,
            );
        }
    }

    return list.map((item) => {
        const cb = String(item?.created_by || '').trim();
        const created_by_user = cb
            ? byName.get(cb.toLowerCase()) || {
                  user_id: null,
                  username: cb,
              }
            : null;
        return withIstTimestamps({ ...item, created_by_user });
    });
}

export async function attachCreatedByUserOne(item) {
    if (!item) return item;
    const [enriched] = await attachCreatedByUser([item]);
    return enriched;
}
