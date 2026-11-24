import { pool } from '../../config/db.js';
import { IST_TIMEZONE, toIstTimestampString } from '../../utils/time.utils.js';

/** Create/verify QTY_RESERVATION table. */
export async function initializeQtyReservationTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "QTY_RESERVATION" (
      id SERIAL PRIMARY KEY,
      requirement_id TEXT,
      serial_number TEXT,
      sku VARCHAR(100),
      item_name VARCHAR(255),
      location VARCHAR(255),
      target_receive_date TEXT,
      req_qty TEXT,
      receive_qty NUMERIC(10, 2),
      reserved_qty NUMERIC(10, 2),
      remove_quantity NUMERIC(10, 2),
      "remove_qtyID" TEXT,
      fixed_quantity NUMERIC(10, 2),
      req_username VARCHAR(255),
      receive_username VARCHAR(255),
      reserved_username VARCHAR(255),
      remove_username VARCHAR(255),
      remove_date TIMESTAMP,
      review TEXT,
      review_username VARCHAR(255),
      review_date TIMESTAMP,
      project_code VARCHAR(255),
      pcb_code VARCHAR(255),
      lot_no VARCHAR(255),
      comment TEXT,
      qtyreservation_status VARCHAR(50),
      is_read BOOLEAN,
      items_image TEXT,
      created_by VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_qty_reservation_requirement_id
      ON "QTY_RESERVATION"(requirement_id);
    CREATE INDEX IF NOT EXISTS idx_qty_reservation_serial_number
      ON "QTY_RESERVATION"(serial_number);
    CREATE INDEX IF NOT EXISTS idx_qty_reservation_sku
      ON "QTY_RESERVATION"(sku);
    CREATE INDEX IF NOT EXISTS idx_qty_reservation_status
      ON "QTY_RESERVATION"(qtyreservation_status);
    CREATE INDEX IF NOT EXISTS idx_qty_reservation_project_code
      ON "QTY_RESERVATION"(project_code);
    CREATE INDEX IF NOT EXISTS idx_qty_reservation_created_at
      ON "QTY_RESERVATION"(created_at);

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'QTY_RESERVATION' AND column_name = 'fixed_quantity'
      ) THEN
        ALTER TABLE "QTY_RESERVATION" ADD COLUMN fixed_quantity NUMERIC(10, 2);
      END IF;
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'QTY_RESERVATION' AND column_name = 'serial_number'
          AND data_type <> 'text'
      ) THEN
        ALTER TABLE "QTY_RESERVATION" ALTER COLUMN serial_number TYPE TEXT;
      END IF;
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'QTY_RESERVATION' AND column_name = 'target_receive_date'
          AND data_type <> 'text'
      ) THEN
        ALTER TABLE "QTY_RESERVATION" ALTER COLUMN target_receive_date TYPE TEXT;
      END IF;
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'QTY_RESERVATION' AND column_name = 'req_qty'
          AND udt_name <> 'text'
      ) THEN
        ALTER TABLE "QTY_RESERVATION" ALTER COLUMN req_qty TYPE TEXT USING req_qty::text;
      END IF;
      IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'fk_qty_reservation_requirement'
          AND table_name = 'QTY_RESERVATION'
      ) THEN
        ALTER TABLE "QTY_RESERVATION"
        DROP CONSTRAINT fk_qty_reservation_requirement;
      END IF;
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'QTY_RESERVATION' AND column_name = 'requirement_id'
          AND data_type <> 'text'
          AND udt_name <> 'text'
      ) THEN
        ALTER TABLE "QTY_RESERVATION"
        ALTER COLUMN requirement_id TYPE TEXT USING requirement_id::text;
      END IF;
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'QTY_RESERVATION' AND column_name = 'store_qty'
      ) THEN
        ALTER TABLE "QTY_RESERVATION" DROP COLUMN store_qty;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'QTY_RESERVATION' AND column_name = 'items_image'
      ) THEN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'QTY_RESERVATION' AND column_name = 'items_photo'
        ) THEN
          ALTER TABLE "QTY_RESERVATION" RENAME COLUMN items_photo TO items_image;
        ELSE
          ALTER TABLE "QTY_RESERVATION" ADD COLUMN items_image TEXT;
        END IF;
      ELSIF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'QTY_RESERVATION' AND column_name = 'items_photo'
      ) THEN
        UPDATE "QTY_RESERVATION"
        SET items_image = items_photo
        WHERE (items_image IS NULL OR TRIM(items_image) = '')
          AND items_photo IS NOT NULL
          AND TRIM(items_photo) <> '';
        ALTER TABLE "QTY_RESERVATION" DROP COLUMN items_photo;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'QTY_RESERVATION' AND column_name = 'remove_quantity'
      ) THEN
        ALTER TABLE "QTY_RESERVATION" ADD COLUMN remove_quantity NUMERIC(10, 2);
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'QTY_RESERVATION' AND column_name = 'remove_qtyID'
      ) THEN
        ALTER TABLE "QTY_RESERVATION" ADD COLUMN "remove_qtyID" TEXT;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'QTY_RESERVATION' AND column_name = 'remove_username'
      ) THEN
        ALTER TABLE "QTY_RESERVATION" ADD COLUMN remove_username VARCHAR(255);
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'QTY_RESERVATION' AND column_name = 'remove_date'
      ) THEN
        ALTER TABLE "QTY_RESERVATION" ADD COLUMN remove_date TIMESTAMP;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'QTY_RESERVATION' AND column_name = 'review'
      ) THEN
        ALTER TABLE "QTY_RESERVATION" ADD COLUMN review TEXT;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'QTY_RESERVATION' AND column_name = 'review_username'
      ) THEN
        ALTER TABLE "QTY_RESERVATION" ADD COLUMN review_username VARCHAR(255);
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'QTY_RESERVATION' AND column_name = 'review_date'
      ) THEN
        ALTER TABLE "QTY_RESERVATION" ADD COLUMN review_date TIMESTAMP;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'QTY_RESERVATION' AND column_name = 'receive_username'
      ) THEN
        ALTER TABLE "QTY_RESERVATION" ADD COLUMN receive_username VARCHAR(255);
      END IF;
      UPDATE "QTY_RESERVATION" qr
      SET receive_username = r.receiver_name
      FROM "REQUIREMENT" r
      WHERE (qr.receive_username IS NULL OR TRIM(qr.receive_username) = '')
        AND qr.requirement_id IS NOT NULL
        AND TRIM(qr.requirement_id) <> ''
        AND qr.requirement_id NOT LIKE '%,%'
        AND qr.requirement_id = r."sr.no"::text
        AND r.receiver_name IS NOT NULL
        AND TRIM(r.receiver_name) <> '';
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'QTY_RESERVATION' AND column_name = 'is_read'
      ) THEN
        ALTER TABLE "QTY_RESERVATION" ADD COLUMN is_read BOOLEAN;
      END IF;
    END $$;
  `);
  console.log('✅ QTY_RESERVATION table ready');
}

class QtyReservationModel {
  /** Serialize timestamp fields as IST wall-clock strings for API responses. */
  static _formatRow(row) {
    if (!row) return row;
    const fmt = (v) =>
      v != null && v !== '' ? toIstTimestampString(v) : v;
    return {
      ...row,
      remove_qtyID:
        row.remove_qtyID ??
        row.remove_qtyid ??
        row.remove_qty_id ??
        null,
      remove_date: fmt(row.remove_date),
      review_date: fmt(row.review_date),
      created_at: fmt(row.created_at),
      updated_at: fmt(row.updated_at),
    };
  }

  static _buildWhereFromFilters(filters = {}) {
    const params = [];
    const whereClauses = [];

    const pushIlike = (columnSql, rawValue) => {
      const value = String(rawValue ?? '').trim();
      if (!value) return;
      // Escape LIKE wildcards so letters like _ in codes match literally.
      const escaped = value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
      whereClauses.push(
        `LOWER(TRIM(COALESCE(${columnSql}, ''))) ILIKE LOWER($${params.length + 1}) ESCAPE '\\'`,
      );
      params.push(`%${escaped}%`);
    };

    if (filters.requirement_id != null && String(filters.requirement_id).trim() !== '') {
      const rid = String(filters.requirement_id).trim();
      // Exact token match or partial content match
      whereClauses.push(
        `(requirement_id = $${params.length + 1}
          OR (',' || COALESCE(requirement_id, '') || ',') LIKE '%,' || $${params.length + 1} || ',%'
          OR LOWER(TRIM(COALESCE(requirement_id, ''))) ILIKE LOWER($${params.length + 2}))`,
      );
      params.push(rid, `%${rid}%`);
    }

    pushIlike('serial_number', filters.serial_number);
    pushIlike('sku', filters.sku);

    const statusFilter = String(
      filters.qtyreservation_status ?? filters.status ?? '',
    ).trim();
    if (statusFilter) {
      const statusNeedle = statusFilter.toLowerCase();
      if (statusNeedle === 'in transit') {
        whereClauses.push(
          `LOWER(TRIM(COALESCE(qtyreservation_status, ''))) IN ('in transit')`,
        );
      } else {
        pushIlike('qtyreservation_status', statusFilter);
      }
    }

    pushIlike('project_code', filters.project_code);
    pushIlike('pcb_code', filters.pcb_code);
    pushIlike('item_name', filters.item_name);
    pushIlike('lot_no', filters.lot_no);
    pushIlike('receive_username', filters.receive_username);

    const usernameFilter = String(
      filters.username ?? filters.user_name ?? '',
    ).trim();
    if (usernameFilter) {
      const escaped = usernameFilter
        .replace(/\\/g, '\\\\')
        .replace(/%/g, '\\%')
        .replace(/_/g, '\\_');
      whereClauses.push(
        `(LOWER(TRIM(COALESCE(req_username, ''))) ILIKE LOWER($${params.length + 1}) ESCAPE '\\'
          OR LOWER(TRIM(COALESCE(reserved_username, ''))) ILIKE LOWER($${params.length + 1}) ESCAPE '\\'
          OR LOWER(TRIM(COALESCE(receive_username, ''))) ILIKE LOWER($${params.length + 1}) ESCAPE '\\')`,
      );
      params.push(`%${escaped}%`);
    } else {
      pushIlike('req_username', filters.req_username);
    }

    pushIlike('reserved_username', filters.reserved_username);

    const whereSql =
      whereClauses.length > 0 ? ` WHERE ${whereClauses.join(' AND ')}` : '';
    return { whereSql, params };
  }

  static async findAll(filters = {}) {
    const { whereSql, params: baseParams } = this._buildWhereFromFilters(filters);
    let query =
      'SELECT * FROM "QTY_RESERVATION"' +
      whereSql +
      ' ORDER BY created_at DESC, id DESC';
    const params = [...baseParams];

    const hasLimit =
      filters.limit != null && String(filters.limit).trim() !== '';
    if (hasLimit) {
      const limit = Math.max(1, parseInt(String(filters.limit), 10) || 10);
      const offset = Math.max(0, parseInt(String(filters.offset), 10) || 0);
      query += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(limit, offset);
    }

    const result = await pool.query(query, params);
    return result.rows.map((row) => this._formatRow(row));
  }

  static async countMatching(filters = {}) {
    const { whereSql, params } = this._buildWhereFromFilters(filters);
    const result = await pool.query(
      `SELECT COUNT(*)::int AS total FROM "QTY_RESERVATION"${whereSql}`,
      params,
    );
    return result.rows[0]?.total ?? 0;
  }

  /** WHERE clause for qty-reservation notifications. */
  static _buildNotificationWhere(filters = {}) {
    const params = [];
    const whereClauses = [];

    const pushIlike = (columnSql, rawValue) => {
      const value = String(rawValue ?? '').trim();
      if (!value) return;
      const escaped = value
        .replace(/\\/g, '\\\\')
        .replace(/%/g, '\\%')
        .replace(/_/g, '\\_');
      whereClauses.push(
        `LOWER(TRIM(COALESCE(${columnSql}, ''))) ILIKE LOWER($${params.length + 1}) ESCAPE '\\'`,
      );
      params.push(`%${escaped}%`);
    };

    const rawStatus = String(
      filters.qtyreservation_status ?? filters.status ?? '',
    ).trim();
    if (rawStatus) {
      if (rawStatus.includes(',')) {
        const statuses = rawStatus
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean);
        if (statuses.length) {
          const placeholders = statuses.map(
            (_, i) => `LOWER($${params.length + i + 1})`,
          );
          whereClauses.push(
            `LOWER(TRIM(COALESCE(qtyreservation_status, ''))) IN (${placeholders.join(', ')})`,
          );
          params.push(...statuses);
        }
      } else {
        pushIlike('qtyreservation_status', rawStatus);
      }
    } else {
      whereClauses.push(
        `LOWER(TRIM(COALESCE(qtyreservation_status, ''))) IN ('completed', 'completed with issue','qty reserved')`,
      );
    }

    pushIlike('item_name', filters.item_name);
    pushIlike('sku', filters.sku);
    pushIlike('remove_username', filters.remove_username);
    pushIlike('review_username', filters.review_username);
    pushIlike('receive_username', filters.receive_username);
    pushIlike('reserved_username', filters.reserved_username);
    pushIlike('req_username', filters.req_username);

    if (filters.is_read !== undefined && String(filters.is_read).trim() !== '') {
      const raw = String(filters.is_read).trim().toLowerCase();
      if (raw === 'null') {
        whereClauses.push('is_read IS NULL');
      } else if (raw === 'true' || raw === '1') {
        whereClauses.push('is_read = TRUE');
      } else if (raw === 'false' || raw === '0') {
        whereClauses.push('is_read = FALSE');
      }
    }

    const whereSql =
      whereClauses.length > 0 ? ` WHERE ${whereClauses.join(' AND ')}` : '';
    return { whereSql, params };
  }

  static _formatNotificationRow(row) {
    if (!row) return row;
    const fmt = (v) =>
      v != null && v !== '' ? toIstTimestampString(v) : v;
    return {
      id: row.id,
      status: row.qtyreservation_status ?? null,
      sku: row.sku ?? null,
      item_name: row.item_name ?? null,
      receive_username: row.receive_username ?? null,
      reserved_username: row.reserved_username ?? null,
      reserved_qty:
        row.reserved_qty != null && row.reserved_qty !== ''
          ? Number(row.reserved_qty)
          : null,
      remove_username: row.remove_username ?? null,
      review: row.review ?? null,
      review_username: row.review_username ?? null,
      review_date: fmt(row.review_date),
      is_read: row.is_read ?? null,
    };
  }

  /** Public alias for socket / API notification payloads. */
  static formatNotificationRow(row) {
    return this._formatNotificationRow(row);
  }

  static async findNotifications(filters = {}) {
    const { whereSql, params: baseParams } =
      this._buildNotificationWhere(filters);
    let query =
      `SELECT id, qtyreservation_status, sku, item_name, receive_username, reserved_username, reserved_qty, remove_username, review, review_username, review_date, is_read
       FROM "QTY_RESERVATION"` +
      whereSql +
      ' ORDER BY review_date DESC NULLS LAST, id DESC';
    const params = [...baseParams];

    const hasLimit =
      filters.limit != null && String(filters.limit).trim() !== '';
    if (hasLimit) {
      const limit = Math.max(1, parseInt(String(filters.limit), 10) || 10);
      const offset = Math.max(0, parseInt(String(filters.offset), 10) || 0);
      query += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(limit, offset);
    }

    const result = await pool.query(query, params);
    return result.rows.map((row) => this._formatNotificationRow(row));
  }

  static async countNotifications(filters = {}) {
    const { whereSql, params } = this._buildNotificationWhere(filters);
    const result = await pool.query(
      `SELECT COUNT(*)::int AS total FROM "QTY_RESERVATION"${whereSql}`,
      params,
    );
    return result.rows[0]?.total ?? 0;
  }

  static async findById(id) {
    const result = await pool.query(
      'SELECT * FROM "QTY_RESERVATION" WHERE id = $1',
      [id],
    );
    return this._formatRow(result.rows[0]);
  }

  static async findByRequirementId(requirementId) {
    const rid = String(requirementId ?? '').trim();
    const result = await pool.query(
      `SELECT * FROM "QTY_RESERVATION"
       WHERE requirement_id = $1
          OR (',' || COALESCE(requirement_id, '') || ',') LIKE '%,' || $1 || ',%'
       ORDER BY created_at DESC, id DESC`,
      [rid],
    );
    return result.rows.map((row) => this._formatRow(row));
  }

  static _parseRequirementIdList(value) {
    return String(value ?? '')
      .split(',')
      .map((part) => String(part).trim())
      .filter(Boolean);
  }

  static async _resolveLinkedReservation({ requirementId, qtyReservationId }) {
    const reqId = String(requirementId ?? '').trim();
    if (!reqId) return null;

    let reservation = null;
    const resId = qtyReservationId != null ? Number(qtyReservationId) : null;
    if (Number.isFinite(resId) && resId > 0) {
      reservation = await this.findById(resId);
    }
    if (!reservation) {
      const rows = await this.findByRequirementId(reqId);
      reservation = rows[0] ?? null;
    }
    return reservation?.id ? reservation : null;
  }

  /** Open / legacy statuses that may be normalized to Pending Reserve. */
  static _isOpenQtyReservationStatus(status) {
    const s = String(status ?? '')
      .trim()
      .toLowerCase();
    // Treat legacy partial_receive as open so sync upgrades it to Pending Reserve.
    return !s || s === 'pending reserve';
  }

  /**
   * Parse expire_hours setting:
   * - `24h,0m,0s` / `0h,1m,0s`
   * - legacy plain hours number: `24`
   * @returns {{ hours: number, minutes: number, seconds: number }}
   */
  static parseExpireDuration(raw) {
    const value = String(raw ?? '').trim();
    if (!value) {
      return { hours: 24, minutes: 0, seconds: 0 };
    }

    const match = value.match(/^(\d+)\s*h\s*,\s*(\d+)\s*m\s*,\s*(\d+)\s*s$/i);
    if (match) {
      const hours = Math.max(0, Math.floor(Number(match[1]) || 0));
      const minutes = Math.min(59, Math.max(0, Math.floor(Number(match[2]) || 0)));
      const seconds = Math.min(59, Math.max(0, Math.floor(Number(match[3]) || 0)));
      if (hours === 0 && minutes === 0 && seconds === 0) {
        return { hours: 24, minutes: 0, seconds: 0 };
      }
      return { hours, minutes, seconds };
    }

    const asHours = Number(value);
    if (Number.isFinite(asHours) && asHours >= 1) {
      return { hours: Math.floor(asHours), minutes: 0, seconds: 0 };
    }

    return { hours: 24, minutes: 0, seconds: 0 };
  }

  /**
   * Pending Reserve → Reserve Expired when created_at is older than expire duration.
   * Accepts `24h,0m,0s` string, plain hours number, or {hours,minutes,seconds}.
   * Also syncs linked REQUIREMENT.qtyreservation_status.
   * @returns {Promise<object[]>} updated reservation rows
   */
  static async expirePendingPastDuration(expireDuration) {
    const duration =
      expireDuration &&
      typeof expireDuration === 'object' &&
      !Array.isArray(expireDuration)
        ? {
            hours: Math.max(0, Math.floor(Number(expireDuration.hours) || 0)),
            minutes: Math.max(0, Math.floor(Number(expireDuration.minutes) || 0)),
            seconds: Math.max(0, Math.floor(Number(expireDuration.seconds) || 0)),
          }
        : this.parseExpireDuration(expireDuration);

    let { hours, minutes, seconds } = duration;
    if (hours === 0 && minutes === 0 && seconds === 0) {
      hours = 24;
    }

    const result = await pool.query(
      `UPDATE "QTY_RESERVATION"
       SET qtyreservation_status = $1,
           updated_at = (NOW() AT TIME ZONE '${IST_TIMEZONE}')
       WHERE LOWER(TRIM(COALESCE(qtyreservation_status, ''))) = 'pending reserve'
         AND created_at <= NOW() - make_interval(
           hours => $2,
           mins => $3,
           secs => $4
         )
       RETURNING *`,
      ['Reserve Expired', hours, minutes, seconds],
    );

    const rows = result.rows.map((row) => this._formatRow(row));
    for (const row of rows) {
      try {
        await this._syncStatusToLinkedRequirements(
          row.requirement_id,
          'Reserve Expired',
        );
      } catch (err) {
        console.error(
          'Failed syncing Reserve Expired to requirements:',
          err?.message || err,
        );
      }
    }
    return rows;
  }

  /** @deprecated Use expirePendingPastDuration */
  static async expirePendingPastHours(expireHours) {
    return this.expirePendingPastDuration(expireHours);
  }

  /**
   * Always Pending Reserve for open rows — no receive vs fixed quantity check.
   * Returns null when status must not change (already reserved/completed/etc.).
   */
  static _statusFromReceiveVsFixed(reservation, _receiveQty) {
    if (!this._isOpenQtyReservationStatus(reservation?.qtyreservation_status)) {
      return null;
    }
    return 'Pending Reserve';
  }

  static async _syncStatusToLinkedRequirements(requirementIdValue, status) {
    const ids = this._parseRequirementIdList(requirementIdValue)
      .map((id) => Number(id))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (!ids.length || !status) return;

    const beforeResult = await pool.query(
      `SELECT "sr.no", serial_number, status, qtyreservation_status
       FROM "REQUIREMENT"
       WHERE "sr.no" = ANY($1::int[])`,
      [ids],
    );

    await pool.query(
      `UPDATE "REQUIREMENT"
       SET qtyreservation_status = $1, updated_at = NOW()
       WHERE "sr.no" = ANY($2::int[])`,
      [status, ids],
    );

    const { recordQtyReservationStatusChange } = await import(
      './requirementStatus.model.js'
    );
    for (const row of beforeResult.rows) {
      const serial = String(row.serial_number ?? '').trim();
      const prev = String(row.qtyreservation_status ?? '').trim();
      const next = String(status ?? '').trim();
      if (
        !serial ||
        !next ||
        (prev && prev.toLowerCase() === next.toLowerCase())
      ) {
        continue;
      }
      try {
        await recordQtyReservationStatusChange({
          serial_number: serial,
          old_qtyreservation_status: prev || null,
          new_qtyreservation_status: next,
          fallback_old_status: String(row.status ?? '').trim() || null,
        });
      } catch (err) {
        console.error(
          'Failed recording qtyreservation status history:',
          serial,
          err.message || err,
        );
      }
    }
  }

  static async _applyPatchWithStatus(reservation, patch) {
    const nextReceive =
      patch.receive_qty !== undefined
        ? patch.receive_qty
        : reservation.receive_qty;
    const nextStatus = this._statusFromReceiveVsFixed(reservation, nextReceive);
    if (nextStatus != null) {
      patch.qtyreservation_status = nextStatus;
    }

    const updated = await this.update(reservation.id, patch);
    if (
      updated &&
      nextStatus != null &&
      String(reservation.qtyreservation_status ?? '').trim().toLowerCase() !==
        nextStatus.toLowerCase()
    ) {
      try {
        await this._syncStatusToLinkedRequirements(
          updated.requirement_id,
          nextStatus,
        );
      } catch (err) {
        console.error(
          'Failed syncing qtyreservation_status to requirements:',
          err,
        );
      }
    }
    return updated;
  }

  /**
   * Requirement receive_qty changed → update only QTY_RESERVATION.receive_qty
   * (+ status from receive vs fixed when still open).
   */
  static async syncReceiveQtyFromRequirement({
    requirementId,
    receiveQty,
    qtyReservationId,
  } = {}) {
    const reqId = String(requirementId ?? '').trim();
    const parsedReceive = Number(receiveQty);
    if (!reqId || !Number.isFinite(parsedReceive) || parsedReceive < 0) {
      return null;
    }

    const reservation = await this._resolveLinkedReservation({
      requirementId: reqId,
      qtyReservationId,
    });
    if (!reservation) return null;

    const linkedReqIds = this._parseRequirementIdList(reservation.requirement_id);

    if (linkedReqIds.length <= 1) {
      return this._applyPatchWithStatus(reservation, {
        receive_qty: parsedReceive,
      });
    }

    let total = 0;
    for (const linkedId of linkedReqIds) {
      if (linkedId === reqId) {
        total += parsedReceive;
        continue;
      }
      const linked = await pool.query(
        `SELECT receive_qty FROM "REQUIREMENT" WHERE "sr.no"::text = $1 LIMIT 1`,
        [linkedId],
      );
      const n = Number(linked.rows[0]?.receive_qty);
      total += Number.isFinite(n) && n > 0 ? n : 0;
    }

    return this._applyPatchWithStatus(reservation, { receive_qty: total });
  }

  /**
   * Requirement quantity changed → update only QTY_RESERVATION.req_qty
   * (+ re-check status from existing receive vs fixed when still open).
   */
  static async syncReqQtyFromRequirement({
    requirementId,
    quantity,
    qtyReservationId,
  } = {}) {
    const reqId = String(requirementId ?? '').trim();
    const parsedQty = Number(quantity);
    if (!reqId || !Number.isFinite(parsedQty) || parsedQty < 0) {
      return null;
    }

    const reservation = await this._resolveLinkedReservation({
      requirementId: reqId,
      qtyReservationId,
    });
    if (!reservation) return null;

    const linkedReqIds = this._parseRequirementIdList(reservation.requirement_id);

    let patch;
    if (linkedReqIds.length <= 1) {
      patch = { req_qty: String(parsedQty) };
    } else {
      const reqQtyParts = String(reservation.req_qty ?? '')
        .split(',')
        .map((part) => part.trim());
      while (reqQtyParts.length < linkedReqIds.length) {
        reqQtyParts.push('0');
      }
      const idx = linkedReqIds.findIndex((id) => id === reqId);
      if (idx < 0) return null;
      reqQtyParts[idx] = String(parsedQty);
      patch = { req_qty: reqQtyParts.join(',') };
    }

    return this._applyPatchWithStatus(reservation, patch);
  }

  /** Normalize API aliases onto the quoted DB column "remove_qtyID". */
  static _normalizeWriteData(data = {}) {
    const next = { ...data };
    const raw =
      next.remove_qtyID ??
      next.remove_qtyid ??
      next.remove_qty_id;
    if (raw !== undefined) {
      next.remove_qtyID =
        raw == null || String(raw).trim() === ''
          ? null
          : String(raw).trim();
      delete next.remove_qtyid;
      delete next.remove_qty_id;
    }
    return next;
  }

  static async create(data = {}) {
    const normalized = this._normalizeWriteData(data);
    const keys = Object.keys(normalized).filter(
      (key) => normalized[key] !== undefined && key !== 'id',
    );
    if (keys.length === 0) {
      throw new Error('No qty reservation fields provided');
    }

    const columns = keys.map((k) => `"${k}"`).join(', ');
    const values = keys.map((k) => normalized[k]);
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');

    const result = await pool.query(
      `INSERT INTO "QTY_RESERVATION" (${columns})
       VALUES (${placeholders})
       RETURNING *`,
      values,
    );
    return this._formatRow(result.rows[0]);
  }

  static async update(id, data = {}) {
    const normalized = this._normalizeWriteData(data);
    const keys = Object.keys(normalized).filter(
      (key) => normalized[key] !== undefined && key !== 'id',
    );
    if (keys.length === 0) return null;

    const setClause = keys
      .map((key, i) => `"${key}" = $${i + 1}`)
      .join(', ');
    const values = keys.map((key) => normalized[key]);
    values.push(id);

    const result = await pool.query(
      `UPDATE "QTY_RESERVATION"
       SET ${setClause}, updated_at = (NOW() AT TIME ZONE '${IST_TIMEZONE}')
       WHERE id = $${values.length}
       RETURNING *`,
      values,
    );
    return this._formatRow(result.rows[0]);
  }

  static async delete(id) {
    const result = await pool.query(
      'DELETE FROM "QTY_RESERVATION" WHERE id = $1 RETURNING id',
      [id],
    );
    return result.rows[0];
  }

  static async deleteByRequirementId(requirementId) {
    const rid = String(requirementId ?? '').trim();
    const result = await pool.query(
      `DELETE FROM "QTY_RESERVATION"
       WHERE requirement_id = $1
          OR (',' || COALESCE(requirement_id, '') || ',') LIKE '%,' || $1 || ',%'
       RETURNING id`,
      [rid],
    );
    return result.rows;
  }
}

export default QtyReservationModel;
