import { pool } from '../../config/db.js';

class ClientModel {
    /**
     * Build WHERE clause + params for list/count filters.
     * @returns {{ whereSql: string, params: any[] }}
     */
    static buildListFilters(filters = {}) {
        const {
            isActiveFilter,
            company_name,
            client_name,
            client_code,
            mobile,
            email,
            gst,
            location,
            bill_location,
            sheet_map_location,
            created_by,
        } = filters;

        const conditions = [];
        const params = [];

        if (isActiveFilter === true || isActiveFilter === 'true') {
            conditions.push('COALESCE(is_active, TRUE) IS TRUE');
        } else if (isActiveFilter === false || isActiveFilter === 'false') {
            conditions.push('is_active IS FALSE');
        }

        const addIlike = (columnExpr, value) => {
            const raw = String(value || '').trim();
            if (!raw) return;
            params.push(`%${raw}%`);
            conditions.push(`${columnExpr} ILIKE $${params.length}`);
        };

        addIlike('company_name', company_name);

        if (String(client_name || '').trim()) {
            params.push(`%${String(client_name).trim()}%`);
            conditions.push(
                `(CONCAT_WS(' ', client_firstname, client_middlename, client_lastname) ILIKE $${params.length}
                  OR client_firstname ILIKE $${params.length}
                  OR client_middlename ILIKE $${params.length}
                  OR client_lastname ILIKE $${params.length})`,
            );
        }

        addIlike('client_code', client_code);

        if (String(mobile || '').trim()) {
            params.push(`%${String(mobile).trim()}%`);
            conditions.push(
                `(COALESCE(client_mobile_no, '') ILIKE $${params.length}
                  OR COALESCE(contact_number::text, '') ILIKE $${params.length})`,
            );
        }

        addIlike('email_id', email);
        addIlike('gst_code', gst);
        addIlike('location', location);
        addIlike('bill_location', bill_location);
        addIlike('sheet_map_location', sheet_map_location);
        addIlike('created_by', created_by);

        const whereSql =
            conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        return { whereSql, params };
    }

    static async findAll(limit, offset, filters = {}) {
        // Back-compat: third arg used to be isActiveFilter boolean/string
        const normalized =
            filters !== null &&
            typeof filters === 'object' &&
            !Array.isArray(filters)
                ? filters
                : { isActiveFilter: filters };

        const { whereSql, params } = this.buildListFilters(normalized);
        let query = `SELECT * FROM "CLIENT" ${whereSql} ORDER BY company_name ASC`;
        const queryParams = [...params];

        if (limit !== null && limit !== undefined) {
            queryParams.push(limit, offset ?? 0);
            query += ` LIMIT $${queryParams.length - 1} OFFSET $${queryParams.length}`;
        }

        const result = await pool.query(query, queryParams);
        return result.rows;
    }

    static async countAll(filters = {}) {
        const normalized =
            filters !== null &&
            typeof filters === 'object' &&
            !Array.isArray(filters)
                ? filters
                : { isActiveFilter: filters };

        const { whereSql, params } = this.buildListFilters(normalized);
        const result = await pool.query(
            `SELECT COUNT(*) as total FROM "CLIENT" ${whereSql}`,
            params,
        );
        return parseInt(result.rows[0].total, 10);
    }

    static async getStats() {
        const result = await pool.query(`
            SELECT
                COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE COALESCE(is_active, TRUE) IS TRUE)::int AS active,
                COUNT(*) FILTER (WHERE is_active IS FALSE)::int AS inactive
            FROM "CLIENT"
        `);
        return result.rows[0];
    }

    static async findById(id) {
        const result = await pool.query('SELECT * FROM "CLIENT" WHERE id = $1', [id]);
        return result.rows[0];
    }

    static async findByIdOrCode(idOrCode) {
        // Check if it's a number (ID) or string (code)
        if (!isNaN(parseInt(idOrCode))) {
            return await this.findById(idOrCode);
        } else {
            const result = await pool.query(
                'SELECT * FROM "CLIENT" WHERE TRIM(UPPER(client_code)) = TRIM(UPPER($1))',
                [idOrCode]
            );
            return result.rows[0];
        }
    }

    static async findByCode(code, excludeId = null) {
        let query = 'SELECT id FROM "CLIENT" WHERE TRIM(UPPER(client_code)) = TRIM(UPPER($1))';
        let params = [code];

        if (excludeId) {
            query += ' AND id != $2';
            params.push(excludeId);
        }

        const result = await pool.query(query, params);
        return result.rows[0] || null;
    }

    static async create(clientData) {
        const {
            company_name,
            client_firstname,
            client_middlename,
            client_lastname,
            client_code,
            client_mobile_no,
            contact_number,
            email_id,
            gst_code,
            location,
            bill_location,
            sheet_map_location,
            client_logo,
            sec_name,
            sec_mobile,
            sec_email,
            created_by,
            is_active
        } = clientData;

        const result = await pool.query(`
      INSERT INTO "CLIENT" (
        company_name, client_firstname, client_middlename, client_lastname,
        client_code, client_mobile_no, contact_number, email_id,
        gst_code, location, bill_location, sheet_map_location, client_logo,
        sec_name, sec_mobile, sec_email, created_by, is_active
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
      RETURNING *
    `, [
            company_name,
            client_firstname || null,
            client_middlename || null,
            client_lastname || null,
            client_code || null,
            client_mobile_no || null,
            contact_number || null,
            email_id || null,
            gst_code || null,
            location || null,
            bill_location || null,
            sheet_map_location || null,
            client_logo || null,
            sec_name || null,
            sec_mobile || null,
            sec_email || null,
            created_by || null,
            is_active !== undefined && is_active !== null ? Boolean(is_active) : true
        ]);
        return result.rows[0];
    }

    static async update(id, clientData) {
        const {
            company_name,
            client_firstname,
            client_middlename,
            client_lastname,
            client_code,
            client_mobile_no,
            contact_number,
            email_id,
            gst_code,
            location,
            bill_location,
            sheet_map_location,
            client_logo,
            is_active
        } = clientData;

        const result = await pool.query(`
      UPDATE "CLIENT" SET
        company_name = COALESCE($1, company_name),
        client_firstname = COALESCE($2, client_firstname),
        client_middlename = COALESCE($3, client_middlename),
        client_lastname = COALESCE($4, client_lastname),
        client_code = COALESCE($5, client_code),
        client_mobile_no = COALESCE($6, client_mobile_no),
        contact_number = COALESCE($7, contact_number),
        email_id = COALESCE($8, email_id),
        gst_code = COALESCE($9, gst_code),
        location = COALESCE($10, location),
        bill_location = COALESCE($11, bill_location),
        sheet_map_location = COALESCE($12, sheet_map_location),
        client_logo = COALESCE($13, client_logo),
        updated_at = CURRENT_TIMESTAMP
        ${is_active !== undefined ? ', is_active = $14' : ''}
      WHERE id = $15
      RETURNING *
    `, [
            company_name,
            client_firstname,
            client_middlename,
            client_lastname,
            client_code,
            client_mobile_no,
            contact_number,
            email_id,
            gst_code,
            location,
            bill_location,
            sheet_map_location,
            client_logo,
            is_active !== undefined ? is_active : null,
            id
        ]);
        return result.rows[0];
    }

    static async delete(id) {
        const result = await pool.query('DELETE FROM "CLIENT" WHERE id = $1 RETURNING id', [id]);
        return result.rows[0];
    }

    // Optimized: Bulk create with transaction
    static async bulkCreate(clients) {
        const dbClient = await pool.connect();
        try {
            await dbClient.query('BEGIN');
            const createdClients = [];

            for (const c of clients) {
                const result = await dbClient.query(
                    `INSERT INTO "CLIENT" (
                        company_name, client_code, client_firstname, client_middlename, client_lastname,
                        client_mobile_no, email_id, gst_code, location, bill_location,
                        sheet_map_location, sec_name, sec_mobile, sec_email, created_by
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
                    ON CONFLICT (client_code) DO UPDATE SET
                        company_name = EXCLUDED.company_name,
                        client_firstname = EXCLUDED.client_firstname,
                        client_middlename = EXCLUDED.client_middlename,
                        client_lastname = EXCLUDED.client_lastname,
                        client_mobile_no = EXCLUDED.client_mobile_no,
                        email_id = EXCLUDED.email_id,
                        gst_code = EXCLUDED.gst_code,
                        location = EXCLUDED.location,
                        bill_location = EXCLUDED.bill_location,
                        sheet_map_location = EXCLUDED.sheet_map_location,
                        sec_name = EXCLUDED.sec_name,
                        sec_mobile = EXCLUDED.sec_mobile,
                        sec_email = EXCLUDED.sec_email,
                        created_by = EXCLUDED.created_by,
                        is_active = EXCLUDED.is_active
                    RETURNING *`,
                    [
                        c.company_name, c.client_code, c.client_firstname || null, c.client_middlename || null, c.client_lastname || null,
                        c.client_mobile_no || null, c.email_id || null, c.gst_code || null, c.location || null, c.bill_location || null,
                        c.sheet_map_location || null, c.sec_name || null, c.sec_mobile || null, c.sec_email || null, c.created_by || null, c.is_active || null
                    ]
                );
                createdClients.push(result.rows[0]);
            }
            await dbClient.query('COMMIT');
            return createdClients;
        } catch (error) {
            await dbClient.query('ROLLBACK');
            throw error;
        } finally {
            dbClient.release();
        }
    }
}

export default ClientModel;
