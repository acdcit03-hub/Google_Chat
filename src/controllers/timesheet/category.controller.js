import CategoryModel from '../../models/timesheet/category.model.js';
import { writeAuditLog, pickChangedColumns } from '../../utils/audit.utils.js';
import { AppError, wrapController } from '../../middleware/error.middleware.js';

class CategoryController {
    static withParentPath(category, categories) {
        const { segmentsFor, pathFor } = CategoryModel.buildParentPathIndex(categories);
        const segments = segmentsFor(category.id);

        return {
            ...category,
            id: category.id.toString(),
            isActive: category.is_active,
            category_type: category.category_type || 'PROCESS',
            parent_path: pathFor(category.id),
            parent_path_segments: segments,
        };
    }

    static normalizeParentId(raw) {
        if (raw == null || raw === '') return null;
        const n = Number(raw);
        if (!Number.isInteger(n) || n <= 0) return null;
        return n;
    }

    // FIX: accept every reasonable alias/casing the frontend might be sending
    // the category type under, so it never silently falls back to PROCESS
    // just because the key name didn't match. Also tolerant of it being
    // nested one level under `body.category` or `body.data`.
    static extractCategoryTypeRaw(body) {
        if (!body || typeof body !== 'object') return undefined;

        const candidates = [
            body.category_type,
            body.categoryType,
            body.type,
            body.categorytype,
            body.CategoryType,
            body.Category_Type,
            body.process_type,
            body.processType,
        ];

        for (const c of candidates) {
            if (c != null && String(c).trim() !== '') return c;
        }

        // Check one level of nesting: { category: { type: '...' } } / { data: {...} }
        for (const nestedKey of ['category', 'data', 'payload']) {
            const nested = body[nestedKey];
            if (nested && typeof nested === 'object') {
                const nestedVal =
                    nested.category_type ??
                    nested.categoryType ??
                    nested.type;
                if (nestedVal != null && String(nestedVal).trim() !== '') {
                    return nestedVal;
                }
            }
        }

        return undefined;
    }

    static normalizeCategoryType(raw) {
        if (raw == null || String(raw).trim() === '') {
            return 'PROCESS';
        }

        const value = String(raw).trim().toUpperCase();

        // FIX: tolerate a few common variants (CHECK_LIST, CHECK LIST, LIST)
        // in case the frontend sends a slightly different label for checklist.
        if (value === 'CHECK_LIST' || value === 'CHECK-LIST' || value === 'CHECK LIST' || value === 'LIST') {
            return 'CHECKLIST';
        }
        if (value === 'PROC' || value === 'PROCESS_TYPE') {
            return 'PROCESS';
        }

        if (
            value !== 'PROCESS' &&
            value !== 'CHECKLIST'
        ) {
            throw new AppError(
                'Invalid category_type. Allowed values are PROCESS or CHECKLIST.',
                400,
            );
        }

        return value;
    }

    // Optimized: Fetch all categories and build tree structure.
    // Optional filter: ?parent_id=null → root rows only; ?parent_id=12 → children of 12.
    static async getAllCategories(req, res) {
        const categories = await CategoryModel.findAll();
        const { segmentsFor, pathFor } =
            CategoryModel.buildParentPathIndex(categories);

        const usedIds =
            await CategoryModel.getUsedCategoryIds();

        const rawParentId = req.query?.parent_id ?? req.query?.parentId;
        const hasParentFilter =
            rawParentId !== undefined && rawParentId !== null;

        const isNullParentFilter =
            hasParentFilter &&
            (rawParentId === '' ||
                String(rawParentId).trim().toLowerCase() === 'null' ||
                String(rawParentId).trim().toLowerCase() === 'undefined');

        const parentIdFilter = isNullParentFilter
            ? null
            : hasParentFilter
              ? Number(rawParentId)
              : undefined;

        if (
            hasParentFilter &&
            !isNullParentFilter &&
            (!Number.isInteger(parentIdFilter) || parentIdFilter <= 0)
        ) {
            throw new AppError(
                'Invalid parent_id. Use a positive integer or null.',
                400,
            );
        }

        // Filtered flat list (no tree nesting)
        if (hasParentFilter) {
            const filtered = categories.filter((cat) => {
                if (parentIdFilter === null) {
                    return cat.parent_id == null;
                }
                return Number(cat.parent_id) === parentIdFilter;
            });

            const rows = filtered.map((cat) => {
                const segments = segmentsFor(cat.id);
                return {
                    ...cat,
                    id: cat.id.toString(),
                    isActive: cat.is_active,
                    category_type: cat.category_type || 'PROCESS',
                    parent_path: pathFor(cat.id),
                    parent_path_segments: segments,
                    in_use: usedIds.has(Number(cat.id)),
                    children: [],
                    isExpanded: true,
                };
            });

            return res.json(rows);
        }

        // Build tree structure
        const categoryMap = new Map();
        const rootCategories = [];

        // Single pass: Create map and build tree structure
        categories.forEach(cat => {
            const segments = segmentsFor(cat.id);

            const node = {
                ...cat,
                id: cat.id.toString(),
                isActive: cat.is_active,
                category_type:
                    cat.category_type || 'PROCESS',

                parent_path: pathFor(cat.id),
                parent_path_segments: segments,
                in_use: usedIds.has(Number(cat.id)),
                children: [],
                isExpanded: true,
            };

            categoryMap.set(cat.id, node);

            if (cat.parent_id) {
                const parent = categoryMap.get(cat.parent_id);
                if (parent) {
                    parent.children.push(node);
                } else {
                    // Parent not yet processed, will be linked later
                    rootCategories.push(node);
                }
            } else {
                rootCategories.push(node);
            }
        });

        // Second pass: Link any remaining children to parents
        categories.forEach(cat => {
            if (cat.parent_id) {
                const node = categoryMap.get(cat.id);
                const parent = categoryMap.get(cat.parent_id);
                if (parent && !parent.children.includes(node)) {
                    // Remove from root if it was added there
                    const rootIndex = rootCategories.indexOf(node);
                    if (rootIndex > -1) {
                        rootCategories.splice(rootIndex, 1);
                    }
                    parent.children.push(node);
                }
            }
        });

        res.json(rootCategories);
    }

    static async getCategoryById(req, res) {
        const { id } = req.params;
        const category = await CategoryModel.findById(id);

        if (!category) {
            throw new AppError('Category not found', 404);
        }

        const categories = await CategoryModel.findAll();
        res.json(CategoryController.withParentPath(category, categories));
    }

    static async createCategory(req, res) {
        const body =
            req.body && typeof req.body === 'object' ? req.body : {};

        const letterRaw = body.letter ?? body.categoryLetter;

        const name = body.name ?? body.categoryName ?? '';

        const rawParent = body.parent_id ?? body.parentId;

        const parent_id = CategoryController.normalizeParentId(rawParent,);

        const is_active = body.is_active ?? body.isActive;

        const default_users = body.default_users ?? body.defaultUsers;

        // Respect whatever type the frontend sends (PROCESS for top-level
        // "Add Category" / sub-process, CHECKLIST for checklist items),
        // falling back to PROCESS only when nothing valid was sent.
        const category_type = CategoryController.normalizeCategoryType(
            CategoryController.extractCategoryTypeRaw(body),
        );

        const letterStr = letterRaw == null || letterRaw === '' ? '' : String(letterRaw).trim();

        const nameStr = String(name).trim();

        const hasParentInBody = rawParent != null && rawParent !== '';

        if (hasParentInBody && parent_id == null) {
            throw new AppError(
                'Invalid parent category. Please refresh and try again.',
                400,
            );
        }

        const isTopLevel =
            parent_id == null;

        if (!nameStr) {
            throw new AppError('Name is required. To list categories use GET /api/categories. To create use POST with JSON body: { "name": "...", and "letter": "..." for top-level (or "parent_id": <id> for sub-category) }', 400,);
        }

        if (isTopLevel && !letterStr) {
            throw new AppError('Letter is required for top-level categories. Use POST with body: { "letter": "...", "name": "...", "parent_id": null }', 400,
            );
        }

        if (parent_id) {
            const parentCheck =
                await CategoryModel.findById(
                    parent_id,
                );

            if (!parentCheck) {
                throw new AppError(
                    'Parent category not found',
                    404,
                );
            }
        }

        let newCategory;

        try {
            newCategory =
                await CategoryModel.create({
                    letter: isTopLevel
                        ? letterStr
                        : null,
                    name: nameStr,
                    parent_id,
                    is_active,
                    default_users,
                    category_type,
                });
        } catch (error) {
            if (
                error.code === '23505' &&
                error.constraint ===
                'categories_pkey'
            ) {
                throw new AppError(
                    'Category id sequence was out of sync. Please try again — if it persists, restart the backend.',
                    409,
                );
            }

            throw error;
        }

        const categories =
            await CategoryModel.findAll();

        res.status(201).json(
            CategoryController.withParentPath(
                newCategory,
                categories,
            ),
        );
    }

    static async updateCategory(req, res) {
        const { id } = req.params;

        const before =
            await CategoryModel.findById(id);

        if (!before) {
            throw new AppError(
                'Category not found',
                404,
            );
        }

        const {
            letter,
            name,
            is_active,
            default_users,
            defaultUsers,
        } = req.body;

        // FIX: same wider alias extraction on update, so editing a category
        // to CHECKLIST doesn't silently revert to PROCESS either.
        const rawCategoryType =
            CategoryController.extractCategoryTypeRaw(req.body);

        const categoryCheck = before;

        const updatedCategory =
            await CategoryModel.update(id, {
                letter,
                name,
                is_active,

                default_users:
                    default_users ??
                    defaultUsers ??
                    before.default_users,

                category_type:
                    CategoryController.normalizeCategoryType(
                        rawCategoryType ??
                        before.category_type ??
                        'PROCESS',
                    ),
            });

        if (!updatedCategory) {
            throw new AppError(
                'Category not found',
                404,
            );
        }

        // Audit log
        try {
            const patch =
                pickChangedColumns(
                    categoryCheck,
                    updatedCategory,
                    [
                        'letter',
                        'name',
                        'is_active',
                        'default_users',
                        'category_type',
                    ],
                );

            await writeAuditLog(req, {
                action: 'UPDATE',
                tableName: 'categories',
                tableOfId: parseInt(id, 10),
                tableOfColumn:
                    patch.columns.join(','),
                oldValue: patch.oldValue,
                newValue: patch.newValue,
            });
        } catch (e) {
            console.error(
                'Audit log write failed (category update):',
                e.message || e,
            );
        }

        res.json(updatedCategory);
    }

    static async setActiveStatus(req, res) {
        const { id } = req.params;

        const before =
            await CategoryModel.findById(id);

        if (!before) {
            throw new AppError(
                'Category not found',
                404,
            );
        }

        const raw =
            req.body?.is_active ??
            req.body?.isActive;

        if (raw === undefined) {
            throw new AppError(
                'is_active is required',
                400,
            );
        }

        const isActive =
            raw === true ||
            raw === 'true' ||
            raw === 1 ||
            raw === '1';

        // FIX: toggling a category now cascades to its whole subtree in
        // BOTH directions — previously only deactivating cascaded, so
        // reactivating a parent left every descendant stuck INACTIVE.
        const updated =
            await CategoryModel.setActive(
                id,
                isActive,
                {
                    cascadeDeactivate:
                        !isActive,
                    cascadeActivate:
                        isActive,
                },
            );

        if (!updated) {
            throw new AppError(
                'Category not found',
                404,
            );
        }

        try {
            await writeAuditLog(req, {
                action: 'UPDATE',
                tableName: 'categories',
                tableOfId: parseInt(id, 10),
                tableOfColumn: 'is_active',
                oldValue: before.is_active,
                newValue: updated.is_active,
            });
        } catch (e) {
            console.error(
                'Audit log write failed (category status):',
                e.message || e,
            );
        }

        res.json({
            success: true,

            message: isActive
                ? 'Category activated successfully'
                : 'Category deactivated successfully',

            category: updated,
        });
    }

    static async deleteCategory(req, res) {
        const { id } = req.params;

        const category =
            await CategoryModel.findById(id);

        if (!category) {
            throw new AppError(
                'Category not found',
                404,
            );
        }

        const children =
            await CategoryModel.findChildren(id);

        if (children.length > 0) {
            throw new AppError(
                'Cannot delete: this category has sub-categories. Delete or move them first.',
                409,
            );
        }

        const usedIds =
            await CategoryModel.getUsedCategoryIds();

        if (usedIds.has(Number(id))) {
            throw new AppError(
                'Cannot delete: this category is used in existing timesheet or project records. Deactivate it instead.',
                409,
            );
        }

        const deleted =
            await CategoryModel.hardDelete(id);

        if (!deleted) {
            throw new AppError(
                'Category not found',
                404,
            );
        }

        try {
            await writeAuditLog(req, {
                action: 'DELETE',
                tableName: 'categories',
                tableOfId: parseInt(id, 10),
                tableOfColumn: '*',
                oldValue:
                    JSON.stringify(category),
                newValue: null,
            });
        } catch (e) {
            console.error(
                'Audit log write failed (category delete):',
                e.message || e,
            );
        }

        res.json({
            success: true,
            message:
                'Category deleted successfully',
        });
    }
}

wrapController(CategoryController, [
    'getAllCategories',
    'getCategoryById',
    'createCategory',
    'updateCategory',
    'setActiveStatus',
    'deleteCategory',
]);

export default CategoryController;