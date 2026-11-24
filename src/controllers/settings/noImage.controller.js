import NoImageModel from '../../models/settings/noImage.model.js';
import { v2 as cloudinary } from 'cloudinary';
import dotenv from 'dotenv';
import { AppError, wrapController } from '../../middleware/error.middleware.js';

dotenv.config();

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

function normalizeModuleName(value) {
    return String(value ?? '').trim().toLowerCase();
}

async function uploadNoImageFile(file, moduleName) {
    if (!file) return null;

    const isImage = file.mimetype?.startsWith('image/');
    if (!isImage) {
        throw new AppError(
            'Invalid file type. Only images (JPEG, PNG, GIF, WebP) are allowed.',
            400
        );
    }

    const folderPath = `no-images/${moduleName || 'general'}`;
    const timestamp = Date.now();
    const originalName = file.originalname || 'no-image';
    const fileExtension = originalName.includes('.')
        ? originalName.split('.').pop().toLowerCase()
        : 'png';
    const cleanName = originalName
        .replace(/\.[^/.]+$/, '')
        .replace(/[^a-zA-Z0-9]/g, '_')
        .toLowerCase() || 'no-image';
    const publicId = `${folderPath}/noimg_${timestamp}_${cleanName}.${fileExtension}`;

    const base64Image = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
    const uploadResult = await cloudinary.uploader.upload(base64Image, {
        public_id: publicId,
        folder: folderPath,
        resource_type: 'image',
        transformation: [
            { width: 800, height: 800, crop: 'limit' },
            { quality: 'auto' },
        ],
    });

    return uploadResult.secure_url;
}

class NoImageController {
    static async getAll(req, res) {
        const rows = await NoImageModel.findAll();
        res.json({ success: true, data: rows });
    }

    /** GET /no-images/:id — fetch placeholder by row id */
    static async getById(req, res) {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id) || id <= 0) {
            throw new AppError('Valid id is required', 400);
        }

        const row = await NoImageModel.findById(id);
        if (!row) {
            throw new AppError('No-image record not found', 404);
        }

        res.json({ success: true, data: row });
    }

    /** GET /no-images/module/:moduleName — fetch placeholder for a module (project, pcb, …) */
    static async getByModuleName(req, res) {
        const moduleName = normalizeModuleName(req.params.moduleName);
        if (!moduleName) {
            throw new AppError('module_name is required', 400);
        }

        const row = await NoImageModel.findByModuleName(moduleName);
        if (!row) {
            throw new AppError(
                `No-image not configured for module "${moduleName}"`,
                404
            );
        }

        res.json({ success: true, data: row });
    }

    /**
     * POST /no-images
     * Body (JSON): { module_name, image? }
     * Or multipart: field "module_name" + file field "image" / "photo"
     * Upserts by module_name so re-upload replaces the placeholder.
     */
    static async create(req, res) {
        const moduleName = normalizeModuleName(
            req.body?.module_name ?? req.body?.moduleName
        );
        if (!moduleName) {
            throw new AppError('module_name is required', 400);
        }

        let imageUrl =
            req.body?.image != null && String(req.body.image).trim()
                ? String(req.body.image).trim()
                : null;

        const file = req.file || null;
        if (file) {
            imageUrl = await uploadNoImageFile(file, moduleName);
        }

        if (!imageUrl) {
            throw new AppError(
                'image is required (URL string or uploaded file)',
                400
            );
        }

        const row = await NoImageModel.upsertByModuleName({
            module_name: moduleName,
            image: imageUrl,
        });

        res.status(201).json({
            success: true,
            message: 'No-image saved for module',
            data: row,
        });
    }

    static async update(req, res) {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id) || id <= 0) {
            throw new AppError('Valid id is required', 400);
        }

        const existing = await NoImageModel.findById(id);
        if (!existing) {
            throw new AppError('No-image record not found', 404);
        }

        const moduleNameRaw =
            req.body?.module_name ?? req.body?.moduleName;
        const moduleName =
            moduleNameRaw != null
                ? normalizeModuleName(moduleNameRaw)
                : undefined;

        if (moduleNameRaw != null && !moduleName) {
            throw new AppError('module_name cannot be empty', 400);
        }

        if (moduleName && moduleName !== existing.module_name) {
            const duplicate = await NoImageModel.findByModuleName(moduleName);
            if (duplicate && Number(duplicate.id) !== id) {
                throw new AppError(
                    'Another no-image already exists for this module_name',
                    409
                );
            }
        }

        let imageUrl =
            req.body?.image !== undefined
                ? (req.body.image == null || String(req.body.image).trim() === ''
                    ? null
                    : String(req.body.image).trim())
                : undefined;

        if (req.file) {
            imageUrl = await uploadNoImageFile(
                req.file,
                moduleName || existing.module_name
            );
        }

        const row = await NoImageModel.update(id, {
            module_name: moduleName,
            image: imageUrl,
        });

        res.json({
            success: true,
            message: 'No-image updated',
            data: row,
        });
    }

    static async remove(req, res) {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id) || id <= 0) {
            throw new AppError('Valid id is required', 400);
        }

        const existing = await NoImageModel.findById(id);
        if (!existing) {
            throw new AppError('No-image record not found', 404);
        }

        await NoImageModel.delete(id);
        res.json({
            success: true,
            message: 'No-image deleted',
            data: { id },
        });
    }
}

wrapController(NoImageController, [
    'getAll',
    'getById',
    'getByModuleName',
    'create',
    'update',
    'remove',
]);

export default NoImageController;
