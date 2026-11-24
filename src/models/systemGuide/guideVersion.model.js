import { pool } from '../../config/db.js';

export async function list() {
    const { rows } = await pool.query(
        'SELECT * FROM guide_versions ORDER BY created_at DESC'
    );
    return rows;
}

export async function getById(id) {
    const { rows } = await pool.query(
        'SELECT * FROM guide_versions WHERE id=$1',
        [id]
    );
    return rows[0] || null;
}

export async function create(data, actorId) {
    const { rows } = await pool.query(`
        INSERT INTO guide_versions
        (version_key,version_name,description,is_active,is_default,created_by,updated_by)
        VALUES ($1,$2,$3,COALESCE($4,TRUE),COALESCE($5,FALSE),$6,$6)
        RETURNING *
    `, [
        data.version_key, data.version_name, data.description || null,
        data.is_active, data.is_default, actorId || null
    ]);
    return rows[0];
}

export async function update(id, data, actorId) {
    const { rows } = await pool.query(`
        UPDATE guide_versions
        SET version_key=COALESCE($1,version_key),
            version_name=COALESCE($2,version_name),
            description=COALESCE($3,description),
            is_active=COALESCE($4,is_active),
            is_default=COALESCE($5,is_default),
            updated_by=$6,
            updated_at=CURRENT_TIMESTAMP
        WHERE id=$7
        RETURNING *
    `, [
        data.version_key, data.version_name, data.description,
        data.is_active, data.is_default, actorId || null, id
    ]);
    return rows[0] || null;
}

export async function remove(id) {
    const result = await pool.query(
        'DELETE FROM guide_versions WHERE id=$1',
        [id]
    );
    return result.rowCount > 0;
}

export default { list, getById, create, update, remove };
