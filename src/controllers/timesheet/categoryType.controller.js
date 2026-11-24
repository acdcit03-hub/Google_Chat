import CategoryTypeModel from '../../models/timesheet/categoryType.model.js';
import { AppError, wrapController } from '../../middleware/error.middleware.js';

class CategoryTypeController {
    static toBoolean(raw, fallback = false) {
        if (raw === undefined || raw === null || raw === '') {
            return fallback;
        }

        return raw === true || raw === 'true' || raw === 1 || raw === '1';
    }

    static normalizeModule(raw) {
        const value = raw == null ? '' : String(raw).trim();
        if (!value) {
            throw new AppError('module is required', 400);
        }
        return value;
    }

    static async getAll(req, res) {
        const rows = await CategoryTypeModel.findAll();
        res.json(rows);
    }

    static async getById(req, res) {
        const row = await CategoryTypeModel.findById(req.params.id);

        if (!row) {
            throw new AppError('Category type not found', 404);
        }

        res.json(row);
    }

    static async create(req, res) {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const module = CategoryTypeController.normalizeModule(body.module);
        const existing = await CategoryTypeModel.findByModule(module);

        if (existing) {
            throw new AppError('A category type for this module already exists', 409);
        }

        const created = await CategoryTypeModel.create({
            module,
            process: CategoryTypeController.toBoolean(body.process, false),
            checklist: CategoryTypeController.toBoolean(body.checklist, false),
            is_active: CategoryTypeController.toBoolean(body.is_active ?? body.isActive, true),
        });

        res.status(201).json(created);
    }

    static async update(req, res) {
        const { id } = req.params;
        const before = await CategoryTypeModel.findById(id);

        if (!before) {
            throw new AppError('Category type not found', 404);
        }

        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const module = CategoryTypeController.normalizeModule(
            body.module ?? before.module,
        );
        const existing = await CategoryTypeModel.findByModule(module, id);

        if (existing) {
            throw new AppError('A category type for this module already exists', 409);
        }

        const updated = await CategoryTypeModel.update(id, {
            module,
            process: CategoryTypeController.toBoolean(
                body.process,
                before.process,
            ),
            checklist: CategoryTypeController.toBoolean(
                body.checklist,
                before.checklist,
            ),
            is_active: CategoryTypeController.toBoolean(
                body.is_active ?? body.isActive,
                before.is_active,
            ),
        });

        res.json(updated);
    }

    static async delete(req, res) {
        const deleted = await CategoryTypeModel.delete(req.params.id);

        if (!deleted) {
            throw new AppError('Category type not found', 404);
        }

        res.json({
            success: true,
            message: 'Category type deleted successfully',
        });
    }
}

wrapController(CategoryTypeController, [
    'getAll',
    'getById',
    'create',
    'update',
    'delete',
]);

export default CategoryTypeController;
