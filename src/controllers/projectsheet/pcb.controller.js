import PCBModel from '../../models/projectsheet/pcb.model.js';
import ProcessMapModel from '../../models/projectsheet/updateProject.model.js';
import ProjectPcbVersionModel from '../../models/projectsheet/projectPcbVersion.model.js';
import { broadcastClientUpdate } from '../../config/socket.js';
import { pool } from '../../config/db.js';
import { getFinancialYearFromProjectCode, syncProjectProcessCheckedTotal } from '../../utils/project.utils.js';
import {
    createOrUpdatePcbProjectProcessChecked,
    deletePcbProjectProcessChecked,
    enrichPcbsWithProcessChecked,
    findProjectProcessCheckedRow,
    recalculateProjectOverallCompletion,
} from '../../utils/projectProcessChecked.utils.js';
import { getUserIdFromReq, getUsernameFromReq, writeAuditLog, pickChangedColumns } from '../../utils/audit.utils.js';
import { findPcbLogs, insertPcbFieldLogs } from '../../models/projectsheet/pcbLog.model.js';
import { resolveStatsScopeFromQuery } from '../../utils/dataScope.utils.js';
import { ensureProjectPcbFolders } from '../filemanager/projectFileManager.controller.js';
import { v2 as cloudinary } from 'cloudinary';
import dotenv from 'dotenv';
import { AppError, wrapController } from '../../middleware/error.middleware.js';
dotenv.config();

// Configure Cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

async function resolveProjectForPcb(projectCode) {
    const code = projectCode == null ? '' : String(projectCode).trim();
    if (!code) return null;

    const result = await pool.query(
        'SELECT id, project_code FROM "PROJECT" WHERE project_code = $1 LIMIT 1',
        [code],
    );
    return result.rows[0] || null;
}

async function categoryIdsForCheckedNames(names) {
    const cleanNames = [...new Set((names || [])
        .map((name) => String(name ?? '').trim())
        .filter(Boolean))];
    if (cleanNames.length === 0) return [];

    const result = await pool.query(
        `SELECT id
         FROM categories
         WHERE LOWER(TRIM(name)) = ANY($1::text[])`,
        [cleanNames.map((name) => name.toLowerCase())],
    );
    return result.rows.map((row) => Number(row.id)).filter((id) => Number.isFinite(id));
}

async function persistPcbProcessChecked(pcb, previousProjectId = null, overrides = {}) {
    if (!pcb?.id) return;

    const project = await resolveProjectForPcb(pcb.project_code);
    if (!project?.id) return;

    const projectId = parseInt(project.id, 10);
    const prevId =
        previousProjectId != null ? parseInt(previousProjectId, 10) : null;

    if (prevId && Number.isFinite(prevId) && prevId > 0 && prevId !== projectId) {
        await deletePcbProjectProcessChecked(prevId, pcb.id);
        await syncProjectProcessCheckedTotal(prevId);
    }

    const existing = await findProjectProcessCheckedRow(projectId, pcb.id);
    const processIds =
        overrides.processIds !== undefined
            ? overrides.processIds
            : existing?.total_process_id;
    const payload = {
        projectId,
        projectCode: project.project_code || pcb.project_code,
        pcbId: pcb.id,
        processIds,
    };
    // Only pass checkedIds when the caller is updating checks.
    // Passing the existing list here used to intersect it with parent
    // process IDs and wipe every descendant checked task.
    if (overrides.checkedIds !== undefined) {
        payload.checkedIds = overrides.checkedIds;
    }

    await createOrUpdatePcbProjectProcessChecked(payload);
    await syncProjectProcessCheckedTotal(projectId);
    try {
        await recalculateProjectOverallCompletion(projectId);
    } catch (e) {
        console.error('overall_completion recalculate failed (pcb):', e.message || e);
    }
}

async function afterPcbSaved(updatedPCB, beforePCB = null, overrides = {}) {
    if (!updatedPCB) return updatedPCB;

    if (overrides.checkedNames !== undefined) {
        const baseMap = updatedPCB.process_map ?? beforePCB?.process_map ?? {};
        const taskScopeNames = overrides.taskScopeNames ?? [];
        const project = await resolveProjectForPcb(updatedPCB.project_code);
        const checkedRow = project?.id
            ? await findProjectProcessCheckedRow(project.id, updatedPCB.id)
            : null;
        const scopeIds = await categoryIdsForCheckedNames(taskScopeNames);
        const checkedIds = await categoryIdsForCheckedNames(overrides.checkedNames);
        const previousCheckedIds = checkedRow?.checked_id
            ? (Array.isArray(checkedRow.checked_id)
                ? checkedRow.checked_id
                : String(checkedRow.checked_id).split(','))
            : [];
        const scopeSet = new Set(scopeIds);
        updatedPCB = {
            ...updatedPCB,
            process_map: ProcessMapModel.applyCheckedTasks(
                baseMap,
                overrides.checkedNames,
                taskScopeNames,
            ),
        };
        overrides = {
            ...overrides,
            processMap: updatedPCB.process_map,
            checkedIds: [
                ...new Set([
                    ...previousCheckedIds
                        .map((id) => Number(id))
                        .filter((id) => Number.isFinite(id) && !scopeSet.has(id)),
                    ...checkedIds,
                ]),
            ],
        };
    }

    if (overrides.processMap !== undefined) {
        updatedPCB = await PCBModel.update(updatedPCB.id, {
            process_map: overrides.processMap,
        });
    }

    let previousProjectId = null;
    if (
        beforePCB?.project_code &&
        updatedPCB.project_code &&
        String(beforePCB.project_code).trim() !== String(updatedPCB.project_code).trim()
    ) {
        const previousProject = await resolveProjectForPcb(beforePCB.project_code);
        previousProjectId = previousProject?.id ?? null;
    }

    await persistPcbProcessChecked(updatedPCB, previousProjectId, overrides);
    const [enriched] = await enrichPcbsWithProcessChecked([updatedPCB]);
    return enriched || updatedPCB;
}

async function savePcbFieldLog(req, before, updated, patch) {
    await insertPcbFieldLogs({
        pcbId: updated?.id ?? before?.id,
        pcbCode: updated?.pcb_code || before?.pcb_code,
        changed: patch,
        updatedBy: getUsernameFromReq(req),
    });
}

class PCBController {
    /**
     * PCB GET response: fold custom_process into process_map for display.
     * Custom nodes use category_type "CUSTOM" and keep their stored path
     * (e.g. "ujyyi", "FIRMWARE/ergg"). custom_process field is still returned.
     */
    static async mergePcbProcessAndCustom(pcb, { includeCustomProcessField = true } = {}) {
        if (!pcb) return pcb;

        const baseMainProcesses = Array.isArray(pcb?.process_map?.main_processes)
            ? pcb.process_map.main_processes
            : [];

        const resolvedCustomProcess = includeCustomProcessField
            ? await ProcessMapModel.customProcessToResolvedTree(pcb.custom_process)
            : undefined;

        // Drop previously folded CUSTOM nodes so re-merge is idempotent
        const stripCustomNodes = (nodes) => {
            if (!Array.isArray(nodes)) return [];
            return nodes
                .filter(
                    (node) =>
                        node !== null &&
                        typeof node === 'object' &&
                        !Array.isArray(node) &&
                        String(node?.category_type ?? '')
                            .trim()
                            .toUpperCase() !== 'CUSTOM',
                )
                .map((node) => ({
                    ...node,
                    children: stripCustomNodes(node.children),
                }));
        };

        const foldCustomsIntoProcess = async (processNodes, customEntryOrWhole) => {
            let process = stripCustomNodes(
                Array.isArray(processNodes) ? processNodes : [],
            );

            const topLevelSource = ProcessMapModel.isPcbProjectCustomProcessEntry(
                customEntryOrWhole,
            )
                ? Array.isArray(customEntryOrWhole.process)
                    ? customEntryOrWhole.process
                    : []
                : ProcessMapModel.customProcessToDedupedMainProcessNodes(
                      customEntryOrWhole,
                  );

            const topCustomNodes = (topLevelSource || [])
                .filter((node) => String(node?.name ?? '').trim())
                .filter((node) => node?.active !== false)
                .map((node) => ProcessMapModel.buildCustomDisplayNode(node));

            process = [...process, ...topCustomNodes];

            const extrasPayload = ProcessMapModel.isPcbProjectCustomProcessEntry(
                customEntryOrWhole,
            )
                ? {
                      categoryExtraSubs:
                          customEntryOrWhole.categoryExtraSubs &&
                          typeof customEntryOrWhole.categoryExtraSubs === 'object'
                              ? customEntryOrWhole.categoryExtraSubs
                              : {},
                  }
                : customEntryOrWhole;

            return ProcessMapModel.applyCustomProcessExtraSubs(
                process,
                extrasPayload,
            );
        };

        let cleanMainProcesses;
        if (ProcessMapModel.isPcbProjectWiseProcessMap(pcb.process_map)) {
            cleanMainProcesses = [];
            for (const entry of baseMainProcesses) {
                if (!ProcessMapModel.isPcbProjectProcessEntry(entry)) {
                    cleanMainProcesses.push(entry);
                    continue;
                }
                const customEntry = ProcessMapModel.getCustomProcessEntryForProject(
                    pcb.custom_process,
                    entry.project_code,
                );
                const process = await foldCustomsIntoProcess(
                    entry.process,
                    customEntry || { process: [], categoryExtraSubs: {} },
                );
                cleanMainProcesses.push({
                    ...entry,
                    process,
                });
            }
        } else {
            cleanMainProcesses = await foldCustomsIntoProcess(
                baseMainProcesses,
                pcb.custom_process,
            );
        }

        const merged = {
            ...pcb,
            process_map: {
                ...(pcb.process_map || {}),
                main_processes: cleanMainProcesses,
            },
        };

        if (includeCustomProcessField) {
            merged.custom_process =
                resolvedCustomProcess ?? pcb.custom_process ?? null;
        } else {
            delete merged.custom_process;
        }

        return merged;
    }

    static async getPCBStats(req, res) {
        const financialYear =
            req.query?.financialYear ?? req.query?.financial_year;
        const { scopeUsernames } = await resolveStatsScopeFromQuery(req.query);
        const stats = await PCBModel.getStats({
            ...req.query,
            financialYear,
            scopeUsernames,
        });

        res.json({
            success: true,
            stats: {
                total: Number(stats.total) || 0,
                uniqueProjects: Number(stats.uniqueProjects) || 0,
                currentYear: Number(stats.currentYear) || 0,
            },
        });
    }

    // Optimized: Fetch PCBs with parallel count and data queries
    static async getAllPCBs(req, res) {
        const {
                limit, offset, page, all,
                project_code, pcb_code, project_name, created_by, financialYear
            } = req.query;

            // Project tab bulk (all=true + current-year): skip FY so timeline keeps older FY PCBs.
            // PCB tab (paginated): FY from pcb_code last-4 MMYY (2026-27 → 0426..0327).
            // Project tab bulk with a specific FY: prefer project_code MMYY.
            const isBulk = all === 'true';
            const skipFinancialYear = isBulk && financialYear === 'current-year';
            const fyFromProjectCode = isBulk && !skipFinancialYear && !!financialYear && financialYear !== 'all';

            const filters = {
                limit: all === 'true' ? 10000 : (parseInt(limit) || 10),
                offset: parseInt(offset),
                page: parseInt(page) || 1,
                all,
                project_code,
                pcb_code,
                project_name,
                created_by,
                financialYear,
                skipFinancialYear,
                fyFromProjectCode,
                // Unique Projects card: one PCB per non-standard (not 15/17) project_code.
                uniqueProjects:
                    req.query?.unique_projects === 'true' ||
                    req.query?.unique_projects === true ||
                    req.query?.uniqueProjects === 'true' ||
                    req.query?.uniqueProjects === true,
            };

            const [countResult, dataResult] = await Promise.all([
                PCBModel.count(filters),
                PCBModel.findAll(filters)
            ]);

            const finalPcbs = await Promise.all(
                (await enrichPcbsWithProcessChecked(dataResult)).map((pcb) =>
                    PCBController.mergePcbProcessAndCustom(pcb, {
                        includeCustomProcessField: true,
                    }),
                ),
            );
            const finalTotal = countResult;

            const actualLimit = filters.limit;
            const actualOffset = filters.offset !== undefined && !isNaN(filters.offset) && filters.offset >= 0
                ? filters.offset
                : (filters.page - 1) * actualLimit;
            const actualPage = filters.page || 1;

            res.json({
                success: true,
                pcbs: finalPcbs,
                pagination: {
                    total: finalTotal,
                    limit: actualLimit,
                    offset: actualOffset,
                    page: actualPage,
                    totalPages: finalTotal > 0 ? Math.ceil(finalTotal / actualLimit) : 0,
                    hasNextPage: actualOffset + actualLimit < finalTotal,
                    hasPrevPage: actualOffset > 0
                }
            });
    }

    static async getPCBById(req, res) {
        const { id } = req.params;
        const pcb = await PCBModel.findById(id);
        if (!pcb) {
            throw new AppError('PCB not found', 404);
        }
        const [enrichedPcb] = await enrichPcbsWithProcessChecked([pcb]);
        const resultPcb = await PCBController.mergePcbProcessAndCustom(
            enrichedPcb ?? pcb,
            { includeCustomProcessField: true },
        );
        res.json({
            success: true,
            pcb: resultPcb,
        });
    }

    static async getPcbLogs(req, res) {
        const { id } = req.params;
        const pcb = await PCBModel.findById(id);
        if (!pcb) {
            throw new AppError('PCB not found', 404);
        }
        const logs = await findPcbLogs(id);
        res.json({
            success: true,
            logs,
        });
    }

    /**
     * GET /api/pcbs/project/:projectId
     * PCBs linked to a project (project_pcb_version), each with process_map
     * scoped to that project: category PROCESS tree + CUSTOM nodes (path).
     */
    static async getPCBsByProjectId(req, res) {
        const projectId = Number(req.params.projectId);
        if (!Number.isFinite(projectId) || projectId <= 0) {
            throw new AppError('Valid projectId is required', 400);
        }

        const projectResult = await pool.query(
            `SELECT id, project_code, project_name
             FROM "PROJECT"
             WHERE id = $1
             LIMIT 1`,
            [Math.trunc(projectId)],
        );
        const project = projectResult.rows[0];
        if (!project) {
            throw new AppError('Project not found', 404);
        }

        const projectCode = String(project.project_code ?? '').trim();
        const activeOnly =
            req.query.active_only === 'true' ||
            req.query.activeOnly === 'true';
        const pcbCodeFilter = String(
            req.query.pcb_code ?? req.query.pcbCode ?? '',
        )
            .trim()
            .toLowerCase();

        const versions = await ProjectPcbVersionModel.findByProjectId(
            project.id,
            { activeOnly },
        );

        // Prefer newest version row per pcb_id (findByProjectId orders id DESC)
        const versionByPcbId = new Map();
        for (const row of versions) {
            const pcbId = Number(row.pcb_id);
            if (!Number.isFinite(pcbId) || pcbId <= 0) continue;
            if (pcbCodeFilter) {
                const rowCode = String(row.pcb_code ?? '')
                    .trim()
                    .toLowerCase();
                if (rowCode !== pcbCodeFilter) continue;
            }
            if (!versionByPcbId.has(pcbId)) versionByPcbId.set(pcbId, row);
        }

        const pcbIds = [...versionByPcbId.keys()];
        const pcbRows = await PCBModel.findByIds(pcbIds);
        const pcbById = new Map(
            pcbRows.map((row) => [Number(row.id), row]),
        );

        const enriched = await enrichPcbsWithProcessChecked(
            pcbIds.map((id) => pcbById.get(id)).filter(Boolean),
        );
        const enrichedById = new Map(
            (enriched || []).map((row) => [Number(row.id), row]),
        );

        const pcbs = [];
        for (const pcbId of pcbIds) {
            const version = versionByPcbId.get(pcbId);
            const pcb = enrichedById.get(pcbId) ?? pcbById.get(pcbId);
            if (!pcb || !version) continue;

            const merged = await ProcessMapModel.mergePcbProcessMapOnly(
                pcb,
                projectCode,
            );
            // Customs are folded into process_map (category_type CUSTOM) —
            // do not return a separate custom_process blob on this endpoint.
            const { custom_process: _omitCustom, ...pcbWithoutCustom } =
                merged;

            pcbs.push({
                ...pcbWithoutCustom,
                project_id: Number(project.id),
                project_code: projectCode,
                project_name: String(project.project_name ?? '').trim(),
                pcb_name: String(version.pcb_name ?? '').trim(),
                version: String(version.version ?? '').trim(),
                version_id: Number(version.id) || null,
                version_status: version.status !== false,
                filemanager_link: String(version.filemanager_link ?? '').trim() || null,
            });
        }

        res.json({
            success: true,
            project_id: Number(project.id),
            project_code: projectCode,
            project_name: String(project.project_name ?? '').trim(),
            pcbs,
        });
    }

    /**
     * GET /api/pcbs/:id/projects-process-map
     * One PCB → all linked projects' process trees (PROCESS + CUSTOM),
     * same node shape as GET /pcbs/project/:projectId (no custom_process field).
     */
    static async getPcbProjectsProcessMap(req, res) {
        const pcbId = Number(req.params.id);
        if (!Number.isFinite(pcbId) || pcbId <= 0) {
            throw new AppError('Valid PCB id is required', 400);
        }

        const pcb = await PCBModel.findById(Math.trunc(pcbId));
        if (!pcb) {
            throw new AppError('PCB not found', 404);
        }

        const activeOnly =
            req.query.active_only === 'true' ||
            req.query.activeOnly === 'true';

        const versions = await ProjectPcbVersionModel.findByPcbId(pcb.id, {
            activeOnly,
        });

        // Newest version row per project_code
        const versionByProjectCode = new Map();
        for (const row of versions) {
            const code = String(row.project_code ?? '').trim();
            if (!code) continue;
            const key = code.toLowerCase();
            if (!versionByProjectCode.has(key)) {
                versionByProjectCode.set(key, row);
            }
        }

        const main_processes = [];
        for (const version of versionByProjectCode.values()) {
            const projectCode = String(version.project_code ?? '').trim();
            const merged = await ProcessMapModel.mergePcbProcessMapOnly(
                pcb,
                projectCode,
            );
            const process = Array.isArray(
                merged?.process_map?.main_processes,
            )
                ? merged.process_map.main_processes
                : [];

            main_processes.push({
                project_code: projectCode,
                project_id: Number(version.project_id) || null,
                pcb: String(version.pcb_name ?? '').trim(),
                version: String(version.version ?? '').trim(),
                version_id: Number(version.id) || null,
                version_status: version.status !== false,
                process,
            });
        }

        res.json({
            success: true,
            pcb_id: Number(pcb.id),
            pcb_code: String(pcb.pcb_code ?? '').trim(),
            process_map: { main_processes },
        });
    }

    // Optimized: Parallel checks for duplicate code and project lookup
    static async createPCB(req, res) {
        const { pcb_code, project_id, project_code, project_name, link, pcb_photo, created_by, process_ids, sub_process_ids, process_map, section_index } = req.body;

        if (!pcb_code) {
            throw new AppError('PCB code is required', 400);
        }

            // Parallel execution: check for duplicate and fetch project name
            const [duplicateCheck, projectResult] = await Promise.all([
                pool.query('SELECT id FROM "PCB" WHERE pcb_code = $1 LIMIT 1', [pcb_code]),
                project_code ? pool.query('SELECT id, project_name, project_code FROM "PROJECT" WHERE project_code = $1 LIMIT 1', [project_code]) : Promise.resolve({ rows: [] })
            ]);

        if (duplicateCheck.rows.length > 0) {
            throw new AppError('PCB code already exists', 400);
        }

            const finalProjectName = projectResult.rows.length > 0
                ? projectResult.rows[0].project_name
                : (project_name || '');
            const bodyProjectId =
                project_id != null && !isNaN(Number(project_id)) && Number(project_id) > 0
                    ? parseInt(String(project_id), 10)
                    : null;
            const finalProjectId =
                bodyProjectId ??
                (projectResult.rows.length > 0 ? projectResult.rows[0].id : null);

            const mainIdsArray = Array.isArray(process_ids)
                ? process_ids
                : process_ids != null
                    ? String(process_ids).split(',').map((value) => parseInt(value.trim(), 10)).filter((value) => !isNaN(value))
                    : [];
            const subIdsArray = Array.isArray(sub_process_ids)
                ? sub_process_ids
                : sub_process_ids != null
                    ? String(sub_process_ids).split(',').map((value) => parseInt(value.trim(), 10)).filter((value) => !isNaN(value))
                    : [];
            // total_process_id covers everything tied to this PCB (main + sub),
            // same as how the project side tracks completion.
            const processIdsStr = mainIdsArray.length > 0 || subIdsArray.length > 0
                ? [...new Set([...mainIdsArray, ...subIdsArray])].join(',')
                : null;
            const processMap = process_map && typeof process_map === 'object' && Array.isArray(process_map.main_processes)
                ? process_map
                : await ProcessMapModel.buildProcessMapFromCategoryIds(
                    0,
                    mainIdsArray,
                    new Map(),
                    subIdsArray,
                );
        const sectionIndex = section_index != null && !isNaN(Number(section_index)) ? parseInt(section_index, 10) : 2;
        let newPCB;
        try {
            newPCB = await PCBModel.create({
                pcb_code,
                project_id: finalProjectId,
                project_code,
                project_name: finalProjectName,
                link,
                pcb_photo,
                created_by,
                section_index: sectionIndex,
                process_map: processMap,
            });
        } catch (error) {
            if (error.code === '23505') {
                throw new AppError('PCB code already exists', 400);
            }
            throw error;
        }

            await persistPcbProcessChecked(newPCB, null, { processIds: processIdsStr });

            broadcastClientUpdate('created', { source: 'pcb', id: newPCB.id, pcb_code: newPCB.pcb_code });

            // Create PCB-scoped folders under existing project file manager (best-effort)
            let pcbFolders = null;
            try {
                pcbFolders = await ensureProjectPcbFolders({
                    projectCode: newPCB.project_code,
                    pcbCode: newPCB.pcb_code,
                });
            } catch (fmErr) {
                console.warn(
                    'PCB folder structure create skipped:',
                    fmErr?.message || fmErr,
                );
            }

            const [enrichedPcb] = await enrichPcbsWithProcessChecked([newPCB]);

        res.status(201).json({
            success: true,
            message: 'PCB created successfully',
            pcb: enrichedPcb || newPCB,
            ...(pcbFolders
                ? {
                      pcb_folders: {
                          project_code: pcbFolders.project_code,
                          pcb_code: pcbFolders.pcb_code,
                          created_folders: pcbFolders.structure_folders,
                      },
                  }
                : {}),
        });
    }

    // Optimized: Parallel checks for PCB existence and project lookup
    static async updatePCB(req, res) {
        const { id } = req.params;
        const userId = getUserIdFromReq(req);
        const before = await PCBModel.findById(id);
        if (!before) {
            throw new AppError('PCB not found', 404);
        }
        const body = req.body || {};
            const { pcb_code, project_id, project_code, project_name, link, pcb_photo, checked_tasks, checked_task_names, task_scope_names, process_ids, sub_process_ids, process_map } = body;
            const processMapIds = process_map && typeof process_map === 'object' && Array.isArray(process_map.main_process_ids)
                ? process_map.main_process_ids
                : process_ids !== undefined
                    ? process_ids
                    : undefined;
            const processMapSubIds = process_map && typeof process_map === 'object' && Array.isArray(process_map.sub_process_ids)
                ? process_map.sub_process_ids
                : sub_process_ids !== undefined
                    ? sub_process_ids
                    : undefined;
            const toIdArray = (value) =>
                Array.isArray(value)
                    ? value
                    : String(value ?? '').split(',').map((v) => parseInt(v.trim(), 10)).filter((v) => !isNaN(v));
            // total_process_id covers everything tied to this PCB (main + sub).
            const combinedProcessIds =
                processMapIds !== undefined || processMapSubIds !== undefined
                    ? [...new Set([
                        ...toIdArray(processMapIds),
                        ...toIdArray(processMapSubIds),
                    ])].join(',')
                    : process_ids;
            const processMap = process_map && typeof process_map === 'object' && Array.isArray(process_map.main_processes)
                ? process_map
                : processMapIds !== undefined
                    ? await ProcessMapModel.buildProcessMapFromCategoryIds(
                        id,
                        toIdArray(processMapIds),
                        new Map(),
                        toIdArray(processMapSubIds),
                    )
                    : undefined;
            const noOther = body.pcb_code === undefined && body.project_code === undefined && body.link === undefined && body.pcb_photo === undefined;

            // Only checked_tasks (uncheck only removes from checked_tasks; process_ids/added list unchanged)
            const hasCheckedNames = Array.isArray(checked_task_names);
            const onlyCheckedTasks = (typeof checked_tasks !== 'undefined' || hasCheckedNames) && noOther && body.process_ids === undefined;
            if (onlyCheckedTasks) {
                const pcbCheck = await pool.query('SELECT id FROM "PCB" WHERE id = $1', [id]);
            if (pcbCheck.rows.length === 0) {
                throw new AppError('PCB not found', 404);
            }
                const updatedPCB = await afterPcbSaved(before, before, {
                    checkedIds: checked_tasks,
                    checkedNames: hasCheckedNames ? checked_task_names : undefined,
                    taskScopeNames: Array.isArray(task_scope_names) ? task_scope_names : [],
                    processMap,
                });
                broadcastClientUpdate('updated', { source: 'pcb', id: updatedPCB.id, pcb_code: updatedPCB.pcb_code });
                try {
                    const patch = pickChangedColumns(before, updatedPCB, ['checked_tasks']);
                    await writeAuditLog(req, { action: 'UPDATE', tableName: 'PCB', tableOfId: parseInt(id, 10), tableOfColumn: patch.columns.join(','), oldValue: patch.oldValue, newValue: patch.newValue, userId });
                    await savePcbFieldLog(req, before, updatedPCB, patch);
                } catch (e) {
                    console.error('Audit log write failed (pcb update):', e.message || e);
                }
                return res.json({
                    success: true,
                    message: 'PCB updated successfully',
                    pcb: updatedPCB
                });
            }

            // process_ids + checked_tasks together (process map save: added list and checked subset)
            const processMapSave = (typeof process_ids !== 'undefined' || typeof checked_tasks !== 'undefined') && noOther;
            if (processMapSave) {
                const pcbCheck = await pool.query('SELECT id FROM "PCB" WHERE id = $1', [id]);
            if (pcbCheck.rows.length === 0) {
                throw new AppError('PCB not found', 404);
            }
                const updatedPCB = await afterPcbSaved(before, before, {
                    processIds: combinedProcessIds,
                    checkedIds: checked_tasks,
                    processMap,
                });
                broadcastClientUpdate('updated', { source: 'pcb', id: updatedPCB.id, pcb_code: updatedPCB.pcb_code });
                try {
                    const patch = pickChangedColumns(before, updatedPCB, ['process_ids', 'checked_tasks']);
                    await writeAuditLog(req, { action: 'UPDATE', tableName: 'PCB', tableOfId: parseInt(id, 10), tableOfColumn: patch.columns.join(','), oldValue: patch.oldValue, newValue: patch.newValue, userId });
                    await savePcbFieldLog(req, before, updatedPCB, patch);
                } catch (e) {
                    console.error('Audit log write failed (pcb update):', e.message || e);
                }
                return res.json({
                    success: true,
                    message: 'PCB updated successfully',
                    pcb: updatedPCB
                });
            }

            // Only process_ids (add/remove process list; checked_tasks unchanged)
            const onlyProcessIds = typeof process_ids !== 'undefined' && noOther && body.checked_tasks === undefined;
            if (onlyProcessIds) {
                const pcbCheck = await pool.query('SELECT id FROM "PCB" WHERE id = $1', [id]);
            if (pcbCheck.rows.length === 0) {
                throw new AppError('PCB not found', 404);
            }
                const updatedPCB = await afterPcbSaved(before, before, {
                    processIds: combinedProcessIds,
                    processMap,
                });
                broadcastClientUpdate('updated', { source: 'pcb', id: updatedPCB.id, pcb_code: updatedPCB.pcb_code });
                try {
                    const patch = pickChangedColumns(before, updatedPCB, ['process_ids']);
                    await writeAuditLog(req, { action: 'UPDATE', tableName: 'PCB', tableOfId: parseInt(id, 10), tableOfColumn: patch.columns.join(','), oldValue: patch.oldValue, newValue: patch.newValue, userId });
                    await savePcbFieldLog(req, before, updatedPCB, patch);
                } catch (e) {
                    console.error('Audit log write failed (pcb update):', e.message || e);
                }
                return res.json({
                    success: true,
                    message: 'PCB updated successfully',
                    pcb: updatedPCB
                });
            }

            // Full update: parallel execution for existence and project lookup
            const [pcbCheck, projectResult] = await Promise.all([
                pool.query('SELECT id FROM "PCB" WHERE id = $1', [id]),
                project_code ? pool.query('SELECT id, project_name FROM "PROJECT" WHERE project_code = $1 LIMIT 1', [project_code]) : Promise.resolve({ rows: [] })
            ]);

        if (pcbCheck.rows.length === 0) {
            throw new AppError('PCB not found', 404);
        }

            // Check for duplicate pcb_code if it's being updated
            if (pcb_code) {
                const duplicateCheck = await pool.query(
                    'SELECT id FROM "PCB" WHERE pcb_code = $1 AND id != $2 LIMIT 1',
                    [pcb_code, id]
                );
            if (duplicateCheck.rows.length > 0) {
                throw new AppError('PCB code already exists', 400);
            }
            }

            const finalProjectName = projectResult.rows.length > 0
                ? projectResult.rows[0].project_name
                : (project_name || null);
            const bodyProjectId =
                project_id != null && !isNaN(Number(project_id)) && Number(project_id) > 0
                    ? parseInt(String(project_id), 10)
                    : null;
            const finalProjectId =
                bodyProjectId ??
                (projectResult.rows.length > 0 ? projectResult.rows[0].id : undefined);

            const updatedPCB = await afterPcbSaved(
                await PCBModel.update(id, {
                    pcb_code,
                    project_id: finalProjectId,
                    project_code,
                    project_name: finalProjectName,
                    link,
                    pcb_photo,
                    section_index: body.section_index,
                    process_map: processMap,
                }),
                before,
                {
                    processIds: combinedProcessIds,
                    checkedIds: checked_tasks,
                    processMap,
                },
            );

        if (!updatedPCB) {
            throw new AppError('PCB not found', 404);
        }

            broadcastClientUpdate('updated', { source: 'pcb', id: updatedPCB.id, pcb_code: updatedPCB.pcb_code });

            // Audit log (best-effort)
            try {
                const patch = pickChangedColumns(before, updatedPCB, ['pcb_code', 'project_code', 'project_name', 'link', 'pcb_photo', 'checked_tasks', 'process_ids', 'process_map', 'section_index']);
                await writeAuditLog(req, {
                    action: 'UPDATE',
                    tableName: 'PCB',
                    tableOfId: parseInt(id, 10),
                    tableOfColumn: patch.columns.join(','),
                    oldValue: patch.oldValue,
                    newValue: patch.newValue,
                    userId
                });
                await savePcbFieldLog(req, before, updatedPCB, patch);
            } catch (e) {
                console.error('Audit log write failed (pcb update):', e.message || e);
            }

        res.json({
            success: true,
            message: 'PCB updated successfully',
            pcb: updatedPCB
        });
    }

    static async deletePCB(req, res) {
        const { id } = req.params;
            const userId = getUserIdFromReq(req);
        const before = await PCBModel.findById(id);
        if (!before) {
            throw new AppError('PCB not found', 404);
        }
        const deleted = await PCBModel.delete(id);
        if (!deleted) {
            throw new AppError('PCB not found', 404);
        }

            const previousProject = await resolveProjectForPcb(before.project_code);
            if (previousProject?.id) {
                await deletePcbProjectProcessChecked(previousProject.id, before.id);
                await syncProjectProcessCheckedTotal(previousProject.id);
            }

            broadcastClientUpdate('deleted', { source: 'pcb', id: parseInt(id, 10) });

            // Audit log (best-effort)
            try {
                await writeAuditLog(req, {
                    action: 'DELETE',
                    tableName: 'PCB',
                    tableOfId: parseInt(id, 10),
                    tableOfColumn: 'id',
                    oldValue: before,
                    newValue: null,
                    userId
                });
            } catch (e) {
                console.error('Audit log write failed (pcb delete):', e.message || e);
            }
        res.json({
            success: true,
            message: 'PCB deleted successfully'
        });
    }

    static async getLastSerial(req, res) {
        const { month, year } = req.query;
        let targetFY = null;
    
        if (month && year) {
            targetFY = getFinancialYearFromProjectCode(`${month.padStart(2, '0')}${year.padStart(2, '0')}`);
        }
    
        // Fetch all PCBs
        const allPcbsResult = await pool.query(`
            SELECT pcb_code
            FROM "PCB"
            WHERE pcb_code IS NOT NULL
                AND pcb_code != ''
                AND LENGTH(pcb_code) >= 5
            ORDER BY pcb_code DESC
        `);
    
        // Process serial numbers while optionally filtering by financial year
        const serialPromises = allPcbsResult.rows.map(row => {
            return new Promise(resolve => {
                const pcbCode = row.pcb_code;
                if (!pcbCode || pcbCode.length < 5) {
                    resolve(0);
                    return;
                }
    
                // Extract serial number (all digits before the last 4 chars which are MMYY)
                const serialPart = pcbCode.substring(0, pcbCode.length - 4);
                const serialNum = parseInt(serialPart, 10);
    
                if (isNaN(serialNum)) {
                    resolve(0);
                    return;
                }
    
                // If targetFY is provided, verify this PCB belongs to the same financial year
                if (targetFY) {
                    const pcbFY = getFinancialYearFromProjectCode(pcbCode);
                    if (pcbFY !== targetFY) {
                        resolve(0);
                        return;
                    }
                }
    
                resolve(serialNum);
            });
        });
    
        const extractedSerials = await Promise.all(serialPromises);
        const existingSerials = extractedSerials.filter(num => num > 0);
    
        // Find the highest serial number (either globally or for the targeted financial year)
        const maxSerial = existingSerials.length > 0 ? Math.max(...existingSerials) : 0;
        const nextSerial = maxSerial + 1;
    
        // NEW: always emit as a fixed 7-digit, zero-padded string so the
        // generated pcb_code (serial + MMYY) has a consistent, predictable length.
        const SERIAL_DIGITS = 3;
        const nextSerialPadded = String(nextSerial).padStart(SERIAL_DIGITS, '0');
        const lastSerialPadded = String(maxSerial).padStart(SERIAL_DIGITS, '0');
    
        if (nextSerialPadded.length > SERIAL_DIGITS) {
            // Guard: more than 9,999,999 PCBs in this scope — surface it instead of silently truncating.
            throw new AppError(
                `Serial number overflow: next serial ${nextSerial} exceeds ${SERIAL_DIGITS} digits.`,
                409,
            );
        }
    
        res.json({
            success: true,
            lastSerialNumber: maxSerial,
            nextSerialNumber: nextSerial,
            lastSerialNumberFormatted: lastSerialPadded,
            nextSerialNumberFormatted: nextSerialPadded,
            totalPCBs: allPcbsResult.rows.length,
            financialYear: targetFY,
            note: targetFY ? `Filtered by financial year: ${targetFY}` : 'Global continuous increment'
        });
    }
    // Upload PCB photo to Cloudinary
    static async uploadPhoto(req, res) {
        if (!req.file) {
            throw new AppError('No file provided', 400);
        }

            const { pcb_code } = req.body;

            // Clean PCB code for folder name
            const cleanPcbCode = pcb_code ? pcb_code.replace(/[^a-zA-Z0-9-]/g, '_').toUpperCase() : 'UNKNOWN';
            const folderPath = `pcbs/${cleanPcbCode}`;

            // Check if it's an image
            const isImage = req.file.mimetype.startsWith('image/');
        if (!isImage) {
            throw new AppError('Invalid file type. Only images (JPEG, PNG, GIF, WebP) are allowed.', 400);
        }

            // Generate a structured filename
            const timestamp = Date.now();
            const originalName = req.file.originalname || 'pcb-photo';

            // Extract file extension
            let fileExtension = '';
            if (originalName.includes('.')) {
                fileExtension = originalName.split('.').pop().toLowerCase();
            } else {
                const mimeToExt = {
                    'image/jpeg': 'jpg',
                    'image/jpg': 'jpg',
                    'image/png': 'png',
                    'image/gif': 'gif',
                    'image/webp': 'webp'
                };
                fileExtension = mimeToExt[req.file.mimetype] || 'jpg';
            }

            const nameWithoutExt = originalName.replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
            const cleanName = nameWithoutExt || 'pcb-photo';
            const publicId = `${folderPath}/photo_${timestamp}_${cleanName}.${fileExtension}`;

            // Convert buffer to base64 for Cloudinary upload
            const base64Image = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;

            // Upload image to Cloudinary (async operation)
            const uploadResult = await cloudinary.uploader.upload(base64Image, {
                public_id: publicId,
                folder: folderPath,
                resource_type: 'image',
                transformation: [
                    { width: 800, height: 800, crop: 'limit' },
                    { quality: 'auto' }
                ]
            });

        res.json({
            success: true,
            imageUrl: uploadResult.secure_url,
            url: uploadResult.secure_url,
            publicId: uploadResult.public_id,
            folder: folderPath
        });
    }
}

wrapController(PCBController, [
    'getPCBStats',
    'getAllPCBs',
    'getPCBById',
    'getPcbLogs',
    'getPCBsByProjectId',
    'getPcbProjectsProcessMap',
    'createPCB',
    'updatePCB',
    'deletePCB',
    'getLastSerial',
    'uploadPhoto',
]);

export default PCBController;