import { pool } from '../../config/db.js';
import { triggerRecalculate } from '../../utils/time.utils.js';
import TaskModel from './task.model.js';

/** Keep tasks.duration (total worked time) in sync; never lets a failure break the timesheet save. */
async function syncTaskDuration(...taskIds) {
    for (const id of new Set(taskIds.filter((v) => v != null && v !== ''))) {
        try {
            await TaskModel.recalculateDuration(id);
        } catch (err) {
            console.error('Task duration sync failed:', err.message);
        }
    }
}

import { timeToSeconds, formatDurationHMS } from '../../utils/time.utils.js';
// SQL expression that normalizes TIMESHEET.date to a DATE (handles dd-mm-yyyy, dd-mm-yy, yyyy-mm-dd); fallback created_at
const DATE_COL_AS_DATE = `COALESCE(
    CASE
        WHEN t."date" IS NOT NULL AND trim(t."date"::text) ~ '^\\d{1,2}-\\d{1,2}-\\d{4}$' THEN to_date(trim(t."date"::text), 'DD-MM-YYYY')
        WHEN t."date" IS NOT NULL AND trim(t."date"::text) ~ '^\\d{1,2}-\\d{1,2}-\\d{2}$' THEN to_date(trim(t."date"::text), 'DD-MM-YY')
        WHEN t."date" IS NOT NULL AND trim(t."date"::text) ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN (t."date"::text)::date
        ELSE NULL
    END,
    DATE(t.created_at)
)`;

function appendUsernameFilter(conditions, params, rawUser) {
    const raw = String(rawUser || '').trim();
    if (!raw) return;
    const parts = raw.includes('|')
        ? raw.split('|').map((x) => x.trim()).filter(Boolean)
        : [raw];
    const patterns = parts.map((p) => `%${p}%`);
    params.push(patterns);
    conditions.push(
        `COALESCE(NULLIF(TRIM(t.user_name), ''), pd.username) ILIKE ANY($${params.length})`,
    );
}

// Add near the top of the file, next to DATE_COL_AS_DATE
function normalizeDateParamToISO(value) {
    const s = String(value ?? '').trim();
    if (!s) return null;

    // DD-MM-YYYY
    let m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
    if (m) {
        const [, d, mo, y] = m;
        return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }

    // DD-MM-YY
    m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{2})$/);
    if (m) {
        const [, d, mo, y] = m;
        return `${2000 + parseInt(y, 10)}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }

    // Already YYYY-MM-DD
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return s;

    return null; // unrecognized format — let caller decide
}

class TimesheetModel {
    /** Ensure TIMESHEET can link rows to tasks (id + serial_number). */
    static async ensureTaskLinkColumns() {
        await pool.query(`
            ALTER TABLE "TIMESHEET" ADD COLUMN IF NOT EXISTS task_id INTEGER;
            ALTER TABLE "TIMESHEET" ADD COLUMN IF NOT EXISTS task_serial_number VARCHAR(50);

            CREATE INDEX IF NOT EXISTS idx_timesheet_task_id ON "TIMESHEET"(task_id);
            CREATE INDEX IF NOT EXISTS idx_timesheet_task_serial_number ON "TIMESHEET"(task_serial_number);
        `);
    }

    static async findAll(filters = {}) {
        const {
            userId, projectCode, date, dateStart, dateEnd, today, type, project,
            process, startTime, stopTime, duration, projectBy, notes, user,
            taskId, task_id, taskSerialNumber, task_serial_number,
            page, limit, sortOrder
        } = filters;

        // Normalize date for API: support DD-MM-YYYY / DD-MM-YY / YYYY-MM-DD; fallback created_at.
        // Do not select only YYYY-MM-DD — live DB often stores DD-MM-YYYY (see toDDMMYYYY), which made date null.
        let query = `SELECT t.*,
            COALESCE(NULLIF(TRIM(t.user_name), ''), pd.username) AS user_name,
            (${DATE_COL_AS_DATE})::text AS date
            FROM "TIMESHEET" t LEFT JOIN personal_details pd ON t.user_id = pd.id`;
        let countQuery = 'SELECT COUNT(*) as count FROM "TIMESHEET" t';
        let countQueryJoin = ''; // Track if we need to add JOIN to count query
        let params = [];
        let conditions = [];

        const userFilter = user || userId;

        if (projectCode) {
            params.push(projectCode.trim());
            conditions.push(`TRIM(UPPER(t.project_code)) = TRIM(UPPER($${params.length}))`);
        }

        if (today === 'true') {
            conditions.push(`(${DATE_COL_AS_DATE}) = CURRENT_DATE`);
        }

        if (date) {
            const isoDate = this.toISODate(date) || String(date).trim();
            params.push(isoDate);
            conditions.push(`(${DATE_COL_AS_DATE}) = $${params.length}::date`);
        }

        // Date range: only start → from start to latest; only end → from earliest to end; both → between inclusive
        if (dateStart) {
            const isoStart = this.toISODate(dateStart) || String(dateStart).trim();
            params.push(isoStart);
            conditions.push(`(${DATE_COL_AS_DATE}) >= $${params.length}::date`);
        }
        if (dateEnd) {
            const isoEnd = this.toISODate(dateEnd) || String(dateEnd).trim();
            params.push(isoEnd);
            conditions.push(`(${DATE_COL_AS_DATE}) <= $${params.length}::date`);
        }

        if (type) {
            params.push(`%${type}%`);
            conditions.push(`LOWER(t.project_type) ILIKE $${params.length}`);
        }

        if (project) {
            const raw = String(project || '').trim();
            const parts = raw.includes('|')
                ? raw.split('|').map((x) => x.trim()).filter(Boolean)
                : [raw];
            const patterns = parts.map((p) => `%${p.toLowerCase()}%`);
            params.push(patterns);
            conditions.push(`LOWER(t.project_code) ILIKE ANY($${params.length})`);
        }

        if (process) {
            // Support both process ID and process name
            const processIdMatch = process.toString().match(/^\d+$/);
            if (processIdMatch) {
                params.push(parseInt(process));
                conditions.push(`t.process_id = $${params.length}`);
            } else {
                params.push(`%${process}%`);
                conditions.push(`LOWER(t.process_name) ILIKE $${params.length}`);
            }
        }

        // Start time: exact match when HH:MM or HH:MM:SS; only cast when column looks like time to avoid invalid cast
        if (startTime) {
            const isTimeFormat = /^\d{1,2}:\d{2}(:\d{2})?$/.test(String(startTime).trim());
            params.push(isTimeFormat ? String(startTime).trim() : `%${startTime}%`);
            conditions.push(isTimeFormat
                ? `(t.start_time IS NOT NULL AND TRIM(t.start_time) <> '' AND t.start_time ~ '^[0-9]{1,2}:[0-9]{2}(:[0-9]{2})?$' AND t.start_time::time = $${params.length}::time)`
                : `t.start_time::text ILIKE $${params.length}`);
        }

        if (stopTime) {
            if (String(stopTime).toLowerCase() === 'ongoing') {
                conditions.push(`(t.stop_time IS NULL OR t.stop_time = '' OR t.stop_time = 'Ongoing')`);
            } else {
                const isTimeFormat = /^\d{1,2}:\d{2}(:\d{2})?$/.test(String(stopTime).trim());
                params.push(isTimeFormat ? String(stopTime).trim() : `%${stopTime}%`);
                conditions.push(isTimeFormat
                    ? `(t.stop_time IS NOT NULL AND TRIM(t.stop_time) <> '' AND t.stop_time ~ '^[0-9]{1,2}:[0-9]{2}(:[0-9]{2})?$' AND t.stop_time::time = $${params.length}::time)`
                    : `t.stop_time::text ILIKE $${params.length}`);
            }
        }

        // Duration: exact match HH:MM or HH:MM:SS; only cast when column looks like interval to avoid invalid cast
        if (duration && /^\d{1,2}:\d{2}(:\d{2})?$/.test(String(duration).trim())) {
            const d = String(duration).trim();
            params.push(d);
            conditions.push(`(t.duration IS NOT NULL AND TRIM(t.duration) <> '' AND t.duration ~ '^[0-9]{1,2}:[0-9]{2}(:[0-9]{2})?$' AND (TRIM(t.duration)::interval = $${params.length}::interval OR TRIM(t.duration) = $${params.length}))`);
        }

        if (projectBy) {
            const raw = String(projectBy || '').trim();
            const parts = raw.includes('|')
                ? raw.split('|').map((x) => x.trim()).filter(Boolean)
                : [raw];
            const patterns = parts.map((p) => `%${p.toLowerCase()}%`);
            params.push(patterns);
            conditions.push(`LOWER(t.project_by) ILIKE ANY($${params.length})`);
        }

        if (notes) {
            if (notes.toLowerCase() === 'has_notes') {
                conditions.push(`(t.notes IS NOT NULL AND TRIM(t.notes) <> '' AND TRIM(t.notes) <> '-')`);
            } else if (notes.toLowerCase() === 'no_notes') {
                conditions.push(`(t.notes IS NULL OR TRIM(t.notes) = '' OR TRIM(t.notes) = '-')`);
            } else {
                params.push(`%${notes}%`);
                conditions.push(`LOWER(t.notes) ILIKE $${params.length}`);
            }
        }

        const taskIdFilter = taskId ?? task_id;
        if (taskIdFilter != null && String(taskIdFilter).trim() !== '') {
            params.push(parseInt(taskIdFilter, 10));
            conditions.push(`t.task_id = $${params.length}`);
        }

        const taskSerialFilter = taskSerialNumber ?? task_serial_number;
        if (taskSerialFilter != null && String(taskSerialFilter).trim() !== '') {
            params.push(String(taskSerialFilter).trim());
            conditions.push(
                `TRIM(UPPER(t.task_serial_number)) = TRIM(UPPER($${params.length}))`,
            );
        }

        if (userFilter) {
            countQueryJoin = ' LEFT JOIN personal_details pd ON t.user_id = pd.id';
            appendUsernameFilter(conditions, params, userFilter);
        }

        const whereClause = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';

        // Sort date-wise descending (newest first): support dd-mm-yyyy, dd-mm-yy, yyyy-mm-dd
        const direction = sortOrder && sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

        // Sort date-wise: support dd-mm-yyyy, dd-mm-yy, yyyy-mm-dd
        const orderClause = ` ORDER BY COALESCE(
            CASE
                WHEN t."date" IS NOT NULL AND trim(t."date"::text) ~ '^\\d{1,2}-\\d{1,2}-\\d{4}$' THEN to_date(trim(t."date"::text), 'DD-MM-YYYY')
                WHEN t."date" IS NOT NULL AND trim(t."date"::text) ~ '^\\d{1,2}-\\d{1,2}-\\d{2}$' THEN to_date(trim(t."date"::text), 'DD-MM-YY')
                WHEN t."date" IS NOT NULL AND trim(t."date"::text) ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN (t."date"::text)::date
                ELSE NULL
            END,
            DATE(t.created_at)
        ) ${direction} NULLS LAST, CASE WHEN t.start_time IS NOT NULL AND t.start_time::text ~ '^\\d{1,2}:\\d{2}:\\d{2}$' THEN t.start_time::TIME ELSE '00:00:00'::TIME END ${direction} NULLS LAST, t.created_at ${direction}, t.id ${direction}`;

        let dataQuery = query + whereClause + orderClause;

        // Copy params for count query before limit/offset
        const countParams = [...params];

        // Handle pagination
        if (page && limit) {
            const limitNum = parseInt(limit);
            const offset = (parseInt(page) - 1) * limitNum;
            params.push(limitNum, offset);
            dataQuery += ` LIMIT $${params.length - 1} OFFSET $${params.length}`;
        }

        // Optimized: Parallel execution - fetch count and data simultaneously
        const [countResult, dataResult] = await Promise.all([
            pool.query(countQuery + countQueryJoin + whereClause, countParams),
            pool.query(dataQuery, params)
        ]);

        return {
            rows: dataResult.rows,
            totalCount: parseInt(countResult.rows[0].count, 10)
        };
    }

    static async findById(id) {
        const result = await pool.query('SELECT * FROM "TIMESHEET" WHERE id = $1', [id]);
        return result.rows[0];
    }

    /**
     * Normalize any supported date string to YYYY-MM-DD for Postgres `::date` casts.
     * App storage uses DD-MM-YYYY; never rely on `$1::date` with that format (month/day swap).
     */
    static toISODate(value) {
        if (value == null || value === '') return null;
        if (value instanceof Date) {
            if (isNaN(value.getTime())) return null;
            const y = value.getFullYear();
            const m = String(value.getMonth() + 1).padStart(2, '0');
            const d = String(value.getDate()).padStart(2, '0');
            return `${y}-${m}-${d}`;
        }
        const s = String(value).trim();
        if (!s) return null;
        // YYYY-MM-DD (ISO) — check first so month/day are never swapped
        const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
        if (iso) {
            const [, y, m, d] = iso;
            return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
        }
        // DD-MM-YYYY / DD-MM-YY / DD/MM/YYYY
        const dmy = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})$/);
        if (dmy) {
            let y = dmy[3];
            if (y.length === 2) y = `20${y}`;
            return `${y.padStart(4, '0')}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
        }
        try {
            const d = new Date(s);
            if (!isNaN(d.getTime())) {
                return this.toISODate(d);
            }
        } catch (_) {}
        return null;
    }

    /** Convert any date format to dd-mm-yyyy for storage. Returns the string or null. */
    static toDDMMYYYY(value) {
        const iso = this.toISODate(value);
        if (!iso) return null;
        const [y, m, d] = iso.split('-');
        return `${d}-${m}-${y}`;
    }

    static prepareTimesheetData(tData = {}, { allowId = false } = {}) {
        const prepared = {};

        for (const [key, value] of Object.entries(tData || {})) {
            if (value === undefined) continue;
            if (!allowId && key === 'id') continue;
            if (key === 'created_at' || key === 'updated_at') continue;
            prepared[key] = value;
        }

        if (prepared.date != null && prepared.date !== '') {
            const normalized = this.toDDMMYYYY(prepared.date);
            prepared.date = normalized || null;
        }

        if (Object.prototype.hasOwnProperty.call(prepared, 'task_id')) {
            const raw = prepared.task_id;
            if (raw === null || raw === '') {
                prepared.task_id = null;
            } else {
                const parsed = parseInt(raw, 10);
                prepared.task_id = Number.isFinite(parsed) ? parsed : null;
            }
        }

        if (Object.prototype.hasOwnProperty.call(prepared, 'task_serial_number')) {
            const serial = String(prepared.task_serial_number ?? '').trim();
            prepared.task_serial_number = serial || null;
        }

        return prepared;
    }

  

    static async create(tData) {
        const preparedData = this.prepareTimesheetData(tData);

        // Automatically calculate duration if start and stop times are provided
        if (preparedData.start_time && preparedData.stop_time && preparedData.stop_time !== 'Ongoing') {
            const s = timeToSeconds(preparedData.start_time);
            const e = timeToSeconds(preparedData.stop_time);
            if (s !== null && e !== null && e > s) {
                preparedData.duration = formatDurationHMS(e - s);
            }
        }

        const keys = Object.keys(preparedData);
        const columns = keys.map(k => `"${k}"`).join(', ');
        const values = Object.values(preparedData);
        const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
       
        const result = await pool.query(`
      INSERT INTO "TIMESHEET" (${columns})
      VALUES (${placeholders})
      RETURNING *
  `, values);

       
       

        // Trigger background recalculation
        if (result.rows[0].project_code) {
          
            triggerRecalculate(result.rows[0].project_code);
        }

        await syncTaskDuration(result.rows[0].task_id);

        return result.rows[0];
    }

    static async update(id, tData) {
        const preparedData = this.prepareTimesheetData(tData);
        if (
            (Object.prototype.hasOwnProperty.call(preparedData, 'start_time') ||
                Object.prototype.hasOwnProperty.call(preparedData, 'stop_time')) &&
            !Object.prototype.hasOwnProperty.call(preparedData, 'duration')
        ) {

            const currentRow = await this.findById(id);
            const effectiveStart =
                preparedData.start_time !== undefined
                    ? preparedData.start_time
                    : currentRow?.start_time;
            const effectiveStop =
                preparedData.stop_time !== undefined
                    ? preparedData.stop_time
                    : currentRow?.stop_time;

            const s = timeToSeconds(effectiveStart);
            const e = timeToSeconds(effectiveStop);
            if (s !== null && e !== null && e > s) {
                preparedData.duration = formatDurationHMS(e - s);
            }
        }

        const keys = Object.keys(preparedData);
        if (keys.length === 0) return null;

        // If the entry is moved to another task, both tasks need their total refreshed.
        let previousTaskId = null;
        if (Object.prototype.hasOwnProperty.call(preparedData, 'task_id')) {
            previousTaskId = (await this.findById(id))?.task_id ?? null;
        }

        const setClause = keys.map((key, i) => `"${key}" = $${i + 1}`).join(', ');
        const params = keys.map(key => preparedData[key]);
        params.push(id);

        const query = `
      UPDATE "TIMESHEET" 
      SET ${setClause}, updated_at = CURRENT_TIMESTAMP 
      WHERE id = $${params.length} 
      RETURNING *
    `;

        let result = await pool.query(query, params);

        if (result.rows.length === 0) return null;

        // Recalculate duration if start or stop time changed
        if (tData.start_time !== undefined || tData.stop_time !== undefined) {
            const updated = result.rows[0];
           
            const s = timeToSeconds(updated.start_time);
            const e = timeToSeconds(updated.stop_time);

            if (s !== null && e !== null && e > s) {
                const newDuration = formatDurationHMS(e - s);
                if (newDuration !== updated.duration) {
                    await pool.query('UPDATE "TIMESHEET" SET duration = $1 WHERE id = $2', [newDuration, id]);
                    updated.duration = newDuration;
                }
            }
        }

        // Trigger background recalculation
        if (result.rows[0] && result.rows[0].project_code) {
         
            triggerRecalculate(result.rows[0].project_code);
        }

        await syncTaskDuration(result.rows[0].task_id, previousTaskId);

        return result.rows[0];
    }

    static async delete(id) {
        // Get project_code before deletion
        const ts = await this.findById(id);
        const result = await pool.query('DELETE FROM "TIMESHEET" WHERE id = $1 RETURNING id', [id]);

        // Trigger background recalculation
        if (ts && ts.project_code) {
         
            triggerRecalculate(ts.project_code);
        }

        if (result.rows[0]) await syncTaskDuration(ts?.task_id);

        return result.rows[0];
    }

    // Process entries one-by-one; no duplicate check — all rows are inserted.
    static async bulkCreate(entries) {
        if (!entries || entries.length === 0) return { inserted: [], skipped: 0, errors: 0, errorDetails: [] };

        const inserted = [];
        const errorDetails = [];

        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            try {
                const row = await this.create(entry);
                inserted.push(row);
            } catch (err) {
                console.error(`[TimesheetModel.bulkCreate] Row ${i + 1} failed:`, err.message);
                errorDetails.push({ entry: i + 1, error: err.message });
            }
        }

        return { inserted, skipped: 0, errors: errorDetails.length, errorDetails };
    }

    // Get timesheet summary (total duration and net time) for ALL entries matching filters
    static async getSummary(filters = {}) {
        const {
            userId, projectCode, date, dateStart, dateEnd, today, type, project,
            process, startTime, stopTime, duration, projectBy, notes, user
        } = filters;

        let query = 'SELECT start_time, stop_time, t."date" FROM "TIMESHEET" t';
        let summaryJoin = '';
        let params = [];
        let conditions = [];

        const userFilter = user || userId;

        if (projectCode) {
            params.push(projectCode.trim());
            conditions.push(`TRIM(UPPER(t.project_code)) = TRIM(UPPER($${params.length}))`);
        }

        if (today === 'true') {
            conditions.push(`(${DATE_COL_AS_DATE}) = CURRENT_DATE`);
        }

        if (date) {
            const isoDate = this.toISODate(date) || String(date).trim();
            params.push(isoDate);
            conditions.push(`(${DATE_COL_AS_DATE}) = $${params.length}::date`);
        }

        // Date range: only start → from start to latest; only end → from earliest to end; both → between inclusive
        if (dateStart) {
            const isoStart = this.toISODate(dateStart) || String(dateStart).trim();
            params.push(isoStart);
            conditions.push(`(${DATE_COL_AS_DATE}) >= $${params.length}::date`);
        }
        if (dateEnd) {
            const isoEnd = this.toISODate(dateEnd) || String(dateEnd).trim();
            params.push(isoEnd);
            conditions.push(`(${DATE_COL_AS_DATE}) <= $${params.length}::date`);
        }

        if (type) {
            params.push(`%${type}%`);
            conditions.push(`LOWER(t.project_type) ILIKE $${params.length}`);
        }

        if (project) {
            const raw = String(project || '').trim();
            const parts = raw.includes('|')
                ? raw.split('|').map((x) => x.trim()).filter(Boolean)
                : [raw];
            const patterns = parts.map((p) => `%${p.toLowerCase()}%`);
            params.push(patterns);
            conditions.push(`LOWER(t.project_code) ILIKE ANY($${params.length})`);
        }

        if (process) {
            // Support both process ID and process name
            const processIdMatch = process.toString().match(/^\d+$/);
            if (processIdMatch) {
                params.push(parseInt(process));
                conditions.push(`t.process_id = $${params.length}`);
            } else {
                params.push(`%${process}%`);
                conditions.push(`LOWER(t.process_name) ILIKE $${params.length}`);
            }
        }

        // Start time: exact match when HH:MM or HH:MM:SS; only cast when column looks like time to avoid invalid cast
        if (startTime) {
            const isTimeFormat = /^\d{1,2}:\d{2}(:\d{2})?$/.test(String(startTime).trim());
            params.push(isTimeFormat ? String(startTime).trim() : `%${startTime}%`);
            conditions.push(isTimeFormat
                ? `(t.start_time IS NOT NULL AND TRIM(t.start_time) <> '' AND t.start_time ~ '^[0-9]{1,2}:[0-9]{2}(:[0-9]{2})?$' AND t.start_time::time = $${params.length}::time)`
                : `t.start_time::text ILIKE $${params.length}`);
        }

        if (stopTime) {
            if (String(stopTime).toLowerCase() === 'ongoing') {
                conditions.push(`(t.stop_time IS NULL OR t.stop_time = '' OR t.stop_time = 'Ongoing')`);
            } else {
                const isTimeFormat = /^\d{1,2}:\d{2}(:\d{2})?$/.test(String(stopTime).trim());
                params.push(isTimeFormat ? String(stopTime).trim() : `%${stopTime}%`);
                conditions.push(isTimeFormat
                    ? `(t.stop_time IS NOT NULL AND TRIM(t.stop_time) <> '' AND t.stop_time ~ '^[0-9]{1,2}:[0-9]{2}(:[0-9]{2})?$' AND t.stop_time::time = $${params.length}::time)`
                    : `t.stop_time::text ILIKE $${params.length}`);
            }
        }

        // Duration: exact match HH:MM or HH:MM:SS; only cast when column looks like interval to avoid invalid cast
        if (duration && /^\d{1,2}:\d{2}(:\d{2})?$/.test(String(duration).trim())) {
            const d = String(duration).trim();
            params.push(d);
            conditions.push(`(t.duration IS NOT NULL AND TRIM(t.duration) <> '' AND t.duration ~ '^[0-9]{1,2}:[0-9]{2}(:[0-9]{2})?$' AND (TRIM(t.duration)::interval = $${params.length}::interval OR TRIM(t.duration) = $${params.length}))`);
        }

        if (projectBy) {
            const raw = String(projectBy || '').trim();
            const parts = raw.includes('|')
                ? raw.split('|').map((x) => x.trim()).filter(Boolean)
                : [raw];
            const patterns = parts.map((p) => `%${p.toLowerCase()}%`);
            params.push(patterns);
            conditions.push(`LOWER(t.project_by) ILIKE ANY($${params.length})`);
        }

        if (notes) {
            params.push(`%${notes}%`);
            conditions.push(`LOWER(t.notes) ILIKE $${params.length}`);
        }

        if (userFilter) {
            summaryJoin = ' LEFT JOIN personal_details pd ON t.user_id = pd.id';
            appendUsernameFilter(conditions, params, userFilter);
        }

        const whereClause = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';
        const result = await pool.query(query + summaryJoin + whereClause, params);

        return result.rows;
    }

    static isOngoingStopTime(stopTime) {
        if (stopTime == null || stopTime === '') return true;
        return String(stopTime).trim().toLowerCase() === 'ongoing';
    }

    static async getStats(filters = {}) {
        const rows = await this.getSummary(filters);
        let totalDurationSeconds = 0;
        let totalOngoingEntries = 0;

        for (const ts of rows) {
            if (this.isOngoingStopTime(ts.stop_time)) {
                totalOngoingEntries += 1;
                continue;
            }

            if (ts.start_time && ts.stop_time) {
                const startSeconds = timeToSeconds(ts.start_time);
                const stopSeconds = timeToSeconds(ts.stop_time);
                if (
                    startSeconds != null &&
                    stopSeconds != null &&
                    stopSeconds >= startSeconds
                ) {
                    totalDurationSeconds += stopSeconds - startSeconds;
                }
            }
        }

        return {
            totalEntries: rows.length,
            totalOngoingEntries,
            totalDurationSeconds,
        };
    }

    /**
     * All timesheet rows in a date range (no pagination) for max-work analysis.
     * Optional user filter (username, supports | for multiple).
     */
    static async findAllForMaxWork({ dateStart, dateEnd, user } = {}) {
        const params = [];
        const conditions = [];

        if (dateStart) {
            params.push(dateStart);
            conditions.push(`(${DATE_COL_AS_DATE}) >= $${params.length}::date`);
        }
        if (dateEnd) {
            params.push(dateEnd);
            conditions.push(`(${DATE_COL_AS_DATE}) <= $${params.length}::date`);
        }

        let join = ' LEFT JOIN personal_details pd ON t.user_id = pd.id';
        if (user) {
            appendUsernameFilter(conditions, params, user);
        }

        const whereClause =
            conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';

        const query = `
            SELECT
                t.id,
                t.project_code,
                t.process_name,
                t.start_time,
                t.stop_time,
                t.duration,
                t.project_by,
                t.notes,
                t.task_id,
                t.task_serial_number,
                COALESCE(NULLIF(TRIM(t.user_name), ''), pd.username) AS user_name,
                (${DATE_COL_AS_DATE})::text AS date
            FROM "TIMESHEET" t
            ${join}
            ${whereClause}
            ORDER BY
                (${DATE_COL_AS_DATE}) ASC NULLS LAST,
                COALESCE(NULLIF(TRIM(t.user_name), ''), pd.username) ASC NULLS LAST,
                CASE
                    WHEN t.start_time IS NOT NULL
                         AND t.start_time::text ~ '^\\d{1,2}:\\d{2}:\\d{2}$'
                    THEN t.start_time::TIME
                    ELSE '00:00:00'::TIME
                END ASC NULLS LAST,
                t.id ASC
        `;

        const result = await pool.query(query, params);
        return result.rows;
    }

    /**
     * Timesheet rows for one project (optional date range / user / process) for duration totals.
     */
    static async findAllForMaxWorkDuration({
        projectCode,
        dateStart,
        dateEnd,
        user,
        processName,
    } = {}) {
        const params = [];
        const conditions = [];

        if (projectCode) {
            params.push(String(projectCode).trim());
            conditions.push(
                `TRIM(UPPER(t.project_code)) = TRIM(UPPER($${params.length}))`,
            );
        }
        if (dateStart) {
            params.push(dateStart);
            conditions.push(`(${DATE_COL_AS_DATE}) >= $${params.length}::date`);
        }
        if (dateEnd) {
            params.push(dateEnd);
            conditions.push(`(${DATE_COL_AS_DATE}) <= $${params.length}::date`);
        }
        if (processName) {
            params.push(String(processName).trim());
            conditions.push(
                `LOWER(TRIM(COALESCE(t.process_name, ''))) = LOWER(TRIM($${params.length}))`,
            );
        }

        let join = ' LEFT JOIN personal_details pd ON t.user_id = pd.id';
        if (user) {
            params.push(String(user).trim());
            conditions.push(
                `LOWER(TRIM(COALESCE(NULLIF(TRIM(t.user_name), ''), pd.username, ''))) = LOWER(TRIM($${params.length}))`,
            );
        }

        const whereClause =
            conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';

        const query = `
            SELECT
                t.id,
                t.project_code,
                t.process_name,
                t.start_time,
                t.stop_time,
                t.duration,
                t.project_by,
                t.notes,
                t.task_id,
                t.task_serial_number,
                COALESCE(NULLIF(TRIM(t.user_name), ''), pd.username) AS user_name,
                (${DATE_COL_AS_DATE})::text AS date
            FROM "TIMESHEET" t
            ${join}
            ${whereClause}
            ORDER BY
                (${DATE_COL_AS_DATE}) ASC NULLS LAST,
                CASE
                    WHEN t.start_time IS NOT NULL
                         AND t.start_time::text ~ '^\\d{1,2}:\\d{2}:\\d{2}$'
                    THEN t.start_time::TIME
                    ELSE '00:00:00'::TIME
                END ASC NULLS LAST,
                t.id ASC
        `;

        const result = await pool.query(query, params);
        return result.rows;
    }

    /** Same calendar day + user — used to block overlapping time ranges. */
    static async findEntriesForUserOnDate({
        date,
        userId,
        userName,
        excludeId,
    } = {}) {
        // Always compare as YYYY-MM-DD. Passing DD-MM-YYYY to `$1::date` can
        // swap month/day (e.g. 03-09-2026 → 2026-03-09) depending on DateStyle.
     const dateValue = this.toISODate(date);
if (!dateValue) return [];

// Parameters and WHERE conditions for the overlap query
const params = [dateValue];
const conditions = [`(${DATE_COL_AS_DATE}) = $1::date`];

const uid =
            userId != null && String(userId).trim() !== ''
                ? parseInt(String(userId), 10)
                : null;
        if (Number.isFinite(uid)) {
            params.push(uid);
            conditions.push(`t.user_id = $${params.length}`);
        } else if (String(userName ?? '').trim()) {
            params.push(String(userName).trim());
            conditions.push(
                `LOWER(TRIM(COALESCE(NULLIF(TRIM(t.user_name), ''), pd.username))) = LOWER(TRIM($${params.length}))`,
            );
        } else {
            return [];
        }

        if (excludeId != null && String(excludeId).trim() !== '') {
            params.push(parseInt(String(excludeId), 10));
            conditions.push(`t.id <> $${params.length}`);
        }

        conditions.push(
            `t.start_time IS NOT NULL AND TRIM(t.start_time) <> ''`,
        );

        const needsJoin = conditions.some((c) => c.includes('pd.username'));
        const join = needsJoin
            ? ' LEFT JOIN personal_details pd ON t.user_id = pd.id'
            : '';

        const query = `
            SELECT
                t.id,
                t.project_code,
                t.process_name,
                t.start_time,
                t.stop_time
            FROM "TIMESHEET" t
            ${join}
            WHERE ${conditions.join(' AND ')}
            ORDER BY t.start_time ASC NULLS LAST, t.id ASC
        `;

        const result = await pool.query(query, params);
        return result.rows;
    }
}

export default TimesheetModel;