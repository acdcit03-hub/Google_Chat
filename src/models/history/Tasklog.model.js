import { pool } from '../../config/db.js';

const TASK_LOG_COLUMNS = [
    ['task_id', 'INTEGER'],
    ['serial_number', 'VARCHAR(50)'],
    ['field_name', 'VARCHAR(100)'],
    ['old_data', 'JSONB'],
    ['new_data', 'JSONB'],
    ['edited_by', 'VARCHAR(255)'],
    ['created_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'],
];


const USING = {
    NUMERIC: (c) => `NULLIF(TRIM("${c}"::text), '')::numeric`,
    DATE: (c) => `NULLIF(TRIM("${c}"::text), '')::date`,
    TIME: (c) => `NULLIF(TRIM("${c}"::text), '')::time`,
    TIMESTAMP: (c) => `NULLIF(TRIM("${c}"::text), '')::timestamp`,
    INTEGER: (c) => `NULLIF(TRIM("${c}"::text), '')::numeric::integer`,
    JSONB: (c) => `to_jsonb("${c}")`,
    TEXT: (c) => `"${c}"::text`,
    VARCHAR: (c) => `"${c}"::text`,
};

function columnMatches(wantedDdl, actual) {
    const want = wantedDdl.trim().toUpperCase();
    const dt = actual.data_type;
    if (want.startsWith('VARCHAR')) {
        const n = parseInt((want.match(/\((\d+)\)/) || [])[1], 10);
        return dt === 'text' || (dt === 'character varying' && (actual.character_maximum_length == null || actual.character_maximum_length >= n));
    }
    if (want.startsWith('TEXT')) return dt === 'text';
    if (want.startsWith('INTEGER')) return dt === 'integer' || dt === 'bigint';
    if (want.startsWith('NUMERIC')) return dt === 'numeric' && (actual.numeric_precision == null || actual.numeric_precision >= 10) && (actual.numeric_scale == null || actual.numeric_scale >= 2);
    if (want.startsWith('DATE')) return dt === 'date';
    if (want.startsWith('TIMESTAMP')) return dt === 'timestamp without time zone';
    if (want.startsWith('TIME')) return dt === 'time without time zone';
    if (want.startsWith('JSONB')) return dt === 'jsonb';
    return true;
}

async function repairTaskLogColumns() {
    try {
        const { rows } = await pool.query(
            `SELECT column_name, data_type, character_maximum_length, numeric_precision, numeric_scale, is_nullable, column_default
             FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'task_log'`,
        );
        const actualByName = new Map(rows.map((r) => [r.column_name, r]));
        const known = new Set(['id', ...TASK_LOG_COLUMNS.map(([name]) => name)]);

        // 1) wrong type / too-short length -> convert to the wanted type
        for (const [name, ddl] of TASK_LOG_COLUMNS) {
            const actual = actualByName.get(name);
            if (!actual || columnMatches(ddl, actual)) continue;

            const base = ddl.trim().toUpperCase().split(/[\s(]/)[0];
            const typeOnly = ddl.replace(/\s+(NOT NULL|DEFAULT).*$/i, '').trim();
            try {
                await pool.query(
                    `ALTER TABLE task_log ALTER COLUMN "${name}" TYPE ${typeOnly} USING ${(USING[base] || ((c) => `"${c}"::${typeOnly}`))(name)}`,
                );
                
            } catch (e) {
                // Data cannot be converted: keep it, but move to the right type with the old values dropped.
                try {
                    await pool.query(`ALTER TABLE task_log ALTER COLUMN "${name}" TYPE ${typeOnly} USING NULL`);
                } catch (e2) {
                    console.error(`task_log.${name} type repair failed:`, e2.message || e2);
                }
            }
        }
        for (const r of rows) {
            if (known.has(r.column_name)) continue;
            if (r.is_nullable === 'NO' && r.column_default == null) {
                try {
                    await pool.query(`ALTER TABLE task_log ALTER COLUMN "${r.column_name}" DROP NOT NULL`);
                } catch (e) {
                    console.error(`task_log.${r.column_name} DROP NOT NULL failed:`, e.message || e);
                }
            }
        }
    } catch (e) {
        console.error('task_log repair failed:', e.message || e);
    }
}

export async function initializeTaskLogTable() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS task_log (
            id SERIAL PRIMARY KEY
        );
    `);
    const addColumns = TASK_LOG_COLUMNS
        .map(([name, type]) => `ALTER TABLE task_log ADD COLUMN IF NOT EXISTS ${name} ${type};`)
        .join('\n');
    await pool.query(addColumns);
    await dropObsoleteTaskLogColumns();
    await repairTaskLogColumns();
    await dropLeftoverTaskLogConstraints();

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_task_log_task_id ON task_log(task_id);
        CREATE INDEX IF NOT EXISTS idx_task_log_edited_by ON task_log(edited_by);
        CREATE INDEX IF NOT EXISTS idx_task_log_created_at ON task_log(created_at);
    `);
    await removeOldTaskLogTrigger();
    await selfTestTaskLog();
}

async function dropObsoleteTaskLogColumns() {
    try {
        const { rows } = await pool.query(
            `SELECT column_name, data_type FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'task_log'`,
        );
        const names = new Set(rows.map((r) => r.column_name));
        if (names.has('old_value') && names.has('new_value')) {
            await pool.query(
                `UPDATE task_log
                 SET old_data = to_jsonb(old_value), new_data = to_jsonb(new_value)
                 WHERE field_name IS NOT NULL AND old_value IS NOT NULL`,
            );
        }

        const keep = new Set(['id', ...TASK_LOG_COLUMNS.map(([name]) => name)]);
        for (const { column_name } of rows) {
            if (keep.has(column_name)) continue;
            await pool.query(`ALTER TABLE task_log DROP COLUMN IF EXISTS "${column_name}"`);
         
        }
    } catch (e) {
        console.error('task_log column cleanup failed:', e.message || e);
    }
}

async function dropLeftoverTaskLogConstraints() {
    try {
        const cons = await pool.query(
            `SELECT conname FROM pg_constraint
             WHERE conrelid = 'task_log'::regclass AND contype IN ('u', 'c', 'x')`,
        );
        for (const { conname } of cons.rows) {
            await pool.query(`ALTER TABLE task_log DROP CONSTRAINT IF EXISTS "${conname}"`);
         
        }
        const idx = await pool.query(
            `SELECT indexname FROM pg_indexes
             WHERE schemaname = current_schema() AND tablename = 'task_log'
               AND indexdef ILIKE '%UNIQUE%' AND indexname <> 'task_log_pkey'`,
        );
        for (const { indexname } of idx.rows) {
            await pool.query(`DROP INDEX IF EXISTS "${indexname}"`);
       
        }
        const trg = await pool.query(
            `SELECT tgname FROM pg_trigger WHERE tgrelid = 'task_log'::regclass AND NOT tgisinternal`,
        );
        for (const { tgname } of trg.rows) {
            await pool.query(`DROP TRIGGER IF EXISTS "${tgname}" ON task_log`);
            
        }
    } catch (e) {
        console.error('task_log constraint cleanup failed:', e.message || e);
    }
}

async function selfTestTaskLog() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            `INSERT INTO task_log (task_id, serial_number, field_name, old_data, new_data, edited_by)
             VALUES (0, 'TEST', 'target_hour', '2'::jsonb, '4'::jsonb, 'self-test')`,
        );
        
    } catch (e) {
        console.error('❌ task_log self-test insert FAILED - this is why rows are missing:', e.message || e);
    } finally {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
        client.release();
    }
}


async function removeOldTaskLogTrigger() {
    await pool.query(`DROP TRIGGER IF EXISTS trg_task_log_capture ON tasks;`);
    await pool.query(`DROP FUNCTION IF EXISTS task_log_capture();`);
}

function sameValue(a, b) {
    const empty = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
    if (empty(a) && empty(b)) return true;
    if (empty(a) || empty(b)) return false;
    if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
    const na = Number(a), nb = Number(b);
    if (typeof a !== 'string' || typeof b !== 'string') {
        if (!Number.isNaN(na) && !Number.isNaN(nb)) return na === nb;
    }
    return String(a) === String(b);
}

/** Names of the task columns whose value differs between two row snapshots. */
function diffTaskRows(before, after) {
    const changed = [];
    for (const key of Object.keys(after || {})) {
        if (key === 'updated_at') continue;
        if (!sameValue(before?.[key], after[key])) changed.push(key);
    }
    return changed;
}

/** Value as stored text: empty -> NULL, objects -> JSON text. */
function asText(v) {
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) return null;
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

export async function writeTaskLog(client, before, after, editedBy = null) {
    const changed = diffTaskRows(before, after)
        .filter((k) => !['id', 'created_at'].includes(k))
        .filter((k) => asText(before?.[k]) !== null && asText(after[k]) !== null);
    if (changed.length === 0) return changed;

    const editor = String(editedBy ?? '').trim() || 'system';
    const params = [];
    const tuples = changed.map((k) => {
        params.push(after.id, after.serial_number ?? null, k, JSON.stringify(before), JSON.stringify(after), editor);
        const n = params.length;
        return `($${n - 5}, $${n - 4}, $${n - 3}, $${n - 2}::jsonb, $${n - 1}::jsonb, $${n})`;
    });

    await client.query('SAVEPOINT task_log_sp');
    try {
        await client.query(
            `INSERT INTO task_log (task_id, serial_number, field_name, old_data, new_data, edited_by)
             VALUES ${tuples.join(', ')}`,
            params,
        );
        await client.query('RELEASE SAVEPOINT task_log_sp');
    } catch (e) {
        console.error(`task_log insert failed for task ${after.id}:`, e.message || e);
        await client.query('ROLLBACK TO SAVEPOINT task_log_sp');
    }
    return changed;
}

class TaskLogModel {
    /** List log rows, newest first. Optional filters: task_id, edited_by, page, limit. */
    static async findAll(filters = {}) {
        const conditions = [];
        const params = [];

        if (filters.task_id) {
            params.push(parseInt(filters.task_id, 10));
            conditions.push(`task_id = $${params.length}`);
        }
        if (filters.edited_by) {
            params.push(`%${String(filters.edited_by).trim()}%`);
            conditions.push(`edited_by ILIKE $${params.length}`);
        }

        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

        const page = Math.max(1, parseInt(filters.page, 10) || 1);
        const limitRaw = parseInt(filters.limit, 10);
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 1000) : null;
        const offset = limit ? (page - 1) * limit : 0;

        const countResult = await pool.query(
            `SELECT COUNT(*)::int AS count FROM task_log ${where}`,
            params,
        );

        const dataParams = [...params];
        let limitSql = '';
        if (limit) {
            dataParams.push(limit, offset);
            limitSql = ` LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`;
        }

        const dataResult = await pool.query(
            `SELECT * FROM task_log ${where} ORDER BY created_at DESC, id DESC ${limitSql}`,
            dataParams,
        );

        return {
            rows: dataResult.rows,
            total: countResult.rows[0]?.count ?? 0,
            page,
            limit,
        };
    }

    static async findByTaskId(taskId) {
        const id = parseInt(taskId, 10);
        if (!id) return [];
        const result = await pool.query(
            'SELECT * FROM task_log WHERE task_id = $1 ORDER BY created_at DESC, id DESC',
            [id],
        );
        return result.rows;
    }
}

export default TaskLogModel;