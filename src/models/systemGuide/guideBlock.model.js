import { pool } from '../../config/db.js';

export async function listByDocument(documentId) {
    const { rows } = await pool.query(`
        SELECT *
        FROM guide_blocks
        WHERE document_id=$1
        ORDER BY sort_order,id
    `, [documentId]);
    return rows;
}

export async function getById(id) {
    const { rows } = await pool.query(
        'SELECT * FROM guide_blocks WHERE id=$1',
        [id]
    );
    return rows[0] || null;
}

export async function create(data) {
    const { rows } = await pool.query(`
        INSERT INTO guide_blocks
        (document_id,parent_block_id,block_type,content,source_type,source_id,
         auto_generated,sort_order)
        VALUES ($1,$2,$3,COALESCE($4,'{}'::jsonb),$5,$6,
                COALESCE($7,FALSE),COALESCE($8,0))
        RETURNING *
    `, [
        data.document_id, data.parent_block_id || null, data.block_type,
        data.content || {}, data.source_type || null, data.source_id || null,
        data.auto_generated, data.sort_order
    ]);
    return rows[0];
}

export async function update(id, data) {
    const { rows } = await pool.query(`
        UPDATE guide_blocks
        SET parent_block_id=$1,
            block_type=COALESCE($2,block_type),
            content=COALESCE($3,content),
            source_type=$4,
            source_id=$5,
            auto_generated=COALESCE($6,auto_generated),
            sort_order=COALESCE($7,sort_order),
            updated_at=CURRENT_TIMESTAMP
        WHERE id=$8
        RETURNING *
    `, [
        data.parent_block_id || null, data.block_type, data.content,
        data.source_type || null, data.source_id || null,
        data.auto_generated, data.sort_order, id
    ]);
    return rows[0] || null;
}

export async function reorder(documentId, items) {
    const client = await db.connect();

    try {
        await client.query('BEGIN');

        for (const item of items) {
            await client.query(`
                UPDATE guide_blocks
                SET sort_order=$1,
                    parent_block_id=$2,
                    updated_at=CURRENT_TIMESTAMP
                WHERE id=$3 AND document_id=$4
            `, [
                item.sort_order,
                item.parent_block_id || null,
                item.id,
                documentId
            ]);
        }

        await client.query('COMMIT');
        return listByDocument(documentId);
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

export async function remove(id) {
    const result = await pool.query(
        'DELETE FROM guide_blocks WHERE id=$1',
        [id]
    );
    return result.rowCount > 0;
}

export default {
    listByDocument,
    getById,
    create,
    update,
    reorder,
    remove
};
