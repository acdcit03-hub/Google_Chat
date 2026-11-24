import PcbCustomProcessModel from '../../models/projectsheet/pcbCustomProcess.model.js';
import ProcessMapModel from '../../models/projectsheet/updateProject.model.js';
import { removeCustomProcessEntryByPath } from '../../utils/projectProcessChecked.utils.js';
import { AppError } from '../../middleware/error.middleware.js';


async function buildCustomProcessResponse(row) {
    // Project-wise shape: { customProcesses: [{ project_code, pcb_name, version, process }] }
    // Legacy flat trees still resolve to { topLevelProcesses, categoryExtraSubs }.
    const resolved = await ProcessMapModel.customProcessToResolvedTree(
        row.custom_process,
    );
    return {
        pcb_id: row.id,
        pcb_code: row.pcb_code,
        custom_process: resolved,
    };
}

class PcbCustomProcessController {
    /** GET /api/pcbs/:id/custom-process */
    static async getCustomProcess(req, res) {
        const row = await PcbCustomProcessModel.findByPcbId(req.params.id);
        if (!row) {
            throw new AppError('PCB not found', 404);
        }

        res.json({
            success: true,
            ...(await buildCustomProcessResponse(row)),
        });
    }

    /** PUT /api/pcbs/:id/custom-process  body: { custom_process: [...] } */
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

        const existing = await PcbCustomProcessModel.findByPcbId(req.params.id);
        if (!existing) {
            throw new AppError('PCB not found', 404);
        }

        const updated = await PcbCustomProcessModel.update(req.params.id, customProcess);

        res.json({
            success: true,
            ...(await buildCustomProcessResponse(updated)),
        });
    }

    /** DELETE /api/pcbs/:id/custom-process */
    static async clearCustomProcess(req, res) {
        const existing = await PcbCustomProcessModel.findByPcbId(req.params.id);
        if (!existing) {
            throw new AppError('PCB not found', 404);
        }

        const cleared = await PcbCustomProcessModel.clear(req.params.id);

        res.json({
            success: true,
            ...(await buildCustomProcessResponse(cleared)),
        });
    }
  
    static async removeCustomProcessItem(req, res) {
        const path = String(req.query?.path ?? req.body?.path ?? '').trim();
        if (!path) {
            throw new AppError('path is required to identify which custom process to remove', 400);
        }

        const existing = await PcbCustomProcessModel.findByPcbId(req.params.id);
        if (!existing) {
            throw new AppError('PCB not found', 404);
        }

        const { customProcess, removed } = removeCustomProcessEntryByPath(
            existing.custom_process,
            path,
        );
        if (!removed) {
            throw new AppError(`No custom process found with path "${path}"`, 404);
        }

        const updated = await PcbCustomProcessModel.update(req.params.id, customProcess);

        res.json({
            success: true,
            ...(await buildCustomProcessResponse(updated)),
        });
    }
}

export default PcbCustomProcessController;