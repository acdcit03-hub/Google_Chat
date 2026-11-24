import { pool } from '../../config/db.js';

class R2rTempBomImageModel {
    static async initializeTable() {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS r2r_temp_bom_images (
                id SERIAL PRIMARY KEY,
                serial_number VARCHAR(100),
                sku VARCHAR(255),
                original_image TEXT,
                processed_image_url TEXT,
                upload_status VARCHAR(50) DEFAULT 'PENDING',
                processing_status VARCHAR(50) DEFAULT 'WAITING',
                kind VARCHAR(50) DEFAULT 'product',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS idx_r2r_temp_bom_images_serial
                ON r2r_temp_bom_images(serial_number);
            CREATE INDEX IF NOT EXISTS idx_r2r_temp_bom_images_updated_at
                ON r2r_temp_bom_images(updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_r2r_temp_bom_images_processed
                ON r2r_temp_bom_images(serial_number)
                WHERE processed_image_url IS NOT NULL;
        `);

        console.log('✅ r2r_temp_bom_images table ready');
    }

    static async create({ serial_number = null, sku = null, original_image = null, processed_image_url = null, upload_status = 'PENDING', processing_status = 'WAITING', kind = 'product' } = {}) {
        const res = await pool.query(
            `INSERT INTO r2r_temp_bom_images (
                serial_number, sku, original_image, processed_image_url,
                upload_status, processing_status, kind, created_at, updated_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW())
             RETURNING *`,
            [serial_number, sku, original_image, processed_image_url, upload_status, processing_status, kind],
        );
        return res.rows[0];
    }

    static async findBySerial(serial_number) {
        const res = await pool.query(
            `SELECT * FROM r2r_temp_bom_images
             WHERE serial_number = $1
             ORDER BY updated_at DESC`,
            [serial_number],
        );
        return res.rows;
    }

    static async findLatestProcessedBySerial(serial_number) {
        const res = await pool.query(
            `SELECT * FROM r2r_temp_bom_images
             WHERE serial_number = $1
               AND processed_image_url IS NOT NULL
             ORDER BY updated_at DESC
             LIMIT 1`,
            [serial_number],
        );
        return res.rows[0];
    }

    static async findById(id) {
        const res = await pool.query(
            `SELECT * FROM r2r_temp_bom_images WHERE id = $1`,
            [id],
        );
        return res.rows[0];
    }

    static async update(id, fields = {}) {
        const sets = [];
        const values = [];
        let idx = 1;
        for (const [k, v] of Object.entries(fields)) {
            if (v === undefined) continue;
            sets.push(`"${k}" = $${idx++}`);
            values.push(v);
        }
        if (sets.length === 0) return null;
        const q = `UPDATE r2r_temp_bom_images SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`;
        values.push(id);
        const res = await pool.query(q, values);
        return res.rows[0];
    }
}

export default R2rTempBomImageModel;
