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

export async function createGoogleDoc(req, res) {
    try {
        const { ownerId, username, isAdmin } = await resolveActor(req);
        if (ownerId == null || !username) return unauthorized(res);

        const name = sanitizeGoogleItemName(req.body?.name);
        const parentId = Number(req.body?.parent_id);

        if (!name) {
            return res.status(400).json({
                success: false,
                message: 'Doc name is required',
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
                    'Cannot create a Google Doc inside a deleted/recycle-bin folder',
            });
        }
        if (isRecycleBinPath(parent.relative_path)) {
            return res.status(400).json({
                success: false,
                message: 'Cannot create a Google Doc inside Recycle Bin',
            });
        }
        const actor = { ownerId, username, isAdmin };
        if (!(await canAccessItemForWrite(parent, actor))) {
            return forbid(
                res,
                'You do not have permission to create files in this folder.',
            );
        }

        let driveFolderId;
        try {
            driveFolderId = await resolveGoogleDriveFolderId({
                parent,
                userId: ownerId,
            });
        } catch (driveError) {
            const driveStatus =
                Number(driveError.status || driveError.response?.status) || 0;
            const status =
                driveStatus >= 400 && driveStatus < 500 ? driveStatus : 502;
            const isAuthError =
                driveError instanceof GoogleAuthError ||
                String(driveError.code || '').startsWith('GOOGLE_');
            return res.status(status).json({
                success: false,
                message:
                    isAuthError || driveStatus === 400
                        ? driveError.message
                        : 'Failed to resolve Google Drive folder',
            });
        }

        const targetOwnerId = Number(parent.owner_id);
        const targetUsername =
            String(parent.username || username).trim() || username;

        const duplicate =
            (await FileManagerModel.findChildByNameOrUrl(parent.id, name)) ||
            (await findActiveDuplicate({
                parentId: parent.id,
                name: `${name}.url`,
                username: targetUsername,
            }));
        if (duplicate) {
            return res.status(409).json({
                success: false,
                message:
                    'An item with this name already exists in the target folder',
                data: duplicate,
            });
        }

        // Editor access for project assignees, created_by, and the actor, via work email
        const shareEditEmails = await collectProjectGoogleEditorEmails({
            folder: parent,
            extraUsernames: [targetUsername, username],
        });

        let googleMeta = null;
        try {
            googleMeta = await GoogleFileService.createGoogleDoc({
                userId: ownerId,
                title: name,
                googleDriveFolderId: driveFolderId,
                shareEditEmails,
            });
        } catch (gErr) {
            if (
                gErr instanceof GoogleAuthError ||
                gErr?.code === 'GOOGLE_NOT_CONNECTED' ||
                gErr?.code === 'GOOGLE_INVALID_CLIENT' ||
                gErr?.code === 'GOOGLE_INVALID_GRANT'
            ) {
                return res.status(gErr.status || 401).json({
                    success: false,
                    message: gErr.message || 'Google account is not connected',
                });
            }
            console.error(
                'createGoogleDoc Google API error:',
                gErr?.cause?.message || gErr?.message || gErr,
            );
            return res
                .status(gErr.status && gErr.status < 500 ? gErr.status : 502)
                .json({
                    success: false,
                    message:
                        gErr.status === 400
                            ? gErr.message
                            : 'Failed to create Google Doc',
                });
        }

        const parentAbs = resolveShortcutParentDir(parent);
        let shortcutMeta = null;
        try {
            shortcutMeta = createGoogleShortcut({
                parentDirAbsolute: parentAbs,
                name,
                url: googleMeta.url,
            });
        } catch (scErr) {
            console.error(
                'createGoogleDoc shortcut error:',
                scErr?.message || scErr,
            );
            try {
                const { auth } = await getExistingGoogleAuthForUser(ownerId);
                await GoogleFileService.deleteDriveFile(
                    getDriveClient(auth),
                    googleMeta.google_file_id,
                );
            } catch (cleanupErr) {
                console.warn(
                    'Google Doc cleanup after shortcut failure:',
                    cleanupErr?.message || cleanupErr,
                );
            }
            return res
                .status(scErr.status && scErr.status < 500 ? scErr.status : 500)
                .json({
                    success: false,
                    message:
                        scErr.status === 409
                            ? scErr.message
                            : 'Failed to create Google Doc shortcut on disk',
                });
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
                mime_type: 'application/vnd.google-apps.document',
                extension: 'gdoc',
                size: shortcutMeta.size,
                created_by: username,
                updated_by: username,
                file_source: 'gdocs',
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
            console.error('createGoogleDoc DB insert failed:', dbErr);
            removeGoogleShortcut(shortcutMeta?.absolutePath);
            try {
                const { auth } = await getExistingGoogleAuthForUser(ownerId);
                await GoogleFileService.deleteDriveFile(
                    getDriveClient(auth),
                    googleMeta.google_file_id,
                );
            } catch (cleanupErr) {
                console.warn(
                    'Google Doc cleanup after DB failure:',
                    cleanupErr?.message || cleanupErr,
                );
            }
            return res.status(500).json({
                success: false,
                message: 'Failed to save Google Doc metadata',
            });
        }

        try {
            await writeAuditLog(req, {
                action: 'CREATE',
                tableName: 'file_manager_items',
                tableOfId: item.id,
                tableOfColumn: 'google_doc',
                oldValue: null,
                newValue: {
                    id: item.id,
                    name: item.name,
                    file_source: 'gdocs',
                    google_file_id: item.google_file_id,
                    parent_id: item.parent_id,
                    storage_name: item.storage_name,
                    relative_path: item.relative_path,
                },
            });
        } catch (auditErr) {
            console.warn('createGoogleDoc audit log:', auditErr.message);
        }

        const data = attachGoogleFileMeta({
            ...item,
            ...buildThumbnailMeta(item),
            shares: googleMeta?.shares || [],
        });

        return res.status(201).json({
            success: true,
            message: 'Google Doc created successfully',
            data,
        });
    } catch (error) {
        console.error('createGoogleDoc error:', error);
        return res.status(500).json({
            success: false,
            message: error.message || 'Failed to create Google Doc',
        });
    }
}

export default createGoogleDoc;
