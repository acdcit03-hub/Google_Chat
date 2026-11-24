import { pool } from '../../config/db.js';

class DepartmentModel {
    static async findAll() {
        const result = await pool.query('SELECT * FROM departments ORDER BY name ASC');
        return result.rows;
    }

    static async findById(id) {
        const result = await pool.query('SELECT * FROM departments WHERE id = $1', [id]);
        return result.rows[0];
    }

    static async findByName(name, excludeId = null) {
        let query = 'SELECT * FROM departments WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))';
        const params = [name];
        
        if (excludeId) {
            query += ' AND id != $2';
            params.push(excludeId);
        }
        
        const result = await pool.query(query, params);
        return result.rows[0];
    }

    static async create(deptData) {
        const { name, description, is_active } = deptData;
        const result = await pool.query(
            'INSERT INTO departments (name, description, is_active) VALUES ($1, $2, $3) RETURNING *',
            [name, description, is_active !== undefined ? is_active : true]
        );
        return result.rows[0];
    }

    static async update(id, deptData) {
        const { name, description, is_active } = deptData;
        const result = await pool.query(
            'UPDATE departments SET name = $1, description = $2, is_active = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4 RETURNING *',
            [name, description, is_active, id]
        );
        return result.rows[0];
    }

    static async delete(id) {
        const result = await pool.query('DELETE FROM departments WHERE id = $1 RETURNING id', [id]);
        return result.rows[0];
    }
}

export default DepartmentModel;
