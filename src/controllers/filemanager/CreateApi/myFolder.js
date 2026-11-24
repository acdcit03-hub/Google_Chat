import fs from 'fs';
import FileManagerModel from '../../../models/filemanager/fileManager.model.js';
import FileManagerPermissionModel from '../../../models/filemanager/fileManagerPermission.model.js';
import FileManagerSettingModel from '../../../models/filemanager/fileManagerSetting.model.js';
import { getUsernameFromReq } from '../../../utils/audit.utils.js';
import { ensureEmployeeGoogleDriveFolder } from '../../../services/filemanager/googleDriveFolders.service.js';
import {
    resolveActor,
    unauthorized,
    syncFsChildren,
    ownFolderName,
    sanitizeFolderName,
    findExistingOwnRoot,
    absolutePath,
    ensureDir,
    ensureUserRecycleBinFolder,
    getFileManagerPathValue,
} from '../fileManager.controller.js';

async function syncEmployeeDriveFolder(folder, ownerId) {
    const driveFolderId = await ensureEmployeeGoogleDriveFolder(
        ownerId,
        folder.username,
    );
    return (
        (await FileManagerModel.update(folder.id, {
            google_drive_folder_id: driveFolderId,
        })) || { ...folder, google_drive_folder_id: driveFolderId }
    );
}

/** Share the user's My Folder as editor with owners selected in File Manager settings. */
async function shareMyFolderWithSettingsOwners(folder, actorUsername) {
    const folderId = Number(folder?.id);
    if (!Number.isFinite(folderId) || folderId <= 0) return;

    const owners = await FileManagerSettingModel.findActiveOwners();
    const assignedBy = String(actorUsername || '').trim() || 'system';
    const folderOwnerId = Number(folder.owner_id);

    for (const owner of owners || []) {
        if (owner.status === false) continue;
        const userId = Number(owner.owner_id);
        const username = String(owner.username || '').trim();
        if (!userId || !username) continue;
        if (folderOwnerId && userId === folderOwnerId) continue;

        await FileManagerPermissionModel.upsertUser({
            item_id: folderId,
            user_id: userId,
            username,
            role: 'editor',
            assigned_by_username: assignedBy,
            is_childshare: true,
        });
    }
}

export async function ensureMyFolder(req, res) {
    try {
        const { ownerId, username, isAdmin } = await resolveActor(req);
        if (ownerId == null || !username) return unauthorized(res);

        await syncFsChildren({
            parentId: null,
            parentRelative: '',
            defaultOwnerId: ownerId,
            defaultUsername: username,
            actorUsername: username,
        });

        const safeName = ownFolderName(username);

        const requestedName = sanitizeFolderName(req.body?.name || '');
        if (
            requestedName &&
            requestedName.toLowerCase() !== safeName.toLowerCase()
        ) {
            return res.status(400).json({
                success: false,
                message: `Own folder name must be "${safeName}" (your username). Duplicate own folders are not allowed.`,
                suggested_name: safeName,
            });
        }

        let root = await findExistingOwnRoot(ownerId, username);

        if (root) {
            root = await syncEmployeeDriveFolder(root, ownerId);
            const abs = absolutePath(root.relative_path);
            ensureDir(abs);
            const recycleMeta = await ensureUserRecycleBinFolder(
                username,
                ownerId,
            );
            await syncFsChildren({
                parentId: root.id,
                parentRelative: root.relative_path,
                defaultOwnerId: Number(root.owner_id),
                defaultUsername: root.username || username,
                actorUsername: username,
            });
            await shareMyFolderWithSettingsOwners(root, username);

            return res.status(409).json({
                success: false,
                exists: true,
                created: false,
                data: root,
                storage_path: abs,
                recycle_bin_path: recycleMeta?.recycle_bin_path || null,
                recycle_bin_root: recycleMeta?.recycle_bin_root || null,
                recycle_bin_folder: recycleMeta?.recycle_bin_folder || null,
                filemanager_path: getFileManagerPathValue(),
                is_admin: isAdmin,
                message:
                    'Your folder already exists. Duplicate own folder is not allowed.',
            });
        }

        const pathClash =
            (await FileManagerModel.findByRelativePath(safeName)) ||
            (await FileManagerModel.findChildByName({
                parentId: null,
                name: safeName,
            }));
        if (pathClash) {
            const driveFolder = await syncEmployeeDriveFolder(
                pathClash,
                Number(pathClash.owner_id) || ownerId,
            );
            const recycleMeta = await ensureUserRecycleBinFolder(
                driveFolder.username || username,
                Number(driveFolder.owner_id) || ownerId,
            );
            await shareMyFolderWithSettingsOwners(driveFolder, username);
            return res.status(409).json({
                success: false,
                exists: true,
                created: false,
                data: driveFolder,
                recycle_bin_path: recycleMeta?.recycle_bin_path || null,
                recycle_bin_root: recycleMeta?.recycle_bin_root || null,
                recycle_bin_folder: recycleMeta?.recycle_bin_folder || null,
                filemanager_path: getFileManagerPathValue(),
                is_admin: isAdmin,
                message:
                    'A folder with your username already exists. Duplicate own folder is not allowed.',
            });
        }

        const relativePath = safeName;
        const abs = absolutePath(relativePath);
        if (fs.existsSync(abs)) {
            root = await FileManagerModel.create({
                owner_id: ownerId,
                username,
                parent_id: null,
                name: safeName,
                item_type: 'folder',
                storage_name: null,
                relative_path: relativePath,
                filemanager_path: getFileManagerPathValue(),
                created_by: username,
                updated_by: username,
            });
            root = await syncEmployeeDriveFolder(root, ownerId);
            const recycleMeta = await ensureUserRecycleBinFolder(
                username,
                ownerId,
            );
            await shareMyFolderWithSettingsOwners(root, username);
            return res.status(201).json({
                success: true,
                exists: true,
                created: true,
                data: root,
                storage_path: abs,
                recycle_bin_path: recycleMeta?.recycle_bin_path || null,
                recycle_bin_root: recycleMeta?.recycle_bin_root || null,
                recycle_bin_folder: recycleMeta?.recycle_bin_folder || null,
                filemanager_path: getFileManagerPathValue(),
                is_admin: isAdmin,
            });
        }

        ensureDir(abs);

        root = await FileManagerModel.create({
            owner_id: ownerId,
            username,
            parent_id: null,
            name: safeName,
            item_type: 'folder',
            storage_name: null,
            relative_path: relativePath,
            filemanager_path: getFileManagerPathValue(),
            created_by: username,
            updated_by: username,
        });

        root = await syncEmployeeDriveFolder(root, ownerId);
        const recycleMeta = await ensureUserRecycleBinFolder(username, ownerId);
        await shareMyFolderWithSettingsOwners(root, username);

        return res.status(201).json({
            success: true,
            exists: true,
            created: true,
            data: root,
            storage_path: abs,
            recycle_bin_path: recycleMeta?.recycle_bin_path || null,
            recycle_bin_root: recycleMeta?.recycle_bin_root || null,
            recycle_bin_folder: recycleMeta?.recycle_bin_folder || null,
            filemanager_path: getFileManagerPathValue(),
            is_admin: isAdmin,
        });
    } catch (error) {
        console.error('ensureMyFolder error:', error);
        if (error?.code === '23505') {
            const existing = await findExistingOwnRoot(
                Number(req?.user?.id),
                getUsernameFromReq(req) || '',
            );
            if (existing) {
                await shareMyFolderWithSettingsOwners(
                    existing,
                    getUsernameFromReq(req) || '',
                );
            }
            return res.status(409).json({
                success: false,
                exists: true,
                created: false,
                data: existing,
                message:
                    'Your folder already exists. Duplicate own folder is not allowed.',
            });
        }
        return res.status(500).json({
            success: false,
            message: error.message || 'Failed to create user folder',
        });
    }
}

export default ensureMyFolder;
