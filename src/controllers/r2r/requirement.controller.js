import { AppError, wrapController } from '../../middleware/error.middleware.js';
import RequirementModel from '../../models/r2r/requirement.model.js';
import QtyReservationModel from '../../models/r2r/qtyReservation.model.js';

import R2rTempRequirementModel from '../../models/r2r/r2rTempRequirement.model.js';
import R2rTempBomImageModel from '../../models/r2r/r2rTempBomImage.model.js';
import { pool } from '../../config/db.js';
import { broadcast, getIO } from '../../config/socket.js';
import {
    calculateDaysDifference,
    getCurrentDateDDMMYYYY,
    convertDateToPostgres,
    formatRequirementDates,
    fixRequirementSequenceInTransaction,
    normalizeRequirementBody
} from '../../utils/requirement.utils.js';
import { getUserIdFromReq, getUsernameFromReq, writeAuditLog, pickChangedColumns } from '../../utils/audit.utils.js';
import { logRequirementFieldChanges } from '../../models/r2r/requirementEditLog.model.js';
import {
    buildExactUserScopeSql,
    resolveStatsScopeFromQuery,
} from '../../utils/dataScope.utils.js';
import { saveR2rProductPhoto } from '../../utils/r2rImageStorage.js';
import {
    notifyRequirementStatusChange,
    notifyBomBatchCreated,
    notifyBulkRequirementStatusChange,
    notifyBulkReceiveDone,
} from '../../utils/notification/requirementStatusNotify.js';
import {
    buildIssueSocketPayload,
    emitIssueSocket,
} from '../../utils/notification/r2rDesktopNotify.js';
import { getUsernamesForPage } from '../../utils/userPermission.utils.js';
import {
    notifyReceiveIssueToRequirePerson,
    clearReceiveIssueNotifications,
    isReceiveIssueRow,
    isReceiveIssueResponseOrderStatus,
    notifyReceiveIssueResponseToReceiveItemsUsers,
} from '../../utils/notification/receiveIssueNotify.js';
import {
    createTerminateRequestedReadNotification,
    resolveIssueReportedRecipients,
    notifyIssueReportedReadNotifications,
} from '../../utils/notification/readNotificationNotify.js';
import { resolveRequirementSerialYearCode } from '../../utils/financial-year.utils.js';
import {
    recordRequirementStatusChange,
    ensureReceiveIssueStatusHistory,
    recordQtyReservationStatusChange,
    findRequirementStatuses,
    findRequirementStatusBySerial,
} from '../../models/r2r/requirementStatus.model.js';

class RequirementController {
    static normalizeSerialNumber(serial) {
        if (!serial) return serial;
        const s = String(serial).trim();
        if (!s) return s;
        // Collapse accidental multiple hyphens: RFQ--2526-001 -> RFQ-2526-001
        return s.replace(/-+/g, '-');
    }

    /**
     * Keep receive-issue / confirm-issue order statuses.
     * Generic workflow "Issue" must not overwrite "Receive Issue" or "Confirm Issue".
     */
    static resolveOrderStatusFromWorkflowStatus(status, orderStatus, fallback) {
        const requested =
            orderStatus !== undefined && orderStatus !== null && String(orderStatus).trim() !== ''
                ? String(orderStatus).trim()
                : fallback;
        if (!status) return requested;

        const statusLower = String(status).toLowerCase().trim();
        const requestedLower = String(requested || '').toLowerCase().trim();

        if (statusLower === 'confirm issue') {
            if (requestedLower === 'decline by user') {
                return 'Decline by User';
            }
            return 'Accept by User';
        }
        if (requestedLower === 'accept by user') {
            return 'Accept by User';
        }
        if (requestedLower === 'decline by user') {
            return 'Decline by User';
        }
        if (statusLower === 'receive issue' || requestedLower === 'receive issue') {
            return 'Receive Issue';
        }
        if (statusLower === 'received with issue' || requestedLower === 'received with issue') {
            return 'Received With Issue';
        }
        if (statusLower.includes('issue')) {
            return 'Issue';
        }
        if (statusLower.includes('terminate') || statusLower.includes('terminated')) {
            return 'Terminated';
        }
        if (statusLower === 'order done') {
            return 'Order Done';
        }
        if (statusLower === 'receive done') {
            if (
                requestedLower === 'receive issue' ||
                requestedLower === 'received with issue' ||
                requestedLower === 'accept by user' ||
                requestedLower === 'decline by user'
            ) {
                return requested;
            }
            return 'Receive Done';
        }
        return requested;
    }

    /** Format a REQUIREMENT row for WebSocket `requirement-update` (includes qtyreservation_status). */
    static formatRequirementBroadcastRow(row) {
        if (!row) return row;
        const formatted = formatRequirementDates({ ...row });
        formatted.serial_number = RequirementController.normalizeSerialNumber(
            formatted.serial_number,
        );
        return formatted;
    }

    /** Emit `requirement-update` with a normalized row for live stat cards + tables. */
    static broadcastRequirementLive(type, row) {
        if (type === 'deleted') {
            broadcast('requirement-update', type, row);
            return;
        }
        broadcast(
            'requirement-update',
            type,
            RequirementController.formatRequirementBroadcastRow(row),
        );
    }

    /** Upload/paste → Cloudinary URL; existing https URL → stored as-is in DB. */
    static async resolveProductPhotoForDb(serialOrDraft, photoInput, options = {}) {
        if (photoInput == null || String(photoInput).trim() === '') return null;
        const serial =
            RequirementController.normalizeSerialNumber(serialOrDraft) ||
            String(serialOrDraft || 'draft').trim() ||
            'draft';
        return saveR2rProductPhoto(serial, photoInput, options);
    }

    static async transferBomImageToRequirement(serialNumber, kind = 'product') {
        if (!serialNumber) return false;
        const normalizedSerial = RequirementController.normalizeSerialNumber(serialNumber);
        if (!normalizedSerial) return false;

        let tempImage;
        try {
            tempImage = await R2rTempBomImageModel.findLatestProcessedBySerial(normalizedSerial);
        } catch (err) {
            if (err?.code === '42P01') {
                try {
                    await R2rTempBomImageModel.initializeTable();
                    tempImage = await R2rTempBomImageModel.findLatestProcessedBySerial(normalizedSerial);
                } catch (initErr) {
                    console.error('Error ensuring r2r_temp_bom_images table:', initErr.message);
                    return false;
                }
            } else {
                throw err;
            }
        }
        if (!tempImage || !tempImage.processed_image_url) return false;

        let photoValue;
        try {
            photoValue = await RequirementController.resolveProductPhotoForDb(
                normalizedSerial,
                tempImage.processed_image_url,
                { kind },
            );
        } catch (photoErr) {
            console.error('Error storing BOM image on requirement:', photoErr);
            return false;
        }
        if (!photoValue) return false;

        const targetColumn = kind === 'bill' ? 'bill_or_product_photo' : 'product_photo';
        const updateResult = await pool.query(
            `UPDATE "REQUIREMENT"
             SET "${targetColumn}" = $1,
                 updated_at = CURRENT_TIMESTAMP
             WHERE serial_number = $2
             RETURNING *`,
            [photoValue, normalizedSerial]
        );

        if (updateResult.rows.length === 0) {
            return false;
        }

        await R2rTempBomImageModel.update(tempImage.id, {
            processing_status: 'TRANSFERRED',
            upload_status: 'COMPLETED'
        });

        return true;
    }


    /** Resolve TEMP_REQUIREMENT row by UUID temp_id or numeric primary key. */
    static async resolveTempRequirementRow(tempRef) {
        const ref = tempRef != null ? String(tempRef).trim() : '';
        if (!ref) return null;

        let row = await R2rTempRequirementModel.findByTempId(ref);
        if (row?.id) return row;

        if (/^\d+$/.test(ref)) {
            row = await R2rTempRequirementModel.findById(parseInt(ref, 10));
            if (row?.id) return row;
        }

        return null;
    }

    /** Remove serial_number from temp draft payloads (assigned only on RFQ submit). */
    static sanitizeTempDraftData(data = {}) {
        if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
        const clean = { ...data };
        delete clean.serial_number;
        return clean;
    }

    /** True when TEMP row holds a BOM bulk draft in bom_preview JSONB. */
    static isBomBulkTempDraft(row) {
        if (!row) return false;
        if (String(row.requirement_type ?? '').trim() === 'BOM_BULK') return true;
        const data =
            row.data && typeof row.data === 'object' && !Array.isArray(row.data)
                ? row.data
                : {};
        if (String(data.draft_kind ?? '').trim() === 'bom') return true;
        const bomPreview = row.bom_preview;
        if (!bomPreview || typeof bomPreview !== 'object' || Array.isArray(bomPreview)) {
            return false;
        }
        if (Array.isArray(bomPreview.rows) && bomPreview.rows.length > 0) return true;
        const meta =
            bomPreview.meta && typeof bomPreview.meta === 'object' && !Array.isArray(bomPreview.meta)
                ? bomPreview.meta
                : {};
        return Boolean(
            String(meta.project_code ?? '').trim() ||
                String(meta.pcb_code ?? '').trim() ||
                String(meta.lot_no ?? '').trim(),
        );
    }

    /** Draft row counts only when user entered real RFQ fields (not preview serial alone). */
    static isMeaningfulTempDraft(row) {
        if (!row) return false;
        if (RequirementController.isBomBulkTempDraft(row)) return true;
        const data =
            row.data && typeof row.data === 'object' && !Array.isArray(row.data)
                ? row.data
                : {};
        const pick = (key) => {
            const v = row[key] ?? data[key];
            if (v == null) return '';
            return String(v).trim();
        };
        const contentKeys = [
            'product_name',
            'sku',
            'requirement_type',
            'remark',
            'link',
            'vendor',
            'mnp',
            'pcb_code',
            'lot_no',
            'project_code',
        ];
        if (contentKeys.some((key) => pick(key))) return true;
        const qty = pick('quantity');
        if (qty && Number(qty) > 0) return true;
        const photo = pick('product_photo') || pick('existing_product_photo');
        if (photo) return true;
        return false;
    }

    /** Delete draft row after RFQ is persisted (idempotent). */
    static async deleteTempDraftByRef(tempRef) {
        const row = await RequirementController.resolveTempRequirementRow(tempRef);
        if (row?.id) {
            await R2rTempRequirementModel.deleteById(row.id);
            return true;
        }
        const deleted = await R2rTempRequirementModel.deleteByTempId(tempRef);
        return Boolean(deleted);
    }

    /** Move draft-only temp assets onto the created RFQ (does not overwrite submit payload fields). */
    static async transferTempAssetsToRequirement(createdRequirement, tempId) {
        if (!tempId || !createdRequirement?.['sr.no']) return;

        const tempRow = await RequirementController.resolveTempRequirementRow(tempId);
        if (!tempRow?.id) return;
    }
    /** After minimal RFQ create: merge all autosaved temp fields + draft assets onto the row. */
    static async transferAllTempDataToRequirement(createdRequirement, tempId, options = {}) {
        if (!tempId || !createdRequirement?.['sr.no']) return createdRequirement;

        const tempRow = await R2rTempRequirementModel.findByTempId(tempId);
        if (!tempRow?.id) return createdRequirement;


        const srNo = createdRequirement['sr.no'];
        const finalSerial = RequirementController.normalizeSerialNumber(createdRequirement.serial_number);
        const tempData =
            tempRow.data && typeof tempRow.data === 'object' && !Array.isArray(tempRow.data)
                ? tempRow.data
                : {};

        const pickTempValue = (...keys) => {
            for (const key of keys) {
                const fromCol = tempRow[key];
                if (fromCol != null && String(fromCol).trim() !== '') return fromCol;
                const fromData = tempData[key];
                if (fromData != null && String(fromData).trim() !== '') return fromData;
            }
            return null;
        };

        const updatePayload = {};
        const createdPhoto = createdRequirement.product_photo;
        if (!createdPhoto || String(createdPhoto).trim() === '') {
            const tempPhoto = pickTempValue('product_photo', 'existing_product_photo');
            if (tempPhoto) updatePayload.product_photo = tempPhoto;
        }



        const mergedDraft = normalizeRequirementBody({
            ...tempData,
            ...tempRow,
            product_photo:
                tempData.product_photo ??
                tempRow.product_photo ??
                tempData.existing_product_photo ??
                tempRow.existing_product_photo,
        });

        const allowedCols = [
            'date', 'product_name', 'quantity', 'unit', 'package', 'remark', 'product_photo',
            'link', 'project_code', 'target_receive_date', 'require_person_name',
            'order_person_name', 'review_person', 'order_status', 'receive_qty', 'vendor',
            'price_per_piece', 'order_date', 'sku', 'expected_date', 'receive_date',
            'receiver_name', 'mnp', 'requirement_type', 'status', 'order_qty', 'pcb_code', 'lot_no',
            'split', 'order_id', 'order_tracking_link', 'location', 'qtyreservation_status',
            'qtyreservation_id', 'fixed_quantity', 'note', 'addQuantityID',
        ];
        const dateCols = new Set([
            'date', 'target_receive_date', 'order_date', 'expected_date', 'receive_date',
        ]);

        for (const key of allowedCols) {
            if (mergedDraft[key] === undefined || mergedDraft[key] === null) continue;
            if (dateCols.has(key)) {
                const pgDate = convertDateToPostgres(mergedDraft[key]);
                if (pgDate) updatePayload[key] = pgDate;
            } else if (key === 'product_photo') {
                const photoVal = mergedDraft[key];
                if (photoVal != null && String(photoVal).trim() !== '') {
                    updatePayload[key] = photoVal;
                }
            } else {
                updatePayload[key] = mergedDraft[key];
            }
        }

        if (options.skipProductPhoto) {
            delete updatePayload.product_photo;
        } else if (updatePayload.product_photo) {
            try {
                updatePayload.product_photo = await RequirementController.resolveProductPhotoForDb(
                    finalSerial || String(tempId).trim() || 'draft',
                    updatePayload.product_photo,
                );
            } catch (photoErr) {
                console.error('Error storing temp product photo on requirement:', photoErr);
                delete updatePayload.product_photo;
            }
        }

        const draftSerialKeys = new Set(
            [
                RequirementController.normalizeSerialNumber(tempRow.serial_number),
                String(tempId).trim(),
                'DRAFT',
            ]

                .map((s) => (s ? String(s).trim() : ''))
                .filter(Boolean),
        );

        for (const draftKey of draftSerialKeys) {
            if (!finalSerial || draftKey === finalSerial) continue;
            await pool.query(
                `UPDATE r2r_temp_bom_images
                 SET serial_number = $1, updated_at = NOW()
                 WHERE serial_number = $2`,
                [finalSerial, draftKey],
            );
        }

        let updatedRow = createdRequirement;
        if (Object.keys(updatePayload).length > 0) {
            updatedRow = await RequirementModel.update(srNo, updatePayload);
        }

        await RequirementController.transferBomImageToRequirement(finalSerial);

        const rowAfterTransfer =
            (await RequirementModel.findById(srNo)) || updatedRow || createdRequirement;

        if (rowAfterTransfer) {
            RequirementController.broadcastRequirementLive('updated', rowAfterTransfer);
        }

        return rowAfterTransfer || updatedRow || createdRequirement;
    }


    /** Transfer draft assets then always remove TEMP row once RFQ exists in REQUIREMENT. */
    static async finalizeTempDraftAfterCreate(createdRequirement, tempId) {
        if (!tempId || !createdRequirement?.['sr.no']) return;

        const tempRow = await RequirementController.resolveTempRequirementRow(tempId);
        if (!tempRow?.id) return;

        try {
            await RequirementController.transferTempAssetsToRequirement(
                createdRequirement,
                tempId,
            );
        } catch (transferErr) {
            console.error('Error transferring temp draft assets to requirement:', transferErr);
        } finally {
            try {
                await R2rTempRequirementModel.deleteById(tempRow.id);
            } catch (deleteErr) {
                console.error('Error deleting temp requirement after RFQ create:', deleteErr);
            }
        }
    }

    static async getTempBomImages(req, res) {
        const serial_number = RequirementController.normalizeSerialNumber(req.params.serial_number);
        if (!serial_number) {
            throw new AppError('serial_number is required', 400);
        }

        const rows = await R2rTempBomImageModel.findBySerial(serial_number);
        res.json({ success: true, tempBomImages: rows });
    }

    static async createTempBomImage(req, res) {
        const { serial_number, sku, original_image, kind } = req.body;
        const normalizedSerial = RequirementController.normalizeSerialNumber(serial_number);
        if (!normalizedSerial || !sku) {
            throw new AppError('serial_number and sku are required', 400);
        }

        const storedOriginal = original_image
            ? await RequirementController.resolveProductPhotoForDb(
                normalizedSerial,
                original_image,
            )
            : null;

        const tempBomImage = await R2rTempBomImageModel.create({
            serial_number: normalizedSerial,
            sku,
            original_image: storedOriginal,
            upload_status: storedOriginal ? 'COMPLETED' : 'PENDING',
            processing_status: storedOriginal ? 'READY' : 'WAITING'
        });

        res.status(201).json({ success: true, tempBomImage });
    }

    static async updateTempBomImage(req, res) {
        const { id } = req.params;
        const { processed_image_url, upload_status, processing_status, transfer_to_requirement, kind } = req.body;
        if (!id) {
            throw new AppError('id is required', 400);
        }

        const existing = await R2rTempBomImageModel.findById(id);
        if (!existing) {
            throw new AppError('Temp BOM image record not found', 404);
        }

        let storedProcessedUrl = processed_image_url;
        if (processed_image_url) {
            storedProcessedUrl = await RequirementController.resolveProductPhotoForDb(
                existing.serial_number || 'draft',
                processed_image_url,
            );
        }

        const updated = await R2rTempBomImageModel.update(id, {
            processed_image_url: storedProcessedUrl || undefined,
            upload_status: upload_status || (storedProcessedUrl ? 'COMPLETED' : undefined),
            processing_status: processing_status || undefined
        });

        if (!updated) {
            throw new AppError('Temp BOM image record not found', 404);
        }

        if (transfer_to_requirement && updated.serial_number) {
            await RequirementController.transferBomImageToRequirement(updated.serial_number, kind || 'product');
        }

        res.json({ success: true, tempBomImage: updated });
    }

    static async transferTempBomImage(req, res) {
        const { serial_number, kind } = req.body;
        const normalizedSerial = RequirementController.normalizeSerialNumber(serial_number);
        if (!normalizedSerial) {
            throw new AppError('serial_number is required', 400);
        }

        const success = await RequirementController.transferBomImageToRequirement(normalizedSerial, kind || 'product');
        if (!success) {
            throw new AppError('No processed temp BOM image found or requirement not found', 404);
        }

        res.json({ success: true, message: 'Temp BOM image transferred to requirement' });
    }

    // TEMP REQUIREMENT (draft) endpoints
    /** Merge top-level BOM draft fields onto temp create/update payload. */
    static buildTempRequirementPayload(rawBody = {}, data = {}, storedPhoto = null, userId = null, username = null) {
        const resolvedUsername = String(
            rawBody.username ?? data.username ?? username ?? '',
        ).trim();
        const payload = {
            ...data,
            temp_id: rawBody.temp_id,
            product_photo: storedPhoto,
            user_id: rawBody.user_id ?? data.user_id ?? userId,
        };
        if (resolvedUsername) payload.username = resolvedUsername;
        if (rawBody.bom_preview !== undefined) payload.bom_preview = rawBody.bom_preview;
        else if (data.bom_preview !== undefined) payload.bom_preview = data.bom_preview;
        if (rawBody.bom_file !== undefined) payload.bom_file = rawBody.bom_file;
        if (rawBody.requirement_type !== undefined) {
            payload.requirement_type = rawBody.requirement_type;
        }
        for (const key of ['project_code', 'pcb_code', 'lot_no', 'product_name', 'link']) {
            if (rawBody[key] !== undefined) payload[key] = rawBody[key];
        }
        return payload;
    }

    static async createTempRequirement(req, res) {
        const rawBody = req.body || {};
        const data = RequirementController.sanitizeTempDraftData(
            rawBody.data && typeof rawBody.data === 'object' && !Array.isArray(rawBody.data)
                ? rawBody.data
                : {},
        );
        const productPhoto =
            data.product_photo != null && String(data.product_photo).trim() !== ''
                ? data.product_photo
                : data.existing_product_photo;
        const storedPhoto = productPhoto
            ? await RequirementController.resolveProductPhotoForDb(
                rawBody.temp_id || data.serial_number || 'draft',
                productPhoto,
            )
            : null;
        const payload = RequirementController.buildTempRequirementPayload(
            rawBody,
            data,
            storedPhoto,
            getUserIdFromReq(req),
            getUsernameFromReq(req),
        );
        const created = await R2rTempRequirementModel.create(payload);
        res.status(201).json({ success: true, tempRequirement: created });
    }

    static async updateTempRequirement(req, res) {
        let { id } = req.params;
        const rawBody = req.body || {};
        const data = RequirementController.sanitizeTempDraftData(
            rawBody.data && typeof rawBody.data === 'object' && !Array.isArray(rawBody.data)
                ? rawBody.data
                : {},
        );
        const productPhoto =
            data.product_photo != null && String(data.product_photo).trim() !== ''
                ? data.product_photo
                : data.existing_product_photo;
        const storedPhoto = productPhoto
            ? await RequirementController.resolveProductPhotoForDb(
                rawBody.temp_id || data.serial_number || id || 'draft',
                productPhoto,
            )
            : null;
        const payload = RequirementController.buildTempRequirementPayload(
            rawBody,
            data,
            storedPhoto,
            getUserIdFromReq(req),
            getUsernameFromReq(req),
        );
        if (!id) throw new AppError('id is required', 400);
        const numeric = Number(id);
        if (Number.isNaN(numeric)) {
            const found = await R2rTempRequirementModel.findByTempId(id);
            if (!found) throw new AppError('Temp requirement not found', 404);
            id = found.id;
        }
        const updated = await R2rTempRequirementModel.update(id, payload);
        if (!updated) throw new AppError('Temp requirement not found', 404);
        res.json({ success: true, tempRequirement: updated });
    }

    static async listTempRequirements(req, res) {
        const username =
            getUsernameFromReq(req) ??
            (req.query.username != null ? String(req.query.username).trim() : null);
        const userId =
            getUserIdFromReq(req) ??
            (req.query.user_id != null ? parseInt(String(req.query.user_id), 10) : null);

        const hasUsername = Boolean(username && String(username).trim());
        const hasUserId = Number.isFinite(userId);
        if (!hasUsername && !hasUserId) {
            throw new AppError(
                'username is required (header x-username or query username)',
                400,
            );
        }

        if (hasUserId) {
            await pool.query(
                `UPDATE "TEMP_REQUIREMENT" SET serial_number = NULL WHERE user_id = $1`,
                [userId],
            );
        }
        if (hasUsername) {
            await pool.query(
                `UPDATE "TEMP_REQUIREMENT" SET serial_number = NULL
                 WHERE LOWER(TRIM(username)) = LOWER(TRIM($1))`,
                [String(username).trim()],
            );
        }

        const rows = hasUsername
            ? await R2rTempRequirementModel.findByUsername(
                String(username).trim(),
                hasUserId ? userId : null,
            )
            : await R2rTempRequirementModel.findByUserId(userId);

        const meaningful = [];
        for (const row of rows) {
            if (RequirementController.isMeaningfulTempDraft(row)) {
                const data = RequirementController.sanitizeTempDraftData(
                    row.data && typeof row.data === 'object' && !Array.isArray(row.data)
                        ? row.data
                        : {},
                );
                meaningful.push({ ...row, serial_number: null, data });
            } else if (row?.id) {
                try {
                    await R2rTempRequirementModel.deleteById(row.id);
                } catch (cleanupErr) {
                    console.error('Error cleaning empty temp draft:', cleanupErr);
                }
            }
        }
        res.json({ success: true, tempRequirements: meaningful });
    }

    static async getTempRequirement(req, res) {
        const { temp_id } = req.params;
        if (!temp_id) throw new AppError('temp_id is required', 400);
        const row = await R2rTempRequirementModel.findByTempId(temp_id);

        res.json({ success: true, tempRequirement: row });
    }

    static async deleteTempRequirement(req, res) {
        let { id } = req.params;
        if (!id) throw new AppError('id is required', 400);
        const numeric = Number(id);
        if (Number.isNaN(numeric)) {
            const found = await R2rTempRequirementModel.findByTempId(id);
            if (!found) throw new AppError('Temp requirement not found', 404);
            id = found.id;
        }
        const deleted = await R2rTempRequirementModel.deleteById(id);
        if (!deleted) throw new AppError('', 404);
        res.json({ success: true, tempRequirement: deleted });
    }

    // Optimized: Parallel fetch and status updates
    static async getAllRequirements(req, res) {
        const query = req.query || {};
        const pag = RequirementModel.parsePaginationState(query);

        const mapRow = (row) => {
            const r = { ...row };
            r.serial_number = RequirementController.normalizeSerialNumber(r.serial_number);
            return formatRequirementDates(r);
        };

        const buildListPayload = (rows, total) => ({
            success: true,
            requirements: rows.map(mapRow),
            pagination: {
                total,
                page: pag.page,
                limit: pag.limit,
                offset: pag.offset,
                totalPages: pag.limit ? Math.ceil(total / pag.limit) : 0
            }
        });

        const fetchList = () =>
            Promise.all([
                RequirementModel.findAll(query),
                RequirementModel.countMatching(query)
            ]);

        const [requirements, total] = await fetchList();

        const currentDate = getCurrentDateDDMMYYYY();
        const requirementsToUpdate = [];

        for (const row of requirements) {
            const orderStatus = row.order_status ? String(row.order_status).trim() : '';
            if (row.target_receive_date && orderStatus.toLowerCase() === 'normal') {
                const targetDate = formatRequirementDates(row).target_receive_date || row.target_receive_date;
                const daysDiff = calculateDaysDifference(targetDate, currentDate);

                if (daysDiff !== null && daysDiff >= 0 && daysDiff <= 2) {
                    requirementsToUpdate.push(row['sr.no']);
                }
            }
        }

        if (requirementsToUpdate.length > 0) {
            await pool.query(
                `UPDATE "REQUIREMENT" SET order_status = 'Urgent' WHERE "sr.no" = ANY($1::int[]) AND LOWER(TRIM(order_status)) = 'normal'`,
                [requirementsToUpdate]
            );

            const [updatedRequirements, totalAfter] = await fetchList();
            return res.json(buildListPayload(updatedRequirements, totalAfter));
        }

        res.json(buildListPayload(requirements, total));
    }

    /**
     * GET /requirements/collection-desk
     * Same filters as list, but groups rows that share the same qtyreservation_id.
     * Pagination is by group (not by requirement row).
     */
    static async getCollectionDeskRequirements(req, res) {
        const query = req.query || {};
        const page = Math.max(1, parseInt(String(query.page ?? '1'), 10) || 1);
        const limitRaw = parseInt(String(query.limit ?? '20'), 10);
        const limit = Number.isFinite(limitRaw)
            ? Math.min(10000, Math.max(1, limitRaw))
            : 20;
        // When client scopes (me/department) locally, fetch all groups then paginate on the client.
        const paginateServer =
            String(query.paginate ?? 'true').trim().toLowerCase() !== 'false';

        const mapRow = (row) => {
            const r = { ...row };
            r.serial_number = RequirementController.normalizeSerialNumber(
                r.serial_number,
            );
            return formatRequirementDates(r);
        };

        const rows = (await RequirementModel.findAllMatching(query)).map(mapRow);

        // Attach qty-reservation reserved/remove fields for Collection Desk columns.
        const qrIds = [
            ...new Set(
                rows
                    .map((r) => String(r.qtyreservation_id ?? '').trim())
                    .filter((id) => id && Number.isFinite(Number(id))),
            ),
        ].map((id) => Number(id));

        if (qrIds.length > 0) {
            try {
                const qrResult = await pool.query(
                    `SELECT id, reserved_qty, reserved_username, remove_quantity, remove_username, review, "remove_qtyID"
                     FROM "QTY_RESERVATION"
                     WHERE id = ANY($1::int[])`,
                    [qrIds],
                );
                const byId = new Map(
                    (qrResult.rows || []).map((qr) => [String(qr.id), qr]),
                );
                for (const row of rows) {
                    const qr = byId.get(String(row.qtyreservation_id ?? '').trim());
                    if (!qr) continue;
                    row.reserved_qty =
                        qr.reserved_qty != null && qr.reserved_qty !== ''
                            ? Number(qr.reserved_qty)
                            : null;
                    row.reserved_username = qr.reserved_username ?? null;
                    row.remove_quantity =
                        qr.remove_quantity != null && qr.remove_quantity !== ''
                            ? Number(qr.remove_quantity)
                            : null;
                    row.remove_username = qr.remove_username ?? null;
                    row.review = qr.review ?? null;
                    row.remove_qtyID =
                        qr.remove_qtyID ??
                        qr.remove_qtyid ??
                        qr.remove_qty_id ??
                        null;
                }
            } catch (err) {
                console.error(
                    'Collection desk qty reservation field join failed:',
                    err?.message || err,
                );
            }
        }

        const groupMap = new Map();
        const groups = [];

        for (const row of rows) {
            const rawId = row.qtyreservation_id;
            const idStr =
                rawId != null && String(rawId).trim() !== ''
                    ? String(rawId).trim()
                    : '';
            const srNo = row['sr.no'] ?? row.sr_no;
            const groupKey = idStr ? `qr:${idStr}` : `solo:${srNo}`;

            let group = groupMap.get(groupKey);
            if (!group) {
                group = {
                    qtyreservation_id: idStr || null,
                    keyLabel: idStr
                        ? `QR-${idStr}`
                        : String(row.serial_number || srNo || ''),
                    requirements: [],
                };
                groupMap.set(groupKey, group);
                groups.push(group);
            }
            group.requirements.push(row);
        }

        const totalGroups = groups.length;
        const offset = (page - 1) * limit;
        const pageGroups = paginateServer
            ? groups.slice(offset, offset + limit)
            : groups;

        return res.json({
            success: true,
            groups: pageGroups,
            requirements: pageGroups.flatMap((g) => g.requirements),
            pagination: {
                total: totalGroups,
                page: paginateServer ? page : 1,
                limit: paginateServer ? limit : totalGroups || limit,
                offset: paginateServer ? offset : 0,
                totalPages: paginateServer
                    ? totalGroups === 0
                        ? 0
                        : Math.ceil(totalGroups / limit)
                    : 1,
                paginated: paginateServer,
            },
        });
    }

    // GET /requirements/stats
    static async getRequirementStats(req, res) {
        const { require_person_name, serial_number } = req.query;
        const { scopeUsernames } = await resolveStatsScopeFromQuery(req.query);
        let conditions = [];
        let values = [];
        if (serial_number) {
            values.push(serial_number);

            conditions.push(`
                    split_part("serial_number", '-', 2) = $${values.length}
                `);
        }

        const scopeSql = buildExactUserScopeSql(
            'require_person_name',
            scopeUsernames,
            values,
        );
        if (scopeSql) {
            conditions.push(scopeSql);
        } else if (require_person_name) {
            values.push(require_person_name);
            conditions.push(`LOWER(TRIM(require_person_name)) = LOWER(TRIM($${values.length}))`);
        }



        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const result = await pool.query(`
            SELECT
                COUNT(*) AS total,
                COUNT(*) FILTER (
                    WHERE LOWER(TRIM(status)) = 'issue'
                ) AS issue,
                 COUNT(*) FILTER (
                    WHERE  LOWER(TRIM(status)) = 'request review' AND LOWER(TRIM(order_status)) = 'issue' 
                ) AS request_review_issue,
                 COUNT(*) FILTER (
                    WHERE LOWER(TRIM(status)) = 'request review' AND LOWER(TRIM(order_status)) = 'urgent' 
                ) AS request_review_urgent,
                 COUNT(*) FILTER (
                    WHERE LOWER(TRIM(status)) = 'in store' AND LOWER(TRIM(order_status)) = 'urgent' 
                ) AS in_store_urgent,
                 COUNT(*) FILTER (
                    WHERE LOWER(TRIM(status)) = 'purchase' AND LOWER(TRIM(order_status)) = 'urgent' 
                ) AS purchase_urgent,
                 
            
                COUNT(*) FILTER (
                    WHERE LOWER(TRIM(status)) = 'terminate requested'
                ) AS terminate_requested,                
                COUNT(*) FILTER (
                    WHERE LOWER(TRIM(order_status)) = 'urgent'
                ) AS urgent,

                COUNT(*) FILTER (
                    WHERE LOWER(TRIM(status)) = 'request review'
                ) AS request_review,

                COUNT(*) FILTER (
                    WHERE LOWER(TRIM(status)) = 'in store'
                ) AS in_store,

                COUNT(*) FILTER (
                    WHERE LOWER(TRIM(status)) = 'purchase'
                ) AS purchase,
                
                COUNT(*) FILTER (
                    WHERE LOWER(TRIM(status)) = 'order done'
                ) AS order_done,

                COUNT(*) FILTER (
                    WHERE LOWER(TRIM(status)) = 'receive done'
                ) AS receive_done,
                COUNT(*) FILTER (
                    WHERE LOWER(TRIM(order_status)) = 'receive issue' AND LOWER(TRIM(status)) = 'receive issue'
                ) AS receive_issue,
                COUNT(*) FILTER (
                    WHERE LOWER(TRIM(order_status)) = 'received with issue' AND LOWER(TRIM(status)) = 'receive done'
                ) AS received_with_issue,
                COUNT(*) FILTER (
                    WHERE LOWER(TRIM(status)) = 'return req'
                       OR LOWER(TRIM(order_status)) = 'return req'
                ) AS return_req,
                COUNT(*) FILTER (
                    WHERE LOWER(TRIM(order_person_name)) = 'in store' AND LOWER(TRIM(status)) = 'receive done'
                ) AS received_in_store,
                COUNT(*) FILTER (
                    WHERE LOWER(TRIM(status)) = 'receive done'
                      AND LOWER(TRIM(COALESCE(order_person_name, ''))) <> 'in store'
                ) AS received_purchase,

                
                COUNT(*) FILTER (
                    WHERE LOWER(TRIM(order_status)) = 'terminated'
                       OR LOWER(TRIM(status)) = 'terminated'
                ) AS terminated,

             

                COUNT(*) FILTER (
                    WHERE LOWER(TRIM(COALESCE(qtyreservation_status, ''))) = 'pending reserve'
                ) AS pending_reserve,

                COUNT(*) FILTER (
                    WHERE LOWER(TRIM(COALESCE(qtyreservation_status, ''))) = 'reserve expired'
                ) AS reserve_expired,

                COUNT(*) FILTER (
                    WHERE LOWER(TRIM(COALESCE(qtyreservation_status, ''))) = 'qty reserved'
                ) AS qty_reserved,

                COUNT(*) FILTER (
                    WHERE LOWER(TRIM(COALESCE(qtyreservation_status, ''))) = 'tray prepared'
                ) AS tray_prepared,

                COUNT(*) FILTER (
                    WHERE LOWER(TRIM(COALESCE(qtyreservation_status, ''))) IN (
                      'in transit'
                    )
                ) AS in_transit,

                COUNT(*) FILTER (
                    WHERE LOWER(TRIM(COALESCE(qtyreservation_status, ''))) = 'completed'
                ) AS completed,

                COUNT(*) FILTER (
                    WHERE LOWER(TRIM(COALESCE(qtyreservation_status, ''))) = 'completed with issue'
                ) AS completed_with_issue,

                COUNT(*) FILTER (
                    WHERE LOWER(TRIM(COALESCE(qtyreservation_status, ''))) IN (
                      'canceled',
                      'cancelled'
                    )
                ) AS canceled,

                COUNT(*) FILTER (
                    WHERE qtyreservation_status IS NOT NULL
                      AND TRIM(COALESCE(qtyreservation_status, '')) <> ''
                ) AS qty_reservation_present
            FROM "REQUIREMENT"
            ${whereClause}
        `, values);

        const stats = result.rows[0];

        res.json({
            success: true,
            stats: {
                total: Number(stats.total || 0),
                urgent: Number(stats.urgent || 0),
                terminateRequested: Number(stats.terminate_requested || 0),
                requestReview: Number(stats.request_review || 0),
                inStore: Number(stats.in_store || 0),
                purchase: Number(stats.purchase || 0),
                receiveDone: Number(stats.receive_done || 0),
                orderDone: Number(stats.order_done || 0),
                issue: Number(stats.issue || 0),
                terminated: Number(stats.terminated || 0),
                requestReviewIssue: Number(stats.request_review_issue || 0),
                requestReviewUrgent: Number(stats.request_review_urgent || 0),
                inStoreUrgent: Number(stats.in_store_urgent || 0),
                purchaseUrgent: Number(stats.purchase_urgent || 0),
                receiveIssue: Number(stats.receive_issue || 0),
                receivedWithIssue: Number(stats.received_with_issue || 0),
                returnReq: Number(stats.return_req || 0),
                receivedInStore: Number(stats.received_in_store || 0),
                receivedPurchase: Number(stats.received_purchase || 0),
                pendingReserve: Number(stats.pending_reserve || 0),
                reserveExpired: Number(stats.reserve_expired || 0),
                qtyReserved: Number(stats.qty_reserved || 0),
                trayPrepared: Number(stats.tray_prepared || 0),
                inTransit: Number(stats.in_transit || 0),
                
                completed: Number(stats.completed || 0),
                completedWithIssue: Number(stats.completed_with_issue || 0),
                canceled: Number(stats.canceled || 0),
                qtyReservationPresent: Number(stats.qty_reservation_present || 0),
            }
        });
    }
    // Optimized: Parallel fetch requirement and issue status
    static async getRequirementById(req, res) {
        const { id } = req.params;

        // Parallel: Fetch requirement and issue status
        const [requirement, issueResult] = await Promise.all([
            RequirementModel.findById(id),
            pool.query(
                'SELECT "issue_order_status" FROM "ISSUE" WHERE "requirement_id" = $1 ORDER BY "created_at" DESC LIMIT 1',
                [id]
            )
        ]);

        if (!requirement) {
            throw new AppError('Requirement not found', 404);
        }

        if (issueResult.rows.length > 0) {
            requirement.issue_order_status = issueResult.rows[0].issue_order_status;
        }

        const currentDate = getCurrentDateDDMMYYYY();
        const orderStatus = requirement.order_status ? String(requirement.order_status).trim() : '';

        // Check and update order_status if needed
        if (requirement.target_receive_date && orderStatus.toLowerCase() === 'normal') {
            const targetDate = formatRequirementDates(requirement).target_receive_date || requirement.target_receive_date;
            const daysDiff = calculateDaysDifference(targetDate, currentDate);

            if (daysDiff !== null && daysDiff >= 0 && daysDiff <= 2) {
                await pool.query(
                    `UPDATE "REQUIREMENT" SET order_status = 'Urgent' WHERE "sr.no" = $1`,
                    [id]
                );
                requirement.order_status = 'Urgent';
            }
        }

        res.json({
            success: true,
            requirement: formatRequirementDates({
                ...requirement,
                serial_number: RequirementController.normalizeSerialNumber(requirement.serial_number)
            })
        });
    }

    // Optimized: Parallel validation checks and sequence fix
    static async createRequirement(req, res) {
        const rawBody = req.body;
        const body =
            rawBody != null && typeof rawBody === 'object' && !Array.isArray(rawBody)
                ? rawBody
                : null;
        if (!body) {
            throw new AppError(
                'Request body is missing or not JSON. Send a JSON object with header Content-Type: application/json.',
                400,
            );
        }

        const normalizedBody = normalizeRequirementBody(body);
        const bomDirect = Boolean(
            rawBody?.bom_direct === true ||
            rawBody?.bom_direct === 'true' ||
            rawBody?.bom_direct === 1,
        );

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Fix sequence within transaction
            await fixRequirementSequenceInTransaction(client);

            const {
                date, product_name, quantity, unit, package: packageName, remark,
                product_photo, link, project_code, target_receive_date,
                require_person_name, order_person_name, review_person, order_status,
                receive_qty, vendor, price_per_piece, order_date,
                sku, expected_date, receive_date, receiver_name,
                mnp, requirement_type, serial_number, status, order_qty,
                pcb_code, lot_no, split, order_id, order_tracking_link,
                location, qtyreservation_status, qtyreservation_id, fixed_quantity,
                requirement_priority, addQuantityID,
                issue_note, issue_reported_by, has_issue
            } = normalizedBody;

            // Validation
            if (!product_name || !product_name.trim()) {
                await client.query('ROLLBACK');
                await client.query('SELECT pg_advisory_unlock(12345)');
                throw new AppError('Product name is required and cannot be empty', 400);
            }

            if (!quantity || quantity <= 0) {
                await client.query('ROLLBACK');
                await client.query('SELECT pg_advisory_unlock(12345)');
                throw new AppError('Quantity is required and must be greater than 0', 400);
            }

            // Determine initial order_status
            let finalOrderStatus = RequirementController.resolveOrderStatusFromWorkflowStatus(
                status,
                order_status,
                order_status || 'Pending',
            );

            // Check if order_status should be 'Urgent' based on target_receive_date
            const convertedTargetDate = convertDateToPostgres(target_receive_date);
            if (convertedTargetDate && finalOrderStatus === 'Normal') {
                const currentDate = getCurrentDateDDMMYYYY();
                const daysDiff = calculateDaysDifference(convertedTargetDate, currentDate);
                if (daysDiff !== null && daysDiff >= 0 && daysDiff <= 2) {
                    finalOrderStatus = 'Urgent';
                }
            }

            const normalizedSerial =
                RequirementController.normalizeSerialNumber(serial_number);
            let storedProductPhoto = null;
            if (product_photo) {
                try {
                    storedProductPhoto = await RequirementController.resolveProductPhotoForDb(
                        normalizedSerial || 'draft',
                        product_photo,
                    );
                } catch (photoErr) {
                    await client.query('ROLLBACK');
                    await client.query('SELECT pg_advisory_unlock(12345)');
                    throw new AppError(photoErr.message || 'Invalid product photo', 400);
                }
            }

            const insertQuery = `INSERT INTO "REQUIREMENT" (
                date, product_name, quantity, unit, package, remark,
                product_photo, link, project_code, target_receive_date,
                require_person_name, order_person_name, review_person, order_status,
                receive_qty, vendor, price_per_piece, order_date,
                sku, expected_date, receive_date, receiver_name,
                mnp, requirement_type, serial_number, status, order_qty, pcb_code, lot_no,
                split, order_id, order_tracking_link, location, qtyreservation_status,
                qtyreservation_id, fixed_quantity, requirement_priority, "addQuantityID", created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, NOW()) 
            RETURNING *`;

            const insertValues = [
                convertDateToPostgres(date), product_name, quantity, unit || null, packageName || null, remark || null,
                storedProductPhoto, link || null, project_code || null, convertedTargetDate,
                require_person_name || null, order_person_name || null, review_person || null, finalOrderStatus,
                receive_qty || null, vendor || null, price_per_piece || null, convertDateToPostgres(order_date),
                sku || null, convertDateToPostgres(expected_date), convertDateToPostgres(receive_date), receiver_name || null,
                mnp || null, requirement_type || null, normalizedSerial || null, status, order_qty || null,

                pcb_code != null && String(pcb_code).trim() !== '' ? String(pcb_code).trim() : null,
                lot_no != null && String(lot_no).trim() !== '' ? String(lot_no).trim() : null,
                split != null && String(split).trim() !== '' ? String(split).trim() : null,
                order_id != null && String(order_id).trim() !== '' ? String(order_id).trim() : null,
                order_tracking_link != null && String(order_tracking_link).trim() !== '' ? String(order_tracking_link).trim() : null,
                location != null && String(location).trim() !== '' ? String(location).trim() : null,
                qtyreservation_status != null && String(qtyreservation_status).trim() !== '' ? String(qtyreservation_status).trim() : null,
                qtyreservation_id != null && String(qtyreservation_id).trim() !== '' ? Number(qtyreservation_id) : null,
                fixed_quantity != null && String(fixed_quantity).trim() !== '' ? Number(fixed_quantity) : null,
                requirement_priority != null && String(requirement_priority).trim() !== ''
                    ? String(requirement_priority).trim()
                    : 'Any',
                addQuantityID != null && String(addQuantityID).trim() !== ''
                    ? String(addQuantityID).trim()
                    : null,
            ];

            const result = await client.query(insertQuery, insertValues);

            const createdRow = result.rows[0];
            const newStatus =
                String(createdRow?.status ?? status ?? 'Request Review').trim() ||
                'Request Review';
            await recordRequirementStatusChange(
                {
                    serial_number:
                        RequirementController.normalizeSerialNumber(
                            createdRow?.serial_number || normalizedSerial,
                        ) || normalizedSerial,
                    old_status: 'New',
                    new_status: newStatus,
                    username: getUsernameFromReq(req),
                },
                client,
            );

            await client.query('COMMIT');
            await client.query('SELECT pg_advisory_unlock(12345)');

            const createdRequirement = formatRequirementDates(createdRow);
            createdRequirement.serial_number = RequirementController.normalizeSerialNumber(createdRequirement.serial_number);


            // RFQ is in REQUIREMENT; transfer draft assets then remove TEMP_REQUIREMENT row.

            // Step 2: merge TEMP_REQUIREMENT into the new RFQ before response (step 3: client photo upload).
            let responseRequirement = createdRequirement;

            const tempId = rawBody && rawBody.temp_id;
            const clientWillUploadPhoto = Boolean(rawBody.client_will_upload_photo);
            if (tempId) {

                await RequirementController.finalizeTempDraftAfterCreate(
                    createdRequirement,
                    tempId,
                );

                try {
                    const transferred = await RequirementController.transferAllTempDataToRequirement(
                        createdRequirement,
                        tempId,
                        { skipProductPhoto: clientWillUploadPhoto },
                    );
                    if (transferred) responseRequirement = transferred;
                } catch (transferErr) {
                    console.error('Error transferring temp draft data to requirement:', transferErr);
                }

            } else if (!bomDirect) {
                try {
                    await RequirementController.transferBomImageToRequirement(createdRequirement.serial_number);
                } catch (syncError) {
                    console.error('Error syncing temp BOM image after requirement create:', syncError);
                }
            }

            // Notify and broadcast (non-blocking)
            try {
                RequirementController.broadcastRequirementLive('created', createdRequirement);

                if (!bomDirect) {
                    Promise.resolve().then(async () => {
                        try {
                            await notifyRequirementStatusChange(
                                createdRequirement,
                                '',
                                createdRequirement.status || 'Request Review',
                                { title: 'New Requirement' },
                            );
                        } catch (notifyError) {
                            console.error('Error sending requirement notifications:', notifyError);
                        }
                    });
                }

                // Original  notification logic
                if (require_person_name) {
                    Promise.resolve().then(async () => {
                        try {
                            const requirePersonResult = await pool.query(
                                `SELECT ed.reporting_manager
                                 FROM personal_details pd
                                 JOIN employment_details ed ON ed.personal_details_id = pd.id
                                 WHERE LOWER(TRIM(pd.username)) = LOWER(TRIM($1))
                                 LIMIT 1`,
                                [require_person_name]
                            );
                            const reportingManager = requirePersonResult.rows[0]?.reporting_manager;
                            if (reportingManager) {
                                console.log(`[Requirement] Head notification for ${reportingManager}`);
                            }
                        } catch (headNotifyError) {
                            console.error('Error notifying:', headNotifyError);
                        }
                    });
                }
            } catch (err) {
                console.error('Error during broadcast/notification:', err);
            }

            res.status(201).json({
                success: true,
                message: 'Requirement created successfully',
                requirement: responseRequirement,
            });
        } catch (error) {
            try {
                await client.query('ROLLBACK');
                await client.query('SELECT pg_advisory_unlock(12345)');
            } catch (rollbackError) {
                console.error('Error during rollback:', rollbackError);
            }

            if (error instanceof AppError) throw error;

            if (error.code === '23505' && error.constraint === 'REQUIREMENT_pkey') {
                throw new AppError(
                    'Duplicate primary key error - sequence conflict. Please retry this requirement.',
                    409,
                    { error_code: 'DUPLICATE_PKEY', retryable: true },
                );
            }

            if (error.code === '23505' && (error.constraint === 'requirement_serial_number_unique' || error.constraint === 'idx_requirement_serial_number_unique')) {
                throw new AppError('This serial number already exists', 409);
            }

            throw error;
        } finally {
            client.release();
        }
    }

    static async createBulkRequirements(req, res) {
        const requirementsArray = req.body;
        if (!Array.isArray(requirementsArray)) {
            throw new AppError('Request body must be an array of requirements', 400);
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Fix sequence once for the whole batch
            await fixRequirementSequenceInTransaction(client);

            const createdRequirements = [];

            for (const body of requirementsArray) {
                const normalizedBody = normalizeRequirementBody(body);
                const {
                    date, product_name, quantity, unit, package: packageName, remark,
                    product_photo, link, project_code, target_receive_date,
                    require_person_name, order_person_name, review_person, order_status,
                    receive_qty, vendor, price_per_piece, order_date,
                    sku, expected_date, receive_date, receiver_name,
                    mnp, requirement_type, serial_number, status, order_qty,
                    pcb_code, lot_no, split, order_id, order_tracking_link,
                    location, qtyreservation_status, qtyreservation_id, fixed_quantity,
                    requirement_priority, addQuantityID
                } = normalizedBody;

                if (!product_name || !product_name.trim()) {
                    throw new Error('Product name is required and cannot be empty');
                }

                if (!quantity || quantity <= 0) {
                    throw new Error('Quantity is required and must be greater than 0');
                }

                let finalOrderStatus = RequirementController.resolveOrderStatusFromWorkflowStatus(
                    status,
                    order_status,
                    order_status || 'Pending',
                );

                const convertedTargetDate = convertDateToPostgres(target_receive_date);
                if (convertedTargetDate && finalOrderStatus === 'Normal') {
                    const currentDate = getCurrentDateDDMMYYYY();
                    const daysDiff = calculateDaysDifference(convertedTargetDate, currentDate);
                    if (daysDiff !== null && daysDiff >= 0 && daysDiff <= 2) {
                        finalOrderStatus = 'Urgent';
                    }
                }

                const normalizedSerial = RequirementController.normalizeSerialNumber(serial_number);
                let storedProductPhoto = null;
                if (product_photo) {
                    storedProductPhoto = await RequirementController.resolveProductPhotoForDb(
                        normalizedSerial,
                        product_photo,
                    );
                }

                const insertQuery = `INSERT INTO "REQUIREMENT" (
                    date, product_name, quantity, unit, package, remark,
                    product_photo, link, project_code, target_receive_date,
                    require_person_name, order_person_name, review_person, order_status,
                    receive_qty, vendor, price_per_piece, order_date,
                    sku, expected_date, receive_date, receiver_name,
                    mnp, requirement_type, serial_number, status, order_qty, pcb_code, lot_no,
                    split, order_id, order_tracking_link, location, qtyreservation_status,
                    qtyreservation_id, fixed_quantity, requirement_priority, "addQuantityID", created_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, NOW()) 
                RETURNING *`;

                const insertValues = [
                    convertDateToPostgres(date), product_name, quantity, unit || null, packageName || null, remark || null,
                    storedProductPhoto, link || null, project_code || null, convertedTargetDate,
                    require_person_name || null, order_person_name || null, review_person || null, finalOrderStatus,
                    receive_qty || null, vendor || null, price_per_piece || null, convertDateToPostgres(order_date),
                    sku || null, convertDateToPostgres(expected_date), convertDateToPostgres(receive_date), receiver_name || null,
                    mnp || null, requirement_type || null, normalizedSerial || null, status, order_qty || null,
                    pcb_code != null && String(pcb_code).trim() !== '' ? String(pcb_code).trim() : null,
                    lot_no != null && String(lot_no).trim() !== '' ? String(lot_no).trim() : null,
                    split != null && String(split).trim() !== '' ? String(split).trim() : null,
                    order_id != null && String(order_id).trim() !== '' ? String(order_id).trim() : null,
                    order_tracking_link != null && String(order_tracking_link).trim() !== '' ? String(order_tracking_link).trim() : null,
                    location != null && String(location).trim() !== '' ? String(location).trim() : null,
                    qtyreservation_status != null && String(qtyreservation_status).trim() !== '' ? String(qtyreservation_status).trim() : null,
                    qtyreservation_id != null && String(qtyreservation_id).trim() !== '' ? Number(qtyreservation_id) : null,
                    fixed_quantity != null && String(fixed_quantity).trim() !== '' ? Number(fixed_quantity) : null,
                    requirement_priority != null && String(requirement_priority).trim() !== ''
                        ? String(requirement_priority).trim()
                        : 'Any',
                    addQuantityID != null && String(addQuantityID).trim() !== ''
                        ? String(addQuantityID).trim()
                        : null,
                ];

                const result = await client.query(insertQuery, insertValues);
                const createdRequirement = formatRequirementDates(result.rows[0]);
                createdRequirement.serial_number = RequirementController.normalizeSerialNumber(createdRequirement.serial_number);

                const newStatus =
                    String(createdRequirement.status ?? status ?? 'Request Review').trim() ||
                    'Request Review';
                await recordRequirementStatusChange(
                    {
                        serial_number: createdRequirement.serial_number,
                        old_status: 'New',
                        new_status: newStatus,
                        username: getUsernameFromReq(req),
                    },
                    client,
                );

                createdRequirements.push(createdRequirement);
            }

            await client.query('COMMIT');
            await client.query('SELECT pg_advisory_unlock(12345)');

            for (const req of createdRequirements) {
                RequirementController.broadcastRequirementLive('created', req);
            }

            res.status(201).json({
                success: true,
                message: 'Requirements created successfully',
                requirements: createdRequirements,
            });

        } catch (error) {
            try {
                await client.query('ROLLBACK');
                await client.query('SELECT pg_advisory_unlock(12345)');
            } catch (rollbackError) {
                console.error('Error during rollback:', rollbackError);
            }
            throw error;
        } finally {
            client.release();
        }
    }

    /** One combined desktop popup after BOM batch create → Request Review. */
    static async notifyBomBatchCreated(req, res) {
        const { ids } = req.body || {};
        if (!Array.isArray(ids) || ids.length === 0) {
            throw new AppError('ids array is required', 400);
        }

        const rows = [];
        for (const rawId of ids) {
            const id = String(rawId ?? '').trim();
            if (!id) continue;
            const row = await RequirementModel.findById(id);
            if (!row) continue;
            const formatted = formatRequirementDates(row);
            formatted.serial_number =
                RequirementController.normalizeSerialNumber(
                    formatted.serial_number,
                );
            rows.push(formatted);
        }

        if (rows.length > 0) {
            await notifyBomBatchCreated(rows);
        }

        return res.json({
            success: true,
            notified_count: rows.length,
        });
    }

    /** One combined desktop popup after bulk receive → Receive Done / Receive Issue. */
    static async notifyBulkReceiveDone(req, res) {
        const { ids } = req.body || {};
        if (!Array.isArray(ids) || ids.length === 0) {
            throw new AppError('ids array is required', 400);
        }

        const rows = [];
        for (const rawId of ids) {
            const id = String(rawId ?? '').trim();
            if (!id) continue;
            const row = await RequirementModel.findById(id);
            if (!row) continue;
            const formatted = formatRequirementDates(row);
            formatted.serial_number =
                RequirementController.normalizeSerialNumber(
                    formatted.serial_number,
                );
            rows.push(formatted);
        }

        if (rows.length > 0) {
            await notifyBulkReceiveDone(rows);
        }

        return res.json({
            success: true,
            notified_count: rows.length,
        });
    }

    /** One combined desktop popup after bulk In Store → Purchase move. */
    static async notifyBulkPurchaseMoved(req, res) {
        const { ids } = req.body || {};
        if (!Array.isArray(ids) || ids.length === 0) {
            throw new AppError('ids array is required', 400);
        }

        const rows = [];
        for (const rawId of ids) {
            const id = String(rawId ?? '').trim();
            if (!id) continue;
            const row = await RequirementModel.findById(id);
            if (!row) continue;
            const formatted = formatRequirementDates(row);
            formatted.serial_number =
                RequirementController.normalizeSerialNumber(
                    formatted.serial_number,
                );
            rows.push(formatted);
        }

        if (rows.length > 0) {
            await notifyBulkRequirementStatusChange(rows, 'Purchase');
        }

        return res.json({
            success: true,
            notified_count: rows.length,
        });
    }

    /** Combined desktop popup after bulk verify → In Store. */
    static async notifyInStoreCheckBulkVerified(verifiedRows) {
        try {
            await notifyBulkRequirementStatusChange(verifiedRows, 'In Store');
        } catch (notifyError) {
            console.error('Error sending bulk in-store-check notifications:', notifyError);
        }
    }

    /** Verify many Request Review rows → In Store; one combined notification. */
    static async bulkVerifyRequirements(req, res) {
        const { ids, review_person } = req.body || {};
        if (!Array.isArray(ids) || ids.length === 0) {
            throw new AppError('ids array is required', 400);
        }

        const reviewPerson = String(review_person ?? '').trim();
        if (!reviewPerson) {
            throw new AppError('review_person is required', 400);
        }

        const verified = [];
        const failed = [];

        for (const rawId of ids) {
            const id = String(rawId ?? '').trim();
            if (!id) continue;

            try {
                const currentResult = await pool.query(
                    'SELECT * FROM "REQUIREMENT" WHERE "sr.no" = $1',
                    [id],
                );
                if (currentResult.rows.length === 0) {
                    failed.push({ id, message: 'Not found' });
                    continue;
                }

                const prevStatus = String(currentResult.rows[0].status ?? '')
                    .trim()
                    .toLowerCase();
                if (prevStatus !== 'request review') {
                    failed.push({
                        id,
                        message: 'Not in Request Review status',
                    });
                    continue;
                }

                const result = await pool.query(
                    `UPDATE "REQUIREMENT"
                         SET status = $1, review_person = $2, updated_at = NOW()
                         WHERE "sr.no" = $3
                         RETURNING *`,
                    ['In Store', reviewPerson, id],
                );

                const row = formatRequirementDates(result.rows[0]);
                row.serial_number =
                    RequirementController.normalizeSerialNumber(
                        row.serial_number,
                    );

                await recordRequirementStatusChange({
                    serial_number: row.serial_number,
                    old_status: currentResult.rows[0].status,
                    new_status: row.status,
                    username: getUsernameFromReq(req),
                });

                try {
                    await logRequirementFieldChanges({
                        requirement_id: parseInt(id, 10),
                        serial_number: row.serial_number,
                        edited_by: getUsernameFromReq(req),
                        action: 'UPDATE',
                        before: currentResult.rows[0],
                        after: result.rows[0],
                        fields: ['status', 'review_person'],
                    });
                } catch (logErr) {
                    console.error(
                        'REQUIREMENT_EDIT_LOG write failed (bulk verify):',
                        logErr.message || logErr,
                    );
                }

                verified.push(row);
                RequirementController.broadcastRequirementLive('updated', row);
            } catch (rowErr) {
                failed.push({
                    id,
                    message:
                        process.env.NODE_ENV === 'development'
                            ? rowErr.message
                            : 'Update failed',
                });
            }
        }

        if (verified.length > 0) {
            void RequirementController.notifyInStoreCheckBulkVerified(
                verified,
            );
        }

        return res.json({
            success: verified.length > 0 || failed.length === 0,
            message:
                verified.length > 1
                    ? `${verified.length} requirements verified — moved to In Store`
                    : verified.length === 1
                        ? 'Requirement verified — moved to In Store'
                        : 'No requirements were verified',
            verified_count: verified.length,
            failed_count: failed.length,
            requirements: verified,
            failed,
        });
    }

    // Optimized: Parallel existence check and issue status fetch
    static async updateRequirement(req, res) {
        const { id } = req.params;
        const userId = getUserIdFromReq(req);
        const beforeRow = await RequirementModel.findById(id);
        if (!beforeRow) {
            throw new AppError('Requirement not found', 404);
        }
            const {
                date, product_name, quantity, unit, package: packageName, remark,
                product_photo, link, project_code, target_receive_date,
                require_person_name, order_person_name, review_person, order_status,
                receive_qty, vendor, price_per_piece, order_date,
                sku, expected_date, receive_date, receiver_name,
                mnp, requirement_type, serial_number, status, order_qty,
                pcb_code, lot_no, split, order_id, order_tracking_link,
                location, qtyreservation_status, qtyreservation_id, fixed_quantity,
                issue_note, issue_reported_by, has_issue, bill_or_product_photo, note,
                requirement_priority, addQuantityID
            } = req.body || {};

            // Parallel: Get current requirement
            // Add timeout handling for connection issues
            let currentResult;
            try {
                [currentResult] = await Promise.all([
                    pool.query('SELECT target_receive_date, order_status, status FROM "REQUIREMENT" WHERE "sr.no" = $1', [id])
                ]);
            } catch (dbError) {
                console.error('Database connection error in updateRequirement:', dbError.message);
                // Check if it's a timeout or connection error
                if (dbError.message.includes('timeout') || dbError.message.includes('Connection terminated') || dbError.message.includes('Connection terminated unexpectedly')) {
                    throw new AppError(
                        'Database connection timeout. Please try again in a moment.',
                        503,
                        { error: 'CONNECTION_TIMEOUT' },
                    );
                }
                // Re-throw other errors
                throw dbError;
            }

            if (currentResult.rows.length === 0) {
                throw new AppError('Requirement not found', 404);
            }

            const currentReq = currentResult.rows[0];
            let finalOrderStatus = RequirementController.resolveOrderStatusFromWorkflowStatus(
                status,
                order_status,
                order_status !== undefined ? order_status : currentReq.order_status,
            );

            // Restore original order_status if status changed from "Issue"
            if (status !== undefined &&
                (status === 'Request Review' || status === 'In Store') &&
                (currentReq.order_status === 'Issue' || currentReq.status === 'Request Review')) {
                try {
                    const issuesResult = await pool.query(
                        `SELECT "issue_order_status" FROM "ISSUE"
                         WHERE "requirement_id" = $1
                         ORDER BY "created_at" DESC LIMIT 1`,
                        [id]
                    );

                    if (issuesResult.rows.length > 0 && issuesResult.rows[0].issue_order_status) {
                        if (order_status === undefined) {
                            finalOrderStatus = issuesResult.rows[0].issue_order_status;
                        }
                    }
                } catch (orderStatusError) {
                    console.error('Error fetching issue_order_status:', orderStatusError);
                }
            }

            // Check if order_status should be 'Urgent'
            const shouldCheckOrderStatus =
                target_receive_date !== undefined ||
                (status !== undefined && (status === 'Request Review' || status === 'In Store' || status === 'Purchase'));

            if (shouldCheckOrderStatus) {
                const targetDateToCheck = target_receive_date !== undefined
                    ? convertDateToPostgres(target_receive_date)
                    : currentReq.target_receive_date;

                if (finalOrderStatus === 'Normal' && targetDateToCheck) {
                    const currentDate = getCurrentDateDDMMYYYY();
                    const daysDiff = calculateDaysDifference(targetDateToCheck, currentDate);
                    if (daysDiff !== null && daysDiff >= 0 && daysDiff <= 2) {
                        finalOrderStatus = 'Urgent';
                    }
                }
            }

            // Build update query dynamically
            const updates = [];
            const values = [];
            let paramCount = 1;

            const addUpdate = (field, value, transform = null) => {
                if (value !== undefined) {
                    updates.push(`"${field}" = $${paramCount++}`);
                    values.push(transform ? transform(value) : value);
                }
            };

            addUpdate('date', date, convertDateToPostgres);
            addUpdate('product_name', product_name);
            addUpdate('quantity', quantity);
            addUpdate('unit', unit);
            addUpdate('package', packageName);
            addUpdate('remark', remark);
            addUpdate('note', note);
            if (product_photo !== undefined) {
                const serialForPhoto = RequirementController.normalizeSerialNumber(
                    serial_number || beforeRow.serial_number,
                );
                try {
                    const storedPhoto = await RequirementController.resolveProductPhotoForDb(
                        serialForPhoto,
                        product_photo,
                    );
                    addUpdate('product_photo', storedPhoto);
                } catch (photoErr) {
                    throw new AppError(photoErr.message || 'Invalid product photo', 400);
                }
            }
            addUpdate('link', link);
            addUpdate('project_code', project_code);
            addUpdate('target_receive_date', target_receive_date, convertDateToPostgres);
            addUpdate('require_person_name', require_person_name);
            addUpdate('order_person_name', order_person_name);
            addUpdate('review_person', review_person);
            if (order_status !== undefined || (shouldCheckOrderStatus && finalOrderStatus !== currentReq.order_status)) {
                updates.push(`order_status = $${paramCount++}`);
                values.push(finalOrderStatus);
            }
            addUpdate('receive_qty', receive_qty);
            addUpdate('vendor', vendor);
            addUpdate('price_per_piece', price_per_piece);
            addUpdate('order_date', order_date, convertDateToPostgres);
            addUpdate('sku', sku);
            addUpdate('expected_date', expected_date, convertDateToPostgres);
            addUpdate('receive_date', receive_date, convertDateToPostgres);
            addUpdate('receiver_name', receiver_name);
            addUpdate('mnp', mnp);
            addUpdate('requirement_type', requirement_type);
            addUpdate('serial_number', serial_number);
            addUpdate('status', status);
            addUpdate('order_qty', order_qty);
            addUpdate('pcb_code', pcb_code);
            addUpdate('lot_no', lot_no);
            addUpdate('split', split);
            addUpdate('order_id', order_id);
            addUpdate('order_tracking_link', order_tracking_link);
            addUpdate('location', location);
            {
              let nextQtyResStatus = qtyreservation_status;
              if (
                nextQtyResStatus != null &&
                String(nextQtyResStatus).trim().toLowerCase() === 'pending reserve'
              ) {
                nextQtyResStatus = 'Pending Reserve';
              }
              addUpdate('qtyreservation_status', nextQtyResStatus);
            }
            addUpdate('qtyreservation_id', qtyreservation_id);
            addUpdate('fixed_quantity', fixed_quantity);
            addUpdate('addQuantityID', addQuantityID);
            addUpdate('requirement_priority', requirement_priority);
            if (bill_or_product_photo !== undefined) {
                const serialForBill = RequirementController.normalizeSerialNumber(
                    serial_number || beforeRow.serial_number,
                );
                try {
                    const storedBill = await RequirementController.resolveProductPhotoForDb(
                        serialForBill,
                        bill_or_product_photo,
                        { suffix: '_bill' },
                    );
                    addUpdate('bill_or_product_photo', storedBill);
                } catch (photoErr) {
                    throw new AppError(photoErr.message || 'Invalid bill photo', 400);
                }
            }



            if (updates.length === 0) {
                throw new AppError('No fields to update', 400);
            }

            values.push(id);
            const query = `UPDATE "REQUIREMENT" SET ${updates.join(', ')}, updated_at = NOW() WHERE "sr.no" = $${paramCount} RETURNING *`;

            let result;
            try {
                result = await pool.query(query, values);
            } catch (updateError) {
                console.error('Database error during requirement update:', updateError.message);
                if (updateError.code === '54000') {
                    throw new AppError(
                        'Could not save: bill/product photo data is too large for the database index. ' +
                        'Ask an admin to run: node src/scripts/apply_drop_bill_photo_index.js (then retry), ' +
                        'or upload a smaller image / use a photo URL instead.',
                        500,
                        { error_code: 'INDEX_ROW_TOO_LARGE' },
                    );
                }
                // Check if it's a timeout or connection error
                if (updateError.message.includes('timeout') || updateError.message.includes('Connection terminated') || updateError.message.includes('Connection terminated unexpectedly')) {
                    throw new AppError(
                        'Database connection timeout during update. Please try again in a moment.',
                        503,
                        { error: 'CONNECTION_TIMEOUT' },
                    );
                }
                // Re-throw other errors
                throw updateError;
            }

            if (result.rows.length === 0) {
                throw new AppError('Requirement not found', 404);
            }

            const updatedRequirement = formatRequirementDates(result.rows[0]);
            updatedRequirement.serial_number = RequirementController.normalizeSerialNumber(updatedRequirement.serial_number);

            const wasReceiveIssue = isReceiveIssueRow(beforeRow);
            const isReceiveIssueNow = isReceiveIssueRow(updatedRequirement);

            if (isReceiveIssueNow && !wasReceiveIssue) {
                Promise.resolve().then(async () => {
                    try {
                        await notifyReceiveIssueToRequirePerson(
                            updatedRequirement,
                            getUsernameFromReq(req),
                        );
                    } catch (notifyErr) {
                        console.error(
                            'Error sending receive-issue notification:',
                            notifyErr,
                        );
                    }
                });
            } else if (wasReceiveIssue && !isReceiveIssueNow) {
                Promise.resolve().then(async () => {
                    try {
                        await clearReceiveIssueNotifications(
                            id,
                            beforeRow.require_person_name,
                        );
                        if (
                            isReceiveIssueResponseOrderStatus(
                                updatedRequirement.order_status,
                            )
                        ) {
                            await notifyReceiveIssueResponseToReceiveItemsUsers(
                                updatedRequirement,
                                updatedRequirement.order_status,
                                getUsernameFromReq(req),
                            );
                        }
                    } catch (notifyErr) {
                        console.error(
                            'Error clearing receive-issue notification:',
                            notifyErr,
                        );
                    }
                });
            }

            if (receive_qty !== undefined || quantity !== undefined) {
              try {
                const qtyReservationId =
                  updatedRequirement.qtyreservation_id ??
                  beforeRow.qtyreservation_id;
                let syncedReservation = null;

                if (receive_qty !== undefined) {
                  syncedReservation =
                    await QtyReservationModel.syncReceiveQtyFromRequirement({
                      requirementId: id,
                      receiveQty: updatedRequirement.receive_qty,
                      qtyReservationId,
                    });
                }

                if (quantity !== undefined) {
                  syncedReservation =
                    (await QtyReservationModel.syncReqQtyFromRequirement({
                      requirementId: id,
                      quantity: updatedRequirement.quantity,
                      qtyReservationId,
                    })) ?? syncedReservation;
                }

                if (syncedReservation) {
                  broadcast('qty-reservation-update', 'updated', syncedReservation);
                }
              } catch (syncErr) {
                console.error(
                  'Qty reservation qty sync failed:',
                  syncErr,
                );
              }
            }

            const prevStatus = currentReq.status;
            const nextStatus = updatedRequirement.status;
            const bothReceiveIssue =
                String(nextStatus ?? '').trim().toLowerCase() === 'receive issue' &&
                String(updatedRequirement.order_status ?? '').trim().toLowerCase() ===
                    'receive issue';
            if (bothReceiveIssue) {
                await ensureReceiveIssueStatusHistory(
                    updatedRequirement,
                    getUsernameFromReq(req),
                );
            } else if (nextStatus && prevStatus !== nextStatus) {
                await recordRequirementStatusChange({
                    serial_number: updatedRequirement.serial_number,
                    old_status: prevStatus,
                    new_status: nextStatus,
                    username: getUsernameFromReq(req),
                });
            }

            // After Receive Done (and later), also track qtyreservation_status
            // on the same REQUIREMENT_STATUS timeline (Pending Reserve → …).
            const prevQtyRes = String(
                currentReq.qtyreservation_status ?? '',
            ).trim();
            const nextQtyRes = String(
                updatedRequirement.qtyreservation_status ?? '',
            ).trim();
            if (
                nextQtyRes &&
                prevQtyRes.toLowerCase() !== nextQtyRes.toLowerCase()
            ) {
                await recordQtyReservationStatusChange({
                    serial_number: updatedRequirement.serial_number,
                    old_qtyreservation_status: prevQtyRes || null,
                    new_qtyreservation_status: nextQtyRes,
                    fallback_old_status: nextStatus || prevStatus || null,
                });
            }

            // Broadcast WebSocket update (non-blocking)
            try {
                RequirementController.broadcastRequirementLive('updated', updatedRequirement);

                const suppressStatusPopup = Boolean(
                    req.body && req.body.suppress_in_store_popup,
                );
                if (!suppressStatusPopup && nextStatus && prevStatus !== nextStatus) {
                    Promise.resolve().then(async () => {
                        try {
                            await notifyRequirementStatusChange(
                                updatedRequirement,
                                prevStatus,
                                nextStatus,
                            );
                        } catch (notifyError) {
                            console.error(
                                'Error sending status-change notifications:',
                                notifyError,
                            );
                        }
                    });
                }
            } catch (err) {

                console.error('Error broadcasting update/notification:', err);
            }

            res.json({
                success: true,
                message: 'Requirement updated successfully',
                requirement: updatedRequirement
            });

            // Field-level edit log (best-effort) — one row per changed REQUIREMENT column
            try {
                const candidate = Array.from(new Set([
                    ...Object.keys(req.body || {}),
                    'order_status',
                    'status',
                ]));
                await logRequirementFieldChanges({
                    requirement_id: parseInt(id, 10),
                    serial_number: updatedRequirement.serial_number || beforeRow.serial_number,
                    edited_by: getUsernameFromReq(req),
                    action: 'UPDATE',
                    before: beforeRow,
                    after: result.rows[0],
                    fields: candidate,
                });
            } catch (e) {
                console.error(
                    'REQUIREMENT_EDIT_LOG write failed (requirement update):',
                    e.message || e,
                );
            }

            // Audit log (best-effort) - store raw DB row (before) and updated row (after)
            try {
                // Only store changed fields (based on provided body keys + computed order_status)
                const candidate = Array.from(new Set([
                    ...Object.keys(req.body || {}),
                    'order_status',
                    'status'
                ]));
                const patch = pickChangedColumns(beforeRow, result.rows[0], candidate);
                await writeAuditLog(req, {
                    action: 'UPDATE',
                    tableName: 'REQUIREMENT',
                    tableOfId: parseInt(id, 10),
                    tableOfColumn: patch.columns.join(','),
                    oldValue: patch.oldValue,
                    newValue: patch.newValue,
                    userId
                });
            } catch (e) {
                console.error('Audit log write failed (requirement update):', e.message || e);
            }
    }

    // Optimized: Check existence before deletion
    static async deleteRequirement(req, res) {
        const { id } = req.params;
        const userId = getUserIdFromReq(req);

        const requirementCheck = await RequirementModel.findById(id);

        if (!requirementCheck) {
            throw new AppError('Requirement not found', 404);
        }

        const deleted = await RequirementModel.delete(id);

        if (!deleted) {
            throw new AppError('Requirement not found', 404);
        }

        // Broadcast WebSocket update (non-blocking)
        RequirementController.broadcastRequirementLive('deleted', { id: parseInt(id) });

        // Audit log (best-effort)
        try {
            await writeAuditLog(req, {
                action: 'DELETE',
                tableName: 'REQUIREMENT',
                tableOfId: parseInt(id, 10),
                tableOfColumn: '"sr.no"',
                oldValue: requirementCheck,
                newValue: null,
                userId
            });
        } catch (e) {
            console.error('Audit log write failed (requirement delete):', e.message || e);
        }

        res.json({
            success: true,
            message: 'Requirement deleted successfully'
        });
    }

    static async getPersonFilterOptions(req, res) {
        const options = await RequirementModel.getPersonFilterOptions();
        res.json({ success: true, ...options });
    }

    static async getNextSerialNumber(req, res) {
        // Get prefix and year format from settings (data from settings, not hardcoded YYMM)
        const settingsResult = await pool.query(
            "SELECT key, value FROM settings WHERE key IN ('serial_prefix', 'serial_year_format')"
        );
        const settings = {};
        (settingsResult.rows || []).forEach(row => { settings[row.key] = row.value; });

        const prefix = settings.serial_prefix || req.query.prefix || 'RFQ';
        // Default: financial year from `financial_years` → RFQ-2526-001
        const yearFormat = (settings.serial_year_format || 'FINANCIAL_YEAR').toString().trim();
        const yearCode = await resolveRequirementSerialYearCode(pool, yearFormat);

        const latest = await RequirementModel.findLatestSerialNumber(prefix, yearCode);

        let nextNumber = 1;
        let padLen = 3;
        if (latest && latest.serial_number) {
            const parts = latest.serial_number.split('-');
            const lastPart = String(parts[parts.length - 1] ?? '').trim();
            const lastNum = parseInt(lastPart, 10);
            if (!isNaN(lastNum)) {
                nextNumber = lastNum + 1;
                padLen = Math.max(3, lastPart.length, String(nextNumber).length);
            }
        }

        const serialNumber = `${prefix}-${yearCode}-${nextNumber.toString().padStart(padLen, '0')}`;
        res.json({
            success: true,
            serialNumber,
            serial_number: serialNumber
        });
    }

    // Optimized: Parallel checks for issue reporting
    static async reportIssue(req, res) {
        // Check if pool is available
        if (!pool) {
            throw new AppError('Database connection pool not initialized', 500);
        }

        const { id } = req.params;
        const { issue_note, reported_by, page_name, receive_username } = req.body || {};

        if (!issue_note || !issue_note.trim()) {
            throw new AppError('Issue note is required', 400);
        }

        if (!page_name) {
            throw new AppError('Page name is required', 400);
        }

            // Parallel: Get requirement and check ISSUE table existence
            const [reqResult, issueTableCheck] = await Promise.all([
                pool.query(
                    `SELECT "require_person_name", "review_person", "serial_number", "order_status", "status"
                     FROM "REQUIREMENT" WHERE "sr.no" = $1`,
                    [id],
                ),
                pool.query(`
                    SELECT table_name 
                    FROM information_schema.tables 
                    WHERE table_name = 'ISSUE'
                `)
            ]);

            if (reqResult.rows.length === 0) {
                throw new AppError('Requirement not found', 404);
            }

            const requirement = reqResult.rows[0];
            const hasIssueTable = issueTableCheck.rows.length > 0;

            if (!hasIssueTable) {
                throw new AppError('ISSUE table does not exist. Please run migration 013_create_issue_table.sql', 400);
            }

            // Determine receive_username
            let receiveUsername = receive_username || null;

            if (!receiveUsername) {
                if (page_name === 'Request Review') {
                    receiveUsername = requirement.require_person_name;
                } else if (page_name === 'In Store check') {
                    if (requirement.require_person_name) {
                        try {
                            const requirePersonResult = await pool.query(
                                `SELECT ed.reporting_manager
                                 FROM personal_details pd
                                 JOIN employment_details ed ON ed.personal_details_id = pd.id
                                 WHERE LOWER(TRIM(pd.username)) = LOWER(TRIM($1))
                                 LIMIT 1`,
                                [requirement.require_person_name]
                            );

                            const reportingManager = requirePersonResult.rows[0]?.reporting_manager;
                            if (reportingManager) {
                                receiveUsername = String(reportingManager).trim();
                            }
                        } catch (headError) {
                            console.error('Error finding reporting manager:', headError);
                        }
                    }
                }
            }

            // Purchase/In Store issues: show to whole Request Review team.
            // Notification bar includes these items for request-review users ONLY when receive_username IS NULL
            // (see IssueController.getAllIssues).
            if (page_name === 'Purchase' || page_name === 'In Store check') {
                receiveUsername = null;
            }

            // Create issue record
            const currentDate = new Date();
            const dateStr = currentDate.toISOString().split('T')[0];
            const timeStr = currentDate.toTimeString().split(' ')[0].substring(0, 8);

            // If receiveUsername is still null, pick one reviewer only for pages that need a concrete assignee
            // (Purchase/In Store use NULL so every request-review user sees the issue).
            if (!receiveUsername && page_name !== 'Purchase' && page_name !== 'In Store check') {
                try {
                    const reviewUsernames = await getUsernamesForPage('request-review');
                    if (reviewUsernames.length > 0) {
                        receiveUsername = reviewUsernames[0];
                    } else {
                        receiveUsername = 'Reviewer';
                    }
                } catch (e) {
                    receiveUsername = 'Reviewer';
                }
            }

            const issueResult = await pool.query(
                `INSERT INTO "ISSUE" (
                    "serial_number", "requirement_id", "sender_username", "page_name", 
                    "notes", "receive_username", "order_status", "issue_order_status", "date", "time", "created_at"
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
                RETURNING *`,
                [
                    requirement.serial_number || null,
                    parseInt(id),
                    reported_by || null,
                    page_name,
                    issue_note.trim(),
                    receiveUsername,
                    'Issue',
                    requirement.order_status || null,
                    dateStr,
                    timeStr
                ]
            );

            // Parallel: Update requirement and broadcast updates
            // Determine requirement status based on source page
            // If from In Store or Purchase, move to Request Review. If from Review page, move to Issue.
            const newStatus = (page_name === 'In Store check' || page_name === 'Purchase') ? 'Request Review' : 'Issue';

            const [updateResult] = await Promise.all([
                pool.query(
                    `UPDATE "REQUIREMENT"
                     SET "order_status" = 'Issue', 
                         "status" = $1, 
                         "updated_at" = CURRENT_TIMESTAMP
                     WHERE "sr.no" = $2
                     RETURNING *`,
                    [newStatus, id]
                )
            ]);

            if (!updateResult || !updateResult.rows || updateResult.rows.length === 0) {
                throw new AppError('Requirement not found or update failed', 404);
            }

            const updatedRequirement = formatRequirementDates(updateResult.rows[0]);
            const createdIssue = issueResult.rows[0];

            await recordRequirementStatusChange({
                serial_number: updatedRequirement.serial_number,
                old_status: requirement.status,
                new_status: updatedRequirement.status,
                username: reported_by || getUsernameFromReq(req),
            });

            try {
                await logRequirementFieldChanges({
                    requirement_id: parseInt(id, 10),
                    serial_number: updatedRequirement.serial_number,
                    edited_by: reported_by || getUsernameFromReq(req),
                    action: 'UPDATE',
                    before: requirement,
                    after: updateResult.rows[0],
                    fields: ['status', 'order_status'],
                });
            } catch (logErr) {
                console.error(
                    'REQUIREMENT_EDIT_LOG write failed (report issue):',
                    logErr.message || logErr,
                );
            }

            // Informational sidebar copy (READ_NOTIFICATION) — dismiss only.
            // Receive Issue also uses READ_NOTIFICATION (notifyReceiveIssueToRequirePerson).
            // ISSUE row + requirement status update remain for Fix Issue / Forward workflow.
            const pageLower = String(page_name ?? '').trim().toLowerCase();
            const isReceiveIssueNotify =
                pageLower === 'receive issue' || pageLower === 'receive items';

            if (!isReceiveIssueNotify) {
                try {
                    const recipients = await resolveIssueReportedRecipients(
                        requirement,
                        page_name,
                        { excludeUsername: reported_by },
                    );

                    if (!recipients.length) {
                        console.warn(
                            '[READ_NOTIFICATION] no recipients for issue-reported',
                            {
                                requirementId: id,
                                review_person: requirement.review_person,
                                require_person_name: requirement.require_person_name,
                                page_name,
                            },
                        );
                    }

                    const rows = await notifyIssueReportedReadNotifications({
                        requirementId: id,
                        serialNumber: requirement.serial_number,
                        senderUsername: reported_by,
                        pageName: page_name,
                        note: issue_note,
                        originStatus: requirement.order_status || requirement.status,
                        issueId: createdIssue?.['sr.no'] ?? createdIssue?.id,
                        recipients,
                    });

                    for (const row of rows) {
                        const receiveUser = String(row.receive_username ?? '').trim();
                        if (!receiveUser) continue;
                        emitIssueSocket(
                            buildIssueSocketPayload({
                                username: receiveUser,
                                socketType: 'issue-reported',
                                title: 'Issue reported',
                                message:
                                    row.message ||
                                    `${requirement.serial_number || `REQ-${id}`} issue from ${page_name}`,
                                serial_number: requirement.serial_number,
                                sr_no: Number(id),
                                requirement_id: Number(id),
                                issue: row,
                                page_name,
                            }),
                        );
                    }
                } catch (err) {
                    console.error('Failed creating issue-reported READ_NOTIFICATION:', err);
                }
            }

            // Broadcast updates (non-blocking)
            try {
                RequirementController.broadcastRequirementLive('updated', updatedRequirement);
            } catch (broadcastErr) {
                console.error('Error broadcasting requirement update:', broadcastErr);
            }

            try {
                const io = getIO();
                if (io) {
                    const reviewUsers = await getUsernamesForPage('request-review');

                    const serialLabel = requirement.serial_number || `REQ-${id}`;
                    const issueMessage = `${serialLabel} issue generated from ${page_name}`.trim();
                    const isInstoreOrPurchase =
                        page_name === 'In Store check' || page_name === 'Purchase';

                    const notifyIssueUser = (targetUsername) => {
                        const name = String(targetUsername || '').trim();
                        if (!name || name === reported_by) return;
                        emitIssueSocket(
                            buildIssueSocketPayload({
                                username: name,
                                socketType: 'issue-created',
                                title: 'Issue reported',
                                message: issueMessage,
                                serial_number: requirement.serial_number,
                                sr_no: Number(id),
                                requirement_id: Number(id),
                                issue: createdIssue,
                                page_name,
                            }),
                        );
                    };

                    if (isInstoreOrPurchase) {
                        reviewUsers.forEach(notifyIssueUser);
                    } else if (page_name === 'Request Review') {
                        notifyIssueUser(requirement.require_person_name);
                    } else if (receiveUsername) {
                        notifyIssueUser(receiveUsername);
                    }
                }
            } catch (ioErr) {
                console.error('Error broadcasting notification update:', ioErr);
            }

            res.json({
                success: true,
                message: 'Issue reported successfully',
                requirement: updatedRequirement,
                issue: createdIssue,
                serial_number: requirement.serial_number
            });
    }

    /** Map pipeline status / page to label shown in Terminate Requested (Label). */
    static resolveTerminateOriginLabel(status, pageName) {
        const st = String(status || '').trim().toLowerCase();
        const page = String(pageName || '').trim().toLowerCase();

        if (st === 'request review' || page.includes('request review')) {
            return 'Request Review';
        }
        if (st === 'purchase' || page === 'purchase' || page.includes('purchase request')) {
            return 'Purchase';
        }
        if (st === 'order done' || page.includes('order placed')) {
            return 'Order Placed';
        }
        if (st === 'receive done' || page.includes('receive')) {
            return 'Receive Items';
        }
        if (st === 'in store' || page.includes('in store')) {
            return 'In Store Check';
        }

        const fallback = String(status || pageName || '').trim();
        return fallback || 'Unknown';
    }

    /** Append termination reason + username to split (keeps existing balance/split text). */
    static buildTerminationSplitNote(reason, username, existingSplit = '') {
        const reasonText = String(reason ?? '').trim();
        const by = String(username ?? '').trim();
        const note = by ? `${reasonText} (${by})` : reasonText;
        const prior = String(existingSplit ?? '').trim();
        if (!prior) return note;
        return `${prior} | ${note}`;
    }

    // Optimized: Parallel checks for termination
    static async terminateRequirement(req, res) {
        const { id } = req.params;
        const { reason, reported_by, page_name } = req.body || {};

        if (!reason || !reason.trim()) {
            throw new AppError('Termination reason is required', 400);
        }

        const originPage = page_name || 'Terminate';
        const reasonText = reason.trim();
        const terminatedBy = String(
            reported_by ?? getUsernameFromReq(req) ?? '',
        ).trim();

            const reqResult = await pool.query(
                `SELECT "require_person_name", "serial_number", "order_status", "status", "split"
                 FROM "REQUIREMENT" WHERE "sr.no" = $1`,
                [id],
            );

            if (reqResult.rows.length === 0) {
                throw new AppError('Requirement not found', 404);
            }

            const requirement = reqResult.rows[0];
            const requirePersonName = requirement.require_person_name;
            const originLabel = RequirementController.resolveTerminateOriginLabel(
                requirement.status,
                originPage,
            );
            const terminateOrderStatus = `Terminate Requested (${originLabel})`;

            if (!requirePersonName) {
                throw new AppError('Requirement does not have a require_person_name', 400);
            }

            const requirePersonResult = await pool.query(
                `SELECT ed.reporting_manager
                 FROM personal_details pd
                 JOIN employment_details ed ON ed.personal_details_id = pd.id
                 WHERE LOWER(TRIM(pd.username)) = LOWER(TRIM($1))
                 LIMIT 1`,
                [requirePersonName]
            );

            const headUsername = requirePersonResult.rows[0]?.reporting_manager
                ? String(requirePersonResult.rows[0].reporting_manager).trim()
                : null;

            const issueNote = terminatedBy
                ? `Termination requested by ${terminatedBy}: ${reasonText}`
                : `Termination requested: ${reasonText}`;
            const splitNote = RequirementController.buildTerminationSplitNote(
                reasonText,
                terminatedBy,
                requirement.split,
            );

            // Update requirement status first (Confirm Terminate uses REQUIREMENT, not ISSUE).
            const updateResult = await pool.query(
                `UPDATE "REQUIREMENT"
                 SET "status" = $1,
                     "order_status" = $2,
                     "split" = $3,
                     "updated_at" = NOW()
                 WHERE "sr.no" = $4
                 RETURNING *`,
                ['Terminate Requested', terminateOrderStatus, splitNote, id]
            );

            const updatedRequirement = formatRequirementDates(updateResult.rows[0]);

            await recordRequirementStatusChange({
                serial_number: updatedRequirement.serial_number,
                old_status: requirement.status,
                new_status: updatedRequirement.status,
                username: terminatedBy || getUsernameFromReq(req),
            });

            try {
                await logRequirementFieldChanges({
                    requirement_id: parseInt(id, 10),
                    serial_number: updatedRequirement.serial_number,
                    edited_by: terminatedBy || getUsernameFromReq(req),
                    action: 'UPDATE',
                    before: requirement,
                    after: updateResult.rows[0],
                    fields: ['status', 'order_status', 'split'],
                });
            } catch (logErr) {
                console.error(
                    'REQUIREMENT_EDIT_LOG write failed (terminate request):',
                    logErr.message || logErr,
                );
            }

            // Sidebar notifications — READ_NOTIFICATION only (never ISSUE).
            let requirePersonNotify = null;
            let headNotify = null;
            try {
                requirePersonNotify = await createTerminateRequestedReadNotification({
                    requirementId: id,
                    serialNumber: requirement.serial_number,
                    senderUsername: terminatedBy,
                    receiveUsername: requirePersonName,
                    pageName: originPage,
                    note: issueNote,
                    originStatus: requirement.status || requirement.order_status,
                });
                if (headUsername && headUsername !== requirePersonName) {
                    headNotify = await createTerminateRequestedReadNotification({
                        requirementId: id,
                        serialNumber: requirement.serial_number,
                        senderUsername: terminatedBy,
                        receiveUsername: headUsername,
                        pageName: originPage,
                        note: issueNote,
                        originStatus: requirement.status || requirement.order_status,
                    });
                }
            } catch (err) {
                console.error('Failed creating terminate-requested READ_NOTIFICATION:', err);
            }

            // Broadcast updates (non-blocking)
            try {
                RequirementController.broadcastRequirementLive('updated', updatedRequirement);
            } catch (broadcastErr) {
                console.error('Error broadcasting requirement update:', broadcastErr);
            }

            try {
                const io = getIO();
                if (io) {
                    const serialLabel =
                        requirement.serial_number || `SR-${id}`;
                    if (requirePersonName && requirePersonName !== terminatedBy) {
                        emitIssueSocket(
                            buildIssueSocketPayload({
                                username: requirePersonName,
                                socketType: 'terminate-requested',
                                title: 'Terminate requested',
                                message:
                                    requirePersonNotify?.message ||
                                    `${serialLabel}: termination requested`,
                                serial_number: requirement.serial_number,
                                sr_no: Number(id),
                                requirement_id: Number(id),
                                issue: requirePersonNotify,
                                page_name: originPage,
                            }),
                        );
                    }
                    if (
                        headNotify &&
                        headUsername &&
                        headUsername !== terminatedBy &&
                        headUsername !== requirePersonName
                    ) {
                        emitIssueSocket(
                            buildIssueSocketPayload({
                                username: headUsername,
                                socketType: 'terminate-requested',
                                title: 'Terminate requested',
                                message:
                                    headNotify.message ||
                                    `${serialLabel}: termination requested`,
                                serial_number: requirement.serial_number,
                                sr_no: Number(id),
                                requirement_id: Number(id),
                                issue: headNotify,
                                page_name: originPage,
                            }),
                        );
                    }
                }
            } catch (ioErr) {
                console.error('Error broadcasting notification updates:', ioErr);
            }

            res.json({
                success: true,
                message: 'Termination request sent successfully',
                notification: requirePersonNotify,
                headNotificationCreated: !!headNotify,
                headUsername: headUsername || null
            });
    }

    /** Extract origin label from "Terminate Requested (Purchase)" / "Terminated (Purchase)". */
    static extractTerminateOriginLabel(orderStatus) {
        const raw = String(orderStatus || '').trim();
        const match = raw.match(/\(([^)]+)\)\s*$/);
        if (match?.[1]?.trim()) return match[1].trim();
        return '';
    }

    // Optimized: Parallel operations for confirm termination
    static async confirmTerminate(req, res) {
        const { id } = req.params;

        const reqResult = await pool.query(
            `SELECT "order_status", "status", "split", "serial_number", "require_person_name"
             FROM "REQUIREMENT"
             WHERE "sr.no" = $1`,
            [id],
        );

        if (reqResult.rows.length === 0) {
            throw new AppError('Requirement not found', 404);
        }

        const current = reqResult.rows[0];

        let originLabel = RequirementController.extractTerminateOriginLabel(
            current.order_status,
        );
        if (!originLabel) {
            originLabel = RequirementController.resolveTerminateOriginLabel(
                current.status,
                '',
            );
        }

        const terminatedOrderStatus = originLabel
            ? `Terminated (${originLabel})`
            : 'Terminated';

        // Keep split as-is (termination reason). Only update status + order_status.
        const updateResult = await pool.query(
            `UPDATE "REQUIREMENT"
             SET status = $1, order_status = $2, updated_at = NOW()
             WHERE "sr.no" = $3
             RETURNING *`,
            ['Terminated', terminatedOrderStatus, id],
        );

        if (updateResult.rows.length === 0) {
            throw new AppError('Requirement not found', 404);
        }

        try {
            await logRequirementFieldChanges({
                requirement_id: parseInt(id, 10),
                serial_number: updateResult.rows[0].serial_number || current.serial_number,
                edited_by: getUsernameFromReq(req),
                action: 'UPDATE',
                before: current,
                after: updateResult.rows[0],
                fields: ['status', 'order_status'],
            });
        } catch (logErr) {
            console.error(
                'REQUIREMENT_EDIT_LOG write failed (confirm terminate):',
                logErr.message || logErr,
            );
        }

        // Clear terminate sidebar notifications (READ_NOTIFICATION).
        // Also clear any legacy ISSUE terminate rows if present.
        await pool.query(
            `DELETE FROM "READ_NOTIFICATION"
             WHERE requirement_id = $1 AND notification_type = 'terminate-requested'`,
            [parseInt(id, 10)],
        );
        try {
            await pool.query(
                `DELETE FROM "ISSUE" 
                 WHERE "requirement_id" = $1 AND "order_status" = 'Terminate'`,
                [id],
            );
        } catch (err) {
            console.error('Legacy ISSUE terminate cleanup failed:', err);
        }

        const updatedRequirement = formatRequirementDates(updateResult.rows[0]);

        await recordRequirementStatusChange({
            serial_number: updatedRequirement.serial_number,
            old_status: current.status,
            new_status: updatedRequirement.status,
            username: getUsernameFromReq(req),
        });

        // Broadcast update (non-blocking)
        RequirementController.broadcastRequirementLive('updated', updatedRequirement);

        try {
            const io = getIO();
            const requirePerson = updateResult.rows[0]?.require_person_name;
            if (io && requirePerson) {
                const serialLabel =
                    updatedRequirement.serial_number || `SR-${id}`;
                emitIssueSocket(
                    buildIssueSocketPayload({
                        username: requirePerson,
                        socketType: 'terminate-confirmed',
                        title: 'Requirement terminated',
                        message: `${serialLabel}: requirement terminated`,
                        serial_number: updatedRequirement.serial_number,
                        sr_no: Number(id),
                        requirement_id: Number(id),
                        page_name: originLabel || 'Request Review',
                    }),
                );
            }
        } catch (ioErr) {
            console.error('Error broadcasting terminate confirm:', ioErr);
        }

            res.json({
                success: true,
                message: 'Requirement terminated successfully',
                requirement: updatedRequirement,
            });
    }

    /** GET /requirements/status — list status history (optional ?serial_number=&page=&limit=). */
    static async getRequirementStatuses(req, res) {
        const { serial_number, page, limit } = req.query || {};
        const result = await findRequirementStatuses({
            serial_number,
            page,
            limit,
        });

        res.json({
            success: true,
            statuses: result.rows,
            pagination: {
                total: result.total,
                page: result.page,
                limit: result.limit,
                totalPages: result.limit
                    ? Math.ceil(result.total / result.limit) || 0
                    : 1,
            },
        });
    }

    /** GET /requirements/status/:serial_number — history for one serial. */
    static async getRequirementStatusBySerial(req, res) {
        const serial = String(req.params.serial_number ?? '').trim();
        if (!serial) {
            throw new AppError('serial_number is required', 400);
        }

        const requirementResult = await pool.query(
            `SELECT serial_number, status, order_status
             FROM "REQUIREMENT"
             WHERE LOWER(TRIM(serial_number)) = LOWER(TRIM($1))
             ORDER BY "sr.no" DESC
             LIMIT 1`,
            [serial],
        );
        if (requirementResult.rows[0]) {
            await ensureReceiveIssueStatusHistory(requirementResult.rows[0], null);
        }

        const statuses = await findRequirementStatusBySerial(serial);
        res.json({
            success: true,
            serial_number: serial,
            statuses,
            count: statuses.length,
        });
    }
}

wrapController(RequirementController, [
    'getTempBomImages',
    'createTempBomImage',
    'updateTempBomImage',
    'transferTempBomImage',
    'createTempRequirement',
    'updateTempRequirement',
    'listTempRequirements',
    'getTempRequirement',
    'deleteTempRequirement',
    'getAllRequirements',
    'getCollectionDeskRequirements',
    'getRequirementStats',
    'getRequirementStatuses',
    'getRequirementStatusBySerial',
    'getRequirementById',
    'createRequirement',
    'createBulkRequirements',
    'notifyBomBatchCreated',
    'notifyBulkReceiveDone',
    'notifyBulkPurchaseMoved',
    'bulkVerifyRequirements',
    'updateRequirement',
    'deleteRequirement',
    'getPersonFilterOptions',
    'getNextSerialNumber',
    'reportIssue',
    'terminateRequirement',
    'confirmTerminate',
]);
export default RequirementController;