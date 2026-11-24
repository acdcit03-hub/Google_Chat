import { pool } from '../../config/db.js';

class ProjectProcessCheckedModel {
    static async findAll(filters = {}) {
        const { project_id, project_code, main_or_pcb_id, scope } = filters;
        const conditions = [];
        const params = [];

        if (project_id != null && project_id !== '') {
            params.push(parseInt(project_id, 10));
            conditions.push(`project_id = $${params.length}`);
        }

        if (project_code != null && String(project_code).trim() !== '') {
            params.push(String(project_code).trim());
            conditions.push(`project_code = $${params.length}`);
        }

        const scopeValue = main_or_pcb_id ?? scope;
        if (scopeValue != null && String(scopeValue).trim() !== '') {
            params.push(String(scopeValue).trim());
            conditions.push(`main_or_pcb_id = $${params.length}`);
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const result = await pool.query(
            `SELECT *
             FROM projects_process_checked
             ${where}
             ORDER BY project_id ASC, main_or_pcb_id ASC`,
            params,
        );
        return result.rows;
    }

    static async findById(id) {
        const result = await pool.query(
            'SELECT * FROM projects_process_checked WHERE id = $1 LIMIT 1',
            [parseInt(id, 10)],
        );
        return result.rows[0] || null;
    }

    static async findByProjectId(projectId) {
        const pid = parseInt(projectId, 10);
        if (!Number.isFinite(pid) || pid <= 0) return [];

        const result = await pool.query(
            `SELECT *
             FROM projects_process_checked
             WHERE project_id = $1
             ORDER BY main_or_pcb_id ASC`,
            [pid],
        );
        return result.rows;
    }

    static async findByProjectAndScope(projectId, scope) {
        const pid = parseInt(projectId, 10);
        const scopeKey = scope == null || scope === '' ? 'main' : String(scope).trim();
        if (!Number.isFinite(pid) || pid <= 0) return null;

        const result = await pool.query(
            `SELECT *
             FROM projects_process_checked
             WHERE project_id = $1
               AND main_or_pcb_id = $2
             LIMIT 1`,
            [pid, scopeKey],
        );
        return result.rows[0] || null;
    }

    static async deleteById(id) {
        const result = await pool.query(
            'DELETE FROM projects_process_checked WHERE id = $1 RETURNING id',
            [parseInt(id, 10)],
        );
        return result.rows[0] || null;
    }
}

export default ProjectProcessCheckedModel;
