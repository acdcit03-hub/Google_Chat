import { pool } from '../../config/db.js';

export async function list({ activeOnly = false } = {}) {
    const where = activeOnly ? 'WHERE is_active = TRUE' : '';
    const { rows } = await pool.query(`
        SELECT *
        FROM guide_modules
        ${where}
        ORDER BY sort_order, title
    `);
    return rows;
}

export async function getById(id) {
    const { rows } = await pool.query(
        'SELECT * FROM guide_modules WHERE id = $1',
        [id]
    );
    return rows[0] || null;
}

export async function getBySlug(slug) {
    const { rows } = await pool.query(
        'SELECT * FROM guide_modules WHERE slug = $1',
        [slug]
    );
    return rows[0] || null;
}

export async function create(data, actorId) {
    const { rows } = await pool.query(`
        INSERT INTO guide_modules
        (module_key,title,slug,icon,route,description,sort_order,is_active,auto_generated,created_by,updated_by)
        VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,0),COALESCE($8,TRUE),COALESCE($9,FALSE),$10,$10)
        RETURNING *
    `, [
        data.module_key, data.title, data.slug, data.icon || null,
        data.route || null, data.description || null, data.sort_order,
        data.is_active, data.auto_generated, actorId || null
    ]);
    return rows[0];
}

export async function update(id, data, actorId) {
    const { rows } = await pool.query(`
        UPDATE guide_modules
        SET module_key=COALESCE($1,module_key),
            title=COALESCE($2,title),
            slug=COALESCE($3,slug),
            icon=COALESCE($4,icon),
            route=COALESCE($5,route),
            description=COALESCE($6,description),
            sort_order=COALESCE($7,sort_order),
            is_active=COALESCE($8,is_active),
            auto_generated=COALESCE($9,auto_generated),
            updated_by=$10,
            updated_at=CURRENT_TIMESTAMP
        WHERE id=$11
        RETURNING *
    `, [
        data.module_key, data.title, data.slug, data.icon, data.route,
        data.description, data.sort_order, data.is_active,
        data.auto_generated, actorId || null, id
    ]);
    return rows[0] || null;
}

export async function remove(id) {
    const result = await pool.query(
        'DELETE FROM guide_modules WHERE id=$1',
        [id]
    );
    return result.rowCount > 0;
}

export default { list, getById, getBySlug, create, update, remove };
