/**
 * Backward-compatible wrapper around unified file_manager_permissions.
 * Prefer FileManagerPermissionModel for new code.
 */
import FileManagerPermissionModel, {
    initializeFileManagerPermissionsTable,
} from './fileManagerPermission.model.js';

export const initializeFileManagerItemFolderUsersTable = async () => {
    await initializeFileManagerPermissionsTable();
};

class FileManagerItemFolderUsersModel {
    static assertFolderItem(itemId) {
        return FileManagerPermissionModel.assertFolderItem(itemId);
    }

    static listUsers(itemId) {
        return FileManagerPermissionModel.listUsers(itemId);
    }

    static findUser(itemId, userId) {
        return FileManagerPermissionModel.findUser(itemId, userId);
    }

    static upsertUser(payload) {
        return FileManagerPermissionModel.upsertUser(payload);
    }

    static updateUserPermissions(itemId, userId, fields = {}) {
        return FileManagerPermissionModel.updateUserPermissions(
            itemId,
            userId,
            fields,
        );
    }

    static removeUser(itemId, userId) {
        return FileManagerPermissionModel.removeUser(itemId, userId);
    }
}

export default FileManagerItemFolderUsersModel;
