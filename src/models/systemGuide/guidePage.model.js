import { pool } from '../../config/db.js';

export async function listByModule(moduleId) {
    const { rows } = await pool.query(`
        SELECT * FROM guide_pages
        WHERE module_id=$1
        ORDER BY sort_order,title
    `, [moduleId]);
    return rows;
}

export async function getById(id) {
    const { rows } = await pool.query(
        'SELECT * FROM guide_pages WHERE id=$1',
        [id]
    );
    return rows[0] || null;
}

export async function getBySlug(moduleSlug, pageSlug) {
    const { rows } = await pool.query(`
        SELECT p.*, m.module_key, m.title AS module_title, m.slug AS module_slug
        FROM guide_pages p
        JOIN guide_modules m ON m.id=p.module_id
        WHERE m.slug=$1 AND p.slug=$2
    `, [moduleSlug, pageSlug]);
    return rows[0] || null;
}

export async function create(data) {
    const { rows } = await pool.query(`
        INSERT INTO guide_pages
        (module_id,page_key,title,slug,route,description,sort_order,is_active,auto_generated)
        VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,0),COALESCE($8,TRUE),COALESCE($9,FALSE))
        RETURNING *
    `, [
        data.module_id, data.page_key, data.title, data.slug,
        data.route || null, data.description || null, data.sort_order,
        data.is_active, data.auto_generated
    ]);
    return rows[0];
}

export async function update(id, data) {
    const { rows } = await pool.query(`
        UPDATE guide_pages
        SET module_id=COALESCE($1,module_id),
            page_key=COALESCE($2,page_key),
            title=COALESCE($3,title),
            slug=COALESCE($4,slug),
            route=COALESCE($5,route),
            description=COALESCE($6,description),
            sort_order=COALESCE($7,sort_order),
            is_active=COALESCE($8,is_active),
            auto_generated=COALESCE($9,auto_generated),
            updated_at=CURRENT_TIMESTAMP
        WHERE id=$10
        RETURNING *
    `, [
        data.module_id, data.page_key, data.title, data.slug,
        data.route, data.description, data.sort_order, data.is_active,
        data.auto_generated, id
    ]);
    return rows[0] || null;
}

export async function remove(id) {
    const result = await pool.query(
        'DELETE FROM guide_pages WHERE id=$1',
        [id]
    );
    return result.rowCount > 0;
}

export default { listByModule, getById, getBySlug, create, update, remove };
