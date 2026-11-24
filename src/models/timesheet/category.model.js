import { pool } from '../../config/db.js';

const sleep = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

let categoriesCache = null;
let categoriesCacheTime = 0;

const CATEGORY_CACHE_TTL = 3000;

async function safeQuery(
    sql,
    params = [],
    retries = 3,
) {
    let lastError;

    for (
        let attempt = 0;
        attempt <= retries;
        attempt++
    ) {
        try {
            return await pool.query(
                sql,
                params,
            );
        } catch (error) {
            lastError = error;

            const errorMessage =
                String(
                    error?.message || '',
                ).toLowerCase();

            const isTooManyClients =
                error?.code === '53300' ||
                errorMessage.includes(
                    'too many clients',
                );

            if (
                !isTooManyClients ||
                attempt === retries
            ) {
                throw error;
            }

            await sleep(
                500 * (attempt + 1),
            );
        }
    }

    throw lastError;
}

class CategoryModel {
    /** Build cached root-to-node name segments for every category id. */
    static buildParentPathIndex(categories) {
        const byId = new Map(categories.map((cat) => [cat.id, cat]));
        const cache = new Map();

        const segmentsFor = (id) => {
            const numericId = Number(id);
            if (cache.has(numericId)) return cache.get(numericId);

            const segments = [];
            const visited = new Set();
            let current = byId.get(numericId);

            while (current) {
                if (visited.has(current.id)) break;
                visited.add(current.id);
                segments.unshift(String(current.name ?? '').trim());
                current = current.parent_id ? byId.get(current.parent_id) : null;
            }

            cache.set(numericId, segments);
            return segments;
        };

        const pathFor = (id) => segmentsFor(id).join(' / ');

        return {
            segmentsFor,
            pathFor,
        };
    }

    static clearCache() {
        categoriesCache = null;
        categoriesCacheTime = 0;
    }

    static normalizeCategoryType(raw) {
        if (
            raw == null ||
            String(raw).trim() === ''
        ) {
            return 'PROCESS';
        }

        const categoryType =
            String(raw)
                .trim()
                .toUpperCase();

        const allowedTypes = [
            'PROCESS',
            'CHECKLIST',
        ];

        if (
            !allowedTypes.includes(
                categoryType,
            )
        ) {
            throw new Error(
                'Invalid category_type. Allowed values are PROCESS or CHECKLIST.',
            );
        }

        return categoryType;
    }

    static async findAll() {
        const now = Date.now();

        if (
            categoriesCache &&
            now - categoriesCacheTime <
            CATEGORY_CACHE_TTL
        ) {
            return categoriesCache;
        }

        const result = await safeQuery(
            `
                SELECT *
                FROM categories
                ORDER BY id ASC
            `,
        );

        categoriesCache = result.rows;
        categoriesCacheTime = now;

        return result.rows;
    }

    static async findById(id) {
        const result = await safeQuery(
            `
                SELECT *
                FROM categories
                WHERE id = $1
            `,
            [id],
        );

        return result.rows[0];
    }

    static async findByName(name, excludeId = null) {
        let query = 'SELECT * FROM categories WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))';
        const params = [name];

        if (excludeId != null) {
            query += ' AND id != $2';
            params.push(excludeId);
        }

        const result = await safeQuery(
            query,
            params,
        );

        return result.rows[0];
    }

    static async findByNameUnderParent(
        name,
        parentId = null,
        excludeId = null,
    ) {
        const params = [name];

        const parentKey =
            parentId == null || parentId === ''
                ? null
                : Number(parentId);

        let query =
            parentKey == null
                ? 'SELECT * FROM categories WHERE LOWER(TRIM(name)) = LOWER(TRIM($1)) AND parent_id IS NULL'
                : 'SELECT * FROM categories WHERE LOWER(TRIM(name)) = LOWER(TRIM($1)) AND parent_id = $2';

        if (parentKey != null) {
            params.push(parentKey);
        }

        if (excludeId != null) {
            const idx = params.length + 1;
            query += ` AND id != $${idx}`;
            params.push(Number(excludeId));
        }

        const result = await pool.query(query, params);
        return result.rows[0];
    }

    static async findByLetter(letter, excludeId = null) {
        let query =
            'SELECT * FROM categories WHERE parent_id IS NULL AND UPPER(TRIM(letter)) = UPPER(TRIM($1))';
        const params = [letter];

        if (excludeId != null) {
            query += ' AND id != $2';
            params.push(excludeId);
        }

        const result = await safeQuery(
            query,
            params,
        );

        return result.rows[0];
    }

    static async syncIdSequence() {
        const maxResult = await pool.query(
            'SELECT COALESCE(MAX(id), 0) AS max_id FROM categories',
        );

        const maxId =
            parseInt(
                maxResult.rows[0].max_id,
                10,
            ) || 0;

        const seqResult =
            await safeQuery(
                `
                    SELECT pg_get_serial_sequence(
                        'categories',
                        'id'
                    ) AS sequence_name
                `,
            );
        const sequenceName = seqResult.rows[0]?.sequence_name;
        if (sequenceName) {
            await pool.query('SELECT setval($1, $2, true)', [sequenceName, maxId]);
        }

        return maxId;
    }

    /** Normalize default users into a comma-separated username string (or null). */
    static normalizeDefaultUsers(raw) {
        if (raw == null) return null;
        const list = Array.isArray(raw)
            ? raw
            : String(raw).split(/[,|]/);
        const joined = list
            .map((s) => String(s ?? '').trim())
            .filter(Boolean)
            .join(',');
        return joined || null;
    }

    static async create(categoryData) {
        const { 
            letter, 
            name, 
            parent_id, 
            is_active, 
            default_users, 
            category_type,
            process 
        } = categoryData;

        const insertSql =
            'INSERT INTO categories (letter, name, parent_id, is_active, default_users, category_type) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *';
        const params = [
            letter,
            name,
            parent_id || null,
            is_active !== undefined ? is_active : true,
            CategoryModel.normalizeDefaultUsers(default_users),
            CategoryModel.normalizeCategoryType(category_type || process),
        ];

        try {
            const result =
                await safeQuery(
                    insertSql,
                    params,
                );

            CategoryModel.clearCache();

            return result.rows[0];
        } catch (error) {
            if (error.code === '23505' && error.constraint === 'categories_pkey') {
                await CategoryModel.syncIdSequence();

                const retry =
                    await safeQuery(
                        insertSql,
                        params,
                    );

                CategoryModel.clearCache();

                return retry.rows[0];
            }
            throw error;
        }
    }

    static async update(
        id,
        categoryData,
    ) {
        const {
            letter,
            name,
            is_active,
            default_users,
            category_type,
            process,
        } = categoryData;

        const result =
            await safeQuery(
                `
                    UPDATE categories
                    SET
                        letter = $1,
                        name = $2,
                        is_active = $3,
                        default_users = $4,
                        category_type = $5,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = $6
                    RETURNING *
                `,
                [
                    letter,
                    name,
                    is_active,
                    CategoryModel.normalizeDefaultUsers(default_users),
                    CategoryModel.normalizeCategoryType(category_type || process),
                    id,
                ],
            );

        CategoryModel.clearCache();

        return result.rows[0];
    }

    static async setActive(
        id,
        isActive,
        {
            cascadeDeactivate = false,
            cascadeActivate = false,
        } = {},
    ) {
        const active =
            Boolean(isActive);

        if (
            (!active && cascadeDeactivate) ||
            (active && cascadeActivate)
        ) {
            const result =
                await safeQuery(
                    `
                        WITH RECURSIVE tree AS (
                            SELECT id
                            FROM categories
                            WHERE id = $1

                            UNION ALL

                            SELECT c.id
                            FROM categories c
                            INNER JOIN tree t
                                ON c.parent_id = t.id
                        )

                        UPDATE categories
                        SET
                            is_active = $2,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE id IN (
                            SELECT id
                            FROM tree
                        )
                        RETURNING *
                    `,
                    [id, active],
                );

            CategoryModel.clearCache();

            return (
                result.rows.find(
                    (row) =>
                        String(
                            row.id,
                        ) ===
                        String(id),
                ) ||
                result.rows[0]
            );
        }

        const result =
            await safeQuery(
                `
                    UPDATE categories
                    SET
                        is_active = $1,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = $2
                    RETURNING *
                `,
                [
                    active,
                    id,
                ],
            );

        CategoryModel.clearCache();

        return result.rows[0];
    }

    static async delete(id) {
        const result =
            await CategoryModel.setActive(
                id,
                false,
                {
                    cascadeDeactivate:
                        true,
                },
            );

        CategoryModel.clearCache();

        return result;
    }

    static async findChildren(id) {
        const result =
            await safeQuery(
                `
                    SELECT id
                    FROM categories
                    WHERE parent_id = $1
                `,
                [id],
            );

        return result.rows;
    }

    static async hardDelete(id) {
        const result =
            await safeQuery(
                `
                    DELETE FROM categories
                    WHERE id = $1
                    RETURNING *
                `,
                [id],
            );

        CategoryModel.clearCache();

        return result.rows[0];
    }

    static async getUsedCategoryIds() {
        const ids = new Set();

        const collectFromQuery =
            async (
                sql,
                params = [],
            ) => {
                try {
                    const result =
                        await safeQuery(
                            sql,
                            params,
                        );

                    result.rows.forEach(
                        (row) => {
                            if (
                                row.id !=
                                null
                            ) {
                                const numericId =
                                    Number(
                                        row.id,
                                    );

                                if (
                                    Number.isFinite(
                                        numericId,
                                    )
                                ) {
                                    ids.add(
                                        numericId,
                                    );
                                }
                            }
                        },
                    );
                } catch (error) {
                    console.warn(
                        'Category usage query skipped:',
                        String(error?.message || ''),
                    );
                }
            };

        await collectFromQuery(
            `
                SELECT DISTINCT
                    process_id AS id
                FROM "TIMESHEET"
                WHERE process_id IS NOT NULL
            `,
        );
        await collectFromQuery(
            `
                SELECT DISTINCT
                    process_id AS id
                FROM tasks
                WHERE process_id IS NOT NULL
            `,
        );
        await collectFromQuery(
            `
                SELECT DISTINCT
                    process_id AS id
                FROM task_list_history
                WHERE process_id IS NOT NULL
            `,
        );

        try {
            const result =
                await safeQuery(
                    `
                        SELECT process_ids
                        FROM "PROJECT"
                        WHERE process_ids IS NOT NULL
                    `,
                );

            result.rows.forEach(
                (row) => {
                    if (
                        !Array.isArray(
                            row.process_ids,
                        )
                    ) {
                        return;
                    }

                    row.process_ids.forEach(
                        (pid) => {
                            if (
                                pid == null
                            ) {
                                return;
                            }

                            const numericId =
                                Number(
                                    pid,
                                );

                            if (
                                Number.isFinite(
                                    numericId,
                                )
                            ) {
                                ids.add(
                                    numericId,
                                );
                            }
                        },
                    );
                },
            );
        } catch (error) {
            console.warn(
                'PROJECT category usage query skipped:',
                error?.message || error,
            );
        }

        try {
            const result =
                await safeQuery(
                    `
                        SELECT total_process_id
                        FROM projects_process_checked
                        WHERE total_process_id IS NOT NULL
                    `,
                );

            result.rows.forEach(
                (row) => {
                    if (
                        !Array.isArray(
                            row.total_process_id,
                        )
                    ) {
                        return;
                    }

                    row.total_process_id.forEach(
                        (pid) => {
                            if (
                                pid == null
                            ) {
                                return;
                            }

                            const numericId =
                                Number(
                                    pid,
                                );

                            if (
                                Number.isFinite(
                                    numericId,
                                )
                            ) {
                                ids.add(
                                    numericId,
                                );
                            }
                        },
                    );
                },
            );
        } catch (error) {
            console.warn(
                'projects_process_checked category usage query skipped:',
                error?.message || error,
            );
        }

        return ids;
    }
}

export default CategoryModel;