import { pool } from '../config/db.js';

/**
 * ✅ ONLY TRUSTED SOURCE
 * user comes ONLY from auth middleware
 */
function getUserIdFromReq(req) {
  const u = req?.user;
  const authUserId = u?.id ?? u?._id ?? u?.userId ?? u?.user_id ?? null; // ✅ PRIMARY SOURCE

  if (authUserId != null) {
    return Number(authUserId);
  }

  const header = req?.headers?.['x-user-id'] ?? req?.headers?.['x_user_id'];
  const n = header == null ? NaN : parseInt(String(header), 10);
  return Number.isFinite(n) ? n : null;
}

function getUsernameFromReq(req) {
  const u = req?.user;
  const authUsername = u?.username ?? u?.user_name ?? u?.userName ?? null;
  if (authUsername != null && String(authUsername).trim()) {
    return String(authUsername).trim();
  }

  const header = req?.headers?.['x-username'] ?? req?.headers?.['x_username'];
  if (header != null && String(header).trim()) {
    return String(header).trim();
  }

  return null;
}

/**
 * 🔥 MAIN AUDIT LOGGER (CLEAN + SAFE)
 */
async function writeAuditLog(req, {
  action,
  tableName,
  tableOfId,
  tableOfColumn,
  oldValue,
  newValue,
}) {
  const userId = getUserIdFromReq(req);

  const safeAction = String(action || '').toUpperCase();
  if (!['UPDATE', 'DELETE', 'CREATE'].includes(safeAction)) return;

  const table = String(tableName || '').trim();
  if (!table) return;

  await pool.query(
    `
      INSERT INTO audit_log (
        action,
        table_name,
        table_of_id,
        table_of_column,
        old_value,
        new_value,
        user_id,
        created_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
    `,
    [
      safeAction,
      table,
      tableOfId != null ? Number(tableOfId) : null,
      tableOfColumn || null,
      oldValue != null ? JSON.stringify(oldValue) : null,
      newValue != null ? JSON.stringify(newValue) : null,
      userId != null ? Number(userId) : null,
    ]
  );
}

/**
 * 🔥 COMPARE OLD VS NEW DATA
 */
function normalizeForCompare(v) {
  if (v === undefined) return '__undefined__';
  if (v === null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

function pickChangedColumns(before, after, keys) {
  const allKeys = Array.isArray(keys) && keys.length
    ? keys
    : Array.from(new Set([
        ...Object.keys(before || {}),
        ...Object.keys(after || {})
      ]));

  const changed = [];
  const oldValue = {};
  const newValue = {};

  for (const k of allKeys) {
    const b = normalizeForCompare(before?.[k]);
    const a = normalizeForCompare(after?.[k]);

    if (b !== a) {
      changed.push(k);
      oldValue[k] = before?.[k];
      newValue[k] = after?.[k];
    }
  }

  return {
    columns: changed,
    oldValue: changed.length ? oldValue : null,
    newValue: changed.length ? newValue : null,
  };
}

export {
  getUserIdFromReq,
  getUsernameFromReq,
  writeAuditLog,
  pickChangedColumns,
};