import CustomProcessModel from '../../models/projectsheet/customProcess.model.js';
import ProcessMapModel from '../../models/projectsheet/updateProject.model.js';
import { removeCustomProcessEntryByPath } from '../../utils/projectProcessChecked.utils.js';
import { AppError } from '../../middleware/error.middleware.js';


async function buildCustomProcessResponse(row) {
    // Same resolved shape as PCB.custom_process:
    // - project-wise: { customProcesses: [{ project_code, process, ... }] }
    // - legacy flat:  { topLevelProcesses, categoryExtraSubs }
    const resolved = await ProcessMapModel.customProcessToResolvedTree(
        row.custom_process,
    );
    return {
        project_id: row.id,
        project_code: row.project_code,
        custom_process: resolved,
    };
}

class CustomProcessController {
    /** GET /api/projects/:id/custom-process */
    static async getCustomProcess(req, res) {
        const row = await CustomProcessModel.findByProjectId(req.params.id);
        if (!row) {
            throw new AppError('Project not found', 404);
        }

        res.json({
            success: true,
            ...(await buildCustomProcessResponse(row)),
        });
    }

    /** PUT /api/projects/:id/custom-process  body: { custom_process: [...] } */
    static async updateCustomProcess(req, res) {
        const body = req.body || {};
        const customProcess =
            body.custom_process !== undefined ? body.custom_process : body;

        if (
            customProcess === undefined ||
            customProcess === null ||
            typeof customProcess !== 'object'
        ) {
            throw new AppError(
                'custom_process is required and must be a JSON object or array',
                400,
            );
        }

        const existing = await CustomProcessModel.findByProjectId(req.params.id);
        if (!existing) {
            throw new AppError('Project not found', 404);
        }

        const updated = await CustomProcessModel.update(req.params.id, customProcess);

        res.json({
            success: true,
            ...(await buildCustomProcessResponse(updated)),
        });
    }

    /** DELETE /api/projects/:id/custom-process */
    static async clearCustomProcess(req, res) {
        const existing = await CustomProcessModel.findByProjectId(req.params.id);
        if (!existing) {
            throw new AppError('Project not found', 404);
        }

        const cleared = await CustomProcessModel.clear(req.params.id);

        res.json({
            success: true,
            ...(await buildCustomProcessResponse(cleared)),
        });
    }
    /** DELETE /api/projects/:id/custom-process/item?path=GTDCDC/EWQ
     *  Removes a single custom-process node (identified by its `path`,
     *  the same value stored on the node itself) instead of clearing
     *  the whole custom_process field. Accepts the path via query string
     *  or JSON body (`{ path }`) since a DELETE request isn't guaranteed
     *  to carry a body in every client.
     */
    static async removeCustomProcessItem(req, res) {
        const path = String(req.query?.path ?? req.body?.path ?? '').trim();
        if (!path) {
            throw new AppError('path is required to identify which custom process to remove', 400);
        }

        const existing = await CustomProcessModel.findByProjectId(req.params.id);
        if (!existing) {
            throw new AppError('Project not found', 404);
        }

        const { customProcess, removed } = removeCustomProcessEntryByPath(
            existing.custom_process,
            path,
        );
        if (!removed) {
            throw new AppError(`No custom process found with path "${path}"`, 404);
        }

        const updated = await CustomProcessModel.update(req.params.id, customProcess);

        res.json({
            success: true,
            ...(await buildCustomProcessResponse(updated)),
        });
    }
}

export default CustomProcessController;