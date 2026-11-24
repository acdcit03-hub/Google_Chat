import { pool } from '../../config/db.js';

const TEMP_REQUIREMENT_COLUMNS = [
    'temp_id',
    'user_id',
    'username',
    'socket_id',
    'date',
    'product_name',
    'quantity',
    'unit',
    'package',
    'remark',
    'product_photo',
    'bom_file',
    'bom_preview',
    'link',
    'project_code',
    'target_receive_date',
    'require_person_name',
    'order_person_name',
    'review_person',
    'order_status',
    'receive_qty',
    'vendor',
    'price_per_piece',
    'order_date',
    'sku',
    'expected_date',
    'receive_date',
    'receiver_name',
    'mnp',
    'requirement_type',
    'status',
    'order_qty',
    'pcb_code',
    'lot_no',
    'split',
    'order_id',
    'order_tracking_link',
    'is_completed',
    'data',
];

class R2rTempRequirementModel {
    static buildFields(payload = {}) {
        const row = {};
        const nullableEmptyColumns = new Set([
            'user_id',
            'quantity',
            'receive_qty',
            'price_per_piece',
            'order_qty',
            'date',
            'target_receive_date',
            'order_date',
            'expected_date',
            'receive_date',
            'bom_preview',
            'is_completed',
        ]);
        for (const key of TEMP_REQUIREMENT_COLUMNS) {
            if (!Object.prototype.hasOwnProperty.call(payload, key)) {
                continue;
            }
            let value = payload[key];
            if (key === 'temp_id' && (value === '' || value === null || value === undefined)) {
                continue;
            }
            if (value === '') {
                if (nullableEmptyColumns.has(key)) {
                    value = null;
                }
            }
            if (key === 'is_completed' && typeof value === 'string') {
                const normalized = String(value).trim().toLowerCase();
            if (normalized === 'true' || normalized === '1') {
                    value = true;
                } else if (normalized === 'false' || normalized === '0' || normalized === '') {
                    value = false;
                }
            }
            // Normalize date string fields from dd-mm-yyyy to ISO (yyyy-mm-dd)
            const dateColumns = new Set([
                'date',
                'target_receive_date',
                'order_date',
                'expected_date',
                'receive_date'
            ]);
            if (dateColumns.has(key) && typeof value === 'string') {
                const s = value.trim();
                const m = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
                if (m) {
                    // convert DD-MM-YYYY -> YYYY-MM-DD (Postgres-friendly ISO)
                    value = `${m[3]}-${m[2]}-${m[1]}`;
                }
            }
            row[key] = value;
        }
        return row;
    }

    static async create(payload = {}) {
        const row = R2rTempRequirementModel.buildFields(payload);
        const columns = Object.keys(row);
        const values = Object.values(row);

        let query;
        if (columns.length > 0) {
            const placeholders = columns.map((_, idx) => `$${idx + 1}`);
            query = `INSERT INTO "TEMP_REQUIREMENT" (${columns.join(', ')}, created_at, updated_at) VALUES (${placeholders.join(', ')}, NOW(), NOW()) RETURNING *`;
        } else {
            query = `INSERT INTO "TEMP_REQUIREMENT" (created_at, updated_at) VALUES (NOW(), NOW()) RETURNING *`;
        }

        const res = await pool.query(query, values);
        return res.rows[0];
    }

    static async update(id, payload = {}) {
        const row = R2rTempRequirementModel.buildFields(payload);
        const columns = Object.keys(row);
        if (columns.length === 0) return null;

        const sets = columns.map((col, idx) => `${col} = $${idx + 1}`);
        const values = Object.values(row);
        const query = `UPDATE "TEMP_REQUIREMENT" SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${columns.length + 1} RETURNING *`;
        values.push(id);

        const res = await pool.query(query, values);
        return res.rows[0];
    }

    static async findByUserId(user_id) {
        const res = await pool.query(
            `SELECT * FROM "TEMP_REQUIREMENT"
             WHERE user_id = $1
             ORDER BY updated_at DESC`,
            [user_id],
        );
        return res.rows;
    }

    /** Own drafts by username (case-insensitive). Optional user_id includes legacy rows with null username. */
    static async findByUsername(username, user_id = null) {
        const name = String(username ?? '').trim();
        if (!name) return [];
        if (user_id != null && Number.isFinite(Number(user_id))) {
            const res = await pool.query(
                `SELECT * FROM "TEMP_REQUIREMENT"
                 WHERE LOWER(TRIM(username)) = LOWER(TRIM($1))
                    OR (
                      (username IS NULL OR TRIM(username) = '')
                      AND user_id = $2
                    )
                 ORDER BY updated_at DESC`,
                [name, Number(user_id)],
            );
            return res.rows;
        }
        const res = await pool.query(
            `SELECT * FROM "TEMP_REQUIREMENT"
             WHERE LOWER(TRIM(username)) = LOWER(TRIM($1))
             ORDER BY updated_at DESC`,
            [name],
        );
        return res.rows;
    }

    static async findByTempId(temp_id) {
        const res = await pool.query(`SELECT * FROM "TEMP_REQUIREMENT" WHERE temp_id = $1 LIMIT 1`, [temp_id]);
        return res.rows[0];
    }

    static async findById(id) {
        const res = await pool.query(`SELECT * FROM "TEMP_REQUIREMENT" WHERE id = $1`, [id]);
        return res.rows[0];
    }

    static async findBySerial(serial_number) {
        const res = await pool.query(`SELECT * FROM "TEMP_REQUIREMENT" WHERE serial_number = $1 ORDER BY updated_at DESC`, [serial_number]);
        return res.rows;
    }

    static async deleteById(id) {
        const res = await pool.query(`DELETE FROM "TEMP_REQUIREMENT" WHERE id = $1 RETURNING *`, [id]);
        return res.rows[0];
    }

    static async deleteByTempId(temp_id) {
        const res = await pool.query(
            `DELETE FROM "TEMP_REQUIREMENT" WHERE temp_id = $1 RETURNING *`,
            [temp_id],
        );
        return res.rows[0];
    }
}

export default R2rTempRequirementModel;
