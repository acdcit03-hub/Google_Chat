import { getIO } from '../../config/socket.js';
import { getUsernamesForPage } from '../userPermission.utils.js';

/** Workflow status → page permission + in-app route for desktop popup. */
const STATUS_NOTIFY_CONFIG = {
    'request review': {
        pageId: 'request-review',
        href: '/r2r/request-review',
        title: 'Request Review',
        message: (serial) =>
            `1 new requirement added for review: ${serial}`,
        bulkTitle: 'New Requirements',
        bulkMessage: (count, preview, more) =>
            `${count} new requirement(s) added for review: ${preview}${more}`,
    },
    'in store': {
        pageId: 'in-store-check',
        href: '/r2r/instore-check',
        title: 'Requirement Verified',
        message: (serial) =>
            `Requirement verified: ${serial}. Now available for In Store Check.`,
        bulkTitle: 'Requirements Verified',
        bulkMessage: (count, preview, more) =>
            `${count} requirement(s) verified: ${preview}${more}. Now available for In Store Check.`,
    },
    purchase: {
        pageId: 'purchase',
        href: '/r2r/purchases',
        title: 'Ready for Purchase',
        message: (serial) => `${serial}: In Store → Purchase`,
        bulkTitle: 'Ready for Purchase',
        bulkMessage: (count, preview, more) =>
            `${count} requirement(s): In Store → Purchase — ${preview}${more}`,
    },
    'order done': {
        pageId: 'order-placed',
        href: '/r2r/order-placed',
        title: 'Order Placed',
        message: (serial) => `${serial} requirement is order placed`,
        bulkTitle: 'Orders Placed',
        bulkMessage: (count, preview, more) =>
            `${count} requirement(s) order placed: ${preview}${more}`,
    },
    'receive done': {
        pageId: 'receive-items',
        href: '/r2r/receive-items',
        title: 'Requirement Received',
        message: (serial) => `${serial} requirement received`,
        bulkTitle: 'Requirements Received',
        bulkMessage: (count, preview, more) =>
            `${count} requirement(s) received: ${preview}${more}`,
    },
    'terminate requested': {
        pageId: 'request-review',
        href: '/r2r/request-review',
        title: 'Terminate Requested',
        message: (serial) => `Terminate requested for ${serial}`,
        bulkTitle: 'Terminate Requests',
        bulkMessage: (count, preview, more) =>
            `${count} terminate request(s): ${preview}${more}`,
    },
};

function normalizeStatus(status) {
    return String(status ?? '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
}

function serialLabel(requirement) {
    return (
        requirement.serial_number ||
        (requirement['sr.no'] != null ? `SR-${requirement['sr.no']}` : 'Requirement')
    );
}

function labelsFromRows(rows) {
    return rows.map((r) => serialLabel(r));
}

function previewText(labels) {
    const count = labels.length;
    const preview = labels.slice(0, 5).join(', ');
    const more = count > 5 ? ` and ${count - 5} more` : '';
    return { count, preview, more };
}

function buildEventId(requirement, newStatus) {
    const sr = requirement['sr.no'] ?? requirement.sr_no ?? '';
    const st = normalizeStatus(newStatus).replace(/\s+/g, '-');
    return `${sr}-${st}-${Date.now()}`;
}

function statusChangeMessage(serial, oldStatus, newStatus, config) {
    const oldN = normalizeStatus(oldStatus);
    const newN = normalizeStatus(newStatus);
    if (oldN && newN && oldN !== newN) {
        return `${serial}: ${oldStatus} → ${newStatus}`;
    }
    return config.message(serial);
}

function emitPopupToUsers(usernames, payload) {
    const io = getIO();
    if (!io || !usernames.length) return;
    const seen = new Set();
    usernames.forEach((username) => {
        const key = String(username).trim();
        if (!key || seen.has(key.toLowerCase())) return;
        seen.add(key.toLowerCase());
        io.emit('notification-update', {
            username: key,
            type: 'popup-only',
            ...payload,
        });
    });
}

/**
 * Notify users who can view the page mapped to `newStatus`.
 * @param {object} requirement - formatted requirement row
 * @param {string} oldStatus
 * @param {string} newStatus
 * @param {object} [options]
 */
async function notifyRequirementStatusChange(
    requirement,
    oldStatus,
    newStatus,
    options = {},
) {
    const oldN = normalizeStatus(oldStatus);
    const newN = normalizeStatus(newStatus);
    if (!newN || oldN === newN) return;

    if (newN === 'receive done') {
        await notifyReceiveDoneChange(requirement, {
            ...options,
            oldStatus: oldStatus || options.oldStatus,
        });
        return;
    }

    const config = STATUS_NOTIFY_CONFIG[newN];
    if (!config) return;

    const users = await getUsernamesForPage(config.pageId);
    const serial = serialLabel(requirement);
    const message =
        typeof options.message === 'string' && options.message.trim()
            ? options.message.trim()
            : statusChangeMessage(serial, oldStatus, newStatus, config);

    emitPopupToUsers(users, {
        title: options.title || config.title,
        message,
        serial_number: requirement.serial_number,
        sr_no: requirement['sr.no'],
        href: config.href,
        new_status: newStatus,
        old_status: oldStatus || null,
        event_id: buildEventId(requirement, newStatus),
        added_count: 1,
    });
}

/** Receive Done: page users + require person; receive-issue also notifies review/require. */
async function notifyReceiveDoneChange(requirement, options = {}) {
    const io = getIO();
    if (!io) return;

    const serial = serialLabel(requirement);
    const orderStatusLower = String(
        requirement.order_status || options.orderStatus || '',
    )
        .toLowerCase()
        .trim();
    const isReceiveIssue =
        options.isReceiveIssue === true ||
        orderStatusLower === 'receive issue' ||
        orderStatusLower === 'receiveissue' ||
        orderStatusLower.includes('receive issue');

    if (isReceiveIssue) {
        const msg = `${serial} requirement has a receive issue`;
        const recipients = new Set(
            [requirement.review_person, requirement.require_person_name]
                .map((u) => String(u || '').trim())
                .filter(Boolean),
        );
        emitPopupToUsers([...recipients], {
            title: 'Receive Issue',
            message: msg,
            serial_number: requirement.serial_number,
            sr_no: requirement['sr.no'],
            href: '/r2r/receive-items',
            new_status: 'Receive Done',
            event_id: buildEventId(requirement, 'receive-issue'),
            added_count: 1,
        });
        return;
    }

    const config = STATUS_NOTIFY_CONFIG['receive done'];
    const pageUsers = await getUsernamesForPage(config.pageId);
    const msg = statusChangeMessage(
        serial,
        options.oldStatus,
        'Receive Done',
        config,
    );
    emitPopupToUsers(pageUsers, {
        title: config.title,
        message: msg,
        serial_number: requirement.serial_number,
        sr_no: requirement['sr.no'],
        href: config.href,
        new_status: 'Receive Done',
        old_status: options.oldStatus || null,
        event_id: buildEventId(requirement, 'Receive Done'),
        added_count: 1,
    });

    const requirePerson = String(requirement.require_person_name || '').trim();
    if (requirePerson) {
        emitPopupToUsers([requirePerson], {
            title: 'Your Requirement Received',
            message: `Your ${serial} requirement was received`,
            serial_number: requirement.serial_number,
            sr_no: requirement['sr.no'],
            href: '/r2r/receive-items',
            new_status: 'Receive Done',
            event_id: buildEventId(requirement, 'Receive Done-person'),
            added_count: 1,
        });
    }
}

/** One combined popup after BOM import creates many Request Review rows. */
async function notifyBomBatchCreated(rows) {
    const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
    if (list.length === 0) return;

    const config = STATUS_NOTIFY_CONFIG['request review'];
    if (!config) return;

    const labels = labelsFromRows(list);
    const { count, preview, more } = previewText(labels);
    const users = await getUsernamesForPage(config.pageId);

    const title = count === 1 ? 'New Requirement' : 'BOM Requirements Created';
    const message =
        count === 1
            ? `${labels[0]} created — now review`
            : `${count} requirements created from BOM — now review: ${preview}${more}`;

    emitPopupToUsers(users, {
        title,
        message,
        added_count: count,
        serial_numbers: labels,
        serial_number: list[0]?.serial_number,
        sr_no: list[0]?.['sr.no'],
        href: config.href,
        new_status: 'Request Review',
        event_id: `bom-batch-${Date.now()}`,
    });
}

/** One combined popup when many rows reach the same status (e.g. bulk verify). */
async function notifyBulkRequirementStatusChange(rows, newStatus) {
    const list = Array.isArray(rows) ? rows : [];
    if (list.length === 0) return;

    const newN = normalizeStatus(newStatus);
    const config = STATUS_NOTIFY_CONFIG[newN];
    if (!config) return;

    const labels = labelsFromRows(list);
    const { count, preview, more } = previewText(labels);
    const users = await getUsernamesForPage(config.pageId);

    const title = count === 1 ? config.title : config.bulkTitle;
    const message =
        count === 1
            ? config.message(labels[0])
            : config.bulkMessage(count, preview, more);

    emitPopupToUsers(users, {
        title,
        message,
        added_count: count,
        serial_numbers: labels,
        serial_number: list[0]?.serial_number,
        sr_no: list[0]?.['sr.no'],
        href: config.href,
        new_status: newStatus,
        event_id: `bulk-${normalizeStatus(newStatus)}-${Date.now()}`,
    });
}

/**
 * One combined desktop popup after bulk receive.
 * Receive Done → receive-items page users + require persons.
 * Receive Issue → review/require persons.
 */
async function notifyBulkReceiveDone(rows) {
    const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
    if (list.length === 0) return;

    const issueRows = [];
    const doneRows = [];
    for (const row of list) {
        const orderStatusLower = String(row.order_status ?? '')
            .toLowerCase()
            .trim();
        const isReceiveIssue =
            orderStatusLower === 'receive issue' ||
            orderStatusLower === 'receiveissue' ||
            (orderStatusLower.includes('receive issue') &&
                !orderStatusLower.includes('received with issue'));
        if (isReceiveIssue) issueRows.push(row);
        else doneRows.push(row);
    }

    if (doneRows.length > 0) {
        await notifyBulkRequirementStatusChange(doneRows, 'Receive Done');

        const byPerson = new Map();
        for (const row of doneRows) {
            const person = String(row.require_person_name ?? '').trim();
            if (!person) continue;
            if (!byPerson.has(person)) byPerson.set(person, []);
            byPerson.get(person).push(row);
        }

        for (const [person, personRows] of byPerson) {
            const labels = labelsFromRows(personRows);
            const { count, preview, more } = previewText(labels);
            emitPopupToUsers([person], {
                title:
                    count === 1
                        ? 'Your Requirement Received'
                        : 'Your Requirements Received',
                message:
                    count === 1
                        ? `Your ${labels[0]} requirement was received`
                        : `${count} of your requirements were received: ${preview}${more}`,
                added_count: count,
                serial_numbers: labels,
                serial_number: personRows[0]?.serial_number,
                sr_no: personRows[0]?.['sr.no'],
                href: '/r2r/receive-items',
                new_status: 'Receive Done',
                event_id: `bulk-receive-done-person-${person}-${Date.now()}`,
            });
        }
    }

    if (issueRows.length > 0) {
        const labels = labelsFromRows(issueRows);
        const { count, preview, more } = previewText(labels);
        const recipients = new Set();
        for (const row of issueRows) {
            for (const u of [row.review_person, row.require_person_name]) {
                const key = String(u ?? '').trim();
                if (key) recipients.add(key);
            }
        }
        if (recipients.size > 0) {
            emitPopupToUsers([...recipients], {
                title: count === 1 ? 'Receive Issue' : 'Receive Issues',
                message:
                    count === 1
                        ? `${labels[0]} requirement has a receive issue`
                        : `${count} requirement(s) have a receive issue: ${preview}${more}`,
                added_count: count,
                serial_numbers: labels,
                serial_number: issueRows[0]?.serial_number,
                sr_no: issueRows[0]?.['sr.no'],
                href: '/r2r/receive-items',
                new_status: 'Receive Done',
                event_id: `bulk-receive-issue-${Date.now()}`,
            });
        }
    }
}

export {
    STATUS_NOTIFY_CONFIG,
    normalizeStatus,
    notifyRequirementStatusChange,
    notifyBomBatchCreated,
    notifyBulkRequirementStatusChange,
    notifyBulkReceiveDone,
    notifyReceiveDoneChange,
    getUsernamesForPage,
};
