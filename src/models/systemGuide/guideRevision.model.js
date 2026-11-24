import { pool } from '../../config/db.js';

export async function listByDocument(documentId) {
    const { rows } = await pool.query(`
        SELECT *
        FROM guide_revisions
        WHERE document_id=$1
        ORDER BY version_number DESC
    `, [documentId]);
    return rows;
}

export async function create({
    document_id,
    snapshot,
    change_note,
    created_by
}) {
    const { rows } = await pool.query(`
        INSERT INTO guide_revisions
        (document_id,version_number,snapshot,change_note,created_by)
        VALUES (
            $1,
            COALESCE(
                (SELECT MAX(version_number)+1
                 FROM guide_revisions
                 WHERE document_id=$1),1
            ),
            $2,$3,$4
        )
        RETURNING *
    `, [
        document_id,
        snapshot,
        change_note || null,
        created_by || null
    ]);

    return rows[0];
}

export default { listByDocument, create };
