import { pool } from '../../config/db.js';

export const initializeBomGoogleSheetTable = async () => {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS bom_google_sheets (
            id BIGSERIAL PRIMARY KEY,

            sheet_name VARCHAR(255) NOT NULL,
            project_code VARCHAR(100),
            project_name VARCHAR(255),

            google_file_id VARCHAR(128),
            google_sheet_url TEXT NOT NULL,
            sheet_tab_name VARCHAR(255),

            meta JSONB NOT NULL DEFAULT '{}'::jsonb,
            rows JSONB NOT NULL DEFAULT '[]'::jsonb,
            row_count INTEGER NOT NULL DEFAULT 0,

            created_by_user_id BIGINT,
            created_by_username VARCHAR(100),

            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_bom_google_sheets_project_code
            ON bom_google_sheets(project_code);

        CREATE INDEX IF NOT EXISTS idx_bom_google_sheets_google_file_id
            ON bom_google_sheets(google_file_id);

        CREATE INDEX IF NOT EXISTS idx_bom_google_sheets_created_at
            ON bom_google_sheets(created_at DESC);
    `);
};

class BomGoogleSheetModel {
    static async create({
        sheet_name,
        project_code,
        project_name,
        google_file_id,
        google_sheet_url,
        sheet_tab_name,
        meta,
        rows,
        created_by_user_id,
        created_by_username,
    }) {
        const rowList = Array.isArray(rows) ? rows : [];
        const result = await pool.query(
            `
            INSERT INTO bom_google_sheets (
                sheet_name,
                project_code,
                project_name,
                google_file_id,
                google_sheet_url,
                sheet_tab_name,
                meta,
                rows,
                row_count,
                created_by_user_id,
                created_by_username
            ) VALUES (
                $1, $2, $3, $4, $5, $6,
                $7::jsonb, $8::jsonb, $9,
                $10, $11
            )
            RETURNING *
            `,
            [
                String(sheet_name || '').trim(),
                project_code ? String(project_code).trim() : null,
                project_name ? String(project_name).trim() : null,
                google_file_id ? String(google_file_id).trim() : null,
                String(google_sheet_url || '').trim(),
                sheet_tab_name ? String(sheet_tab_name).trim() : null,
                JSON.stringify(meta && typeof meta === 'object' ? meta : {}),
                JSON.stringify(rowList),
                rowList.length,
                created_by_user_id != null ? Number(created_by_user_id) : null,
                created_by_username
                    ? String(created_by_username).trim()
                    : null,
            ],
        );
        return result.rows[0];
    }

    static async findById(id) {
        const result = await pool.query(
            `SELECT * FROM bom_google_sheets WHERE id = $1`,
            [id],
        );
        return result.rows[0] || null;
    }

    static async list({
        project_code = null,
        created_by_user_id = null,
        created_by_username = null,
        search = null,
        limit = 50,
    } = {}) {
        const params = [];
        const where = [];
        if (project_code) {
            params.push(String(project_code).trim());
            where.push(`project_code = $${params.length}`);
        }
        if (
            (created_by_user_id != null && Number(created_by_user_id) > 0) ||
            created_by_username
        ) {
            const parts = [];
            if (created_by_user_id != null && Number(created_by_user_id) > 0) {
                params.push(Number(created_by_user_id));
                parts.push(`created_by_user_id = $${params.length}`);
            }
            if (created_by_username) {
                params.push(String(created_by_username).trim().toLowerCase());
                parts.push(
                    `LOWER(TRIM(COALESCE(created_by_username, ''))) = $${params.length}`,
                );
            }
            if (parts.length) where.push(`(${parts.join(' OR ')})`);
        }
        const q = String(search || '').trim();
        if (q) {
            params.push(`%${q}%`);
            where.push(
                `(sheet_name ILIKE $${params.length}
                  OR COALESCE(project_code, '') ILIKE $${params.length}
                  OR COALESCE(google_sheet_url, '') ILIKE $${params.length})`,
            );
        }
        params.push(Math.min(Math.max(Number(limit) || 50, 1), 200));
        const result = await pool.query(
            `
            SELECT
                id,
                sheet_name,
                project_code,
                project_name,
                google_file_id,
                google_sheet_url,
                sheet_tab_name,
                row_count,
                created_by_user_id,
                created_by_username,
                created_at,
                updated_at
            FROM bom_google_sheets
            ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
            ORDER BY created_at DESC, id DESC
            LIMIT $${params.length}
            `,
            params,
        );
        return result.rows;
    }
}

export default BomGoogleSheetModel;
