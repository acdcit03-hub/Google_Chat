


import { v2 as cloudinary } from 'cloudinary';
import dotenv from 'dotenv';
dotenv.config();
import { getUserIdFromReq, getUsernameFromReq, writeAuditLog, pickChangedColumns } from '../../utils/audit.utils.js';
import { findProjectLogs, insertProjectFieldLogs } from '../../models/projectsheet/projectLog.model.js';
import { resolveStatsScopeFromQuery } from '../../utils/dataScope.utils.js';
import ProjectModel from '../../models/projectsheet/project.model.js';
import ProcessMapModel from '../../models/projectsheet/updateProject.model.js';
import {  normalizeTimeFormat, calculateProjectWorkHour, calculateProjectNetTime } from '../../utils/project.utils.js';
import {
    enrichProjectsWithMainProcessIds,
    recalculateProjectOverallCompletion,
} from '../../utils/projectProcessChecked.utils.js';
import { broadcast, broadcastClientUpdate } from '../../config/socket.js';
import { pool } from '../../config/db.js';
import { AppError, wrapController } from '../../middleware/error.middleware.js';
// Configure Cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

class ProjectController {

    
    static async mergeProjectProcessAndCustom(project, { includeCustomProcessField = true } = {}) {
        if (!project) return project;

        const baseMainProcesses = Array.isArray(project?.process_map?.main_processes)
            ? project.process_map.main_processes
            : [];
        const customTopLevelNodes = ProcessMapModel.customProcessToMainProcessNodes(
            project.custom_process,
        );

        const [mergedMainProcesses, resolvedCustomProcess] = await Promise.all([
            ProcessMapModel.applyCustomProcessExtraSubs(
                [...baseMainProcesses, ...customTopLevelNodes],
                project.custom_process,
            ),
            includeCustomProcessField
                ? ProcessMapModel.customProcessToResolvedTree(project.custom_process)
                : Promise.resolve(undefined),
        ]);

        const merged = {
            ...project,
            process_map: { ...(project.process_map || {}), main_processes: mergedMainProcesses },
        };

        if (includeCustomProcessField) {
            merged.custom_process = resolvedCustomProcess;
        } else {
            delete merged.custom_process;
        }

        return merged;
    }
    static async getNextSerial(req, res) {
        const serialNo = await ProjectModel.getNextSerialNo();
        return res.json({ success: true, serialNo });
    }

    static async getNextVersion(req, res) {
        const { category, client_code, sub_code } = req.query;
        if (!category || !client_code || !sub_code) {
            throw new AppError('category, client_code, and sub_code are required', 400);
        }

        const version = await ProjectModel.getNextVersion(
            category,
            client_code,
            sub_code,
        );

        return res.json({ success: true, version });
    }

    static async getProjectStats(req, res) {
        const financialYear =
            req.query?.financialYear ?? req.query?.financial_year;
        const { scopeUsernames } = await resolveStatsScopeFromQuery(req.query);
        const stats = await ProjectModel.getStats({
            ...req.query,
            financialYear,
            scopeUsernames,
        });

        res.json({
            success: true,
            stats: {
                total: Number(stats.total) || 0,
                inPlanning: Number(stats.inPlanning) || 0,
                running: Number(stats.running) || 0,
                onHold: Number(stats.onHold) || 0,
                completed: Number(stats.completed) || 0,
                stopped: Number(stats.stopped) || 0,
             
                byStatus: Array.isArray(stats.byStatus) ? stats.byStatus : [],
            },
        });
    }

    // Optimized: Fetch projects with all filters, parallel count and data queries
    // Query params: see ProjectModel.findAll — whitelist includes status, project name/code,
    // dates (single or *_from / *_to), category, priority, client/company, serial, docs, etc.
    static async getAllProjects(req, res) {
        const q = req.query || {};
            const all = q.all;
            const paginateRaw = q.paginate ?? q.pagination;
            const paginate =
                paginateRaw === undefined || paginateRaw === null || paginateRaw === ''
                    ? true
                    : !['false', '0', 'no'].includes(String(paginateRaw).trim().toLowerCase());

            const filters = {
                ...q,
                paginate,
                limit: all === 'true' ? 10000 : (parseInt(q.limit, 10) || 10),
                offset: q.offset != null && q.offset !== '' ? parseInt(q.offset, 10) : undefined,
                page: parseInt(q.page, 10) || 1
            };

            const result = await ProjectModel.findAll(filters);

            // Normalize time formats
            const projectsWithStoredTimes = result.projects.map((project) => ({
                ...project,
                work_hour: project.work_hour ? normalizeTimeFormat(project.work_hour) : '0h',
                net_time: project.net_time ? normalizeTimeFormat(project.net_time) : '0h'
            }));

            const projectsWithProcesses = await enrichProjectsWithMainProcessIds(
                projectsWithStoredTimes,
            );

            const projectsWithMergedProcess = await Promise.all(
                projectsWithProcesses.map(async (project) => {
                    const [merged, processMap] = await Promise.all([
                        ProjectController.mergeProjectProcessAndCustom(project, {
                            includeCustomProcessField: false,
                        }),
                        // Full map (project + PCB roots + custom) for % summaries
                        ProcessMapModel.buildMergedProcessMap(project),
                    ]);

                    const main_processes_Percentage =
                        ProcessMapModel.toMainProcessSummaries(
                            processMap.main_processes,
                        );
                    const overall_completion =
                        ProcessMapModel.overallCompletionFromMainProcesses(
                            processMap.main_processes,
                        );

                    return {
                        ...merged,
                        main_processes_Percentage,
                        overall_completion,
                    };
                }),
            );

            // Use result totals (already calculated with filters applied)
            const finalTotal = result.total || 0;
            const noPagination = result.noPagination === true;
            const finalLimit = noPagination ? finalTotal : (result.limit || filters.limit || 10);
            const finalOffset = noPagination ? 0 : (result.offset || 0);
            const finalPage = noPagination ? 1 : (result.page || filters.page || 1);

            res.json({
                success: true,
                projects: projectsWithMergedProcess,
                pagination: {
                    total: Math.max(0, finalTotal),
                    ...(noPagination
                        ? { paginated: false, limit: null, offset: 0, page: 1, totalPages: 1, hasNextPage: false, hasPrevPage: false }
                        : {
                            paginated: true,
                            limit: Math.max(1, finalLimit),
                            offset: Math.max(0, finalOffset),
                            page: Math.max(1, finalPage),
                            totalPages: finalTotal > 0 ? Math.ceil(finalTotal / finalLimit) : 0,
                            hasNextPage: finalOffset + finalLimit < finalTotal,
                            hasPrevPage: finalOffset > 0
                        })
                }
            });
    }

    static async getProjectById(req, res) {
        const { id } = req.params;
        if (!/^\d+$/.test(String(id))) {
            throw new AppError('Project not found', 404);
        }

        const project = await ProjectModel.findById(id);
        if (!project) {
            throw new AppError('Project not found', 404);
        }

        // Normalize time formats
        project.work_hour = project.work_hour ? normalizeTimeFormat(project.work_hour) : '0h';
        project.net_time = project.net_time ? normalizeTimeFormat(project.net_time) : '0h';

        const [enrichedProject] = await enrichProjectsWithMainProcessIds([project]);
        const resultProject = await ProjectController.mergeProjectProcessAndCustom(
            enrichedProject ?? project,
        );

        res.json({
            success: true,
            project: resultProject
        });
    }

    static async getProjectLogs(req, res) {
        const { id } = req.params;
        const project = await ProjectModel.findById(id);
        if (!project) {
            throw new AppError('Project not found', 404);
        }
        const logs = await findProjectLogs(id);
        res.json({
            success: true,
            logs,
        });
    }

    static async getProjectByCode(req, res) {
        const { code } = req.params;
        const project = await ProjectModel.findByCode(code);
        if (!project) {
            throw new AppError('Project not found', 404);
        }
        res.json({
            success: true,
            project: await ProjectController.mergeProjectProcessAndCustom(project)
        });
    }

    // Optimized: Parallel client lookups and duplicate check
    static async createProject(req, res) {
        const {
                project_name,
                project_code,
                serial_no,
                client_code,
                assigned_users_display,
                inquiry_date,
                target_date,
                start_date,
                end_date,
                work_hour,
                net_time,
                status,
                category,
                client_id,
                sub_code,
                version,
                target_hour,
                per_day_hour,
                month,
                year,
                priority,
                project_photo,
                created_by,
                group_link,
                drive_link,
                process_ids,
                process_display,
                process_mode,
            } = req.body;

            const useNewProcessStore =
                process_mode === 'category' || process_mode === 'new';
            const parsedProcessIds = Array.isArray(process_ids)
                ? process_ids
                : process_ids != null
                    ? String(process_ids).split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n))
                    : [];

            // Early validation
            if (!project_name || !project_name.trim()) {
                throw new AppError('Project name is required', 400);
            }

            if (!project_code || !project_code.trim()) {
                throw new AppError('Project code is required', 400);
            }

            // Parallel: Check duplicate code and resolve client info
            const [duplicateCheck, clientByCode, clientById] = await Promise.all([
                ProjectModel.findByCodeForDuplicate(project_code),
                client_code ? ProjectModel.findClientByCode(client_code) : Promise.resolve(null),
                client_id && client_id !== 0 ? ProjectModel.findClientById(client_id) : Promise.resolve(null)
            ]);

            if (duplicateCheck) {
                throw new AppError(`Project code "${project_code}" already exists`, 400);
            }

            // Resolve client_code and client_id
            let finalClientCode = client_code;
            let finalClientId = client_id;

            if (client_code && (!client_id || client_id === 0)) {
                if (clientByCode) {
                    finalClientId = clientByCode.id;
                    if (!finalClientCode) {
                        finalClientCode = clientByCode.client_code;
                    }
                }
            } else if (!finalClientCode && client_id && client_id !== 0) {
                if (clientById) {
                    finalClientCode = clientById.client_code;
                }
            }

            // Parse project code to extract sub-data if fields are missing
            const parseProjectCode = (code) => {
                if (!code || code.length < 3) return {};
                const parsed = {};
                let pos = 0;

                if (code.length >= 3) {
                    parsed.serialNo = code.substring(pos, pos + 3);
                    pos += 3;
                }
                if (code.length > pos) {
                    parsed.category = code.substring(pos, pos + 1);
                    pos += 1;
                }
                if (code.length >= pos + 3) {
                    parsed.clientCode = code.substring(pos, pos + 3);
                    pos += 3;
                }
                if (code.length >= pos + 3) {
                    parsed.subCode = code.substring(pos, pos + 3);
                    pos += 3;
                }
                if (code.length >= pos + 3) {
                    parsed.version = code.substring(pos, pos + 3);
                }

                return parsed;
            };

            // Extract sub-data from project_code if fields are missing
            let finalSerialNo = serial_no;
            let finalCategory = category;
            let finalSubCode = sub_code;
            let finalVersion = version;
            let finalClientCodeFromCode = null;

            if (project_code && (!serial_no || serial_no === '-' || !category || category === '-' ||
                !sub_code || sub_code === '-' || !version || version === '-')) {
                const parsed = parseProjectCode(project_code);

                if (parsed.serialNo && (!finalSerialNo || finalSerialNo === '-')) {
                    finalSerialNo = parsed.serialNo;
                }
                if (parsed.category && (!finalCategory || finalCategory === '-')) {
                    finalCategory = parsed.category;
                }
                if (parsed.clientCode && (!finalClientCode || finalClientCode === '-')) {
                    finalClientCodeFromCode = parsed.clientCode;
                }
                if (parsed.subCode && (!finalSubCode || finalSubCode === '-')) {
                    finalSubCode = parsed.subCode;
                }
                if (parsed.version && (!finalVersion || finalVersion === '-')) {
                    finalVersion = parsed.version;
                }
            }

            if (finalClientCodeFromCode && (!finalClientCode || finalClientCode === '-')) {
                finalClientCode = finalClientCodeFromCode;
            }

            // Ensure serial is global + unique for current financial year
            const normalizedSerial = ProjectModel.normalizeSerialNo(finalSerialNo);
            if (normalizedSerial) {
                finalSerialNo = normalizedSerial;
            }

            const hasProvided = !!(
                finalSerialNo &&
                finalSerialNo !== '-' &&
                String(finalSerialNo).trim() !== ''
            );

            try {
                if (!hasProvided) {
                    finalSerialNo = await ProjectModel.getNextSerialNo();
                } else if (await ProjectModel.serialNoExistsForCurrentFY(finalSerialNo)) {
                    throw new AppError(`Serial number "${finalSerialNo}" already exists for this financial year`, 400);
                }
            } catch (e) {
                finalSerialNo = hasProvided ? finalSerialNo : null;
            }

            if (finalSerialNo && await ProjectModel.serialNoExistsForCurrentFY(finalSerialNo)) {
                throw new AppError(
                    hasProvided
                        ? `Serial number "${finalSerialNo}" already exists for this financial year`
                        : 'Serial number is no longer available. Close the form and click Add Project again.',
                    400,
                );
            }

            // Helper functions
            const truncateString = (str, maxLength) => {
                if (!str) return null;
                const trimmed = String(str).trim();
                return trimmed.length > maxLength ? trimmed.substring(0, maxLength) : trimmed;
            };

            const formatDateForDB = (dateStr) => {
                if (!dateStr || dateStr === '-' || String(dateStr).toLowerCase() === 'n/a' || String(dateStr).trim() === '') return null;
                const trimmed = String(dateStr).trim();

                if (trimmed.match(/^\d{4}-\d{2}-\d{2}$/)) {
                    return truncateString(trimmed, 20);
                }

                if (trimmed.match(/^\d{2}\/\d{2}\/\d{4}$/)) {
                    const [day, month, year] = trimmed.split('/');
                    return `${year}-${month}-${day}`;
                }

                if (trimmed.match(/^\d{2}-\d{2}-\d{4}$/)) {
                    const [day, month, year] = trimmed.split('-');
                    return `${year}-${month}-${day}`;
                }

                try {
                    const date = new Date(trimmed);
                    if (!isNaN(date.getTime())) {
                        const year = date.getFullYear();
                        const month = String(date.getMonth() + 1).padStart(2, '0');
                        const day = String(date.getDate()).padStart(2, '0');
                        if (year >= 1900 && year <= 2100) {
                            return `${year}-${month}-${day}`;
                        }
                    }
                } catch (e) {
                    // Continue to return null
                }

                return null;
            };

            // Create project
            let newProject;
            try {
                const resolvedAssign = ProjectModel.resolveAssignedUsers({
                    assigned_users_display,
                });

                newProject = await ProjectModel.create({
                projectName: (project_name || '').toUpperCase(),
                projectCode: project_code || '',
                serialNo: truncateString(finalSerialNo, 10) || null,
                clientCode: truncateString(finalClientCode, 50) || null,
                clientId: (finalClientId && finalClientId !== 0) ? finalClientId : null,
                assignedUsersDisplay: resolvedAssign.assignedUsersDisplay,
                inquiryDate: formatDateForDB(inquiry_date),
                targetDate: formatDateForDB(target_date),
                startDate: formatDateForDB(start_date),
                endDate: formatDateForDB(end_date),
                workHour: truncateString(work_hour, 50) || '0h',
                netTime: truncateString(net_time, 50) || '0h',
                status: truncateString(status, 50) || 'In Planning',
                driveLink: truncateString(drive_link, 2000) || null,
                groupLink: truncateString(group_link, 500) || null,
                category: truncateString(finalCategory, 10) || null,
                subCode: truncateString(finalSubCode ? finalSubCode.toUpperCase() : null, 50) || null,
                version: truncateString(finalVersion, 10) || null,
                targetHour: target_hour || 0,
                perDayHour: per_day_hour || 8,
                month: truncateString(month, 2) || null,
                year: truncateString(year, 2) || null,
                priority: truncateString(priority, 10) || '3',
                projectPhoto: project_photo || null,
                createdBy: created_by || null,
                checkedTasks: null,
                processIds: useNewProcessStore ? [] : parsedProcessIds,
            });
            } catch (error) {
                if (error.code === '23505') {
                    throw new AppError('Project code already exists', 400);
                }
                throw error;
            }

            // Broadcast WebSocket update (non-blocking)
            broadcast('project-update', 'created', newProject);
            broadcastClientUpdate('created', { source: 'project', id: newProject.id, project_code: newProject.project_code });

            if (process_ids != null) {
                const rawProcessMap = req.body.process_map && typeof req.body.process_map === 'object'
                    ? req.body.process_map
                    : await ProcessMapModel.buildProcessMapFromCategoryIds(
                        newProject.id,
                        parsedProcessIds,
                    );

                const processMap = ProcessMapModel.sanitizeCustomCategoryType(rawProcessMap);
                await pool.query(
                    `UPDATE "PROJECT"
                     SET process_ids = $1::jsonb,
                         process_map = $2::jsonb,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = $3`,
                    [JSON.stringify(parsedProcessIds), JSON.stringify(processMap), newProject.id],
                );
                newProject.process_map = processMap;
            }

            res.status(201).json({
                success: true,
                message: 'Project created successfully',
                project: {
                    ...newProject,
                    process_ids: parsedProcessIds,
                    process_display: process_display ?? '',
                    process_mode: 'category',
                },
            });
    }

    // Optimized: Parallel existence check and calculations
    static async updateProject(req, res) {
        const { id } = req.params;
            const body = req.body;
            const userId = getUserIdFromReq(req);

            // Parallel: Check if project exists and get current project data
        const existingProject = await ProjectModel.findById(id);
        if (!existingProject) {
            throw new AppError('Project not found', 404);
        }

            const oldStatus = existingProject.status;

            // If status is changing from "In Planning" to "Running", set start_date to today
            if (oldStatus && oldStatus.toLowerCase() === 'in planning' &&
                body.status && body.status.toLowerCase() === 'running') {
                if (!body.start_date) {
                    const today = new Date();
                    const year = today.getFullYear();
                    const month = String(today.getMonth() + 1).padStart(2, '0');
                    const day = String(today.getDate()).padStart(2, '0');
                    body.start_date = `${year}-${month}-${day}`;
                }
            }

            // Parse project code if being updated
            if (body.project_code) {
                const parseProjectCode = (code) => {
                    if (!code || code.length < 3) return {};
                    const parsed = {};
                    let pos = 0;

                    if (code.length >= 3) {
                        parsed.serialNo = code.substring(pos, pos + 3);
                        pos += 3;
                    }
                    if (code.length > pos) {
                        parsed.category = code.substring(pos, pos + 1);
                        pos += 1;
                    }
                    if (code.length >= pos + 3) {
                        parsed.clientCode = code.substring(pos, pos + 3);
                        pos += 3;
                    }
                    if (code.length >= pos + 3) {
                        parsed.subCode = code.substring(pos, pos + 3);
                        pos += 3;
                    }
                    if (code.length >= pos + 3) {
                        parsed.version = code.substring(pos, pos + 3);
                    }

                    return parsed;
                };

                const parsed = parseProjectCode(body.project_code);

                if (parsed.serialNo && (!body.serial_no || body.serial_no === '-')) {
                    body.serial_no = parsed.serialNo;
                }
                if (parsed.category && (!body.category || body.category === '-')) {
                    body.category = parsed.category;
                }
                if (parsed.clientCode && (!body.client_code || body.client_code === '-')) {
                    body.client_code = parsed.clientCode;
                }
                if (parsed.subCode && (!body.sub_code || body.sub_code === '-')) {
                    body.sub_code = parsed.subCode;
                }
                if (parsed.version && (!body.version || body.version === '-')) {
                    body.version = parsed.version;
                }
            }

            // Helper functions
            const truncateString = (str, maxLength) => {
                if (!str) return null;
                const trimmed = String(str).trim();
                return trimmed.length > maxLength ? trimmed.substring(0, maxLength) : trimmed;
            };

            const formatDateForDB = (dateStr) => {
                if (!dateStr || dateStr === '-' || String(dateStr).toLowerCase() === 'n/a') return null;
                const trimmed = String(dateStr).trim();
                if (trimmed.match(/^\d{4}-\d{2}-\d{2}/)) {
                    return truncateString(trimmed, 20);
                }
                try {
                    const date = new Date(trimmed);
                    if (!isNaN(date.getTime())) {
                        const year = date.getFullYear();
                        const month = String(date.getMonth() + 1).padStart(2, '0');
                        const day = String(date.getDate()).padStart(2, '0');
                        return `${year}-${month}-${day}`;
                    }
                } catch (e) { }
                return null;
            };

            // Parallel: Calculate work_hour and net_time if not provided
            const projectCode = existingProject.project_code;
            const [calculatedWorkHour, calculatedNetTime] = await Promise.all([
                body.work_hour === undefined ? calculateProjectWorkHour(projectCode) : Promise.resolve(null),
                body.net_time === undefined ? calculateProjectNetTime(projectCode) : Promise.resolve(null)
            ]);

            // Build update fields
            const updates = [];
            const values = [];
            let paramCount = 1;

            const fields = [
                { name: 'project_name', type: 'string' },
                { name: 'project_code', type: 'string' },
                { name: 'serial_no', type: 'string', length: 10 },
                { name: 'client_code', type: 'string', length: 50 },
                { name: 'assigned_users_display', type: 'string' },
                { name: 'inquiry_date', type: 'date' },
                { name: 'target_date', type: 'date' },
                { name: 'start_date', type: 'date' },
                { name: 'end_date', type: 'date' },
                { name: 'work_hour', type: 'string', length: 50 },
                { name: 'net_time', type: 'string', length: 50 },
                { name: 'status', type: 'string', length: 50 },
                { name: 'drive_link', type: 'string' },
                { name: 'filemanager_link', type: 'string' },
                { name: 'category', type: 'string', length: 10 },
                { name: 'client_id', type: 'number' },
                { name: 'sub_code', type: 'string', length: 50 },
                { name: 'version', type: 'string', length: 10 },
                { name: 'target_hour', type: 'number' },
                { name: 'per_day_hour', type: 'number' },
                { name: 'month', type: 'string', length: 2 },
                { name: 'year', type: 'string', length: 2 },
                { name: 'priority', type: 'string', length: 10 },
                { name: 'project_photo', type: 'string' },
                { name: 'created_by', type: 'string' },
                { name: 'completed_tasks', type: 'string' },
                { name: 'checked_tasks', type: 'string' },
                { name: 'hold_date', type: 'date' },
                { name: 'hold_reason', type: 'string' },
                { name: 'documentation', type: 'string' },
                { name: 'group_link', type: 'string' },
                { name: 'checked_tasks_by_pcb', type: 'string' },
                { name: 'overall_completion', type: 'number' }
                ,{ name: 'process_ids', type: 'json' }
                ,{ name: 'process_map', type: 'json' }
            ];

            // PCB-scoped checked tasks: merge one PCB's tasks into checked_tasks_by_pcb when pcb_code + checked_tasks provided
            if (body.pcb_code != null && body.pcb_code !== '' && body.checked_tasks !== undefined && body.checked_tasks_by_pcb === undefined) {
                let byPcb = {};
                try {
                    if (existingProject.checked_tasks_by_pcb) {
                        byPcb = JSON.parse(existingProject.checked_tasks_by_pcb);
                    }
                } catch (e) { /* ignore */ }
                const pcbCode = String(body.pcb_code).trim();
                byPcb[pcbCode] = (body.checked_tasks === '' || body.checked_tasks == null) ? '' : String(body.checked_tasks).trim();
                body.checked_tasks_by_pcb = JSON.stringify(byPcb);
                delete body.checked_tasks; // do not overwrite legacy checked_tasks column when updating by PCB
            }

            // Resolve assigned users from usernames before dynamic update fields are built.
            if (body.assigned_users_display !== undefined) {
                const resolvedAssign = ProjectModel.resolveAssignedUsers({
                    assigned_users_display: body.assigned_users_display,
                });
                body.assigned_users_display = resolvedAssign.assignedUsersDisplay;
            }

            for (const field of fields) {
                if (body[field.name] !== undefined) {
                    let val = body[field.name];

                    if (field.name === 'checked_tasks' || field.name === 'completed_tasks') {
                        if (val === '') {
                            val = null;
                        } else if (Array.isArray(val)) {
                            // Backend expects comma-separated string (see checked_tasks.split(','))
                            val = val.map(String).join(',');
                        }
                    }

                    if (field.type === 'string' && field.length) {
                        val = typeof val === 'string' ? truncateString(val, field.length) : (val == null ? val : String(val));
                        if (field.name === 'project_name' || field.name === 'sub_code') {
                            val = val ? String(val).toUpperCase() : val;
                        }
                    } else if (field.type === 'date') {
                        val = formatDateForDB(val);
                    } else if (field.type === 'json') {
                        val = Array.isArray(val) ? JSON.stringify(val) : val;
                        updates.push(`${field.name} = $${paramCount++}::jsonb`);
                        values.push(val);
                        continue;
                    }

                    updates.push(`${field.name} = $${paramCount++}`);
                    values.push(val);
                }
            }

            // Add calculated work_hour and net_time if they were calculated
            if (calculatedWorkHour !== null) {
                updates.push(`work_hour = $${paramCount++}`);
                values.push(truncateString(calculatedWorkHour, 50) || '0h');
            }
            if (calculatedNetTime !== null) {
                updates.push(`net_time = $${paramCount++}`);
                values.push(truncateString(calculatedNetTime, 50) || '0h');
            }

        if (updates.length === 0) {
            throw new AppError('No fields to update', 400);
        }

            values.push(id);
            const updatedProject = await ProjectModel.update(id, updates, values);

        if (!updatedProject) {
            throw new AppError('Project not found', 404);
        }

            if (body.process_ids !== undefined) {
                const parsedProcessIds = Array.isArray(body.process_ids)
                    ? body.process_ids
                    : body.process_ids != null
                        ? String(body.process_ids).split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n))
                        : [];

                const rawProcessMap = body.process_map && typeof body.process_map === 'object'
                    ? body.process_map
                    : await ProcessMapModel.buildProcessMapFromCategoryIds(id, parsedProcessIds);

                const processMap = ProcessMapModel.sanitizeCustomCategoryType(rawProcessMap);

                // Store the selected ids and editable process tree directly on PROJECT.
                await pool.query(
                    `UPDATE "PROJECT"
                     SET process_ids = $1::jsonb,
                         process_map = $2::jsonb,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = $3`,
                    [JSON.stringify(parsedProcessIds), JSON.stringify(processMap), id],
                );

                try {
                    const overall = await recalculateProjectOverallCompletion(id);
                    if (overall != null) {
                        updatedProject.overall_completion = overall;
                    }
                } catch (e) {
                    console.error('overall_completion recalculate failed (project update):', e.message || e);
                }

                updatedProject.process_ids = parsedProcessIds;
                updatedProject.process_map = processMap;
                updatedProject.process_mode = 'category';
            }

            // Broadcast WebSocket update (non-blocking)
            broadcast('project-update', 'updated', updatedProject);
            broadcastClientUpdate('updated', { source: 'project', id: updatedProject.id, project_code: updatedProject.project_code });

            // Audit log (best-effort)
            try {
                const candidate = Array.from(new Set([
                    ...Object.keys(body || {}),
                    'work_hour',
                    'net_time',
                    'status',
                    'project_code',
                    'project_name',
                    'serial_no',
                    'process_ids',
                    'overall_completion',
                ]));
                const patch = pickChangedColumns(existingProject, updatedProject, candidate);
                await writeAuditLog(req, {
                    action: 'UPDATE',
                    tableName: 'PROJECT',
                    tableOfId: updatedProject.id,
                    tableOfColumn: patch.columns.join(','),
                    oldValue: patch.oldValue,
                    newValue: patch.newValue,
                    userId
                });
                await insertProjectFieldLogs({
                    projectId: updatedProject.id,
                    projectCode: updatedProject.project_code || existingProject.project_code,
                    changed: patch,
                    updatedBy: getUsernameFromReq(req),
                });
            } catch (e) {
                console.error('Audit log write failed (project update):', e.message || e);
            }

            // Handle HS_Status table updates (non-blocking, don't wait)
            const nextStatus = String(body.status || '').trim().toLowerCase();
            const prevStatus = String(oldStatus || '').trim().toLowerCase();
            const shouldLogHsStatus =
                (nextStatus === 'on hold' || nextStatus === 'stopped') &&
                prevStatus &&
                prevStatus !== nextStatus;

            if (shouldLogHsStatus) {
                setImmediate(async () => {
                    try {
                        const projectId = parseInt(id);
                        const projectCode = updatedProject.project_code || existingProject.project_code;
                        const statusDate =
                            body.hold_date ||
                            body.stopped_date ||
                            formatDateForDB(new Date().toISOString().split('T')[0]);
                        const reasonNote = String(
                            body.hold_reason ?? body.stopped_reason ?? '',
                        ).trim();
                        const updateBy =
                            body.update_by ||
                            req.headers['x-user-name'] ||
                            req.headers['x-user'] ||
                            'System';
                        const currentStatusLabel =
                            nextStatus === 'on hold' ? 'On Hold' : 'Stopped';

                        await pool.query(
                            `INSERT INTO "HS_Status"(project_id, project_code, old_status, current_status, date, reason_note, update_by)
                            VALUES($1, $2, $3, $4, $5, $6, $7)`,
                            [
                                projectId,
                                projectCode,
                                oldStatus,
                                currentStatusLabel,
                                statusDate,
                                reasonNote,
                                updateBy,
                            ],
                        );
                    } catch (hsError) {
                        console.error('[HS_Status] Error inserting status change record:', hsError);
                    }
                });
            }

        res.json({
            success: true,
            message: 'Project updated successfully',
            project: updatedProject
        });
    }

    static async deleteProject(req, res) {
        const { id } = req.params;
            const userId = getUserIdFromReq(req);
        const existingProject = await ProjectModel.findById(id);
        if (!existingProject) {
            throw new AppError('Project not found', 404);
        }
        const deleted = await ProjectModel.delete(id);
        if (!deleted) {
            throw new AppError('Project not found', 404);
        }

            // Broadcast WebSocket update (non-blocking)
            broadcast('project-update', 'deleted', { id: parseInt(id) });
            broadcastClientUpdate('deleted', { source: 'project', id: parseInt(id, 10) });

            // Audit log (best-effort)
            try {
                await writeAuditLog(req, {
                    action: 'DELETE',
                    tableName: 'PROJECT',
                    tableOfId: parseInt(id, 10),
                    tableOfColumn: 'id',
                    oldValue: existingProject,
                    newValue: null,
                    userId
                });
            } catch (e) {
                console.error('Audit log write failed (project delete):', e.message || e);
            }

        res.json({
            success: true,
            message: 'Project deleted successfully'
        });
    }

    // Optimized: Upload photo/document to Cloudinary (async, non-blocking)
    static async uploadPhoto(req, res) {
        if (!req.file) {
            throw new AppError('No file provided', 400);
        }

            const projectCode = req.body.project_code || req.query.project_code || '';
            const cleanProjectCode = projectCode ? projectCode.replace(/[^a-zA-Z0-9-]/g, '_').toUpperCase() : 'UNKNOWN';
            const folderPath = `projects/${cleanProjectCode}`;

            const isImage = req.file.mimetype.startsWith('image/');
            const isDocument = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'].includes(req.file.mimetype);

        if (!isImage && !isDocument) {
            throw new AppError('Invalid file type. Only images (JPEG, PNG, GIF, WebP) and documents (PDF, DOC, DOCX, XLS, XLSX) are allowed.', 400);
        }

            const timestamp = Date.now();
            const originalName = req.file.originalname || (isImage ? 'project-photo' : 'document');

            let fileExtension = '';
            if (originalName.includes('.')) {
                fileExtension = originalName.split('.').pop().toLowerCase();
            } else {
                const mimeToExt = {
                    'application/pdf': 'pdf',
                    'application/msword': 'doc',
                    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
                    'application/vnd.ms-excel': 'xls',
                    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
                    'image/jpeg': 'jpg',
                    'image/jpg': 'jpg',
                    'image/png': 'png',
                    'image/gif': 'gif',
                    'image/webp': 'webp'
                };
                fileExtension = mimeToExt[req.file.mimetype] || 'file';
            }

            const nameWithoutExt = originalName.replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
            const cleanName = nameWithoutExt || (isImage ? 'project-photo' : 'document');
            const filePrefix = isDocument ? 'document' : 'photo';
            const publicId = `${folderPath}/${filePrefix}_${timestamp}_${cleanName}.${fileExtension}`;

            let uploadResult;

            if (isImage) {
                const base64Image = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
                uploadResult = await cloudinary.uploader.upload(base64Image, {
                    public_id: publicId,
                    folder: folderPath,
                    resource_type: 'image',
                    transformation: [
                        { width: 800, height: 800, crop: 'limit' },
                        { quality: 'auto' }
                    ]
                });
            } else {
                const base64Document = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
                uploadResult = await cloudinary.uploader.upload(base64Document, {
                    public_id: publicId,
                    folder: folderPath,
                    resource_type: 'raw'
                });
            }

        res.json({
            success: true,
            imageUrl: uploadResult.secure_url,
            url: uploadResult.secure_url,
            publicId: uploadResult.public_id,
            folder: folderPath,
            fileType: isDocument ? 'document' : 'image'
        });
    }
}

wrapController(ProjectController, [
    'getNextSerial',
    'getNextVersion',
    'getProjectStats',
    'getAllProjects',
    'getProjectById',
    'getProjectLogs',
    'getProjectByCode',
    'createProject',
    'updateProject',
    'deleteProject',
    'uploadPhoto',
]);

export default ProjectController;