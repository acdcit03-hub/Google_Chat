
import { AppError, wrapController } from '../../middleware/error.middleware.js';
import IssueModel from '../../models/r2r/issue.model.js';
import { pool } from '../../config/db.js';
import { getIO, broadcast } from '../../config/socket.js';
import { getUserIdFromReq, writeAuditLog, pickChangedColumns } from '../../utils/audit.utils.js';
import { buildIssueSocketPayload, emitIssueSocket } from '../../utils/notification/r2rDesktopNotify.js';
import { getPersonalDetailsIdByUsername, getUsernamesForPage } from '../../utils/userPermission.utils.js';
import { recordRequirementStatusChange } from '../../models/r2r/requirementStatus.model.js';
import {
    createIssueReportedReadNotification,
    READ_NOTIFY_ISSUE_REPORTED,
} from '../../utils/notification/readNotificationNotify.js';
import ReadNotificationModel from '../../models/r2r/receiveIssueResponse.model.js';

class IssueController {
    // Optimized: Parallel table check and fetch
    static async getAllIssues(req, res) {
        const { username, page_name } = req.query;

        // Parallel: Check if ISSUE table exists
        const issueTableCheck = await pool.query(`
                SELECT table_name 
                FROM information_schema.tables 
                WHERE table_name = 'ISSUE'
            `);
        const hasIssueTable = issueTableCheck.rows.length > 0;

        if (!hasIssueTable) {
            return res.json({
                success: true,
                issues: []
            });
        }

        // If page_name is provided, return all issues with that page_name
        if (page_name && !username) {
            const issues = await IssueModel.findAll({ pageName: page_name });
            return res.json({
                success: true,
                issues
            });
        }

        // If username is provided, get issues for that user
        if (username) {
            const normalizedUsername = username.trim();

            // Fetch user permissions first to decide if they should see broadcasted items
            const userId = await getPersonalDetailsIdByUsername(normalizedUsername);
            let specialIssues = [];

            if (userId) {
                const permissionResult = await pool.query(
                    `SELECT 1 FROM user_page_permissions 
                         WHERE user_id = $1 AND page_id = 'request-review' AND can_view = true`,
                    [userId]
                );
                if (permissionResult.rows.length > 0) {
                    // User is part of review team - they should see UNASSIGNED issues from "In Store check" or "Purchase"
                    const inStoreIssues = await IssueModel.findAll({
                        pageName: 'In Store check',
                        receiveUsername: null
                    });
                    const purchaseIssues = await IssueModel.findAll({
                        pageName: 'Purchase',
                        receiveUsername: null
                    });
                    specialIssues = [...inStoreIssues, ...purchaseIssues];
                }
            }

            const personalIssues = await IssueModel.findAll({ receiveUsername: normalizedUsername });

            // Combine and remove duplicates based on sr.no
            const allIssuesMap = new Map();
            [...personalIssues, ...specialIssues].forEach(issue => {
                allIssuesMap.set(issue['sr.no'], issue);
            });
            const issues = Array.from(allIssuesMap.values());

            console.log(`[GET /api/issues] Query for username: "${normalizedUsername}"`);
            console.log(`[GET /api/issues] Found ${issues.length} total issues (Personal: ${personalIssues.length}, Special/Broadcast: ${specialIssues.length})`);

            return res.json({
                success: true,
                issues
            });
        }

        // If neither username nor page_name is provided, return error
        throw new AppError('Username or page_name is required', 400);
    }

    // Optimized: Parallel validation and creation
    static async createIssue(req, res) {
        // Parallel: Check if ISSUE table exists
        const issueTableCheck = await pool.query(`
                SELECT table_name 
                FROM information_schema.tables 
                WHERE table_name = 'ISSUE'
            `);
        const hasIssueTable = issueTableCheck.rows.length > 0;

        if (!hasIssueTable) {
            throw new AppError('ISSUE table does not exist. Please run migration 013_create_issue_table.sql', 400);
        }

        const newIssue = await IssueModel.create(req.body);

        const pageLower = String(newIssue.page_name ?? '').trim().toLowerCase();
        const orderLower = String(newIssue.order_status ?? '').trim().toLowerCase();
        const isReceiveIssue =
            pageLower === 'receive issue' ||
            orderLower === 'receive issue';

        // All non–Receive Issue alerts also go to READ_NOTIFICATION for sidebar.
        if (!isReceiveIssue && newIssue.receive_username) {
            try {
                const row = await createIssueReportedReadNotification({
                    requirementId: newIssue.requirement_id,
                    serialNumber: newIssue.serial_number,
                    senderUsername: newIssue.sender_username,
                    receiveUsername: newIssue.receive_username,
                    pageName: newIssue.page_name,
                    note: newIssue.notes,
                    originStatus: newIssue.issue_order_status || newIssue.order_status,
                    issueId: newIssue['sr.no'] ?? newIssue.id,
                });
                if (row) {
                    emitIssueSocket(
                        buildIssueSocketPayload({
                            username: newIssue.receive_username,
                            socketType: 'issue-reported',
                            title: 'Issue reported',
                            message: row.message,
                            requirement_id: newIssue.requirement_id,
                            issue: row,
                            page_name: newIssue.page_name,
                        }),
                    );
                }
            } catch (err) {
                console.error('Failed creating issue-reported READ_NOTIFICATION:', err);
            }
        }

        // Broadcast notification update (non-blocking)
        try {
            if (newIssue.receive_username) {
                const serial =
                    newIssue.serial_number ||
                    `SR-${newIssue.requirement_id}`;
                emitIssueSocket(
                    buildIssueSocketPayload({
                        username: newIssue.receive_username,
                        socketType: isReceiveIssue
                            ? 'receive-issue-reported'
                            : 'issue-created',
                        title: isReceiveIssue
                            ? 'Received with issue'
                            : 'Issue assigned to you',
                        message: `${serial}: issue reported`,
                        requirement_id: newIssue.requirement_id,
                        issue: newIssue,
                    }),
                );
            }
        } catch (broadcastErr) {
            console.error('Error broadcasting notification:', broadcastErr);
        }

        res.status(201).json({
            success: true,
            message: 'Issue reported successfully',
            issue: newIssue
        });
    }

    // Optimized: Parallel checks for forwarding
    static async forwardIssue(req, res) {
        const { id } = req.params;
        const userId = getUserIdFromReq(req);

        // Parallel: Check ISSUE table existence and get issue
        const [issueTableCheck, issueResult] = await Promise.all([
            pool.query(`
                    SELECT table_name 
                    FROM information_schema.tables 
                    WHERE table_name = 'ISSUE'
                `),
            pool.query('SELECT * FROM "ISSUE" WHERE "sr.no" = $1', [id])
        ]);

        const hasIssueTable = issueTableCheck.rows.length > 0;

        if (!hasIssueTable) {
            throw new AppError('ISSUE table does not exist', 400);
        }

        if (issueResult.rows.length === 0) {
            throw new AppError('Issue not found', 404);
        }

        const issue = issueResult.rows[0];
        const beforeIssue = issue;

        // Only allow forwarding issues from "In Store check" or "Purchase"
        if (issue.page_name !== 'In Store check' && issue.page_name !== 'Purchase') {
            throw new AppError('Only issues from In Store check or Purchase can be forwarded', 400);
        }

        // Get the requirement to find require_person_name
        const reqResult = await pool.query(
            'SELECT "require_person_name", "status", "serial_number" FROM "REQUIREMENT" WHERE "sr.no" = $1',
            [issue.requirement_id]
        );

        if (reqResult.rows.length === 0) {
            throw new AppError('Requirement not found', 404);
        }

        const requirePersonName = reqResult.rows[0].require_person_name;
        const previousStatus = reqResult.rows[0].status;

        if (!requirePersonName) {
            throw new AppError('Requirement does not have a require_person_name', 400);
        }

        // 1. Update the issue's receive_username to the require person
        const updatedIssue = await IssueModel.update(id, {
            receive_username: requirePersonName
        });

        // 2. Update the requirement's status and order_status to 'Issue'
        const updateResult = await pool.query(
            `UPDATE "REQUIREMENT" 
                 SET "status" = 'Issue', "order_status" = 'Issue', "updated_at" = CURRENT_TIMESTAMP 
                 WHERE "sr.no" = $1
                 RETURNING *`,
            [issue.requirement_id]
        );

        // 3. Broadcast requirement update so tables refresh
        if (updateResult.rows.length > 0) {
            const updatedReq = updateResult.rows[0];
            await recordRequirementStatusChange({
                serial_number: updatedReq.serial_number || reqResult.rows[0].serial_number,
                old_status: previousStatus,
                new_status: updatedReq.status,
            });
            broadcast('requirement-update', 'updated', updatedReq);
        }

        // 4. Sidebar notification for require_person_name (READ_NOTIFICATION).
        // Clear prior Purchase/In Store issue-reported copies for this requirement first.
        let readNotifyRow = null;
        try {
            const reqId = Number(issue.requirement_id);
            if (Number.isFinite(reqId)) {
                await ReadNotificationModel.deleteByRequirementAndType(
                    reqId,
                    READ_NOTIFY_ISSUE_REPORTED,
                );
            }

            readNotifyRow = await createIssueReportedReadNotification({
                requirementId: issue.requirement_id,
                serialNumber:
                    issue.serial_number || reqResult.rows[0].serial_number,
                senderUsername: issue.sender_username,
                receiveUsername: requirePersonName,
                pageName: issue.page_name,
                note: issue.notes,
                originStatus:
                    issue.issue_order_status || issue.order_status || 'Normal',
                issueId: issue['sr.no'] ?? id,
            });
        } catch (err) {
            console.error(
                'Failed creating forward issue READ_NOTIFICATION for require person:',
                err,
            );
        }

        // 5. Send real-time notification updates
        try {
            const io = getIO();
            if (io) {
                const serialLabel = issue.serial_number || `REQ-${issue.requirement_id}`;
                const forwardMessage = `${serialLabel} issue forwarded from ${issue.page_name}`.trim();

                // Require person: show in notification bar + desktop
                if (readNotifyRow) {
                    emitIssueSocket(
                        buildIssueSocketPayload({
                            username: requirePersonName,
                            socketType: 'issue-reported',
                            title: 'Issue assigned to you',
                            message: readNotifyRow.message || forwardMessage,
                            serial_number: issue.serial_number,
                            sr_no: issue.requirement_id,
                            requirement_id: issue.requirement_id,
                            issue: readNotifyRow,
                            page_name: issue.page_name,
                        }),
                    );
                } else {
                    emitIssueSocket(
                        buildIssueSocketPayload({
                            username: requirePersonName,
                            socketType: 'issue-created',
                            title: 'Issue assigned to you',
                            message: forwardMessage,
                            serial_number: issue.serial_number,
                            sr_no: issue.requirement_id,
                            requirement_id: issue.requirement_id,
                            issue: updatedIssue,
                            page_name: issue.page_name,
                        }),
                    );
                }

                // Request Review team: remove broadcast / prior sidebar item
                getUsernamesForPage('request-review').then((reviewUsernames) => {
                    reviewUsernames.forEach((username) => {
                        const name = String(username || '').trim();
                        if (!name) return;
                        io.emit('notification-update', {
                            username: name,
                            type: 'issue-forwarded',
                            requirement_id: issue.requirement_id,
                            sr_no: issue.requirement_id,
                            issue: updatedIssue,
                        });
                    });
                }).catch((err) => {
                    console.error('Error notifying request-review users:', err);
                });

                if (issue.receive_username) {
                    io.emit('notification-update', {
                        username: issue.receive_username,
                        type: 'issue-forwarded',
                        requirement_id: issue.requirement_id,
                        sr_no: issue.requirement_id,
                        issue: updatedIssue,
                    });
                }
            }
        } catch (broadcastErr) {
            console.error('Error broadcasting notifications:', broadcastErr);
        }

        res.json({
            success: true,
            message: 'Issue forwarded successfully to requester',
            issue: updatedIssue
        });

        // Audit log (best-effort) - ISSUE update
        try {
            const patch = pickChangedColumns(beforeIssue, updatedIssue, ['receive_username']);
            await writeAuditLog(req, {
                action: 'UPDATE',
                tableName: 'ISSUE',
                tableOfId: parseInt(id, 10),
                tableOfColumn: patch.columns.join(','),
                oldValue: patch.oldValue,
                newValue: patch.newValue,
                userId
            });
        } catch (e) {
            console.error('Audit log write failed (issue forward/update):', e.message || e);
        }
    }

    // Optimized: Parallel existence check and fetch
    static async deleteIssue(req, res) {
        const { id } = req.params;
        const userId = getUserIdFromReq(req);

        // Parallel: Check ISSUE table existence and get issue
        const [issueTableCheck, issueResult] = await Promise.all([
            pool.query(`
                    SELECT table_name 
                    FROM information_schema.tables 
                    WHERE table_name = 'ISSUE'
                `),
            pool.query('SELECT * FROM "ISSUE" WHERE "sr.no" = $1', [id])
        ]);

        const hasIssueTable = issueTableCheck.rows.length > 0;

        if (!hasIssueTable) {
            throw new AppError('ISSUE table does not exist', 400);
        }

        if (issueResult.rows.length === 0) {
            throw new AppError('Issue not found', 404);
        }

        const beforeIssue = issueResult.rows[0];
        const receiveUsername = beforeIssue.receive_username;
        const requirementId = beforeIssue.requirement_id;

        // Delete the issue
        const deleted = await IssueModel.delete(id);

        if (!deleted) {
            throw new AppError('Issue not found', 404);
        }

        // Clear matching sidebar copies (READ_NOTIFICATION) for this requirement.
        try {
            const reqId = Number(requirementId);
            if (Number.isFinite(reqId)) {
                await pool.query(
                    `DELETE FROM "READ_NOTIFICATION"
                     WHERE requirement_id = $1 AND notification_type = 'issue-reported'`,
                    [reqId],
                );
            }
        } catch (err) {
            console.error('Failed clearing issue-reported READ_NOTIFICATION on issue delete:', err);
        }

        // Broadcast notification update (non-blocking)
        if (receiveUsername) {
            try {
                const io = getIO();
                if (io) {
                    io.emit('notification-update', {
                        username: receiveUsername,
                        type: 'issue-dismissed'
                    });
                }
            } catch (broadcastErr) {
                console.error('Error broadcasting notification:', broadcastErr);
            }
        }

        res.json({
            success: true,
            message: 'Issue deleted successfully'
        });

        // Audit log (best-effort)
        try {
            await writeAuditLog(req, {
                action: 'DELETE',
                tableName: 'ISSUE',
                tableOfId: parseInt(id, 10),
                tableOfColumn: 'sr.no',
                oldValue: beforeIssue,
                newValue: null,
                userId
            });
        } catch (e) {
            console.error('Audit log write failed (issue delete):', e.message || e);
        }
    }

    // Optimized: Parallel operations for deleting issues by requirement
    static async deleteIssuesByRequirement(req, res) {
        const { id } = req.params;

        // Parallel: Check ISSUE table existence and get issue_order_status
        const [issueTableCheck, issuesResult] = await Promise.all([
            pool.query(`
                    SELECT table_name 
                    FROM information_schema.tables 
                    WHERE table_name = 'ISSUE'
                `),
            pool.query(
                `SELECT "issue_order_status" FROM "ISSUE"
                     WHERE "requirement_id" = $1
                     ORDER BY "created_at" DESC LIMIT 1`,
                [id]
            )
        ]);

        const hasIssueTable = issueTableCheck.rows.length > 0;

        if (!hasIssueTable) {
            return res.json({
                success: true,
                message: 'ISSUE table does not exist'
            });
        }

        if (issuesResult.rows.length === 0) {
            return res.json({
                success: true,
                message: 'No open issues for this requirement',
                restoredOrderStatus: null,
            });
        }

        const restoredOrderStatus =
            issuesResult.rows[0].issue_order_status &&
                String(issuesResult.rows[0].issue_order_status).trim()
                ? String(issuesResult.rows[0].issue_order_status).trim()
                : 'Normal';

        await IssueModel.deleteByRequirementId(id);

        try {
            await pool.query(
                `DELETE FROM "READ_NOTIFICATION"
                 WHERE requirement_id = $1 AND notification_type = 'issue-reported'`,
                [parseInt(id, 10)],
            );
        } catch (err) {
            console.error('Failed clearing issue-reported READ_NOTIFICATION:', err);
        }

        const beforeReq = await pool.query(
            'SELECT "status", "serial_number" FROM "REQUIREMENT" WHERE "sr.no" = $1',
            [id],
        );

        const updateResult = await pool.query(
            `UPDATE "REQUIREMENT"
                 SET "order_status" = $1,
                     "status" = 'Request Review',
                     "updated_at" = CURRENT_TIMESTAMP
                 WHERE "sr.no" = $2
                 RETURNING *`,
            [restoredOrderStatus, id],
        );

        const updatedRequirement =
            updateResult.rows.length > 0 ? updateResult.rows[0] : null;

        if (updatedRequirement) {
            await recordRequirementStatusChange({
                serial_number:
                    updatedRequirement.serial_number ||
                    beforeReq.rows[0]?.serial_number,
                old_status: beforeReq.rows[0]?.status,
                new_status: updatedRequirement.status,
            });
        }

        try {
            if (updatedRequirement) {
                broadcast('requirement-update', 'updated', updatedRequirement);
            }
            const io = getIO();
            if (io) {
                io.emit('notification-update', {
                    type: 'issue-resolved',
                    requirement_id: id,
                    sr_no: Number(id) || id,
                });
            }
        } catch (broadcastErr) {
            console.error('Error broadcasting issue resolve:', broadcastErr);
        }

        res.json({
            success: true,
            message: 'Issue resolved; requirement returned to Request Review',
            restoredOrderStatus,
            requirement: updatedRequirement,
        });
    }
}

wrapController(IssueController, [
    'getAllIssues',
    'createIssue',
    'forwardIssue',
    'deleteIssue',
    'deleteIssuesByRequirement',
]);
export default IssueController;
