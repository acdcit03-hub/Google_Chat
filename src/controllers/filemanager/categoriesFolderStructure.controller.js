import CategoriesFolderStructureModel from '../../models/filemanager/categoriesFolderStructure.model.js';
import { wrapController } from '../../middleware/error.middleware.js';

function parseId(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
}

class CategoriesFolderStructureController {
    /** GET /categories-folder-structure */
    static async list(req, res) {
        const rows = await CategoriesFolderStructureModel.findAll({
            category_id: req.query.category_id ?? req.query.categoryId ?? null,
            parent_id:
                req.query.parent_id !== undefined
                    ? req.query.parent_id
                    : req.query.parentId !== undefined
                      ? req.query.parentId
                      : undefined,
            is_active: req.query.is_active ?? req.query.isActive ?? null,
            search: req.query.search || null,
        });
        return res.json({ success: true, data: rows });
    }

    /** GET /categories-folder-structure/category/:categoryId */
    static async getByCategoryId(req, res) {
        const categoryId = parseId(req.params.categoryId);
        if (!categoryId) {
            return res.status(400).json({
                success: false,
                message: 'Valid categoryId is required',
            });
        }

        const rows =
            await CategoriesFolderStructureModel.findByCategoryId(categoryId);
        return res.json({ success: true, data: rows });
    }

    /** GET /categories-folder-structure/:id/children */
    static async getChildren(req, res) {
        const id = parseId(req.params.id);
        if (!id) {
            return res.status(400).json({
                success: false,
                message: 'Valid id is required',
            });
        }

        const rows = await CategoriesFolderStructureModel.findChildren(id);
        return res.json({ success: true, data: rows });
    }

    /** GET /categories-folder-structure/:id */
    static async getById(req, res) {
        const id = parseId(req.params.id);
        if (!id) {
            return res.status(400).json({
                success: false,
                message: 'Valid id is required',
            });
        }

        const row = await CategoriesFolderStructureModel.findById(id);
        if (!row) {
            return res.status(404).json({
                success: false,
                message: 'Folder structure not found',
            });
        }

        return res.json({ success: true, data: row });
    }

    /** POST /categories-folder-structure */
    static async create(req, res) {
        const body = req.body || {};
        const folder_name = body.folder_name ?? body.folderName;

        if (!String(folder_name || '').trim()) {
            return res.status(400).json({
                success: false,
                message: 'folder_name is required',
            });
        }

        try {
            const row = await CategoriesFolderStructureModel.create({
                category_id: body.category_id ?? body.categoryId,
                category_name: body.category_name ?? body.categoryName,
                category_letter: body.category_letter ?? body.categoryLetter,
                parent_id: body.parent_id ?? body.parentId ?? null,
                folder_name,
                // folder_path + display_order auto-set by model when omitted
                folder_path: body.folder_path ?? body.folderPath,
                folder_scope: body.folder_scope ?? body.folderScope ?? 'project',
                google_sheet_url:
                    body.google_sheet_url ?? body.googleSheetUrl ?? null,
                google_sheet_file_name:
                    body.google_sheet_file_name ??
                    body.googleSheetFileName ??
                    null,
                display_order: body.display_order ?? body.displayOrder,
                is_active: body.is_active ?? body.isActive ?? true,
                created_by: body.created_by ?? body.createdBy ?? null,
            });

            return res.status(201).json({
                success: true,
                message: 'Folder structure created',
                data: row,
            });
        } catch (err) {
            const message = err?.message || 'Failed to create folder structure';
            if (
                /google_sheet_url|google_sheet_file_name|folder_name is required/i.test(message)
            ) {
                return res.status(400).json({ success: false, message });
            }
            throw err;
        }
    }

    /** PUT /categories-folder-structure/:id */
    static async update(req, res) {
        const id = parseId(req.params.id);
        if (!id) {
            return res.status(400).json({
                success: false,
                message: 'Valid id is required',
            });
        }

        const body = req.body || {};
        try {
            const row = await CategoriesFolderStructureModel.update(id, {
                category_id: body.category_id ?? body.categoryId,
                category_name: body.category_name ?? body.categoryName,
                category_letter: body.category_letter ?? body.categoryLetter,
                parent_id: body.parent_id ?? body.parentId,
                folder_name: body.folder_name ?? body.folderName,
                folder_path: body.folder_path ?? body.folderPath,
                folder_scope: body.folder_scope ?? body.folderScope,
                google_sheet_url:
                    body.google_sheet_url !== undefined
                        ? body.google_sheet_url
                        : body.googleSheetUrl !== undefined
                          ? body.googleSheetUrl
                          : undefined,
                google_sheet_file_name:
                    body.google_sheet_file_name !== undefined
                        ? body.google_sheet_file_name
                        : body.googleSheetFileName !== undefined
                          ? body.googleSheetFileName
                          : undefined,
                display_order: body.display_order ?? body.displayOrder,
                is_active: body.is_active ?? body.isActive,
            });

            if (!row) {
                return res.status(404).json({
                    success: false,
                    message: 'Folder structure not found',
                });
            }

            return res.json({
                success: true,
                message: 'Folder structure updated',
                data: row,
            });
        } catch (err) {
            const message = err?.message || 'Failed to update folder structure';
            if (
                /google_sheet_url|google_sheet_file_name|folder_name is required|parent_id cannot/i.test(
                    message,
                )
            ) {
                return res.status(400).json({ success: false, message });
            }
            throw err;
        }
    }

    /** DELETE /categories-folder-structure/:id */
    static async remove(req, res) {
        const id = parseId(req.params.id);
        if (!id) {
            return res.status(400).json({
                success: false,
                message: 'Valid id is required',
            });
        }

        const row = await CategoriesFolderStructureModel.remove(id);
        if (!row) {
            return res.status(404).json({
                success: false,
                message: 'Folder structure not found',
            });
        }

        return res.json({
            success: true,
            message: 'Folder structure deleted',
            data: row,
        });
    }
}

wrapController(CategoriesFolderStructureController, [
    'list',
    'getByCategoryId',
    'getChildren',
    'getById',
    'create',
    'update',
    'remove',
]);

export default CategoriesFolderStructureController;
