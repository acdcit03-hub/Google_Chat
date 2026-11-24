import { pool } from '../../config/db.js';

const FOLDER_SCOPES = new Set(['project', 'pcb', 'google_sheet']);

function normalizeFolderScope(value, fallback = 'project') {
    const s = String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, '_');
    if (s === 'googlesheet' || s === 'google') return 'google_sheet';
    if (FOLDER_SCOPES.has(s)) return s;
    return fallback;
}

function normalizeGoogleSheetUrl(value) {
    const url = String(value ?? '').trim();
    if (!url) return null;
    return url;
}

/** Store sheet file/tab format as {PROJECT}_{PCB} or {PROJECT}_{PCB}_SUFFIX. */
function normalizeGoogleSheetFileName(value, fallback = '{PROJECT}_{PCB}') {
    let raw = String(value ?? '').trim();
    if (!raw) return fallback;

    raw = raw.replace(/^\{PROJECT\}_\{PCB\}_?/i, '');
    raw = raw.replace(/^\{PROJECT\}_?/i, '');
    raw = raw.replace(/^\{PCB\}_?/i, '');
    raw = raw.replace(/^_+|_+$/g, '').replace(/\s+/g, '_');

    if (!raw || /^pcb$/i.test(raw)) return '{PROJECT}_{PCB}';
    return `{PROJECT}_{PCB}_${raw}`;
}

/* ================= CREATE TABLE ================= */
export const initializeCategoriesFolderStructureTable = async () => {
    // Create base table (no folder_scope index yet — column may be added via ALTER below)
    await pool.query(`
        CREATE TABLE IF NOT EXISTS categories_folder_structure (
            id BIGSERIAL PRIMARY KEY,

            category_id BIGINT,
            category_name VARCHAR(255),
            category_letter VARCHAR(20),

            parent_id BIGINT NULL
                REFERENCES categories_folder_structure(id)
                ON DELETE CASCADE,

            folder_name VARCHAR(255) NOT NULL,
            folder_path TEXT NOT NULL,

            display_order INTEGER NOT NULL DEFAULT 0,
            is_active BOOLEAN NOT NULL DEFAULT TRUE,

            created_by BIGINT,
            created_at TIMESTAMP DEFAULT TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP),
            updated_at TIMESTAMP DEFAULT TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
        );
    `);

    // Existing DBs: add folder_scope if missing (CREATE TABLE IF NOT EXISTS won't alter)
    await pool.query(`
        ALTER TABLE categories_folder_structure
        ADD COLUMN IF NOT EXISTS folder_scope VARCHAR(20) DEFAULT 'project';
    `);

    await pool.query(`
        ALTER TABLE categories_folder_structure
        ADD COLUMN IF NOT EXISTS google_sheet_url TEXT NULL;
    `);

    await pool.query(`
        ALTER TABLE categories_folder_structure
        ADD COLUMN IF NOT EXISTS google_sheet_file_name VARCHAR(255) NULL;
    `);

    await pool.query(`
        UPDATE categories_folder_structure
        SET folder_scope = 'project'
        WHERE folder_scope IS NULL
           OR TRIM(COALESCE(folder_scope, '')) = ''
           OR LOWER(TRIM(folder_scope)) NOT IN ('project', 'pcb', 'google_sheet');
    `);

    await pool.query(`
        ALTER TABLE categories_folder_structure
        ALTER COLUMN folder_scope SET DEFAULT 'project';
    `);

    await pool.query(`
        ALTER TABLE categories_folder_structure
        ALTER COLUMN folder_scope SET NOT NULL;
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_cat_folder_struct_category_id
            ON categories_folder_structure(category_id);

        CREATE INDEX IF NOT EXISTS idx_cat_folder_struct_parent_id
            ON categories_folder_structure(parent_id);

        CREATE INDEX IF NOT EXISTS idx_cat_folder_struct_letter
            ON categories_folder_structure(category_letter);

        CREATE INDEX IF NOT EXISTS idx_cat_folder_struct_active
            ON categories_folder_structure(is_active);

        CREATE INDEX IF NOT EXISTS idx_cat_folder_struct_display_order
            ON categories_folder_structure(display_order);

        CREATE INDEX IF NOT EXISTS idx_cat_folder_struct_scope
            ON categories_folder_structure(folder_scope);
    `);
};

function parseId(value) {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
}

function toBool(value, fallback = true) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    const s = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on', 'active'].includes(s)) return true;
    if (['0', 'false', 'no', 'n', 'off', 'inactive'].includes(s)) return false;
    return fallback;
}

function toInt(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

class CategoriesFolderStructureModel {
    static async findAll({
        category_id = null,
        parent_id = undefined,
        is_active = null,
        folder_scope = null,
        search = null,
    } = {}) {
        const params = [];
        const where = [];

        if (category_id != null) {
            params.push(parseId(category_id));
            where.push(`category_id = $${params.length}`);
        }

        if (parent_id !== undefined) {
            if (parent_id === null || parent_id === 'null' || parent_id === '') {
                where.push(`parent_id IS NULL`);
            } else {
                params.push(parseId(parent_id));
                where.push(`parent_id = $${params.length}`);
            }
        }

        if (is_active !== null && is_active !== undefined && is_active !== '') {
            params.push(toBool(is_active, true));
            where.push(`is_active = $${params.length}`);
        }

        if (folder_scope != null && String(folder_scope).trim()) {
            params.push(normalizeFolderScope(folder_scope));
            where.push(`folder_scope = $${params.length}`);
        }

        if (search) {
            params.push(`%${String(search).trim()}%`);
            where.push(
                `(folder_name ILIKE $${params.length}
                  OR folder_path ILIKE $${params.length}
                  OR category_name ILIKE $${params.length}
                  OR category_letter ILIKE $${params.length})`,
            );
        }

        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

        const result = await pool.query(
            `
            SELECT *
            FROM categories_folder_structure
            ${whereSql}
            ORDER BY display_order ASC, id ASC
            `,
            params,
        );
        return result.rows;
    }

    static async findById(id) {
        const result = await pool.query(
            `SELECT * FROM categories_folder_structure WHERE id = $1`,
            [id],
        );
        return result.rows[0] || null;
    }

    static async findByCategoryId(categoryId) {
        const result = await pool.query(
            `
            SELECT *
            FROM categories_folder_structure
            WHERE category_id = $1
            ORDER BY display_order ASC, id ASC
            `,
            [categoryId],
        );
        return result.rows;
    }

    static async findChildren(parentId) {
        const result = await pool.query(
            `
            SELECT *
            FROM categories_folder_structure
            WHERE parent_id IS NOT DISTINCT FROM $1
            ORDER BY display_order ASC, id ASC
            `,
            [parentId],
        );
        return result.rows;
    }

    /** Next display_order among siblings (same parent + category). */
    static async getNextDisplayOrder(parentId, categoryId) {
        const params = [];
        let where = 'parent_id IS NULL';

        if (parentId != null) {
            params.push(parentId);
            where = `parent_id = $${params.length}`;
        }

        if (categoryId != null) {
            params.push(categoryId);
            where += ` AND category_id = $${params.length}`;
        }

        const result = await pool.query(
            `
            SELECT COALESCE(MAX(display_order), -1) + 1 AS next_order
            FROM categories_folder_structure
            WHERE ${where}
            `,
            params,
        );
        return Number(result.rows[0]?.next_order) || 0;
    }

    /** Build folder_path from parent path + folder name. */
    static async buildFolderPath(parentId, folderName) {
        const name = String(folderName || '').trim();
        if (!name) return '';

        const parentKey = parseId(parentId);
        if (!parentKey) return name;

        const parent = await CategoriesFolderStructureModel.findById(parentKey);
        const parentPath = String(parent?.folder_path || '').trim();
        if (!parentPath) return name;
        return `${parentPath.replace(/\/+$/, '')}/${name}`;
    }

    static async create({
        category_id,
        category_name,
        category_letter,
        parent_id = null,
        folder_name,
        folder_path,
        folder_scope = 'project',
        google_sheet_url = null,
        google_sheet_file_name = null,
        display_order,
        is_active = true,
        created_by = null,
    }) {
        const name = String(folder_name || '').trim();
        if (!name) {
            throw new Error('folder_name is required');
        }

        const parentKey = parseId(parent_id);
        const categoryKey = parseId(category_id);
        const scope = normalizeFolderScope(folder_scope, 'project');
        const sheetUrl =
            scope === 'google_sheet'
                ? normalizeGoogleSheetUrl(google_sheet_url)
                : null;
        const sheetFileName =
            scope === 'google_sheet'
                ? normalizeGoogleSheetFileName(google_sheet_file_name)
                : null;

        if (scope === 'google_sheet' && !sheetUrl) {
            throw new Error(
                'google_sheet_url is required for Google Sheet scope (publicly accessible link)',
            );
        }
        if (scope === 'google_sheet' && !sheetFileName) {
            throw new Error(
                'google_sheet_file_name is required for Google Sheet scope',
            );
        }

        const path =
            folder_path != null && String(folder_path).trim()
                ? String(folder_path).trim()
                : await CategoriesFolderStructureModel.buildFolderPath(
                      parentKey,
                      name,
                  );

        const order =
            display_order !== undefined &&
            display_order !== null &&
            display_order !== ''
                ? toInt(display_order, 0)
                : await CategoriesFolderStructureModel.getNextDisplayOrder(
                      parentKey,
                      categoryKey,
                  );

        const result = await pool.query(
            `
            INSERT INTO categories_folder_structure (
                category_id,
                category_name,
                category_letter,
                parent_id,
                folder_name,
                folder_path,
                folder_scope,
                google_sheet_url,
                google_sheet_file_name,
                display_order,
                is_active,
                created_by
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            RETURNING *
            `,
            [
                categoryKey,
                category_name != null
                    ? String(category_name).trim()
                    : null,
                category_letter != null
                    ? String(category_letter).trim()
                    : null,
                parentKey,
                name,
                path,
                scope,
                sheetUrl,
                sheetFileName,
                order,
                toBool(is_active, true),
                parseId(created_by),
            ],
        );
        return result.rows[0];
    }

    static async update(id, fields = {}) {
        const existing = await CategoriesFolderStructureModel.findById(id);
        if (!existing) return null;

        const nextParentId =
            fields.parent_id !== undefined
                ? parseId(fields.parent_id)
                : existing.parent_id;
        const nextFolderName =
            fields.folder_name !== undefined
                ? String(fields.folder_name).trim()
                : existing.folder_name;

        if (!nextFolderName) {
            throw new Error('folder_name is required');
        }

        if (nextParentId != null && Number(nextParentId) === Number(id)) {
            throw new Error('parent_id cannot reference itself');
        }

        const nameOrParentChanged =
            fields.folder_name !== undefined ||
            fields.parent_id !== undefined;

        let nextFolderPath = existing.folder_path;
        if (fields.folder_path !== undefined && String(fields.folder_path).trim()) {
            nextFolderPath = String(fields.folder_path).trim();
        } else if (nameOrParentChanged) {
            nextFolderPath =
                await CategoriesFolderStructureModel.buildFolderPath(
                    nextParentId,
                    nextFolderName,
                );
        }

        const next = {
            category_id:
                fields.category_id !== undefined
                    ? parseId(fields.category_id)
                    : existing.category_id,
            category_name:
                fields.category_name !== undefined
                    ? String(fields.category_name || '').trim() || null
                    : existing.category_name,
            category_letter:
                fields.category_letter !== undefined
                    ? String(fields.category_letter || '').trim() || null
                    : existing.category_letter,
            parent_id: nextParentId,
            folder_name: nextFolderName,
            folder_path: nextFolderPath,
            folder_scope:
                fields.folder_scope !== undefined
                    ? normalizeFolderScope(
                          fields.folder_scope,
                          existing.folder_scope || 'project',
                      )
                    : normalizeFolderScope(
                          existing.folder_scope,
                          'project',
                      ),
            display_order:
                fields.display_order !== undefined &&
                fields.display_order !== null &&
                fields.display_order !== ''
                    ? toInt(fields.display_order, existing.display_order)
                    : existing.display_order,
            is_active:
                fields.is_active !== undefined
                    ? toBool(fields.is_active, existing.is_active)
                    : existing.is_active,
        };

        if (fields.google_sheet_url !== undefined) {
            next.google_sheet_url =
                next.folder_scope === 'google_sheet'
                    ? normalizeGoogleSheetUrl(fields.google_sheet_url)
                    : null;
        } else if (next.folder_scope === 'google_sheet') {
            next.google_sheet_url = normalizeGoogleSheetUrl(
                existing.google_sheet_url,
            );
        } else {
            next.google_sheet_url = null;
        }

        if (fields.google_sheet_file_name !== undefined) {
            next.google_sheet_file_name =
                next.folder_scope === 'google_sheet'
                    ? normalizeGoogleSheetFileName(fields.google_sheet_file_name)
                    : null;
        } else if (next.folder_scope === 'google_sheet') {
            next.google_sheet_file_name = normalizeGoogleSheetFileName(
                existing.google_sheet_file_name,
            );
        } else {
            next.google_sheet_file_name = null;
        }

        if (next.folder_scope === 'google_sheet' && !next.google_sheet_url) {
            throw new Error(
                'google_sheet_url is required for Google Sheet scope (publicly accessible link)',
            );
        }
        if (
            next.folder_scope === 'google_sheet' &&
            !next.google_sheet_file_name
        ) {
            throw new Error(
                'google_sheet_file_name is required for Google Sheet scope',
            );
        }

        const result = await pool.query(
            `
            UPDATE categories_folder_structure
            SET
                category_id = $2,
                category_name = $3,
                category_letter = $4,
                parent_id = $5,
                folder_name = $6,
                folder_path = $7,
                folder_scope = $8,
                google_sheet_url = $9,
                google_sheet_file_name = $10,
                display_order = $11,
                is_active = $12,
                updated_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
            WHERE id = $1
            RETURNING *
            `,
            [
                id,
                next.category_id,
                next.category_name,
                next.category_letter,
                next.parent_id,
                next.folder_name,
                next.folder_path,
                next.folder_scope,
                next.google_sheet_url,
                next.google_sheet_file_name,
                next.display_order,
                next.is_active,
            ],
        );
        return result.rows[0] || null;
    }

    static async remove(id) {
        const result = await pool.query(
            `DELETE FROM categories_folder_structure WHERE id = $1 RETURNING *`,
            [id],
        );
        return result.rows[0] || null;
    }
}

export default CategoriesFolderStructureModel;
export { normalizeFolderScope, FOLDER_SCOPES };
