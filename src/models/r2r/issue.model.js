import { pool } from '../../config/db.js';

class IssueModel {
    static async findAll(filters = {}) {
        let query = 'SELECT * FROM "ISSUE"';
        let params = [];
        let whereClauses = [];

        if (filters.receiveUsername !== undefined) {
            if (filters.receiveUsername === null) {
                whereClauses.push(`"receive_username" IS NULL`);
            } else {
                whereClauses.push(`LOWER(TRIM("receive_username")) = LOWER($${params.length + 1})`);
                params.push(filters.receiveUsername.trim());
            }
        }

        if (filters.pageName) {
            whereClauses.push(`"page_name" = $${params.length + 1}`);
            params.push(filters.pageName);
        }

        if (whereClauses.length > 0) {
            query += ' WHERE ' + whereClauses.join(' AND ');
        }

        query += ' ORDER BY "created_at" DESC';

        const result = await pool.query(query, params);
        return result.rows;
    }

    static async findById(id) {
        const result = await pool.query('SELECT * FROM "ISSUE" WHERE "sr.no" = $1', [id]);
        return result.rows[0];
    }

    static async findByRequirementId(requirementId) {
        const result = await pool.query(
            'SELECT * FROM "ISSUE" WHERE "requirement_id" = $1 ORDER BY "created_at" DESC',
            [requirementId]
        );
        return result.rows;
    }

    static async findLatestByRequirementId(requirementId) {
        const result = await pool.query(
            'SELECT "issue_order_status" FROM "ISSUE" WHERE "requirement_id" = $1 ORDER BY "created_at" DESC LIMIT 1',
            [requirementId]
        );
        return result.rows[0];
    }

    static async create(issueData) {
        const keys = Object.keys(issueData);
        const columns = keys.map(k => `"${k}"`).join(', ');
        const values = Object.values(issueData);
        const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');

        const result = await pool.query(`
            INSERT INTO "ISSUE" (${columns})
            VALUES (${placeholders})
            RETURNING *
        `, values);
        return result.rows[0];
    }

    static async update(id, issueData) {
        const keys = Object.keys(issueData);
        if (keys.length === 0) return null;

        const setClause = keys.map((key, i) => `"${key}" = $${i + 1}`).join(', ');
        const values = keys.map(key => issueData[key]);
        values.push(id);

        const result = await pool.query(`
            UPDATE "ISSUE" 
            SET ${setClause}, updated_at = CURRENT_TIMESTAMP 
            WHERE "sr.no" = $${values.length} 
            RETURNING *
        `, values);
        return result.rows[0];
    }

    static async delete(id) {
        const result = await pool.query('DELETE FROM "ISSUE" WHERE "sr.no" = $1 RETURNING "sr.no"', [id]);
        return result.rows[0];
    }

    static async deleteByRequirementId(requirementId) {
        const result = await pool.query(
            'DELETE FROM "ISSUE" WHERE "requirement_id" = $1 RETURNING "sr.no"',
            [requirementId]
        );
        return result.rows;
    }
}

export default IssueModel;
