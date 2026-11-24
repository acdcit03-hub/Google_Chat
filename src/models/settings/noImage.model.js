import { pool } from '../../config/db.js';

class NoImageModel {
    static async findAll() {
        const result = await pool.query(
            'SELECT * FROM "NO_IMAGE" ORDER BY module_name ASC'
        );
        return result.rows;
    }

    static async findById(id) {
        const result = await pool.query(
            'SELECT * FROM "NO_IMAGE" WHERE id = $1',
            [id]
        );
        return result.rows[0];
    }

    static async findByModuleName(moduleName) {
        const result = await pool.query(
            `SELECT * FROM "NO_IMAGE"
             WHERE LOWER(TRIM(module_name)) = LOWER(TRIM($1))`,
            [moduleName]
        );
        return result.rows[0];
    }

    static async create({ module_name, image }) {
        const result = await pool.query(
            `INSERT INTO "NO_IMAGE" (module_name, image)
             VALUES ($1, $2)
             RETURNING *`,
            [String(module_name).trim(), image ?? null]
        );
        return result.rows[0];
    }

    static async update(id, { module_name, image }) {
        const sets = ['updated_at = CURRENT_TIMESTAMP'];
        const params = [];
        let i = 1;

        if (module_name != null) {
            sets.push(`module_name = $${i++}`);
            params.push(String(module_name).trim());
        }
        if (image !== undefined) {
            sets.push(`image = $${i++}`);
            params.push(image);
        }

        params.push(id);
        const result = await pool.query(
            `UPDATE "NO_IMAGE" SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
            params
        );
        return result.rows[0];
    }

    /** Insert or replace image for a module_name (unique). */
    static async upsertByModuleName({ module_name, image }) {
        const name = String(module_name).trim();
        const result = await pool.query(
            `INSERT INTO "NO_IMAGE" (module_name, image)
             VALUES ($1, $2)
             ON CONFLICT (module_name)
             DO UPDATE SET
                 image = EXCLUDED.image,
                 updated_at = CURRENT_TIMESTAMP
             RETURNING *`,
            [name, image ?? null]
        );
        return result.rows[0];
    }

    static async delete(id) {
        const result = await pool.query(
            'DELETE FROM "NO_IMAGE" WHERE id = $1 RETURNING id',
            [id]
        );
        return result.rows[0];
    }
}

export default NoImageModel;
