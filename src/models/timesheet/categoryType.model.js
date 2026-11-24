import { pool } from '../../config/db.js';

class CategoryTypeModel {
    static async findAll() {
        const result = await pool.query(
            `
                SELECT *
                FROM category_type
                ORDER BY id ASC
            `,
        );

        return result.rows;
    }

    static async findById(id) {
        const result = await pool.query(
            `
                SELECT *
                FROM category_type
                WHERE id = $1
            `,
            [id],
        );

        return result.rows[0] || null;
    }

    static async findByModule(module, excludeId = null) {
        const params = [String(module).trim()];
        let query = `
            SELECT *
            FROM category_type
            WHERE LOWER(TRIM(module)) = LOWER(TRIM($1))
        `;

        if (excludeId != null) {
            query += ' AND id != $2';
            params.push(excludeId);
        }

        const result = await pool.query(query, params);
        return result.rows[0] || null;
    }

    static async create({ module, process, checklist, is_active }) {
        const result = await pool.query(
            `
                INSERT INTO category_type (
                    module,
                    process,
                    checklist,
                    is_active
                )
                VALUES ($1, $2, $3, $4)
                RETURNING *
            `,
            [module, process, checklist, is_active],
        );

        return result.rows[0];
    }

    static async update(id, { module, process, checklist, is_active }) {
        const result = await pool.query(
            `
                UPDATE category_type
                SET
                    module = $1,
                    process = $2,
                    checklist = $3,
                    is_active = $4,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $5
                RETURNING *
            `,
            [module, process, checklist, is_active, id],
        );

        return result.rows[0] || null;
    }

    static async delete(id) {
        const result = await pool.query(
            `
                DELETE FROM category_type
                WHERE id = $1
                RETURNING *
            `,
            [id],
        );

        return result.rows[0] || null;
    }
}

export default CategoryTypeModel;
