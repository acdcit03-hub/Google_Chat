import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import sharp from 'sharp';
import XLSX from 'xlsx';
import mammoth from 'mammoth';
import JSZip from 'jszip';
import { createCanvas } from '@napi-rs/canvas';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const require = createRequire(import.meta.url);

try {
    const workerPath = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;
} catch {
    /* worker optional in some environments */
}

const THUMB_WIDTH = Math.min(
    600,
    Math.max(300, Number(process.env.FILE_MANAGER_THUMB_SIZE) || 480),
);

const THUMB_HEIGHT = Math.round(THUMB_WIDTH * 1.25);
const CACHE_DIR_NAME = '.fm-thumbnails';

const IMAGE_EXTS = new Set([
    'jpg', 'jpeg', 'jpe', 'jfif', 'png', 'gif', 'webp', 'svg', 'bmp',
    'tif', 'tiff',
]);
const VIDEO_EXTS = new Set([
    'mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', 'wmv', 'flv', 'mpeg', 'mpg', '3gp',
]);
const AUDIO_EXTS = new Set([
    'mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'opus',
]);
/**
 * Never decode these with sharp — always return a generated extension-label WebP.
 * (ICO/CUR often native-crash libvips; video/zip OOMs if mis-sniffed as images.)
 */
const EXTENSION_ONLY_EXTS = new Set([
    'ico', 'cur',
    'mp4', 'mov', 'zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2',
]);
const SPREADSHEET_EXTS = new Set(['xls', 'xlsx', 'xlsm', 'csv']);
const WORD_EXTS = new Set(['doc', 'docx']);
const PPT_EXTS = new Set(['ppt', 'pptx']);
const PDF_EXTS = new Set(['pdf']);
const TEXT_EXTS = new Set(['txt', 'text', 'log', 'md']);

/** Avoid reading huge media into memory for thumbs (OOM / native sharp crashes). */
const MAX_IMAGE_THUMB_BYTES =
    Number(process.env.FILE_MANAGER_THUMB_MAX_BYTES) || 25 * 1024 * 1024;
const MAX_ICO_THUMB_BYTES = 5 * 1024 * 1024;

// Native Google Workspace MIME types. These files have no bytes of their own
// on disk — they must be exported via the Drive API before we can render
// anything for them.
const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';
const GOOGLE_SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const GOOGLE_SLIDES_MIME = 'application/vnd.google-apps.presentation';

const GOOGLE_EXPORT_MIME = {
    [GOOGLE_DOC_MIME]: {
        exportMime: 'application/vnd.openxmlformats-officedocument.wordformat',
        ext: 'docx',
    },
    [GOOGLE_SHEET_MIME]: {
        exportMime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ext: 'xlsx',
    },
    [GOOGLE_SLIDES_MIME]: {
        exportMime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        ext: 'pptx',
    },
};
// Fix the docx export mime above (kept as a separate const to avoid a typo slipping back in).
GOOGLE_EXPORT_MIME[GOOGLE_DOC_MIME].exportMime =
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** True for a file-manager item that is a native Google Doc/Sheet/Slides file (no local bytes). */
export function isGoogleNativeFile(item) {
    const source = String(item?.file_source || '').toLowerCase();
    const mime = String(item?.mime_type || item?.google_mime_type || '').toLowerCase();
    const ext = normalizeExtension(item?.extension || item?.name);
    if (mime && GOOGLE_EXPORT_MIME[mime]) return true;
    if (ext === 'gsheet' || ext === 'gdoc' || ext === 'gslides') return true;
    // Fall back to file_source/extension heuristics when no mime type is stored.
    if (source === 'google_doc' || source === 'google_docs' || source === 'gdocs' || source === 'gdoc') return true;
    if (source === 'google_sheet' || source === 'google_sheets' || source === 'gsheet') return true;
    if (source === 'google_slides') return true;
    return false;
}

function resolveGoogleExportInfo(item) {
    const mime = String(item?.mime_type || item?.google_mime_type || '').toLowerCase();
    if (mime && GOOGLE_EXPORT_MIME[mime]) return GOOGLE_EXPORT_MIME[mime];

    const ext = normalizeExtension(item?.extension || item?.name);
    if (ext === 'gdoc') return GOOGLE_EXPORT_MIME[GOOGLE_DOC_MIME];
    if (ext === 'gsheet') return GOOGLE_EXPORT_MIME[GOOGLE_SHEET_MIME];
    if (ext === 'gslides') return GOOGLE_EXPORT_MIME[GOOGLE_SLIDES_MIME];

    const source = String(item?.file_source || '').toLowerCase();
    if (source === 'google_doc' || source === 'google_docs' || source === 'gdocs' || source === 'gdoc') return GOOGLE_EXPORT_MIME[GOOGLE_DOC_MIME];
    if (source === 'google_sheet' || source === 'google_sheets' || source === 'gsheet') return GOOGLE_EXPORT_MIME[GOOGLE_SHEET_MIME];
    if (source === 'google_slides') return GOOGLE_EXPORT_MIME[GOOGLE_SLIDES_MIME];
    return null;
}

/**
 * Export a Google Doc/Sheet/Slides file as an Office-format buffer via the
 * Drive API. Uses the app's existing auth resolver (per-user token → env
 * refresh token → service account) rather than managing tokens itself.
 */
async function exportGoogleFileBuffer({ googleFileId, exportMime, drive }) {
    if (!googleFileId) {
        throw new Error('Missing googleFileId for Google file export');
    }
    if (!drive) {
        throw new Error('Missing authenticated Drive client for Google file export');
    }

    const res = await drive.files.export(
        { fileId: googleFileId, mimeType: exportMime },
        { responseType: 'arraybuffer' },
    );

    return Buffer.from(res.data);
}

async function generateGoogleFileThumbnail(item, { drive } = {}) {
    const info = resolveGoogleExportInfo(item);
    if (!info) {
        throw new Error('Unsupported Google file type for thumbnail generation');
    }

    const buffer = await exportGoogleFileBuffer({
        googleFileId: item?.google_file_id,
        exportMime: info.exportMime,
        drive,
    });

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-gthumb-'));
    const tmpPath = path.join(tmpDir, `export.${info.ext}`);
    try {
        fs.writeFileSync(tmpPath, buffer);
        if (info.ext === 'xlsx') {
            return await generateSpreadsheetThumbnail(tmpPath, 'xlsx');
        }
        if (info.ext === 'docx') {
            try {
                return await generateViaLibreOffice(tmpPath);
            } catch {
                return await generateDocxThumbnail(tmpPath, item?.name);
            }
        }
        if (info.ext === 'pptx') {
            try {
                return await generateViaLibreOffice(tmpPath);
            } catch {
                return await generatePptxThumbnail(tmpPath, item?.name);
            }
        }
        throw new Error(`No renderer for exported Google file type: ${info.ext}`);
    } finally {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
            /* ignore */
        }
    }
}

/** Microsoft Word/Excel lock owner files while a doc is open (not real content). */
export function isOfficeTempLockFile(fileName) {
    return String(fileName || '').trim().startsWith('~$');
}

export function normalizeExtension(nameOrExt) {
    return String(nameOrExt || '')
        .trim()
        .toLowerCase()
        .replace(/^\./, '')
        .split('.')
        .pop() || '';
}

export function usesExtensionOnlyThumbnail(ext) {
    return EXTENSION_ONLY_EXTS.has(normalizeExtension(ext));
}

export function isThumbnailSupported(ext) {
    const e = normalizeExtension(ext);
    // Content renderers (images/docs/pdf/…). Extension-only types still get a
    // generated extension-label image via getOrCreateThumbnail.
    return (
        IMAGE_EXTS.has(e) ||
        SPREADSHEET_EXTS.has(e) ||
        WORD_EXTS.has(e) ||
        PPT_EXTS.has(e) ||
        PDF_EXTS.has(e) ||
        TEXT_EXTS.has(e) ||
        e === 'url' ||
        e === 'gsheet' ||
        e === 'gdoc' ||
        e === 'gslides'
    );
}

/** WebP buffer with extension text (fallback when content thumb is impossible). */
export async function generateExtensionThumbnail(ext) {
    return generateGenericIcon(normalizeExtension(ext) || 'FILE');
}

function isVideoExt(ext) {
    return VIDEO_EXTS.has(normalizeExtension(ext));
}

function isAudioExt(ext) {
    return AUDIO_EXTS.has(normalizeExtension(ext));
}

/** MP4/MOV/M4V often start with a size dword then `ftyp`. */
function looksLikeFtypVideo(buf) {
    if (!buf || buf.length < 12) return false;
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    return b.toString('ascii', 4, 8) === 'ftyp';
}

export function buildThumbnailMeta(item) {
    const id = item?.id;
    const name = item?.name || '';
    // Every file gets a thumbnail URL — content preview when possible,
    // otherwise a backend-generated extension-label image (mp4/mov/zip/…).
    if (item?.item_type !== 'file' || id == null) {
        return {
            thumbnail_available: false,
            thumbnail_url: null,
        };
    }
    if (isOfficeTempLockFile(name)) {
        return {
            thumbnail_available: true,
            thumbnail_url: `/api/file-manager/files/${id}/thumbnail`,
        };
    }
    return {
        thumbnail_available: true,
        thumbnail_url: `/api/file-manager/files/${id}/thumbnail`,
    };
}

export function attachThumbnailMeta(items) {
    return (items || [])
        .filter((item) => !isOfficeTempLockFile(item?.name))
        .map((item) => {
            if (!item || item.item_type !== 'file') {
                return {
                    ...item,
                    thumbnail_available: false,
                    thumbnail_url: null,
                };
            }
            const source = String(item.file_source || 'local').toLowerCase();
            const isGoogleFile = source.startsWith('google_') || !!item.google_file_id;
            if (isGoogleFile && !isGoogleNativeFile(item)) {
                // A Google Drive item that isn't a native Doc/Sheet/Slides
                // (e.g. a PDF or image just stored in Drive) — no export
                // path for it here, so no thumbnail.
                return {
                    ...item,
                    thumbnail_available: false,
                    thumbnail_url: null,
                };
            }
            return {
                ...item,
                ...buildThumbnailMeta(item),
            };
        });
}

function escapeXml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function getCacheRoot(storageRoot) {
    const fromEnv = String(process.env.FILE_MANAGER_THUMB_CACHE || '').trim();
    const root = fromEnv
        ? path.resolve(fromEnv)
        : path.join(path.resolve(storageRoot), CACHE_DIR_NAME);
    fs.mkdirSync(root, { recursive: true });
    return root;
}

function cacheKey(itemId, stat) {
    const stamp = `${stat?.mtimeMs || 0}-${stat?.size || 0}`;
    const hash = crypto.createHash('sha1').update(stamp).digest('hex').slice(0, 12);
    return `${itemId}_${hash}.webp`;
}

function readCachedThumbnail(cachePath) {
    if (!fs.existsSync(cachePath)) return null;
    return fs.readFileSync(cachePath);
}

function writeCachedThumbnail(cachePath, buffer) {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, buffer);
}

async function svgToWebp(svg, width = THUMB_WIDTH) {
    return sharp(Buffer.from(svg, 'utf8'), { density: 160 })
        .resize({
            width,
            height: THUMB_HEIGHT,
            fit: 'inside',
            withoutEnlargement: false,
        })
        .webp({ quality: 78 })
        .toBuffer();
}

/**
 * Pull the largest embedded PNG out of a Windows ICO/CUR file.
 * Prefer PNG payloads only — DIB→BMP conversion often native-crashes sharp/libvips.
 * Sharp cannot decode ICO directly (libvips has no ico input).
 */
function extractIcoImageBuffer(icoBuf) {
    const buf = Buffer.isBuffer(icoBuf) ? icoBuf : Buffer.from(icoBuf);
    if (buf.length < 6) {
        throw new Error('Invalid ICO file');
    }
    if (looksLikeFtypVideo(buf)) {
        throw new Error('Not an ICO (ftyp video container)');
    }
    const type = buf.readUInt16LE(2);
    const count = buf.readUInt16LE(4);
    // Real ICOs have a small directory count; MP4/MOV size-dwords often look like type=1
    if ((type !== 1 && type !== 2) || count < 1 || count > 64) {
        throw new Error('Invalid ICO header');
    }

    let bestPng = null;
    for (let i = 0; i < count; i += 1) {
        const entryOffset = 6 + i * 16;
        if (entryOffset + 16 > buf.length) break;
        let width = buf[entryOffset];
        let height = buf[entryOffset + 1];
        if (width === 0) width = 256;
        if (height === 0) height = 256;
        const bytesInRes = buf.readUInt32LE(entryOffset + 8);
        const imgOffset = buf.readUInt32LE(entryOffset + 12);
        if (
            !Number.isFinite(bytesInRes) ||
            !Number.isFinite(imgOffset) ||
            bytesInRes < 8 ||
            imgOffset < 6 ||
            imgOffset + bytesInRes > buf.length
        ) {
            continue;
        }
        const data = buf.subarray(imgOffset, imgOffset + bytesInRes);
        const isPng =
            data[0] === 0x89 &&
            data[1] === 0x50 &&
            data[2] === 0x4e &&
            data[3] === 0x47;
        if (!isPng) continue;
        const area = width * height;
        if (!bestPng || area > bestPng.area) {
            bestPng = { area, data: Buffer.from(data) };
        }
    }

    if (!bestPng) {
        throw new Error('ICO has no embedded PNG (DIB icons skipped for stability)');
    }
    return bestPng.data;
}

/**
 * Detect raster/vector image kind from magic bytes (extension-independent).
 * @returns {'jpeg'|'png'|'gif'|'webp'|'bmp'|'ico'|'svg'|'pdf'|null}
 */
function sniffImageKind(buf) {
    if (!buf || buf.length < 4) return null;
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);

    // Never treat media containers as images (MOV/MP4 size dword can look like ICO)
    if (looksLikeFtypVideo(b)) return null;
    if (
        b.length >= 12 &&
        b.toString('ascii', 0, 4) === 'RIFF' &&
        ['AVI ', 'AVIX', 'WAVE', 'WAV '].includes(b.toString('ascii', 8, 12))
    ) {
        return null;
    }

    // JPEG
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
    // PNG
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
    // GIF
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif';
    // BMP
    if (b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
    // WEBP (RIFF....WEBP)
    if (
        b.length >= 12 &&
        b.toString('ascii', 0, 4) === 'RIFF' &&
        b.toString('ascii', 8, 12) === 'WEBP'
    ) {
        return 'webp';
    }
    // ICO / CUR — require plausible image count (avoids MP4 `00 00 01 00 …` false positives)
    if (
        b.length >= 6 &&
        b[0] === 0x00 &&
        b[1] === 0x00 &&
        (b[2] === 0x01 || b[2] === 0x02) &&
        b[3] === 0x00
    ) {
        const count = b.readUInt16LE(4);
        if (count >= 1 && count <= 64 && 6 + count * 16 <= b.length + 16 * 64) {
            return 'ico';
        }
        return null;
    }
    // SVG (text)
    const head = b.subarray(0, Math.min(256, b.length)).toString('utf8').trim().toLowerCase();
    if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) {
        return 'svg';
    }
    // PDF
    if (b.subarray(0, 5).toString('ascii') === '%PDF-') return 'pdf';
    return null;
}

async function rasterToWebpThumbnail(input) {
    const options = { failOn: 'none', animated: false, density: 144 };
    try {
        return await sharp(input, options)
            .rotate()
            .resize({
                width: THUMB_WIDTH,
                height: THUMB_HEIGHT,
                fit: 'inside',
                withoutEnlargement: true,
            })
            .webp({ quality: 78 })
            .toBuffer();
    } catch {
        // CMYK / odd colorspace / truncated files — force sRGB and retry
        return sharp(input, options)
            .rotate()
            .toColorspace('srgb')
            .resize({
                width: THUMB_WIDTH,
                height: THUMB_HEIGHT,
                fit: 'inside',
                withoutEnlargement: true,
            })
            .webp({ quality: 72 })
            .toBuffer();
    }
}

async function generateImageThumbnail(absPath, ext = '') {
    const normalized = normalizeExtension(ext || path.extname(absPath));
    const st = await fs.promises.stat(absPath);
    const isIco =
        normalized === 'ico' ||
        normalized === 'cur';

    if (isIco && st.size > MAX_ICO_THUMB_BYTES) {
        throw new Error('ICO too large for thumbnail');
    }
    if (st.size > MAX_IMAGE_THUMB_BYTES) {
        throw new Error('Image too large for thumbnail');
    }

    const fileBuf = await fs.promises.readFile(absPath);
    if (looksLikeFtypVideo(fileBuf)) {
        throw new Error('Video container cannot be rasterized as image');
    }
    const sniffed = sniffImageKind(fileBuf) || normalized;

    if (sniffed === 'ico' || sniffed === 'cur' || isIco) {
        const imageBuf = extractIcoImageBuffer(fileBuf);
        return rasterToWebpThumbnail(imageBuf);
    }

    // jpeg / png / gif / webp / bmp / tiff / svg — pass buffer so wrong
    // extensions (e.g. .jpg saved as .bin) still work via magic bytes
    return rasterToWebpThumbnail(fileBuf);
}

function isImageLike(ext, mimeType) {
    const e = normalizeExtension(ext);
    // Never treat video/audio/ico as decodeable images (sharp crash / OOM)
    if (isVideoExt(e) || isAudioExt(e) || usesExtensionOnlyThumbnail(e)) {
        return false;
    }
    if (IMAGE_EXTS.has(e)) return true;
    const mime = String(mimeType || '').toLowerCase();
    if (mime.startsWith('video/') || mime.startsWith('audio/')) return false;
    if (
        mime === 'image/x-icon' ||
        mime === 'image/vnd.microsoft.icon' ||
        mime === 'image/ico'
    ) {
        return false;
    }
    return (
        mime.startsWith('image/') ||
        mime === 'image/jpg' ||
        mime === 'image/pjpeg'
    );
}

function buildSpreadsheetSvg(matrix, title = 'Sheet') {
    const rows = (matrix || []).slice(0, 14).map((row) =>
        (Array.isArray(row) ? row : []).slice(0, 6).map((c) => String(c ?? '')),
    );
    const cols = Math.max(3, ...rows.map((r) => r.length), 3);
    const normalized = rows.map((r) => {
        const padded = [...r];
        while (padded.length < cols) padded.push('');
        return padded;
    });
    if (!normalized.length) {
        normalized.push(Array(cols).fill(''));
    }

    const pad = 16;
    const headerH = 36;
    const rowH = 28;
    const colW = Math.floor((THUMB_WIDTH - pad * 2) / cols);
    const width = THUMB_WIDTH;
    const height = Math.min(THUMB_HEIGHT, headerH + pad * 2 + normalized.length * rowH + 8);

    let cells = '';
    normalized.forEach((row, ri) => {
        row.forEach((cell, ci) => {
            const x = pad + ci * colW;
            const y = headerH + pad + ri * rowH;
            const isHeader = ri === 0;
            cells += `
              <rect x="${x}" y="${y}" width="${colW}" height="${rowH}"
                    fill="${isHeader ? '#e8f5e9' : '#ffffff'}" stroke="#c8e6c9" stroke-width="1"/>
              <text x="${x + 6}" y="${y + 18}" font-family="Segoe UI, Arial, sans-serif"
                    font-size="11" font-weight="${isHeader ? '700' : '400'}" fill="#1b5e20">
                ${escapeXml(String(cell).slice(0, 18))}
              </text>`;
        });
    });

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#f7faf7"/>
  <rect x="0" y="0" width="${width}" height="${headerH}" fill="#2e7d32"/>
  <text x="14" y="24" font-family="Segoe UI, Arial, sans-serif" font-size="14"
        font-weight="700" fill="#ffffff">${escapeXml(String(title).slice(0, 40))}</text>
  ${cells}
</svg>`;
}

async function generateSpreadsheetThumbnail(absPath, ext) {
    let matrix = [];
    let sheetName = 'Sheet1';

    if (ext === 'csv') {
        const raw = fs.readFileSync(absPath, 'utf8');
        const wb = XLSX.read(raw, { type: 'string', sheetRows: 16 });
        sheetName = wb.SheetNames[0] || 'Sheet1';
        matrix = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], {
            header: 1,
            defval: '',
            raw: false,
        });
    } else {
        const wb = XLSX.readFile(absPath, { sheetRows: 16, cellDates: true });
        sheetName = wb.SheetNames[0] || 'Sheet1';
        matrix = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], {
            header: 1,
            defval: '',
            raw: false,
        });
    }

    return svgToWebp(buildSpreadsheetSvg(matrix, sheetName));
}

function buildDocumentSvg(lines, { title = 'Document', accent = '#1565c0' } = {}) {
    const width = THUMB_WIDTH;
    const height = THUMB_HEIGHT;
    const pad = 20;
    const lineH = 16;
    const maxLines = Math.floor((height - 56) / lineH);
    const shown = (lines || []).slice(0, maxLines);

    const textNodes = shown
        .map((line, i) => {
            const y = 52 + i * lineH;
            return `<text x="${pad}" y="${y}" font-family="Consolas, Segoe UI, monospace"
              font-size="12" fill="#263238">${escapeXml(String(line).slice(0, 70))}</text>`;
        })
        .join('\n');

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <rect x="0" y="0" width="${width}" height="36" fill="${accent}"/>
  <text x="14" y="24" font-family="Segoe UI, Arial, sans-serif" font-size="13"
        font-weight="700" fill="#ffffff">${escapeXml(String(title).slice(0, 42))}</text>
  <rect x="10" y="44" width="${width - 20}" height="${height - 54}" rx="6"
        fill="#fafafa" stroke="#e0e0e0"/>
  ${textNodes}
</svg>`;
}

async function generateTextThumbnail(absPath, fileName) {
    let text = fs.readFileSync(absPath, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const lines = text.split(/\r?\n/);
    return svgToWebp(buildDocumentSvg(lines, { title: fileName || 'Text', accent: '#1976d2' }));
}

async function generatePdfThumbnail(absPath) {
    const data = new Uint8Array(fs.readFileSync(absPath));

    let standardFontDataUrl;
    try {
        const pdfjsRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
        const fontsDir = path.join(pdfjsRoot, 'standard_fonts');
        if (fs.existsSync(fontsDir)) {
            standardFontDataUrl = pathToFileURL(fontsDir + path.sep).href;
        }
    } catch {
        /* optional */
    }

    class NodeCanvasFactory {
        create(width, height) {
            const canvas = createCanvas(Math.max(1, Math.ceil(width)), Math.max(1, Math.ceil(height)));
            return { canvas, context: canvas.getContext('2d') };
        }
        reset(canvasAndContext, width, height) {
            canvasAndContext.canvas.width = Math.max(1, Math.ceil(width));
            canvasAndContext.canvas.height = Math.max(1, Math.ceil(height));
        }
        destroy(canvasAndContext) {
            canvasAndContext.canvas.width = 0;
            canvasAndContext.canvas.height = 0;
            canvasAndContext.canvas = null;
            canvasAndContext.context = null;
        }
    }

    const canvasFactory = new NodeCanvasFactory();
    const loadingTask = pdfjs.getDocument({
        data,
        disableWorker: true,
        useSystemFonts: true,
        isEvalSupported: false,
        ...(standardFontDataUrl ? { standardFontDataUrl } : {}),
        canvasFactory,
    });

    const pdf = await loadingTask.promise;
    try {
        const page = await pdf.getPage(1);
        const unscaled = page.getViewport({ scale: 1 });
        const scale = THUMB_WIDTH / Math.max(unscaled.width, 1);
        const viewport = page.getViewport({ scale });
        const canvasAndContext = canvasFactory.create(
            viewport.width,
            viewport.height,
        );

        // White page background (transparent canvas looks black in UI)
        canvasAndContext.context.fillStyle = '#ffffff';
        canvasAndContext.context.fillRect(
            0,
            0,
            canvasAndContext.canvas.width,
            canvasAndContext.canvas.height,
        );

        try {
            await page.render({
                canvasContext: canvasAndContext.context,
                viewport,
                canvasFactory,
            }).promise;

            const png = canvasAndContext.canvas.toBuffer('image/png');
            return await sharp(png, { failOn: 'none' })
                .resize({
                    width: THUMB_WIDTH,
                    height: THUMB_HEIGHT,
                    fit: 'inside',
                    withoutEnlargement: true,
                })
                .webp({ quality: 78 })
                .toBuffer();
        } catch (renderErr) {
            // Font/path render often fails on Node canvas — fall back to text preview
            console.warn(
                'PDF page render failed, using text preview:',
                renderErr?.message || renderErr,
            );
            const textContent = await page.getTextContent().catch(() => null);
            const lines = (textContent?.items || [])
                .map((it) => String(it?.str || '').trim())
                .filter(Boolean);
            if (lines.length) {
                return svgToWebp(
                    buildDocumentSvg(lines.slice(0, 24), {
                        title: path.basename(absPath) || 'PDF',
                        accent: '#c62828',
                    }),
                );
            }
            throw renderErr;
        } finally {
            canvasFactory.destroy(canvasAndContext);
        }
    } finally {
        try {
            await pdf.destroy();
        } catch {
            /* ignore */
        }
    }
}

async function generateDocxThumbnail(absPath, fileName) {
    const result = await mammoth.extractRawText({ path: absPath });
    const lines = String(result.value || '')
        .split(/\r?\n/)
        .map((l) => l.trimEnd())
        .filter((l, idx, arr) => l || (arr[idx - 1] && arr[idx - 1].trim()));
    return svgToWebp(
        buildDocumentSvg(lines.length ? lines : ['(Empty document)'], {
            title: fileName || 'Word',
            accent: '#1565c0',
        }),
    );
}

function extractTextFromXml(xml) {
    const matches = String(xml || '').match(/<a:t[^>]*>([\s\S]*?)<\/a:t>/gi) || [];
    const parts = matches.map((m) =>
        m
            .replace(/<a:t[^>]*>/i, '')
            .replace(/<\/a:t>/i, '')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .trim(),
    ).filter(Boolean);
    return parts.join('\n');
}

async function generatePptxThumbnail(absPath, fileName) {
    const buf = fs.readFileSync(absPath);
    const zip = await JSZip.loadAsync(buf);
    let slideEntry = zip.file('ppt/slides/slide1.xml');
    if (!slideEntry) {
        const key = Object.keys(zip.files).find((k) =>
            /ppt\/slides\/slide\d+\.xml$/i.test(k),
        );
        if (key) slideEntry = zip.file(key);
    }
    let lines = ['(Empty slide)'];
    if (slideEntry) {
        const xml = await slideEntry.async('string');
        const text = extractTextFromXml(xml);
        if (text) {
            lines = text.split(/\n+/).flatMap((line) => {
                const chunks = line.match(/.{1,60}(\s|$)/g);
                return chunks && chunks.length ? chunks : [line.slice(0, 60)];
            });
        }
    }
    return svgToWebp(
        buildDocumentSvg(lines.slice(0, 20), {
            title: fileName || 'PowerPoint',
            accent: '#e65100',
        }),
    );
}

function findLibreOfficeBinary() {
    const fromEnv = String(process.env.LIBREOFFICE_PATH || '').trim();
    if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

    const candidates = [
        'soffice',
        'libreoffice',
        'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
        'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
        '/usr/bin/soffice',
        '/usr/bin/libreoffice',
        '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    ];
    for (const c of candidates) {
        if (c.includes('\\') || c.startsWith('/')) {
            if (fs.existsSync(c)) return c;
        }
    }
    return fromEnv || 'soffice';
}

function runCommand(bin, args, opts = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(bin, args, {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            ...opts,
        });
        let stderr = '';
        child.stderr.on('data', (d) => {
            stderr += String(d);
        });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(stderr || `Command failed (${code})`));
        });
    });
}

async function convertWithLibreOffice(absPath, outDir) {
    const bin = findLibreOfficeBinary();
    fs.mkdirSync(outDir, { recursive: true });
    await runCommand(bin, [
        '--headless',
        '--nologo',
        '--nolockcheck',
        '--nodefault',
        '--norestore',
        '--convert-to',
        'pdf',
        '--outdir',
        outDir,
        absPath,
    ]);
    const base = path.basename(absPath, path.extname(absPath));
    const pdfPath = path.join(outDir, `${base}.pdf`);
    if (!fs.existsSync(pdfPath)) {
        throw new Error('LibreOffice did not produce a PDF');
    }
    return pdfPath;
}

async function generateViaLibreOffice(absPath) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-thumb-'));
    try {
        const pdfPath = await convertWithLibreOffice(absPath, tmp);
        return await generatePdfThumbnail(pdfPath);
    } finally {
        try {
            fs.rmSync(tmp, { recursive: true, force: true });
        } catch {
            /* ignore */
        }
    }
}

/** Tiny 1×1 PNG — absolute last resort if sharp is unavailable. */
function minimalPngBuffer() {
    return Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
    );
}

async function generateGenericIcon(ext) {
    const label = String(ext || 'FILE').toUpperCase().slice(0, 6) || 'FILE';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${THUMB_WIDTH}" height="${THUMB_HEIGHT}" viewBox="0 0 ${THUMB_WIDTH} ${THUMB_HEIGHT}">
  <rect width="100%" height="100%" fill="#eceff1"/>
  <rect x="${THUMB_WIDTH * 0.2}" y="${THUMB_HEIGHT * 0.22}" width="${THUMB_WIDTH * 0.6}" height="${THUMB_HEIGHT * 0.56}" rx="16" fill="#607d8b"/>
  <text x="50%" y="54%" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif"
        font-size="42" font-weight="700" fill="#ffffff">${escapeXml(label)}</text>
</svg>`;
    try {
        return await svgToWebp(svg);
    } catch (err) {
        console.warn('generateGenericIcon sharp failed:', err?.message || err);
        return minimalPngBuffer();
    }
}

/**
 * Generate (or read cached) WebP thumbnail bytes for a file.
 * Never returns the original file bytes.
 */
export async function getOrCreateThumbnail({
    itemId,
    absPath,
    fileName,
    extension,
    storageRoot,
    stat,
    item,
    googleDrive,
}) {
    const ext = normalizeExtension(extension || fileName);
    const cacheRoot = getCacheRoot(storageRoot);

    // Google-native files (Docs/Sheets/Slides) have no local bytes/stat to
    // key the cache off, so key on the file's Drive id + modified time instead.
    const isGoogleFile = !!item && isGoogleNativeFile(item);
    const cacheStat = isGoogleFile
        ? { mtimeMs: item?.modified_time ? new Date(item.modified_time).getTime() : 0, size: 0 }
        : stat;
    const cacheItemId = isGoogleFile ? (item?.google_file_id || itemId) : itemId;
    const cachePath = path.join(cacheRoot, cacheKey(cacheItemId, cacheStat));

    const cached = readCachedThumbnail(cachePath);
    if (cached?.length) {
        return { buffer: cached, contentType: 'image/webp', cached: true };
    }

    if (isGoogleFile) {
        try {
            const buffer = await generateGoogleFileThumbnail(item, {
                drive: googleDrive,
            });
            if (!buffer?.length) {
                throw new Error('Empty buffer from Google file export');
            }
            try {
                writeCachedThumbnail(cachePath, buffer);
            } catch (err) {
                console.warn('thumbnail cache write failed:', err.message);
            }
            return { buffer, contentType: 'image/webp', cached: false };
        } catch (err) {
            // Shortcut .url tagged as gsheet/gdoc without Drive access → branded icon
            try {
                const fallbackExt =
                    normalizeExtension(item?.extension) || ext || 'FILE';
                const buffer = await generateGenericIcon(fallbackExt);
                try {
                    writeCachedThumbnail(cachePath, buffer);
                } catch {
                    /* ignore */
                }
                return { buffer, contentType: 'image/webp', cached: false };
            } catch {
                const error = new Error('Thumbnail is not available for this file type.');
                error.code = 'THUMBNAIL_UNAVAILABLE';
                error.cause = err;
                throw error;
            }
        }
    }

    // Internet shortcuts (.url) — branded icon (no local document bytes)
    if (ext === 'url') {
        const buffer = await generateGenericIcon('URL');
        try {
            writeCachedThumbnail(cachePath, buffer);
        } catch {
            /* ignore */
        }
        return { buffer, contentType: 'image/webp', cached: false };
    }

    // Office lock files (~$...) are not real documents — return generic icon, not 422
    if (isOfficeTempLockFile(fileName)) {
        const buffer = await generateGenericIcon(ext);
        try {
            writeCachedThumbnail(cachePath, buffer);
        } catch {
            /* ignore */
        }
        return { buffer, contentType: 'image/webp', cached: false };
    }

    // mp4 / mov / zip (+ archives) and other video/audio → extension-label image
    if (
        usesExtensionOnlyThumbnail(ext) ||
        isVideoExt(ext) ||
        isAudioExt(ext)
    ) {
        const buffer = await generateExtensionThumbnail(ext);
        try {
            writeCachedThumbnail(cachePath, buffer);
        } catch {
            /* ignore */
        }
        return { buffer, contentType: 'image/webp', cached: false };
    }

    let buffer = null;
    const mimeType = item?.mime_type || null;
    const mimeLower = String(mimeType || '').toLowerCase();
    if (mimeLower.startsWith('video/') || mimeLower.startsWith('audio/')) {
        const iconBuf = await generateExtensionThumbnail(ext || 'MEDIA');
        try {
            writeCachedThumbnail(cachePath, iconBuf);
        } catch {
            /* ignore */
        }
        return { buffer: iconBuf, contentType: 'image/webp', cached: false };
    }

    // Sniff local bytes so mislabeled .jpeg/.webp/.png still get image thumbs
    let sniffedKind = null;
    if (absPath && fs.existsSync(absPath)) {
        try {
            const fd = fs.openSync(absPath, 'r');
            const head = Buffer.alloc(32);
            fs.readSync(fd, head, 0, 32, 0);
            fs.closeSync(fd);
            if (looksLikeFtypVideo(head)) {
                sniffedKind = null;
            } else {
                sniffedKind = sniffImageKind(head);
            }
        } catch {
            sniffedKind = null;
        }
    }

    try {
        // Never decode ICO/CUR bytes (libvips crash) — extension image only
        if (ext === 'ico' || ext === 'cur' || sniffedKind === 'ico') {
            buffer = await generateExtensionThumbnail(ext || 'ICO');
        } else if (
            isImageLike(ext, mimeType) ||
            (sniffedKind && sniffedKind !== 'pdf' && sniffedKind !== 'ico')
        ) {
            buffer = await generateImageThumbnail(
                absPath,
                sniffedKind || ext || mimeType,
            );
        } else if (SPREADSHEET_EXTS.has(ext)) {
            buffer = await generateSpreadsheetThumbnail(absPath, ext);
        } else if (TEXT_EXTS.has(ext)) {
            buffer = await generateTextThumbnail(absPath, fileName);
        } else if (PDF_EXTS.has(ext) || sniffedKind === 'pdf' || mimeType === 'application/pdf') {
            buffer = await generatePdfThumbnail(absPath);
        } else if (ext === 'docx') {
            try {
                buffer = await generateViaLibreOffice(absPath);
            } catch {
                buffer = await generateDocxThumbnail(absPath, fileName);
            }
        } else if (ext === 'pptx') {
            try {
                buffer = await generateViaLibreOffice(absPath);
            } catch {
                buffer = await generatePptxThumbnail(absPath, fileName);
            }
        } else if (WORD_EXTS.has(ext) || PPT_EXTS.has(ext)) {
            buffer = await generateViaLibreOffice(absPath);
        } else if (isThumbnailSupported(ext)) {
            buffer = await generateViaLibreOffice(absPath);
        } else {
            buffer = await generateGenericIcon(ext);
        }
    } catch (err) {
        // Content thumb failed → extension-label image (never crash / leave empty)
        console.warn(
            'thumbnail content render failed, using extension image:',
            ext,
            err?.message || err,
        );
        try {
            buffer = await generateExtensionThumbnail(ext || 'FILE');
        } catch (fallbackErr) {
            const error = new Error('Thumbnail is not available for this file type.');
            error.code = 'THUMBNAIL_UNAVAILABLE';
            error.cause = fallbackErr;
            throw error;
        }
    }

    if (!buffer?.length) {
        buffer = await generateExtensionThumbnail(ext || 'FILE');
    }

    try {
        writeCachedThumbnail(cachePath, buffer);
    } catch (err) {
        console.warn('thumbnail cache write failed:', err.message);
    }

    return { buffer, contentType: 'image/webp', cached: false };
}

export default {
    isThumbnailSupported,
    usesExtensionOnlyThumbnail,
    isOfficeTempLockFile,
    isGoogleNativeFile,
    buildThumbnailMeta,
    attachThumbnailMeta,
    getOrCreateThumbnail,
    generateExtensionThumbnail,
    normalizeExtension,
};