import { pool } from '../../config/db.js';
import ProcessMapModel from './updateProject.model.js';


class CustomProcessModel {
    static async findByProjectId(projectId) {
        const pid = parseInt(projectId, 10);
        if (!Number.isFinite(pid) || pid <= 0) return null;

        const result = await pool.query(
            `SELECT id, project_code, custom_process, process_map
             FROM "PROJECT"
             WHERE id = $1
             LIMIT 1`,
            [pid],
        );
        return result.rows[0] || null;
    }

   
    static async update(projectId, customProcess) {
        const pid = parseInt(projectId, 10);
        if (!Number.isFinite(pid) || pid <= 0) return null;

        const normalized =
            ProcessMapModel.normalizeCustomProcessForStorage(customProcess);

        const result = await pool.query(
            `UPDATE "PROJECT"
             SET custom_process = $1::jsonb,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $2
             RETURNING id, project_code, custom_process, process_map`,
            [JSON.stringify(normalized ?? []), pid],
        );
        return result.rows[0] || null;
    }

    static async clear(projectId) {
        const pid = parseInt(projectId, 10);
        if (!Number.isFinite(pid) || pid <= 0) return null;

        const result = await pool.query(
            `UPDATE "PROJECT"
             SET custom_process = '[]'::jsonb,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1
             RETURNING id, project_code, custom_process, process_map`,
            [pid],
        );
        return result.rows[0] || null;
    }
}

export default CustomProcessModel;