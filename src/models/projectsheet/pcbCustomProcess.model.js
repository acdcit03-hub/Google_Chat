import { pool } from '../../config/db.js';
import ProcessMapModel from './updateProject.model.js';


class PcbCustomProcessModel {
    static async findByPcbId(pcbId) {
        const id = parseInt(pcbId, 10);
        if (!Number.isFinite(id) || id <= 0) return null;

        const result = await pool.query(
            `SELECT id, pcb_code, custom_process, process_map
             FROM "PCB"
             WHERE id = $1
             LIMIT 1`,
            [id],
        );
        return result.rows[0] || null;
    }


    static async update(pcbId, customProcess) {
        const id = parseInt(pcbId, 10);
        if (!Number.isFinite(id) || id <= 0) return null;

        const normalized =
            ProcessMapModel.normalizeCustomProcessForStorage(customProcess);

        const result = await pool.query(
            `UPDATE "PCB"
             SET custom_process = $1::jsonb,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $2
             RETURNING id, pcb_code, custom_process, process_map`,
            [JSON.stringify(normalized ?? []), id],
        );
        return result.rows[0] || null;
    }

    static async clear(pcbId) {
        const id = parseInt(pcbId, 10);
        if (!Number.isFinite(id) || id <= 0) return null;

        const result = await pool.query(
            `UPDATE "PCB"
             SET custom_process = '[]'::jsonb,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1
             RETURNING id, pcb_code, custom_process, process_map`,
            [id],
        );
        return result.rows[0] || null;
    }
}

export default PcbCustomProcessModel;