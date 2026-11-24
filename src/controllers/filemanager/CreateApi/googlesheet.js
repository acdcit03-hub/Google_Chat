import FileManagerModel from '../../../models/filemanager/fileManager.model.js';
import { writeAuditLog } from '../../../utils/audit.utils.js';
import GoogleFileService, {
    GoogleAuthError,
} from '../../../services/filemanager/googleFile.service.js';
import {
    getExistingGoogleAuthForUser,
    getDriveClient,
} from '../../../services/filemanager/googleAuth.service.js';
import {
    createGoogleShortcut,
    removeGoogleShortcut,
    resolveShortcutParentDir,
} from './createshortcut.js';
import {
    resolveActor,
    unauthorized,
    notFound,
    forbid,
    canAccessItemForWrite,
    sanitizeGoogleItemName,
    isRecycleBinPath,
    findActiveDuplicate,
    joinRelative,
    getFileManagerPathValue,
    attachGoogleFileMeta,
} from '../fileManager.controller.js';
import { buildThumbnailMeta } from '../../../services/filemanager/thumbnail.service.js';
import { collectProjectGoogleEditorEmails } from './googleShareHelpers.js';
import { resolveGoogleDriveFolderId } from '../../../services/filemanager/googleDriveFolders.service.js';

/**
 * Shared create-sheet pipeline used by HTTP API and PCB folder structure.
 * Creates Drive sheet (blank or from template), .url shortcut, and FM DB row.
 */
export async function createGoogleSheetItem({
    ownerId,
    username,
    parent,
    name,
    sourceSpreadsheetId = null,
    shareEditEmails = null,
}) {
    const sheetName = sanitizeGoogleItemName(name);
    if (!sheetName) {
        const err = new Error('Sheet name is required');
        err.status = 400;
        throw err;
    }
    if (!parent || parent.item_type !== 'folder') {
        const err = new Error('Parent folder not found');
        err.status = 404;
        throw err;
    }

    const driveFolderId = await resolveGoogleDriveFolderId({
        parent,
        userId: ownerId,
    });
    if (!driveFolderId) {
        const err = new Error(
            'Google Drive folder is not configured for this ERP folder',
        );
        err.status = 400;
        throw err;
    }

    const targetOwnerId = Number(parent.owner_id);
    const targetUsername =
        String(parent.username || username).trim() || username;

    const duplicate =
        (await FileManagerModel.findChildByNameOrUrl(parent.id, sheetName)) ||
        (await findActiveDuplicate({
            parentId: parent.id,
            name: `${sheetName}.url`,
            username: targetUsername,
        }));
    if (duplicate) {
        const err = new Error(
            'An item with this name already exists in the target folder',
        );
        err.status = 409;
        err.data = duplicate;
        throw err;
    }

    const emails =
        shareEditEmails != null
            ? shareEditEmails
            : await collectProjectGoogleEditorEmails({
                  folder: parent,
                  extraUsernames: [targetUsername, username],
              });

    let googleMeta = null;
    try {
        googleMeta = await GoogleFileService.createGoogleSheet({
            userId: ownerId,
            title: sheetName,
            googleDriveFolderId: driveFolderId,
            shareEditEmails: emails,
            sourceSpreadsheetId,
        });
    } catch (gErr) {
        if (
            gErr instanceof GoogleAuthError ||
            gErr?.code === 'GOOGLE_NOT_CONNECTED' ||
            gErr?.code === 'GOOGLE_INVALID_CLIENT' ||
            gErr?.code === 'GOOGLE_INVALID_GRANT'
        ) {
            const err = new Error(
                gErr.message || 'Google account is not connected',
            );
            err.status = gErr.status || 401;
            err.code = gErr.code;
            throw err;
        }
        throw gErr;
    }

    const parentAbs = resolveShortcutParentDir(parent);
    let shortcutMeta = null;
    try {
        shortcutMeta = createGoogleShortcut({
            parentDirAbsolute: parentAbs,
            name: sheetName,
            url: googleMeta.url,
        });
    } catch (scErr) {
        try {
            const { auth } = await getExistingGoogleAuthForUser(ownerId);
            await GoogleFileService.deleteDriveFile(
                getDriveClient(auth),
                googleMeta.google_file_id,
            );
        } catch (cleanupErr) {
            console.warn(
                'Google Sheet cleanup after shortcut failure:',
                cleanupErr?.message || cleanupErr,
            );
        }
        throw scErr;
    }

    let item;
    try {
        item = await FileManagerModel.create({
            owner_id: targetOwnerId,
            username: targetUsername,
            parent_id: parent.id,
            name: shortcutMeta.fileName,
            item_type: 'file',
            storage_name: shortcutMeta.storageName,
            relative_path: joinRelative(
                parent.relative_path,
                shortcutMeta.fileName,
            ),
            absolute_path: shortcutMeta.absolutePath,
            filemanager_path: getFileManagerPathValue(),
            mime_type: 'application/vnd.google-apps.spreadsheet',
            extension: 'gsheet',
            size: shortcutMeta.size,
            created_by: username,
            updated_by: username,
            file_source: 'gsheet',
            google_file_id: googleMeta.google_file_id,
            google_drive_folder_id: driveFolderId,
            url: googleMeta.url,
        });
        item =
            (await FileManagerModel.placeShortcutInParent(
                item.id,
                parent,
                shortcutMeta.absolutePath,
            )) || item;
    } catch (dbErr) {
        removeGoogleShortcut(shortcutMeta?.absolutePath);
        try {
            const { auth } = await getExistingGoogleAuthForUser(ownerId);
            await GoogleFileService.deleteDriveFile(
                getDriveClient(auth),
                googleMeta.google_file_id,
            );
        } catch (cleanupErr) {
            console.warn(
                'Google Sheet cleanup after DB failure:',
                cleanupErr?.message || cleanupErr,
            );
        }
        const err = new Error('Failed to save Google Sheet metadata');
        err.status = 500;
        err.cause = dbErr;
        throw err;
    }

    return {
        item,
        googleMeta,
        shortcutMeta,
        driveFolderId,
    };
}

export async function createGoogleSheet(req, res) {
    try {
        const { ownerId, username, isAdmin } = await resolveActor(req);
        if (ownerId == null || !username) return unauthorized(res);

        const name = sanitizeGoogleItemName(req.body?.name);
        const parentId = Number(req.body?.parent_id);
        const sourceSpreadsheetId = String(
            req.body?.source_spreadsheet_id ??
                req.body?.sourceSpreadsheetId ??
                '',
        ).trim();

        if (!name) {
            return res.status(400).json({
                success: false,
                message: 'Sheet name is required',
            });
        }
        if (
            req.body?.parent_id == null ||
            req.body?.parent_id === '' ||
            Number.isNaN(parentId) ||
            parentId <= 0
        ) {
            return res.status(400).json({
                success: false,
                message: 'parent_id is required',
            });
        }

        const parent = await FileManagerModel.findById(parentId, {
            anyScope: true,
        });
        if (!parent || parent.item_type !== 'folder') {
            return notFound(res, 'Parent folder not found');
        }
        if (parent.is_deleted || parent.recycle_path) {
            return res.status(400).json({
                success: false,
                message:
                    'Cannot create a Google Sheet inside a deleted/recycle-bin folder',
            });
        }
        if (isRecycleBinPath(parent.relative_path)) {
            return res.status(400).json({
                success: false,
                message: 'Cannot create a Google Sheet inside Recycle Bin',
            });
        }
        const actor = { ownerId, username, isAdmin };
        if (!(await canAccessItemForWrite(parent, actor))) {
            return forbid(
                res,
                'You do not have permission to create files in this folder.',
            );
        }

        let created;
        try {
            created = await createGoogleSheetItem({
                ownerId,
                username,
                parent,
                name,
                sourceSpreadsheetId: sourceSpreadsheetId || null,
            });
        } catch (err) {
            if (
                err instanceof GoogleAuthError ||
                err?.code === 'GOOGLE_NOT_CONNECTED' ||
                err?.code === 'GOOGLE_INVALID_CLIENT' ||
                err?.code === 'GOOGLE_INVALID_GRANT'
            ) {
                return res.status(err.status || 401).json({
                    success: false,
                    message: err.message || 'Google account is not connected',
                });
            }
            if (err?.status === 409) {
                return res.status(409).json({
                    success: false,
                    message: err.message,
                    data: err.data,
                });
            }
            if (err?.status && err.status < 500) {
                return res.status(err.status).json({
                    success: false,
                    message: err.message,
                });
            }
            console.error(
                'createGoogleSheet Google API error:',
                err?.cause?.message || err?.message || err,
            );
            return res.status(502).json({
                success: false,
                message:
                    err.status === 400
                        ? err.message
                        : 'Failed to create Google Sheet',
            });
        }

        try {
            await writeAuditLog(req, {
                action: 'CREATE',
                tableName: 'file_manager_items',
                tableOfId: created.item.id,
                tableOfColumn: 'google_sheet',
                oldValue: null,
                newValue: {
                    id: created.item.id,
                    name: created.item.name,
                    file_source: 'gsheet',
                    google_file_id: created.item.google_file_id,
                    parent_id: created.item.parent_id,
                    storage_name: created.item.storage_name,
                    relative_path: created.item.relative_path,
                },
            });
        } catch (auditErr) {
            console.warn('createGoogleSheet audit log:', auditErr.message);
        }

        const data = attachGoogleFileMeta({
            ...created.item,
            ...buildThumbnailMeta(created.item),
            shares: created.googleMeta?.shares || [],
        });

        return res.status(201).json({
            success: true,
            message: 'Google Sheet created successfully',
            data,
        });
    } catch (error) {
        console.error('createGoogleSheet error:', error);
        return res.status(500).json({
            success: false,
            message: error.message || 'Failed to create Google Sheet',
        });
    }
}

export default createGoogleSheet;
