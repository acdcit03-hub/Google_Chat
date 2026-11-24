import fs from 'fs';
import {
    getExistingGoogleAuthForUser,
    getDriveClient,
    mapGoogleApiAuthError,
    GoogleAuthError,
} from '../auth/googleDriveAuth.js'; // <-- adjust to the real path of the file you pasted
import { getOrCreateThumbnail, isGoogleNativeFile } from './fileManager.js';

// Example Express handler for GET /api/file-manager/files/:id/thumbnail
export async function thumbnailHandler(req, res) {
    const { id } = req.params;
    const userId = req.user?.id; // <-- adjust to however you identify the requesting ERP user

    // Replace with however you actually load a file-manager item by id
    const item = await FileManagerItem.findById(id); // <-- your real lookup

    if (!item) {
        return res.status(404).json({ error: 'File not found' });
    }

    try {
        let googleDrive;

        if (isGoogleNativeFile(item)) {
            try {
                const { auth } = await getExistingGoogleAuthForUser(userId);
                googleDrive = getDriveClient(auth);
            } catch (err) {
                // Surface a clean 401 instead of leaking auth internals
                if (err instanceof GoogleAuthError) {
                    return res.status(err.status).json({ error: err.message, code: err.code });
                }
                const mapped = mapGoogleApiAuthError(err);
                if (mapped) {
                    return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
                }
                throw err;
            }
        }

        const { buffer, contentType } = await getOrCreateThumbnail({
            itemId: item.id,
            absPath: item.abs_path,       // ignored for Google-native files
            fileName: item.name,
            extension: item.extension,
            storageRoot: item.storage_root,
            stat: item.abs_path && fs.existsSync(item.abs_path) ? fs.statSync(item.abs_path) : null,
            item,                          // needed for Google detection
            googleDrive,                   // authenticated googleapis Drive client, only set for Google files
        });

        res.set('Content-Type', contentType);
        res.set('Cache-Control', 'private, max-age=3600');
        return res.send(buffer);
    } catch (err) {
        if (err.code === 'THUMBNAIL_UNAVAILABLE') {
            return res.status(422).json({ error: err.message });
        }
        const mapped = mapGoogleApiAuthError(err);
        if (mapped) {
            return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
        }
        console.error('Thumbnail generation failed:', err);
        return res.status(500).json({ error: 'Internal error generating thumbnail' });
    }
}