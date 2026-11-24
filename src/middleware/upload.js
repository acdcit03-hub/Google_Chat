import multer from 'multer';
import sharp from 'sharp';

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configure Cloudinary

// Multer storage for memory (to upload to Cloudinary)
const storage = multer.memoryStorage();

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB limit
    }
});

const imageUpload = multer({
    storage,
    limits: {
        fileSize: 10 * 1024 * 1024
    },
    fileFilter: (_req, file, cb) => {
        if (String(file.mimetype || '').startsWith('image/')) {
            cb(null, true);
            return;
        }
        cb(new Error('Only image uploads are allowed'));
    }
});

function handleUploadError(err, _req, res, next) {
    if (!err) {
        next();
        return;
    }

    const isSizeError =
        err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE';
    res.status(isSizeError ? 413 : 400).json({
        success: false,
        message: isSizeError
            ? 'Image file is too large. Maximum size is 10MB.'
            : err.message || 'Invalid upload',
    });
}

function singleImageUpload(fieldName = 'image') {
    return [
        imageUpload.single(fieldName),
        handleUploadError,
    ];
}

async function compressUploadedImage(req, _res, next) {
    if (!req.file?.buffer || !String(req.file.mimetype || '').startsWith('image/')) {
        next();
        return;
    }

    try {
        const compressed = await sharp(req.file.buffer)
            .rotate()
            .resize({
                width: 1600,
                height: 1600,
                fit: 'inside',
                withoutEnlargement: true,
            })
            .flatten({ background: '#ffffff' })
            .jpeg({
                quality: 78,
                mozjpeg: true,
            })
            .toBuffer();

        req.file.buffer = compressed;
        req.file.size = compressed.length;
        req.file.mimetype = 'image/jpeg';
        req.file.originalname = String(req.file.originalname || 'image')
            .replace(/\.[^.]+$/, '') + '.jpg';
        next();
    } catch (error) {
        next(error);
    }
}

function handleImageCompressionError(err, _req, res, next) {
    if (!err) {
        next();
        return;
    }

    res.status(400).json({
        success: false,
        message: 'Could not compress uploaded image',
    });
}

function singleCompressedImageUpload(fieldName = 'image') {
    return [
        imageUpload.single(fieldName),
        handleUploadError,
        compressUploadedImage,
        handleImageCompressionError,
    ];
}

// Local storage for physical files if needed
const localDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(localDir)) {
    fs.mkdirSync(localDir, { recursive: true });
}

const r2rImageUpload = singleCompressedImageUpload('image');

export {
    upload,
    imageUpload,
    singleImageUpload,
    compressUploadedImage,
    handleImageCompressionError,
    singleCompressedImageUpload,
    r2rImageUpload,
};
