import { AppError, wrapController } from '../../middleware/error.middleware.js';
import QtyReservationModel from '../../models/r2r/qtyReservation.model.js';
import ReadNotificationModel from '../../models/r2r/receiveIssueResponse.model.js';
import RequirementModel from '../../models/r2r/requirement.model.js';
import RequirementController from './requirement.controller.js';
import { pool } from '../../config/db.js';
import { recordQtyReservationStatusChange } from '../../models/r2r/requirementStatus.model.js';
import {
  buildIssueSocketPayload,
  emitIssueSocket,
} from '../../utils/notification/r2rDesktopNotify.js';
import {
  broadcast,
  broadcastQtyReservationNotification,
  broadcastQtyReservationUpdate,
} from '../../config/socket.js';
import {
  buildPaginationPayload,
  resolvePageWindow,
  stripListMeta,
} from '../../utils/paginatedList.utils.js';
import { nowIstTimestamp } from '../../utils/time.utils.js';
import {
  buildExactUserScopeSql,
  resolveStatsScopeFromQuery,
} from '../../utils/dataScope.utils.js';

const QTY_RESERVATION_PAGE = 'Qty Reservation';
/** Only this status triggers require-person notification. */
const PENDING_STATUS = 'Pending Reserve';
const RESERVED_STATUS = 'Qty Reserved';
const CANCELED_STATUS = 'Canceled';

const IN_TRANSIT_STATUS = 'In Transit';
const TRAY_PREPARED_STATUS = 'Tray Prepared';

const COMPLETED_STATUS = 'Completed';
const COMPLETED_WITH_ISSUE_STATUS = 'Completed with Issue';

/** READ_NOTIFICATION.notification_type values for qty reservation. */
const QTY_RES_NOTIFY_REQUESTED = 'qty-reservation-requested';
const QTY_RES_NOTIFY_PENDING_CONFIRM = 'qty-reservation-pending-confirm'; // legacy tray-prepared
const QTY_RES_NOTIFY_RESERVED = 'qty-reservation-reserved';
const QTY_RES_NOTIFY_TRAY_PREPARED = 'qty-reservation-tray-prepared';
const QTY_RES_NOTIFY_IN_TRANSIT = 'qty-reservation-in-transit';
const QTY_RES_NOTIFY_USER_RECEIVED = 'qty-reservation-user-received';
const QTY_RES_READ_NOTIFY_TYPES = [
  QTY_RES_NOTIFY_REQUESTED,
  QTY_RES_NOTIFY_PENDING_CONFIRM,
  QTY_RES_NOTIFY_RESERVED,
  QTY_RES_NOTIFY_TRAY_PREPARED,
  QTY_RES_NOTIFY_IN_TRANSIT,
  QTY_RES_NOTIFY_USER_RECEIVED,
];
const QTY_RESERVATION_HREF = '/r2r/receive-items';
const COLLECTION_DESK_HREF = '/r2r/collection-desk';

function str(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

function isPendingReserveStatus(value) {
  return str(value)?.toLowerCase() === PENDING_STATUS.toLowerCase();
}

function isTrayPreparedStatus(value) {
  return str(value)?.toLowerCase() === TRAY_PREPARED_STATUS.toLowerCase();
}

function isCompletedNotificationStatus(value) {
  const normalized = str(value)?.toLowerCase();
  return (
    normalized === COMPLETED_STATUS.toLowerCase() ||
    normalized === COMPLETED_WITH_ISSUE_STATUS.toLowerCase()
  );
}

function isQtyReservedStatus(value) {
  return str(value)?.toLowerCase() === RESERVED_STATUS.toLowerCase();
}

function isReserveExpiredStatus(value) {
  return str(value)?.toLowerCase() === 'reserve expired';
}

function isCanceledStatus(value) {
  const normalized = str(value)?.toLowerCase();
  return (
    normalized === CANCELED_STATUS.toLowerCase() ||
    normalized === 'cancelled'
  );
}

function canCancelReserveStatus(value) {
  return (
    isPendingReserveStatus(value) ||
    isQtyReservedStatus(value) ||
    isReserveExpiredStatus(value)
  );
}

/** Statuses returned by GET /notifications default + live socket payload. */
function isNotificationLiveStatus(value) {
  return isQtyReservedStatus(value) || isCompletedNotificationStatus(value);
}

/** Parse is_read from API body / query (null | true | false). */
function parseIsRead(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const s = String(value).trim().toLowerCase();
  if (s === '' || s === 'null') return null;
  if (value === true || s === 'true' || s === '1') return true;
  if (value === false || s === 'false' || s === '0') return false;
  return undefined;
}

/** Unread notification when status is Qty Reserved or Completed / Completed with Issue. */
function isReadForStatus(status) {
  const normalized = str(status)?.toLowerCase();
  if (!normalized) return undefined;
  if (isQtyReservedStatus(status)) return false;
  if (isCompletedNotificationStatus(status)) return false;
  return undefined;
}

/** Apply is_read rules when status changes; explicit is_read in patch wins. */
function withIsReadForStatus(patch = {}) {
  const next = { ...patch };
  if (next.isRead !== undefined && next.is_read === undefined) {
    next.is_read = next.isRead;
  }
  delete next.isRead;

  if (next.is_read !== undefined) {
    const explicit = parseIsRead(next.is_read);
    if (explicit !== undefined) next.is_read = explicit;
    return next;
  }

  const auto = isReadForStatus(next.qtyreservation_status ?? next.status);
  if (auto !== undefined) next.is_read = auto;
  return next;
}

function num(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Known qty-reservation query keys — used to reassemble values like R&D split by `&`. */
const QTY_RESERVATION_QUERY_KEYS = [
  'pagination',
  'paginate',
  'limit',
  'offset',
  'page',
  'all',
  'requirement_id',
  'serial_number',
  'sku',
  'item_name',
  'status',
  'qtyreservation_status',
  'project_code',
  'pcb_code',
  'pcb',
  'lot_no',
  'username',
  'user_name',
  'req_username',
  'reserved_username',
  'receive_username',
];

/**
 * Read a query value, fixing unencoded `&` (e.g. project_code=R&D → only "R").
 * Prefer raw URL capture when parsed value looks truncated.
 */
function readQueryParam(req, key, fallback = undefined) {
  const parsed = req.query?.[key] ?? fallback;
  const parsedStr =
    parsed == null
      ? ''
      : Array.isArray(parsed)
        ? String(parsed[0] ?? '').trim()
        : String(parsed).trim();

  const rawUrl = String(req.originalUrl || req.url || '');
  const qIndex = rawUrl.indexOf('?');
  if (qIndex < 0) return parsedStr || undefined;

  const query = rawUrl.slice(qIndex + 1);
  const keyAlt = QTY_RESERVATION_QUERY_KEYS.filter((k) => k !== key)
    .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const re = new RegExp(
    `(?:^|&)${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([\\s\\S]*?)(?=&(?:${keyAlt})=|&$)`,
    'i',
  );
  const match = query.match(re);
  if (!match) return parsedStr || undefined;

  let rawValue = match[1];
  try {
    rawValue = decodeURIComponent(rawValue.replace(/\+/g, ' '));
  } catch {
    // keep rawValue
  }
  rawValue = String(rawValue ?? '').trim();
  if (!rawValue) return parsedStr || undefined;

  // If Express split R&D into "R", prefer the raw reassembled value.
  if (!parsedStr || rawValue.length > parsedStr.length) return rawValue;
  return parsedStr;
}

/** Keep comma lists as text; otherwise parse as number. */
function qtyField(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.includes(',')) return s;
  const n = Number(s);
  return Number.isFinite(n) ? n : s;
}

function requirementIdFromBody(body = {}) {
  const raw =
    body.requirement_id ??
    body.requirementId ??
    body['sr.no'] ??
    body.sr_no ??
    body.id;
  if (raw == null || String(raw).trim() === '') return null;
  const s = String(raw).trim();
  // Already a comma list of ids
  if (s.includes(',')) return s;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return String(n);
}

function firstRequirementId(value) {
  if (value == null || value === '') return null;
  const first = String(value).split(',')[0].trim();
  const n = Number(first);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseRequirementIdList(value) {
  if (value == null || value === '') return [];
  return String(value)
    .split(',')
    .map((p) => Number(String(p).trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/** Sync linked REQUIREMENT rows with qty reservation status + id. */
async function syncLinkedRequirementsQtyReservation(
  requirementIdValue,
  { status, qtyReservationId, note },
) {
  const reqIds = parseRequirementIdList(requirementIdValue);
  const payload = {};
  if (status != null) payload.qtyreservation_status = status;
  if (qtyReservationId != null && qtyReservationId !== '') {
    payload.qtyreservation_id = Number(qtyReservationId);
  }
  if (note !== undefined) {
    payload.note = note == null || String(note).trim() === '' ? null : String(note).trim();
  }
  if (Object.keys(payload).length === 0) return;

  for (const reqId of reqIds) {
    try {
      const before = await RequirementModel.findById(reqId);
      const updated = await RequirementModel.update(reqId, payload);

      const nextQtyRes = str(status ?? updated?.qtyreservation_status);
      const prevQtyRes = str(before?.qtyreservation_status);
      const serial = str(updated?.serial_number || before?.serial_number);
      if (
        serial &&
        nextQtyRes &&
        (!prevQtyRes || prevQtyRes.toLowerCase() !== nextQtyRes.toLowerCase())
      ) {
        await recordQtyReservationStatusChange({
          serial_number: serial,
          old_qtyreservation_status: prevQtyRes,
          new_qtyreservation_status: nextQtyRes,
          fallback_old_status: str(before?.status) || str(updated?.status),
        });
      }
    } catch (err) {
      console.error(
        'Error syncing requirement qtyreservation fields:',
        reqId,
        err,
      );
    }
  }
}

/** Broadcast linked requirement rows so Collection Desk table + stat cards update live. */
async function broadcastLinkedRequirements(reservation) {
  const reqIds = parseRequirementIdList(reservation?.requirement_id);
  for (const reqId of reqIds) {
    try {
      const row = await RequirementModel.findById(reqId);
      if (row) {
        broadcast(
          'requirement-update',
          'updated',
          RequirementController.formatRequirementBroadcastRow(row),
        );
      }
    } catch (err) {
      console.error('Error broadcasting requirement update:', reqId, err);
    }
  }
}

function shouldEmitQtyReservationNotificationLive(
  existing,
  updated,
  { bodyHasIsRead = false, isReadChanged = false } = {},
) {
  if (!updated || !isNotificationLiveStatus(updated.qtyreservation_status)) {
    return false;
  }

  const prevRead = parseIsRead(existing?.is_read);
  const nextRead = parseIsRead(updated?.is_read);
  const becameUnread = nextRead === false && prevRead !== false;
  const statusBecameNotifiable =
    isNotificationLiveStatus(updated.qtyreservation_status) &&
    !isNotificationLiveStatus(existing?.qtyreservation_status);

  return (
    becameUnread ||
    statusBecameNotifiable ||
    (bodyHasIsRead && isReadChanged)
  );
}

function resolveQtyReservationNotificationEventType(existing, updated) {
  const prevRead = parseIsRead(existing?.is_read);
  const nextRead = parseIsRead(updated?.is_read);
  const becameUnread = nextRead === false && prevRead !== false;
  const statusBecameNotifiable =
    isNotificationLiveStatus(updated?.qtyreservation_status) &&
    !isNotificationLiveStatus(existing?.qtyreservation_status);

  return becameUnread || statusBecameNotifiable ? 'created' : 'updated';
}

/** Emit qty-reservation-notification socket (same shape as GET /notifications). */
function emitQtyReservationNotificationLive(reservation, eventType = 'created') {
  if (!reservation || !isNotificationLiveStatus(reservation.qtyreservation_status)) {
    console.log('[socket] skip qty-reservation-notification — status not notifiable', {
      id: reservation?.id ?? null,
      status: reservation?.qtyreservation_status ?? null,
    });
    return;
  }

  const notification = QtyReservationModel.formatNotificationRow(reservation);
  if (!notification) return;

  try {
    broadcastQtyReservationNotification(eventType, {
      username: str(reservation.receive_username),
      notification,
    });
  } catch (err) {
    console.error('Socket emit error (qty-reservation-notification):', err);
  }
}

function maybeEmitQtyReservationNotificationLive(
  existing,
  updated,
  { bodyHasIsRead = false } = {},
) {
  const prevRead = parseIsRead(existing?.is_read);
  const nextRead = parseIsRead(updated?.is_read);
  const isReadChanged = prevRead !== nextRead;

  if (
    !shouldEmitQtyReservationNotificationLive(existing, updated, {
      bodyHasIsRead,
      isReadChanged,
    })
  ) {
    return;
  }

  emitQtyReservationNotificationLive(
    updated,
    resolveQtyReservationNotificationEventType(existing, updated),
  );
}

async function emitQtyReservationLive(type, qtyReservation) {
  try {
    broadcastQtyReservationUpdate(type, qtyReservation ?? null);
  } catch (err) {
    console.error('Socket emit error (qty-reservation-update):', err);
  }
  if (qtyReservation && type !== 'deleted') {
    await broadcastLinkedRequirements(qtyReservation);
  }
}

/** Resolve acting username from header / auth / body fields. */
async function resolveActorUsername(req, bodyKeys = []) {
  let actor =
    str(req.headers?.['x-username'] ?? req.headers?.['x-store-username']) ||
    str(req.user?.username) ||
    null;

  if (!actor) {
    for (const key of bodyKeys) {
      actor = str(req.body?.[key]);
      if (actor) break;
    }
  }

  if (!actor && req.user?.id != null) {
    try {
      const userRes = await pool.query(
        `SELECT username FROM personal_details WHERE id = $1 LIMIT 1`,
        [req.user.id],
      );
      actor = str(userRes.rows[0]?.username);
    } catch (err) {
      console.error('Could not resolve username from user id:', err);
    }
  }

  return actor;
}

/**
 * Apply remove_quantity on one qty reservation → Tray Prepared.
 * Shared by single + bulk remove endpoints.
 * Optional location is saved on the reservation row.
 * @param {{ location?: unknown, skipNotify?: boolean }} [options]
 */
async function applyRemoveQuantity(id, removeQty, removeBy, options = {}) {
  const { location, skipNotify = false } = options;
  const existing = await QtyReservationModel.findById(id);
  if (!existing) throw new AppError('Qty reservation not found', 404);

  if (removeQty == null || removeQty <= 0) {
    throw new AppError('remove_quantity must be greater than 0', 400);
  }

  const wasTrayPrepared = isTrayPreparedStatus(existing.qtyreservation_status);

  const patch = {
    remove_quantity: removeQty,
    remove_username: removeBy,
    remove_date: nowIstTimestamp(),
    qtyreservation_status: TRAY_PREPARED_STATUS,
  };
  if (location !== undefined) {
    patch.location = str(location);
  }

  const updated = await QtyReservationModel.update(id, patch);

  if (existing.requirement_id != null) {
    await syncLinkedRequirementsQtyReservation(existing.requirement_id, {
      status: TRAY_PREPARED_STATUS,
      qtyReservationId: updated?.id ?? id,
    });
  }

  if (!wasTrayPrepared && !skipNotify) {
    try {
      await notifyTrayPreparedBulk([updated], removeBy);
    } catch (err) {
      console.error('Error sending tray-prepared notification:', err);
    }
  }

  try {
    await emitQtyReservationLive('removed', updated);
  } catch (err) {
    console.error('Socket emit error (remove):', err);
  }

  return updated;
}

/**
 * Accept one qty reservation → Qty Reserved.
 * Shared by single + bulk accept endpoints.
 * @param {{ skipNotify?: boolean }} [options]
 */
async function applyAcceptReserveQuantity(
  id,
  reservedQtyInput,
  reservedBy,
  options = {},
) {
  const skipNotify = options.skipNotify === true;
  const existing = await QtyReservationModel.findById(id);
  if (!existing) throw new AppError('Qty reservation not found', 404);

  const maxQty =
    num(existing.fixed_quantity) ??
    num(existing.receive_qty) ??
    num(String(existing.req_qty || '').split(',')[0]) ??
    null;

  let reservedQty = num(reservedQtyInput) ?? maxQty ?? 0;

  if (reservedQty <= 0) {
    throw new AppError('reserved_qty must be greater than 0', 400);
  }
  if (maxQty != null && reservedQty > maxQty) {
    throw new AppError(`reserved_qty cannot exceed ${maxQty}`, 400);
  }

  const updated = await QtyReservationModel.update(
    id,
    withIsReadForStatus({
      qtyreservation_status: RESERVED_STATUS,
      reserved_qty: reservedQty,
      reserved_username: reservedBy,
    }),
  );

  if (existing.requirement_id != null) {
    await syncLinkedRequirementsQtyReservation(existing.requirement_id, {
      status: RESERVED_STATUS,
      qtyReservationId: updated?.id ?? id,
    });
  }

  try {
    await clearQtyReservationIssues(existing.requirement_id, existing.id);
  } catch (err) {
    console.error('Error clearing qty reservation issues:', err);
  }

  if (!skipNotify) {
    try {
      await notifyQtyReservedBulk([updated], reservedBy);
    } catch (err) {
      console.error('Error sending qty-reserved notification:', err);
    }
  }

  try {
    maybeEmitQtyReservationNotificationLive(existing, updated);
  } catch (err) {
    console.error(
      'Error emitting qty-reservation-notification (accept):',
      err,
    );
  }

  try {
    await emitQtyReservationLive('accepted', updated);
  } catch (err) {
    console.error('Socket emit error (accept):', err);
  }

  return updated;
}

/**
 * Mark one qty reservation as In Transit (tray prepared → ship).
 * Shared by single + bulk tray-prepared endpoints.
 * @param {{ skipNotify?: boolean }} [options]
 */
async function applyTrayPrepared(id, options = {}) {
  const skipNotify = options.skipNotify === true;
  const existing = await QtyReservationModel.findById(id);
  if (!existing) throw new AppError('Qty reservation not found', 404);

  const prev = str(existing.qtyreservation_status)?.toLowerCase();
  const alreadyInTransit =
    prev === IN_TRANSIT_STATUS.toLowerCase() || prev === 'pending confirm';

  const updated = await QtyReservationModel.update(
    id,
    withIsReadForStatus({
      qtyreservation_status: IN_TRANSIT_STATUS,
    }),
  );

  if (existing.requirement_id != null) {
    await syncLinkedRequirementsQtyReservation(existing.requirement_id, {
      status: IN_TRANSIT_STATUS,
      qtyReservationId: updated?.id ?? id,
    });
  }

  if (!alreadyInTransit && !skipNotify) {
    try {
      await notifyInTransitBulk([updated], str(existing.remove_username) || 'System');
    } catch (err) {
      console.error('Error sending in-transit notification:', err);
    }
  }

  try {
    await emitQtyReservationLive('tray-prepared', updated);
  } catch (err) {
    console.error('Socket emit error (tray-prepared):', err);
  }

  return updated;
}

/**
 * User receive / review one reservation → Completed / Completed with Issue.
 * @param {{ reviewText?: string|null, reviewBy: string, requestedStatus?: string, skipNotify?: boolean }} opts
 */
async function applyUserReceiveReview(id, opts = {}) {
  const existing = await QtyReservationModel.findById(id);
  if (!existing) throw new AppError('Qty reservation not found', 404);

  const reviewText = str(opts.reviewText);
  const reviewBy = str(opts.reviewBy);
  if (!reviewBy) {
    throw new AppError('review_username is required', 400);
  }

  const requestedStatus = str(opts.requestedStatus) || COMPLETED_STATUS;
  const requestedLower = requestedStatus.toLowerCase();
  const finalStatus =
    requestedLower === COMPLETED_WITH_ISSUE_STATUS.toLowerCase()
      ? COMPLETED_WITH_ISSUE_STATUS
      : COMPLETED_STATUS;

  if (finalStatus === COMPLETED_WITH_ISSUE_STATUS && !reviewText) {
    throw new AppError('review is required for Completed with Issue', 400);
  }

  const skipNotify = opts.skipNotify === true;

  const updated = await QtyReservationModel.update(
    id,
    withIsReadForStatus({
      review: reviewText,
      review_username: reviewBy,
      review_date: nowIstTimestamp(),
      qtyreservation_status: finalStatus,
    }),
  );

  if (existing.requirement_id != null) {
    await syncLinkedRequirementsQtyReservation(existing.requirement_id, {
      status: finalStatus,
      qtyReservationId: updated?.id ?? id,
    });
  }

  if (!skipNotify) {
    try {
      await notifyUserReceivedBulk([updated], reviewBy);
    } catch (err) {
      console.error('Error sending user-receive notification:', err);
    }
  }

  try {
    await emitQtyReservationLive('reviewed', updated);
    maybeEmitQtyReservationNotificationLive(existing, updated);
  } catch (err) {
    console.error('Socket emit error (review):', err);
  }

  return updated;
}

/**
 * Cancel one qty reservation → Canceled.
 * Shared by single + bulk cancel endpoints.
 */
async function applyCancelReserve(id, commentInput, statusStageInput) {
  const existing = await QtyReservationModel.findById(id);
  if (!existing) throw new AppError('Qty reservation not found', 404);

  if (!canCancelReserveStatus(existing.qtyreservation_status)) {
    throw new AppError(
      'Only Pending Reserve, Qty Reserved, or Reserve Expired can be canceled',
      400,
    );
  }

  const comment = str(commentInput);
  if (!comment) {
    throw new AppError('comment is required to cancel reservation', 400);
  }

  const stageFrom =
    str(existing.qtyreservation_status) ||
    str(statusStageInput) ||
    'Unknown';

  const commentWithStage = comment.includes('(from ')
    ? comment
    : `${comment} (from ${stageFrom})`;

  const updated = await QtyReservationModel.update(
    id,
    withIsReadForStatus({
      comment: commentWithStage,
      qtyreservation_status: CANCELED_STATUS,
    }),
  );

  if (existing.requirement_id != null) {
    await syncLinkedRequirementsQtyReservation(existing.requirement_id, {
      status: CANCELED_STATUS,
      qtyReservationId: updated?.id ?? id,
      note: commentWithStage,
    });
  }

  try {
    await emitQtyReservationLive('updated', updated);
  } catch (err) {
    console.error('Socket emit error (cancel):', err);
  }

  return updated;
}

/** Root serial for split family: from "Balance qty from X (...)" / receive issue, else own serial. */
function parseRootSerial(serial, splitText) {
  const split = String(splitText ?? '');
  const balance = split.match(/Balance qty from\s+(.+?)\s*\(/i);
  if (balance?.[1]) return balance[1].trim();
  const issue = split.match(/Receive issue from\s+(.+)$/i);
  if (issue?.[1]) return issue[1].trim();
  return str(serial);
}

/**
 * Walk split parents until the original RFQ (supports A → B → C chains, not only 2).
 */
async function resolveUltimateRootSerial(requirement) {
  let current = requirement;
  const seen = new Set();
  for (let i = 0; i < 20; i++) {
    const serial = str(current?.serial_number);
    const parent = parseRootSerial(serial, current?.split);
    if (!parent || !serial || parent.toLowerCase() === serial.toLowerCase()) {
      return parent || serial || null;
    }
    const key = parent.toLowerCase();
    if (seen.has(key)) return parent;
    seen.add(key);

    const parentRes = await pool.query(
      `SELECT serial_number, split, fixed_quantity, "sr.no"
       FROM "REQUIREMENT"
       WHERE LOWER(TRIM(COALESCE(serial_number, ''))) = LOWER(TRIM($1))
       LIMIT 1`,
      [parent],
    );
    if (!parentRes.rows[0]) return parent;
    current = parentRes.rows[0];
  }
  return str(current?.serial_number);
}

async function findSplitFamilyRequirements(requirement) {
  if (!requirement) return [];
  const serial = str(requirement.serial_number);
  let root;
  try {
    root = (await resolveUltimateRootSerial(requirement)) || serial;
  } catch {
    root = parseRootSerial(serial, requirement.split) || serial;
  }
  if (!root) return requirement ? [requirement] : [];

  const fixed = num(requirement.fixed_quantity);
  const params = [root];

  // Pull root + any RFQ whose split chain mentions root (direct or nested balance labels).
  // Also include children of children by matching any serial already in the growing set via recursive CTE.
  let sql = `
    WITH RECURSIVE family AS (
      SELECT r.*
      FROM "REQUIREMENT" r
      WHERE LOWER(TRIM(COALESCE(r.serial_number, ''))) = LOWER(TRIM($1))
      UNION
      SELECT c.*
      FROM "REQUIREMENT" c
      INNER JOIN family f
        ON (
          c.split ILIKE '%' || TRIM(f.serial_number) || '%'
          OR LOWER(TRIM(COALESCE(c.serial_number, ''))) = LOWER(TRIM($1))
        )
      WHERE c."sr.no" IS DISTINCT FROM f."sr.no"
    )
    SELECT DISTINCT ON (family."sr.no") family.*
    FROM family
  `;
  if (fixed != null) {
    params.push(fixed);
    sql += `
    WHERE (
      family.fixed_quantity = $2
      OR family.fixed_quantity IS NULL
    )
    `;
  }
  sql += ` ORDER BY family."sr.no", family.created_at ASC NULLS LAST`;

  try {
    const result = await pool.query(sql, params);
    const rows = result.rows || [];
    if (rows.length === 0 && requirement) return [requirement];

    // Safety: also include any row whose split mentions root (in case CTE missed)
    const extra = await pool.query(
      `SELECT * FROM "REQUIREMENT"
       WHERE split ILIKE '%' || $1 || '%'
          OR LOWER(TRIM(COALESCE(serial_number, ''))) = LOWER(TRIM($1))
       ORDER BY created_at ASC NULLS LAST, "sr.no" ASC`,
      [root],
    );
    const byId = new Map();
    for (const r of [...rows, ...(extra.rows || [])]) {
      const id = String(r['sr.no'] ?? '');
      if (id) byId.set(id, r);
    }
    if (requirement?.['sr.no'] != null || requirement?.sr_no != null) {
      byId.set(String(requirement['sr.no'] ?? requirement.sr_no), {
        ...byId.get(String(requirement['sr.no'] ?? requirement.sr_no)),
        ...requirement,
      });
    }
    return [...byId.values()].sort(
      (a, b) => Number(a['sr.no'] || 0) - Number(b['sr.no'] || 0),
    );
  } catch (err) {
    console.error('findSplitFamilyRequirements failed:', err);
    // Fallback non-recursive
    try {
      const result = await pool.query(
        `SELECT * FROM "REQUIREMENT"
         WHERE LOWER(TRIM(COALESCE(serial_number, ''))) = LOWER(TRIM($1))
            OR split ILIKE '%' || $1 || '%'
         ORDER BY created_at ASC NULLS LAST, "sr.no" ASC`,
        [root],
      );
      return result.rows?.length ? result.rows : requirement ? [requirement] : [];
    } catch {
      return requirement ? [requirement] : [];
    }
  }
}

function isReceivedRequirement(row) {
  const status = String(row.status ?? '')
    .trim()
    .toLowerCase();
  const recv = num(row.receive_qty);
  return status.includes('receive done') || (recv != null && recv > 0);
}

/**
 * Aggregate ALL received split RFQs into comma-separated fields (2+ supported).
 * Pending Reserve only when total receive qty matches fixed_quantity.
 */
function applySplitFamilyAggregation(row, familyRows, currentRequirement) {
  let fixed =
    num(row.fixed_quantity) ??
    num(currentRequirement?.fixed_quantity) ??
    null;

  const byId = new Map();
  for (const r of familyRows || []) {
    const id = String(r['sr.no'] ?? r.sr_no ?? '');
    if (id) byId.set(id, r);
  }
  if (currentRequirement) {
    const id = String(
      currentRequirement['sr.no'] ?? currentRequirement.sr_no ?? '',
    );
    if (id) byId.set(id, currentRequirement);
  }

  const allFamily = [...byId.values()];

  if (fixed == null && allFamily.length > 0) {
    const allocated = allFamily.reduce((sum, r) => {
      return sum + (num(r.quantity) ?? num(r.order_qty) ?? num(r.receive_qty) ?? 0);
    }, 0);
    if (allocated > 0) fixed = allocated;
  }

  let members = allFamily.filter(isReceivedRequirement);
  if (members.length === 0 && currentRequirement) {
    members = [currentRequirement];
  }

  // Stable order by requirement id
  members.sort(
    (a, b) =>
      Number(a['sr.no'] ?? a.sr_no ?? 0) - Number(b['sr.no'] ?? b.sr_no ?? 0),
  );

  const reqIds = [];
  const serials = [];
  const reqQtys = [];
  const targets = [];
  const receivers = [];
  let totalReceive = 0;

  for (const r of members) {
    const id = r['sr.no'] ?? r.sr_no;
    if (id != null && String(id).trim() !== '') reqIds.push(String(id));
    const sn = str(r.serial_number);
    if (sn) serials.push(sn);
    const q = num(r.receive_qty) ?? num(r.quantity) ?? 0;
    reqQtys.push(String(q));
    totalReceive += q;
    targets.push(str(r.target_receive_date) || '-');
    const receiver = str(r.receiver_name ?? r.receive_username);
    if (receiver) receivers.push(receiver);
  }

  if (reqIds.length) row.requirement_id = reqIds.join(',');
  if (serials.length) row.serial_number = serials.join(',');
  if (reqQtys.length) row.req_qty = reqQtys.join(',');
  if (targets.length) row.target_receive_date = targets.join(',');
  if (receivers.length) {
    row.receive_username = [...new Set(receivers)].join(',');
  }
  row.receive_qty = totalReceive;
  if (fixed != null) row.fixed_quantity = fixed;

  row.qtyreservation_status = PENDING_STATUS;
  const matched =
    fixed != null &&
    Number.isFinite(totalReceive) &&
    Math.abs(totalReceive - fixed) < 0.0001;
  return { matched, totalReceive, fixed, members };
}

async function findOpenFamilyReservation({
  fixedQuantity,
  reqUsername,
  sku,
  rootSerial,
  requirementId,
  familyIds = [],
  familySerials = [],
}) {
  const params = [];
  const where = [
    `LOWER(TRIM(COALESCE(qtyreservation_status, ''))) = LOWER($1)`,
  ];
  params.push(PENDING_STATUS);

  const orParts = [];

  const root = str(rootSerial);
  if (root) {
    params.push(root);
    orParts.push(`serial_number ILIKE '%' || $${params.length} || '%'`);
  }

  for (const sn of familySerials || []) {
    const s = str(sn);
    if (!s || (root && s.toLowerCase() === root.toLowerCase())) continue;
    params.push(s);
    orParts.push(`serial_number ILIKE '%' || $${params.length} || '%'`);
  }

  const ids = (familyIds || [])
    .map((id) => num(id))
    .filter((id) => id != null);
  const reqIdsFromRow = parseRequirementIdList(requirementId);
  for (const id of reqIdsFromRow) {
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length) {
    for (const id of ids) {
      params.push(String(id));
      // Token match avoids false positives (e.g. id 1 matching "12,21")
      orParts.push(
        `(requirement_id = $${params.length} OR (',' || COALESCE(requirement_id, '') || ',') LIKE '%,' || $${params.length} || ',%')`,
      );
    }
  }

  if (orParts.length === 0) {
    // Last resort: same fixed_quantity + sku (same item family)
    const fixed = num(fixedQuantity);
    const skuVal = str(sku);
    if (fixed == null || !skuVal) return [];
    params.push(fixed, skuVal);
    where.push(`fixed_quantity = $${params.length - 1}`);
    where.push(
      `LOWER(TRIM(COALESCE(sku, ''))) = LOWER(TRIM($${params.length}))`,
    );
  } else {
    where.push(`(${orParts.join(' OR ')})`);
    const fixed = num(fixedQuantity);
    if (fixed != null) {
      // Prefer same fixed_quantity but still allow null fixed on older rows
      params.push(fixed);
      where.push(
        `(fixed_quantity = $${params.length} OR fixed_quantity IS NULL)`,
      );
    }
  }

  const username = str(reqUsername);
  const sql = `
    SELECT * FROM "QTY_RESERVATION"
    WHERE ${where.join(' AND ')}
    ORDER BY
      CASE
        WHEN $${params.length + 1}::text IS NOT NULL
         AND LOWER(TRIM(COALESCE(req_username, ''))) = LOWER(TRIM($${params.length + 1}::text))
        THEN 0 ELSE 1
      END,
      id ASC
    LIMIT 10
  `;
  params.push(username);

  try {
    const result = await pool.query(sql, params);
    return result.rows || [];
  } catch (err) {
    console.error('findOpenFamilyReservation failed:', err);
    return [];
  }
}

/** Keep one open family reservation; remove duplicate open rows. */
async function mergeDuplicateOpenReservations(keepId, candidates = []) {
  for (const row of candidates) {
    if (!row?.id || Number(row.id) === Number(keepId)) continue;
    try {
      await QtyReservationModel.delete(row.id);
    } catch (err) {
      console.error('Failed deleting duplicate qty reservation', row.id, err);
    }
  }
}

/** Map request body / requirement fields → QTY_RESERVATION row. */
export function buildQtyReservationRow(body = {}) {
  const requirementId = requirementIdFromBody(body);

  return {
    requirement_id: requirementId,
    serial_number: str(body.serial_number),
    sku: str(body.sku),
    item_name: str(body.item_name ?? body.product_name),
    location: str(body.location),
    target_receive_date: str(body.target_receive_date),
    req_qty: qtyField(body.req_qty ?? body.quantity),
    receive_qty: num(body.receive_qty),
    reserved_qty: num(body.reserved_qty),
    remove_quantity: num(body.remove_quantity ?? body.remove_qty),
    remove_qtyID: (() => {
      const raw =
        body.remove_qtyID ?? body.remove_qtyid ?? body.remove_qty_id;
      if (raw == null || String(raw).trim() === '') return null;
      return String(raw).trim();
    })(),
    fixed_quantity: num(body.fixed_quantity),
    req_username: str(body.req_username ?? body.require_person_name),
    receive_username: str(body.receive_username ?? body.receiver_name),
    reserved_username: str(body.reserved_username),
    remove_username: str(body.remove_username),
    remove_date: str(body.remove_date),
    review: str(body.review),
    review_username: str(body.review_username),
    review_date: str(body.review_date),
    project_code: str(body.project_code),
    pcb_code: str(body.pcb_code ?? body.pcb),
    lot_no: str(body.lot_no),
    comment: str(body.comment),
    items_image: str(
      body.items_image ?? body.items_photo ?? body.image_url ?? body.image,
    ),
    qtyreservation_status: (() => {
      const raw = str(body.qtyreservation_status ?? body.status);
      // Never persist legacy partial_receive — always Pending Reserve on create/update row build.
     
      return raw;
    })(),
    is_read: parseIsRead(body.is_read ?? body.isRead),
    created_by: str(body.created_by ?? body.receiver_name),
  };
}

/** Resolve store catalog image_url for a SKU (same catalog the frontend uses). */
async function fetchStoreItemsImageBySku(sku) {
  const trimmed = str(sku);
  if (!trimmed) return null;

  const base = String(
   
      process.env.NEXT_PUBLIC_STORE_API ||
      '',
  )
    .trim()
    .replace(/\/+$/, '');
  if (!base) return null;

  try {
    const url = `${base}/store/all-items?sku=${encodeURIComponent(trimmed)}&pagination=false`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const body = await res.json();
    const rows = Array.isArray(body?.data)
      ? body.data
      : Array.isArray(body?.items)
        ? body.items
        : [];
    if (!rows.length) return null;

    const skuLower = trimmed.toLowerCase();
    const item =
      rows.find(
        (r) => String(r?.sku ?? '').trim().toLowerCase() === skuLower,
      ) || rows[0];
    const raw =
      item?.image_url ??
      item?.imageUrl ??
      item?.image ??
      item?.items_image ??
      item?.photo ??
      null;
    const image = str(raw);
    return image;
  } catch (err) {
    console.error('fetchStoreItemsImageBySku failed:', err?.message || err);
    return null;
  }
}

function buildReservationMeta(row) {
  const qty = row.fixed_quantity ?? row.receive_qty ?? null;
  return {
    item_name: row.item_name || '',
    quantity: qty,
    fixed_quantity: row.fixed_quantity ?? qty,
    req_qty: row.req_qty ?? null,
    receive_qty: row.receive_qty ?? null,
    serial_number: row.serial_number || '',
    requirement_id: row.requirement_id || '',
    target_receive_date: row.target_receive_date || '',
    qty_reservation_id: row.id ?? null,
    sku: row.sku || '',
    qtyreservation_status: row.qtyreservation_status || '',
  };
}

async function notifyReqUsername(reservation) {
  return notifyPendingReserveBulk([reservation]);
}

/**
 * One desktop + READ_NOTIFICATION per req_username when many Pending Reserve
 * rows share the same requirement user (bulk receive → Accept to reserve).
 */
async function notifyPendingReserveBulk(reservations) {
  const list = (Array.isArray(reservations) ? reservations : [])
    .filter(Boolean)
    .filter((row) => isPendingReserveStatus(row?.qtyreservation_status));
  if (!list.length) return [];

  /** @type {Map<string, any[]>} */
  const byUser = new Map();
  for (const row of list) {
    const username = str(row.req_username);
    if (!username) continue;
    if (!byUser.has(username)) byUser.set(username, []);
    byUser.get(username).push(row);
  }

  const created = [];

  for (const [username, rows] of byUser.entries()) {
    const count = rows.length;
    const sender =
      str(rows[0]?.created_by) ||
      str(rows[0]?.receive_username) ||
      'System';

    const lineParts = rows.map((r) => {
      const serial =
        str(r.serial_number) ||
        (r.requirement_id != null ? `REQ-${r.requirement_id}` : 'Requirement');
      const itemName = str(r.item_name) || 'Item';
      const qty =
        r.fixed_quantity ?? r.receive_qty ?? r.req_qty ?? '';
      return { serial, itemName, qty, row: r };
    });

    const serials = lineParts.map((p) => p.serial).filter(Boolean);
    const preview =
      serials.slice(0, 5).join(', ') +
      (serials.length > 5 ? ` +${serials.length - 5} more` : '');

    const title = 'Qty Reservation';
    const dbMessage =
      count === 1
        ? `${sender} requested Qty Reservation for ${serials[0]}`
        : `${sender} requested Qty Reservation for ${count} items: ${preview}`;

    const desktopMessage =
      count === 1
        ? `${lineParts[0].serial}: ${lineParts[0].itemName} — Qty ${lineParts[0].qty}. Accept to reserve.`
        : `${count} items pending accept: ${preview}. Accept to reserve.`;

    const requirementIds = rows
      .map((r) => firstRequirementId(r.requirement_id))
      .filter((id) => id != null);

    try {
      if (requirementIds.length) {
        await pool.query(
          `DELETE FROM "READ_NOTIFICATION"
           WHERE notification_type = $1
             AND LOWER(TRIM(receive_username)) = LOWER($2)
             AND requirement_id = ANY($3::int[])`,
          [QTY_RES_NOTIFY_REQUESTED, username, requirementIds],
        );
      }
    } catch (err) {
      console.error(
        'Failed clearing prior qty-reservation-requested notifications:',
        err,
      );
    }

    const primary = rows[0];
    const primaryReqId = firstRequirementId(primary.requirement_id);
    const serialForStore =
      String(serials[0] || '').split(',')[0].trim() || serials[0] || '';

    const row = await ReadNotificationModel.create({
      notification_type: QTY_RES_NOTIFY_REQUESTED,
      requirement_id: primaryReqId,
      serial_number: String(serialForStore).slice(0, 100),
      sender_username: sender,
      receive_username: username,
      page_name: QTY_RESERVATION_PAGE,
      href: QTY_RESERVATION_HREF,
      title,
      message: dbMessage,
      meta: {
        status: PENDING_STATUS,
        count,
        serial_numbers: serials,
        qty_reservation_ids: rows.map((r) => r.id).filter((id) => id != null),
        requirement_ids: requirementIds,
        items: rows.map((r) => buildReservationMeta(r)),
      },
      is_read: false,
    });
    created.push(row);

    const payload = buildIssueSocketPayload({
      username,
      socketType: QTY_RES_NOTIFY_REQUESTED,
      title,
      message: desktopMessage,
      serial_number: serials[0] || null,
      requirement_id: primary.requirement_id,
      page_name: QTY_RESERVATION_PAGE,
      issue: row,
    });
    emitIssueSocket({
      ...payload,
      added_count: count,
      event_id: `qty-reservation-requested-${username}-${Date.now()}`,
      href: QTY_RESERVATION_HREF,
    });
  }

  return created;
}

/**
 * Notify require person when items are prepared (Tray Prepared).
 * Desktop + READ_NOTIFICATION row — Collection Desk receive.
 */
async function notifyPendingConfirm(reservation) {
  return notifyQtyReservationStatusBulk([reservation], {
    notificationType: QTY_RES_NOTIFY_TRAY_PREPARED,
    title: 'Tray prepared',
    statusLabel: 'Tray Prepared',
    senderUsername:
      str(reservation?.remove_username) ||
      str(reservation?.created_by) ||
      'System',
    href: COLLECTION_DESK_HREF,
    statusGuard: (row) =>
      isTrayPreparedStatus(row?.qtyreservation_status) ||
      // Legacy notifyPendingConfirm also accepted In Transit mis-sets.
      str(row?.qtyreservation_status)?.toLowerCase() ===
        IN_TRANSIT_STATUS.toLowerCase(),
  });
}

/**
 * One READ_NOTIFICATION per recipient when many reservations share the same user.
 * Used for Qty Reserved / Tray Prepared / In Transit / User Receive (single + bulk).
 */
async function notifyQtyReservationStatusBulk(reservations, opts = {}) {
  const {
    notificationType,
    title,
    statusLabel,
    senderUsername,
    href = QTY_RESERVATION_HREF,
    statusGuard = null,
  } = opts;

  const list = (Array.isArray(reservations) ? reservations : [])
    .filter(Boolean)
    .filter((row) => (statusGuard ? statusGuard(row) : true));
  if (!list.length || !notificationType) return [];

  /** @type {Map<string, any[]>} */
  const byUser = new Map();
  for (const row of list) {
    const username = str(row.req_username);
    if (!username) continue;
    if (!byUser.has(username)) byUser.set(username, []);
    byUser.get(username).push(row);
  }

  const created = [];
  const sender = str(senderUsername) || 'System';

  for (const [username, rows] of byUser.entries()) {
    const serials = rows
      .map(
        (r) =>
          str(r.serial_number) ||
          (r.requirement_id != null ? `REQ-${r.requirement_id}` : ''),
      )
      .filter(Boolean);
    const count = rows.length;
    const preview =
      serials.slice(0, 5).join(', ') +
      (serials.length > 5 ? ` +${serials.length - 5} more` : '');
    const message =
      count === 1
        ? `${preview}: ${statusLabel}`
        : `${count} items ${statusLabel}: ${preview}`;

    const requirementIds = rows
      .map((r) => firstRequirementId(r.requirement_id))
      .filter((id) => id != null);

    try {
      if (requirementIds.length) {
        await pool.query(
          `DELETE FROM "READ_NOTIFICATION"
           WHERE notification_type = $1
             AND LOWER(TRIM(receive_username)) = LOWER($2)
             AND requirement_id = ANY($3::int[])`,
          [notificationType, username, requirementIds],
        );
      }
    } catch (err) {
      console.error(
        `Failed clearing prior ${notificationType} notifications:`,
        err,
      );
    }

    const primary = rows[0];
    const primaryReqId = firstRequirementId(primary.requirement_id);
    const serialForStore =
      String(serials[0] || '').split(',')[0].trim() || serials[0] || '';

    const row = await ReadNotificationModel.create({
      notification_type: notificationType,
      requirement_id: primaryReqId,
      serial_number: String(serialForStore).slice(0, 100),
      sender_username: sender,
      receive_username: username,
      page_name: QTY_RESERVATION_PAGE,
      href,
      title: title || statusLabel,
      message,
      meta: {
        status: statusLabel,
        count,
        serial_numbers: serials,
        qty_reservation_ids: rows.map((r) => r.id).filter((id) => id != null),
        requirement_ids: requirementIds,
        items: rows.map((r) => buildReservationMeta(r)),
      },
      is_read: false,
    });
    created.push(row);

    emitIssueSocket(
      buildIssueSocketPayload({
        username,
        socketType: notificationType,
        title: title || statusLabel,
        message,
        serial_number: serials[0] || null,
        requirement_id: primary.requirement_id,
        page_name: QTY_RESERVATION_PAGE,
        issue: row,
      }),
    );
  }

  return created;
}

async function notifyQtyReservedBulk(reservations, senderUsername) {
  return notifyQtyReservationStatusBulk(reservations, {
    notificationType: QTY_RES_NOTIFY_RESERVED,
    title: 'Qty reserved',
    statusLabel: 'Qty Reserved',
    senderUsername,
    href: QTY_RESERVATION_HREF,
    statusGuard: (row) => isQtyReservedStatus(row?.qtyreservation_status),
  });
}

async function notifyTrayPreparedBulk(reservations, senderUsername) {
  return notifyQtyReservationStatusBulk(reservations, {
    notificationType: QTY_RES_NOTIFY_TRAY_PREPARED,
    title: 'Tray prepared',
    statusLabel: 'Tray Prepared',
    senderUsername,
    href: COLLECTION_DESK_HREF,
    statusGuard: (row) => isTrayPreparedStatus(row?.qtyreservation_status),
  });
}

async function notifyInTransitBulk(reservations, senderUsername) {
  return notifyQtyReservationStatusBulk(reservations, {
    notificationType: QTY_RES_NOTIFY_IN_TRANSIT,
    title: 'In transit',
    statusLabel: 'In Transit',
    senderUsername,
    href: COLLECTION_DESK_HREF,
    statusGuard: (row) => {
      const s = str(row?.qtyreservation_status)?.toLowerCase();
      return s === IN_TRANSIT_STATUS.toLowerCase() || s === 'pending confirm';
    },
  });
}

async function notifyUserReceivedBulk(reservations, senderUsername) {
  return notifyQtyReservationStatusBulk(reservations, {
    notificationType: QTY_RES_NOTIFY_USER_RECEIVED,
    title: 'Items received',
    statusLabel: 'User Receive',
    senderUsername,
    href: COLLECTION_DESK_HREF,
    statusGuard: (row) =>
      isCompletedNotificationStatus(row?.qtyreservation_status),
  });
}

async function clearQtyReservationIssues(requirementId, qtyReservationId = null) {
  const ids = parseRequirementIdList(requirementId);
  const resId = num(qtyReservationId);

  // Clear READ_NOTIFICATION rows (current store).
  let clearedReadRows = [];
  if (ids.length) {
    const typeParams = [...QTY_RES_READ_NOTIFY_TYPES];
    const idParams = ids;
    const readResult = await pool.query(
      `DELETE FROM "READ_NOTIFICATION"
       WHERE notification_type = ANY($1::text[])
         AND requirement_id = ANY($2::int[])
       RETURNING id, receive_username, requirement_id, serial_number`,
      [typeParams, idParams],
    );
    clearedReadRows = readResult.rows;
  } else if (resId != null) {
    const readResult = await pool.query(
      `DELETE FROM "READ_NOTIFICATION"
       WHERE notification_type = ANY($1::text[])
         AND (
           meta->>'qty_reservation_id' = $2
           OR meta->>'qty_reservation_id' = $3
         )
       RETURNING id, receive_username, requirement_id, serial_number`,
      [QTY_RES_READ_NOTIFY_TYPES, String(resId), JSON.stringify(resId)],
    );
    clearedReadRows = readResult.rows;
  }

  for (const row of clearedReadRows) {
    const username = str(row.receive_username);
    if (!username) continue;
    emitIssueSocket(
      buildIssueSocketPayload({
        username,
        socketType: 'qty-reservation-accepted',
        title: 'Qty reserved',
        message: `${row.serial_number || 'Requirement'}: reservation accepted`,
        serial_number: row.serial_number,
        requirement_id: row.requirement_id,
        page_name: QTY_RESERVATION_PAGE,
        issue: row,
      }),
    );
  }

  // Legacy ISSUE cleanup (older rows created before READ_NOTIFICATION).
  const params = [QTY_RESERVATION_PAGE];
  const conditions = [`"page_name" = $1`];
  const idConds = [];

  if (ids.length) {
    params.push(ids);
    idConds.push(`"requirement_id" = ANY($${params.length}::int[])`);
  }

  if (resId != null) {
    params.push(String(resId));
    idConds.push(
      `notes ILIKE '%' || '"qty_reservation_id":' || $${params.length} || '%'`,
    );
    params.push(String(resId));
    idConds.push(
      `notes ILIKE '%' || '"qty_reservation_id": ' || $${params.length} || '%'`,
    );
  }

  if (idConds.length === 0) return;
  conditions.push(`(${idConds.join(' OR ')})`);

  const result = await pool.query(
    `DELETE FROM "ISSUE"
     WHERE ${conditions.join(' AND ')}
     RETURNING "sr.no", "receive_username", "requirement_id", "serial_number"`,
    params,
  );

  for (const row of result.rows) {
    const username = str(row.receive_username);
    if (!username) continue;
    emitIssueSocket(
      buildIssueSocketPayload({
        username,
        socketType: 'qty-reservation-accepted',
        title: 'Qty reserved',
        message: `${row.serial_number || 'Requirement'}: reservation accepted`,
        serial_number: row.serial_number,
        requirement_id: row.requirement_id,
        page_name: QTY_RESERVATION_PAGE,
        issue: row,
      }),
    );
  }
}

class QtyReservationController {
  static async getAll(req, res) {
    const { meta, filterQuery } = stripListMeta(req.query || {});
    const { all, paginationOff, limit, offset, page } = resolvePageWindow(meta);
    const username = String(
      req.headers?.['x-username'] ??
        req.headers?.['x_username'] ??
        filterQuery.username ??
        filterQuery.user_name ??
        filterQuery.req_username ??
        '',
    ).trim();
    const hasSpecificLookup =
      String(filterQuery.requirement_id ?? '').trim() !== '' ||
      String(filterQuery.serial_number ?? '').trim() !== '';
    // List views: scope to requester or reserver. Lookup by requirement/serial: no header user filter.
    const hasExplicitUserFilter =
      String(filterQuery.username ?? filterQuery.user_name ?? '').trim() !==
        '' ||
      String(filterQuery.req_username ?? '').trim() !== '' ||
      String(filterQuery.reserved_username ?? '').trim() !== '';
    if (username && !hasSpecificLookup && !hasExplicitUserFilter) {
      filterQuery.username = username;
    }

    const filters = {
      requirement_id: readQueryParam(req, 'requirement_id', filterQuery.requirement_id),
      serial_number: readQueryParam(req, 'serial_number', filterQuery.serial_number),
      item_name: readQueryParam(req, 'item_name', filterQuery.item_name),
      sku: readQueryParam(req, 'sku', filterQuery.sku),
      status: readQueryParam(
        req,
        'qtyreservation_status',
        filterQuery.qtyreservation_status ?? filterQuery.status,
      ) ?? readQueryParam(req, 'status', filterQuery.status),
      qtyreservation_status: readQueryParam(
        req,
        'qtyreservation_status',
        filterQuery.qtyreservation_status,
      ),
      project_code: readQueryParam(req, 'project_code', filterQuery.project_code),
      pcb_code:
        readQueryParam(req, 'pcb_code', filterQuery.pcb_code) ??
        readQueryParam(req, 'pcb', filterQuery.pcb),
      lot_no: readQueryParam(req, 'lot_no', filterQuery.lot_no),
      username:
        readQueryParam(req, 'username', filterQuery.username) ??
        readQueryParam(req, 'user_name', filterQuery.user_name),
      req_username: readQueryParam(req, 'req_username', filterQuery.req_username),
      receive_username: readQueryParam(
        req,
        'receive_username',
        filterQuery.receive_username,
      ),
      reserved_username: readQueryParam(
        req,
        'reserved_username',
        filterQuery.reserved_username,
      ),
      location: readQueryParam(req, 'location', filterQuery.location),
    };

    if (all || paginationOff) {
      const rows = await QtyReservationModel.findAll(filters);
      return res.json({
        success: true,
        qtyReservations: rows,
        pagination: buildPaginationPayload(rows.length, rows.length || limit, 0, 1, {
          paginated: false,
        }),
      });
    }

    const [rows, total] = await Promise.all([
      QtyReservationModel.findAll({ ...filters, limit, offset }),
      QtyReservationModel.countMatching(filters),
    ]);

    return res.json({
      success: true,
      qtyReservations: rows,
      pagination: buildPaginationPayload(total, limit, offset, page, {
        paginated: true,
      }),
    });
  }

  /**
   * GET /qty-reservations/notifications
   * Default status: Completed, Completed with Issue. Optional ?status= or ?qtyreservation_status= filter.
   */
  static async getNotifications(req, res) {
    const { meta, filterQuery } = stripListMeta(req.query || {});
    const { all, paginationOff, limit, offset, page } = resolvePageWindow(meta);

    const headerUser = String(
      req.headers?.['x-username'] ?? req.headers?.['x_username'] ?? '',
    ).trim();

    const filters = {
      item_name: readQueryParam(req, 'item_name', filterQuery.item_name),
      sku: readQueryParam(req, 'sku', filterQuery.sku),
      status:
        readQueryParam(
          req,
          'qtyreservation_status',
          filterQuery.qtyreservation_status,
        ) ?? readQueryParam(req, 'status', filterQuery.status),
      qtyreservation_status: readQueryParam(
        req,
        'qtyreservation_status',
        filterQuery.qtyreservation_status,
      ),
      receive_username: readQueryParam(
        req,
        'receive_username',
        filterQuery.receive_username,
      ),
      req_username: readQueryParam(req, 'req_username', filterQuery.req_username),
      remove_username: readQueryParam(
        req,
        'remove_username',
        filterQuery.remove_username,
      ),
      review_username: readQueryParam(
        req,
        'review_username',
        filterQuery.review_username,
      ),
      reserved_username: readQueryParam(
        req,
        'reserved_username',
        filterQuery.reserved_username,
      ),
      is_read:
        readQueryParam(req, 'is_read', filterQuery.is_read) ??
        readQueryParam(req, 'isRead', filterQuery.isRead),
      username:
        readQueryParam(req, 'username', filterQuery.username) ??
        readQueryParam(req, 'user_name', filterQuery.user_name),
    };

    const hasExplicitUserFilter =
      String(filters.receive_username ?? '').trim() !== '' ||
      String(filters.req_username ?? '').trim() !== '' ||
      String(filters.username ?? '').trim() !== '';
    if (headerUser && !hasExplicitUserFilter) {
      filters.receive_username = headerUser;
    } else if (filters.username && !filters.receive_username) {
      filters.receive_username = filters.username;
    }

    if (all || paginationOff) {
      const rows = await QtyReservationModel.findNotifications(filters);
      return res.json({
        success: true,
        notifications: rows,
        pagination: buildPaginationPayload(rows.length, rows.length || limit, 0, 1, {
          paginated: false,
        }),
      });
    }

    const [rows, total] = await Promise.all([
      QtyReservationModel.findNotifications({ ...filters, limit, offset }),
      QtyReservationModel.countNotifications(filters),
    ]);

    return res.json({
      success: true,
      notifications: rows,
      pagination: buildPaginationPayload(total, limit, offset, page, {
        paginated: true,
      }),
    });
  }

  /** GET /qty-reservations/stats — stat-card counts for Collection Desk. */
  static async getStats(req, res) {
    const { serial_number, req_username, project_code, pcb_code } = req.query || {};
    const { scopeUsernames } = await resolveStatsScopeFromQuery(req.query);

    const conditions = [];
    const values = [];

    if (serial_number) {
      values.push(serial_number);
      conditions.push(
        `split_part(serial_number, '-', 2) = $${values.length}`,
      );
    }
    

    const scopeSql = buildExactUserScopeSql(
      'req_username',
      scopeUsernames,
      values,
    );
    if (scopeSql) {
      conditions.push(scopeSql);
    } else if (req_username) {
      values.push(req_username);
      conditions.push(
        `LOWER(TRIM(req_username)) = LOWER(TRIM($${values.length}))`,
      );
    } else {
      const headerUser = String(
        req.headers?.['x-username'] ?? req.headers?.['x_username'] ?? '',
      ).trim();
      if (headerUser) {
        values.push(headerUser);
        conditions.push(
          `LOWER(TRIM(req_username)) = LOWER(TRIM($${values.length}))`,
        );
      }
    }

    if (project_code) {
      values.push(project_code);
      conditions.push(
        `LOWER(TRIM(project_code)) = LOWER(TRIM($${values.length}))`,
      );
    }

    if (pcb_code) {
      values.push(pcb_code);
      conditions.push(
        `LOWER(TRIM(pcb_code)) = LOWER(TRIM($${values.length}))`,
      );
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await pool.query(
      `
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (
          WHERE LOWER(TRIM(COALESCE(qtyreservation_status, ''))) = 'pending reserve'
        ) AS pending_reserve,
        COUNT(*) FILTER (
          WHERE LOWER(TRIM(COALESCE(qtyreservation_status, ''))) = 'reserve expired'
        ) AS reserve_expired,
        COUNT(*) FILTER (
          WHERE LOWER(TRIM(COALESCE(qtyreservation_status, ''))) = 'qty reserved'
        ) AS qty_reserved,
        COUNT(*) FILTER (
          WHERE LOWER(TRIM(COALESCE(qtyreservation_status, ''))) = 'tray prepared'
        ) AS tray_prepared,
        COUNT(*) FILTER (
          WHERE LOWER(TRIM(COALESCE(qtyreservation_status, ''))) IN (
            'in transit'
          )
        ) AS in_transit,
        COUNT(*) FILTER (
          WHERE LOWER(TRIM(COALESCE(qtyreservation_status, ''))) = 'completed'
        ) AS completed,
        COUNT(*) FILTER (
          WHERE LOWER(TRIM(COALESCE(qtyreservation_status, ''))) = 'completed with issue'
        ) AS completed_with_issue,
        COUNT(*) FILTER (
          WHERE LOWER(TRIM(COALESCE(qtyreservation_status, ''))) IN (
            'canceled',
            'cancelled'
          )
        ) AS canceled
       
      FROM "QTY_RESERVATION"
      ${whereClause}
      `,
      values,
    );

    const stats = result.rows[0] ?? {};

    return res.json({
      success: true,
      stats: {
        total: Number(stats.total || 0),
        pendingReserve: Number(stats.pending_reserve || 0),
        reserveExpired: Number(stats.reserve_expired || 0),
        qtyReserved: Number(stats.qty_reserved || 0),
        trayPrepared: Number(stats.tray_prepared || 0),
        inTransit: Number(stats.in_transit || 0),
        completed: Number(stats.completed || 0),
        completedWithIssue: Number(stats.completed_with_issue || 0),
        canceled: Number(stats.canceled || 0),
      },
    });
  }

  static async getById(req, res) {
    const row = await QtyReservationModel.findById(req.params.id);
    if (!row) throw new AppError('Qty reservation not found', 404);
    return res.json({
      success: true,
      qtyReservation: row,
    });
  }

  static async create(req, res) {
    const body = req.body || {};
    let row = buildQtyReservationRow(body);

    if (!row.serial_number && !row.requirement_id) {
      throw new AppError(
        'serial_number or requirement_id is required to create qty reservation',
        400,
      );
    }

    // One reservation = one requirement (never comma-join split RFQs).
    const singleRequirementId =
      firstRequirementId(row.requirement_id) != null
        ? String(firstRequirementId(row.requirement_id))
        : null;
    const singleSerial = String(row.serial_number || '')
      .split(',')[0]
      .trim();
    const singleReqQty =
      row.req_qty != null
        ? String(row.req_qty).split(',')[0].trim()
        : null;
    const singleTarget = String(row.target_receive_date || '')
      .split(',')[0]
      .trim();

    row.requirement_id = singleRequirementId;
    row.serial_number = singleSerial || null;
    if (singleReqQty != null && singleReqQty !== '') {
      row.req_qty = singleReqQty;
    } else if (row.req_qty != null) {
      row.req_qty = String(row.req_qty);
    }
    if (singleTarget) {
      row.target_receive_date = singleTarget;
    }

    // Fill items_image from store catalog by SKU when client omitted it
    if (!row.items_image && row.sku) {
      try {
        row.items_image = await fetchStoreItemsImageBySku(
          String(row.sku).split(',')[0].trim(),
        );
      } catch (err) {
        console.error('Could not resolve items_image from store SKU:', err);
      }
    }

    let currentRequirement = null;
    if (singleRequirementId != null) {
      try {
        currentRequirement = await RequirementModel.findById(singleRequirementId);
      } catch (err) {
        console.error('Qty reservation: load requirement failed:', err);
      }
    }

    if (currentRequirement) {
      if (!row.receive_username && currentRequirement.receiver_name) {
        row.receive_username = str(currentRequirement.receiver_name);
      }
      if (!row.serial_number) {
        row.serial_number = str(currentRequirement.serial_number);
      }
      if (!row.req_username && currentRequirement.require_person_name) {
        row.req_username = str(currentRequirement.require_person_name);
      }
    }

    row.qtyreservation_status = PENDING_STATUS;

    // Upsert only against this exact single requirement_id (not split family).
    let existingOpen = null;
    if (singleRequirementId != null) {
      try {
        const rows = await QtyReservationModel.findByRequirementId(
          singleRequirementId,
        );
        existingOpen =
          (Array.isArray(rows) ? rows : []).find(
            (r) =>
              String(r?.requirement_id ?? '').trim() === singleRequirementId &&
              isPendingReserveStatus(r?.qtyreservation_status),
          ) || null;
      } catch (err) {
        console.error('Qty reservation: find existing by requirement failed:', err);
      }
    }

    let saved;
    const wasPending = isPendingReserveStatus(
      existingOpen?.qtyreservation_status,
    );

    if (!row.items_image && existingOpen?.items_image) {
      row.items_image = existingOpen.items_image;
    }

    try {
      const saveRow = withIsReadForStatus(row);
      if (existingOpen?.id) {
        saved = await QtyReservationModel.update(existingOpen.id, saveRow);
      } else {
        saved = await QtyReservationModel.create(saveRow);
      }
    } catch (err) {
      console.error('Qty reservation save failed, retrying minimal row:', err);
      const minimal = withIsReadForStatus({
        ...row,
        requirement_id: singleRequirementId,
        serial_number: singleSerial || null,
        req_qty:
          num(singleReqQty) ??
          row.receive_qty ??
          null,
        target_receive_date: singleTarget
          ? singleTarget.slice(0, 10)
          : null,
      });
      if (existingOpen?.id) {
        saved = await QtyReservationModel.update(existingOpen.id, minimal);
      } else {
        saved = await QtyReservationModel.create(minimal);
      }
    }

    if (!saved) {
      throw new AppError('Could not save qty reservation', 500);
    }

    // Sync only this requirement — not the whole split family.
    if (singleRequirementId != null) {
      try {
        const beforeReq = await RequirementModel.findById(singleRequirementId);
        const updatedReq = await RequirementModel.update(singleRequirementId, {
          qtyreservation_status: saved.qtyreservation_status,
          qtyreservation_id: saved.id,
        });
        const nextQtyRes = str(saved.qtyreservation_status);
        const prevQtyRes = str(beforeReq?.qtyreservation_status);
        const serial = str(
          updatedReq?.serial_number ||
            beforeReq?.serial_number ||
            singleSerial,
        );
        if (
          serial &&
          nextQtyRes &&
          (!prevQtyRes || prevQtyRes.toLowerCase() !== nextQtyRes.toLowerCase())
        ) {
          await recordQtyReservationStatusChange({
            serial_number: serial,
            old_qtyreservation_status: prevQtyRes,
            new_qtyreservation_status: nextQtyRes,
            fallback_old_status: str(beforeReq?.status) || str(updatedReq?.status),
          });
        }
      } catch (err) {
        console.error('Error syncing requirement qtyreservation fields:', err);
      }
    }

    try {
      const suppressPendingNotify =
        body.suppress_pending_notify === true ||
        body.suppress_pending_notify === 'true' ||
        body.suppressPendingNotify === true;
      if (
        !suppressPendingNotify &&
        isPendingReserveStatus(saved.qtyreservation_status) &&
        !wasPending
      ) {
        await notifyReqUsername(saved);
      }
    } catch (err) {
      console.error('Error sending qty reservation notification:', err);
    }

    await emitQtyReservationLive(existingOpen?.id ? 'updated' : 'created', saved);

    return res.status(201).json({
      success: true,
      message: 'Qty reservation created',
      qtyReservation: saved,
    });
  }

  /**
   * One combined Qty Reservation desktop popup per req_username
   * after bulk receive creates many Pending Reserve rows.
   * Body: { ids: number[] }
   */
  static async bulkNotifyPendingReserve(req, res) {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new AppError('ids array is required', 400);
    }

    const rows = [];
    for (const rawId of ids) {
      const id = String(rawId ?? '').trim();
      if (!id) continue;
      const row = await QtyReservationModel.findById(id);
      if (!row) continue;
      if (!isPendingReserveStatus(row.qtyreservation_status)) continue;
      rows.push(row);
    }

    const created = rows.length ? await notifyPendingReserveBulk(rows) : [];

    return res.json({
      success: true,
      notified_count: rows.length,
      notification_count: created.length,
    });
  }

  /**
   * Cancel Pending Reserve / Qty Reserved.
   * Body: { comment } — fixed reason text; status becomes Canceled.
   */
  static async cancel(req, res) {
    const { id } = req.params;
    const comment = str(req.body?.comment ?? req.body?.reason);
    const statusStage =
      str(req.body?.status_stage) || str(req.body?.from_status) || null;

    const updated = await applyCancelReserve(id, comment, statusStage);

    return res.json({
      success: true,
      message: 'Qty reservation canceled',
      qtyReservation: updated,
    });
  }

  /**
   * Bulk cancel reserve — Body: { comment, items: [{ id, status_stage? }, ...] }
   */
  static async bulkCancel(req, res) {
    const body = req.body || {};
    const comment = str(body.comment ?? body.reason);
    if (!comment) {
      throw new AppError('comment is required to cancel reservation', 400);
    }

    const defaultStage =
      str(body.status_stage) || str(body.from_status) || null;

    let rawItems = body.items ?? body.qtyReservations ?? null;
    if ((!Array.isArray(rawItems) || rawItems.length === 0) && Array.isArray(body.ids)) {
      rawItems = body.ids.map((id) => ({ id }));
    }
    if ((!Array.isArray(rawItems) || rawItems.length === 0) && body.id != null) {
      rawItems = [{ id: body.id }];
    }

    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      throw new AppError(
        'items array is required — [{ id }, ...] or ids: [id, ...]',
        400,
      );
    }

    const canceled = [];
    const failed = [];

    for (const item of rawItems) {
      const id =
        item?.id ??
        item?.qty_reservation_id ??
        (typeof item === 'string' || typeof item === 'number' ? item : null);
      const statusStage =
        str(item?.status_stage) ||
        str(item?.from_status) ||
        defaultStage;
      try {
        if (id == null || String(id).trim() === '') {
          failed.push({ id: id ?? null, message: 'id is required' });
          continue;
        }
        const updated = await applyCancelReserve(id, comment, statusStage);
        canceled.push(updated);
      } catch (err) {
        failed.push({
          id,
          message:
            err?.message ||
            (process.env.NODE_ENV === 'development'
              ? String(err)
              : 'Cancel failed'),
        });
      }
    }

    return res.json({
      success: true,
      message: 'Bulk qty reservation cancel completed',
      qtyReservations: canceled,
      failed,
      summary: {
        total: rawItems.length,
        success: canceled.length,
        failed: failed.length,
      },
    });
  }

  static async accept(req, res) {
    const { id } = req.params;

    const reservedBy = await resolveActorUsername(req, [
      'reserved_username',
      'username',
    ]);
    if (!reservedBy) {
      throw new AppError(
        'Current username not found — send x-username header',
        400,
      );
    }

    const updated = await applyAcceptReserveQuantity(
      id,
      req.body?.reserved_qty,
      reservedBy,
    );

    return res.json({
      success: true,
      message: 'Qty reservation accepted',
      qtyReservation: updated,
    });
  }

  /**
   * Bulk accept reserve — same fields as single accept, as an items[].
   * Body: { items: [{ id, reserved_qty }, ...] }
   */
  static async bulkAccept(req, res) {
    const reservedBy = await resolveActorUsername(req, [
      'reserved_username',
      'username',
    ]);
    if (!reservedBy) {
      throw new AppError(
        'Current username not found — send x-username header',
        400,
      );
    }

    const body = req.body || {};
    const rawItems = body.items ?? body.qtyReservations ?? null;
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      throw new AppError(
        'items array is required — [{ id, reserved_qty }, ...]',
        400,
      );
    }

    const accepted = [];
    const failed = [];

    for (const item of rawItems) {
      const id = item?.id ?? item?.qty_reservation_id ?? null;
      const reservedQty = item?.reserved_qty ?? item?.quantity ?? null;
      try {
        if (id == null || String(id).trim() === '') {
          failed.push({ id: id ?? null, message: 'id is required' });
          continue;
        }
        const updated = await applyAcceptReserveQuantity(
          id,
          reservedQty,
          reservedBy,
          { skipNotify: true },
        );
        accepted.push(updated);
      } catch (err) {
        failed.push({
          id,
          message:
            err?.message ||
            (process.env.NODE_ENV === 'development'
              ? String(err)
              : 'Accept failed'),
        });
      }
    }

    if (accepted.length) {
      try {
        await notifyQtyReservedBulk(accepted, reservedBy);
      } catch (err) {
        console.error('Error sending bulk qty-reserved notifications:', err);
      }
    }

    return res.json({
      success: true,
      message: 'Bulk qty reservation accept completed',
      qtyReservations: accepted,
      failed,
      summary: {
        total: rawItems.length,
        success: accepted.length,
        failed: failed.length,
      },
    });
  }

  /**
   * Single tray prepared — body/params: { id }
   * Sets qtyreservation_status = Tray Prepared.
   */


  /**
   * Bulk tray prepared — Body: { items: [{ id }, ...] } or { ids: [id, ...] }
   * Also accepts a single { id } for convenience.
   */
  static async bulkTrayPrepared(req, res) {
    const body = req.body || {};
    let rawItems = body.items ?? body.qtyReservations ?? null;

    if ((!Array.isArray(rawItems) || rawItems.length === 0) && Array.isArray(body.ids)) {
      rawItems = body.ids.map((id) => ({ id }));
    }

    // Single-id body on bulk route
    if ((!Array.isArray(rawItems) || rawItems.length === 0) && body.id != null) {
      rawItems = [{ id: body.id }];
    }

    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      throw new AppError(
        'items array is required — [{ id }, ...] or ids: [id, ...]',
        400,
      );
    }

    const prepared = [];
    const failed = [];

    for (const item of rawItems) {
      const id =
        item?.id ??
        item?.qty_reservation_id ??
        (typeof item === 'string' || typeof item === 'number' ? item : null);
      try {
        if (id == null || String(id).trim() === '') {
          failed.push({ id: id ?? null, message: 'id is required' });
          continue;
        }
        const updated = await applyTrayPrepared(id, { skipNotify: true });
        prepared.push(updated);
      } catch (err) {
        failed.push({
          id,
          message:
            err?.message ||
            (process.env.NODE_ENV === 'development'
              ? String(err)
              : 'Tray prepared failed'),
        });
      }
    }

    if (prepared.length) {
      try {
        const actor = await resolveActorUsername(req, ['username']);
        await notifyInTransitBulk(prepared, actor || 'System');
      } catch (err) {
        console.error('Error sending bulk in-transit notifications:', err);
      }
    }

    return res.json({
      success: true,
      message: 'Bulk tray prepared completed',
      qtyReservations: prepared,
      failed,
      summary: {
        total: rawItems.length,
        success: prepared.length,
        failed: failed.length,
      },
    });
  }

  /**
   * Bulk remove qty — same fields as single remove, as an items[].
   * Body: { items: [{ id, remove_quantity, location }, ...], location? }
   * Top-level location is used when an item omits location.
   */
  static async bulkRemove(req, res) {
    const removeBy = await resolveActorUsername(req, [
      'remove_username',
      'username',
    ]);
    if (!removeBy) {
      throw new AppError(
        'Current username not found — send x-username header',
        400,
      );
    }

    const body = req.body || {};
    const defaultLocation =
      body.location !== undefined ? body.location : undefined;

    const rawItems = body.items ?? body.qtyReservations ?? null;
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      throw new AppError(
        'items array is required — [{ id, remove_quantity, location }, ...]',
        400,
      );
    }

    const removed = [];
    const failed = [];

    for (const item of rawItems) {
      const id = item?.id ?? item?.qty_reservation_id ?? null;
      const removeQty = num(item?.remove_quantity ?? item?.remove_qty);
      const location =
        item?.location !== undefined ? item.location : defaultLocation;
      try {
        if (id == null || String(id).trim() === '') {
          failed.push({ id: id ?? null, message: 'id is required' });
          continue;
        }
        const updated = await applyRemoveQuantity(id, removeQty, removeBy, {
          location,
          skipNotify: true,
        });
        removed.push(updated);
      } catch (err) {
        failed.push({
          id,
          message:
            err?.message ||
            (process.env.NODE_ENV === 'development'
              ? String(err)
              : 'Remove failed'),
        });
      }
    }

    if (removed.length) {
      try {
        await notifyTrayPreparedBulk(removed, removeBy);
      } catch (err) {
        console.error('Error sending bulk tray-prepared notifications:', err);
      }
    }

    return res.json({
      success: true,
      message: 'Bulk qty reservation remove completed',
      qtyReservations: removed,
      failed,
      summary: {
        total: rawItems.length,
        success: removed.length,
        failed: failed.length,
      },
    });
  }

  /** Submit review — review_username from x-username header; review_date = now. */
  static async review(req, res) {
    const { id } = req.params;
    const reviewBy = await resolveActorUsername(req, [
      'review_username',
      'username',
    ]);
    if (!reviewBy) {
      throw new AppError(
        'Current username not found — send x-username header',
        400,
      );
    }

    const updated = await applyUserReceiveReview(id, {
      reviewText: str(req.body?.review),
      reviewBy,
      requestedStatus:
        str(req.body?.qtyreservation_status ?? req.body?.status) ||
        COMPLETED_STATUS,
      skipNotify: false,
    });

    return res.json({
      success: true,
      message: 'Review submitted',
      qtyReservation: updated,
    });
  }

  /**
   * Bulk user receive / review.
   * Body: { items: [{ id, review?, qtyreservation_status? }, ...] }
   * Sends one READ_NOTIFICATION per req_username for all completed rows.
   */
  static async bulkReview(req, res) {
    const reviewBy = await resolveActorUsername(req, [
      'review_username',
      'username',
    ]);
    if (!reviewBy) {
      throw new AppError(
        'Current username not found — send x-username header',
        400,
      );
    }

    const body = req.body || {};
    const rawItems = body.items ?? body.qtyReservations ?? null;
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      throw new AppError(
        'items array is required — [{ id, review?, qtyreservation_status? }, ...]',
        400,
      );
    }

    const reviewed = [];
    const failed = [];

    for (const item of rawItems) {
      const id = item?.id ?? item?.qty_reservation_id ?? null;
      try {
        if (id == null || String(id).trim() === '') {
          failed.push({ id: id ?? null, message: 'id is required' });
          continue;
        }
        const updated = await applyUserReceiveReview(id, {
          reviewText: str(item?.review),
          reviewBy,
          requestedStatus:
            str(item?.qtyreservation_status ?? item?.status) ||
            COMPLETED_STATUS,
          skipNotify: true,
        });
        reviewed.push(updated);
      } catch (err) {
        failed.push({
          id,
          message:
            err?.message ||
            (process.env.NODE_ENV === 'development'
              ? String(err)
              : 'Review failed'),
        });
      }
    }

    if (reviewed.length) {
      try {
        await notifyUserReceivedBulk(reviewed, reviewBy);
      } catch (err) {
        console.error('Error sending bulk user-receive notifications:', err);
      }
    }

    return res.json({
      success: true,
      message: 'Bulk user receive completed',
      qtyReservations: reviewed,
      failed,
      summary: {
        total: rawItems.length,
        success: reviewed.length,
        failed: failed.length,
      },
    });
  }

  static async update(req, res) {
    const { id } = req.params;
    const existing = await QtyReservationModel.findById(id);
    if (!existing) throw new AppError('Qty reservation not found', 404);

    const body = req.body ?? {};
    const bodyHasIsRead =
      Object.prototype.hasOwnProperty.call(body, 'is_read') ||
      Object.prototype.hasOwnProperty.call(body, 'isRead');

    const built = buildQtyReservationRow({ ...existing, ...body });
    // Only treat is_read as explicit when the client sent it; otherwise
    // recompute from status (Qty Reserved / Completed → unread).
    if (!bodyHasIsRead) {
      delete built.is_read;
    }

    const row = withIsReadForStatus(built);
    delete row.id;

    const updated = await QtyReservationModel.update(id, row);

    // Notify only when status becomes Pending Reserve.
    const becamePending =
      isPendingReserveStatus(updated?.qtyreservation_status) &&
      !isPendingReserveStatus(existing.qtyreservation_status);
    if (becamePending) {
      try {
        await notifyReqUsername(updated);
      } catch (err) {
        console.error('Error sending qty reservation notification:', err);
      }
    }

    // Live notification: Qty Reserved / Completed / Completed with Issue (+ is_read changes).
    try {
      maybeEmitQtyReservationNotificationLive(existing, updated, { bodyHasIsRead });
    } catch (err) {
      console.error('Error emitting qty-reservation-notification:', err);
    }

    await emitQtyReservationLive('updated', updated);

    return res.json({
      success: true,
      message: 'Qty reservation updated',
      qtyReservation: updated,
    });
  }

  static async delete(req, res) {
    const existing = await QtyReservationModel.findById(req.params.id);
    if (!existing) throw new AppError('Qty reservation not found', 404);

    const deleted = await QtyReservationModel.delete(req.params.id);
    if (!deleted) throw new AppError('Qty reservation not found', 404);

    await emitQtyReservationLive('deleted', { ...existing, id: deleted.id });

    return res.json({ success: true, message: 'Qty reservation deleted' });
  }
}

wrapController(QtyReservationController, [
  'getAll',
  'getNotifications',
  'getStats',
  'getById',
  'create',
  'accept',
  'bulkAccept',
  'bulkTrayPrepared',
  'bulkNotifyPendingReserve',
  'cancel',
  'bulkCancel',
  'bulkRemove',
  'review',
  'bulkReview',
  'update',
  'delete',
]);

export default QtyReservationController;
