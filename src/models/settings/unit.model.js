import { pool } from '../../config/db.js';

class UnitModel {
    static async findAll() {
        const result = await pool.query('SELECT * FROM "UNITS" ORDER BY unitname ASC');
        return result.rows;
    }

    static async findById(id) {
        const result = await pool.query('SELECT * FROM "UNITS" WHERE id = $1', [id]);
        return result.rows[0];
    }

    static async findByName(unitname, excludeId = null) {
        let query = 'SELECT * FROM "UNITS" WHERE LOWER(TRIM(unitname)) = LOWER(TRIM($1))';
        const params = [unitname];
        
        if (excludeId) {
            query += ' AND id != $2';
            params.push(excludeId);
        }
        
        const result = await pool.query(query, params);
        return result.rows[0];
    }

    static async create(unitData) {
        const { unitname, is_active } = unitData;
        const result = await pool.query(
            'INSERT INTO "UNITS" (unitname, is_active) VALUES ($1, $2) RETURNING *',
            [unitname.trim(), is_active !== undefined ? is_active : true]
        );
        return result.rows[0];
    }

    static async update(id, unitData) {
        const { unitname, is_active } = unitData;
        const result = await pool.query(
            'UPDATE "UNITS" SET unitname = $1, is_active = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING *',
            [unitname.trim(), is_active, id]
        );
        return result.rows[0];
    }

    static async delete(id) {
        const result = await pool.query('DELETE FROM "UNITS" WHERE id = $1 RETURNING id', [id]);
        return result.rows[0];
    }
}

export default UnitModel;
