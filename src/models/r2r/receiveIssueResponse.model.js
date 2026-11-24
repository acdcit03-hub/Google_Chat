/**
 * ReadNotificationModel — generic model for the READ_NOTIFICATION table.
 * Handles any informational / view-only notification type.
 * Import alias kept as "ReceiveIssueResponseModel" for backwards compat
 * with existing callers (receiveIssueNotify.js, controller).
 */
import { pool } from '../../config/db.js';

class ReadNotificationModel {
    /** Insert a new read notification row. */
    static async create(data) {
        const keys = Object.keys(data);
        const columns = keys.map((k) => `"${k}"`).join(', ');
        const values = Object.values(data);
        const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');

        const result = await pool.query(
            `INSERT INTO "READ_NOTIFICATION" (${columns}) VALUES (${placeholders}) RETURNING *`,
            values,
        );
        return result.rows[0];
    }

    /** All unread + recent read notifications for a given user (last 7 days). */
    static async findForUser(username) {
        const result = await pool.query(
            `SELECT * FROM "READ_NOTIFICATION"
             WHERE LOWER(TRIM(receive_username)) = LOWER($1)
             ORDER BY created_at DESC`,
            [username.trim()],
        );
        return result.rows;
    }

    /** Fetch by notification_type for a user. */
    static async findForUserByType(username, notificationType) {
        const result = await pool.query(
            `SELECT * FROM "READ_NOTIFICATION"
             WHERE LOWER(TRIM(receive_username)) = LOWER($1)
               AND notification_type = $2
             ORDER BY created_at DESC`,
            [username.trim(), notificationType],
        );
        return result.rows;
    }

    /** Mark a single row as read. */
    static async markRead(id) {
        const result = await pool.query(
            `UPDATE "READ_NOTIFICATION"
             SET is_read = true, updated_at = NOW()
             WHERE id = $1 RETURNING *`,
            [id],
        );
        return result.rows[0] ?? null;
    }

    /** Mark all unread notifications for a user as read. */
    static async markAllReadForUser(username) {
        await pool.query(
            `UPDATE "READ_NOTIFICATION"
             SET is_read = true, updated_at = NOW()
             WHERE LOWER(TRIM(receive_username)) = LOWER($1) AND is_read = false`,
            [username.trim()],
        );
    }

    /** Delete (dismiss) a single row. */
    static async deleteById(id) {
        await pool.query(`DELETE FROM "READ_NOTIFICATION" WHERE id = $1`, [id]);
    }

    /** Delete all notifications for a requirement (e.g. on requirement delete). */
    static async deleteByRequirement(requirementId) {
        await pool.query(
            `DELETE FROM "READ_NOTIFICATION" WHERE requirement_id = $1`,
            [requirementId],
        );
    }

    /** Delete prior rows of the same type for a requirement (replace with fresh). */
    static async deleteByRequirementAndType(requirementId, notificationType) {
        await pool.query(
            `DELETE FROM "READ_NOTIFICATION"
             WHERE requirement_id = $1 AND notification_type = $2`,
            [requirementId, notificationType],
        );
    }

    /** Delete prior rows for requirement + type + receive user. */
    static async deleteByRequirementTypeAndUser(
        requirementId,
        notificationType,
        receiveUsername,
    ) {
        await pool.query(
            `DELETE FROM "READ_NOTIFICATION"
             WHERE requirement_id = $1
               AND notification_type = $2
               AND LOWER(TRIM(receive_username)) = LOWER($3)`,
            [requirementId, notificationType, String(receiveUsername ?? '').trim()],
        );
    }
}

export default ReadNotificationModel;
