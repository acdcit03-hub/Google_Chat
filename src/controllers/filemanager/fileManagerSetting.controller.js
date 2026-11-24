import FileManagerSettingModel from '../../models/filemanager/fileManagerSetting.model.js';
import FinancialYearFileManagerModel from '../../models/filemanager/financialYearFileManager.model.js';
import ProjectFileManagerModel from '../../models/filemanager/projectFileManager.model.js';
import { wrapController } from '../../middleware/error.middleware.js';

function parseId(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
}

function isActiveOwner(row) {
    if (!row) return false;
    return row.status !== false;
}

/** Keep FY + project folders owned by the selected file-manager owner. */
async function syncOwnersToFileManagerFolders(actorUsername = 'system') {
    const actor = String(actorUsername || 'system').trim() || 'system';
    let financial_year_owner_sync = null;
    let project_owner_sync = null;
    try {
        financial_year_owner_sync =
            await FinancialYearFileManagerModel.applyFileManagerOwnersToAll(
                actor,
            );
    } catch (err) {
        console.error(
            'syncOwnersToFinancialYearFolders failed:',
            err?.message || err,
        );
    }
    try {
        project_owner_sync =
            await ProjectFileManagerModel.applyFileManagerOwnersToAll(actor);
    } catch (err) {
        console.error(
            'syncOwnersToProjectFolders failed:',
            err?.message || err,
        );
    }
    return { financial_year_owner_sync, project_owner_sync };
}

const ONLY_ONE_OWNER_MESSAGE =
    'Only one file manager owner is allowed. Update the existing owner ';

class FileManagerSettingController {
    /** GET /file-manager-settings */
    static async list(req, res) {
        const { status, search } = req.query;
        const rows = await FileManagerSettingModel.findAll({
            status: status ?? null,
            search: search || null,
        });
        return res.json({
            success: true,
            data: rows,
        });
    }

    /** GET /file-manager-settings/active */
    static async listActive(_req, res) {
        const rows = await FileManagerSettingModel.findActiveOwners();
        return res.json({
            success: true,
            data: rows,
        });
    }

    /** GET /file-manager-settings/:id */
    static async getById(req, res) {
        const id = parseId(req.params.id);
        if (!id) {
            return res.status(400).json({
                success: false,
                message: 'Valid id is required',
            });
        }

        const row = await FileManagerSettingModel.findById(id);
        if (!row) {
            return res.status(404).json({
                success: false,
                message: 'File manager setting not found',
            });
        }

        return res.json({
            success: true,
            data: row,
        });
    }

    /** GET /file-manager-settings/owner/:ownerId */
    static async getByOwnerId(req, res) {
        const ownerId = parseId(req.params.ownerId);
        if (!ownerId) {
            return res.status(400).json({
                success: false,
                message: 'Valid ownerId is required',
            });
        }

        const row = await FileManagerSettingModel.findByOwnerId(ownerId);
        if (!row) {
            return res.status(404).json({
                success: false,
                message: 'Owner setting not found',
            });
        }

        return res.json({
            success: true,
            data: row,
        });
    }

    /**
     * POST /file-manager-settings — add/update the single allowed owner.
     * If a different owner already exists → 409 (no insert).
     * Same owner_id → update that row.
     */
    static async create(req, res) {
        if (Array.isArray(req.body) || Array.isArray(req.body?.owners) || Array.isArray(req.body?.selected_owners)) {
            return res.status(400).json({
                success: false,
                message: ONLY_ONE_OWNER_MESSAGE,
            });
        }

        const owner_id = req.body?.owner_id ?? req.body?.ownerId;
        const username = req.body?.username ?? req.body?.user_name;
        const access = req.body?.access;
        const status = req.body?.status;
        const ownerId = parseId(owner_id);

        if (!ownerId || !String(username || '').trim()) {
            return res.status(400).json({
                success: false,
                message: 'owner_id and username are required',
            });
        }

        const existingRows = await FileManagerSettingModel.findAll();
        const existingOther = existingRows.find(
            (row) => Number(row.owner_id) !== Number(ownerId),
        );
        if (existingOther) {
            return res.status(409).json({
                success: false,
                message: ONLY_ONE_OWNER_MESSAGE,
                data: existingOther,
            });
        }

        const row = await FileManagerSettingModel.upsert({
            owner_id: ownerId,
            username,
            access,
            status,
        });

        const ownerSync = isActiveOwner(row)
            ? await syncOwnersToFileManagerFolders(
                  String(username || 'system').trim(),
              )
            : null;

        return res.status(201).json({
            success: true,
            message: 'Owner setting saved',
            data: row,
            financial_year_owner_sync:
                ownerSync?.financial_year_owner_sync ?? null,
            project_owner_sync: ownerSync?.project_owner_sync ?? null,
        });
    }

    /** PUT /file-manager-settings/:id */
    static async update(req, res) {
        const id = parseId(req.params.id);
        if (!id) {
            return res.status(400).json({
                success: false,
                message: 'Valid id is required',
            });
        }

        const nextOwnerIdRaw = req.body?.owner_id ?? req.body?.ownerId;
        if (nextOwnerIdRaw !== undefined && nextOwnerIdRaw !== null && nextOwnerIdRaw !== '') {
            const existingRows = await FileManagerSettingModel.findAll();
            const otherOwnerRow = existingRows.find(
                (row) => Number(row.id) !== Number(id),
            );
            if (otherOwnerRow) {
                return res.status(409).json({
                    success: false,
                    message: ONLY_ONE_OWNER_MESSAGE,
                    data: otherOwnerRow,
                });
            }
        }

        const row = await FileManagerSettingModel.update(id, {
            owner_id: req.body?.owner_id ?? req.body?.ownerId,
            username: req.body?.username ?? req.body?.user_name,
            access: req.body?.access,
            status: req.body?.status,
        });

        if (!row) {
            return res.status(404).json({
                success: false,
                message: 'File manager setting not found',
            });
        }

        const ownerSync = await syncOwnersToFileManagerFolders(
            String(row.username || 'system').trim(),
        );

        return res.json({
            success: true,
            message: 'Owner setting updated',
            data: row,
            financial_year_owner_sync:
                ownerSync?.financial_year_owner_sync ?? null,
            project_owner_sync: ownerSync?.project_owner_sync ?? null,
        });
    }
}

wrapController(FileManagerSettingController, [
    'list',
    'listActive',
    'getById',
    'getByOwnerId',
    'create',
    'update',
]);

export default FileManagerSettingController;
