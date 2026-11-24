import {
    getExistingGoogleAuthForUser,
    getDriveClient,
    mapGoogleApiAuthError,
} from './googleAuth.service.js';
import { pool } from '../../config/db.js';

const GOOGLE_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

function cleanEnv(value) {
    return String(value || '')
        .trim()
        .replace(/^["']|["']$/g, '')
        .trim();
}

function escapeDriveQueryValue(value) {
    return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function ensureDriveFolder(userId, name, parentId) {
    const folderName = String(name || '').trim();
    const parentFolderId = String(parentId || '').trim();
    if (!folderName || !parentFolderId) {
        const err = new Error('Google Drive folder name and parent ID are required');
        err.status = 400;
        throw err;
    }

    const { auth } = await getExistingGoogleAuthForUser(userId);
    const drive = getDriveClient(auth);
    const queryName = escapeDriveQueryValue(folderName);
    try {
        const result = await drive.files.list({
            q: `name = '${queryName}' and mimeType = '${GOOGLE_FOLDER_MIME_TYPE}' and '${parentFolderId}' in parents and trashed = false`,
            pageSize: 100,
            orderBy: 'createdTime',
            fields: 'files(id,name)',
            corpora: 'allDrives',
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
        });

        const existing = result.data.files?.[0];
        if (existing?.id) return String(existing.id);

        const created = await drive.files.create({
            requestBody: {
                name: folderName,
                mimeType: GOOGLE_FOLDER_MIME_TYPE,
                parents: [parentFolderId],
            },
            fields: 'id,name',
            supportsAllDrives: true,
        });
        if (!created.data.id) {
            throw new Error(
                `Google Drive did not return an ID for folder "${folderName}"`,
            );
        }
        return String(created.data.id);
    } catch (err) {
        const authError = mapGoogleApiAuthError(err);
        if (authError) throw authError;
        throw err;
    }
}

async function ensureGroupingFolder(userId, name) {
    const configuredParentId = cleanEnv(process.env.GOOGLE_DRIVE_FOLDER_ID);
    if (!configuredParentId) {
        const err = new Error('GOOGLE_DRIVE_FOLDER_ID is not configured in .env');
        err.status = 400;
        throw err;
    }
    return ensureDriveFolder(userId, name, configuredParentId);
}

export async function ensureEmployeeGoogleDriveFolder(userId, username) {
    const employeeName = String(username || '').trim();
    if (!employeeName) {
        const err = new Error('Username is required to create an employee Drive folder');
        err.status = 400;
        throw err;
    }
    const employeesFolderId = await ensureGroupingFolder(userId, 'Employees');
    return ensureDriveFolder(userId, employeeName, employeesFolderId);
}

export async function ensureProjectGoogleDriveFolder(userId, projectCode) {
    const code = String(projectCode || '').trim();
    if (!code) {
        const err = new Error('Project code is required to create a project Drive folder');
        err.status = 400;
        throw err;
    }
    const projectsFolderId = await ensureGroupingFolder(userId, 'Projects');
    return ensureDriveFolder(userId, code, projectsFolderId);
}

export async function resolveGoogleDriveFolderId({ parent, userId }) {
    const scope = String(parent?.scope || '').trim().toLowerCase();
    if (scope === 'project' || parent?.project_id != null) {
        const rootId = parent?.scope_root_id ?? parent?.id;
        const rootResult =
            rootId != null
                ? await pool.query(
                      `SELECT google_drive_folder_id
                       FROM file_manager_items
                       WHERE id = $1
                         AND scope = 'project'
                         AND scope_root_id IS NULL
                         AND is_deleted = FALSE
                       LIMIT 1`,
                      [rootId],
                  )
                : { rows: [] };
        const projectFolderId = String(
            rootResult.rows[0]?.google_drive_folder_id ||
                (rootId == null ? parent?.google_drive_folder_id : '') ||
                '',
        ).trim();
        if (projectFolderId) return projectFolderId;
        return ensureProjectGoogleDriveFolder(
            userId,
            parent?.project_code,
        );
    }

    if (scope === 'file_manager' || !scope) {
        return ensureEmployeeGoogleDriveFolder(userId, parent?.username);
    }

    const existingId = String(parent?.google_drive_folder_id || '').trim();
    if (existingId) return existingId;

    const configuredParentId = cleanEnv(process.env.GOOGLE_DRIVE_FOLDER_ID);
    if (!configuredParentId) {
        const err = new Error('GOOGLE_DRIVE_FOLDER_ID is not configured in .env');
        err.status = 400;
        throw err;
    }
    return configuredParentId;
}
