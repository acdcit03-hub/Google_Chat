/**
 * R2R requirement images — Cloudinary only.
 * - Upload / paste (base64, data URL, file buffer) → Cloudinary URL
 * - Store-transaction / external https URL → stored as-is in REQUIREMENT columns
 */

import path from 'path';
import dotenv from 'dotenv';
import { v2 as cloudinary } from 'cloudinary';

dotenv.config();

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

function sanitizeSerialForFilename(serial) {
    const s = String(serial || 'unknown')
        .trim()
        .replace(/-+/g, '-')
        .replace(/[^a-zA-Z0-9._-]/g, '_');
    return s || 'unknown';
}

function extFromUpload(filetype, originalName) {
    const fromName = path
        .extname(String(originalName || ''))
        .replace('.', '')
        .toLowerCase();
    if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(fromName)) {
        return fromName === 'jpeg' ? 'jpg' : fromName;
    }
    const part = String(filetype || '')
        .split('/')[1]
        ?.toLowerCase();
    if (part === 'jpeg') return 'jpg';
    if (['jpg', 'png', 'gif', 'webp'].includes(part)) return part;
    return 'jpg';
}

function buildR2rStoredFilename(serialNumber, options = {}) {
    const serial = sanitizeSerialForFilename(serialNumber);
    const bill =
        options.suffix === '_bill' ||
        String(options.kind || '').toLowerCase() === 'bill';
    const suffix = bill ? '_bill' : '';
    const ext = extFromUpload(options.filetype, options.originalName);
    return `${serial}${suffix}.${ext}`;
}

function isDataUrl(value) {
    return /^data:image\/[a-z0-9+.-]+;base64,/i.test(String(value || '').trim());
}

function isLikelyBase64(value) {
    const t = String(value || '').trim();
    return t.length > 256 && /^[A-Za-z0-9+/=\s]+$/.test(t);
}

function isHttpUrl(value) {
    const t = String(value || '').trim();
    return t.startsWith('http://') || t.startsWith('https://');
}

function isCloudinaryUrl(value) {
    return /res\.cloudinary\.com/i.test(String(value || '').trim());
}

function isLegacyDbImageRef(value) {
    const t = String(value || '').trim();
    return (
        t.startsWith('r2r-file:') ||
        t.startsWith('/api/images/r2r/') ||
        t.startsWith('images/r2r/')
    );
}

function ensureCloudinaryConfigured() {
    if (
        !process.env.CLOUDINARY_CLOUD_NAME ||
        !process.env.CLOUDINARY_API_KEY ||
        !process.env.CLOUDINARY_API_SECRET
    ) {
        throw new Error('Cloudinary is not configured on the server');
    }
}

async function uploadImageToCloudinary(imagePayload, serialNumber, options = {}) {
    ensureCloudinaryConfigured();

    const serial = sanitizeSerialForFilename(serialNumber);
    const bill =
        options.suffix === '_bill' ||
        String(options.kind || '').toLowerCase() === 'bill';
    const timestamp = Date.now();
    const publicId = `r2r/requirements/${serial}${bill ? '_bill' : ''}_${timestamp}`;

    const uploadResult = await cloudinary.uploader.upload(imagePayload, {
        public_id: publicId,
        resource_type: 'image',
        transformation: [
            { width: 1200, height: 1200, crop: 'limit' },
            { quality: 'auto' },
        ],
    });

    return uploadResult.secure_url;
}

/**
 * Normalize value for `product_photo` / `bill_or_product_photo`.
 */
async function saveR2rProductPhoto(serialNumber, imageInput, options = {}) {
    if (imageInput == null || imageInput === '') return null;

    if (Buffer.isBuffer(imageInput)) {
        const base64Image = `data:${options.mime || 'image/jpeg'};base64,${imageInput.toString('base64')}`;
        return uploadImageToCloudinary(base64Image, serialNumber, options);
    }

    if (typeof imageInput !== 'string') return null;

    const trimmed = imageInput.trim();
    if (!trimmed || trimmed === 'null' || trimmed === 'undefined') {
        return null;
    }

    if (isLegacyDbImageRef(trimmed)) {
        return null;
    }

    if (isHttpUrl(trimmed) || isCloudinaryUrl(trimmed)) {
        return trimmed;
    }

    if (isDataUrl(trimmed)) {
        return uploadImageToCloudinary(trimmed, serialNumber, options);
    }

    if (isLikelyBase64(trimmed)) {
        const dataUrl = `data:image/jpeg;base64,${trimmed.replace(/\s/g, '')}`;
        return uploadImageToCloudinary(dataUrl, serialNumber, options);
    }

    if (trimmed.length <= 128) {
        return trimmed;
    }

    return null;
}

async function saveR2rProductPhotoFromUpload(file, serialNumber, options = {}) {
    if (!file || !file.buffer || !file.buffer.length) return null;

    const base64Image = `data:${file.mimetype || 'image/jpeg'};base64,${file.buffer.toString('base64')}`;
    return uploadImageToCloudinary(base64Image, serialNumber, options);
}

export {
    saveR2rProductPhoto,
    saveR2rProductPhotoFromUpload,
    buildR2rStoredFilename,
    sanitizeSerialForFilename,
};
