import { pool } from '../../config/db.js';

export async function list(filters = {}) {
    const where = [];
    const values = [];

    if (filters.media_type) {
        values.push(filters.media_type);
        where.push(`media_type=$${values.length}`);
    }

    if (filters.provider) {
        values.push(filters.provider);
        where.push(`provider=$${values.length}`);
    }

    const { rows } = await pool.query(`
        SELECT *
        FROM guide_media
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY created_at DESC
    `, values);

    return rows;
}

export async function getById(id) {
    const { rows } = await pool.query(
        'SELECT * FROM guide_media WHERE id=$1',
        [id]
    );
    return rows[0] || null;
}

export async function create(data, actorId) {
    const { rows } = await pool.query(`
        INSERT INTO guide_media
        (media_type,provider,file_name,storage_name,relative_path,url,mime_type,
         size,width,height,duration,thumbnail_path,alt_text,metadata,created_by)
        VALUES ($1,COALESCE($2,'storage'),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
                COALESCE($14,'{}'::jsonb),$15)
        RETURNING *
    `, [
        data.media_type, data.provider, data.file_name || null,
        data.storage_name || null, data.relative_path || null, data.url || null,
        data.mime_type || null, data.size || null, data.width || null,
        data.height || null, data.duration || null, data.thumbnail_path || null,
        data.alt_text || null, data.metadata || {}, actorId || null
    ]);
    return rows[0];
}

export async function remove(id) {
    const result = await pool.query(
        'DELETE FROM guide_media WHERE id=$1',
        [id]
    );
    return result.rowCount > 0;
}

export default { list, getById, create, remove };
