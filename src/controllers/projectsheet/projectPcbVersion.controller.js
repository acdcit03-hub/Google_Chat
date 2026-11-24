import ProjectPcbVersionModel from '../../models/projectsheet/projectPcbVersion.model.js';
import { getUsernameFromReq } from '../../utils/audit.utils.js';
import { AppError, wrapController } from '../../middleware/error.middleware.js';

function parsePositiveInt(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

class ProjectPcbVersionController {
    /** GET /project-pcb-versions */
    static async getAll(req, res) {
        const filters = {
            project_id: req.query.project_id ?? req.query.projectId,
            project_code: req.query.project_code ?? req.query.projectCode,
            pcb_id: req.query.pcb_id ?? req.query.pcbId,
            pcb_code: req.query.pcb_code ?? req.query.pcbCode,
            version: req.query.version,
            status: req.query.status,
            limit: req.query.limit,
            page: req.query.page,
            all: req.query.all,
        };

        const [rows, total] = await Promise.all([
            ProjectPcbVersionModel.findAll(filters),
            ProjectPcbVersionModel.count(filters),
        ]);

        const all = filters.all === true || filters.all === 'true';
        const limit = all
            ? total
            : Math.min(Math.max(parseInt(filters.limit, 10) || 50, 1), 500);
        const page = Math.max(parseInt(filters.page, 10) || 1, 1);

        res.json({
            success: true,
            data: rows,
            pagination: {
                total,
                limit,
                page,
                totalPages: limit > 0 ? Math.ceil(total / limit) : 0,
            },
        });
    }

    /** GET /project-pcb-versions/:id */
    static async getById(req, res) {
        const row = await ProjectPcbVersionModel.findById(req.params.id);
        if (!row) {
            throw new AppError('Project PCB version not found', 404);
        }
        res.json({ success: true, data: row });
    }

    /** GET /project-pcb-versions/project/:projectId */
    static async getByProjectId(req, res) {
        const projectId = parsePositiveInt(req.params.projectId);
        if (!projectId) {
            throw new AppError('Valid projectId is required', 400);
        }
        const activeOnly =
            req.query.active_only === 'true' ||
            req.query.activeOnly === 'true';
        const rows = await ProjectPcbVersionModel.findByProjectId(projectId, {
            activeOnly,
        });
        res.json({ success: true, data: rows });
    }

    /** GET /project-pcb-versions/pcb/:pcbId */
    static async getByPcbId(req, res) {
        const pcbId = parsePositiveInt(req.params.pcbId);
        if (!pcbId) {
            throw new AppError('Valid pcbId is required', 400);
        }
        const activeOnly =
            req.query.active_only === 'true' ||
            req.query.activeOnly === 'true';
        const rows = await ProjectPcbVersionModel.findByPcbId(pcbId, {
            activeOnly,
        });
        res.json({ success: true, data: rows });
    }

    /** POST /project-pcb-versions */
    static async create(req, res) {
        const body = req.body || {};
        try {
            const row = await ProjectPcbVersionModel.create({
                project_id: body.project_id ?? body.projectId,
                project_code: body.project_code ?? body.projectCode,
                pcb_id: body.pcb_id ?? body.pcbId,
                pcb_code: body.pcb_code ?? body.pcbCode,
                pcb_name: body.pcb_name ?? body.pcbName,
                version: body.version,
                status: body.status,
                filemanager_link:
                    body.filemanager_link ??
                    body.filemanagerLink ??
                    body.filemanagerlink ??
                    body.filemangerlink,
            });
            res.status(201).json({
                success: true,
                message: 'Project PCB version created',
                data: row,
            });
        } catch (err) {
            if (err?.message) {
                throw new AppError(err.message, 400);
            }
            throw err;
        }
    }

    /** PUT /project-pcb-versions/:id */
    static async update(req, res) {
        const id = parsePositiveInt(req.params.id);
        if (!id) {
            throw new AppError('Valid id is required', 400);
        }

        const existing = await ProjectPcbVersionModel.findById(id);
        if (!existing) {
            throw new AppError('Project PCB version not found', 404);
        }

        const body = req.body || {};
        try {
            const row = await ProjectPcbVersionModel.update(id, {
                project_id: body.project_id ?? body.projectId,
                project_code: body.project_code ?? body.projectCode,
                pcb_id: body.pcb_id ?? body.pcbId,
                pcb_code: body.pcb_code ?? body.pcbCode,
                pcb_name: body.pcb_name ?? body.pcbName,
                version: body.version,
                status: body.status,
                filemanager_link:
                    body.filemanager_link ??
                    body.filemanagerLink ??
                    body.filemanagerlink ??
                    body.filemangerlink,
            }, getUsernameFromReq(req));
            res.json({
                success: true,
                message: 'Project PCB version updated',
                data: row,
            });
        } catch (err) {
            if (err?.message) {
                throw new AppError(err.message, 400);
            }
            throw err;
        }
    }

    /** PATCH /project-pcb-versions/:id/status */
    static async setStatus(req, res) {
        const id = parsePositiveInt(req.params.id);
        if (!id) {
            throw new AppError('Valid id is required', 400);
        }
        if (req.body?.status === undefined) {
            throw new AppError('status is required', 400);
        }
        const row = await ProjectPcbVersionModel.setStatus(
            id,
            req.body.status,
            getUsernameFromReq(req),
        );
        if (!row) {
            throw new AppError('Project PCB version not found', 404);
        }
        res.json({
            success: true,
            message: 'Project PCB version status updated',
            data: row,
        });
    }
}

wrapController(ProjectPcbVersionController, [
    'getAll',
    'getById',
    'getByProjectId',
    'getByPcbId',
    'create',
    'update',
    'setStatus',
]);

export default ProjectPcbVersionController;
