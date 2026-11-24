import { pool } from '../../config/db.js';

export async function list(filters = {}) {
    const where = [];
    const values = [];

    if (filters.module_id) {
        values.push(filters.module_id);
        where.push(`module_id=$${values.length}`);
    }

    if (filters.role_id) {
        values.push(filters.role_id);
        where.push(`role_id=$${values.length}`);
    }

    if (filters.user_id) {
        values.push(filters.user_id);
        where.push(`user_id=$${values.length}`);
    }

    const { rows } = await pool.query(`
        SELECT *
        FROM guide_permissions
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY id
    `, values);

    return rows;
}

export async function upsert(data) {
    const { rows } = await pool.query(`
        INSERT INTO guide_permissions
        (module_id,permission_key,role_id,user_id,is_allowed)
        VALUES ($1,$2,$3,$4,COALESCE($5,TRUE))
        RETURNING *
    `, [
        data.module_id || null,
        data.permission_key,
        data.role_id || null,
        data.user_id || null,
        data.is_allowed
    ]);

    return rows[0];
}

export async function remove(id) {
    const result = await pool.query(
        'DELETE FROM guide_permissions WHERE id=$1',
        [id]
    );
    return result.rowCount > 0;
}

export default { list, upsert, remove };
