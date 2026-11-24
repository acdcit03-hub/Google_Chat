import { pool } from '../../config/db.js';

export const initializeFileManagerLogTable = async () => {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS filemanager_log (
            id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            action VARCHAR(20) NOT NULL,
            entity_type VARCHAR(20) NOT NULL,
            item_id BIGINT,
            item_name VARCHAR(500),
            target_username VARCHAR(100),
            field_name VARCHAR(100),
            old_value TEXT,
            new_value TEXT,
            updated_by VARCHAR(100),
            updated_by_user_id BIGINT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_filemanager_log_item
            ON filemanager_log(item_id, created_at DESC);

        CREATE INDEX IF NOT EXISTS idx_filemanager_log_created
            ON filemanager_log(created_at DESC);
    `);
};

function toLogText(value) {
    if (value == null) return '';
    const text =
        typeof value === 'object' ? JSON.stringify(value) : String(value);
    return text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
}

/**
 * Best-effort audit row for file-manager edits, deletes, and permission changes.
 * A failed insert must not block the original request.
 */
export async function writeFileManagerLog({
    action,
    entityType,
    itemId = null,
    itemName = null,
    targetUsername = null,
    fieldName = null,
    oldValue = null,
    newValue = null,
    updatedBy = null,
    updatedByUserId = null,
}) {
    const safeAction = String(action || '').trim().toUpperCase();
    const safeEntity = String(entityType || '').trim().toLowerCase();
    if (!safeAction || !safeEntity) return null;

    try {
        const result = await pool.query(
            `
            INSERT INTO filemanager_log (
                action,
                entity_type,
                item_id,
                item_name,
                target_username,
                field_name,
                old_value,
                new_value,
                updated_by,
                updated_by_user_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING id, created_at
            `,
            [
                safeAction,
                safeEntity,
                itemId != null && Number(itemId) > 0 ? Number(itemId) : null,
                itemName != null ? String(itemName).slice(0, 500) : null,
                targetUsername != null
                    ? String(targetUsername).slice(0, 100)
                    : null,
                fieldName != null ? String(fieldName).slice(0, 100) : null,
                toLogText(oldValue),
                toLogText(newValue),
                updatedBy != null ? String(updatedBy).slice(0, 100) : null,
                updatedByUserId != null && Number(updatedByUserId) > 0
                    ? Number(updatedByUserId)
                    : null,
            ],
        );
        return result.rows[0] || null;
    } catch (error) {
        console.error(
            'filemanager_log write failed:',
            error?.message || error,
        );
        return null;
    }
}
