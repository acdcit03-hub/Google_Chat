import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import FileManagerController from '../../controllers/filemanager/fileManager.controller.js';
import SharedWithMeController from '../../controllers/filemanager/sharedWithMe.controller.js';
import PermissionController from '../../controllers/filemanager/fileManagerpermission.controller.js';
import createGoogleSheet from '../../controllers/filemanager/CreateApi/googlesheet.js';
import createGoogleDoc from '../../controllers/filemanager/CreateApi/googledocs.js';
import createFolder from '../../controllers/filemanager/CreateApi/folder.js';
import ensureMyFolder from '../../controllers/filemanager/CreateApi/myFolder.js';
import createShortcut from '../../controllers/filemanager/CreateApi/createshortcut.js';

const router = express.Router();

/** Trim stray spaces in URL segments (e.g. ".../replace%20%20" from Postman). */
router.use((req, _res, next) => {
    if (req.url) {
        const [pathPart, ...queryParts] = req.url.split('?');
        const cleaned = pathPart
            .split('/')
            .map((segment) => {
                try {
                    return encodeURIComponent(
                        decodeURIComponent(segment).trim(),
                    );
                } catch {
                    return segment.trim();
                }
            })
            .join('/');
        req.url = queryParts.length
            ? `${cleaned}?${queryParts.join('?')}`
            : cleaned;
    }
    next();
});

const MAX_FILE_BYTES =
    Number(process.env.FILE_MANAGER_MAX_BYTES) || 5 * 1024 * 1024 * 1024;
const MAX_FILES = Number(process.env.FILE_MANAGER_MAX_FILES) || 5000;

function getUploadTempDir() {
    const configured = String(
        process.env.FILEMANAGER_PATH || process.env.FILE_MANAGER_UPLOAD_TMP || '',
    )
        .trim()
        .replace(/^["']|["']$/g, '');
    const base = configured
        ? path.resolve(configured, '.upload-tmp')
        : path.join(process.cwd(), '.upload-tmp');
    fs.mkdirSync(base, { recursive: true });
    return base;
}

const diskStorage = multer.diskStorage({
    destination(_req, _file, cb) {
        try {
            cb(null, getUploadTempDir());
        } catch (err) {
            cb(err);
        }
    },
    filename(_req, file, cb) {
        const ext = path.extname(file.originalname || '').slice(0, 32);
        cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
    },
});

const upload = multer({
    storage: diskStorage,
    limits: {
        fileSize: 5* 1024 * 1024 * 1024,
    },
});

function handleUploadError(err, _req, res, next) {
    if (!err) {
        next();
        return;
    }

    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({
                success: false,
                message: 'File is too large',
            });
        }
        if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
            return res.status(400).json({
                success: false,
                message: `Too many files in one upload (max ${MAX_FILES}). Upload a smaller folder or raise FILE_MANAGER_MAX_FILES.`,
            });
        }
        return res.status(400).json({
            success: false,
            message: err.message || 'Invalid upload',
        });
    }

    return res.status(400).json({
        success: false,
        message: err.message || 'Invalid upload',
    });
}

/* ================= USER ROOT ================= */
router.get('/my-folder', FileManagerController.getMyFolder);
router.post('/my-folder', ensureMyFolder);

/* ================= GOOGLE ================= */
router.get('/google-sheets', FileManagerController.listGoogleSheets);
router.post('/google-sheets', createGoogleSheet);
router.post('/google-docs', createGoogleDoc);

/* ================= SHORTCUT ================= */
router.post('/shortcuts', createShortcut);

/* ================= RECYCLE BIN ================= */
router.get('/recycle-bin', FileManagerController.getRecycleBin);
router.post('/recycle-bin/:id/restore', FileManagerController.restoreFromRecycleBin);
router.delete('/recycle-bin/:id', FileManagerController.permanentDeleteFromRecycleBin);

/* ================= SHARED WITH ME ================= */
router.get('/shared-with-me', SharedWithMeController.list);
router.get(
    '/shared-with-me/folders/:folderId/children',
    SharedWithMeController.children,
);

/* ================= PERMISSIONS (folders + files, role-based) ================= */
router.get('/permissions/access', PermissionController.getAccess);
router.get('/permissions', PermissionController.list);
router.post('/permissions', PermissionController.create);
router.put('/permissions/:itemId', PermissionController.update);
router.put('/permissions', PermissionController.update);
router.delete('/permissions', PermissionController.remove);

/* ================= FOLDERS ================= */
router.post('/folders', createFolder);
router.get('/folders/:id/children', FileManagerController.getFolderChildren);
router.get('/folders/:id/download', FileManagerController.downloadFolder);
router.get('/folders/:id', FileManagerController.getFolder);
router.put('/folders/:id', FileManagerController.updateFolder);
router.delete('/folders/:id', FileManagerController.deleteFolder);

/* ================= FILES ================= */
router.post(
    '/files/upload',
    upload.fields([
        {
            name: 'file',
            maxCount: MAX_FILES,
        },
        {
            name: 'files',
            maxCount: MAX_FILES,
        },
    ]),
    handleUploadError,
    FileManagerController.uploadFile,
);

router.post(
    '/files/upload-folder',
    upload.array('files', MAX_FILES),
    handleUploadError,
    FileManagerController.uploadFolder,
);
router.get('/files/:id/download', FileManagerController.downloadFile);
router.get('/files/:id/view', FileManagerController.viewFile);
router.get('/files/:id/thumbnail', FileManagerController.getThumbnail);
router.get('/files/:id', FileManagerController.getFile);
router.put('/files/:id', FileManagerController.updateFile);
router.delete('/files/:id', FileManagerController.deleteFile);

/* ================= FAVORITES ================= */
router.get('/favorites', FileManagerController.listFavorites);
router.post('/favorites', FileManagerController.setFavorite);

/* ================= COMMON (file + folder by id) ================= */
router.get('/items', FileManagerController.getItems);
/** ?type=file|folder&username=&name=  (name aliases: file_name, q, query) */
router.get('/search', FileManagerController.search);
router.post('/move', upload.none(), handleUploadError, FileManagerController.moveItem);
/** One replace API for both: file id = single file, folder id = folder contents. */
router.post(
    '/items/:id/replace',
    upload.fields([
        { name: 'file', maxCount: MAX_FILES },
        { name: 'files', maxCount: MAX_FILES },
    ]),
    handleUploadError,
    FileManagerController.replaceItem,
);
/** One permanent-delete API for both file and folder, detected by id. */
router.delete(
    '/items/:id/permanent',
    FileManagerController.permanentDelete,
);

export default router;
