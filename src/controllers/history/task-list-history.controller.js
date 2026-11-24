import TaskListHistoryModel from '../../models/history/task-list-history.model.js';
import { getUserIdFromReq, writeAuditLog } from '../../utils/audit.utils.js';
import { updateProjectProcessCheckedIds, toggleProjectProcessCheckedId } from '../../utils/project.utils.js';
import { resolveProcessCheckedScope } from '../../utils/projectProcessChecked.utils.js';

class TaskListHistoryController {
    static async log(req, res) {
        try {
            const { process_id, user_id, checked, project_code, project_id, pcb_id } = req.body || {};
            const actorUserId = getUserIdFromReq(req) ?? (user_id != null ? parseInt(String(user_id), 10) : null);
            if (process_id == null) {
                return res.status(400).json({ success: false, message: 'process_id is required' });
            }
            const row = await TaskListHistoryModel.create({
                process_id,
                user_id: user_id ?? req.body?.userId ?? null,
                checked: checked === true || checked === 'true',
                project_code: project_code || req.body?.projectCode || null,
                project_id: project_id ?? req.body?.projectId ?? null,
                pcb_id: pcb_id ?? req.body?.pcbId ?? null
            });
            const pid = project_id ?? req.body?.projectId ?? null;
            const pcode = project_code || req.body?.projectCode || null;
            const pcbId = pcb_id ?? req.body?.pcbId ?? null;
            const processScope = resolveProcessCheckedScope(pcbId);
            const isChecked = checked === true || checked === 'true';
            const addedIds = req.body?.added_ids ?? req.body?.addedIds;
            const removedIds = req.body?.removed_ids ?? req.body?.removedIds;

            if (pid) {
                if (addedIds !== undefined || removedIds !== undefined) {
                    await updateProjectProcessCheckedIds(
                        pid,
                        pcode,
                        {
                            addIds: addedIds || [],
                            removeIds: removedIds || [],
                        },
                        processScope,
                    );
                } else if (process_id != null) {
                    await toggleProjectProcessCheckedId(
                        pid,
                        pcode,
                        process_id,
                        isChecked,
                        processScope,
                    );
                }
            }

            // Audit log (best-effort)
            try {
                
                await writeAuditLog(req, {
                    action: 'CREATE',
                    tableName: 'task_list_history',
                    tableOfId: row?.id ?? null,
                    tableOfColumn: 'id',
                    oldValue: null,
                    newValue: row,
                    userId: actorUserId,
                });
            } catch (e) {
                console.error('Audit log write failed (task list history create):', e.message || e);
            }

            res.status(201).json({ success: true, history: row });
        } catch (error) {
            console.error('Error logging task list history:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to log task history',
                error: error?.message
            });
        }
    }

    static async list(req, res) {
        try {
            const { project_code, project_id, process_id, user_id, limit } = req.query;
            const rows = await TaskListHistoryModel.findByProject({
                project_code,
                project_id,
                process_id,
                user_id,
                limit
            });
            res.json({ success: true, history: rows });
        } catch (error) {
            console.error('Error fetching task list history:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch task history',
                error: error?.message
            });
        }
    }
}

export default TaskListHistoryController;
