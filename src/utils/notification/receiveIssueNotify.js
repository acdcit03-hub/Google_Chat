import ReceiveIssueResponseModel from '../../models/r2r/receiveIssueResponse.model.js';
import { getIO } from '../../config/socket.js';
import { getUsernamesForPage } from '../userPermission.utils.js';
import { buildIssueSocketPayload, emitIssueSocket } from './r2rDesktopNotify.js';

export const RECEIVE_ISSUE_NOTIFY_PAGE = 'Receive Issue';
export const RECEIVE_ISSUE_RESPONSE_PAGE = 'Receive Items';
export const READ_NOTIFY_RECEIVE_ISSUE = 'receive-issue-reported';
export const PURCHASE_REQUEST_RECEIVE_ISSUE_HREF =
    '/r2r/purchase-request?filter=receiveIssue';
export const RECEIVE_ITEMS_HREF = '/r2r/receive-items';

function str(v) {
    return String(v ?? '').trim();
}

function buildReceiveIssueMeta(requirement) {
    return {
        item_name: str(requirement.product_name) || 'Item',
        remark: str(requirement.remark),
        serial_number: str(requirement.serial_number),
        requirement_id: String(requirement['sr.no'] ?? ''),
    };
}

export function isReceiveIssueRow(row) {
    if (!row) return false;
    const status = str(row.status).toLowerCase();
    const orderStatus = str(row.order_status).toLowerCase();
    return status === 'receive issue' || orderStatus === 'receive issue';
}

/**
 * Notify require person when store marks a requirement as Receive Issue.
 * Sidebar copy lives in READ_NOTIFICATION (dismiss-only — not ISSUE API).
 */
export async function notifyReceiveIssueToRequirePerson(
    requirement,
    senderUsername,
) {
    const receiveUser = str(requirement.require_person_name);
    if (!receiveUser) return null;

    const reqId = requirement['sr.no'];
    if (reqId == null || String(reqId).trim() === '') return null;

    const itemName = str(requirement.product_name) || 'Item';
    const remark = str(requirement.remark);
    const serial = str(requirement.serial_number) || `SR-${reqId}`;
    const sender = str(senderUsername) || 'System';

    const message = remark
        ? `${sender} — ${serial} — ${itemName}. Remark: ${remark}`
        : `${sender} — ${serial} — ${itemName}`;

    try {
        await ReceiveIssueResponseModel.deleteByRequirementTypeAndUser(
            Number(reqId),
            READ_NOTIFY_RECEIVE_ISSUE,
            receiveUser,
        );
    } catch (err) {
        console.error('Failed clearing prior receive-issue notifications:', err);
    }

    let row;
    try {
        row = await ReceiveIssueResponseModel.create({
            notification_type: READ_NOTIFY_RECEIVE_ISSUE,
            requirement_id: Number(reqId),
            serial_number: serial.slice(0, 100),
            sender_username: sender,
            receive_username: receiveUser,
            page_name: RECEIVE_ISSUE_NOTIFY_PAGE,
            href: PURCHASE_REQUEST_RECEIVE_ISSUE_HREF,
            title: 'Received with issue',
            message,
            meta: buildReceiveIssueMeta(requirement),
            is_read: false,
        });
    } catch (err) {
        console.error('Failed creating receive-issue READ_NOTIFICATION:', err);
        return null;
    }

    emitIssueSocket({
        ...buildIssueSocketPayload({
            username: receiveUser,
            socketType: READ_NOTIFY_RECEIVE_ISSUE,
            title: 'Received with issue',
            message,
            serial_number: serial,
            requirement_id: reqId,
            page_name: RECEIVE_ISSUE_NOTIFY_PAGE,
            issue: row,
        }),
        href: PURCHASE_REQUEST_RECEIVE_ISSUE_HREF,
    });

    return row;
}

export function isReceiveIssueResponseOrderStatus(orderStatus) {
    const s = str(orderStatus).toLowerCase();
    return s === 'accept by user' || s === 'decline by user';
}

function buildReceiveIssueResponseNotes(requirement, responseLabel) {
    return {
        item_name: str(requirement.product_name) || 'Item',
        serial_number: str(requirement.serial_number),
        requirement_id: String(requirement['sr.no'] ?? ''),
        response: responseLabel,
    };
}

/**
 * Notify receive-items page users when require person accepts / declines receive issue.
 */
export async function notifyReceiveIssueResponseToReceiveItemsUsers(
    requirement,
    orderStatus,
    senderUsername,
) {
    const responseLower = str(orderStatus).toLowerCase();
    if (!isReceiveIssueResponseOrderStatus(orderStatus)) return [];

    const responseLabel =
        responseLower === 'accept by user' ? 'Accept by User' : 'Decline by User';

    const reqId = requirement['sr.no'];
    if (reqId == null || String(reqId).trim() === '') return [];

    const itemName = str(requirement.product_name) || 'Item';
    const serial = str(requirement.serial_number) || `SR-${reqId}`;
    const message = `${serial} — ${itemName}: requirement ${responseLabel}`;

    let users = [];
    try {
        users = await getUsernamesForPage('receive-items');
    } catch (err) {
        console.error('Failed loading receive-items users for notification:', err);
        return [];
    }
    if (!users.length) return [];

    try {
        await ReceiveIssueResponseModel.deleteByRequirementAndType(
            Number(reqId),
            'receive-issue-responded',
        );
    } catch (err) {
        console.error('Failed clearing prior receive-issue response notifications:', err);
    }

    const sender = str(senderUsername) || 'User';
    const created = [];

    for (const username of users) {
        const receiveUser = str(username);
        if (!receiveUser) continue;

        try {
            const row = await ReceiveIssueResponseModel.create({
                notification_type: 'receive-issue-responded',
                requirement_id: Number(reqId),
                serial_number: serial.slice(0, 100),
                sender_username: sender,
                receive_username: receiveUser,
                page_name: RECEIVE_ISSUE_RESPONSE_PAGE,
                href: RECEIVE_ITEMS_HREF,
                title: `Requirement ${responseLabel}`,
                message,
                meta: buildReceiveIssueResponseNotes(requirement, responseLabel),
                is_read: false,
            });
            created.push(row);

            emitIssueSocket({
                ...buildIssueSocketPayload({
                    username: receiveUser,
                    socketType: 'receive-issue-responded',
                    title: `Requirement ${responseLabel}`,
                    message,
                    serial_number: serial,
                    requirement_id: reqId,
                    page_name: RECEIVE_ISSUE_RESPONSE_PAGE,
                    issue: row,
                }),
                href: RECEIVE_ITEMS_HREF,
            });
        } catch (err) {
            console.error(
                'Failed creating receive-issue response notification for',
                receiveUser,
                err,
            );
        }
    }

    return created;
}

/** Remove receive-issue sidebar notification when require person accepts / declines. */
export async function clearReceiveIssueNotifications(
    requirementId,
    receiveUsername,
) {
    const id = Number(requirementId);
    if (!Number.isFinite(id)) return;

    try {
        await ReceiveIssueResponseModel.deleteByRequirementAndType(
            id,
            READ_NOTIFY_RECEIVE_ISSUE,
        );
    } catch (err) {
        console.error('Failed clearing receive-issue READ_NOTIFICATION:', err);
        return;
    }

    const io = getIO();
    if (!io) return;

    const payload = {
        type: 'issue-resolved',
        requirement_id: id,
        sr_no: id,
    };
    const user = str(receiveUsername);
    if (user) {
        io.emit('notification-update', { ...payload, username: user });
    } else {
        io.emit('notification-update', payload);
    }
}
