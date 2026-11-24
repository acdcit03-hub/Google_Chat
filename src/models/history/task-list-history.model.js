import { pool } from '../../config/db.js';

class TaskListHistoryModel {
    static async create(data) {
        const { process_id, user_id, checked, project_code, project_id, pcb_id } = data;
        const result = await pool.query(
            `INSERT INTO task_list_history (process_id, user_id, checked, project_code, project_id, pcb_id)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *`,
            [
                process_id == null ? null : parseInt(process_id, 10),
                user_id == null ? null : parseInt(user_id, 10),
                !!checked,
                project_code || null,
                project_id == null ? null : parseInt(project_id, 10),
                pcb_id == null ? null : parseInt(pcb_id, 10)
            ]
        );
        return result.rows[0];
    }

    static async findByProject(filters = {}) {
        const { project_code, project_id, process_id, user_id, limit = 100 } = filters;
        const conditions = [];
        const params = [];

        if (project_code) {
            params.push(project_code.trim());
            conditions.push(`TRIM(UPPER(project_code)) = TRIM(UPPER($${params.length}))`);
        }
        if (project_id != null) {
            params.push(project_id);
            conditions.push(`project_id = $${params.length}`);
        }
        if (process_id != null) {
            params.push(process_id);
            conditions.push(`process_id = $${params.length}`);
        }
        if (user_id != null) {
            params.push(user_id);
            conditions.push(`user_id = $${params.length}`);
        }

        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const actualLimit = Math.min(parseInt(limit, 10) || 100, 500);
        params.push(actualLimit);

        const result = await pool.query(
            `SELECT h.*, pd.username as user_name, pd.first_name, pd.last_name
             FROM task_list_history h
             LEFT JOIN personal_details pd ON h.user_id = pd.id
             ${where}
             ORDER BY h.created_at DESC
             LIMIT $${params.length}`,
            params
        );
        return result.rows;
    }
}

export default TaskListHistoryModel;
