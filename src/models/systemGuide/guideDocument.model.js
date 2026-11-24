import { pool } from '../../config/db.js';


export async function list(filters = {}) {
    const where = [];
    const values = [];

    for (const [field, column] of [
        ['module_id', 'd.module_id'],
        ['page_id', 'd.page_id'],
        ['version_id', 'd.version_id'],
        ['status', 'd.status']
    ]) {
        if (filters[field]) {
            values.push(filters[field]);
            where.push(`${column}=$${values.length}`);
        }
    }

    const { rows } = await pool.query(`
        SELECT d.*,
               m.title AS module_title,
               p.title AS page_title,
               v.version_name
        FROM guide_documents d
        LEFT JOIN guide_modules m ON m.id=d.module_id
        LEFT JOIN guide_pages p ON p.id=d.page_id
        LEFT JOIN guide_versions v ON v.id=d.version_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY d.sort_order,d.title
    `, values);

    return rows;
}

export async function getById(id) {
    const { rows } = await pool.query(`
        SELECT d.*,
               m.title AS module_title,
               p.title AS page_title,
               v.version_name
        FROM guide_documents d
        LEFT JOIN guide_modules m ON m.id=d.module_id
        LEFT JOIN guide_pages p ON p.id=d.page_id
        LEFT JOIN guide_versions v ON v.id=d.version_id
        WHERE d.id=$1
    `, [id]);

    return rows[0] || null;
}

export async function getFullByPath(
    moduleSlug,
    pageSlug,
    documentSlug,
    versionKey = null
) {
    const values = [moduleSlug, pageSlug, documentSlug];
    let versionSql = '';

    if (versionKey) {
        values.push(versionKey);
        versionSql = `AND v.version_key=$${values.length}`;
    }

    const { rows } = await pool.query(`
        SELECT d.*,
               m.module_key,m.title AS module_title,m.slug AS module_slug,
               p.page_key,p.title AS page_title,p.slug AS page_slug,
               v.version_key,v.version_name
        FROM guide_documents d
        JOIN guide_modules m ON m.id=d.module_id
        JOIN guide_pages p ON p.id=d.page_id
        LEFT JOIN guide_versions v ON v.id=d.version_id
        WHERE m.slug=$1
          AND p.slug=$2
          AND d.slug=$3
          ${versionSql}
        ORDER BY d.updated_at DESC
        LIMIT 1
    `, values);

    if (!rows[0]) return null;

    const document = rows[0];

    const blocks = await pool.query(`
        SELECT *
        FROM guide_blocks
        WHERE document_id=$1
        ORDER BY sort_order,id
    `, [document.id]);

    return {
        ...document,
        blocks: blocks.rows
    };
}

export async function create(data, actorId) {
    const { rows } = await pool.query(`
        INSERT INTO guide_documents
        (module_id,page_id,tab_id,section_id,version_id,title,slug,summary,
         status,sort_order,created_by,updated_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,'draft'),
                COALESCE($10,0),$11,$11)
        RETURNING *
    `, [
        data.module_id || null, data.page_id || null,
        data.tab_id || null, data.section_id || null,
        data.version_id || null, data.title, data.slug,
        data.summary || null, data.status, data.sort_order,
        actorId || null
    ]);

    return rows[0];
}

export async function update(id, data, actorId) {
    const { rows } = await pool.query(`
        UPDATE guide_documents
        SET module_id=COALESCE($1,module_id),
            page_id=COALESCE($2,page_id),
            tab_id=$3,
            section_id=$4,
            version_id=$5,
            title=COALESCE($6,title),
            slug=COALESCE($7,slug),
            summary=COALESCE($8,summary),
            status=COALESCE($9,status),
            sort_order=COALESCE($10,sort_order),
            updated_by=$11,
            updated_at=CURRENT_TIMESTAMP
        WHERE id=$12
        RETURNING *
    `, [
        data.module_id, data.page_id, data.tab_id, data.section_id,
        data.version_id, data.title, data.slug, data.summary,
        data.status, data.sort_order, actorId || null, id
    ]);

    return rows[0] || null;
}

export async function publish(id, actorId) {
    const { rows } = await pool.query(`
        UPDATE guide_documents
        SET status='published',
            published_by=$1,
            published_at=CURRENT_TIMESTAMP,
            updated_by=$1,
            updated_at=CURRENT_TIMESTAMP
        WHERE id=$2
        RETURNING *
    `, [actorId || null, id]);

    return rows[0] || null;
}

export async function unpublish(id, actorId) {
    const { rows } = await pool.query(`
        UPDATE guide_documents
        SET status='draft',
            published_by=NULL,
            published_at=NULL,
            updated_by=$1,
            updated_at=CURRENT_TIMESTAMP
        WHERE id=$2
        RETURNING *
    `, [actorId || null, id]);

    return rows[0] || null;
}

export async function remove(id) {
    const result = await pool.query(
        'DELETE FROM guide_documents WHERE id=$1',
        [id]
    );
    return result.rowCount > 0;
}

export default {
    list,
    getById,
    getFullByPath,
    create,
    update,
    publish,
    unpublish,
    remove
};
