import ProcessMapModel from '../../models/projectsheet/updateProject.model.js';
import PCBModel from '../../models/projectsheet/pcb.model.js';
import PCBController from './pcb.controller.js';
import { AppError, wrapController } from '../../middleware/error.middleware.js';
import { broadcast } from '../../config/socket.js';
import { recalculateProjectOverallCompletion } from '../../utils/projectProcessChecked.utils.js';

class ProcessMapController {

    static async buildMergedProcessMap(project) {
        return ProcessMapModel.buildMergedProcessMap(project);
    }

    static async getProcessMap(req, res) {
        const { id } = req.params;

        const project = await ProcessMapModel.findProjectById(id);
        if (!project) {
            throw new AppError('Project not found', 404);
        }

        const processMap = await ProcessMapModel.buildMergedProcessMap(project);

        res.json({
            success: true,
            process_map: processMap,
        });
    }

    /**
     * GET /process-map/:id/main-processes
     * Top-level main processes only (PROCESS / PCB), with completion %.
     */
    static async getMainProcesses(req, res) {
        const { id } = req.params;

        const project = await ProcessMapModel.findProjectById(id);
        if (!project) {
            throw new AppError('Project not found', 404);
        }

        const processMap = await ProcessMapModel.buildMergedProcessMap(project);
        const main_processes = ProcessMapModel.toMainProcessSummaries(
            processMap.main_processes,
        );

        res.json({
            success: true,
            process_map: {
                main_processes,
            },
            overall_completion: ProcessMapModel.overallCompletionFromMainProcesses(
                processMap.main_processes,
            ),
        });
    }

    static async getCheckedProcessMap(req, res) {
        const { id } = req.params;
        const processName = typeof req.query?.process_name === 'string'
            ? req.query.process_name.trim()
            : '';
        const categoryLetter = typeof req.query?.category_letter === 'string'
            ? req.query.category_letter.trim()
            : '';
        const pcbId = req.query?.pcb_id != null
            ? String(req.query.pcb_id).trim()
            : '';

        const project = await ProcessMapModel.findProjectById(id);
        if (!project) {
            throw new AppError('Project not found', 404);
        }

        let processMap;
        let pcb = null;
        if (pcbId) {
            pcb = await PCBModel.findById(pcbId);
            if (!pcb || String(pcb.project_code) !== String(project.project_code)) {
                throw new AppError('PCB not found for this project', 404);
            }
            // Fold the PCB's ad-hoc custom_process into process_map here too,
            // so this PCB-scoped view (used by the checklist tab) matches
            // what the project-wide process map shows for the same PCB.
            pcb = await PCBController.mergePcbProcessAndCustom(pcb, {
                includeCustomProcessField: false,
            });
            processMap = pcb.process_map ?? {};
        } else {
            processMap = project.process_map ?? {};


            const customTopLevelNodes = ProcessMapModel.customProcessToMainProcessNodes(
                project.custom_process,
            );
            const mergedMainProcesses = await ProcessMapModel.applyCustomProcessExtraSubs(
                [...(processMap.main_processes || []), ...customTopLevelNodes],
                project.custom_process,
            );
            processMap = { ...processMap, main_processes: mergedMainProcesses };
        }

        if (processName) {
            const idsByName = await ProcessMapModel.findRootCategoryIdsByNames([processName], categoryLetter);
            const hasProcess = (nodes) => (nodes || []).some((node) =>
                String(node?.name ?? '').trim().toLowerCase() === processName.toLowerCase() ||
                hasProcess(node?.children),
            );

            // Only fall back to a freshly-built (unchecked) subtree when the
            // process is missing from whichever map we picked above — never
            // rebuild over a PCB's own saved checks.
            if (!hasProcess(processMap.main_processes) && idsByName.size > 0) {
                processMap = await ProcessMapModel.buildProcessMapFromCategoryIds(
                    id,
                    [...idsByName.values()],
                );
            }
            processMap = ProcessMapModel.filterProcessMapByTaskScope(
                processMap,
                [],
                processName,
            );
        }

        // PCB scope: show the PCB code itself as the main_process, with its
        // real processes (DESIGN, FIRMWARE, ...) nested as subprocesses —
        // matches how the process map is displayed everywhere else, instead
        // of the PCB's processes looking like top-level main processes.
        if (pcbId && pcb) {
            processMap = ProcessMapModel.wrapWithPcbRoot(processMap, pcb.pcb_code);
        }

        res.json({
            success: true,
            message: 'Checked process map fetched successfully',
            process_map: ProcessMapModel.sanitizeCustomCategoryType(processMap),
        });
    }

    static async updateProcessMap(req, res) {
        const { id } = req.params;
        const body = req.body || {};

        const project = await ProcessMapModel.findProjectById(id);
        if (!project) {
            throw new AppError('Project not found', 404);
        }

        const categoryLetter = typeof body.category_letter === 'string'
            ? body.category_letter.trim()
            : '';

        let mapData = body.process_map !== undefined ? body.process_map : body;
        if (typeof mapData === 'string') {
            try {
                mapData = JSON.parse(mapData);
            } catch (e) {
                throw new AppError('process_map must be valid JSON', 400);
            }
        }

        if (!mapData || typeof mapData !== 'object' || Array.isArray(mapData)) {
            throw new AppError('process_map is required and must be an object', 400);
        }

        const idListCandidate = Array.isArray(mapData.main_process_ids)
            ? mapData.main_process_ids
            : Array.isArray(mapData.main_processes)
                ? mapData.main_processes
                : null;

        const isPlainIdList =
            Array.isArray(idListCandidate) &&
            idListCandidate.length > 0 &&
            idListCandidate.every(
                (v) => typeof v === 'number' || typeof v === 'string',
            );

        if (isPlainIdList) {
            const subProcessIds = Array.isArray(mapData.sub_process_ids)
                ? mapData.sub_process_ids
                : [];
            mapData = await ProcessMapModel.buildProcessMapFromCategoryIds(
                id,
                idListCandidate,
                new Map(),
                subProcessIds,
            );
        } else if (Array.isArray(mapData.main_processes)) {

            const hasOwnChildren = (n) =>
                Array.isArray(n?.children) && n.children.length > 0;

            const needsExpansion = (n) =>
                n &&
                typeof n === 'object' &&
                typeof n.name === 'string' &&
                n.name.trim() !== '' &&
                !hasOwnChildren(n);

            const needsExpansionNames = mapData.main_processes
                .filter(needsExpansion)
                .map((n) => n.name);

            if (needsExpansionNames.length > 0) {
                const idsByName = await ProcessMapModel.findRootCategoryIdsByNames(
                    needsExpansionNames,
                    categoryLetter,
                );

                if (idsByName.size > 0) {
                    const taskCheckOverrides =
                        ProcessMapModel.collectTaskCheckOverridesByName(
                            mapData.main_processes,
                        );

                    const expanded = await ProcessMapModel.buildProcessMapFromCategoryIds(
                        id,
                        [...idsByName.values()],
                        taskCheckOverrides,
                    );
                    const expandedByName = new Map(
                        expanded.main_processes.map((n) => [n.name.trim(), n]),
                    );

                    mapData = {
                        ...mapData,
                        main_processes: mapData.main_processes.map((n) => {
                            if (!needsExpansion(n)) return n;
                            const key = n.name.trim();
                            return expandedByName.has(key)
                                ? expandedByName.get(key)
                                : n;
                        }),
                    };
                }
            }
        }

        if (!mapData || typeof mapData !== 'object' || Array.isArray(mapData)) {
            throw new AppError('process_map is required and must be an object', 400);
        }


        if (mapData && Array.isArray(mapData.main_processes)) {
            mapData = {
                ...mapData,
                main_processes: mapData.main_processes.filter(
                    (n) => n?.category_type !== 'PCB',
                ),
            };
        }

        const savedRow = await ProcessMapModel.upsertProcessMap({
            projectId: id,
            projectCode: project.project_code,
            map: mapData,
        });

        if (!savedRow) {
            throw new AppError('Failed to save process map', 500);
        }

        // Broadcast WebSocket update (non-blocking) so open clients refresh.
        try {
            broadcast('project-update', 'updated', {
                id: project.id,
                project_code: project.project_code,
                process_map: savedRow.process_map,
            });
        } catch (e) {
            console.error('Broadcast failed (process map update):', e.message || e);
        }

        let overall_completion = null;
        try {
            overall_completion = await recalculateProjectOverallCompletion(id);
        } catch (e) {
            console.error('overall_completion recalculate failed (process map update):', e.message || e);
        }

        res.json({
            success: true,
            message: 'Project process map updated successfully',
            process_map: savedRow.process_map,
            overall_completion,
        });
    }

  
    static async updateChecked(req, res) {
        const { id } = req.params;
        const body = req.body || {};

        const project = await ProcessMapModel.findProjectById(id);
        if (!project) {
            throw new AppError('Project not found', 404);
        }

        const checkedNames = Array.isArray(body.checked_names)
            ? body.checked_names
            : Array.isArray(body.checked_tasks)
                ? body.checked_tasks
                : [];

        const taskScopeNames = Array.isArray(body.task_scope_names)
            ? body.task_scope_names
            : [];
        const processName = typeof body.process_name === 'string'
            ? body.process_name.trim()
            : '';
        const categoryLetter = typeof body.category_letter === 'string'
            ? body.category_letter.trim()
            : '';

        const scopeRaw = body.pcb_id != null
            ? String(body.pcb_id).trim()
            : typeof body.scope === 'string'
                ? body.scope.trim()
                : '';
        const pcbId = scopeRaw && scopeRaw.toLowerCase() !== 'main' ? scopeRaw : '';

        let pcb = null;
        if (pcbId) {
            pcb = await PCBModel.findById(pcbId);
            if (!pcb || String(pcb.project_code) !== String(project.project_code)) {
                throw new AppError('PCB not found for this project', 404);
            }
        }

        let baseMap = pcbId ? (pcb.process_map ?? {}) : (await ProcessMapModel.findProcessMapByProjectId(id))?.process_map;

        if (!baseMap || !Array.isArray(baseMap.main_processes) || baseMap.main_processes.length === 0) {
         
            if (!processName) {
                throw new AppError('No process map found for this project', 404);
            }

            const idsByName = await ProcessMapModel.findRootCategoryIdsByNames(
                [processName],
                categoryLetter,
            );
            if (idsByName.size === 0) {
                throw new AppError('No process map found for this project', 404);
            }

            baseMap = await ProcessMapModel.buildProcessMapFromCategoryIds(
                id,
                [...idsByName.values()],
            );
        }

        if (processName) {
            const hasProcess = (nodes) => (nodes || []).some((node) =>
                String(node?.name ?? '').trim().toLowerCase() === processName.toLowerCase() ||
                hasProcess(node?.children),
            );

            if (!hasProcess(baseMap.main_processes)) {
                const idsByName = await ProcessMapModel.findRootCategoryIdsByNames([processName], categoryLetter);
                if (idsByName.size > 0) {
                    const selectedMap = await ProcessMapModel.buildProcessMapFromCategoryIds(
                        id,
                        [...idsByName.values()],
                    );
                    baseMap = {
                        ...baseMap,
                        main_processes: [
                            ...(baseMap.main_processes || []),
                            ...selectedMap.main_processes,
                        ],
                    };
                }
            }
        }

        const updatedMap = ProcessMapModel.applyCheckedTasks(
            baseMap,
            checkedNames,
            taskScopeNames,
        );

        let savedProcessMap;
        if (pcbId) {
            const savedPcb = await PCBModel.update(pcbId, {
                process_map: ProcessMapModel.normalizeMap(updatedMap),
            });
            if (!savedPcb) {
                throw new AppError('Failed to save checked tasks', 500);
            }
            savedProcessMap = savedPcb.process_map;
        } else {
            const savedRow = await ProcessMapModel.upsertProcessMap({
                projectId: id,
                projectCode: project.project_code,
                map: updatedMap,
            });
            if (!savedRow) {
                throw new AppError('Failed to save checked tasks', 500);
            }
            savedProcessMap = savedRow.process_map;
        }

        try {
            broadcast('project-update', 'updated', {
                id: project.id,
                project_code: project.project_code,
                pcb_id: pcbId || undefined,
                process_map: savedProcessMap,
            });
        } catch (e) {
            console.error('Broadcast failed (process map checked update):', e.message || e);
        }

        let responseMap = ProcessMapModel.filterProcessMapByTaskScope(
            savedProcessMap,
            taskScopeNames,
            processName,
        );

        // Same PCB-code-as-main_process wrapping as getCheckedProcessMap,
        // so the save response matches what a follow-up GET would show.
        if (pcbId && pcb) {
            responseMap = ProcessMapModel.wrapWithPcbRoot(responseMap, pcb.pcb_code);
        }

        let overall_completion = null;
        try {
            overall_completion = await recalculateProjectOverallCompletion(id);
        } catch (e) {
            console.error('overall_completion recalculate failed (checked update):', e.message || e);
        }

        res.json({
            success: true,
            message: 'Checked tasks updated successfully',
            process_map: responseMap,
            overall_completion,
        });
    }

    static async deleteProcessMap(req, res) {
        const { id } = req.params;

        const project = await ProcessMapModel.findProjectById(id);
        if (!project) {
            throw new AppError('Project not found', 404);
        }

        const deleted = await ProcessMapModel.deleteProcessMapByProjectId(id);
        if (!deleted) {
            throw new AppError('No process map found for this project', 404);
        }

        res.json({
            success: true,
            message: 'Project process map deleted successfully',
        });
    }
}

wrapController(ProcessMapController, [
    'getProcessMap',
    'getMainProcesses',
    'getCheckedProcessMap',
    'updateProcessMap',
    'updateChecked',
    'deleteProcessMap',
]);

export default ProcessMapController;