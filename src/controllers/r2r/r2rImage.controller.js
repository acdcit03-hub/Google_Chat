import { AppError, wrapController } from '../../middleware/error.middleware.js';
import { saveR2rProductPhotoFromUpload } from '../../utils/r2rImageStorage.js';
import RequirementController from './requirement.controller.js';

class R2rImageController {
    /** Multipart `image` → Cloudinary URL. */
    static async uploadProductPhoto(req, res) {
        if (!req.file || !req.file.buffer) {
            throw new AppError('Image file is required (field name: image)', 400);
        }

        const serial = RequirementController.normalizeSerialNumber(
            req.body?.serial_number || req.body?.serialNumber || '',
        );
        const kind = String(req.body?.kind || 'product').trim().toLowerCase();
        const suffix = kind === 'bill' ? '_bill' : '';

        const imageUrl = await saveR2rProductPhotoFromUpload(
            req.file,
            serial || 'pending',
            { suffix, kind },
        );

        if (!imageUrl) {
            throw new AppError('Could not store image', 400);
        }

        return res.json({
            success: true,
            image_url: imageUrl,
            path: imageUrl,
            url: imageUrl,
        });
    }
}

wrapController(R2rImageController, ['uploadProductPhoto']);
export default R2rImageController;
