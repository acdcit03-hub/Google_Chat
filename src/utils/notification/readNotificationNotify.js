/**
 * Informational notifications that belong in READ_NOTIFICATION
 * (sidebar display / dismiss only — not ISSUE workflow actions).
 */
import ReadNotificationModel from '../../models/r2r/receiveIssueResponse.model.js';
import { pool } from '../../config/db.js';
import { getUsernamesForPage } from '../userPermission.utils.js';

export const READ_NOTIFY_ISSUE_REPORTED = 'issue-reported';
export const READ_NOTIFY_TERMINATE_REQUESTED = 'terminate-requested';

function str(v) {
  return String(v ?? '').trim();
}

/**
 * Resolve who should receive In Store / Purchase / Order Placed issue alerts.
 * Prefer requirement.review_person, then require person, then RM, then request-review page users.
 */
export async function resolveIssueReviewRecipients(requirement, opts = {}) {
  const exclude = str(opts.excludeUsername).toLowerCase();
  const recipients = new Set();

  const add = (value) => {
    const name = str(value);
    if (!name) return;
    if (exclude && name.toLowerCase() === exclude) return;
    recipients.add(name);
  };

  add(requirement?.review_person);
  add(requirement?.review_username);
  add(requirement?.require_person_name);

  const requirePerson = str(requirement?.require_person_name);
  if (requirePerson) {
    try {
      const requirePersonResult = await pool.query(
        `SELECT ed.reporting_manager
         FROM personal_details pd
         JOIN employment_details ed ON ed.personal_details_id = pd.id
         WHERE LOWER(TRIM(pd.username)) = LOWER(TRIM($1))
         LIMIT 1`,
        [requirePerson],
      );
      add(requirePersonResult.rows[0]?.reporting_manager);
    } catch (err) {
      console.error('Failed resolving reporting manager for issue notify:', err);
    }
  }

  if (recipients.size === 0) {
    for (const pageId of ['request-review', 'requestReview', 'purchase-request']) {
      try {
        const users = await getUsernamesForPage(pageId);
        for (const u of users) add(u);
        if (recipients.size > 0) break;
      } catch (err) {
        console.error(`Failed loading ${pageId} users for issue notify:`, err);
      }
    }
  }

  return Array.from(recipients);
}

/**
 * Resolve READ_NOTIFICATION recipients for a reported issue.
 * Skips Receive Issue (that flow keeps ISSUE table notifications).
 * Purchase / In Store → all request-review page users (same audience as former ISSUE broadcast).
 * Request Review → require person only.
 */
export async function resolveIssueReportedRecipients(
  requirement,
  pageName,
  opts = {},
) {
  const page = str(pageName).toLowerCase();
  if (page === 'receive issue' || page === 'receive items') {
    return [];
  }

  if (page === 'request review') {
    const requirePerson = str(requirement?.require_person_name);
    if (requirePerson) {
      const exclude = str(opts.excludeUsername).toLowerCase();
      if (exclude && requirePerson.toLowerCase() === exclude) return [];
      return [requirePerson];
    }
  }

  // Purchase / In Store: notify the whole request-review team (sidebar is READ_NOTIFICATION).
  if (page === 'purchase' || page === 'in store check') {
    const exclude = str(opts.excludeUsername).toLowerCase();
    const recipients = new Set();
    const add = (value) => {
      const name = str(value);
      if (!name) return;
      if (exclude && name.toLowerCase() === exclude) return;
      recipients.add(name);
    };

    try {
      const users = await getUsernamesForPage('request-review');
      for (const u of users) add(u);
    } catch (err) {
      console.error('Failed loading request-review users for issue notify:', err);
    }

    // Also include named review/require people in case they lack page permission.
    add(requirement?.review_person);
    add(requirement?.review_username);
    add(requirement?.require_person_name);

    if (recipients.size > 0) return Array.from(recipients);
  }

  return resolveIssueReviewRecipients(requirement, opts);
}

/**
 * Create issue-reported READ_NOTIFICATION rows + sockets for recipients.
 * No-op for Receive Issue pages.
 */
export async function notifyIssueReportedReadNotifications({
  requirementId,
  serialNumber,
  senderUsername,
  pageName,
  note,
  originStatus,
  issueId,
  recipients,
}) {
  const page = str(pageName).toLowerCase();
  if (page === 'receive issue' || page === 'receive items') {
    return [];
  }

  const created = [];
  for (const receiveUser of recipients || []) {
    const row = await createIssueReportedReadNotification({
      requirementId,
      serialNumber,
      senderUsername,
      receiveUsername: receiveUser,
      pageName,
      note,
      originStatus,
      issueId,
    });
    if (!row) continue;
    created.push(row);
  }
  return created;
}

/**
 * Create a dismissible READ_NOTIFICATION row for require-person issue alerts.
 */
export async function createIssueReportedReadNotification({
  requirementId,
  serialNumber,
  senderUsername,
  receiveUsername,
  pageName,
  note,
  originStatus,
  issueId,
}) {
  const receiveUser = str(receiveUsername);
  if (!receiveUser) {
    console.warn(
      '[READ_NOTIFICATION] skip issue-reported — empty receive_username',
      { requirementId, pageName },
    );
    return null;
  }

  const serial = str(serialNumber) || `SR-${requirementId}`;
  const sender = str(senderUsername) || 'User';
  const page = str(pageName) || 'Request Review';
  const title = 'Issue';
  const message = `${sender} Issue ${serial} from ${page}`;

  try {
    const reqId = Number(requirementId);
    if (Number.isFinite(reqId)) {
      await ReadNotificationModel.deleteByRequirementTypeAndUser(
        reqId,
        READ_NOTIFY_ISSUE_REPORTED,
        receiveUser,
      );
    }
  } catch (err) {
    console.error('Failed clearing prior issue-reported notifications:', err);
  }

  return ReadNotificationModel.create({
    notification_type: READ_NOTIFY_ISSUE_REPORTED,
    requirement_id: Number(requirementId) || null,
    serial_number: serial.slice(0, 100),
    sender_username: sender,
    receive_username: receiveUser,
    page_name: page,
    href: '/r2r/purchase-request?filter=issue',
    title,
    message,
    meta: {
      note: str(note),
      origin_status: str(originStatus) || 'Normal',
      issue_id: issueId != null ? String(issueId) : '',
      serial_number: serial,
    },
    is_read: false,
  });
}

/**
 * Create a dismissible READ_NOTIFICATION row for terminate requests.
 */
export async function createTerminateRequestedReadNotification({
  requirementId,
  serialNumber,
  senderUsername,
  receiveUsername,
  pageName,
  note,
  originStatus,
  issueId,
}) {
  const receiveUser = str(receiveUsername);
  if (!receiveUser) {
    console.warn(
      '[READ_NOTIFICATION] skip terminate-requested — empty receive_username',
      { requirementId, pageName },
    );
    return null;
  }

  const serial = str(serialNumber) || `SR-${requirementId}`;
  const sender = str(senderUsername) || 'User';
  const page = str(pageName) || 'Terminate';
  const title = 'Terminate requested';
  const message = `${page} Termination Request by ${sender} for ${serial}`;

  try {
    const reqId = Number(requirementId);
    if (Number.isFinite(reqId)) {
      await ReadNotificationModel.deleteByRequirementTypeAndUser(
        reqId,
        READ_NOTIFY_TERMINATE_REQUESTED,
        receiveUser,
      );
    }
  } catch (err) {
    console.error('Failed clearing prior terminate-requested notifications:', err);
  }

  return ReadNotificationModel.create({
    notification_type: READ_NOTIFY_TERMINATE_REQUESTED,
    requirement_id: Number(requirementId) || null,
    serial_number: serial.slice(0, 100),
    sender_username: sender,
    receive_username: receiveUser,
    page_name: page,
    href: '/r2r/purchase-request?filter=termreq',
    title,
    message,
    meta: {
      note: str(note),
      origin_status: str(originStatus) || 'Normal',
      issue_id: issueId != null ? String(issueId) : '',
      serial_number: serial,
    },
    is_read: false,
  });
}
