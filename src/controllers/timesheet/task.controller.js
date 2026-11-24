import TaskModel, { TASK_PRIORITIES, TASK_STATUSES } from '../../models/timesheet/task.model.js';
import {
    recordTaskStatusChange,
    findTaskStatusHistory,
    findTaskStatusHistoryByTaskId,
    recordTaskStatusReason,
} from '../../models/timesheet/taskStatusHistory.model.js';
import TaskLogModel from '../../models/history/Tasklog.model.js';
import { writeAuditLog, getUsernameFromReq } from '../../utils/audit.utils.js';
import { AppError, wrapController } from '../../middleware/error.middleware.js';
import { pool } from '../../config/db.js';
import { resolveRequirementSerialYearCode } from '../../utils/financial-year.utils.js';
import { broadcast } from '../../config/socket.js';
import UserPagePermissionModel from '../../models/users/userPagePermission.model.js';


const TASK_VIEWS = new Set(['all', 'assigned', 'created']);
const TASK_PAGE_ID = 'task';
const PERMISSION_FLAGS = ['canView', 'canAdd', 'canEdit', 'canDelete', 'canHead', 'canExport', 'canOrganization'];


/**
 * Head and Organization users get EVERY Task right (view / add / edit / delete / export):
 * start, stop, schedule, edit, review ... never depend on the other ticks of the permission row.
 */
const grantFullRightsToHeadAndOrganization = (permission) => {
    if (permission.canHead === true || permission.canOrganization === true) {
        for (const flag of PERMISSION_FLAGS) permission[flag] = true;
        permission.hasAny = true;
    }
    return permission;
};


const getTaskPermission = async (req) => {
    if (req.pagePermission?.pageId === TASK_PAGE_ID) return grantFullRightsToHeadAndOrganization(req.pagePermission);


    const user = req.user;
    if (!user?.id) throw new AppError('Authentication required', 401);


    let permission;
    if (Number(user.access) === 1 || String(user.username ?? '').trim().toLowerCase() === 'admin') {
        permission = { pageId: TASK_PAGE_ID, isAdmin: true, ...Object.fromEntries(PERMISSION_FLAGS.map((f) => [f, true])) };
    } else {
        const rows = await UserPagePermissionModel.getByUsername(
            user.username,
            Number.isInteger(user.personalDetailsId) ? user.personalDetailsId : null,
        );
        const pageRows = rows.filter((r) => String(r.pageId) === TASK_PAGE_ID);
        const globalRows = pageRows.filter((r) => Number(r.locationId ?? 0) === 0);
        const source = globalRows.length > 0 ? globalRows : pageRows;
        permission = {
            pageId: TASK_PAGE_ID,
            isAdmin: false,
            ...Object.fromEntries(PERMISSION_FLAGS.map((f) => [f, source.some((r) => r[f] === true)])),
        };
    }


    permission.hasAny = PERMISSION_FLAGS.some((f) => permission[f] === true);
    grantFullRightsToHeadAndOrganization(permission);


    req.pagePermission = permission;
    return permission;
};


const requireTaskRead = async (req) => {
    const permission = await getTaskPermission(req);
    if (permission.hasAny && !permission.canView) {
        throw new AppError('You do not have permission (canView) for Task', 403);
    }
    return permission;
};


/** 403 unless the user has ANY of the listed rights (View / Add / Edit ...) on the Task page. */
const requireTaskPermission = async (req, ...flags) => {
    const permission = await getTaskPermission(req);
    if (!flags.some((flag) => permission[flag] === true)) {
        throw new AppError(`You do not have permission (${flags.join(' / ')}) for Task`, 403);
    }
    return permission;
};


/** Lower-case usernames of the user's department (the user included). Resolved on the server. */
const getDepartmentUsernames = async (username) => {
    const me = String(username ?? '').trim().toLowerCase();
    if (!me) return [];


    const result = await pool.query(
        `SELECT DISTINCT LOWER(TRIM(pd2.username)) AS username
         FROM personal_details pd
         INNER JOIN employment_details e1 ON e1.personal_details_id = pd.id
         INNER JOIN employment_details e2
                 ON LOWER(TRIM(e2.department::text)) = LOWER(TRIM(e1.department::text))
         INNER JOIN personal_details pd2 ON pd2.id = e2.personal_details_id
         WHERE LOWER(TRIM(pd.username)) = $1
           AND TRIM(COALESCE(e1.department::text, '')) <> ''
           AND pd2.username IS NOT NULL
           AND TRIM(pd2.username) <> ''`,
        [me],
    );


    const names = result.rows.map((r) => r.username).filter(Boolean);
    if (!names.includes(me)) names.push(me);
    return names;
};


const resolveScope = async (req) => {
    const me = String(getUsernameFromReq(req) ?? '').trim();
    const rawView = String(req.query.view ?? 'all').trim().toLowerCase();
    const view = TASK_VIEWS.has(rawView) ? rawView : 'all';
    const permission = await getTaskPermission(req);
    const isOrganization = me.toLowerCase() === 'admin' || permission.isAdmin || permission.canOrganization;
    const rawScope = String(req.query.scope ?? '').trim().toLowerCase();
    let scope = ['all', 'department', 'me'].includes(rawScope) ? rawScope : '';
    if (scope === 'all' && !isOrganization) scope = permission.canHead ? 'department' : 'me';
    if (scope === 'department' && !(isOrganization || permission.canHead)) scope = 'me';


    if (scope === 'me' && me) {
        return { mine: me, view, includeCreator: true };
    }


    if (scope === 'department' && me) {
        const teamUsernames = await getDepartmentUsernames(me);
        return { mine: me, view, teamUsernames, includeCreator: true };
    }


    if (isOrganization) {
        // "All" data scope is global.  "Assigned" / "Created" are task views inside
        // that global scope, not a restriction to the current organization user's own tasks.
        if (scope === 'all' || !scope) {
            if (view === 'all') return { mine: undefined, view, includeCreator: true };
            return { mine: me || '__no_user__', view, includeCreator: true };
        }
        return { mine: req.query.mine || me, view, includeCreator: true };
    }


    if (permission.canHead && view === 'all' && me) {
        const teamUsernames = await getDepartmentUsernames(me);
        return { mine: me, view, teamUsernames, includeCreator: true };
    }


    return { mine: me || '__no_user__', view, includeCreator: true };
};


const norm = (v) => String(v ?? '').trim();
const lower = (v) => String(v ?? '').trim().toLowerCase();
const isScheduleName = (v) => /^schedu(?:al|le|led)$/i.test(String(v ?? '').trim());
const isInProgressName = (v) => /^(in progress|running)$/i.test(String(v ?? '').trim());
const normalizeAssignedUser = (value) => TaskModel.parseAssignedTo(value)[0] ?? '';


/** Loads a task or answers 404. */
const findTaskOr404 = async (id) => {
    const task = await TaskModel.findById(id);
    if (!task) throw new AppError('Task not found', 404);
    return task;
};


/** Row-level check: the task must be inside the user's scope (see resolveScope). */
const assertTaskVisible = async (req, task) => {
    const permission = await getTaskPermission(req);
    const me = lower(getUsernameFromReq(req));
    if (me === 'admin' || permission.isAdmin || permission.canOrganization) return;


    const assignees = TaskModel.parseAssignedTo(task.assigned_to).map(lower);
    const assigner = lower(task.assigned_by);
    const creator = lower(task.created_by);


    // My own task: assigned to me, assigned by me or created by me.
    if (me && (assignees.includes(me) || assigner === me || creator === me)) return;
    if (permission.canHead && me) {
        const team = new Set(await getDepartmentUsernames(me));
        if (assignees.some((name) => team.has(name)) || team.has(assigner) || team.has(creator)) return;
    }


    throw new AppError('You do not have access to this task', 403);
};


/** Loads a task the user is allowed to see (404 when missing, 403 when out of scope). */
const findVisibleTaskOr404 = async (req, id) => {
    const task = await findTaskOr404(id);
    await assertTaskVisible(req, task);
    return task;
};


/** Task details / assignment can only be changed with the Edit right. */
const assertEditRightForDetails = (req, body, existing) => {
    const permission = req.pagePermission ?? {};
    if (permission.isAdmin || permission.canEdit) return;


    const pairs = [
        ['title', 'title'], ['description', 'description'], ['project_code', 'projectCode'],
        ['project_category', 'projectCategory'], ['process_name', 'processName'],
        ['assigned_by', 'assignedBy'], ['priority', 'priority'],
    ];
    const textChanged = pairs.some(([snake, camel]) => {
        const sent = body[snake] ?? body[camel];
        return sent !== undefined && norm(sent) !== norm(existing[snake]);
    });


    const sentAssignee = body.assigned_to ?? body.assignedTo;
    const assigneeChanged =
        sentAssignee !== undefined &&
        lower(normalizeAssignedUser(sentAssignee)) !== lower(normalizeAssignedUser(existing.assigned_to));


    const sentHour = body.target_hour ?? body.targetHour;
    // Compare as normalized "h:mm:ss" text (1.5, "01:30:00" and "1:30:00" are the same value).
    const hourChanged =
        sentHour !== undefined && TaskModel.toStoredHms(sentHour) !== TaskModel.toStoredHms(existing.target_hour);


    const sentTarget = body.target_completion_at ?? body.targetCompletionAt;
    const targetChanged =
        sentTarget !== undefined &&
        sentTarget !== null &&
        new Date(sentTarget).getTime() !== new Date(existing.target_completion_at).getTime();


    if (textChanged || assigneeChanged || hourChanged || targetChanged) {
        throw new AppError('You do not have the Edit permission to change this task', 403);
    }
};




const buildPagination = ({ total, page, limit }) => ({
    total,
    page,
    limit,
    totalPages: limit ? Math.ceil(total / limit) || 0 : 1,
});


/** First key present in the body. An explicit null/'' counts as sent (so a field can be cleared). */
const pickSent = (body, ...keys) => {
    for (const key of keys) {
        if (body[key] !== undefined) return body[key];
    }
    return undefined;
};


const parseDateTime = (value, label) => {
    if (value === undefined) return undefined;
    if (value === null || String(value).trim() === '') return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new AppError(`${label} is not a valid date & time`, 400);
    return date.toISOString();
};


class TaskController {
   
    static assertTargetHour(value) {
        const text = String(value ?? '').trim();
        if (!text) return;
        let hours = NaN;
        if (text.includes(':')) {
            const match = /^(\d{1,3})(?::(\d{1,2}))?(?::(\d{1,2}))?$/.exec(text);
            if (match) {
                const [, h, m = '0', sec = '0'] = match;
                if (Number(h) <= 999 && Number(m) <= 59 && Number(sec) <= 59) {
                    hours = (Number(h) * 3600 + Number(m) * 60 + Number(sec)) / 3600;
                }
            }
        } else if (text) {
            hours = Number(text);
        }
        if (!Number.isFinite(hours) || hours < 0) {
            throw new AppError('Target Hours must be a valid duration (HH:MM:SS)', 400);
        }
    }


    static assertTargetNotBeforeAssigned(assignedAt, targetAt) {
        if (!assignedAt || !targetAt) return;
        const assigned = new Date(assignedAt).getTime();
        const target = new Date(targetAt).getTime();
        if (Number.isNaN(assigned) || Number.isNaN(target)) return;
        if (target < assigned) {
            throw new AppError('Target Completion Date & Time can not be before the Assigned Date & Time', 400);
        }
    }


    /** "HH:MM:SS" / "HH:MM" / decimal hours -> seconds (NaN when empty or invalid). */
    static targetHourToSeconds(value) {
        const text = String(value ?? '').trim();
        if (!text) return NaN;
        if (text.includes(':')) {
            const match = /^(\d{1,3})(?::(\d{1,2}))?(?::(\d{1,2}))?$/.exec(text);
            if (!match) return NaN;
            const [, h, m = '0', sec = '0'] = match;
            if (Number(h) > 999 || Number(m) > 59 || Number(sec) > 59) return NaN;
            return Number(h) * 3600 + Number(m) * 60 + Number(sec);
        }
        const hours = Number(text);
        return Number.isFinite(hours) ? Math.round(hours * 3600) : NaN;
    }


    /**
     * The time between Assigned and Target Completion Date & Time must always be able to hold the
     * Target Hours: a window shorter than the Target Hours is not allowed.
     */
    static assertTargetHourFitsWindow(assignedAt, targetAt, targetHour) {
        if (!assignedAt || !targetAt) return;
        const assigned = new Date(assignedAt).getTime();
        const target = new Date(targetAt).getTime();
        const needed = TaskController.targetHourToSeconds(targetHour);
        if (Number.isNaN(assigned) || Number.isNaN(target) || !Number.isFinite(needed) || needed <= 0) return;


        const available = Math.floor((target - assigned) / 1000);
        if (available < needed) {
            const fmt = (total) => {
                const t = Math.max(0, total);
                const pad = (n) => String(n).padStart(2, '0');
                return `${pad(Math.floor(t / 3600))}:${pad(Math.floor((t % 3600) / 60))}:${pad(t % 60)}`;
            };
            throw new AppError(
                `Target Hours (${fmt(needed)}) do not fit between the Assigned and Target Completion Date & Time (${fmt(available)}). `
                + 'Increase the Target Completion Date & Time or reduce the Target Hours.',
                400,
            );
        }
    }


    static async validateStatusRequirements(status, body = {}) {
        if (!status) return;


        // Task statuses are fixed (TASK_STATUSES): NOT read from Settings > Task Status.
        const wanted = String(status).trim().toLowerCase();
        const configured = TASK_STATUSES.find((name) => name.toLowerCase() === wanted);
        if (!configured) {
            throw new AppError(`Invalid status "${status}". Allowed values: ${TASK_STATUSES.join(', ')}`, 400);
        }
        return configured;
    }


    static normalizePriority(priority) {
        if (priority === undefined || priority === null || String(priority).trim() === '') return 'Medium';


        const normalized = String(priority).trim();
        const match = TASK_PRIORITIES.find((p) => p.toLowerCase() === normalized.toLowerCase());


        if (!match) {
            throw new AppError(`Invalid priority "${priority}". Allowed values: ${TASK_PRIORITIES.join(', ')}`, 400);
        }


        return match;
    }


    static emitTaskUpdate(type, task, oldStatus = null) {
        try {
            broadcast('task-update', type, {
                id: task?.id ?? null,
                status: task?.status ?? null,
                old_status: oldStatus,
                assigned_by: task?.assigned_by ?? null,
                created_by: task?.created_by ?? null,
            });
        } catch (e) {
            console.error('Task socket broadcast failed:', e.message || e);
        }
    }


    /** GET /api/tasks/user-photos[?usernames=a,b] - username + profile photo for task avatars. */
    /** Whole-system lists (every task's log / history) are for Organization / admin only. */
    static async assertOrganizationOnly(req) {
        await requireTaskPermission(req, 'canView');
        const permission = await getTaskPermission(req);
        const me = lower(getUsernameFromReq(req));
        if (me === 'admin' || permission.isAdmin || permission.canOrganization) return;
        throw new AppError('Only Organization users can list the logs of all tasks', 403);
    }


    static async getUserPhotos(req, res) {
        const usernames = String(req.query.usernames ?? '')
            .split(',')
            .map((name) => name.trim())
            .filter(Boolean);


        const rows = await TaskModel.findUserPhotos(usernames);


        res.set('Cache-Control', 'private, max-age=300');
        res.json({ success: true, data: rows });
    }


    /** Prefix + year code for new task serial numbers (from settings). */
    static async resolveSerialParts(req) {
        const settingsResult = await pool.query(`
            SELECT key, value FROM settings
            WHERE key IN ('task_serial_prefix', 'task_serial_year_format')
        `);


        const settings = {};
        (settingsResult.rows || []).forEach((row) => { settings[row.key] = row.value; });


        const prefix = settings.task_serial_prefix || req.query.prefix || 'TSK';
        const yearFormat = (settings.task_serial_year_format || 'FINANCIAL_YEAR').toString().trim();
        const yearCode = await resolveRequirementSerialYearCode(pool, yearFormat);
        return { prefix, yearCode };
    }


    /** Preview only. The real number is assigned by the server when the task is created. */
    static async getNextSerialNumber(req, res) {
        await requireTaskPermission(req, 'canAdd');
        const { prefix, yearCode } = await TaskController.resolveSerialParts(req);
        const latest = await TaskModel.findLatestSerialNumber(prefix, yearCode);
        const serialNumber = TaskModel.buildNextSerial(latest, prefix, yearCode);


        res.json({ success: true, serialNumber, serial_number: serialNumber });
    }


    static parseCardOrder(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new AppError('card_order must be an object like { "1": [77, 90] }', 400);
        }
        const order = {};
        for (const [statusId, ids] of Object.entries(value)) {
            if (!/^\d+$/.test(statusId)) throw new AppError(`Invalid status id "${statusId}" in card_order`, 400);
            if (!Array.isArray(ids)) throw new AppError(`card_order["${statusId}"] must be an array of task ids`, 400);
            const seen = new Set();
            for (const raw of ids) {
                const id = Number(raw);
                if (!Number.isInteger(id) || id <= 0) {
                    throw new AppError(`Invalid task id "${raw}" in card_order["${statusId}"]`, 400);
                }
                seen.add(id);
            }
            order[statusId] = [...seen];
        }
        return order;
    }


    static parseCollapsedColumns(value) {
        if (value == null) return null;
        if (!Array.isArray(value)) {
            throw new AppError('collapsed_columns must be an array of column ids', 400);
        }
        const seen = new Set();
        return value.reduce((ids, raw) => {
            const id = String(raw ?? '').trim();
            if (!id || seen.has(id)) return ids;
            seen.add(id);
            ids.push(id);
            return ids;
        }, []);
    }


    /** PUT /api/tasks/board-preference - saves the logged-in user's board preference. */
    static async saveBoardPreference(req, res) {
        await requireTaskRead(req);
        const me = String(getUsernameFromReq(req) ?? '').trim();
        if (!me) throw new AppError('Could not determine the logged-in user', 401);


        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const cardOrder = TaskController.parseCardOrder(body.card_order ?? body.cardOrder);
        const parsedCollapsedColumns = TaskController.parseCollapsedColumns(
            body.collapsed_columns ?? body.collapsedColumns,
        );
        const existingPreference =
            parsedCollapsedColumns === null
                ? await TaskModel.findBoardPreference(me)
                : null;
        const collapsedColumns =
            parsedCollapsedColumns === null
                ? (existingPreference?.collapsed_columns ?? [])
                : parsedCollapsedColumns;
        const preference = await TaskModel.saveBoardPreference(me, cardOrder, collapsedColumns);


        res.json({ success: true, message: 'Board preference saved.', data: preference });
    }


    /** GET /api/tasks/board-preference - the logged-in user's saved board preference. */
    static async getBoardPreference(req, res) {
        await requireTaskRead(req);
        const me = String(getUsernameFromReq(req) ?? '').trim();
        if (!me) throw new AppError('Could not determine the logged-in user', 401);


        const preference = await TaskModel.findBoardPreference(me);
        res.json({ success: true, data: preference });
    }


    static async getAllTasks(req, res) {
        await requireTaskRead(req);
        const {
            project_category, project_code, project_id, project_by, process_id,
            process_name, status, created_by, assigned_by, assigned_to, search,
            target_completion_date, serial_number, title, assigned_date, priority,
        } = req.query;
        const { mine, view, teamUsernames, includeCreator } = await resolveScope(req);


        const tasks = await TaskModel.findAll({
            project_category, project_code, project_id, project_by, process_id,
            process_name, status, created_by, assigned_by, assigned_to, search,
            target_completion_date, serial_number, title, assigned_date, mine, view, priority, teamUsernames, includeCreator,
        });


        res.json(tasks);
    }


    static async searchTasks(req, res) {
        await requireTaskRead(req);
        const { q, status, priority } = req.query;
        const { mine, view, teamUsernames, includeCreator } = await resolveScope(req);


        // Stat card filters: Priority / User / Date are applied here, not in the browser.
        const priorityKind = lower(req.query.priority_kind);
        const dateFilter = lower(req.query.date_filter);
        // Viewer's time zone (e.g. Asia/Calcutta) so "Today" means the user's day. Unknown name -> UTC.
        let tz = norm(req.query.tz) || 'UTC';
        if (tz !== 'UTC') {
            const known = await pool.query('SELECT 1 FROM pg_timezone_names WHERE name = $1 LIMIT 1', [tz]);
            if (known.rowCount === 0) tz = 'UTC';
        }
        const cardFilters = {
            priority_kind: ['high', 'medium', 'low'].includes(priorityKind) ? priorityKind : undefined,
            date_filter: ['past', 'yesterday', 'today', 'tomorrow', 'week'].includes(dateFilter) ? dateFilter : undefined,
            assigned_user: norm(req.query.assigned_user) || undefined,
            // Created dropdown: the user box is the assignee (assign_user).
            // Assigned dropdown: the user box is the creator (created_user).
            // All: a ticked name matches either role.
            assigned_users: view === 'created'
                ? TaskModel.cleanUserList(
                    req.query.assign_user ?? req.query.assigned_users ?? req.query.related_users,
                )
                : undefined,
            creator_users: view === 'assigned'
                ? TaskModel.cleanUserList(
                    req.query.created_user ?? req.query.creator_users ?? req.query.related_users,
                )
                : undefined,
            related_users: view === 'all'
                ? TaskModel.cleanUserList(
                    req.query.related_users ?? req.query.assign_user ?? req.query.assigned_users,
                )
                : undefined,
            tz,
        };


        const filters = { q, mine, view, priority, teamUsernames, includeCreator };


        const [tasks, counts, dimensionCounts] = await Promise.all([
            TaskModel.findAll({ ...filters, ...cardFilters, status }),
            TaskModel.countByStatus({ ...filters, ...cardFilters }),
            TaskModel.dimensionCounts(filters, tz),
        ]);


        const total = Object.values(counts).reduce((sum, n) => sum + n, 0);


        res.json({ success: true, tasks, counts, total, dimension_counts: dimensionCounts });
    }


    static async getPendingReviewCount(req, res) {
        const username = getUsernameFromReq(req);
        if (!username) throw new AppError('Username is required', 400);


        const count = await TaskModel.countPendingReview(username);


        // A live number - never let a browser / proxy serve an old one.
        res.set('Cache-Control', 'no-store');
        res.json({ success: true, username, count });
    }


    /** GET /api/tasks/:id/time-entries - timesheet rows booked on this task. */
    static async getTaskTimeEntries(req, res) {
        await requireTaskRead(req);
        const { id } = req.params;
        const task = await findVisibleTaskOr404(req, id);


        const entries = await TaskModel.findTimeEntries(id);


        res.json({ success: true, task_id: parseInt(id, 10), entries });
    }


    static async getTasksByProcess(req, res) {
        await requireTaskRead(req);
        const {
            project_id, project_code, process_id, process_path, process_name,
            category_letter, pcb_code, include_parents, include_children, all_projects,
        } = req.query;


        if (!project_id && !project_code) {
            throw new AppError('project_id or project_code is required', 400);
        }


        const path = process_path ?? process_name;
        if (!process_id && !(path && String(path).trim())) {
            throw new AppError('process_id or process_path is required', 400);
        }


        const isTrue = (v) => ['true', '1', 'yes'].includes(lower(v));
        const isFalse = (v) => ['false', '0', 'no'].includes(lower(v));


        const { process, tasks } = await TaskModel.findByProcessScope({
            project_id,
            project_code,
            process_id,
            process_path: path,
            category_letter,
            pcb_code,
            include_parents: !isFalse(include_parents),
            include_children: !isFalse(include_children),
            all_projects: isTrue(all_projects),
        });


        const counts = { parent: 0, self: 0, child: 0, total: tasks.length, other_projects: 0 };
        for (const task of tasks) {
            counts[task.relation] += 1;
            if (!task.is_current_project) counts.other_projects += 1;
        }


        res.json({ success: true, process, counts, tasks });
    }


    static async getTaskById(req, res) {
        await requireTaskRead(req);
        const { id } = req.params;
        const task = await findVisibleTaskOr404(req, id);
        res.json(task);
    }


    /** POST /api/tasks */
    static async createTask(req, res) {
        await requireTaskPermission(req, 'canAdd');
        const body = req.body && typeof req.body === 'object' ? req.body : {};


        const title = body.title;
        const project_category = body.project_category ?? body.projectCategory;
        const project_id = body.project_id ?? body.projectId;
        const project_code = body.project_code ?? body.projectCode;
        const project_by = body.project_by ?? body.projectBy;
        const process_id = body.process_id ?? body.processId;
        const process_name = body.process_name ?? body.processName;
        const serial_number = body.serial_number ?? body.serialNumber;
        const description = body.description;
        const status = body.status;
        const assigned_by = body.assigned_by ?? body.assignedBy;
        const assigned_to = body.assigned_to ?? body.assignedTo;
        const assigned_at = parseDateTime(pickSent(body, 'assigned_at', 'assignedAt'), 'Assigned Date & Time');
        const target_completion_at = parseDateTime(
            pickSent(body, 'target_completion_at', 'targetCompletionAt'),
            'Target Completion Date & Time',
        );
        const target_hour = body.target_hour ?? body.targetHour;
        const priority = TaskController.normalizePriority(body.priority);
        const assignedUser = normalizeAssignedUser(assigned_to);


        const created_by =
            req.user?.username || req.headers['x-username'] || body.created_by || body.createdBy;


        if (!title || !String(title).trim()) throw new AppError('Title is required', 400);
        if (!project_code || !String(project_code).trim()) {
            throw new AppError('Project is required (project_code)', 400);
        }
        if (!description || !String(description).trim()) throw new AppError('Description is required', 400);
        TaskController.assertTargetHour(target_hour);
        TaskController.assertTargetNotBeforeAssigned(assigned_at, target_completion_at);


        let normalizedStatus;
        if (status) {
            normalizedStatus = await TaskController.validateStatusRequirements(status, body);
        } else {
            normalizedStatus = TASK_STATUSES[0]; // 'New'
        }


        // Status is always stored in UPPERCASE.
        normalizedStatus = String(normalizedStatus).trim().toUpperCase();


        // A NEW task created directly in Schedule: same rules as moving a task to Schedule.
        if (isScheduleName(normalizedStatus)) {
            if (!assignedUser) throw new AppError('Assign this task to a user before scheduling it', 400);
            if (!assigned_at) throw new AppError('Assigned Date & Time is required to schedule a task', 400);
            if (new Date(assigned_at).getTime() < Date.now() - 60 * 1000) {
                throw new AppError('Assigned Date & Time must be in the future to schedule a task', 400);
            }
        }


        let createAssignedAt = assigned_at;
        if (isInProgressName(normalizedStatus)) {
            if (!assignedUser) throw new AppError('Assign this task to a user before moving it to In Progress', 400);
            const clientMs = assigned_at ? new Date(assigned_at).getTime() : NaN;
            const fresh =
                Number.isFinite(clientMs) && Math.abs(Date.now() - clientMs) <= 2 * 60 * 1000;
            // Immediate sends Assigned Date & Time and Target Hours from the same moment.
            // Keep that moment so the hours still fit. Replace a missing or old time.
            if (!fresh) createAssignedAt = new Date().toISOString();
        }


        TaskController.assertTargetHourFitsWindow(createAssignedAt, target_completion_at, target_hour);
        const taskData = {
            title, project_category, project_id, project_code, project_by,
            process_id, process_name, description, status: normalizedStatus, created_by,
            assigned_by, assigned_to: assignedUser || null, assigned_at: createAssignedAt, target_completion_at,
            target_hour, priority,
        };
        const requestedSerial = String(serial_number ?? '').trim();
        let task;
        if (requestedSerial) {
            try {
                task = await TaskModel.createWithSerial(taskData, requestedSerial);
            } catch (error) {
                if (error.code === 'SERIAL_TAKEN') {
                    throw new AppError(
                        `Task code ${requestedSerial} is already taken by another user. Click the refresh icon next to the task code to get a new one, then create the task again.`,
                        409,
                    );
                }
                throw error;
            }
        } else {
            const serialParts = await TaskController.resolveSerialParts(req);
            task = await TaskModel.createWithNextSerial(taskData, serialParts);
        }


        try {
            await writeAuditLog(req, {
                action: 'CREATE', tableName: 'tasks', tableOfId: task.id,
                tableOfColumn: 'id', oldValue: null, newValue: task,
            });
        } catch (e) {
            console.error('Audit log write failed (task create):', e.message || e);
        }


        try {
            await recordTaskStatusChange({
                task_id: task.id, old_status: null, new_status: task.status,
                user_name: getUsernameFromReq(req) || created_by,
                performed_by: req.user?.id ?? null,
            });
        } catch (e) {
            console.error('Task status history write failed (task create):', e.message || e);
        }


        TaskController.emitTaskUpdate('created', task);
        scheduleNextAutoStart();


        res.status(201).json(task);
    }


    static async updateTask(req, res) {
        await requireTaskPermission(req, 'canEdit', 'canAdd');
        const { id } = req.params;
        const body = req.body && typeof req.body === 'object' ? req.body : {};


        const existing = await findVisibleTaskOr404(req, id);
        assertEditRightForDetails(req, body, existing);


        const requester = lower(getUsernameFromReq(req));
        const owner = lower(existing.assigned_by ?? existing.created_by);
        const isOwner = !owner || requester === owner || requester === 'admin';




        const scheduleAttempt =
            body.status !== undefined && lower(existing.status) === 'new' && lower(body.status) !== 'new';
        const pagePermission = req.pagePermission ?? {};
        const hasEditRight =
            pagePermission.isAdmin === true ||
            (pagePermission.canEdit === true && (pagePermission.canHead === true || pagePermission.canOrganization === true));
        if (!isOwner && !hasEditRight && scheduleAttempt) {
            throw new AppError('Only the user who assigned this task (or a Head / Organization user) can schedule it', 403);
        }
        if (!isOwner && !hasEditRight) {
            const detailChanged = [
                ['title', body.title],
                ['description', body.description],
                ['project_code', body.project_code ?? body.projectCode],
                ['project_category', body.project_category ?? body.projectCategory],
                ['process_name', body.process_name ?? body.processName],
                ['assigned_by', body.assigned_by ?? body.assignedBy],
            ].some(([key, value]) => value !== undefined && norm(value) !== norm(existing[key]));
            const priorityChanged =
                body.priority !== undefined &&
                norm(TaskController.normalizePriority(body.priority)) !== norm(existing.priority);
            if (detailChanged || priorityChanged) {
                throw new AppError('Only the user who assigned this task (or a Head / Organization user) can edit it', 403);
            }
        }


        let normalizedStatus = body.status;


        if (
            body.status &&
            lower(body.status) !== lower(existing.status)
        ) {
            normalizedStatus = await TaskController.validateStatusRequirements(body.status, { ...existing, ...body });
        }


        // Status is always stored in UPPERCASE.
        if (normalizedStatus) normalizedStatus = String(normalizedStatus).trim().toUpperCase();


        const hasAssignedTo = body.assigned_to !== undefined || body.assignedTo !== undefined;
        const assigned_to = hasAssignedTo ? (body.assigned_to ?? body.assignedTo) : existing.assigned_to;
        const assignedUser = normalizeAssignedUser(assigned_to);


        if (hasAssignedTo) {
            const assigneeChanged =
                lower(assignedUser) !== lower(normalizeAssignedUser(existing.assigned_to));
            if (assigneeChanged) {
                const currentStatus = String(existing.status ?? '').trim();
                const isNewOrSchedule = lower(currentStatus) === 'new' || isScheduleName(currentStatus);
                const isInProgress = isInProgressName(currentStatus);


                if (!isNewOrSchedule && !isInProgress) {
                    throw new AppError(
                        'Assigned user can only be changed while the task is in New, Schedule or In Progress status',
                        400,
                    );
                }


                if (isInProgress) {
                    const running = await pool.query(
                        `SELECT 1 FROM "TIMESHEET" ts
                         WHERE ts.task_id = $1
                           AND (ts.stop_time IS NULL OR TRIM(ts.stop_time::text) = '' OR ts.stop_time::text = 'Ongoing')
                         LIMIT 1`,
                        [existing.id],
                    );
                    if (running.rowCount > 0) {
                        throw new AppError('Stop the running timer before changing the assigned user', 400);
                    }
                }
            }
        }


        // An unassigned task can never be scheduled.
        if (isScheduleName(normalizedStatus) && !assignedUser) {
            throw new AppError('Assign this task to a user before scheduling it', 400);
        }


        const title = body.title;
        // A field that is sent must not be blank (title / description / project can never be emptied).
        if (title !== undefined && !String(title ?? '').trim()) throw new AppError('Title is required', 400);
        if (body.description !== undefined && !String(body.description ?? '').trim()) {
            throw new AppError('Description is required', 400);
        }
        const bodyProject = body.project_code ?? body.projectCode;
        if (bodyProject !== undefined && !String(bodyProject ?? '').trim()) {
            throw new AppError('Project is required (project_code)', 400);
        }
        // Assigned Date & Time is only sent when the task is scheduled; otherwise it stays as saved.
        let assigned_at = parseDateTime(pickSent(body, 'assigned_at', 'assignedAt'), 'Assigned Date & Time');
        const target_completion_at = parseDateTime(
            pickSent(body, 'target_completion_at', 'targetCompletionAt'),
            'Target Completion Date & Time',
        );
        const sentTargetHour = pickSent(body, 'target_hour', 'targetHour');
        if (sentTargetHour !== undefined) {
            TaskController.assertTargetHour(sentTargetHour);
        }
        TaskController.assertTargetNotBeforeAssigned(
            assigned_at ?? existing.assigned_at,
            target_completion_at ?? existing.target_completion_at,
        );
        const windowTouched = [
            pickSent(body, 'assigned_at', 'assignedAt'),
            pickSent(body, 'target_completion_at', 'targetCompletionAt'),
            pickSent(body, 'target_hour', 'targetHour'),
        ].some((value) => value !== undefined);
        if (windowTouched) {
            const sentHour = pickSent(body, 'target_hour', 'targetHour');
            TaskController.assertTargetHourFitsWindow(
                assigned_at ?? existing.assigned_at,
                target_completion_at ?? existing.target_completion_at,
                sentHour !== undefined ? sentHour : existing.target_hour,
            );
        }


       
        const rejectReason = String(body.reject_reason ?? body.rejectReason ?? '').trim();
        const existingStatus = lower(existing.status);
        const nextStatus = lower(normalizedStatus);
        let rejectFields = {};
        if (nextStatus === 'review' && existingStatus !== 'review' && !rejectReason) {
            const started = await pool.query(
                'SELECT 1 FROM "TIMESHEET" WHERE task_id = $1 LIMIT 1',
                [existing.id],
            );
            if (started.rowCount === 0) {
                throw new AppError('Start this task first. A task can only be moved to Review after it has been started.', 400);
            }
        }


        if (rejectReason) {
            if (existingStatus !== 'review') {
                throw new AppError('Only a task in Review can be rejected', 400);
            }
            rejectFields = { reject_reason: rejectReason, was_rejected: true };
        } else if (nextStatus && nextStatus !== existingStatus && ['review', 'completed'].includes(nextStatus)) {
            rejectFields = { reject_reason: null };
        }


        const statusReason = String(body.status_reason ?? body.statusReason ?? '').trim();
        const changeNote = String(body.change_reason ?? body.changeReason ?? '').trim();
        const STATUS_REASON_STATUSES = ['on hold', 'stopped'];
        let statusReasonFields = {};


        if (statusReason) {
            if (!STATUS_REASON_STATUSES.includes(nextStatus || existingStatus)) {
                throw new AppError('A reason can only be saved for On Hold or Stopped tasks', 400);
            }
            statusReasonFields = { status_reason: statusReason };
        } else if (nextStatus && nextStatus !== existingStatus && !STATUS_REASON_STATUSES.includes(nextStatus)) {
            statusReasonFields = { status_reason: null };
        }


        let resumedFields = {};
        if (
            nextStatus &&
            nextStatus !== existingStatus &&
            existingStatus === 'on hold' &&
            !['on hold', 'stopped'].includes(nextStatus)
        ) {
            resumedFields = { resumed_from_hold: true };
        }


        // ---- Assigned Date & Time rules for Schedule / Immediate (enforced here, not only in the UI) ----
        const statusChanging = Boolean(nextStatus) && nextStatus !== existingStatus;


        // A RUNNING task (an ongoing timesheet row) can only be stopped / moved out of In Progress by the user
        // whose timer it is. Head, Organization and the assigner can not stop it for him.
        if (statusChanging && isInProgressName(existing.status) && !isInProgressName(nextStatus)) {
            const ongoing = await pool.query(
                `SELECT ts.user_id, LOWER(TRIM(COALESCE(ts.user_name, ''))) AS user_name
                 FROM "TIMESHEET" ts
                 WHERE ts.task_id = $1
                   AND (ts.stop_time IS NULL OR TRIM(ts.stop_time::text) = '' OR ts.stop_time::text = 'Ongoing')`,
                [existing.id],
            );
            if (ongoing.rowCount > 0) {
                const myId = req.user?.id != null ? String(req.user.id) : null;
                const isTimerOwner = ongoing.rows.some(
                    (row) =>
                        (myId && row.user_id != null && String(row.user_id) === myId) ||
                        (requester && row.user_name === requester),
                );
                if (!isTimerOwner) {
                    throw new AppError(
                        'This task is running. Only the user it is assigned to can stop it.',
                        403,
                    );
                }
            }
        }


        if (
            statusChanging &&
            isInProgressName(nextStatus) &&
            (existingStatus === 'new' || existingStatus === 'on hold' || isScheduleName(existingStatus))
        ) {
            const clientMs = assigned_at ? new Date(assigned_at).getTime() : NaN;
            const fresh =
                Number.isFinite(clientMs) && Math.abs(Date.now() - clientMs) <= 2 * 60 * 1000;
            if (!fresh) assigned_at = new Date().toISOString();
        }


        if (statusChanging && isScheduleName(nextStatus)) {
            if (!assigned_at) {
                throw new AppError('Assigned Date & Time is required to schedule a task', 400);
            }
            if (new Date(assigned_at).getTime() < Date.now() - 60 * 1000) {
                throw new AppError('Assigned Date & Time must be in the future to schedule a task', 400);
            }
        }


        const editedBy = getUsernameFromReq(req) || (body.user_name ?? body.userName) || null;


        const updated = await TaskModel.update(id, {
            ...rejectFields,
            ...statusReasonFields,
            ...resumedFields,
            title,
            project_category: body.project_category ?? body.projectCategory,
            project_id: body.project_id ?? body.projectId,
            project_code: body.project_code ?? body.projectCode,
            project_by: body.project_by ?? body.projectBy,
            process_id: body.process_id ?? body.processId,
            process_name: body.process_name ?? body.processName,
            description: body.description,
            status: normalizedStatus,
            priority: body.priority !== undefined ? TaskController.normalizePriority(body.priority) : undefined,
            // created_by is set once when the task is created and never changes.
            created_by: existing.created_by,
            assigned_by: body.assigned_by ?? body.assignedBy,
            assigned_to: assignedUser || null,
            assigned_at,
            target_completion_at,
            target_hour: pickSent(body, 'target_hour', 'targetHour'),
        }, editedBy);


        if (!updated) throw new AppError('Task not found', 404);


        try {
            await writeAuditLog(req, {
                action: 'UPDATE', tableName: 'tasks', tableOfId: parseInt(id, 10),
                tableOfColumn: 'id', oldValue: existing, newValue: updated,
            });
        } catch (e) {
            console.error('Audit log write failed (task update):', e.message || e);
        }


        if (normalizedStatus) {
            try {
                await recordTaskStatusChange({
                    task_id: parseInt(id, 10),
                    old_status: existing.status,
                    // A reject is stored as "IN PROGRESS (REJECT)" so the history itself shows it.
                    new_status: rejectReason ? `${updated.status} (REJECT)` : updated.status,
                    user_name: getUsernameFromReq(req) || (body.user_name ?? body.userName),
                    performed_by: req.user?.id ?? null,
                    reason: rejectReason || statusReason || changeNote || null,
                });
            } catch (e) {
                console.error('Task status history write failed (task update):', e.message || e);
            }
        }


        // Reason given when the task moved to On Hold / Stopped -> its own row in task_status_reason.
        if (statusReason) {
            await recordTaskStatusReason({
                task_id: parseInt(id, 10),
                task_serial_no: updated.serial_number,
                old_status: existing.status,
                new_status: updated.status,
                reason: statusReason,
                updated_by: editedBy,
            });
        }


        TaskController.emitTaskUpdate('updated', updated, existing.status);
        scheduleNextAutoStart(); // status / assigned time changed -> re-aim the timer


        res.json(updated);
    }


    /** GET /api/tasks/task-log?task_id=&edited_by=&page=&limit= */
    static async getTaskLog(req, res) {
        await TaskController.assertOrganizationOnly(req);
        const { task_id, edited_by, page, limit } = req.query || {};
        const result = await TaskLogModel.findAll({ task_id, edited_by, page, limit });


        res.json({
            success: true,
            logs: result.rows,
            pagination: buildPagination(result),
        });
    }


    /** GET /api/tasks/:id/task-log */
    static async getTaskLogById(req, res) {
        await requireTaskRead(req);
        const { id } = req.params;
        const existing = await findVisibleTaskOr404(req, id);


        const logs = await TaskLogModel.findByTaskId(id);


        res.json({ success: true, task_id: parseInt(id, 10), logs, count: logs.length });
    }


    static async getTaskStatusHistory(req, res) {
        await TaskController.assertOrganizationOnly(req);
        const { task_id, page, limit } = req.query || {};
        const result = await findTaskStatusHistory({ task_id, page, limit });


        res.json({
            success: true,
            history: result.rows,
            pagination: buildPagination(result),
        });
    }


    static async getTaskStatusHistoryById(req, res) {
        await requireTaskRead(req);
        const { id } = req.params;
        const existing = await findVisibleTaskOr404(req, id);


        const history = await findTaskStatusHistoryByTaskId(id);


        res.json({ success: true, task_id: parseInt(id, 10), history, count: history.length });
    }


    static async runAutoStartCheck() {
        try {
            const startedTasks = await TaskModel.autoStartDueTasks();


            for (const task of startedTasks) {
                try {
                    await recordTaskStatusChange({
                        task_id: task.id,
                        old_status: 'SCHEDULE',
                        new_status: 'IN PROGRESS',
                        user_name: 'system-auto-start',
                    });
                } catch (e) {
                    console.error('Task status history write failed (auto-start):', e.message || e);
                }


                TaskController.emitTaskUpdate('updated', task, 'SCHEDULE');
            }
        } catch (err) {
            console.error('Task auto-start check failed:', err.message || err);
        }
    }
}


const TASK_AUTO_START_MAX_WAIT_MS = 30 * 1000;
const TASK_AUTO_START_MIN_WAIT_MS = 250;   // never spin: also covers a DB clock slightly ahead of Node's
const TASK_AUTO_START_BOOT_DELAY_MS = 5 * 1000;
let autoStartRunning = false;
let autoStartTimer = null;


const runAutoStartGuarded = async () => {
    if (autoStartRunning) return;
    autoStartRunning = true;
    try {
        await TaskController.runAutoStartCheck();
    } finally {
        autoStartRunning = false;
    }
};


async function scheduleNextAutoStart(delayOverrideMs) {
    clearTimeout(autoStartTimer);
    let wait = delayOverrideMs ?? TASK_AUTO_START_MAX_WAIT_MS;
    if (delayOverrideMs === undefined) {
        try {
            const next = await TaskModel.nextAutoStartAt();
            if (next) {
                const untilDue = new Date(next).getTime() - Date.now();
                wait = Math.min(TASK_AUTO_START_MAX_WAIT_MS, Math.max(TASK_AUTO_START_MIN_WAIT_MS, untilDue));
            }
        } catch (err) {
            console.error('Task auto-start: could not read the next due time:', err.message || err);
        }
    }
    clearTimeout(autoStartTimer); // another call may have armed a timer while we were reading the DB
    autoStartTimer = setTimeout(async () => {
        await runAutoStartGuarded();
        scheduleNextAutoStart();
    }, wait);
    autoStartTimer.unref?.();
}


/** Called once from server.js after boot: starts the auto-start scheduler and catches anything already overdue. */
export function startTaskAutoStartCheck() {
    scheduleNextAutoStart(TASK_AUTO_START_BOOT_DELAY_MS);
}


// Wrap only real route handlers with error handling.
wrapController(TaskController, [
    'getAllTasks',
    'searchTasks',
    'getTasksByProcess',
    'getTaskById',
    'createTask',
    'updateTask',
    'getTaskStatusHistory',
    'getTaskStatusHistoryById',
    'getTaskLog',
    'getTaskLogById',
    'getTaskTimeEntries',
    'getPendingReviewCount',
    'getNextSerialNumber',
    'getUserPhotos',
]);


export default TaskController;

