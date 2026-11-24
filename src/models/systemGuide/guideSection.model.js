import { pool } from '../../config/db.js';

export async function listByPage(pageId) {
    const { rows } = await pool.query(
        'SELECT * FROM guide_sections WHERE page_id=$1 ORDER BY sort_order,title',
        [pageId]
    );
    return rows;
}

export async function listByTab(tabId) {
    const { rows } = await pool.query(
        'SELECT * FROM guide_sections WHERE tab_id=$1 ORDER BY sort_order,title',
        [tabId]
    );
    return rows;
}

export async function getById(id) {
    const { rows } = await pool.query(
        'SELECT * FROM guide_sections WHERE id=$1',
        [id]
    );
    return rows[0] || null;
}

export async function create(data) {
    const { rows } = await pool.query(`
        INSERT INTO guide_sections
        (page_id,tab_id,title,slug,description,sort_order,is_active,auto_generated)
        VALUES ($1,$2,$3,$4,$5,COALESCE($6,0),COALESCE($7,TRUE),COALESCE($8,FALSE))
        RETURNING *
    `, [
        data.page_id, data.tab_id || null, data.title, data.slug || null,
        data.description || null, data.sort_order, data.is_active,
        data.auto_generated
    ]);
    return rows[0];
}

export async function update(id, data) {
    const { rows } = await pool.query(`
        UPDATE guide_sections
        SET page_id=COALESCE($1,page_id),
            tab_id=$2,
            title=COALESCE($3,title),
            slug=COALESCE($4,slug),
            description=COALESCE($5,description),
            sort_order=COALESCE($6,sort_order),
            is_active=COALESCE($7,is_active),
            auto_generated=COALESCE($8,auto_generated),
            updated_at=CURRENT_TIMESTAMP
        WHERE id=$9
        RETURNING *
    `, [
        data.page_id, data.tab_id, data.title, data.slug,
        data.description, data.sort_order, data.is_active,
        data.auto_generated, id
    ]);
    return rows[0] || null;
}

export async function remove(id) {
    const result = await pool.query(
        'DELETE FROM guide_sections WHERE id=$1',
        [id]
    );
    return result.rowCount > 0;
}

export default { listByPage, listByTab, getById, create, update, remove };
