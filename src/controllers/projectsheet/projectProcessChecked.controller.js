import ProjectProcessCheckedModel from '../../models/projectsheet/projectProcessChecked.model.js';
import ProjectModel from '../../models/projectsheet/project.model.js';
import {
    createMainProjectProcessChecked,
    createOrUpdatePcbProjectProcessChecked,
    deletePcbProjectProcessChecked,
    findProjectProcessCheckedRow,
    MAIN_PROCESS_SCOPE,
    resolveProcessCheckedScope,
    recalculateProjectOverallCompletion,
} from '../../utils/projectProcessChecked.utils.js';
import {
    getProjectProcessChecked,
    parseProcessIdsToArray,
    toggleProjectProcessCheckedId,
    updateProjectProcessCheckedIds,
} from '../../utils/project.utils.js';
import { getUserIdFromReq, writeAuditLog, pickChangedColumns } from '../../utils/audit.utils.js';
import { AppError, wrapController } from '../../middleware/error.middleware.js';

function formatRow(row) {
    if (!row) return null;

    return {
        id: row.id,
        project_id: row.project_id,
        project_code: row.project_code,
        main_or_pcb_id: row.main_or_pcb_id,
        scope: row.main_or_pcb_id,
        total_process_id: parseProcessIdsToArray(row.total_process_id),
        checked_id: parseProcessIdsToArray(row.checked_id),
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

async function resolveProjectContext(projectId, projectCode) {
    if (projectId != null && projectId !== '') {
        const project = await ProjectModel.findById(parseInt(projectId, 10));
        if (project) {
            return {
                projectId: project.id,
                projectCode: project.project_code || projectCode || null,
            };
        }
    }

    if (projectCode != null && String(projectCode).trim() !== '') {
        const project = await ProjectModel.findByCode(String(projectCode).trim());
        if (project) {
            return {
                projectId: project.id,
                projectCode: project.project_code,
            };
        }
    }

    return null;
}

class ProjectProcessCheckedController {
    static async list(req, res) {
        const rows = await ProjectProcessCheckedModel.findAll(req.query || {});
        res.json({
            success: true,
            projectProcessChecked: rows.map(formatRow),
        });
    }

    static async getById(req, res) {
        const row = await ProjectProcessCheckedModel.findById(req.params.id);
        if (!row) {
            throw new AppError('Project process checked row not found', 404);
        }

        res.json({
            success: true,
            projectProcessChecked: formatRow(row),
        });
    }

    static async getByProject(req, res) {
        const rows = await ProjectProcessCheckedModel.findByProjectId(
            req.params.projectId,
        );
        res.json({
            success: true,
            projectProcessChecked: rows.map(formatRow),
        });
    }

    static async getByProjectScope(req, res) {
        const row = await ProjectProcessCheckedModel.findByProjectAndScope(
            req.params.projectId,
            req.params.scope,
        );
        if (!row) {
            throw new AppError('Project process checked row not found', 404);
        }

        res.json({
            success: true,
            projectProcessChecked: formatRow(row),
        });
    }

    static async upsert(req, res) {
        const body = req.body || {};
        const ctx = await resolveProjectContext(body.project_id, body.project_code);

        if (!ctx) {
            throw new AppError('Valid project_id or project_code is required', 400);
        }

        const scope = resolveProcessCheckedScope(
            body.main_or_pcb_id ?? body.scope ?? body.pcb_id ?? MAIN_PROCESS_SCOPE,
        );
        const hasProcessIds =
            body.total_process_id !== undefined ||
            body.process_ids !== undefined ||
            body.totalProcessId !== undefined;
        const userId = getUserIdFromReq(req);

        const before = await findProjectProcessCheckedRow(ctx.projectId, scope);

        let row = before;
        if (hasProcessIds) {
            const processIds =
                body.total_process_id ?? body.process_ids ?? body.totalProcessId ?? [];
            if (scope === MAIN_PROCESS_SCOPE) {
                row = await createMainProjectProcessChecked({
                    projectId: ctx.projectId,
                    projectCode: ctx.projectCode,
                    processIds,
                });
            } else {
                row = await createOrUpdatePcbProjectProcessChecked({
                    projectId: ctx.projectId,
                    projectCode: ctx.projectCode,
                    pcbId: scope,
                    processIds,
                });
            }
        }

        if (
            body.checked_id !== undefined ||
            body.checked_ids !== undefined ||
            body.checked_tasks !== undefined
        ) {
            const checkedIds = parseProcessIdsToArray(
                body.checked_id ?? body.checked_ids ?? body.checked_tasks,
            );
            const previousChecked = parseProcessIdsToArray(
                before?.checked_id ?? row?.checked_id,
            );
            const taskScopeIds = parseProcessIdsToArray(
                body.task_scope_ids ?? body.scoped_checked_ids ?? body.taskScopeIds,
            );

            let addIds;
            let removeIds;
            if (taskScopeIds.length > 0) {
                // Only mutate checks that belong to the current process task list.
                const scopeSet = new Set(taskScopeIds);
                const checkedInScope = new Set(
                    checkedIds.filter((id) => scopeSet.has(id)),
                );
                addIds = [...checkedInScope].filter((id) => !previousChecked.includes(id));
                removeIds = taskScopeIds.filter(
                    (id) => previousChecked.includes(id) && !checkedInScope.has(id),
                );
            } else {
                // Legacy full-replace: treat payload as complete checked list.
                addIds = checkedIds;
                removeIds = previousChecked.filter((id) => !checkedIds.includes(id));
            }

            row =
                (await updateProjectProcessCheckedIds(
                ctx.projectId,
                ctx.projectCode,
                {
                    addIds,
                    removeIds,
                },
                scope,
            )) ?? row;
        }

        try {
            const patch = pickChangedColumns(
                before ? formatRow(before) : null,
                formatRow(row),
                ['total_process_id', 'checked_id'],
            );
            await writeAuditLog(req, {
                action: before ? 'UPDATE' : 'CREATE',
                tableName: 'projects_process_checked',
                tableOfId: row?.id ?? null,
                tableOfColumn: patch.columns.join(','),
                oldValue: patch.oldValue,
                newValue: patch.newValue,
                userId,
            });
        } catch (e) {
            console.error('Audit log write failed (projects_process_checked upsert):', e.message || e);
        }

        let overall_completion = null;
        try {
            overall_completion = await recalculateProjectOverallCompletion(ctx.projectId);
        } catch (e) {
            console.error('overall_completion recalculate failed (upsert):', e.message || e);
        }

        res.status(before ? 200 : 201).json({
            success: true,
            message: before
                ? 'Project process checked updated successfully'
                : 'Project process checked created successfully',
            projectProcessChecked: formatRow(row),
            overall_completion,
        });
    }

    static async patchChecked(req, res) {
        const { projectId, scope } = req.params;
        const body = req.body || {};
        const ctx = await resolveProjectContext(projectId, body.project_code);
        const resolvedScope = resolveProcessCheckedScope(scope);
        const userId = getUserIdFromReq(req);

        if (!ctx) {
            throw new AppError('Valid project is required', 400);
        }

        const before = await getProjectProcessChecked(ctx.projectId, resolvedScope);
        let row = null;

        if (body.process_id != null && body.checked !== undefined) {
            row = await toggleProjectProcessCheckedId(
                ctx.projectId,
                ctx.projectCode,
                body.process_id,
                body.checked === true || body.checked === 'true',
                resolvedScope,
            );
        } else {
            row = await updateProjectProcessCheckedIds(
                ctx.projectId,
                ctx.projectCode,
                {
                    addIds: body.add_ids ?? body.addIds ?? [],
                    removeIds: body.remove_ids ?? body.removeIds ?? [],
                },
                resolvedScope,
            );
        }

        if (!row) {
            throw new AppError('Project process checked row not found', 404);
        }

        try {
            const patch = pickChangedColumns(
                before ? formatRow(before) : null,
                formatRow(row),
                ['checked_id'],
            );
            await writeAuditLog(req, {
                action: 'UPDATE',
                tableName: 'projects_process_checked',
                tableOfId: row?.id ?? null,
                tableOfColumn: patch.columns.join(','),
                oldValue: patch.oldValue,
                newValue: patch.newValue,
                userId,
            });
        } catch (e) {
            console.error('Audit log write failed (projects_process_checked patch):', e.message || e);
        }

        let overall_completion = null;
        try {
            overall_completion = await recalculateProjectOverallCompletion(ctx.projectId);
        } catch (e) {
            console.error('overall_completion recalculate failed (patch):', e.message || e);
        }

        res.json({
            success: true,
            message: 'Checked process ids updated successfully',
            projectProcessChecked: formatRow(row),
            overall_completion,
        });
    }

    static async remove(req, res) {
        const row = await ProjectProcessCheckedModel.findById(req.params.id);
        if (!row) {
            throw new AppError('Project process checked row not found', 404);
        }

        const scope = String(row.main_or_pcb_id ?? '').trim();
        if (scope && scope !== MAIN_PROCESS_SCOPE) {
            await deletePcbProjectProcessChecked(row.project_id, scope);
        } else {
            await ProjectProcessCheckedModel.deleteById(row.id);
        }

        try {
            await writeAuditLog(req, {
                action: 'DELETE',
                tableName: 'projects_process_checked',
                tableOfId: row.id,
                tableOfColumn: 'id',
                oldValue: formatRow(row),
                newValue: null,
                userId: getUserIdFromReq(req),
            });
        } catch (e) {
            console.error('Audit log write failed (projects_process_checked delete):', e.message || e);
        }

        res.json({
            success: true,
            message: 'Project process checked row deleted successfully',
        });
    }
}

wrapController(ProjectProcessCheckedController, [
    'list',
    'getById',
    'getByProject',
    'getByProjectScope',
    'upsert',
    'patchChecked',
    'remove',
]);

export default ProjectProcessCheckedController;
