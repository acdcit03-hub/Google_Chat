import crypto from 'crypto';

/**
 * 16-byte unique public id for file-manager URLs (Google Drive–style).
 * Encoded as base64url → ~22 URL-safe characters (A-Za-z0-9_-).
 */
export function generatePublicId() {
    return crypto.randomBytes(16).toString('base64url');
}

export default generatePublicId;
