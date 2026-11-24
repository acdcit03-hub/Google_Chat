
import path from 'path';
import ProductionModel from '../../models/projectsheet/production.model.js';
import { pool } from '../../config/db.js';
import { PRODUCTION_DEFAULT_STATUS, PRODUCTION_STATUSES } from '../../utils/productionStatus.utils.js';
import { broadcastClientUpdate } from '../../config/socket.js';
import { v2 as cloudinary } from 'cloudinary';
import { getUserIdFromReq, getUsernameFromReq, writeAuditLog, pickChangedColumns } from '../../utils/audit.utils.js';
import { findProductionLogs, insertProductionFieldLogs } from '../../models/projectsheet/productionLog.model.js';
import { resolveStatsScopeFromQuery } from '../../utils/dataScope.utils.js';
import { AppError, wrapController } from '../../middleware/error.middleware.js';

// Configure Cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

class ProductionController {
    static async getProductionStats(req, res) {
        const financialYear =
            req.query?.financialYear ?? req.query?.financial_year;
        const { scopeUsernames } = await resolveStatsScopeFromQuery(req.query);

        const stats = await ProductionModel.getStats({
            ...req.query,
            financialYear,
            scopeUsernames,
        });

        res.json({
            success: true,
            stats: {
                total: Number(stats.total) || 0,
                ...Object.fromEntries(
                    PRODUCTION_STATUSES.map(({ key }) => [
                        key,
                        Number(stats[key]) || 0,
                    ]),
                ),
            },
        });
    }

    // Optimized: Fetch productions with parallel count and data queries
    static async getAllProductions(req, res) {
        const {
            limit, offset, page, all,
            status, project_code, lot_no, pcb_code, production_code, financialYear,
            project_name, prepare_person, place,
            serial_no_from, serial_no_to,
            dispatch_target_date_from, dispatch_target_date_to,
            dispatch_date_from, dispatch_date_to,
            acdc_target_date_from, acdc_target_date_to,
            emble_target_date_from, emble_target_date_to,
            completed_date_from, completed_date_to,
        } = req.query;

        const filters = {
            limit: all === 'true' ? 10000 : (parseInt(limit) || 10),
            offset: parseInt(offset),
            page: parseInt(page) || 1,
            all,
            status,
            projectCode: project_code,
            lotNo: lot_no,
            pcbCode: pcb_code,
            productionCode: production_code,
            projectName: project_name,
            preparePerson: prepare_person,
            place,
            serialNoFrom: serial_no_from,
            serialNoTo: serial_no_to,
            dispatch_target_date_from,
            dispatch_target_date_to,
            dispatch_date_from,
            dispatch_date_to,
            acdc_target_date_from,
            acdc_target_date_to,
            emble_target_date_from,
            emble_target_date_to,
            completed_date_from,
            completed_date_to,
            financialYear
        };

        // Parallel execution: FY filter applied in SQL via serial_no center code (PRD-2627-034 → 2627)
        const [countResult, dataResult] = await Promise.all([
            ProductionModel.count(filters),
            ProductionModel.findAll(filters)
        ]);

        const finalProductions = dataResult;
        const finalTotal = countResult;

        const actualLimit = filters.limit;
        const actualOffset = filters.offset !== undefined && !isNaN(filters.offset) && filters.offset >= 0
            ? filters.offset
            : (filters.page - 1) * actualLimit;
        const actualPage = filters.page || 1;

        res.json({
            success: true,
            productions: finalProductions,
            pagination: {
                total: finalTotal,
                limit: actualLimit,
                offset: actualOffset,
                page: actualPage,
                totalPages: finalTotal > 0 ? Math.ceil(finalTotal / actualLimit) : 0,
                hasNextPage: actualOffset + actualLimit < finalTotal,
                hasPrevPage: actualOffset > 0
            }
        });
    }

    static async getProductionById(req, res) {
        const { id } = req.params;
        const production = await ProductionModel.findById(id);
        if (!production) {
            throw new AppError('Production not found', 404);
        }
        res.json({
            success: true,
            production
        });
    }

    static async getProductionLogs(req, res) {
        const { id } = req.params;
        const production = await ProductionModel.findById(id);
        if (!production) {
            throw new AppError('Production not found', 404);
        }
        const logs = await findProductionLogs(id);
        res.json({
            success: true,
            logs,
        });
    }

    /**
     * GET productions by project_code, grouped by pcb_code for display.
     * Query: ?project_code=XXX (required)&pcb_code=YYY (optional — exact PCB filter)
     */
    static async getProductionsGroupedByPcbCode(req, res) {
        const projectCode = String(
            req.query.project_code || req.query.projectCode || '',
        ).trim();
        const pcbCode = String(
            req.query.pcb_code || req.query.pcbCode || '',
        ).trim();

        if (!projectCode) {
            throw new AppError('project_code is required', 400);
        }

        const rows = await ProductionModel.findByProjectCodeGroupedReady(
            projectCode,
            pcbCode || undefined,
        );

        const groupMap = new Map();
        for (const row of rows) {
            const pcbKey = String(row.pcb_code || '').trim() || '(no pcb)';
            if (!groupMap.has(pcbKey)) {
                groupMap.set(pcbKey, []);
            }
            groupMap.get(pcbKey).push(row);
        }

        const groups = Array.from(groupMap.entries()).map(([pcb_code, productions]) => ({
            pcb_code,
            count: productions.length,
            productions,
        }));

        res.json({
            success: true,
            project_code: projectCode,
            ...(pcbCode ? { pcb_code: pcbCode } : {}),
            total: rows.length,
            group_count: groups.length,
            groups,
        });
    }

    // Optimized: Parallel checks for duplicate code and project lookup
    static async createProduction(req, res) {
        const {
            project_name, project_code, pcb_code, lot_no, qty, production_code,
            bom_link, bom_file, requirementsheep_link, requirementsheep_file,
            gerber_link, gerber_file, panel_gerber_link, panel_gerber_file, stencil_link, stencil_file,
            sample_photo_link, sample_photo_file, testing_link, testing_file,
            prepare_person, dispatch_target_date, dispatch_date, acdc_target_date, emble_target_date,
            production_done_date, production_photos, status, place, comment, odoo_link, created_by, serial_no,
            filemanager_bom, filemanager_requirementsheep, filemanager_gerber,
            filemanager_panel_gerber, filemanager_stencil, filemanager_production_photos,
            filemanager_testing,
        } = req.body;



        // Parallel execution: check for duplicate and fetch project name
        const [duplicateCheck, projectResult] = await Promise.all([
            pool.query('SELECT id FROM "PRODUCTION" WHERE production_code = $1 LIMIT 1', [production_code]),
            project_code ? pool.query('SELECT project_name FROM "PROJECT" WHERE project_code = $1 LIMIT 1', [project_code]) : Promise.resolve({ rows: [] })
        ]);


        const finalProjectName = projectResult.rows.length > 0
            ? projectResult.rows[0].project_name
            : (project_name || '');

        let newProduction;
        try {
            newProduction = await ProductionModel.create({
                project_name: finalProjectName,
                project_code,
                pcb_code,
                lot_no,
                qty,
                production_code,
                bom_link,
                bom_file,
                requirementsheep_link,
                requirementsheep_file,
                gerber_link,
                gerber_file,
                panel_gerber_link,
                panel_gerber_file,
                stencil_link,
                stencil_file,
                sample_photo_link,
                sample_photo_file,
                testing_link,
                testing_file,
                prepare_person,
                dispatch_target_date,
                dispatch_date,
                acdc_target_date,
                emble_target_date,
                production_done_date,
                production_photos,
                status: status || PRODUCTION_DEFAULT_STATUS,
                place,
                comment,
                odoo_link,
                created_by,
                serial_no,
                filemanager_bom,
                filemanager_requirementsheep,
                filemanager_gerber,
                filemanager_panel_gerber,
                filemanager_stencil,
                filemanager_production_photos,
                filemanager_testing,
            });
        } catch (error) {
            if (error.code === '23505') {
                throw new AppError('Production code already exists', 400);
            }
            throw error;
        }

        try {
            broadcastClientUpdate('created', { source: 'production', id: newProduction.id, production: newProduction });
        } catch (e) {
            console.error('Production create socket broadcast failed:', e);
        }

        res.status(201).json({
            success: true,
            message: 'Production created successfully',
            production: newProduction
        });
    }

    // Optimized: Parallel checks for production existence and project lookup
    static async updateProduction(req, res) {
        const { id } = req.params;
        const userId = getUserIdFromReq(req);
        const existingProduction = await ProductionModel.findById(id);
        if (!existingProduction) {
            throw new AppError('Production not found', 404);
        }
        const {
            project_name, project_code, pcb_code, lot_no, qty, production_code,
            bom_link, bom_file, requirementsheep_link, requirementsheep_file,
            gerber_link, gerber_file, panel_gerber_link, panel_gerber_file, stencil_link, stencil_file,
            sample_photo_link, sample_photo_file, testing_link, testing_file,
            prepare_person, dispatch_target_date, dispatch_date, acdc_target_date, emble_target_date,
            production_done_date, production_photos, status, place, comment, odoo_link, serial_no,
            filemanager_bom, filemanager_requirementsheep, filemanager_gerber,
            filemanager_panel_gerber, filemanager_stencil, filemanager_production_photos,
            filemanager_testing,
        } = req.body;

        // Parallel execution: check production existence and fetch project name
        const [productionCheck, projectResult] = await Promise.all([
            pool.query('SELECT id FROM "PRODUCTION" WHERE id = $1', [id]),
            project_code ? pool.query('SELECT project_name FROM "PROJECT" WHERE project_code = $1 LIMIT 1', [project_code]) : Promise.resolve({ rows: [] })
        ]);

        if (productionCheck.rows.length === 0) {
            throw new AppError('Production not found', 404);
        }

        // Check for duplicate production_code if it's being updated
        if (production_code) {
            const duplicateCheck = await pool.query(
                'SELECT id FROM "PRODUCTION" WHERE production_code = $1 AND id != $2 LIMIT 1',
                [production_code, id]
            );

        }

        const finalProjectName = projectResult.rows.length > 0
            ? projectResult.rows[0].project_name
            : (project_name || null);

        // Build update data object
        const updateData = {};
        if (finalProjectName !== null) updateData.project_name = finalProjectName;
        if (project_code !== undefined) updateData.project_code = project_code;
        if (pcb_code !== undefined) updateData.pcb_code = pcb_code;
        if (lot_no !== undefined) updateData.lot_no = lot_no;
        if (qty !== undefined) updateData.qty = qty;
        if (production_code !== undefined) updateData.production_code = production_code;
        if (bom_link !== undefined) updateData.bom_link = bom_link;
        if (bom_file !== undefined) updateData.bom_file = bom_file;
        if (requirementsheep_link !== undefined) updateData.requirementsheep_link = requirementsheep_link;
        if (requirementsheep_file !== undefined) updateData.requirementsheep_file = requirementsheep_file;
        if (gerber_link !== undefined) updateData.gerber_link = gerber_link;
        if (gerber_file !== undefined) updateData.gerber_file = gerber_file;
        if (panel_gerber_link !== undefined) updateData.panel_gerber_link = panel_gerber_link;
        if (panel_gerber_file !== undefined) updateData.panel_gerber_file = panel_gerber_file;
        if (stencil_link !== undefined) updateData.stencil_link = stencil_link;
        if (stencil_file !== undefined) updateData.stencil_file = stencil_file;
        if (sample_photo_link !== undefined) updateData.sample_photo_link = sample_photo_link;
        if (sample_photo_file !== undefined) updateData.sample_photo_file = sample_photo_file;
        if (testing_link !== undefined) updateData.testing_link = testing_link;
        if (testing_file !== undefined) updateData.testing_file = testing_file;
        if (prepare_person !== undefined) updateData.prepare_person = prepare_person;
        if (dispatch_target_date !== undefined) updateData.dispatch_target_date = dispatch_target_date;
        if (dispatch_date !== undefined) updateData.dispatch_date = dispatch_date;
        if (acdc_target_date !== undefined) updateData.acdc_target_date = acdc_target_date;
        if (emble_target_date !== undefined) updateData.emble_target_date = emble_target_date;
        if (production_done_date !== undefined) updateData.production_done_date = production_done_date;
        if (production_photos !== undefined) updateData.production_photos = production_photos;
        if (status !== undefined) updateData.status = status;
        if (place !== undefined) updateData.place = place;
        if (comment !== undefined) updateData.comment = comment;
        if (odoo_link !== undefined) updateData.odoo_link = odoo_link;
        if (serial_no !== undefined) updateData.serial_no = serial_no;
        if (filemanager_bom !== undefined) updateData.filemanager_bom = filemanager_bom;
        if (filemanager_requirementsheep !== undefined) {
            updateData.filemanager_requirementsheep = filemanager_requirementsheep;
        }
        if (filemanager_gerber !== undefined) updateData.filemanager_gerber = filemanager_gerber;
        if (filemanager_panel_gerber !== undefined) {
            updateData.filemanager_panel_gerber = filemanager_panel_gerber;
        }
        if (filemanager_stencil !== undefined) updateData.filemanager_stencil = filemanager_stencil;
        if (filemanager_production_photos !== undefined) {
            updateData.filemanager_production_photos = filemanager_production_photos;
        }
        if (filemanager_testing !== undefined) updateData.filemanager_testing = filemanager_testing;

        const updatedProduction = await ProductionModel.update(id, updateData);
        if (!updatedProduction) {
            throw new AppError('Production not found', 404);
        }

        try {
            broadcastClientUpdate('updated', { source: 'production', id: parseInt(id, 10), production: updatedProduction });
        } catch (e) {
            console.error('Production update socket broadcast failed:', e);
        }

        res.json({
            success: true,
            message: 'Production updated successfully',
            production: updatedProduction
        });

        // Audit log (best-effort)
        try {
            const candidate = Object.keys(updateData || {});
            const patch = pickChangedColumns(existingProduction, updatedProduction, candidate);
            await writeAuditLog(req, {
                action: 'UPDATE',
                tableName: 'PRODUCTION',
                tableOfId: parseInt(id, 10),
                tableOfColumn: patch.columns.join(','),
                oldValue: patch.oldValue,
                newValue: patch.newValue,
                userId
            });
            await insertProductionFieldLogs({
                productionId: updatedProduction.id,
                productionCode: updatedProduction.production_code || existingProduction.production_code,
                changed: patch,
                updatedBy: getUsernameFromReq(req),
            });
        } catch (e) {
            console.error('Audit log write failed (production update):', e.message || e);
        }
    }

    static async deleteProduction(req, res) {
        const { id } = req.params;
        const userId = getUserIdFromReq(req);
        const existingProduction = await ProductionModel.findById(id);
        if (!existingProduction) {
            throw new AppError('Production not found', 404);
        }
        const deleted = await ProductionModel.delete(id);
        if (!deleted) {
            throw new AppError('Production not found', 404);
        }

        try {
            broadcastClientUpdate('deleted', { source: 'production', id: parseInt(id, 10) });
        } catch (e) {
            console.error('Production delete socket broadcast failed:', e);
        }

        res.json({
            success: true,
            message: 'Production deleted successfully'
        });

        // Audit log (best-effort)
        try {
            await writeAuditLog(req, {
                action: 'DELETE',
                tableName: 'PRODUCTION',
                tableOfId: parseInt(id, 10),
                tableOfColumn: 'id',
                oldValue: existingProduction,
                newValue: null,
                userId
            });
        } catch (e) {
            console.error('Audit log write failed (production delete):', e.message || e);
        }
    }

    // Upload production file to Cloudinary
    static async uploadFile(req, res) {
        if (!req.file) {
            throw new AppError('No file provided', 400);
        }

        const { production_code, file_type } = req.body;

        if (!production_code) {
            throw new AppError('Production code is required', 400);
        }

        // Clean production code for folder name
        const cleanProductionCode = production_code.replace(/[^a-zA-Z0-9-]/g, '_').toUpperCase();
        const folderPath = `productions/${cleanProductionCode}/${file_type || 'documents'}`;

        // Validate file type based on file_type parameter
        const allowedTypes = {
            'bom': [
                'application/vnd.ms-excel',
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'application/vnd.ms-excel.sheet.macroEnabled.12',
                'application/x-excel',
                'application/x-msexcel'
            ],
            'pick_place': [
                'application/vnd.ms-excel',
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'application/vnd.ms-excel.sheet.macroEnabled.12',
                'application/x-excel',
                'application/x-msexcel'
            ],
            'gerber': [
                'application/zip',
                'application/x-zip-compressed',
                'application/x-compressed',
                'application/x-compress'
            ],
            'panel_gerber': [
                'application/zip',
                'application/x-zip-compressed',
                'application/x-compressed',
                'application/x-compress'
            ],
            'stencil': [
                'application/zip',
                'application/x-zip-compressed',
                'application/x-compressed',
                'application/x-compress',
                'application/x-coreldraw',
                'application/coreldraw',
                'image/x-coreldraw'
            ],
            'sample_photo': [
                'image/jpeg',
                'image/jpg',
                'image/png',
                'image/gif',
                'image/webp',
                'image/bmp',
                'image/svg+xml'
            ],
            'testing': [
                'application/pdf',
                'application/msword',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                'application/vnd.ms-excel',
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'text/plain',
                'text/csv'
            ]
        };

        const allowedMimeTypes = allowedTypes[file_type] || [];
        const isImage = req.file.mimetype.startsWith('image/');

        // Check if file type is valid
        let isValidType = false;
        if (allowedMimeTypes.length > 0) {
            isValidType = allowedMimeTypes.includes(req.file.mimetype);
            if (!isValidType && file_type === 'sample_photo' && isImage) {
                isValidType = true;
            }
        } else {
            isValidType = true;
        }

        if (!isValidType) {
            const fileTypeNames = {
                'bom': 'Excel files (XLS, XLSX)',
                'pick_place': 'Excel files (XLS, XLSX)',
                'gerber': 'ZIP files',
                'panel_gerber': 'ZIP files',
                'stencil': 'CDR or ZIP files',
                'sample_photo': 'Image files (JPG, JPEG, PNG, GIF, WebP, etc.)',
                'testing': 'Document files (PDF, DOC, DOCX, Word, etc.)'
            };
            throw new AppError(`Invalid file type for ${file_type}. Only ${fileTypeNames[file_type] || 'allowed file types'} are allowed.`, 400);
        }

        // Generate filename
        const timestamp = Date.now();
        const originalName = req.file.originalname || 'file';
        const fileExtension = path.extname(originalName) || (isImage ? '.jpg' : '.pdf');
        const nameWithoutExt = originalName.replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9._-]/g, '_').toLowerCase();
        const cleanName = nameWithoutExt || (isImage ? 'image' : 'document');
        const publicId = `${folderPath}/${cleanName}_${timestamp}${fileExtension}`;

        // Upload to Cloudinary (async operation)
        let uploadResult;
        if (isImage) {
            const base64Image = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
            uploadResult = await cloudinary.uploader.upload(base64Image, {
                public_id: publicId,
                folder: folderPath,
                resource_type: 'image',
                transformation: [
                    { width: 1200, height: 1200, crop: 'limit' },
                    { quality: 'auto' }
                ]
            });
        } else {
            const base64Document = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
            uploadResult = await cloudinary.uploader.upload(base64Document, {
                public_id: publicId,
                folder: folderPath,
                resource_type: 'raw'
            });
        }

        try {
            broadcastClientUpdate('updated', { source: 'production', production_code, file_type: file_type || null });
        } catch (e) {
            console.error('Production upload socket broadcast failed:', e);
        }

        res.json({
            success: true,
            fileUrl: uploadResult.secure_url,
            publicId: uploadResult.public_id,
            folder: folderPath,
            fileType: isImage ? 'image' : 'document',
            fileName: originalName
        });
    }
}

wrapController(ProductionController, [
    'getProductionStats',
    'getAllProductions',
    'getProductionById',
    'getProductionLogs',
    'getProductionsGroupedByPcbCode',
    'createProduction',
    'updateProduction',
    'deleteProduction',
    'uploadFile',
]);

export default ProductionController;
