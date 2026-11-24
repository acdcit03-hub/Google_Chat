import { pool } from '../../config/db.js';

const MIN_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 10000;

const ORDER_BY_SERIAL_TAIL = `
            (serial_number IS NULL OR TRIM(serial_number) = '') ASC,
            CASE
              WHEN TRIM(serial_number) ~ '^[A-Za-z]+-+[0-9]{4}-+[0-9]+$'
                THEN CAST(regexp_replace(TRIM(serial_number), '^[A-Za-z]+-+([0-9]{4})-+([0-9]+)$', '\\1') AS INTEGER)
              ELSE -1
            END DESC,
            CASE
              WHEN TRIM(serial_number) ~ '^[A-Za-z]+-+[0-9]{4}-+[0-9]+$'
                THEN CAST(regexp_replace(TRIM(serial_number), '^[A-Za-z]+-+([0-9]{4})-+([0-9]+)$', '\\2') AS INTEGER)
              ELSE -1
            END DESC
        `;

const ORDER_BY_SERIAL = `
          ORDER BY
            ${ORDER_BY_SERIAL_TAIL.trim()}
        `;

/** Urgent first, then Normal, then other order_status; serial sort within each tier. */
const ORDER_BY_URGENT_NORMAL_SERIAL = `
          ORDER BY
            CASE
              WHEN LOWER(TRIM(COALESCE(order_status, ''))) = 'urgent' THEN 0
              WHEN LOWER(TRIM(COALESCE(order_status, ''))) = 'normal' THEN 1
              ELSE 2
            END ASC,
            ${ORDER_BY_SERIAL_TAIL.trim()}
        `;

/** Earliest expected_date first (DD-MM-YYYY or YYYY-MM-DD); empty dates last; serial as tiebreaker. */
const ORDER_BY_EXPECTED_DATE = `
          ORDER BY
            CASE
              WHEN expected_date IS NULL OR TRIM(COALESCE(expected_date::text, '')) = '' THEN 1
              ELSE 0
            END DESC,
            CASE
              WHEN TRIM(COALESCE(expected_date::text, '')) ~ '^\\d{2}-\\d{2}-\\d{4}$'
                THEN TO_DATE(TRIM(expected_date::text), 'DD-MM-YYYY')
              WHEN TRIM(COALESCE(expected_date::text, '')) ~ '^\\d{4}-\\d{2}-\\d{2}'
                THEN TO_DATE(SUBSTRING(TRIM(expected_date::text), 1, 10), 'YYYY-MM-DD')
              ELSE NULL
            END DESC NULLS LAST,
            ${ORDER_BY_SERIAL_TAIL.trim()}
        `;

class RequirementModel {
    
    /**
     * List endpoint is always paginated: default page 1, page size 20.
     * Optional query: page, limit (min 20, max MAX_PAGE_SIZE), offset.
     */

    static parsePaginationState(filters = {}) {
        const limitRaw = filters.limit;
        const pageRaw = filters.page;
        const offsetRaw = filters.offset;
        const hasPage = pageRaw != null && String(pageRaw).trim() !== '';
        const hasLimit = limitRaw != null && String(limitRaw).trim() !== '';
        const hasOffset = offsetRaw != null && String(offsetRaw).trim() !== '';

        let limit = MIN_PAGE_SIZE;
        if (hasLimit) {
            const n = parseInt(String(limitRaw), 10);
            if (Number.isFinite(n)) {
                limit = Math.min(MAX_PAGE_SIZE, Math.max(MIN_PAGE_SIZE, n));
            }
        }

        let offset = 0;
        let page = 1;
        if (hasOffset) {
            const o = parseInt(String(offsetRaw), 10);
            if (Number.isFinite(o) && o >= 0) offset = o;
            page = Math.floor(offset / limit) + 1;
        } else if (hasPage) {
            const p = parseInt(String(pageRaw), 10);
            page = Number.isFinite(p) && p >= 1 ? p : 1;
            offset = (page - 1) * limit;
        }

        return { limit, offset, page };
    }

    static _buildWhereFromFilters(filters = {}) {
        const params = [];
        const whereClauses = [];

        /** Exact match, or IN (...) when value is comma-separated (multi-select filters). */
        const addInEq = (col, value) => {
            if (value === undefined || value === null || String(value).trim() === '') {
                return;
            }
            const values = String(value)
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
            if (values.length === 0) return;
            if (values.length === 1) {
                whereClauses.push(
                    `LOWER(TRIM("${col}")) = LOWER(TRIM($${params.length + 1}))`,
                );
                params.push(values[0]);
                return;
            }
            const placeholders = values
                .map((_, i) => `LOWER(TRIM($${params.length + i + 1}))`)
                .join(', ');
            whereClauses.push(`LOWER(TRIM("${col}")) IN (${placeholders})`);
            params.push(...values);
        };

        const addILike = (col, value) => {
            if (value === undefined || value === null || String(value).trim() === '') return;
            whereClauses.push(`("${col}" ILIKE $${params.length + 1})`);
            params.push(`%${String(value).trim()}%`);
        };

        const addNotEqILower = (col, value) => {
            if (value === undefined || value === null || String(value).trim() === '') return;
            whereClauses.push(
                `LOWER(TRIM("${col}")) <> LOWER(TRIM($${params.length + 1}))`,
            );
            params.push(String(value).trim());
        };

        const dateExpr = (col) => `
          CASE
            WHEN "${col}" IS NULL OR TRIM("${col}") = '' THEN NULL
            WHEN TRIM("${col}") ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN to_date(TRIM("${col}"), 'YYYY-MM-DD')
            WHEN TRIM("${col}") ~ '^[0-9]{2}-[0-9]{2}-[0-9]{4}$' THEN to_date(TRIM("${col}"), 'DD-MM-YYYY')
            ELSE NULL
          END
        `;

        const addDateFromTo = (col, fromVal, toVal) => {
            const from = fromVal != null && String(fromVal).trim() !== '' ? String(fromVal).trim() : null;
            const to = toVal != null && String(toVal).trim() !== '' ? String(toVal).trim() : null;
            if (!from && !to) return;
            const expr = dateExpr(col);
            if (from) {
                whereClauses.push(`${expr} >= $${params.length + 1}::date`);
                params.push(from);
            }
            if (to) {
                whereClauses.push(`${expr} <= $${params.length + 1}::date`);
                params.push(to);
            }
        };

        addInEq('status', filters.status);
        addILike('order_status', filters.order_status);
        addInEq('requirement_priority', filters.requirement_priority);
        addInEq('requirement_type', filters.requirement_type);
        addInEq('unit', filters.unit);
        addInEq('require_person_name', filters.require_person_name);
        addInEq('review_person', filters.review_person);
        addInEq('order_person_name', filters.order_person_name);
        addNotEqILower('order_person_name', filters.exclude_order_person_name);
        addInEq('receiver_name', filters.receiver_name);

        /** Filter REQUIREMENT rows by username fields on linked QTY_RESERVATION. */
        const addQtyReservationUsernameIn = (column, value) => {
            if (value === undefined || value === null || String(value).trim() === '') {
                return;
            }
            const names = String(value)
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
            if (names.length === 0) return;

            const placeholders = names
                .map((_, i) => `$${params.length + i + 1}`)
                .join(', ');
            whereClauses.push(
                `EXISTS (
                   SELECT 1 FROM "QTY_RESERVATION" qr
                   WHERE qr.id = "REQUIREMENT"."qtyreservation_id"
                     AND TRIM(COALESCE(qr."${column}", '')) IN (${placeholders})
                 )`,
            );
            params.push(...names);
        };
        addQtyReservationUsernameIn('reserved_username', filters.reserved_username);
        addQtyReservationUsernameIn('remove_username', filters.remove_username);

        addILike('serial_number', filters.serial_number);

        /**
         * Sr.No range filter. Serials are like RFQ-2526-1500; UI often sends
         * numeric start/end (e.g. 1500–1600). Compare the trailing number, not
         * the full string (string "RFQ-…" <= "1600" is always false).
         */
        const addSerialFromTo = (fromVal, toVal) => {
            const fromRaw =
                fromVal != null && String(fromVal).trim() !== ''
                    ? String(fromVal).trim()
                    : null;
            const toRaw =
                toVal != null && String(toVal).trim() !== ''
                    ? String(toVal).trim()
                    : null;
            if (!fromRaw && !toRaw) return;

            const toSerialSeq = (raw) => {
                const s = String(raw || '').trim();
                if (!s) return null;
                const last = s.includes('-') ? s.split('-').pop() : s;
                const token = String(last || '').trim();
                if (!/^\d+$/.test(token)) return null;
                const n = parseInt(token, 10);
                return Number.isFinite(n) ? n : null;
            };

            const fromNum = fromRaw ? toSerialSeq(fromRaw) : null;
            const toNum = toRaw ? toSerialSeq(toRaw) : null;

            const serialSeqExpr = `
              CASE
                WHEN TRIM(COALESCE("serial_number", '')) ~ '-[0-9]+$'
                  THEN CAST((regexp_match(TRIM("serial_number"), '-([0-9]+)$'))[1] AS INTEGER)
                WHEN TRIM(COALESCE("serial_number", '')) ~ '^[0-9]+$'
                  THEN CAST(TRIM("serial_number") AS INTEGER)
                ELSE NULL
              END
            `;

            // Exact same bound (numeric or text): match that value
            if (fromRaw && toRaw && fromRaw === toRaw) {
                if (fromNum != null) {
                    whereClauses.push(`${serialSeqExpr} = $${params.length + 1}`);
                    params.push(fromNum);
                } else {
                    whereClauses.push(`("serial_number" ILIKE $${params.length + 1})`);
                    params.push(`%${fromRaw}%`);
                }
                return;
            }

            if (fromNum != null || toNum != null) {
                if (fromNum != null) {
                    whereClauses.push(`${serialSeqExpr} >= $${params.length + 1}`);
                    params.push(fromNum);
                }
                if (toNum != null) {
                    whereClauses.push(`${serialSeqExpr} <= $${params.length + 1}`);
                    params.push(toNum);
                }
                return;
            }

            // Non-numeric free-text fallback
            if (fromRaw) {
                whereClauses.push(
                    `TRIM("serial_number") >= TRIM($${params.length + 1})`,
                );
                params.push(fromRaw);
            }
            if (toRaw) {
                whereClauses.push(
                    `TRIM("serial_number") <= TRIM($${params.length + 1})`,
                );
                params.push(toRaw);
            }
        };
        addSerialFromTo(filters.serial_number_from, filters.serial_number_to);
        addILike('package', filters.package);
        addILike('product_name', filters.product_name);
        addILike('project_code', filters.project_code);
        addILike('vendor', filters.vendor);
        addILike('sku', filters.sku);
        addILike('mnp', filters.mnp);
        addILike('remark', filters.remark);
        addILike('note', filters.note);
        addILike('pcb_code', filters.pcb_code);
        addILike('lot_no', filters.lot_no);
        addILike('location', filters.location);
        // Exact match on reservation workflow status (supports comma-separated multi-select)
        if (
          filters.qtyreservation_status !== undefined &&
          filters.qtyreservation_status !== null &&
          String(filters.qtyreservation_status).trim() !== ''
        ) {
          const values = String(filters.qtyreservation_status)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
          if (values.length > 0) {
            const hasInTransit = values.some(
              (v) => v.toLowerCase() === 'in transit',
            );
            const others = values.filter(
              (v) => v.toLowerCase() !== 'in transit',
            );
            const parts = [];
            if (hasInTransit) {
              parts.push(
                `LOWER(TRIM(COALESCE("qtyreservation_status", ''))) IN ('in transit')`,
              );
            }
            if (others.length === 1) {
              parts.push(
                `LOWER(TRIM(COALESCE("qtyreservation_status", ''))) = LOWER(TRIM($${params.length + 1}))`,
              );
              params.push(others[0]);
            } else if (others.length > 1) {
              const placeholders = others
                .map((_, i) => `LOWER(TRIM($${params.length + i + 1}))`)
                .join(', ');
              parts.push(
                `LOWER(TRIM(COALESCE("qtyreservation_status", ''))) IN (${placeholders})`,
              );
              params.push(...others);
            }
            if (parts.length === 1) {
              whereClauses.push(parts[0]);
            } else if (parts.length > 1) {
              whereClauses.push(`(${parts.join(' OR ')})`);
            }
          }
        } else if (
          filters.qtyreservation_not_null !== undefined &&
          filters.qtyreservation_not_null !== null &&
          String(filters.qtyreservation_not_null).trim() !== ''
        ) {
          const v = String(filters.qtyreservation_not_null).trim().toLowerCase();
          if (v === 'true' || v === '1' || v === 'yes') {
            whereClauses.push(
              `"qtyreservation_status" IS NOT NULL AND TRIM(COALESCE("qtyreservation_status", '')) <> ''`,
            );
          }
        }

        addDateFromTo('date', filters.date_from, filters.date_to);
        addDateFromTo('target_receive_date', filters.target_from, filters.target_to);
        addDateFromTo('order_date', filters.order_date_from, filters.order_date_to);
        addDateFromTo('expected_date', filters.expected_from, filters.expected_to);
        addDateFromTo('receive_date', filters.receive_from, filters.receive_to);

        const addNumberEq = (col, value) => {
            if (value === undefined || value === null || String(value).trim() === '') return;
            const n = Number(value);
            if (!Number.isFinite(n)) return;
            whereClauses.push(`"${col}" = $${params.length + 1}`);
            params.push(n);
        };
        addNumberEq('quantity', filters.quantity);
        addNumberEq('receive_qty', filters.receive_qty);
        addNumberEq('order_qty', filters.order_qty);

        if (filters.has_issue !== undefined && filters.has_issue !== null && String(filters.has_issue).trim() !== '') {
            const v = String(filters.has_issue).trim().toLowerCase();
            if (v === 'true' || v === '1') whereClauses.push(`COALESCE(has_issue, false) = true`);
            if (v === 'false' || v === '0') whereClauses.push(`COALESCE(has_issue, false) = false`);
        }

        const whereSql = whereClauses.length > 0 ? ' WHERE ' + whereClauses.join(' AND ') : '';
        return { whereSql, params };
    }

    static async countMatching(filters = {}) {
        const { whereSql, params } = this._buildWhereFromFilters(filters);
        const result = await pool.query(`SELECT COUNT(*)::int AS total FROM "REQUIREMENT"${whereSql}`, params);
        return result.rows[0].total;
    }

    static _wantsUrgentFirstSort(filters = {}) {
        const raw = filters.urgent_first ?? filters.urgentFirst;
        if (raw === undefined || raw === null) return false;
        const s = String(raw).trim().toLowerCase();
        return s === 'true' || s === '1' || s === 'yes';
    }

    static _wantsExpectedDateFirstSort(filters = {}) {
        const raw = filters.expected_date_first ?? filters.expectedDateFirst;
        if (raw === undefined || raw === null) return false;
        const s = String(raw).trim().toLowerCase();
        return s === 'true' || s === '1' || s === 'yes';
    }

    static async findAll(filters = {}) {
        const { whereSql, params: baseParams } = this._buildWhereFromFilters(filters);
        let query = 'SELECT * FROM "REQUIREMENT"' + whereSql;
        const params = [...baseParams];
        if (this._wantsExpectedDateFirstSort(filters)) {
            query += ORDER_BY_EXPECTED_DATE;
        } else if (this._wantsUrgentFirstSort(filters)) {
            query += ORDER_BY_URGENT_NORMAL_SERIAL;
        } else {
            query += ORDER_BY_SERIAL;
        }

        const pag = this.parsePaginationState(filters);
        query += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        params.push(pag.limit, pag.offset);

        const result = await pool.query(query, params);
        return result.rows;
    }

    /** All matching rows (no pagination) — used for Collection Desk grouping. */
    static async findAllMatching(filters = {}) {
        const { whereSql, params } = this._buildWhereFromFilters(filters);
        let query = 'SELECT * FROM "REQUIREMENT"' + whereSql;
        if (this._wantsExpectedDateFirstSort(filters)) {
            query += ORDER_BY_EXPECTED_DATE;
        } else if (this._wantsUrgentFirstSort(filters)) {
            query += ORDER_BY_URGENT_NORMAL_SERIAL;
        } else {
            query += ORDER_BY_SERIAL;
        }
        const result = await pool.query(query, params);
        return result.rows;
    }

    static async findById(id) {
        const result = await pool.query('SELECT * FROM "REQUIREMENT" WHERE "sr.no" = $1', [id]);
        return result.rows[0];
    }

    static async create(reqData) {
        const {
            date, serial_number, product_name, quantity, unit,
            package: packageType, remark, product_photo, link, project_code,
            target_receive_date, require_person_name, order_person_name, review_person,
            order_status, receive_qty, vendor, price_per_piece,
            order_date, sku, expected_date, receive_date, receiver_name,
            mnp, requirement_type, status, order_qty, bill_or_product_photo,
            pcb_code, lot_no, split, order_id, order_tracking_link,
            location, qtyreservation_status, qtyreservation_id, fixed_quantity,
            requirement_priority, addQuantityID
        } = reqData;

        const result = await pool.query(`
      INSERT INTO "REQUIREMENT" (
        date, serial_number, product_name, quantity, unit,
        package, remark, product_photo, link, project_code,
        target_receive_date, require_person_name, order_person_name, review_person,
        order_status, receive_qty, vendor, price_per_piece,
        order_date, sku, expected_date, receive_date, receiver_name,
        mnp, requirement_type, status, order_qty, bill_or_product_photo, pcb_code, lot_no,
        split, order_id, order_tracking_link, location, qtyreservation_status,
        qtyreservation_id, fixed_quantity, requirement_priority, "addQuantityID"
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39)
      RETURNING *
    `, [
            date, serial_number, product_name, quantity, unit,
            packageType, remark, product_photo, link, project_code,
            target_receive_date, require_person_name, order_person_name, review_person,
            order_status || 'Normal', receive_qty, vendor, price_per_piece,
            order_date, sku, expected_date, receive_date, receiver_name,
            mnp, requirement_type, status, order_qty, bill_or_product_photo,
            pcb_code || null, lot_no || null,
            split || null, order_id || null, order_tracking_link || null,
            location || null, qtyreservation_status || null,
            qtyreservation_id != null && qtyreservation_id !== ''
              ? Number(qtyreservation_id)
              : null,
            fixed_quantity != null && fixed_quantity !== '' ? fixed_quantity : null,
            requirement_priority || 'Any',
            addQuantityID != null && String(addQuantityID).trim() !== ''
              ? String(addQuantityID).trim()
              : null,
        ]);
        return result.rows[0];
    }

    static async update(id, reqData) {
        const keys = Object.keys(reqData).filter(k => k !== 'sr.no');
        if (keys.length === 0) return null;

        const setClause = keys.map((key, i) => `"${key}" = $${i + 1}`).join(', ');
        const params = keys.map(key => reqData[key]);
        params.push(id);

        const query = `
      UPDATE "REQUIREMENT" 
      SET ${setClause}, updated_at = CURRENT_TIMESTAMP 
      WHERE "sr.no" = $${params.length} 
      RETURNING *
    `;

        const result = await pool.query(query, params);
        return result.rows[0];
    }

    static async delete(id) {
        const result = await pool.query('DELETE FROM "REQUIREMENT" WHERE "sr.no" = $1 RETURNING "sr.no"', [id]);
        return result.rows[0];
    }

    /**
     * Highest RFQ suffix for prefix+year (numeric), e.g. 1000 beats 999 — not string sort.
     */
    static async findLatestSerialNumber(prefix, yearMonth) {
        const pattern = `${prefix}-${yearMonth}-%`;
        const result = await pool.query(
            `SELECT serial_number
             FROM "REQUIREMENT"
             WHERE serial_number LIKE $1
             ORDER BY
               CAST(
                 NULLIF(regexp_replace(TRIM(serial_number), '^.*-', ''), '')
                 AS INTEGER
               ) DESC NULLS LAST
             LIMIT 1`,
            [pattern]
        );
        return result.rows[0];
    }

    /** Distinct non-empty person usernames from REQUIREMENT for header filter dropdowns. */
    static async getPersonFilterOptions() {
        const distinct = async (column) => {
            const result = await pool.query(
                `SELECT DISTINCT TRIM("${column}") AS v
                 FROM "REQUIREMENT"
                 WHERE "${column}" IS NOT NULL AND TRIM("${column}") <> ''
                 ORDER BY v ASC`,
            );
            return result.rows.map((r) => String(r.v).trim()).filter(Boolean);
        };

        const distinctQtyReservation = async (column) => {
            const result = await pool.query(
                `SELECT DISTINCT TRIM("${column}") AS v
                 FROM "QTY_RESERVATION"
                 WHERE "${column}" IS NOT NULL AND TRIM("${column}") <> ''
                 ORDER BY v ASC`,
            );
            return result.rows.map((r) => String(r.v).trim()).filter(Boolean);
        };

        const [
            require_person_names,
            review_persons,
            order_person_names,
            receiver_names,
            reserved_usernames,
            remove_usernames,
        ] = await Promise.all([
            distinct('require_person_name'),
            distinct('review_person'),
            distinct('order_person_name'),
            distinct('receiver_name'),
            distinctQtyReservation('reserved_username'),
            distinctQtyReservation('remove_username'),
        ]);

        return {
            require_person_names,
            review_persons,
            order_person_names,
            receiver_names,
            reserved_usernames,
            remove_usernames,
        };
    }
}

export default RequirementModel;
