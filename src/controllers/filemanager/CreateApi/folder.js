import path from 'path';
import FileManagerModel from '../../../models/filemanager/fileManager.model.js';
import {
    RECYCLE_BIN_FOLDER,
    resolveActor,
    unauthorized,
    notFound,
    forbid,
    assertOwner,
    sanitizeFolderName,
    findActiveDuplicate,
    joinRelative,
    absolutePath,
    ensureDir,
    getFileManagerPathValue,
    isScopedTreeItem,
    resolveWritableParent,
    resolveItemAbsoluteDir,
    createScopedUploadedFolder,
} from '../fileManager.controller.js';
import { attachCreatedByUserOne } from '../../../utils/fileManagerCreatedBy.js';

export async function createFolder(req, res) {
    try {
        const { ownerId, username, isAdmin } = await resolveActor(req);
        if (ownerId == null || !username) return unauthorized(res);

        const name = sanitizeFolderName(req.body?.name);
        const parentId =
            req.body?.parent_id != null ? Number(req.body.parent_id) : null;

        if (!name) {
            return res.status(400).json({
                success: false,
                message: 'Folder name is required',
            });
        }
        if (name.toLowerCase() === RECYCLE_BIN_FOLDER.toLowerCase()) {
            return res.status(400).json({
                success: false,
                message: `"${RECYCLE_BIN_FOLDER}" is a reserved system folder`,
            });
        }

        const actor = { ownerId, username, isAdmin };
        let parent = null;
        if (parentId == null) {
            parent = await FileManagerModel.findRootByOwner(
                ownerId,
                getFileManagerPathValue(),
            );
            if (!parent) {
                return res.status(400).json({
                    success: false,
                    message:
                        'User root folder not found. Call POST /my-folder first.',
                });
            }
        } else {
            const resolved = await resolveWritableParent(parentId, actor);
            if (resolved.error === 'not_found') {
                return notFound(res, 'Parent folder not found');
            }
            if (resolved.error === 'forbid') return forbid(res);
            parent = resolved.parent;
        }

        const scopedParent = isScopedTreeItem(parent);
        const targetOwnerId = Number(parent.owner_id);
        const targetUsername =
            String(parent.username || username).trim() || username;

        const duplicate = await findActiveDuplicate({
            parentId: parent.id,
            name,
            username: targetUsername,
            anyScope: scopedParent,
        });
        if (duplicate) {
            return res.status(409).json({
                success: false,
                message: 'A folder or file with this name already exists here',
            });
        }

        const relativePath = joinRelative(parent.relative_path, name);
        const abs = scopedParent
            ? path.join(resolveItemAbsoluteDir(parent), name)
            : absolutePath(relativePath);
        ensureDir(abs);

        const folder = scopedParent
            ? await createScopedUploadedFolder({
                  parent,
                  name,
                  relativePath,
                  absolutePath: abs,
                  actorUsername: username,
                  actorUserId: ownerId,
              })
            : await FileManagerModel.create({
                  owner_id: targetOwnerId,
                  username: targetUsername,
                  parent_id: parent.id,
                  name,
                  item_type: 'folder',
                  storage_name: null,
                  relative_path: relativePath,
                  filemanager_path: getFileManagerPathValue(),
                  created_by: username,
                  updated_by: username,
              });

        const isOwner =
            isAdmin ||
            Number(folder.owner_id) === Number(ownerId) ||
            String(folder.username || '')
                .trim()
                .toLowerCase() === String(username || '').trim().toLowerCase();

        const dataWithCreator = await attachCreatedByUserOne(folder);

        return res.status(201).json({
            success: true,
            data: {
                ...dataWithCreator,
                access: {
                    permissions: {
                        view: isOwner,
                        create: isOwner,
                        rename: isOwner,
                        delete: isOwner,
                        download: isOwner,
                    },
                    is_owner: isOwner,
                },
            },
        });
    } catch (error) {
        console.error('createFolder error:', error);
        return res.status(500).json({
            success: false,
            message: error.message || 'Failed to create folder',
        });
    }
}

export default createFolder;
