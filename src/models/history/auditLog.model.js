import { pool } from '../../config/db.js';

class AuditLogModel {
  static async findAll({ limit = 200, offset = 0 } = {}) {
    const lim = Math.max(1, Math.min(1000, parseInt(limit, 10) || 200));
    const off = Math.max(0, parseInt(offset, 10) || 0);
    const result = await pool.query(
      `
        SELECT id, action, table_name, table_of_id, table_of_column, old_value, new_value, user_id, created_at
        FROM audit_log
        ORDER BY created_at DESC, id DESC
        LIMIT $1 OFFSET $2
      `,
      [lim, off]
    );
    return result.rows;
  }
}

export default AuditLogModel;

