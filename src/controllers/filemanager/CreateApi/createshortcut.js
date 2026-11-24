import fs from 'fs';
import path from 'path';
import FileManagerModel from '../../../models/filemanager/fileManager.model.js';
import { writeAuditLog } from '../../../utils/audit.utils.js';
import {
    getExistingGoogleAuthForUser,
    getDriveClient,
} from '../../../services/filemanager/googleAuth.service.js';
import {
    buildThumbnailMeta,
    getOrCreateThumbnail,
} from '../../../services/filemanager/thumbnail.service.js';
import {
    resolveActor,
    unauthorized,
    notFound,
    forbid,
    canAccessItemForWrite,
    isRecycleBinPath,
    findActiveDuplicate,
    joinRelative,
    absolutePath,
    getFileManagerPathValue,
    attachGoogleFileMeta,
} from '../fileManager.controller.js';

const ALLOWED_SHORTCUT_EXTENSIONS = new Set(['gsheet', 'gdoc', 'url']);

const SHORTCUT_TYPE_META = {
    gsheet: {
        extension: 'gsheet',
        mime_type: 'application/vnd.google-apps.spreadsheet',
        file_source: 'gsheet',
    },
    gdoc: {
        extension: 'gdoc',
        mime_type: 'application/vnd.google-apps.document',
        file_source: 'gdocs',
    },
    url: {
        extension: 'url',
        mime_type: 'application/internet-shortcut',
        file_source: 'shortcut',
    },
};

/**
 * Windows Internet Shortcut (.url) contents for a target URL.
 */
export function buildInternetShortcutContents(url) {
    const target = String(url || '').trim();
    if (!target) {
        throw new Error('Shortcut URL is required');
    }
    return `[InternetShortcut]\r\nURL=${target}\r\n`;
}

/**
 * Sanitize a display name into a safe Windows shortcut base name
 * (no path separators / reserved characters).
 */
export function sanitizeShortcutBaseName(name) {
    let base = String(name || '')
        .trim()
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
        .replace(/\s+/g, ' ')
        .replace(/\.+$/g, '')
        .slice(0, 240);
    if (/\.url$/i.test(base)) {
        base = base.slice(0, -4).replace(/\.+$/g, '');
    }
    return base;
}

export function normalizeShortcutExtension(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/^\./, '');
}

/**
 * Pull Google Drive file id from a Docs/Sheets URL when possible.
 */
export function extractGoogleFileIdFromUrl(url, extension) {
    const target = String(url || '').trim();
    const ext = normalizeShortcutExtension(extension);
    if (!target) return null;

    if (ext === 'gsheet') {
        const m = target.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/i);
        if (m?.[1]) return m[1];
    }
    if (ext === 'gdoc') {
        const m = target.match(/\/document\/d\/([a-zA-Z0-9-_]+)/i);
        if (m?.[1]) return m[1];
    }

    const generic = target.match(/\/d\/([a-zA-Z0-9-_]+)/i);
    return generic?.[1] || null;
}

/**
 * Create a physical Windows .url shortcut under an existing storage folder.
 * Only writes a local Internet Shortcut pointing at the URL — no download.
 */
/** Folder on disk: project/FY absolute_path, otherwise the personal file-manager path. */
export function resolveShortcutParentDir(parent) {
    const stored = String(parent?.absolute_path || '').trim();
    if (stored) return path.resolve(stored);
    return absolutePath(parent?.relative_path);
}

export function createGoogleShortcut({
    parentDirAbsolute,
    name,
    url,
    overwrite = false,
} = {}) {
    const parentDir = String(parentDirAbsolute || '').trim();
    const baseName = sanitizeShortcutBaseName(name);
    const targetUrl = String(url || '').trim();

    if (!parentDir) {
        throw new Error('parentDirAbsolute is required');
    }
    if (!baseName) {
        throw new Error('Shortcut name is required');
    }
    if (!/^https?:\/\//i.test(targetUrl)) {
        throw new Error('Shortcut URL must be an http(s) URL');
    }

    fs.mkdirSync(parentDir, { recursive: true });

    const fileName = `${baseName}.url`;
    const absolutePath = path.join(parentDir, fileName);

    if (!overwrite && fs.existsSync(absolutePath)) {
        const err = new Error(
            `Shortcut already exists on disk: ${fileName}`,
        );
        err.code = 'SHORTCUT_EXISTS';
        err.status = 409;
        throw err;
    }

    const contents = buildInternetShortcutContents(targetUrl);
    fs.writeFileSync(absolutePath, contents, 'utf8');

    let size = Buffer.byteLength(contents, 'utf8');
    try {
        size = fs.statSync(absolutePath).size;
    } catch {
        /* keep byteLength */
    }

    return {
        absolutePath,
        fileName,
        storageName: fileName,
        size,
    };
}

export const createPhysicalShortcut = createGoogleShortcut;

export function removeGoogleShortcut(absolutePath) {
    try {
        if (absolutePath && fs.existsSync(absolutePath)) {
            fs.unlinkSync(absolutePath);
        }
    } catch (err) {
        console.warn(
            'removeGoogleShortcut failed:',
            err?.message || err,
        );
    }
}

export const removePhysicalShortcut = removeGoogleShortcut;

/**
 * Best-effort thumbnail warm after shortcut create.
 */
async function warmShortcutThumbnail(item, { ownerId, absolutePath }) {
    try {
        let googleDrive;
        const ext = normalizeShortcutExtension(item.extension);
        if (ext === 'gsheet' || ext === 'gdoc') {
            const { auth } = await getExistingGoogleAuthForUser(ownerId);
            googleDrive = getDriveClient(auth);
        }
        await getOrCreateThumbnail({
            itemId: item.id,
            absPath: absolutePath,
            fileName: item.name,
            extension: item.extension,
            storageRoot: getFileManagerPathValue(),
            stat: absolutePath && fs.existsSync(absolutePath)
                ? fs.statSync(absolutePath)
                : null,
            item,
            googleDrive,
        });
    } catch (err) {
        console.warn(
            'createShortcut thumbnail warm failed:',
            err?.message || err,
        );
    }
}

/**
 * POST /shortcuts
 * Body: { name, url, parent_id, extension }
 * extension: gsheet | gdoc | url (required)
 */
export async function createShortcut(req, res) {
    try {
        const { ownerId, username, isAdmin } = await resolveActor(req);
        if (ownerId == null || !username) return unauthorized(res);

        const name = sanitizeShortcutBaseName(req.body?.name);
        const targetUrl = String(req.body?.url || '').trim();
        const parentId = Number(req.body?.parent_id);
        const extension = normalizeShortcutExtension(req.body?.extension);

        if (!name) {
            return res.status(400).json({
                success: false,
                message: 'Shortcut name is required',
            });
        }
        if (!targetUrl) {
            return res.status(400).json({
                success: false,
                message: 'url is required',
            });
        }
        if (!/^https?:\/\//i.test(targetUrl)) {
            return res.status(400).json({
                success: false,
                message: 'url must be an http(s) URL',
            });
        }
        if (!extension || !ALLOWED_SHORTCUT_EXTENSIONS.has(extension)) {
            return res.status(400).json({
                success: false,
                message: 'extension is required and must be one of: gsheet, gdoc, url',
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

        const typeMeta = SHORTCUT_TYPE_META[extension];
        const googleFileId = extractGoogleFileIdFromUrl(targetUrl, extension);

        if (
            (extension === 'gsheet' || extension === 'gdoc') &&
            !googleFileId
        ) {
            return res.status(400).json({
                success: false,
                message:
                    extension === 'gsheet'
                        ? 'url must be a Google Sheets link (…/spreadsheets/d/{id}/…)'
                        : 'url must be a Google Docs link (…/document/d/{id}/…)',
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
                    'Cannot create a shortcut inside a deleted/recycle-bin folder',
            });
        }
        if (isRecycleBinPath(parent.relative_path)) {
            return res.status(400).json({
                success: false,
                message: 'Cannot create a shortcut inside Recycle Bin',
            });
        }
        const actor = { ownerId, username, isAdmin };
        if (!(await canAccessItemForWrite(parent, actor))) {
            return forbid(
                res,
                'You do not have permission to create files in this folder.',
            );
        }

        const targetOwnerId = Number(parent.owner_id);
        const targetUsername =
            String(parent.username || username).trim() || username;

        const duplicate = await findActiveDuplicate({
            parentId: parent.id,
            name,
            username: targetUsername,
        });
        if (duplicate) {
            return res.status(409).json({
                success: false,
                message:
                    'An item with this name already exists in the target folder',
                data: duplicate,
            });
        }

        const shortcutFileName = `${name}.url`;
        const relativePath = joinRelative(
            parent.relative_path,
            shortcutFileName,
        );
        const parentAbs = resolveShortcutParentDir(parent);

        let shortcutMeta = null;
        try {
            shortcutMeta = createPhysicalShortcut({
                parentDirAbsolute: parentAbs,
                name,
                url: targetUrl,
            });
        } catch (scErr) {
            console.error(
                'createShortcut disk error:',
                scErr?.message || scErr,
            );
            return res
                .status(scErr.status && scErr.status < 500 ? scErr.status : 500)
                .json({
                    success: false,
                    message:
                        scErr.status === 409
                            ? scErr.message
                            : scErr.message || 'Failed to create shortcut on disk',
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
                relative_path: relativePath,
                absolute_path: shortcutMeta.absolutePath,
                filemanager_path: getFileManagerPathValue(),
                mime_type: typeMeta.mime_type,
                extension: typeMeta.extension,
                size: shortcutMeta.size,
                created_by: username,
                updated_by: username,
                file_source: typeMeta.file_source,
                google_file_id: googleFileId,
                url: targetUrl,
            });
            item =
                (await FileManagerModel.placeShortcutInParent(
                    item.id,
                    parent,
                    shortcutMeta.absolutePath,
                )) || item;
        } catch (dbErr) {
            console.error('createShortcut DB insert failed:', dbErr);
            removePhysicalShortcut(shortcutMeta?.absolutePath);
            return res.status(500).json({
                success: false,
                message: 'Failed to save shortcut metadata',
            });
        }

        await warmShortcutThumbnail(item, {
            ownerId,
            absolutePath: shortcutMeta.absolutePath,
        });

        try {
            await writeAuditLog(req, {
                action: 'CREATE',
                tableName: 'file_manager_items',
                tableOfId: item.id,
                tableOfColumn: 'shortcut',
                oldValue: null,
                newValue: {
                    id: item.id,
                    name: item.name,
                    extension: item.extension,
                    mime_type: item.mime_type,
                    file_source: item.file_source,
                    google_file_id: item.google_file_id,
                    url: item.url,
                    parent_id: item.parent_id,
                    storage_name: item.storage_name,
                    relative_path: item.relative_path,
                },
            });
        } catch (auditErr) {
            console.warn('createShortcut audit log:', auditErr.message);
        }

        const data = attachGoogleFileMeta({
            ...item,
            ...buildThumbnailMeta(item),
        });

        return res.status(201).json({
            success: true,
            message: 'Shortcut created successfully',
            data,
        });
    } catch (error) {
        console.error('createShortcut error:', error);
        return res.status(500).json({
            success: false,
            message: error.message || 'Failed to create shortcut',
        });
    }
}

export default createShortcut;
