import { pool } from '../../config/db.js';

export async function listByPage(pageId) {
    const { rows } = await pool.query(
        'SELECT * FROM guide_tabs WHERE page_id=$1 ORDER BY sort_order,title',
        [pageId]
    );
    return rows;
}

export async function getById(id) {
    const { rows } = await pool.query(
        'SELECT * FROM guide_tabs WHERE id=$1',
        [id]
    );
    return rows[0] || null;
}

export async function create(data) {
    const { rows } = await pool.query(`
        INSERT INTO guide_tabs
        (page_id,tab_key,title,sort_order,is_active,auto_generated)
        VALUES ($1,$2,$3,COALESCE($4,0),COALESCE($5,TRUE),COALESCE($6,FALSE))
        RETURNING *
    `, [
        data.page_id, data.tab_key, data.title, data.sort_order,
        data.is_active, data.auto_generated
    ]);
    return rows[0];
}

export async function update(id, data) {
    const { rows } = await pool.query(`
        UPDATE guide_tabs
        SET page_id=COALESCE($1,page_id),
            tab_key=COALESCE($2,tab_key),
            title=COALESCE($3,title),
            sort_order=COALESCE($4,sort_order),
            is_active=COALESCE($5,is_active),
            auto_generated=COALESCE($6,auto_generated),
            updated_at=CURRENT_TIMESTAMP
        WHERE id=$7
        RETURNING *
    `, [
        data.page_id, data.tab_key, data.title, data.sort_order,
        data.is_active, data.auto_generated, id
    ]);
    return rows[0] || null;
}

export async function remove(id) {
    const result = await pool.query('DELETE FROM guide_tabs WHERE id=$1', [id]);
    return result.rowCount > 0;
}

export default { listByPage, getById, create, update, remove };
