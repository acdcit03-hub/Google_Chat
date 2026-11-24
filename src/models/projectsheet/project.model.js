import { pool } from '../../config/db.js';
import {
  parseFinancialYearFilter,
  buildProjectFinancialYearSql,
  getCurrentFinancialYearBounds,
} from '../../utils/financial-year.utils.js';
import { appendScopeCondition, buildAssignedUsersScopeSql } from '../../utils/dataScope.utils.js';

function normalizeAssignUsernames(raw) {
  if (raw == null || raw === '') return [];
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x).trim()).filter(Boolean);
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed.map((x) => String(x).trim()).filter(Boolean);
        }
      } catch {
        /* fall through */
      }
    }
    return trimmed.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

/** True for `current-year` / `current`, or the calendar current FY code (e.g. 2026-27). */
function isCurrentFinancialYearSelection(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s || s === 'all') return false;
  if (s === 'current-year' || s === 'current') return true;
  const bounds = getCurrentFinancialYearBounds();
  const code = String(bounds.yearCode || '').trim().toLowerCase();
  return Boolean(code) && s === code;
}

class ProjectModel {
  /** Normalize assigned usernames into assigned_users_display string. */
  static resolveAssignedUsers(input = {}) {
    const names = normalizeAssignUsernames(
      input.assigned_users_display ?? input.assignedUsersDisplay,
    );
    return {
      assignedUsersDisplay: names.join(', '),
    };
  }

  /**
   * Returns the next project serial number (3-digit string) for the CURRENT financial year.
   * Financial year is Apr->Mar. New FY resets serial back to 001.
   *
   * Uses `serial_no` when present; otherwise falls back to first 3 digits of `project_code`.
   * This is intentionally NOT scoped to any user (global across all users).
   */
  static async getNextSerialNo() {
    const now = new Date();
    const month = now.getMonth() + 1; // 1-12
    const year = now.getFullYear();
    const fyStartYear = month >= 4 ? year : (year - 1);

    const result = await pool.query(`
      WITH candidates AS (
        SELECT
          p.project_code,
          CASE
            WHEN p.serial_no IS NOT NULL AND TRIM(p.serial_no) ~ '^[0-9]{1,10}$'
              THEN CAST(TRIM(p.serial_no) AS INTEGER)
            WHEN p.project_code IS NOT NULL AND SUBSTRING(p.project_code FROM 1 FOR 3) ~ '^[0-9]{3}$'
              THEN CAST(SUBSTRING(p.project_code FROM 1 FOR 3) AS INTEGER)
            ELSE NULL
          END AS serial_int
        FROM "PROJECT" p
      )
      SELECT COALESCE(MAX(serial_int), 0) AS max_serial
      FROM candidates
      WHERE serial_int IS NOT NULL
        AND (
          -- Prefer deriving FY from last 4 chars of project_code (MMYY)
          (
            LENGTH(project_code) >= 4
            AND RIGHT(project_code, 4) ~ '^[0-9]{4}$'
            AND (
              CASE
                WHEN CAST(SUBSTRING(RIGHT(project_code, 4) FROM 1 FOR 2) AS INTEGER) >= 4
                  THEN 2000 + CAST(SUBSTRING(RIGHT(project_code, 4) FROM 3 FOR 2) AS INTEGER)
                ELSE 1999 + CAST(SUBSTRING(RIGHT(project_code, 4) FROM 3 FOR 2) AS INTEGER)
              END
            ) = $1
          )
          OR
          -- If project_code can't be parsed, still include the row (legacy data)
          NOT (LENGTH(project_code) >= 4 AND RIGHT(project_code, 4) ~ '^[0-9]{4}$')
        )
    `, [fyStartYear]);

    const maxSerial = parseInt(result.rows?.[0]?.max_serial ?? 0, 10) || 0;
    const next = maxSerial + 1;
    return String(next).padStart(3, '0');
  }

  static async serialNoExistsForCurrentFY(serialNo) {
    if (serialNo == null) return false;
    const s = String(serialNo).trim();
    if (!s) return false;
    const now = new Date();
    const month = now.getMonth() + 1; // 1-12
    const year = now.getFullYear();
    const fyStartYear = month >= 4 ? year : (year - 1);

    const result = await pool.query(`
      SELECT 1
      FROM "PROJECT" p
      WHERE TRIM(p.serial_no) = $1
        AND (
          (
            LENGTH(p.project_code) >= 4
            AND RIGHT(p.project_code, 4) ~ '^[0-9]{4}$'
            AND (
              CASE
                WHEN CAST(SUBSTRING(RIGHT(p.project_code, 4) FROM 1 FOR 2) AS INTEGER) >= 4
                  THEN 2000 + CAST(SUBSTRING(RIGHT(p.project_code, 4) FROM 3 FOR 2) AS INTEGER)
                ELSE 1999 + CAST(SUBSTRING(RIGHT(p.project_code, 4) FROM 3 FOR 2) AS INTEGER)
              END
            ) = $2
          )
          OR
          NOT (LENGTH(p.project_code) >= 4 AND RIGHT(p.project_code, 4) ~ '^[0-9]{4}$')
        )
      LIMIT 1
    `, [s, fyStartYear]);
    return result.rowCount > 0;
  }

  /**
   * Normalize project serial to a 3-digit string (e.g. 1 -> 001).
   * Returns null for empty, dash, or non-numeric input.
   */
  static normalizeSerialNo(serialNo) {
    if (serialNo == null) return null;
    const raw = String(serialNo).trim();
    if (!raw || raw === '-') return null;

    const digits = raw.replace(/\D/g, '');
    if (!digits) return null;

    return digits.padStart(3, '0').slice(-3);
  }

  /**
   * Next version for category + client + sub_code (e.g. V01, V02).
   * Matches existing projects on category, client_code, and sub_code.
   */
  static async getNextVersion(category, clientCode, subCode) {
    const cat = String(category ?? '').trim().toUpperCase();
    const client = String(clientCode ?? '').trim().toUpperCase();
    const sub = String(subCode ?? '').trim().toUpperCase();

    if (!cat || !client || !sub) {
      return 'V01';
    }

    const result = await pool.query(
      `
      SELECT version, project_code
      FROM "PROJECT"
      WHERE TRIM(UPPER(COALESCE(category, ''))) = $1
        AND TRIM(UPPER(COALESCE(client_code, ''))) = $2
        AND TRIM(UPPER(COALESCE(sub_code, ''))) = $3
      `,
      [cat, client, sub],
    );

    let maxNum = 0;

    const bumpFromVersionString = (raw) => {
      const value = String(raw ?? '').trim().toUpperCase();
      if (!value) return;

      const direct = value.match(/^V?(\d{1,3})$/);
      if (direct) {
        maxNum = Math.max(maxNum, parseInt(direct[1], 10) || 0);
        return;
      }

      const embedded = value.match(/V(\d{1,3})/);
      if (embedded) {
        maxNum = Math.max(maxNum, parseInt(embedded[1], 10) || 0);
      }
    };

    for (const row of result.rows) {
      bumpFromVersionString(row.version);

      const code = String(row.project_code ?? '').trim().toUpperCase();
      // serial(3)+cat(1)+client(3)+sub(3)+version(3)+mm(2)+yy(2) => version at 10-12
      if (code.length >= 13) {
        bumpFromVersionString(code.substring(10, 13));
      }
    }

    const next = maxNum + 1;
    return `V${String(next).padStart(2, '0')}`;
  }

  /**
   * Whitelist GET /api/projects query filters (backend-side).
   * Supports camelCase and snake_case for most keys.
   *
   * Existing: status (comma list), all, financialYear|financial_year (current-year|2025-26),
   *   user_id, username, full_name, month, year (exact MM / YY on PROJECT columns),
  
   *   inquiryDate|inquiry_date, targetDate|target_date, startDate|start_date, endDate|end_date,
   *   category, priority, limit, offset, page
   *
   * Added: id, serial_no|serialNo, sub_code|subCode, version, drive_link|driveLink,

   *   client_code (CLIENT.client_code ILIKE), work_hour|workHour, net_time|netTime,
   *   hold_reason|holdReason, 
   *   target_hour|targetHour (eq), target_hour_min/max, per_day_hour|perDayHour (eq),
   *   overall_completion_min|overallCompletionMin, overall_completion_max|overallCompletionMax,
   *   inquiry_date_from/to, target_date_from/to, start_date_from/to, end_date_from/to,
   *   hold_date_from/to, hold_date|holdDate (single YYYY-MM-DD), created_at_from/to (timestamps)
   *
   * Pagination: default page size 10. Use all=true for up to 10000 rows.
   * Use paginate=false (or pagination=false) to return ALL matching rows (no SQL LIMIT/OFFSET).
   */
  static async findAll(filters = {}) {
    const pick = (...keys) => {
      for (const k of keys) {
        const v = filters[k];
        if (v === undefined || v === null) continue;
        const s = String(v).trim();
        if (s !== '' && s.toLowerCase() !== 'all') return s;
      }
      return '';
    };

    const paginateOff = (v) =>
      v === false || ['false', '0', 'no'].includes(String(v ?? '').trim().toLowerCase());
    const paginate = paginateOff(filters.paginate)
      ? false
      : paginateOff(filters.pagination)
        ? false
        : true;

    const limit = !paginate
      ? null
      : filters.all === 'true'
        ? 10000
        : Math.min(10000, Math.max(1, parseInt(filters.limit, 10) || 10));
    const offsetRaw = filters.offset;
    const page = Math.max(1, parseInt(filters.page, 10) || 1);
    const offsetParsed = offsetRaw != null && offsetRaw !== '' ? parseInt(offsetRaw, 10) : NaN;
    const actualOffset =
      !paginate || limit == null
        ? 0
        : !Number.isNaN(offsetParsed) && offsetParsed >= 0
          ? offsetParsed
          : (page - 1) * limit;

    const conditions = [];
    const baseParams = [];
    const pushILike = (sqlExpr, raw) => {
      const s = String(raw).trim();
      if (!s) return;
      conditions.push(`${sqlExpr} ILIKE $${baseParams.length + 1}`);
      baseParams.push(`%${s}%`);
    };
    const pushEqTrim = (col, raw) => {
      const s = String(raw).trim();
      if (!s) return;
      conditions.push(`TRIM(p.${col}) = TRIM($${baseParams.length + 1})`);
      baseParams.push(s);
    };

    const varcharDateExpr = (col) => `(
      CASE
        WHEN p.${col} IS NULL OR TRIM(p.${col}::text) = '' THEN NULL::date
        WHEN TRIM(p.${col}::text) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN to_date(TRIM(p.${col}::text), 'YYYY-MM-DD')
        WHEN TRIM(p.${col}::text) ~ '^[0-9]{2}-[0-9]{2}-[0-9]{4}$' THEN to_date(TRIM(p.${col}::text), 'DD-MM-YYYY')
        ELSE NULL::date
      END
    )`;

    const addDateRange = (col, fromVal, toVal) => {
      const from = fromVal && String(fromVal).trim();
      const to = toVal && String(toVal).trim();
      if (!from && !to) return;
      const expr = varcharDateExpr(col);
      if (from) {
        conditions.push(`${expr} >= $${baseParams.length + 1}::date`);
        baseParams.push(from);
      }
      if (to) {
        conditions.push(`${expr} <= $${baseParams.length + 1}::date`);
        baseParams.push(to);
      }
    };

    const status = pick('status');
    if (status) {
      if (status.includes(',')) {
        const statuses = status.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
        if (statuses.length) {
          const placeholders = statuses.map((_, i) => `$${baseParams.length + i + 1}`).join(', ');
          conditions.push(`LOWER(p.status) IN (${placeholders})`);
          baseParams.push(...statuses);
        }
      } else {
        conditions.push(`LOWER(p.status) = LOWER($${baseParams.length + 1})`);
        baseParams.push(status);
      }
    }

    const projectName = pick('projectName', 'project_name');
    if (projectName) pushILike('LOWER(p.project_name)', projectName.toLowerCase());

    const projectCode = pick('projectCode', 'project_code');
    if (projectCode) pushILike('LOWER(p.project_code)', projectCode.toLowerCase());

   

    // Legacy single-day filters (YYYY-MM-DD recommended)
    const inquiryDate = pick('inquiryDate', 'inquiry_date');
    if (inquiryDate && !pick('inquiry_date_from', 'inquiryDateFrom') && !pick('inquiry_date_to', 'inquiryDateTo')) {
      conditions.push(`${varcharDateExpr('inquiry_date')} = $${baseParams.length + 1}::date`);
      baseParams.push(inquiryDate);
    }
    const targetDate = pick('targetDate', 'target_date');
    if (targetDate && !pick('target_date_from', 'targetDateFrom') && !pick('target_date_to', 'targetDateTo')) {
      conditions.push(`${varcharDateExpr('target_date')} = $${baseParams.length + 1}::date`);
      baseParams.push(targetDate);
    }
    const startDate = pick('startDate', 'start_date');
    if (startDate && !pick('start_date_from', 'startDateFrom') && !pick('start_date_to', 'startDateTo')) {
      conditions.push(`${varcharDateExpr('start_date')} = $${baseParams.length + 1}::date`);
      baseParams.push(startDate);
    }
    const endDate = pick('endDate', 'end_date');
    if (endDate && !pick('end_date_from', 'endDateFrom') && !pick('end_date_to', 'endDateTo')) {
      conditions.push(`${varcharDateExpr('end_date')} = $${baseParams.length + 1}::date`);
      baseParams.push(endDate);
    }

    addDateRange('inquiry_date', pick('inquiry_date_from', 'inquiryDateFrom'), pick('inquiry_date_to', 'inquiryDateTo'));
    addDateRange('target_date', pick('target_date_from', 'targetDateFrom'), pick('target_date_to', 'targetDateTo'));
    addDateRange('start_date', pick('start_date_from', 'startDateFrom'), pick('start_date_to', 'startDateTo'));
    addDateRange('end_date', pick('end_date_from', 'endDateFrom'), pick('end_date_to', 'endDateTo'));
    addDateRange('hold_date', pick('hold_date_from', 'holdDateFrom'), pick('hold_date_to', 'holdDateTo'));

    const holdDateSingle = pick('holdDate', 'hold_date');
    if (holdDateSingle && !pick('hold_date_from', 'holdDateFrom')) {
      conditions.push(`${varcharDateExpr('hold_date')} = $${baseParams.length + 1}::date`);
      baseParams.push(holdDateSingle);
    }

    const category = pick('category');
    if (category) pushILike('LOWER(p.category)', category.toLowerCase());

    const priority = pick('priority');
    if (priority) {
      conditions.push(`LOWER(p.priority) = LOWER($${baseParams.length + 1})`);
      baseParams.push(priority);
    }

    const username = pick(
      'username',
      'assign_username',
      'assignUsername',
      'assigned_users_display',
      'assignedUsersDisplay',
    );
    const full_name = pick('full_name', 'fullName');
    if (username || full_name) {
      const userConditions = [];
      if (username) {
        const usernames = String(username)
          .split(/[,|]/)
          .map((u) => u.trim().toLowerCase())
          .filter(Boolean);
        const assignedSql = buildAssignedUsersScopeSql(
          'p.assigned_users_display',
          usernames,
          baseParams,
        );
        if (assignedSql) userConditions.push(assignedSql);
      }
      if (full_name) {
        userConditions.push(`LOWER(TRIM(p.assigned_users_display)) LIKE LOWER(TRIM($${baseParams.length + 1}))`);
        baseParams.push(`%${full_name}%`);
      }
      if (userConditions.length) {
        conditions.push(`(${userConditions.join(' OR ')})`);
      }
    }

    // FY filter (Apr–Mar) via MMYY on month/year (e.g. 2026-27 → 0426..0327).
    // current-year: ALL projects in current FY + Running projects from older FYs.
    // Specific year (e.g. 2025-26): strict FY match only.
    // Results always ORDER BY p.id DESC.
    const financialYearRaw = String(
      filters.financialYear ?? filters.financial_year ?? '',
    ).trim();
    const financialYear =
      financialYearRaw && financialYearRaw.toLowerCase() !== 'all'
        ? financialYearRaw
        : '';
    if (financialYear) {
      const isCurrentYearMode = isCurrentFinancialYearSelection(financialYear);
      const fy = parseFinancialYearFilter(financialYear);
      if (fy) {
        const startIdx = baseParams.length + 1;
        const endIdx = baseParams.length + 2;
        baseParams.push(fy.startYearShort, fy.endYearShort);
        const fySql = buildProjectFinancialYearSql(startIdx, endIdx);
        if (isCurrentYearMode) {
          conditions.push(`(
            (${fySql})
            OR (
              LOWER(TRIM(COALESCE(p.status, ''))) LIKE '%running%'
              AND NOT (${fySql})
            )
          )`);
        } else {
          conditions.push(fySql);
        }
      }
    }

    const id = pick('id');
    if (id && /^\d+$/.test(id)) {
      conditions.push(`p.id = $${baseParams.length + 1}`);
      baseParams.push(parseInt(id, 10));
    }

    const serialNo = pick('serial_no', 'serialNo');
    if (serialNo) pushILike('LOWER(p.serial_no::text)', serialNo.toLowerCase());

    pushILike('LOWER(p.sub_code::text)', pick('sub_code', 'subCode').toLowerCase());
    pushILike('LOWER(p.version::text)', pick('version').toLowerCase());
    pushILike(
      'LOWER(COALESCE(p.filemanager_link, p.drive_link)::text)',
      pick(
        'filemanager_link',
        'filemanagerLink',
        'drive_link',
        'driveLink',
        'link',
      ).toLowerCase(),
    );
    pushILike('LOWER(p.documentation::text)', pick('documentation').toLowerCase());
    pushILike('LOWER(p.group_link::text)', pick('group_link', 'groupLink').toLowerCase());
    pushILike('LOWER(p.created_by::text)', pick('created_by', 'createdBy').toLowerCase());

    pushILike('LOWER(p.hold_reason::text)', pick('hold_reason', 'holdReason').toLowerCase());
    pushILike('LOWER(p.work_hour::text)', pick('work_hour', 'workHour').toLowerCase());
    pushILike('LOWER(p.net_time::text)', pick('net_time', 'netTime').toLowerCase());

    const month = pick('month');
    if (month) pushEqTrim('month', month);
    const year = pick('year');
    if (year) pushEqTrim('year', year);

    const companyName = pick('company_name', 'companyName');
    if (companyName) pushILike('LOWER(c.company_name::text)', companyName.toLowerCase());

    const clientCode = pick('client_code', 'clientCode');
    if (clientCode) pushILike('LOWER(c.client_code::text)', clientCode.toLowerCase());

    const targetHour = pick('target_hour', 'targetHour');
    if (targetHour && !Number.isNaN(parseFloat(targetHour))) {
      conditions.push(`p.target_hour = $${baseParams.length + 1}`);
      baseParams.push(parseFloat(targetHour));
    }
    const thMin = pick('target_hour_min', 'targetHourMin');
    const thMax = pick('target_hour_max', 'targetHourMax');
    if (thMin && !Number.isNaN(parseFloat(thMin))) {
      conditions.push(`p.target_hour >= $${baseParams.length + 1}`);
      baseParams.push(parseFloat(thMin));
    }
    if (thMax && !Number.isNaN(parseFloat(thMax))) {
      conditions.push(`p.target_hour <= $${baseParams.length + 1}`);
      baseParams.push(parseFloat(thMax));
    }

    const perDayHour = pick('per_day_hour', 'perDayHour');
    if (perDayHour && !Number.isNaN(parseFloat(perDayHour))) {
      conditions.push(`p.per_day_hour = $${baseParams.length + 1}`);
      baseParams.push(parseFloat(perDayHour));
    }

    const ocMin = pick('overall_completion_min', 'overallCompletionMin');
    const ocMax = pick('overall_completion_max', 'overallCompletionMax');
    if (ocMin && !Number.isNaN(parseFloat(ocMin))) {
      conditions.push(`COALESCE(p.overall_completion, 0) >= $${baseParams.length + 1}`);
      baseParams.push(parseFloat(ocMin));
    }
    if (ocMax && !Number.isNaN(parseFloat(ocMax))) {
      conditions.push(`COALESCE(p.overall_completion, 0) <= $${baseParams.length + 1}`);
      baseParams.push(parseFloat(ocMax));
    }

    const createdFrom = pick('created_at_from', 'createdAtFrom');
    const createdTo = pick('created_at_to', 'createdAtTo');
    if (createdFrom) {
      conditions.push(`p.created_at >= $${baseParams.length + 1}::timestamptz`);
      baseParams.push(createdFrom);
    }
    if (createdTo) {
      conditions.push(`p.created_at <= $${baseParams.length + 1}::timestamptz`);
      baseParams.push(createdTo);
    }

    const fromClause = `FROM "PROJECT" p LEFT JOIN "CLIENT" c ON p.client_code = c.client_code`;
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const dataSql = `
        SELECT 
          p.*, 
          c.client_code as client_code,
          c.company_name as company_name
        ${fromClause}
        ${whereClause}
        ORDER BY p.id DESC
        ${paginate && limit != null ? `LIMIT $${baseParams.length + 1} OFFSET $${baseParams.length + 2}` : ''}
      `;
    const dataParams =
      paginate && limit != null ? [...baseParams, limit, actualOffset] : [...baseParams];

    const [countResult, dataResult] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int as total ${fromClause} ${whereClause}`, baseParams),
      pool.query(dataSql, dataParams),
    ]);

    return {
      projects: dataResult.rows,
      total: parseInt(countResult.rows[0].total, 10),
      limit: paginate ? limit : null,
      offset: actualOffset,
      page,
      noPagination: !paginate,
    };
  }

  static async findById(id) {
    const result = await pool.query(`
      SELECT p.*,
             c.company_name as company_name,
             c.client_logo as client_logo,
             c.client_firstname as client_firstname,
             c.client_middlename as client_middlename,
             c.client_lastname as client_lastname,
             c.client_mobile_no as client_mobile_no,
             c.email_id as client_email,
             c.location as client_location,
             c.gst_code as client_gst,
             c.bill_location as client_bill_location,
             c.sheet_map_location as client_map_location,
             c.sec_name as sec_name,
             c.sec_mobile as sec_mobile,
             c.sec_email as sec_email,
             c.id as client_table_id
      FROM "PROJECT" p
      LEFT JOIN "CLIENT" c ON TRIM(UPPER(p.client_code)) = TRIM(UPPER(c.client_code))
      WHERE p.id = $1
    `, [id]);
    return result.rows[0];
  }

  static async findByCodeForDuplicate(code, excludeId = null) {
    let query = 'SELECT id FROM "PROJECT" WHERE project_code = $1';
    let params = [code];
    if (excludeId) {
      query += ' AND id != $2';
      params.push(excludeId);
    }
    const result = await pool.query(query, params);
    return result.rows[0] || null;
  }

  static async findClientByCode(clientCode) {
    const result = await pool.query('SELECT id, client_code FROM "CLIENT" WHERE client_code = $1', [clientCode]);
    return result.rows[0] || null;
  }

  static async findClientById(clientId) {
    const result = await pool.query('SELECT client_code FROM "CLIENT" WHERE id = $1', [clientId]);
    return result.rows[0] || null;
  }

  static async findByCode(code) {
    const result = await pool.query('SELECT * FROM "PROJECT" WHERE project_code = $1', [code]);
    return result.rows[0];
  }

  static async create(projectData) {
    const {
      projectName, projectCode, serialNo, clientCode,
      assignedUsersDisplay, inquiryDate, targetDate,
      startDate, endDate, workHour, netTime, status,
      driveLink, groupLink, category, subCode, version, targetHour,
      perDayHour, month, year, priority, projectPhoto, createdBy,
      processIds,
    } = projectData;

    const processIdsJson = JSON.stringify(
      Array.isArray(processIds)
        ? processIds.map((id) => Number(id)).filter((id) => Number.isInteger(id))
        : [],
    );

    const result = await pool.query(`
      INSERT INTO "PROJECT"(
        project_name, project_code, serial_no, client_code,
        assigned_users_display, inquiry_date, target_date, start_date, end_date, work_hour, net_time, status,
        drive_link, group_link, category, sub_code, version, target_hour,
        per_day_hour, month, year, priority, project_photo, created_by, process_ids
      ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25::jsonb)
      RETURNING *
    `, [
      projectName, projectCode, serialNo, clientCode,
      assignedUsersDisplay || null,
      inquiryDate, targetDate, startDate, endDate,
      workHour || '0h', netTime || '0h', status || 'In Planning',
      driveLink, groupLink, category, subCode, version, targetHour || 0,
      perDayHour || 8, month, year, priority || '3', projectPhoto, createdBy,
      processIdsJson,
    ]);
    return result.rows[0];
  }

  /**
   * Store File Manager project-folder link on PROJECT.filemanager_link.
   * Does not change drive_link (manual Google Drive URL).
   */
  static async updateProjectFolderLink(id, folderLink) {
    return ProjectModel.updateFileManagerLink(id, folderLink);
  }

  /** Store only PROJECT.filemanager_link (does not change drive_link). */
  static async updateFileManagerLink(id, filemanagerLink) {
    const pid = parseInt(id, 10);
    if (!Number.isFinite(pid) || pid <= 0) return null;

    const url = String(filemanagerLink ?? '').trim();
    if (!url) return null;

    const result = await pool.query(
      `UPDATE "PROJECT"
       SET filemanager_link = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING *`,
      [url, pid],
    );
    return result.rows[0] || null;
  }

  static async updateDriveLink(id, driveLink) {
    const pid = parseInt(id, 10);
    if (!Number.isFinite(pid) || pid <= 0) return null;

    const url = String(driveLink ?? '').trim();
    if (!url) return null;

    const result = await pool.query(
      `UPDATE "PROJECT"
       SET drive_link = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING *`,
      [url, pid],
    );
    return result.rows[0] || null;
  }

  // Optimized: Dynamic update with parallel calculations
  static async update(id, updates, values) {
    if (updates.length === 0) {
      return null;
    }

    const query = `UPDATE "PROJECT" SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${values.length} RETURNING *`;
    const result = await pool.query(query, values);
    return result.rows[0];
  }

  static async delete(id) {
    const result = await pool.query('DELETE FROM "PROJECT" WHERE id = $1 RETURNING id', [id]);
    return result.rows[0];
  }

  /** Count projects grouped by status (canonical buckets + raw breakdown). */
  static async getStats(filters = {}) {
    const classifyStatus = (rawStatus) => {
      const s = String(rawStatus ?? '').trim().toLowerCase();
      if (!s) return 'other';
      if (s.includes('in planning')) return 'inPlanning';
      if (s.includes('on hold')) return 'onHold';
      if (s.includes('stopped')) return 'stopped';
      if (s.includes('completed')) return 'completed';
      if (s.includes('running')) return 'running';
      return 'other';
    };

    const conditions = [];
    const params = [];
    const financialYear = String(
      filters.financialYear ?? filters.financial_year ?? '',
    ).trim();
    if (financialYear && financialYear.toLowerCase() !== 'all') {
      const isCurrentYearMode = ['current-year', 'current'].includes(
        financialYear.toLowerCase(),
      );
      const fy = parseFinancialYearFilter(financialYear);
      if (fy) {
        params.push(fy.startYearShort, fy.endYearShort);
        const fySql = buildProjectFinancialYearSql(1, 2);
        if (isCurrentYearMode) {
          conditions.push(`(
            (${fySql})
            OR (
              LOWER(TRIM(COALESCE(p.status, ''))) LIKE '%running%'
              AND NOT (${fySql})
            )
          )`);
        } else {
          conditions.push(fySql);
        }
      }
    }

    appendScopeCondition(conditions, params, {
      scopeUsernames: filters.scopeUsernames,
      mode: 'assigned_or_created',
      columnExpr: 'p.assigned_users_display',
      createdByColumnExpr: 'p.created_by',
    });

    const pick = (...keys) => {
      for (const k of keys) {
        const v = filters[k];
        if (v === undefined || v === null) continue;
        const s = String(v).trim();
        if (s !== '' && s.toLowerCase() !== 'all') return s;
      }
      return '';
    };

    const pushILike = (sqlExpr, raw) => {
      const s = String(raw).trim();
      if (!s) return;
      conditions.push(`${sqlExpr} ILIKE $${params.length + 1}`);
      params.push(`%${s}%`);
    };

    const varcharDateExpr = (col) => `(
      CASE
        WHEN p.${col} IS NULL OR TRIM(p.${col}::text) = '' THEN NULL::date
        WHEN TRIM(p.${col}::text) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN to_date(TRIM(p.${col}::text), 'YYYY-MM-DD')
        WHEN TRIM(p.${col}::text) ~ '^[0-9]{2}-[0-9]{2}-[0-9]{4}$' THEN to_date(TRIM(p.${col}::text), 'DD-MM-YYYY')
        ELSE NULL::date
      END
    )`;

    const addDateRange = (col, fromVal, toVal) => {
      const from = fromVal && String(fromVal).trim();
      const to = toVal && String(toVal).trim();
      if (!from && !to) return;
      const expr = varcharDateExpr(col);
      if (from) {
        conditions.push(`${expr} >= $${params.length + 1}::date`);
        params.push(from);
      }
      if (to) {
        conditions.push(`${expr} <= $${params.length + 1}::date`);
        params.push(to);
      }
    };

    const projectName = pick('projectName', 'project_name');
    if (projectName) pushILike('LOWER(p.project_name)', projectName.toLowerCase());

    const projectCode = pick('projectCode', 'project_code');
    if (projectCode) pushILike('LOWER(p.project_code)', projectCode.toLowerCase());

    addDateRange('inquiry_date', pick('inquiry_date_from', 'inquiryDateFrom'), pick('inquiry_date_to', 'inquiryDateTo'));
    addDateRange('target_date', pick('target_date_from', 'targetDateFrom'), pick('target_date_to', 'targetDateTo'));
    addDateRange('start_date', pick('start_date_from', 'startDateFrom'), pick('start_date_to', 'startDateTo'));
    addDateRange('end_date', pick('end_date_from', 'endDateFrom'), pick('end_date_to', 'endDateTo'));

    // Assigned-user column filter — do not use `username` (that's Me/Department scope).
    const assignedUsers = pick(
      'assigned_users_display',
      'assignedUsersDisplay',
      'assign_username',
      'assignUsername',
    );
    if (assignedUsers) {
      const usernames = String(assignedUsers)
        .split(/[,|]/)
        .map((u) => u.trim().toLowerCase())
        .filter(Boolean);
      const assignedSql = buildAssignedUsersScopeSql(
        'p.assigned_users_display',
        usernames,
        params,
      );
      if (assignedSql) conditions.push(assignedSql);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const [summaryResult, byStatusResult] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS total FROM "PROJECT" p ${whereClause}`,
        params,
      ),
      pool.query(
        `
        SELECT TRIM(COALESCE(p.status, '')) AS status, COUNT(*)::int AS count
        FROM "PROJECT" p
        ${whereClause}
        GROUP BY TRIM(COALESCE(p.status, ''))
        ORDER BY count DESC, status ASC
      `,
        params,
      ),
    ]);

    const buckets = {
      inPlanning: 0,
      running: 0,
      onHold: 0,
      completed: 0,
      stopped: 0,
      other: 0,
    };

    const byStatus = byStatusResult.rows.map((row) => {
      const status = String(row.status ?? '').trim();
      const count = Number(row.count) || 0;
      const bucket = classifyStatus(status);
      buckets[bucket] += count;
      return {
        status: status || '—',
        count,
        bucket,
      };
    });

    return {
      total: Number(summaryResult.rows[0]?.total) || 0,
      ...buckets,
      byStatus,
    };
  }
}

export default ProjectModel;
