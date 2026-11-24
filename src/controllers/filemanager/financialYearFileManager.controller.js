import fs from 'fs';
import { writeFileManagerLog } from '../../models/filemanager/fileManagerLog.model.js';
import path from 'path';
import { listDiskChildren } from '../../services/filemanager/diskChildren.js';
import FinancialYearFileManagerModel, {
    ensureFinancialYearFolders,
    ensureFinancialYearFolderByCode,
    getProjectFileManagerRootPath,
} from '../../models/filemanager/financialYearFileManager.model.js';
import { wrapController } from '../../middleware/error.middleware.js';
import {
    resolveActor,
    unauthorized,
    notFound,
} from './fileManager.controller.js';

function parseId(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeUserPayload(raw, assignedByUsername) {
    if (!raw || typeof raw !== 'object') return null;
    const userId = parseId(raw.user_id ?? raw.userId ?? raw.id);
    const username = String(raw.username ?? raw.user_name ?? '').trim();
    if (!userId || !username) return null;

    const roleRaw = raw.role ?? raw.permission_role ?? raw.permissionRole;
    let role = String(roleRaw || '')
        .trim()
        .toLowerCase();
    if (!['owner', 'editor', 'viewer'].includes(role)) {
        role = 'viewer';
    }

    return {
        user_id: userId,
        username,
        role,
        assigned_by_username: assignedByUsername,
    };
}

class FinancialYearFileManagerController {
    /** GET /financial-year-file-manager */
    static async list(_req, res) {
        const rows = await FinancialYearFileManagerModel.findAll();
        let root = null;
        try {
            root = getProjectFileManagerRootPath();
        } catch {
            root = null;
        }
        return res.json({
            success: true,
            root,
            data: rows,
        });
    }

    /** POST /financial-year-file-manager/sync — create missing FY folders + DB rows */
    static async sync(_req, res) {
        const result = await ensureFinancialYearFolders();
        return res.json({
            success: true,
            message: 'Financial year folders synced',
            root: result.root,
            data: result.folders,
        });
    }

    /** GET /financial-year-file-manager/year/:yearCode */
    static async getByYearCode(req, res) {
        const yearCode = String(req.params.yearCode || '').trim();
        if (!yearCode) {
            return res.status(400).json({
                success: false,
                message: 'yearCode is required',
            });
        }

        let row = await FinancialYearFileManagerModel.findByYearCode(yearCode);
        if (!row) {
            await ensureFinancialYearFolderByCode(yearCode);
            row = await FinancialYearFileManagerModel.findByYearCode(yearCode);
        }
        if (!row) {
            return res.status(404).json({
                success: false,
                message: 'Financial year folder not found',
            });
        }

        const users = await FinancialYearFileManagerModel.listUsers(row.id);
        const children = listDiskChildren(row.absolute_path);
        return res.json({
            success: true,
            data: { ...row, users, children },
        });
    }

    /** GET /financial-year-file-manager/financial-year/:financialYearId */
    static async getByFinancialYearId(req, res) {
        const financialYearId = parseId(req.params.financialYearId);
        if (!financialYearId) {
            return res.status(400).json({
                success: false,
                message: 'Valid financialYearId is required',
            });
        }

        let row =
            await FinancialYearFileManagerModel.findByFinancialYearId(
                financialYearId,
            );
        if (!row) {
            return res.status(404).json({
                success: false,
                message: 'Financial year folder not found',
            });
        }

        const users = await FinancialYearFileManagerModel.listUsers(row.id);
        const children = listDiskChildren(row.absolute_path);
        return res.json({
            success: true,
            data: { ...row, users, children },
        });
    }

    /** POST /financial-year-file-manager/year/:yearCode — ensure one FY folder */
    static async ensureByYearCode(req, res) {
        const yearCode = String(req.params.yearCode || '').trim();
        if (!yearCode) {
            return res.status(400).json({
                success: false,
                message: 'yearCode is required',
            });
        }

        const result = await ensureFinancialYearFolderByCode(yearCode);
        if (!result.is_folder) {
            return res.status(404).json({
                success: false,
                message:
                    result.message ||
                    'Could not create financial year folder',
                data: result,
            });
        }

        return res.status(result.created ? 201 : 200).json({
            success: true,
            message: result.created
                ? 'Financial year folder created'
                : 'Financial year folder already exists',
            data: result,
        });
    }

    /** GET /financial-year-file-manager/:id */
    static async getById(req, res) {
        const id = parseId(req.params.id);
        if (!id) {
            return res.status(400).json({
                success: false,
                message: 'Valid id is required',
            });
        }

        const row = await FinancialYearFileManagerModel.findById(id);
        if (!row) {
            return res.status(404).json({
                success: false,
                message: 'Financial year folder not found',
            });
        }

        const users = await FinancialYearFileManagerModel.listUsers(row.id);
        const children = listDiskChildren(row.absolute_path);
        return res.json({
            success: true,
            data: { ...row, users, children },
        });
    }

    /** GET /financial-year-file-manager/:id/children — disk folder structure */
    static async listChildren(req, res) {
        const id = parseId(req.params.id);
        if (!id) {
            return res.status(400).json({
                success: false,
                message: 'Valid id is required',
            });
        }

        const row = await FinancialYearFileManagerModel.findById(id);
        if (!row) {
            return res.status(404).json({
                success: false,
                message: 'Financial year folder not found',
            });
        }

        const relative = String(req.query.path || '')
            .trim()
            .replace(/^[/\\]+/, '')
            .replace(/\.\./g, '');
        const base = row.absolute_path;
        const target = relative ? path.join(base, relative) : base;
        const rootNorm = path.resolve(base);
        const targetNorm = path.resolve(target);
        if (
            targetNorm !== rootNorm &&
            !targetNorm.startsWith(`${rootNorm}${path.sep}`)
        ) {
            return res.status(400).json({
                success: false,
                message: 'Invalid path',
            });
        }

        return res.json({
            success: true,
            data: {
                folder: row,
                path: relative || '',
                children: listDiskChildren(targetNorm),
            },
        });
    }

    /* ================= USERS / PERMISSIONS ================= */

    /** GET /financial-year-file-manager/:id/users */
    static async listUsers(req, res) {
        const id = parseId(req.params.id);
        if (!id) {
            return res.status(400).json({
                success: false,
                message: 'Valid id is required',
            });
        }

        const existing = await FinancialYearFileManagerModel.findById(id);
        if (!existing) {
            return notFound(res, 'Financial year folder not found');
        }

        const users = await FinancialYearFileManagerModel.listUsers(id);
        return res.json({ success: true, data: users });
    }

    /**
     * POST /financial-year-file-manager/:id/users
     * Body: single user fields OR { users: [...] }
     */
    static async assignUsers(req, res) {
        const { ownerId, username } = await resolveActor(req);
        if (ownerId == null || !username) return unauthorized(res);

        const id = parseId(req.params.id);
        if (!id) {
            return res.status(400).json({
                success: false,
                message: 'Valid id is required',
            });
        }

        const existing = await FinancialYearFileManagerModel.findById(id);
        if (!existing) {
            return notFound(res, 'Financial year folder not found');
        }

        const rawList = Array.isArray(req.body?.users)
            ? req.body.users
            : [req.body];

        const saved = [];
        for (const raw of rawList) {
            const payload = normalizeUserPayload(raw, username);
            if (!payload) {
                return res.status(400).json({
                    success: false,
                    message: 'Each user requires user_id and username',
                });
            }
            const previous = await FinancialYearFileManagerModel.findUser(
                id,
                payload.user_id,
            );
            const row = await FinancialYearFileManagerModel.upsertUser({
                fy_folder_id: id,
                ...payload,
            });
            saved.push(row);
            await writeFileManagerLog({
                action: 'UPDATE',
                entityType: 'permission',
                itemId: id,
                itemName:
                    existing.folder_name || existing.name || existing.year_code,
                targetUsername: payload.username,
                fieldName: 'role',
                oldValue: previous?.role || null,
                newValue: payload.role || row?.role || null,
                updatedBy: username,
                updatedByUserId: ownerId,
            });
        }

        return res.status(201).json({
            success: true,
            message: 'Financial year folder permissions saved',
            data: saved,
        });
    }

    /** PUT /financial-year-file-manager/:id/users/:userId */
    static async updateUser(req, res) {
        const { ownerId, username: actorUsername } = await resolveActor(req);
        const id = parseId(req.params.id);
        const userId = parseId(req.params.userId);
        if (!id || !userId) {
            return res.status(400).json({
                success: false,
                message: 'Valid id and userId are required',
            });
        }

        const existing = await FinancialYearFileManagerModel.findById(id);
        if (!existing) {
            return notFound(res, 'Financial year folder not found');
        }

        const current = await FinancialYearFileManagerModel.findUser(id, userId);
        if (!current) {
            return notFound(res, 'User assignment not found');
        }

        const fields = {};
        if (req.body?.username != null) fields.username = req.body.username;

        const roleRaw =
            req.body?.role ??
            req.body?.permission_role ??
            req.body?.permissionRole ??
            null;
        if (roleRaw != null && String(roleRaw).trim() !== '') {
            fields.role = String(roleRaw).trim().toLowerCase();
        }

        if (!fields.role && !fields.username) {
            return res.status(400).json({
                success: false,
                message: 'Provide role (owner | editor | viewer) to update',
            });
        }

        const row = await FinancialYearFileManagerModel.updateUserPermissions(
            id,
            userId,
            fields,
        );

        await writeFileManagerLog({
            action: 'UPDATE',
            entityType: 'permission',
            itemId: id,
            itemName:
                existing.folder_name || existing.name || existing.year_code,
            targetUsername: current.username,
            fieldName: 'role',
            oldValue: current.role,
            newValue: row?.role ?? fields.role,
            updatedBy: actorUsername,
            updatedByUserId: ownerId,
        });

        return res.json({
            success: true,
            message: 'User permissions updated',
            data: row,
        });
    }

    /** DELETE /financial-year-file-manager/:id/users/:userId */
    static async removeUser(req, res) {
        const { ownerId, username: actorUsername } = await resolveActor(req);
        const id = parseId(req.params.id);
        const userId = parseId(req.params.userId);
        if (!id || !userId) {
            return res.status(400).json({
                success: false,
                message: 'Valid id and userId are required',
            });
        }

        const existing = await FinancialYearFileManagerModel.findById(id);
        if (!existing) {
            return notFound(res, 'Financial year folder not found');
        }

        const row = await FinancialYearFileManagerModel.removeUser(id, userId);
        if (!row) {
            return notFound(res, 'User assignment not found');
        }

        await writeFileManagerLog({
            action: 'DELETE',
            entityType: 'permission',
            itemId: id,
            itemName:
                existing.folder_name || existing.name || existing.year_code,
            targetUsername: row.username,
            fieldName: 'role',
            oldValue: row.role,
            newValue: null,
            updatedBy: actorUsername,
            updatedByUserId: ownerId,
        });

        return res.json({
            success: true,
            message: 'User access removed',
            data: row,
        });
    }

    /** GET /financial-year-file-manager/:id/access/:userId */
    static async getUserAccess(req, res) {
        const id = parseId(req.params.id);
        const userId = parseId(req.params.userId);
        if (!id || !userId) {
            return res.status(400).json({
                success: false,
                message: 'Valid id and userId are required',
            });
        }

        const existing = await FinancialYearFileManagerModel.findById(id);
        if (!existing) {
            return notFound(res, 'Financial year folder not found');
        }

        const access = await FinancialYearFileManagerModel.findUser(id, userId);
        return res.json({
            success: true,
            data: access || {
                fy_folder_id: id,
                user_id: userId,
                role: null,
            },
        });
    }
}

wrapController(FinancialYearFileManagerController, [
    'list',
    'sync',
    'getByYearCode',
    'getByFinancialYearId',
    'ensureByYearCode',
    'getById',
    'listChildren',
    'listUsers',
    'assignUsers',
    'updateUser',
    'removeUser',
    'getUserAccess',
]);

export default FinancialYearFileManagerController;
