import { pool } from '../../config/db.js';

class SettingModel {
    static async findAll() {
        const result = await pool.query('SELECT key, value FROM settings ORDER BY key ASC');
        return result.rows;
    }

    static async findByKey(key) {
        const result = await pool.query('SELECT key, value FROM settings WHERE key = $1', [key]);
        return result.rows[0];
    }

    static async upsert(key, value) {
        const result = await pool.query(
            `INSERT INTO settings (key, value) 
       VALUES ($1, $2) 
       ON CONFLICT (key) 
       DO UPDATE SET value = $2, updated_at = CURRENT_TIMESTAMP 
       RETURNING key, value`,
            [key, value]
        );
        return result.rows[0];
    }

    static async bulkUpsert(settings) {
        // Parallel upsert for multiple settings
        const upsertPromises = Object.entries(settings)
            .filter(([key, value]) => value !== undefined && value !== null)
            .map(([key, value]) => this.upsert(key, value));

        const results = await Promise.allSettled(upsertPromises);
        
        const savedSettings = {};
        results.forEach((result, index) => {
            const [key] = Object.entries(settings).filter(([, value]) => value !== undefined && value !== null)[index];
            if (result.status === 'fulfilled') {
                savedSettings[key] = result.value.value;
            } else {
                console.error(`Error saving setting ${key}:`, result.reason);
            }
        });

        return savedSettings;
    }
}

export default SettingModel;
