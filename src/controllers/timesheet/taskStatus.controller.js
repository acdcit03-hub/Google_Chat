import TaskStatusModel, { STATUS_FIELD_KEYS } from '../../models/timesheet/taskStatus.model.js';
import { writeAuditLog, pickChangedColumns } from '../../utils/audit.utils.js';
import { AppError, wrapController } from '../../middleware/error.middleware.js';

class TaskStatusController {
    /** Validates the fields that were sent and returns them trimmed. */
    static parseBody(body = {}) {
        const data = {};

        if (body.name !== undefined) {
            data.name = String(body.name).trim();
            if (!data.name) throw new AppError('Status name is required', 400);
            if (data.name.length > 50) throw new AppError('Status name must be 50 characters or less', 400);
        }

        if (body.is_active !== undefined) {
            const v = body.is_active;
            if (v === true || v === 'true' || v === 1 || v === '1') data.is_active = true;
            else if (v === false || v === 'false' || v === 0 || v === '0') data.is_active = false;
            else throw new AppError('is_active must be true or false', 400);
        }

        if (body.show_start !== undefined) {
            const v = body.show_start;
            if (v === true || v === 'true' || v === 1 || v === '1') data.show_start = true;
            else if (v === false || v === 'false' || v === 0 || v === '0') data.show_start = false;
            else throw new AppError('show_start must be true or false', 400);
        }

        if (body.color !== undefined) {
            if (body.color === null || String(body.color).trim() === '') {
                data.color = null;
            } else {
                const hex = String(body.color).trim().toLowerCase();
                if (!/^#[0-9a-f]{6}$/.test(hex)) throw new AppError('color must look like #61e2f3', 400);
                data.color = hex;
            }
        }

        if (body.required_fields !== undefined) {
            if (!Array.isArray(body.required_fields)) throw new AppError('required_fields must be an array', 400);
            const fields = [...new Set(body.required_fields.map((f) => String(f).trim()))];
            const bad = fields.find((f) => !STATUS_FIELD_KEYS.includes(f));
            if (bad) throw new AppError(`Unknown field "${bad}". Allowed: ${STATUS_FIELD_KEYS.join(', ')}`, 400);
            data.required_fields = fields;
        }

        return data;
    }

    static async audit(req, action, id, oldValue, newValue) {
        try {
            await writeAuditLog(req, { action, tableName: 'task_statuses', tableOfId: id, tableOfColumn: 'id', oldValue, newValue });
        } catch (e) {
            console.error(`Audit log write failed (task status ${action}):`, e.message || e);
        }
    }

    /** GET /api/task-statuses            -> every status (Settings page)
     *  GET /api/task-statuses?active=true -> only active ones (dropdowns, cards, board) */
    static async getAllStatuses(req, res) {
        const activeOnly = ['true', '1'].includes(String(req.query?.active ?? '').toLowerCase());
        res.json(await TaskStatusModel.findAll({ activeOnly }));
    }

    static async createStatus(req, res) {
        const data = TaskStatusController.parseBody(req.body);
        if (!data.name) throw new AppError('Status name is required', 400);
        if (await TaskStatusModel.findByName(data.name)) throw new AppError('Status with this name already exists', 409);
        data.show_start = false;

        if (data.color) {
            const used = await TaskStatusModel.findByColor(data.color);
            if (used) throw new AppError(`This colour is already used by "${used.name}". Remove the colour from "${used.name}" first.`, 409);
        }

        const created = await TaskStatusModel.create(data);
        await TaskStatusController.audit(req, 'CREATE', created.id, null, created);
        res.status(201).json(created);
    }

    static async updateStatus(req, res) {
        const { id } = req.params;
        const existing = await TaskStatusModel.findById(id);
        if (!existing) throw new AppError('Status not found', 404);

        const data = TaskStatusController.parseBody(req.body);
        if (data.show_start === false && existing.show_start !== false) {
            throw new AppError('Play must remain enabled for one status. Select another status to move Play.', 400);
        }
        if (data.name !== undefined && data.name !== existing.name) {
            if (existing.is_system) throw new AppError('Built-in statuses cannot be renamed', 400);
            if (await TaskStatusModel.findByName(data.name, existing.id)) {
                throw new AppError('Status with this name already exists', 409);
            }
        }

        // Turning a status OFF: keep at least one active status and never orphan tasks.
        if (data.is_active === false && existing.is_active) {
            if ((await TaskStatusModel.countActive()) <= 1) {
                throw new AppError('At least one status must stay active', 400);
            }
            const used = await TaskStatusModel.countTasksUsing(existing.name);
            if (used > 0) {
                throw new AppError(`Cannot deactivate "${existing.name}": ${used} task(s) still use it. Move them to another status first.`, 409);
            }
        }

        if (data.color) {
            const used = await TaskStatusModel.findByColor(data.color, existing.id);
            if (used) throw new AppError(`This colour is already used by "${used.name}". Remove the colour from "${used.name}" first.`, 409);
        }

        const updated = await TaskStatusModel.update(id, data);
        const patch = pickChangedColumns(existing, updated, ['name', 'variant', 'color', 'is_active', 'show_start', 'required_fields']);
        if (patch.columns.length) {
            await TaskStatusController.audit(req, 'UPDATE', existing.id, patch.oldValue, patch.newValue);
        }
        res.json(updated);
    }

    static async deleteStatus(req, res) {
        const { id } = req.params;
        const existing = await TaskStatusModel.findById(id);
        if (!existing) throw new AppError('Status not found', 404);

        const used = await TaskStatusModel.countTasksUsing(existing.name);
        if (used > 0) {
            throw new AppError(`Cannot delete "${existing.name}": ${used} task(s) still use it. Move them to another status first.`, 409);
        }

        await TaskStatusModel.delete(id);
        await TaskStatusController.audit(req, 'DELETE', existing.id, existing, null);
        res.json({ success: true, message: 'Status deleted successfully' });
    }

    static async reorderStatuses(req, res) {
        const ids = req.body?.ids;
        if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => Number.isInteger(id) && id > 0)) {
            throw new AppError('ids must be a non-empty array of status ids', 400);
        }

        await TaskStatusModel.reorder(ids);
        res.json({ success: true });
    }
}

wrapController(TaskStatusController, [
    'getAllStatuses',
    'createStatus',
    'updateStatus',
    'deleteStatus',
    'reorderStatuses',
]);

export default TaskStatusController;