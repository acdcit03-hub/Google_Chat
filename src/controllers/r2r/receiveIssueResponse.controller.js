import { AppError, wrapController } from '../../middleware/error.middleware.js';
import ReadNotificationModel from '../../models/r2r/receiveIssueResponse.model.js';
import {
    createIssueReportedReadNotification,
    createTerminateRequestedReadNotification,
    READ_NOTIFY_ISSUE_REPORTED,
    READ_NOTIFY_TERMINATE_REQUESTED,
} from '../../utils/notification/readNotificationNotify.js';
import {
    buildIssueSocketPayload,
    emitIssueSocket,
} from '../../utils/notification/r2rDesktopNotify.js';

class ReceiveIssueResponseController {
    /** GET /api/notifications?username=xxx&type=receive-issue-responded */
    static async getForUser(req, res) {
        const username = String(req.query.username ?? '').trim();
        if (!username) throw new AppError('username is required', 400);

        const type = String(req.query.type ?? '').trim();
        const rows = type
            ? await ReadNotificationModel.findForUserByType(username, type)
            : await ReadNotificationModel.findForUser(username);

        return res.json({ success: true, items: rows });
    }

    /**
     * POST /api/notifications
     * Create a READ_NOTIFICATION row (issue-reported, terminate-requested,
     * receive-issue-reported, or generic). Never writes to ISSUE.
     */
    static async create(req, res) {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const notificationType = String(
            body.notification_type ?? body.type ?? '',
        ).trim();
        const receiveUsername = String(body.receive_username ?? '').trim();
        const pageName = String(body.page_name ?? '').trim();

        if (!notificationType) {
            throw new AppError('notification_type is required', 400);
        }
        if (!receiveUsername) {
            throw new AppError('receive_username is required', 400);
        }

        let row = null;

        if (notificationType === READ_NOTIFY_ISSUE_REPORTED) {
            row = await createIssueReportedReadNotification({
                requirementId: body.requirement_id,
                serialNumber: body.serial_number,
                senderUsername: body.sender_username,
                receiveUsername,
                pageName,
                note: body.note ?? body.message,
                originStatus: body.origin_status ?? body.order_status,
                issueId: body.issue_id,
            });
        } else if (notificationType === READ_NOTIFY_TERMINATE_REQUESTED) {
            row = await createTerminateRequestedReadNotification({
                requirementId: body.requirement_id,
                serialNumber: body.serial_number,
                senderUsername: body.sender_username,
                receiveUsername,
                pageName,
                note: body.note ?? body.message,
                originStatus: body.origin_status ?? body.order_status,
                issueId: body.issue_id,
            });
        } else {
            row = await ReadNotificationModel.create({
                notification_type: notificationType,
                requirement_id: Number(body.requirement_id) || null,
                serial_number: String(body.serial_number ?? '').trim().slice(0, 100) || null,
                sender_username: String(body.sender_username ?? '').trim() || null,
                receive_username: receiveUsername,
                page_name: pageName || null,
                href: String(body.href ?? '').trim() || null,
                title: String(body.title ?? '').trim() || notificationType,
                message: String(body.message ?? body.note ?? '').trim() || null,
                meta:
                    body.meta && typeof body.meta === 'object' && !Array.isArray(body.meta)
                        ? body.meta
                        : {},
                is_read: false,
            });
        }

        if (!row) {
            throw new AppError('Failed to create notification', 500);
        }

        try {
            const socketType =
                notificationType === READ_NOTIFY_ISSUE_REPORTED
                    ? 'issue-reported'
                    : notificationType === READ_NOTIFY_TERMINATE_REQUESTED
                      ? 'terminate-requested'
                      : notificationType === 'receive-issue-reported'
                        ? 'receive-issue-reported'
                        : 'notification-created';
            emitIssueSocket(
                buildIssueSocketPayload({
                    username: receiveUsername,
                    socketType,
                    title: row.title || 'Notification',
                    message: row.message || '',
                    requirement_id: row.requirement_id,
                    serial_number: row.serial_number,
                    issue: row,
                    page_name: row.page_name,
                }),
            );
        } catch (err) {
            console.error('Failed emitting notification socket:', err);
        }

        return res.status(201).json({ success: true, item: row });
    }

    /** PATCH /api/notifications/:id/read */
    static async markRead(req, res) {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) throw new AppError('Invalid id', 400);

        const row = await ReadNotificationModel.markRead(id);
        return res.json({ success: true, item: row });
    }

    /** DELETE /api/notifications/:id */
    static async deleteById(req, res) {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) throw new AppError('Invalid id', 400);

        await ReadNotificationModel.deleteById(id);
        return res.json({ success: true });
    }
}

wrapController(ReceiveIssueResponseController, [
    'getForUser',
    'create',
    'markRead',
    'deleteById',
]);

export default ReceiveIssueResponseController;
