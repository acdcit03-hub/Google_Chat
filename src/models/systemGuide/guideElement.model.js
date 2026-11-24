import { pool } from '../../config/db.js';

export async function listByPage(pageId) {
    const { rows } = await pool.query(`
        SELECT * FROM guide_elements
        WHERE page_id=$1
        ORDER BY sort_order,element_type,label
    `, [pageId]);
    return rows;
}

export async function getById(id) {
    const { rows } = await pool.query(
        'SELECT * FROM guide_elements WHERE id=$1',
        [id]
    );
    return rows[0] || null;
}

export async function create(data) {
    const { rows } = await pool.query(`
        INSERT INTO guide_elements
        (page_id,tab_id,section_id,element_key,element_type,label,field_name,
         action_name,route,metadata,sort_order,is_active,auto_generated)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10,'{}'::jsonb),
                COALESCE($11,0),COALESCE($12,TRUE),COALESCE($13,FALSE))
        RETURNING *
    `, [
        data.page_id, data.tab_id || null, data.section_id || null,
        data.element_key, data.element_type, data.label || null,
        data.field_name || null, data.action_name || null, data.route || null,
        data.metadata || {}, data.sort_order, data.is_active,
        data.auto_generated
    ]);
    return rows[0];
}

export async function update(id, data) {
    const { rows } = await pool.query(`
        UPDATE guide_elements
        SET page_id=COALESCE($1,page_id),
            tab_id=$2,
            section_id=$3,
            element_key=COALESCE($4,element_key),
            element_type=COALESCE($5,element_type),
            label=COALESCE($6,label),
            field_name=COALESCE($7,field_name),
            action_name=COALESCE($8,action_name),
            route=COALESCE($9,route),
            metadata=COALESCE($10,metadata),
            sort_order=COALESCE($11,sort_order),
            is_active=COALESCE($12,is_active),
            auto_generated=COALESCE($13,auto_generated),
            updated_at=CURRENT_TIMESTAMP
        WHERE id=$14
        RETURNING *
    `, [
        data.page_id, data.tab_id, data.section_id, data.element_key,
        data.element_type, data.label, data.field_name, data.action_name,
        data.route, data.metadata, data.sort_order, data.is_active,
        data.auto_generated, id
    ]);
    return rows[0] || null;
}

export async function remove(id) {
    const result = await pool.query(
        'DELETE FROM guide_elements WHERE id=$1',
        [id]
    );
    return result.rowCount > 0;
}

export default { listByPage, getById, create, update, remove };
