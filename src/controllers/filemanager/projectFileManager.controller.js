import path from 'path';
import fs from 'fs';
import ProjectFileManagerModel from '../../models/filemanager/projectFileManager.model.js';
import { writeFileManagerLog } from '../../models/filemanager/fileManagerLog.model.js';
import FileManagerSettingModel from '../../models/filemanager/fileManagerSetting.model.js';
import CategoriesFolderStructureModel from '../../models/filemanager/categoriesFolderStructure.model.js';
import FinancialYearFileManagerModel, {
    getProjectFileManagerRootPath,
    ensureFinancialYearFolderByCode,
    ensureFinancialYearFolders,
} from '../../models/filemanager/financialYearFileManager.model.js';

import FinancialYearModel from '../../models/settings/financial-year.model.js';
import ProjectModel from '../../models/projectsheet/project.model.js';
import PCBModel from '../../models/projectsheet/pcb.model.js';
import CategoryModel from '../../models/timesheet/category.model.js';
import { wrapController } from '../../middleware/error.middleware.js';
import { listDiskChildren } from '../../services/filemanager/diskChildren.js';
import {
    resolveActor,
    unauthorized,
    notFound,
    sanitizeFolderName,
} from './fileManager.controller.js';
import GoogleFileService from '../../services/filemanager/googleFile.service.js';
import {
    ensureProjectGoogleDriveFolder,
} from '../../services/filemanager/googleDriveFolders.service.js';
import {
    createGoogleShortcut,
    removeGoogleShortcut,
} from './CreateApi/createshortcut.js';
import { collectProjectGoogleEditorEmails } from './CreateApi/googleShareHelpers.js';

function parseId(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
}

async function syncProjectGoogleDriveFolder(folder, userId) {
    const driveFolderId = await ensureProjectGoogleDriveFolder(
        userId,
        folder.project_code,
    );
    if (String(folder.google_drive_folder_id || '') === driveFolderId) {
        return folder;
    }
    return (
        (await ProjectFileManagerModel.update(folder.id, {
            google_drive_folder_id: driveFolderId,
        })) || { ...folder, google_drive_folder_id: driveFolderId }
    );
}

/** In-app File Manager URL for a project root folder (PROJECT.filemanager_link). */
function projectFolderAppLink(publicId) {
    const id = String(publicId ?? '').trim();
    if (!id) return '';
    return `/fileManager/folders/${encodeURIComponent(id)}`;
}

function pcbAssignmentFolderLink(folders, projectCode, pcbCode) {
    const list = Array.isArray(folders) ? folders : [];
    const pcb = String(pcbCode || '').trim().toUpperCase();
    const project = String(projectCode || '').trim().toUpperCase();
    const rootName = pcb ? `${project}_${pcb}` : '';
    const withId = list.filter((folder) => String(folder?.public_id || '').trim());
    const root = withId.find((folder) => {
        const name = String(folder?.folder_name || folder?.name || '').trim().toUpperCase();
        return rootName && name === rootName;
    });
    const named = withId.find((folder) => {
        const name = String(folder?.folder_name || folder?.name || '').trim().toUpperCase();
        return pcb && name.includes(`_${pcb}`);
    });
    return projectFolderAppLink((root || named)?.public_id);
}

async function syncProjectFolderLink(projectId, publicId) {
    const pid = parseId(projectId);
    const filemanagerLink = projectFolderAppLink(publicId);
    if (!pid || !filemanagerLink) return null;
    try {
        // Stores filemanager_link (+ drive_link for older clients)
        return await ProjectModel.updateProjectFolderLink(pid, filemanagerLink);
    } catch (err) {
        console.warn(
            '[ProjectFileManager] Could not store project filemanager_link:',
            err?.message || err,
        );
        return null;
    }
}

function extractSpreadsheetIdFromUrl(url) {
    const raw = String(url || '').trim();
    if (!raw) return '';
    const m = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    return m?.[1] || '';
}

async function getProjectDriveFolderId(projectFolderId) {
    const projectFolder = await ProjectFileManagerModel.findById(projectFolderId);
    return String(projectFolder?.google_drive_folder_id || '').trim();
}

async function resolveGoogleAuthUserId(projectFolder) {
    const fromFolder = parseId(projectFolder?.owner_id);
    if (fromFolder) return fromFolder;
    const owners = await FileManagerSettingModel.findActiveOwners();
    const withAccess = (owners || []).find((o) => o.access === true);
    const first = withAccess || (owners || [])[0];
    return parseId(first?.owner_id);
}

function normalizeUserPayload(raw, assignedByUsername) {
    if (!raw || typeof raw !== 'object') return null;

    const userId = parseId(raw.user_id ?? raw.userId);
    const username = String(raw.username ?? raw.user_name ?? '').trim();
    if (!userId || !username) return null;

    const roleRaw =
        raw.role ?? raw.permission_role ?? raw.permissionRole ?? null;
    let role = roleRaw != null ? String(roleRaw).trim().toLowerCase() : '';
    if (!['owner', 'editor', 'viewer'].includes(role)) {
        role = 'viewer';
    }

    return {
        user_id: userId,
        username,
        role,
        assigned_by_username: assignedByUsername,
    };
}

/** POST create payload users: only user_id + username */
function normalizeAssignUserIdentity(raw) {
    if (!raw || typeof raw !== 'object') return null;   
    const userId = parseId(raw.user_id ?? raw.userId);
    const username = String(raw.username ?? raw.user_name ?? '').trim();
    if (!userId || !username) return null;
    return { user_id: userId, username };
}

function roleShare(role, assignedByUsername, isChildShare = true) {
    return {
        role: String(role || 'viewer').trim().toLowerCase(),
        assigned_by_username: assignedByUsername,
        is_childshare: isChildShare !== false,
    };
}

function normalizeAssignUsers(body) {
    if (Array.isArray(body?.users)) return body.users;
    if (Array.isArray(body?.assign_users)) return body.assign_users;
    if (Array.isArray(body?.assigned_users)) return body.assigned_users;
    if (Array.isArray(body?.assignUsers)) return body.assignUsers;
    return [];
}

/** Collect folder item ids from structure create results (skip Google Sheet rows). */
function collectStructureFolderIds(structureFolders = [], rootFolderId = null) {
    const ids = [];
    const rootId = parseId(rootFolderId);
    if (rootId) ids.push(rootId);

    for (const row of structureFolders || []) {
        const itemType = String(row?.item_type || 'folder')
            .trim()
            .toLowerCase();
        if (itemType !== 'folder') continue;
        if (row?.google_file_id || row?.google_sheet_url) continue;
        const id = parseId(row?.item_id ?? row?.id);
        if (id) ids.push(id);
    }

    return [...new Set(ids)];
}

/**
 * Upsert the same user shares onto every project-scoped folder id.
 * Used on project create (all structure folders) and PCB create.
 */
async function shareUsersOnProjectFolders(folderIds, shares) {
    const ids = [...new Set((folderIds || []).map(parseId).filter(Boolean))];
    const shareList = Array.isArray(shares) ? shares : [];
    if (!ids.length || !shareList.length) {
        return { folder_count: ids.length, share_count: 0 };
    }

    let share_count = 0;
    for (const folderId of ids) {
        for (const share of shareList) {
            const userId = parseId(share?.user_id ?? share?.userId);
            const username = String(share?.username || '').trim();
            if (!userId || !username) continue;
            await ProjectFileManagerModel.upsertUser({
                project_folder_id: folderId,
                user_id: userId,
                username,
                role: share.role || 'viewer',
                assigned_by_username: share.assigned_by_username,
                is_childshare:
                    share.is_childshare != null
                        ? Boolean(share.is_childshare)
                        : true,
            });
            share_count += 1;
        }
    }

    return { folder_count: ids.length, share_count };
}

/** Map project_folder_users rows → share payloads for PCB folder sharing. */
function sharesFromProjectUsers(users, assignedByUsername = 'system') {
    return (users || [])
        .map((u) => {
            const userId = parseId(u.user_id ?? u.userId);
            const username = String(u.username || '').trim();
            if (!userId || !username) return null;
            return {
                user_id: userId,
                username,
                role: String(u.role || 'viewer').trim().toLowerCase() || 'viewer',
                assigned_by_username:
                    String(u.assigned_by_username || '').trim() ||
                    assignedByUsername,
                is_childshare:
                    u.is_childshare == null ? true : Boolean(u.is_childshare),
            };
        })
        .filter(Boolean);
}

/**
 * Dynamic folder naming:
 *   {PROJECT}_TO_CLIENT
 *   {PROJECT}_{PCB}
 *   {PROJECT}_{PCB}_BOM
 *
 * Template may store a suffix ("TO_CLIENT", "BOM") or a full pattern
 * with {PROJECT} / {PCB} placeholders.
 */
function sanitizeNameSegment(value) {
    return String(value || '')
        .trim()
        .replace(/\s+/g, '_')
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function applyNamePlaceholders(pattern, { projectCode, pcbCode }) {
    const project = sanitizeNameSegment(projectCode);
    const pcb = sanitizeNameSegment(pcbCode);
    return sanitizeFolderName(
        String(pattern || '')
            .replace(/\{PROJECT\}/gi, project)
            .replace(/\{PCB\}/gi, pcb),
    );
}

/**
 * Resolve display folder name for a template node.
 * @param {object} opts
 * @param {string} opts.folderName - template folder_name
 * @param {string} opts.projectCode
 * @param {string} [opts.pcbCode]
 * @param {boolean} [opts.insidePcbInstance] - under an expanded PCB folder
 * @param {boolean} [opts.isPcbRoot] - generic per-PCB root folder ({PROJECT}_{PCB})
 */
function resolveStructureFolderName({
    folderName,
    projectCode,
    pcbCode = '',
    insidePcbInstance = false,
    isPcbRoot = false,
}) {
    const raw = String(folderName || '').trim();
    const project = sanitizeNameSegment(projectCode);
    const pcb = sanitizeNameSegment(pcbCode);

    if (/\{PROJECT\}|\{PCB\}/i.test(raw)) {
        return applyNamePlaceholders(raw, {
            projectCode: project,
            pcbCode: pcb,
        });
    }

    const suffix = sanitizeNameSegment(raw);
    const projectUpper = project.toUpperCase();

    // Already fully prefixed with project code
    if (
        project &&
        suffix &&
        suffix.toUpperCase().startsWith(`${projectUpper}_`)
    ) {
        return sanitizeFolderName(suffix);
    }

    // Generic PCB root placeholder → {PROJECT}_{PCB}
    if (isPcbRoot) {
        if (project && pcb) {
            if (!suffix || /^pcb$/i.test(suffix)) {
                return sanitizeFolderName(`${project}_${pcb}`);
            }
            // Named "pcb root" with extra label → {PROJECT}_{PCB}_{LABEL}
            return sanitizeFolderName(`${project}_${pcb}_${suffix}`);
        }
        return sanitizeFolderName(pcb || project || suffix);
    }

    // Under a PCB / PCB-scoped leaf → {PROJECT}_{PCB}_{SUFFIX}
    // e.g. template _BOM → PROJ_L01_BOM
    if ((insidePcbInstance || pcb) && project && pcb) {
        if (!suffix || /^pcb$/i.test(suffix)) {
            return sanitizeFolderName(`${project}_${pcb}`);
        }
        return sanitizeFolderName(`${project}_${pcb}_${suffix}`);
    }

    // Project scope: {PROJECT}_{SUFFIX}
    if (project && suffix) return sanitizeFolderName(`${project}_${suffix}`);
    return sanitizeFolderName(suffix || project);
}

function isPcbScope(node) {
    return (
        String(node?.folder_scope || '')
            .trim()
            .toLowerCase() === 'pcb'
    );
}

function isGoogleSheetScope(node) {
    return (
        String(node?.folder_scope || '')
            .trim()
            .toLowerCase() === 'google_sheet'
    );
}

function isPcbLikeScope(node) {
    return isPcbScope(node) || isGoogleSheetScope(node);
}

function isGenericPcbTemplateName(name) {
    const label = String(name || '').trim();
    return !label || /^pcb$/i.test(label) || /^pcbs$/i.test(label);
}

/**
 * Resolve stored format "{PROJECT}_{PCB}_MAIN_BOM" → "ACME_L01_MAIN_BOM".
 */
function resolveGoogleSheetFileName(template, projectCode, pcbCode) {
    const project = String(projectCode || '').trim();
    const pcb = String(pcbCode || '').trim();
    let raw = String(template || '').trim();
    if (!raw) raw = '{PROJECT}_{PCB}';

    const resolved = raw
        .replace(/\{PROJECT\}/gi, project)
        .replace(/\{PCB\}/gi, pcb)
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '');

    return sanitizeFolderName(resolved || `${project}_${pcb}`);
}

/**
 * Create Google Sheet for a PCB using the same pipeline as CreateApi/googlesheet.js
 * (GoogleFileService.createGoogleSheet + .url shortcut + DB item).
 * When structure has google_sheet_url, copies that template spreadsheet.
 */
async function createProjectPcbGoogleSheet({
    node,
    projectCode,
    pcbCode,
    googleUserId,
    projectFolderId,
    parentItemId,
    physicalBaseAbs,
    relativeBase,
    displayOrder = 0,
    projectFolderUsername = '',
}) {
    if (!isGoogleSheetScope(node)) return null;

    const sheetName = resolveGoogleSheetFileName(
        node.google_sheet_file_name || node.folder_name,
        projectCode,
        pcbCode,
    );
    if (!sheetName) return null;

    if (!googleUserId) {
        console.warn(
            '[PCB Google Sheet] no Google-connected owner — skip create',
            { projectCode, pcbCode, sheetName },
        );
        return {
            error: 'Google account owner is not configured',
            folder_name: sheetName,
        };
    }

    const driveFolderId = await getProjectDriveFolderId(projectFolderId);
    if (!driveFolderId) {
        console.warn(
            '[PCB Google Sheet] Project Drive folder is missing — skip create',
        );
        return {
            error: 'Project Drive folder is not configured',
            folder_name: sheetName,
        };
    }

    const existing =
        (await ProjectFileManagerModel.findItemByParentAndName(
            projectFolderId,
            parentItemId,
            sheetName,
        )) ||
        (await ProjectFileManagerModel.findItemByParentAndName(
            projectFolderId,
            parentItemId,
            `${sheetName}.url`,
        ));
    if (existing) {
        return {
            template_id: node.id,
            item_id: existing.id,
            item_type: existing.item_type || 'google_sheet',
            folder_name: existing.folder_name,
            relative_path: existing.relative_path,
            absolute_path: existing.absolute_path,
            google_sheet_url: existing.google_sheet_url || null,
            google_file_id: existing.google_file_id || null,
            pcb_code: existing.pcb_code || pcbCode,
            project_pcb_code:
                existing.project_pcb_code ||
                `${String(projectCode).trim()}_${String(pcbCode).trim()}`,
            created: false,
            mode: 'already_exists',
        };
    }

    const sourceSpreadsheetId = extractSpreadsheetIdFromUrl(
        node.google_sheet_url,
    );
    const parentAbs = String(physicalBaseAbs || '').trim();
    if (!parentAbs) {
        return {
            error: 'Parent folder path missing — cannot create sheet shortcut',
            folder_name: sheetName,
        };
    }

    let googleMeta = null;
    let shortcutMeta = null;
    try {
        const shareEditEmails = await collectProjectGoogleEditorEmails({
            projectCode,
            extraUsernames: [projectFolderUsername].filter(Boolean),
        });

        googleMeta = await GoogleFileService.createGoogleSheet({
            userId: googleUserId,
            title: sheetName,
            googleDriveFolderId: driveFolderId,
            shareEditEmails,
            sourceSpreadsheetId: sourceSpreadsheetId || null,
        });

        const projectPcbCode = `${String(projectCode).trim()}_${String(pcbCode).trim()}`;

        // Template has LON — on assigned project sheet rename to LO1 (N = number)
        let loTabName = null;
        try {
            const renamed = await GoogleFileService.renameLonTabToLoNumber({
                userId: googleUserId,
                spreadsheetId: googleMeta.google_file_id,
                startNumber: 1,
            });
            if (renamed?.renamed) {
                loTabName = renamed.to;
                console.log('[PCB Google Sheet] LON →', renamed.to);
            }
        } catch (renameErr) {
            console.warn(
                '[PCB Google Sheet] LON→LO1 rename skipped:',
                renameErr?.message || renameErr,
            );
        }

        // Write {projectcode}_{pcbcode} next to PROJECT CODE_PCBCODE
        try {
            await GoogleFileService.fillBomHeaderProjectPcbCode({
                userId: googleUserId,
                spreadsheetId: googleMeta.google_file_id,
                projectCode,
                pcbCode,
            });
        } catch (fillErr) {
            console.warn(
                '[PCB Google Sheet] project_pcb_code fill skipped:',
                fillErr?.message || fillErr,
            );
        }

        shortcutMeta = createGoogleShortcut({
            parentDirAbsolute: parentAbs,
            name: sheetName,
            url: googleMeta.url,
        });

        const relativePath = relativeBase
            ? `${relativeBase}/${shortcutMeta.fileName}`
            : shortcutMeta.fileName;

        const item = await ProjectFileManagerModel.createItem({
            project_folder_id: projectFolderId,
            parent_id: parentItemId,
            template_id: node.id,
            folder_name: shortcutMeta.fileName,
            relative_path: relativePath,
            absolute_path: shortcutMeta.absolutePath,
            item_type: 'file',
            display_order: displayOrder ?? 0,
            is_active: true,
            google_file_id: googleMeta.google_file_id,
            google_drive_folder_id: driveFolderId,
            google_sheet_url: googleMeta.url,
            pcb_code: pcbCode,
            project_pcb_code: projectPcbCode,
            file_source: 'gsheet',
        });

        console.log('[PCB Google Sheet] created via createGoogleSheet API', {
            projectCode,
            pcbCode,
            project_pcb_code: projectPcbCode,
            lo_tab: loTabName,
            sheetName,
            mode: googleMeta.mode,
            url: googleMeta.url,
        });

        return {
            template_id: node.id,
            item_id: item.id,
            item_type: 'google_sheet',
            folder_name: sheetName,
            relative_path: relativePath,
            absolute_path: shortcutMeta.absolutePath,
            google_sheet_url: googleMeta.url,
            google_file_id: googleMeta.google_file_id,
            pcb_code: pcbCode,
            project_pcb_code: projectPcbCode,
            lo_tab_name: loTabName,
            created: true,
            mode: googleMeta.mode || 'created',
        };
    } catch (err) {
        if (shortcutMeta?.absolutePath) {
            removeGoogleShortcut(shortcutMeta.absolutePath);
        }
        if (googleMeta?.google_file_id && googleUserId) {
            try {
                const authMod = await import(
                    '../../services/filemanager/googleAuth.service.js'
                );
                const { auth } =
                    await authMod.getExistingGoogleAuthForUser(googleUserId);
                await GoogleFileService.deleteDriveFile(
                    authMod.getDriveClient(auth),
                    googleMeta.google_file_id,
                );
            } catch (cleanupErr) {
                console.warn(
                    '[PCB Google Sheet] cleanup failed:',
                    cleanupErr?.message || cleanupErr,
                );
            }
        }
        console.warn(
            '[PCB Google Sheet] create skipped:',
            err?.message || err,
        );
        return {
            error: err?.message || 'Failed to create Google Sheet',
            folder_name: sheetName,
            pcb_code: pcbCode,
        };
    }
}

/** True if this node or any descendant is PCB / Google Sheet scoped. */
function nodeHasPcbDescendant(node) {
    if (!node) return false;
    if (isPcbLikeScope(node)) return true;
    const kids = Array.isArray(node.children) ? node.children : [];
    return kids.some((c) => nodeHasPcbDescendant(c));
}

/** Unique PCB codes for a project (exact project_code match). */
async function loadProjectPcbCodes(projectCode) {
    const code = String(projectCode || '').trim().toUpperCase();
    if (!code) return [];

    const rows = await PCBModel.findAll({
        project_code: code,
        skipFinancialYear: true,
        all: 'true',
    });

    const seen = new Set();
    const codes = [];
    for (const row of rows || []) {
        const rowProject = String(row.project_code || '')
            .trim()
            .toUpperCase();
        if (rowProject !== code) continue;
        const pcbCode = String(row.pcb_code || '').trim();
        if (!pcbCode) continue;
        const key = pcbCode.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        codes.push(pcbCode);
    }
    return codes;
}

function buildCategoryFolderTree(items = []) {
    const map = new Map();
    const roots = [];

    for (const item of items) {
        map.set(Number(item.id), { ...item, children: [] });
    }

    for (const item of items) {
        const node = map.get(Number(item.id));
        const parentId =
            item.parent_id == null || item.parent_id === ''
                ? null
                : Number(item.parent_id);
        if (parentId && map.has(parentId)) {
            map.get(parentId).children.push(node);
        } else {
            roots.push(node);
        }
    }

    const sortNodes = (nodes) => {
        nodes.sort(
            (a, b) =>
                Number(a.display_order || 0) - Number(b.display_order || 0) ||
                Number(a.id) - Number(b.id),
        );
        nodes.forEach((n) => sortNodes(n.children || []));
    };
    sortNodes(roots);
    return roots;
}

/**
 * Create one folder (and optional children) on disk + project_file_manager_items.
 * When ensureExisting is true, reuses a folder with the same parent + name.
 */
async function createOneFolderNode({
    projectFolderId,
    parentItemId,
    templateId,
    displayName,
    displayOrder,
    physicalBaseAbs,
    relativeBase,
    children = [],
    projectCode,
    pcbCodes = [],
    currentPcbCode = '',
    insidePcbInstance = false,
    ensureExisting = false,
    pcbOnly = false,
    googleUserId = null,
    projectFolderUsername = '',
}) {
    const absolutePath = path.join(physicalBaseAbs, displayName);
    const relativePath = relativeBase
        ? `${relativeBase}/${displayName}`
        : displayName;

    let item = null;
    let createdNew = false;

    if (ensureExisting) {
        item = await ProjectFileManagerModel.findItemByParentAndName(
            projectFolderId,
            parentItemId,
            displayName,
        );
    }

    const googleDriveFolderId =
        await getProjectDriveFolderId(projectFolderId);

    if (!item) {
        fs.mkdirSync(absolutePath, { recursive: true });
        item = await ProjectFileManagerModel.createItem({
            project_folder_id: projectFolderId,
            parent_id: parentItemId,
            template_id: templateId,
            folder_name: displayName,
            relative_path: relativePath,
            absolute_path: absolutePath,
            item_type: 'folder',
            display_order: displayOrder ?? 0,
            is_active: true,
            google_drive_folder_id: googleDriveFolderId || null,
        });
        createdNew = true;
    } else {
        if (
            googleDriveFolderId &&
            String(item.google_drive_folder_id || '') !== googleDriveFolderId
        ) {
            item =
                (await ProjectFileManagerModel.updateItemGoogleDriveFolderId(
                    item.id,
                    googleDriveFolderId,
                )) || { ...item, google_drive_folder_id: googleDriveFolderId };
        }
        // Always ensure physical folder exists for reused DB rows
        const abs = String(item.absolute_path || absolutePath).trim();
        fs.mkdirSync(abs || absolutePath, { recursive: true });
        // Prefer computed path if stored absolute_path is empty
        if (!String(item.absolute_path || '').trim()) {
            item = {
                ...item,
                absolute_path: absolutePath,
                relative_path: item.relative_path || relativePath,
            };
        }
    }

    const created = [];
    created.push({
        template_id: templateId,
        item_id: item.id,
        public_id: item.public_id,
        folder_name: item.folder_name,
        relative_path: item.relative_path || relativePath,
        absolute_path: item.absolute_path || absolutePath,
        pcb_code: currentPcbCode || null,
        created: createdNew,
    });

    const childBaseAbs = String(item.absolute_path || absolutePath).trim();
    const childRelBase = String(item.relative_path || relativePath).trim();

    // Always materialize nested template children (DB + physical)
    if (Array.isArray(children) && children.length) {
        fs.mkdirSync(childBaseAbs, { recursive: true });
        const nested = await createCategoryStructureFolders({
            projectFolderId,
            parentItemId: item.id,
            treeNodes: children,
            projectCode,
            physicalBaseAbs: childBaseAbs,
            relativeBase: childRelBase,
            pcbCodes,
            currentPcbCode,
            insidePcbInstance,
            ensureExisting,
            pcbOnly,
            googleUserId,
            projectFolderUsername,
        });
        created.push(...nested);
    }

    return created;
}

/**
 * Walk category template tree.
 * Naming: {PROJECT}_… and under PCB {PROJECT}_{PCB}_…
 * - folder_scope=project → once
 * - folder_scope=pcb → once per project PCB
 * - folder_scope=google_sheet → create Google Sheet (CreateApi/googlesheet pipeline) per PCB
 * - pcbOnly: only create under project parents that lead to PCB-scoped
 *   template folders (assigned folder_scope=pcb|google_sheet in categories structure)
 */
async function createCategoryStructureFolders({
    projectFolderId,
    parentItemId = null,
    treeNodes,
    projectCode,
    physicalBaseAbs,
    relativeBase,
    pcbCodes = [],
    currentPcbCode = '',
    insidePcbInstance = false,
    ensureExisting = false,
    pcbOnly = false,
    googleUserId = null,
    projectFolderUsername = '',
}) {
    const created = [];

    for (const node of treeNodes) {
        if (node.is_active === false) continue;

        // Google Sheet scope → create sheet file (not a folder) via createGoogleSheet API
        if (isGoogleSheetScope(node)) {
            const codes =
                insidePcbInstance && currentPcbCode
                    ? [currentPcbCode]
                    : pcbCodes;
            if (!codes.length) continue;

            for (const pcbCode of codes) {
                const sheetMeta = await createProjectPcbGoogleSheet({
                    node,
                    projectCode,
                    pcbCode,
                    googleUserId,
                    projectFolderId,
                    parentItemId,
                    physicalBaseAbs,
                    relativeBase,
                    displayOrder: node.display_order ?? 0,
                    projectFolderUsername,
                });
                if (sheetMeta) created.push(sheetMeta);
            }
            continue;
        }

        // PCB-scoped template folder → expand once per PCB code
        // Templates may be:
        //   A) generic "PCB" parent → {PROJECT}_{PCB}/ + children
        //   B) named leaves under a project folder (e.g. _BOM, _GERBER)
        //      → {PROJECT}_{PCB}_BOM, {PROJECT}_{PCB}_GERBER (siblings)
        if (isPcbScope(node) && !insidePcbInstance) {
            if (!pcbCodes.length) continue;

            for (const pcbCode of pcbCodes) {
                const templateLabel = String(node.folder_name || '').trim();
                const isRootPlaceholder =
                    isGenericPcbTemplateName(templateLabel);

                const displayName = resolveStructureFolderName({
                    folderName: isRootPlaceholder
                        ? '{PROJECT}_{PCB}'
                        : templateLabel,
                    projectCode,
                    pcbCode,
                    // Named PCB-scoped folders use {PROJECT}_{PCB}_{SUFFIX}
                    isPcbRoot: isRootPlaceholder,
                    insidePcbInstance: !isRootPlaceholder,
                });

                const pcbCreated = await createOneFolderNode({
                    projectFolderId,
                    parentItemId,
                    templateId: node.id,
                    displayName,
                    displayOrder: node.display_order ?? 0,
                    physicalBaseAbs,
                    relativeBase,
                    children: node.children || [],
                    projectCode,
                    pcbCodes,
                    currentPcbCode: pcbCode,
                    // Children of a PCB branch always use PCB naming + mkdir
                    insidePcbInstance: true,
                    ensureExisting,
                    pcbOnly: false,
                    googleUserId,
                    projectFolderUsername,
                });
                created.push(...pcbCreated);
            }
            continue;
        }

        // pcb-folders API: skip project folders that have no PCB-scoped branch
        if (pcbOnly && !insidePcbInstance && !nodeHasPcbDescendant(node)) {
            continue;
        }

        const displayName = resolveStructureFolderName({
            folderName: node.folder_name,
            projectCode,
            pcbCode: currentPcbCode,
            insidePcbInstance,
        });

        const one = await createOneFolderNode({
            projectFolderId,
            parentItemId,
            templateId: node.id,
            displayName,
            displayOrder: node.display_order ?? 0,
            physicalBaseAbs,
            relativeBase,
            children: node.children || [],
            projectCode,
            pcbCodes,
            currentPcbCode,
            insidePcbInstance,
            ensureExisting,
            pcbOnly,
            googleUserId,
            projectFolderUsername,
        });
        created.push(...one);
    }

    return created;
}

/**
 * Ensure PCB-scoped folder tree exists for one PCB under an existing project FM.
 *
 * Uses that project's assigned category folder structure:
 * - Only paths that include folder_scope=pcb in the template
 * - Creates {PROJECT}_{PCB} + children ({PROJECT}_{PCB}_BOM, _GERBER, …)
 * - Project parents (e.g. {PROJECT}_DESIGN_FILE) are find-or-created as containers
 */
/**
 * Resolve active File Manager Settings owners + primary (access-preferred).
 */
async function resolveSettingsPrimaryOwners() {
    const settingsOwners = await FileManagerSettingModel.findActiveOwners();
    const owners = (settingsOwners || []).filter((o) => o.status !== false);
    if (!owners.length) return { owners: [], primary: null };
    const accessOwners = owners.filter((o) => Boolean(o.access));
    const primaryOwners = accessOwners.length ? accessOwners : owners;
    const primary = primaryOwners[0];
    const ownerId = Number(primary?.owner_id);
    const username = String(primary?.username || '').trim();
    if (!ownerId || !username) return { owners, primary: null };
    return {
        owners,
        primary: { owner_id: ownerId, username },
    };
}

/**
 * Register a physical project folder under an FY root into file_manager_items
 * with the File Manager Settings owner (so Shared With Me / owner UI is selected).
 * If the row already exists with no owner, backfill settings owners.
 */
export async function ensureProjectRootFromDisk({
    folderName,
    absolutePath,
    fyFolderId,
    financialYear,
    assignedByUsername = 'system',
} = {}) {
    const rawName = String(folderName || '').trim();
    const name = sanitizeFolderName(rawName);
    const fyCode = String(financialYear || '').trim();
    const parentId = parseId(fyFolderId);
    const abs = String(absolutePath || '').trim();
    if (!name || !fyCode || !parentId || !abs) return null;

    const assignedBy =
        String(assignedByUsername || '').trim() || 'system';

    let existing =
        (await ProjectFileManagerModel.findByProjectCode(name)) ||
        (await ProjectFileManagerModel.findByProjectCode(rawName));

    if (!existing) {
        const roots =
            await ProjectFileManagerModel.listRootsByParentId(parentId);
        existing =
            (roots || []).find(
                (r) =>
                    String(r.folder_name || r.name || r.project_code || '')
                        .trim()
                        .toLowerCase() === name.toLowerCase(),
            ) || null;
    }

    if (existing?.id) {
        const synced =
            await ProjectFileManagerModel.applyFileManagerOwners(
                existing.id,
                assignedBy,
            );
        const entry = await syncProjectGoogleDriveFolder(
            synced.entry || existing,
            existing.owner_id,
        );
        try {
            await syncProjectTreeFromDisk(entry);
        } catch (err) {
            console.warn(
                '[ProjectFileManager] structure sync failed:',
                err?.message || err,
            );
        }
        return entry;
    }

    const { owners, primary } = await resolveSettingsPrimaryOwners();
    if (!primary) return null;

    let project =
        (await ProjectModel.findByCode(name)) ||
        (await ProjectModel.findByCode(name.toUpperCase())) ||
        (await ProjectModel.findByCode(rawName));

    const projectId =
        project?.id != null && Number.isFinite(Number(project.id))
            ? Number(project.id)
            : null;

    let categoryId = null;
    let categoryName = null;
    const projectCategory = String(project?.category || '').trim();
    if (projectCategory) {
        try {
            const match =
                (await CategoryModel.findByLetter(projectCategory)) ||
                (await CategoryModel.findByName(projectCategory)) ||
                null;
            if (match?.id) {
                categoryId = Number(match.id);
                categoryName = String(match.name || projectCategory).trim();
            } else {
                categoryName = projectCategory;
            }
        } catch {
            categoryName = projectCategory;
        }
    }

    const relativePath = `${sanitizeFolderName(fyCode)}/${name}`;
    const googleDriveFolderId = await ensureProjectGoogleDriveFolder(
        primary.owner_id,
        name,
    );

    let row;
    try {
        row = await ProjectFileManagerModel.create({
            project_id: projectId,
            project_code: name,
            financial_year: fyCode,
            category_id: categoryId,
            category_name: categoryName,
            folder_name: name,
            relative_path: relativePath,
            absolute_path: abs,
            owner_id: primary.owner_id,
            username: primary.username,
            parent_id: parentId,
            google_drive_folder_id: googleDriveFolderId,
        });
    } catch (err) {
        console.warn(
            '[ProjectFileManager] ensureProjectRootFromDisk create failed:',
            err?.message || err,
        );
        return null;
    }

    if (!row?.id) return null;

    try {
        await syncProjectFolderLink(projectId, row.public_id);
    } catch {
        /* ignore link sync failures */
    }

    const shareByUserId = new Map();
    for (const owner of owners) {
        const oid = Number(owner.owner_id);
        const uname = String(owner.username || '').trim();
        if (!oid || !uname) continue;
        shareByUserId.set(oid, {
            user_id: oid,
            username: uname,
            ...roleShare('owner', assignedBy, true),
        });
    }
    await shareUsersOnProjectFolders([row.id], [...shareByUserId.values()]);

    const createdRoot = await ProjectFileManagerModel.findById(row.id);
    if (createdRoot) {
        try {
            await syncProjectTreeFromDisk(createdRoot);
        } catch (err) {
            console.warn(
                '[ProjectFileManager] structure sync failed:',
                err?.message || err,
            );
        }
    }
    return createdRoot;
}

/**
 * Walk a project folder on disk and register missing folders/files in DB
 * (structure under PROJECT_FILE_MANAGER_PATH/{FY}/{project_code}).
 */
/**
 * Register one level of physical disk children into DB under a project folder.
 * Used when browsing Shared With Me / project children so on-disk files appear.
 */
export async function syncProjectFolderLevelFromDisk({
    projectRoot,
    parentItemId = null,
    parentAbsolutePath = null,
    parentRelativePath = null,
} = {}) {
    const rootId = parseId(projectRoot?.id);
    const parentId =
        parentItemId != null ? parseId(parentItemId) : rootId;
    const diskAbs = String(
        parentAbsolutePath || projectRoot?.absolute_path || '',
    ).trim();
    const relBase = String(
        parentRelativePath ||
            (parentId === rootId ? projectRoot?.relative_path : '') ||
            '',
    ).trim();

    if (!rootId || !parentId || !diskAbs || !fs.existsSync(diskAbs)) {
        return { created: 0, skipped: 0 };
    }

    let created = 0;
    let skipped = 0;
    const children = listDiskChildren(diskAbs);

    for (const child of children) {
        const name = String(child.name || '').trim();
        if (!name) continue;
        const relativePath = relBase ? `${relBase}/${name}` : name;
        const absPath = String(child.absolute_path || '').trim();
        const itemType = child.item_type === 'file' ? 'file' : 'folder';

        const existing = await ProjectFileManagerModel.findItemByParentAndDiskName(
            rootId,
            parentId,
            name,
            absPath,
        );
        if (existing) {
            skipped += 1;
            continue;
        }

        try {
            await ProjectFileManagerModel.createItem({
                project_folder_id: rootId,
                parent_id: parentId,
                folder_name: name,
                relative_path: relativePath,
                absolute_path: absPath,
                item_type: itemType,
                display_order: 0,
                is_active: true,
                owner_id: projectRoot.owner_id ?? null,
                username: projectRoot.username ?? null,
            });
            created += 1;
        } catch (err) {
            console.warn(
                '[ProjectFileManager] sync level item failed:',
                name,
                err?.message || err,
            );
            skipped += 1;
        }
    }

    return { created, skipped };
}

async function syncProjectTreeFromDisk(projectRoot, { maxDepth = 12 } = {}) {
    const rootId = parseId(projectRoot?.id);
    const rootAbs = String(projectRoot?.absolute_path || '').trim();
    const rootRel = String(projectRoot?.relative_path || '').trim();
    if (!rootId || !rootAbs || !fs.existsSync(rootAbs)) {
        return { created: 0, skipped: 0 };
    }

    let created = 0;
    let skipped = 0;

    async function walk(parentId, diskAbs, relBase, depth) {
        if (depth > maxDepth) return;
        const level = await syncProjectFolderLevelFromDisk({
            projectRoot,
            parentItemId: parentId,
            parentAbsolutePath: diskAbs,
            parentRelativePath: relBase,
        });
        created += level.created;
        skipped += level.skipped;

        if (depth >= maxDepth) return;
        const children = listDiskChildren(diskAbs);
        for (const child of children) {
            if (child.item_type !== 'folder') continue;
            const name = String(child.name || '').trim();
            if (!name) continue;
            const absPath = String(child.absolute_path || '').trim();
            const relativePath = relBase ? `${relBase}/${name}` : name;
            const item = await ProjectFileManagerModel.findItemByParentAndName(
                rootId,
                parentId,
                name,
            );
            if (item?.id && absPath) {
                await walk(Number(item.id), absPath, relativePath, depth + 1);
            }
        }
    }

    await walk(rootId, rootAbs, rootRel, 0);
    return { created, skipped };
}

/**
 * Scan PROJECT_FILE_MANAGER_PATH: ensure FY folders, register physical
 * project folders + nested structure into DB, apply File Manager Settings owner.
 */
export async function syncProjectFileManagerFromDisk(
    assignedByUsername = 'system',
) {
    const assignedBy =
        String(assignedByUsername || '').trim() || 'system';

    let rootPath;
    try {
        rootPath = getProjectFileManagerRootPath();
    } catch (err) {
        return {
            success: false,
            message: err?.message || 'PROJECT_FILE_MANAGER_PATH missing',
            financial_years: [],
            projects: [],
            structure: { created: 0, skipped: 0 },
        };
    }

    const fyEnsure = await ensureFinancialYearFolders();
    const fyByCode = new Map();
    for (const row of fyEnsure?.folders || []) {
        const code = String(row.year_code || row.entry?.year_code || '')
            .trim();
        if (code && row.entry?.id) fyByCode.set(code.toLowerCase(), row);
    }

    // Also discover FY folders that exist only on disk
    const diskFyFolders = listDiskChildren(rootPath).filter(
        (c) => c.item_type === 'folder',
    );
    for (const diskFy of diskFyFolders) {
        const code = String(diskFy.name || '').trim();
        if (!code || fyByCode.has(code.toLowerCase())) continue;
        try {
            const ensured = await ensureFinancialYearFolderByCode(code);
            if (ensured?.entry?.id) {
                fyByCode.set(code.toLowerCase(), {
                    year_code: code,
                    path: ensured.path || diskFy.absolute_path,
                    entry: ensured.entry,
                    created: ensured.created,
                });
            }
        } catch (err) {
            console.warn(
                '[ProjectFileManager] disk FY ensure failed:',
                code,
                err?.message || err,
            );
        }
    }

    const projects = [];
    let structureCreated = 0;
    let structureSkipped = 0;

    for (const [, fy] of fyByCode) {
        const fyId = parseId(fy.entry?.id);
        const fyCode = String(fy.year_code || fy.entry?.year_code || '').trim();
        const fyAbs = String(
            fy.path || fy.entry?.absolute_path || '',
        ).trim();
        if (!fyId || !fyCode || !fyAbs) continue;

        try {
            await FinancialYearFileManagerModel.applyFileManagerOwners(
                fyId,
                assignedBy,
            );
        } catch {
            /* ignore */
        }

        const projectDiskFolders = listDiskChildren(fyAbs).filter(
            (c) => c.item_type === 'folder',
        );

        for (const child of projectDiskFolders) {
            try {
                const projectRoot = await ensureProjectRootFromDisk({
                    folderName: child.name,
                    absolutePath: child.absolute_path,
                    fyFolderId: fyId,
                    financialYear: fyCode,
                    assignedByUsername: assignedBy,
                });
                if (!projectRoot?.id) continue;

                const tree = await syncProjectTreeFromDisk(projectRoot);
                structureCreated += tree.created;
                structureSkipped += tree.skipped;

                projects.push({
                    id: projectRoot.id,
                    project_code: projectRoot.project_code,
                    financial_year: fyCode,
                    owner_id: projectRoot.owner_id ?? null,
                    username: projectRoot.username ?? null,
                    absolute_path: projectRoot.absolute_path,
                    structure_created: tree.created,
                });
            } catch (err) {
                console.warn(
                    '[ProjectFileManager] sync project from disk failed:',
                    child.name,
                    err?.message || err,
                );
            }
        }
    }

    return {
        success: true,
        root: rootPath,
        financial_years: [...fyByCode.values()].map((fy) => ({
            id: fy.entry?.id ?? null,
            year_code: fy.year_code || fy.entry?.year_code || null,
            path: fy.path || fy.entry?.absolute_path || null,
            owner_id: fy.entry?.owner_id ?? null,
        })),
        projects,
        structure: {
            created: structureCreated,
            skipped: structureSkipped,
        },
    };
}

export async function ensureProjectPcbFolders({
    projectCode,
    pcbCode,
}) {
    const code = String(projectCode || '').trim().toUpperCase();
    const pcb = String(pcbCode || '').trim();

    if (!code) {
        const err = new Error('project_code is required');
        err.status = 400;
        throw err;
    }
    if (!pcb) {
        const err = new Error('pcb_code is required');
        err.status = 400;
        throw err;
    }

    let projectFolder =
        await ProjectFileManagerModel.findByProjectCode(code);

    if (!projectFolder) {
        const project = await ProjectModel.findByCode(code);
        if (project?.id) {
            projectFolder = await ProjectFileManagerModel.findByProjectId(
                Number(project.id),
            );
        }
    }

    if (!projectFolder) {
        const err = new Error(
            `Project file manager folder not found for project_code ${code}. Create the project folder structure first.`,
        );
        err.status = 404;
        throw err;
    }

    const categoryId = parseId(projectFolder.category_id);
    if (!categoryId) {
        const err = new Error(
            'Project folder has no category_id — cannot resolve folder template. Assign a category when creating the project folder.',
        );
        err.status = 400;
        throw err;
    }

    const structureRows =
        await CategoriesFolderStructureModel.findByCategoryId(categoryId);
    const activeStructure = (structureRows || []).filter(
        (r) => r.is_active !== false,
    );
    if (!activeStructure.length) {
        const err = new Error(
            'No folder structure configured for this project category',
        );
        err.status = 400;
        throw err;
    }

    const hasPcbScoped = activeStructure.some((r) => isPcbLikeScope(r));
    if (!hasPcbScoped) {
        return {
            project_folder: projectFolder,
            project_code: code,
            pcb_code: pcb,
            category_id: categoryId,
            structure_folders: [],
            message:
                'No PCB / Google Sheet scoped folders in categories folder structure for this project category — mark folders with scope PCB or Google Sheet first',
        };
    }

    const structureTree = buildCategoryFolderTree(activeStructure);
    const physicalBaseAbs = String(
        projectFolder.absolute_path || '',
    ).trim();
    const relativeBase = String(projectFolder.relative_path || '').trim();

    if (!physicalBaseAbs) {
        const err = new Error(
            'Project folder absolute_path is missing — cannot create PCB folders on disk',
        );
        err.status = 500;
        throw err;
    }

    fs.mkdirSync(physicalBaseAbs, { recursive: true });

    const googleUserId = await resolveGoogleAuthUserId(projectFolder);

    // Only create under template folders with folder_scope=pcb|google_sheet (and their parents)
    const structureFolders = await createCategoryStructureFolders({
        projectFolderId: projectFolder.id,
        parentItemId: null,
        treeNodes: structureTree,
        projectCode: code,
        physicalBaseAbs,
        relativeBase,
        pcbCodes: [pcb],
        ensureExisting: true,
        pcbOnly: true,
        googleUserId,
        projectFolderUsername: String(projectFolder.username || '').trim(),
    });

    return {
        project_folder: projectFolder,
        project_code: code,
        pcb_code: pcb,
        category_id: categoryId,
        structure_folders: structureFolders,
    };
}

async function resolveFinancialYearCode(project, bodyFy) {
    const fromBody = String(
        bodyFy ?? '',
    ).trim();
    if (fromBody) return fromBody;

    const current = await FinancialYearModel.findCurrent();
    if (current?.year_code) return String(current.year_code).trim();

    return FinancialYearModel.getCalendarCurrentYearCode();
}

async function resolveCategory({ categoryId, categoryName } = {}) {
    const id = parseId(categoryId);
    const name = String(categoryName ?? '').trim();

    if (!id) {
        throw Object.assign(
            new Error('category_id is required'),
            { status: 400 },
        );
    }
    if (!name) {
        throw Object.assign(
            new Error('category_name is required'),
            { status: 400 },
        );
    }

    const byId = await CategoryModel.findById(id);
    if (!byId) {
        throw Object.assign(new Error('Category not found for category_id'), {
            status: 404,
        });
    }

    const dbName = String(byId.name ?? '').trim().toLowerCase();
    if (dbName !== name.toLowerCase()) {
        throw Object.assign(
            new Error(
                `category_name "${name}" does not match category_id ${id} (${byId.name})`,
            ),
            { status: 400 },
        );
    }

    return byId;
}

class ProjectFileManagerController {
    /** GET /project-file-manager */
    static async list(req, res) {
        const rows = await ProjectFileManagerModel.findAll({
            financial_year:
                req.query.financial_year || req.query.financialYear || null,
            search: req.query.search || req.query.q || null,
        });
        return res.json({ success: true, data: rows });
    }

    /**
     * POST /project-file-manager/sync-from-disk
     * Register physical folders under PROJECT_FILE_MANAGER_PATH into DB
     * with File Manager Settings owner.
     */
    static async syncFromDisk(req, res) {
        const { username } = await resolveActor(req);
        const result = await syncProjectFileManagerFromDisk(
            username || 'system',
        );
        const status = result.success === false ? 400 : 200;
        return res.status(status).json({
            success: result.success !== false,
            message:
                result.message ||
                `Synced ${result.projects?.length || 0} project folder(s) from disk`,
            data: result,
        });
    }

    /** GET /project-file-manager/my-access */
    static async myAccess(req, res) {
        const { ownerId, username } = await resolveActor(req);
        if (ownerId == null || !username) return unauthorized(res);

        const rows = await ProjectFileManagerModel.findAccessibleByUser(ownerId);
        return res.json({ success: true, data: rows });
    }

    /** GET /project-file-manager/project/:projectId */
    static async getByProjectId(req, res) {
        const projectId = parseId(req.params.projectId);
        if (!projectId) {
            return res.status(400).json({
                success: false,
                message: 'Valid projectId is required',
            });
        }

        const row = await ProjectFileManagerModel.findByProjectId(projectId);
        if (!row) return notFound(res, 'Project file manager folder not found');

        await syncProjectFolderLink(projectId, row.public_id);

        // Physical disk folders/files → DB (no manual sync / restart needed)
        try {
            await syncProjectTreeFromDisk(row);
        } catch (err) {
            console.warn(
                '[ProjectFileManager] getByProjectId disk→DB sync skipped:',
                err?.message || err,
            );
        }

        const users = await ProjectFileManagerModel.listUsers(row.id);
        const items = await ProjectFileManagerModel.listItems(row.id);
        return res.json({ success: true, data: { ...row, users, items } });
    }

    /** GET /project-file-manager/:id */
    static async getById(req, res) {
        const id = parseId(req.params.id);
        if (!id) {
            return res.status(400).json({
                success: false,
                message: 'Valid id is required',
            });
        }

        const row = await ProjectFileManagerModel.findById(id);
        if (!row) return notFound(res, 'Project file manager folder not found');

        try {
            await syncProjectTreeFromDisk(row);
        } catch (err) {
            console.warn(
                '[ProjectFileManager] getById disk→DB sync skipped:',
                err?.message || err,
            );
        }

        const users = await ProjectFileManagerModel.listUsers(row.id);
        const items = await ProjectFileManagerModel.listItems(row.id);
        return res.json({ success: true, data: { ...row, users, items } });
    }

    /**
     * POST /project-file-manager
     * Payload:
     *   project_code (required)
     *   category_id (required)
     *   category_name (required)
     *   users / assign_users (optional): [{ user_id, username }] only
     *   - created_by (request actor): editor + is_childshare true
     *   - assign users: editor + is_childshare true
     *   - file manager settings owners: owner + is_childshare true
     *
     * Creates project folders under PROJECT_FILE_MANAGER_PATH/{FY}/{code}.
     * Stores project roots/items in unified file_manager_items (scope=project).
     * FY folder metadata uses file_manager_items (scope=financial_year).
     */
    static async create(req, res) {
        try {
            const actor = await resolveActor(req);
            const actorUsername = actor.username || 'system';

            const projectCode = String(
                req.body?.project_code ?? req.body?.projectCode ?? '',
            )
                .trim()
                .toUpperCase();
            const categoryId =
                req.body?.category_id ?? req.body?.categoryId ?? null;
            const categoryName = String(
                req.body?.category_name ??
                    req.body?.categoryName ??
                    '',
            ).trim();
            const assignUsersRaw = normalizeAssignUsers(req.body);

            if (!projectCode) {
                return res.status(400).json({
                    success: false,
                    message: 'project_code is required',
                });
            }
            if (!parseId(categoryId)) {
                return res.status(400).json({
                    success: false,
                    message: 'category_id is required',
                });
            }
            if (!categoryName) {
                return res.status(400).json({
                    success: false,
                    message: 'category_name is required',
                });
            }

            const project = await ProjectModel.findByCode(projectCode);
            if (!project) {
                return res.status(404).json({
                    success: false,
                    message: `Project not found for code ${projectCode}`,
                });
            }

            const projectId = Number(project.id);
            const existing =
                await ProjectFileManagerModel.findByProjectId(projectId);
            if (existing) {
                const synced = await syncProjectGoogleDriveFolder(
                    existing,
                    existing.owner_id ?? actor.ownerId,
                );
                await syncProjectFolderLink(projectId, existing.public_id);
                return res.status(409).json({
                    success: false,
                    message: 'A file manager folder already exists for this project',
                    data: synced,
                });
            }

            let category;
            try {
                category = await resolveCategory({
                    categoryId,
                    categoryName,
                });
            } catch (catErr) {
                return res.status(catErr.status || 400).json({
                    success: false,
                    message: catErr.message || 'Invalid category',
                });
            }

            const structureRows =
                await CategoriesFolderStructureModel.findByCategoryId(
                    Number(category.id),
                );
            const activeStructure = (structureRows || []).filter(
                (r) => r.is_active !== false,
            );
            if (!activeStructure.length) {
                return res.status(400).json({
                    success: false,
                    message:
                        'No folder structure configured for this category. Add folders in Categories Folder Structure settings first.',
                });
            }
            const structureTree = buildCategoryFolderTree(activeStructure);
            const pcbCodes = await loadProjectPcbCodes(projectCode);

            const settingsOwners =
                await FileManagerSettingModel.findActiveOwners();
            const owners = (settingsOwners || []).filter(
                (o) => o.status !== false,
            );
            if (!owners.length) {
                return res.status(400).json({
                    success: false,
                    message:
                        'No file manager owners configured. Add owners in File Manager Settings first.',
                });
            }

            // Prefer owners with access=true; fallback to all active
            const accessOwners = owners.filter((o) => Boolean(o.access));
            const primaryOwners = accessOwners.length ? accessOwners : owners;
            const primaryOwner = primaryOwners[0];
            const primaryOwnerId = Number(primaryOwner.owner_id);
            const primaryUsername = String(primaryOwner.username).trim();

            const financialYear = await resolveFinancialYearCode(
                project,
                req.body?.financial_year ?? req.body?.financialYear,
            );

            // Physical FY folder + project root on disk
            let physicalProjectAbs = null;
            let fyAbs = null;
            let fyFolderEntry = null;
            try {
                const fyFolder = await ensureFinancialYearFolderByCode(
                    financialYear,
                );
                fyFolderEntry = fyFolder?.entry || null;
                fyAbs =
                    fyFolder?.path ||
                    path.join(
                        getProjectFileManagerRootPath(),
                        sanitizeFolderName(financialYear),
                    );
                physicalProjectAbs = path.join(
                    fyAbs,
                    sanitizeFolderName(projectCode),
                );
                fs.mkdirSync(physicalProjectAbs, { recursive: true });
            } catch (physErr) {
                return res.status(500).json({
                    success: false,
                    message:
                        physErr?.message ||
                        'Failed to create project folder under PROJECT_FILE_MANAGER_PATH',
                });
            }

            const projectRootName = sanitizeFolderName(projectCode);
            const projectRelativePath = `${sanitizeFolderName(financialYear)}/${projectRootName}`;
            const fyParentId =
                fyFolderEntry?.id != null ? Number(fyFolderEntry.id) : null;
            const googleDriveFolderId =
                await ensureProjectGoogleDriveFolder(
                    primaryOwnerId,
                    projectCode,
                );

            // Project root under FY folder (parent_id = financial_year folder id)
            const row = await ProjectFileManagerModel.create({
                project_id: projectId,
                project_code: projectCode,
                financial_year: financialYear,
                category_id: Number(category.id),
                category_name: category.name,
                folder_name: projectRootName,
                relative_path: projectRelativePath,
                absolute_path: physicalProjectAbs,
                owner_id: primaryOwnerId,
                username: primaryUsername,
                parent_id: fyParentId,
                google_drive_folder_id: googleDriveFolderId,
            });

            // Store category structure folders in project_file_manager_items (+ disk)
            // PCB-scoped template folders are expanded once per project PCB.
            const structureFolders = await createCategoryStructureFolders({
                projectFolderId: row.id,
                parentItemId: null,
                treeNodes: structureTree,
                projectCode,
                physicalBaseAbs: physicalProjectAbs,
                relativeBase: projectRelativePath,
                pcbCodes,
                googleUserId: primaryOwnerId,
                projectFolderUsername: primaryUsername,
            });

            // Role-based shares (all with is_childshare=true):
            // - file manager settings owners → owner
            // - created_by actor → editor (unless already settings owner)
            // - assign users (payload) → editor (do not downgrade owner)
            const shareByUserId = new Map();

            for (const owner of owners) {
                const oid = Number(owner.owner_id);
                const uname = String(owner.username || '').trim();
                if (!oid || !uname) continue;
                shareByUserId.set(oid, {
                    user_id: oid,
                    username: uname,
                    ...roleShare('owner', actorUsername, true),
                });
            }

            const createdById = parseId(actor.ownerId);
            const createdByUsername = String(actorUsername || '').trim();
            if (createdById && createdByUsername) {
                const existing = shareByUserId.get(createdById);
                if (!existing || existing.role !== 'owner') {
                    shareByUserId.set(createdById, {
                        user_id: createdById,
                        username: createdByUsername,
                        ...roleShare('editor', actorUsername, true),
                    });
                }
            }

            for (const raw of assignUsersRaw) {
                const identity = normalizeAssignUserIdentity(raw);
                if (!identity) continue;

                const existingShare = shareByUserId.get(identity.user_id);
                // Do not downgrade settings owners
                if (existingShare?.role === 'owner') {
                    continue;
                }

                shareByUserId.set(identity.user_id, {
                    user_id: identity.user_id,
                    username: identity.username,
                    ...roleShare('editor', actorUsername, true),
                });
            }

            // Share root + every created structure folder with owners / assign users
            const shareList = [...shareByUserId.values()];
            const shareFolderIds = collectStructureFolderIds(
                structureFolders,
                row.id,
            );
            const shareResult = await shareUsersOnProjectFolders(
                shareFolderIds,
                shareList,
            );

            const users = await ProjectFileManagerModel.listUsers(row.id);
            const items = await ProjectFileManagerModel.listItems(row.id);
            const full = await ProjectFileManagerModel.findById(row.id);

            const folderLink = await syncProjectFolderLink(
                projectId,
                full?.public_id ?? row.public_id,
            );

            return res.status(201).json({
                success: true,
                message: 'Project folder structure created from category template',
                data: {
                    ...full,
                    users,
                    items,
                    folder_link:
                        folderLink?.filemanager_link ??
                        folderLink?.drive_link ??
                        projectFolderAppLink(full?.public_id ?? row.public_id),
                    filemanager_link:
                        folderLink?.filemanager_link ??
                        folderLink?.drive_link ??
                        projectFolderAppLink(full?.public_id ?? row.public_id),
                    category: {
                        id: category.id,
                        letter: category.letter,
                        name: category.name,
                    },
                    owners: owners.map((o) => ({
                        owner_id: o.owner_id,
                        username: o.username,
                        access: o.access,
                    })),
                    physical_path: physicalProjectAbs,
                    pcb_codes: pcbCodes,
                    structure_folders: structureFolders,
                    shared_folders: shareResult,
                },
            });
        } catch (error) {
            const status = error.status || 500;
            console.error('ProjectFileManager.create error:', error);
            return res.status(status).json({
                success: false,
                message: error.message || 'Failed to create project folder',
            });
        }
    }

    /**
     * POST /project-file-manager/pcb-folders
     * Body: { project_code, pcb_code }
     * Creates PCB-scoped folder structure for that PCB under the existing project FM.
     */
    static async createPcbFolders(req, res) {
        try {
            const projectCode = String(
                req.body?.project_code ?? req.body?.projectCode ?? '',
            )
                .trim()
                .toUpperCase();
            const pcbCode = String(
                req.body?.pcb_code ?? req.body?.pcbCode ?? '',
            ).trim();

            if (!projectCode) {
                return res.status(400).json({
                    success: false,
                    message: 'project_code is required',
                });
            }
            if (!pcbCode) {
                return res.status(400).json({
                    success: false,
                    message: 'pcb_code is required',
                });
            }

            const result = await ensureProjectPcbFolders({
                projectCode,
                pcbCode,
            });

            const projectFolderId = parseId(result.project_folder?.id);
            const projectUsers = projectFolderId
                ? await ProjectFileManagerModel.listUsers(projectFolderId)
                : [];
            const pcbActor = await resolveActor(req);
            const pcbShareList = sharesFromProjectUsers(
                projectUsers,
                pcbActor?.username || 'system',
            );
            const pcbFolderIds = collectStructureFolderIds(
                result.structure_folders,
                null,
            );
            const shareResult = await shareUsersOnProjectFolders(
                pcbFolderIds,
                pcbShareList,
            );

            const items = await ProjectFileManagerModel.listItems(
                result.project_folder.id,
            );

            return res.status(201).json({
                success: true,
                message:
                    result.structure_folders?.length > 0
                        ? 'PCB folder structure created from categories folder_scope=pcb'
                        : result.message ||
                          'PCB folder structure already up to date',
                data: {
                    project_code: result.project_code,
                    pcb_code: result.pcb_code,
                    category_id: result.category_id,
                    project_folder: result.project_folder,
                    created_folders: result.structure_folders,
                    filemanager_link: pcbAssignmentFolderLink(
                        result.structure_folders,
                        result.project_code,
                        result.pcb_code,
                    ),
                    items,
                    shared_users: pcbShareList.length,
                    shared_folders: shareResult,
                },
            });
        } catch (error) {
            const status = error.status || 500;
            console.error('ProjectFileManager.createPcbFolders error:', error);
            return res.status(status).json({
                success: false,
                message:
                    error.message || 'Failed to create PCB folder structure',
            });
        }
    }

    /** PUT /project-file-manager/:id */
    static async update(req, res) {
        const { ownerId, username } = await resolveActor(req);
        const id = parseId(req.params.id);
        if (!id) {
            return res.status(400).json({
                success: false,
                message: 'Valid id is required',
            });
        }

        const existing = await ProjectFileManagerModel.findById(id);
        if (!existing) {
            return notFound(res, 'Project file manager folder not found');
        }

        const fields = {};
        const projectCode = req.body?.project_code ?? req.body?.projectCode;
        const financialYear =
            req.body?.financial_year ?? req.body?.financialYear;
        const categoryId = req.body?.category_id ?? req.body?.categoryId;
        const categoryName = req.body?.category_name ?? req.body?.categoryName;

        if (projectCode != null) fields.project_code = projectCode;
        if (financialYear != null) fields.financial_year = financialYear;
        if (categoryId != null) fields.category_id = categoryId;
        if (categoryName != null) fields.category_name = categoryName;

        const updated = await ProjectFileManagerModel.update(id, fields);
        await writeFileManagerLog({
            action: 'UPDATE',
            entityType: 'folder',
            itemId: id,
            itemName: existing.folder_name || existing.name || existing.project_code,
            fieldName: 'folder',
            oldValue: {
                project_code: existing.project_code,
                financial_year: existing.financial_year,
                category_id: existing.category_id,
                category_name: existing.category_name,
            },
            newValue: fields,
            updatedBy: username,
            updatedByUserId: ownerId,
        });
        const users = await ProjectFileManagerModel.listUsers(id);
        const items = await ProjectFileManagerModel.listItems(id);
        const full = await ProjectFileManagerModel.findById(updated.id);

        return res.json({
            success: true,
            message: 'Project file manager folder updated',
            data: { ...full, users, items },
        });
    }

    /** DELETE /project-file-manager/:id — removes mapping (+ users via CASCADE) */
    static async remove(req, res) {
        const { ownerId, username } = await resolveActor(req);
        const id = parseId(req.params.id);
        if (!id) {
            return res.status(400).json({
                success: false,
                message: 'Valid id is required',
            });
        }

        const existing = await ProjectFileManagerModel.findById(id);
        if (!existing) {
            return notFound(res, 'Project file manager folder not found');
        }

        const deleted = await ProjectFileManagerModel.delete(id);
        await writeFileManagerLog({
            action: 'DELETE',
            entityType: 'folder',
            itemId: id,
            itemName: existing.folder_name || existing.name || existing.project_code,
            fieldName: 'folder',
            oldValue: existing.project_code || existing.folder_name || existing.name,
            newValue: null,
            updatedBy: username,
            updatedByUserId: ownerId,
        });
        return res.json({
            success: true,
            message: 'Project file manager folder mapping deleted',
            data: deleted,
        });
    }

    /** GET /project-file-manager/:id/users */
    static async listUsers(req, res) {
        const id = parseId(req.params.id);
        if (!id) {
            return res.status(400).json({
                success: false,
                message: 'Valid id is required',
            });
        }

        const existing = await ProjectFileManagerModel.findById(id);
        if (!existing) {
            return notFound(res, 'Project file manager folder not found');
        }

        const users = await ProjectFileManagerModel.listUsers(id);
        return res.json({ success: true, data: users });
    }

    /**
     * POST /project-file-manager/:id/users
     * Body: single user fields OR { users: [...] }
     */
    static async assignUsers(req, res) {
        const { ownerId, username } = await resolveActor(req);
        if (ownerId == null || !username) return unauthorized(res);

        const id = parseId(req.params.id);
        if (!id) {
            return res.status(400).json({
                success: false,
                message: 'Valid id is required',
            });
        }

        const existing = await ProjectFileManagerModel.findById(id);
        if (!existing) {
            return notFound(res, 'Project file manager folder not found');
        }

        const rawList = Array.isArray(req.body?.users)
            ? req.body.users
            : [req.body];

        const saved = [];
        for (const raw of rawList) {
            const payload = normalizeUserPayload(raw, username);
            if (!payload) {
                return res.status(400).json({
                    success: false,
                    message: 'Each user requires user_id and username',
                });
            }
            const previous = await ProjectFileManagerModel.findUser(
                id,
                payload.user_id,
            );
            const row = await ProjectFileManagerModel.upsertUser({
                project_folder_id: id,
                ...payload,
            });
            saved.push(row);
            await writeFileManagerLog({
                action: 'UPDATE',
                entityType: 'permission',
                itemId: id,
                itemName:
                    existing.folder_name ||
                    existing.name ||
                    existing.project_code,
                targetUsername: payload.username,
                fieldName: 'role',
                oldValue: previous?.role || null,
                newValue: payload.role || row?.role || null,
                updatedBy: username,
                updatedByUserId: ownerId,
            });
        }

        return res.status(201).json({
            success: true,
            message: 'User permissions saved',
            data: saved,
        });
    }

    /** PUT /project-file-manager/:id/users/:userId */
    static async updateUser(req, res) {
        const { ownerId, username: actorUsername } = await resolveActor(req);
        const id = parseId(req.params.id);
        const userId = parseId(req.params.userId);
        if (!id || !userId) {
            return res.status(400).json({
                success: false,
                message: 'Valid id and userId are required',
            });
        }

        const existing = await ProjectFileManagerModel.findById(id);
        if (!existing) {
            return notFound(res, 'Project file manager folder not found');
        }

        const current = await ProjectFileManagerModel.findUser(id, userId);
        if (!current) {
            return notFound(res, 'User assignment not found');
        }

        const fields = {};
        if (req.body?.username != null) fields.username = req.body.username;

        const roleRaw =
            req.body?.role ??
            req.body?.permission_role ??
            req.body?.permissionRole ??
            null;
        if (roleRaw != null && String(roleRaw).trim() !== '') {
            fields.role = String(roleRaw).trim().toLowerCase();
        }

        if (!fields.role && !fields.username) {
            return res.status(400).json({
                success: false,
                message: 'Provide role (owner | editor | viewer) to update',
            });
        }

        const updated = await ProjectFileManagerModel.updateUserPermissions(
            id,
            userId,
            fields,
        );

        await writeFileManagerLog({
            action: 'UPDATE',
            entityType: 'permission',
            itemId: id,
            itemName:
                existing.folder_name || existing.name || existing.project_code,
            targetUsername: current.username,
            fieldName: 'role',
            oldValue: current.role,
            newValue: updated?.role ?? fields.role,
            updatedBy: actorUsername,
            updatedByUserId: ownerId,
        });

        return res.json({
            success: true,
            message: 'User permissions updated',
            data: updated,
        });
    }

    /** DELETE /project-file-manager/:id/users/:userId */
    static async removeUser(req, res) {
        const { ownerId, username: actorUsername } = await resolveActor(req);
        const id = parseId(req.params.id);
        const userId = parseId(req.params.userId);
        if (!id || !userId) {
            return res.status(400).json({
                success: false,
                message: 'Valid id and userId are required',
            });
        }

        const existing = await ProjectFileManagerModel.findById(id);
        if (!existing) {
            return notFound(res, 'Project file manager folder not found');
        }

        const deleted = await ProjectFileManagerModel.removeUser(id, userId);
        if (!deleted) {
            return notFound(res, 'User assignment not found');
        }

        await writeFileManagerLog({
            action: 'DELETE',
            entityType: 'permission',
            itemId: id,
            itemName:
                existing.folder_name || existing.name || existing.project_code,
            targetUsername: deleted.username,
            fieldName: 'role',
            oldValue: deleted.role,
            newValue: null,
            updatedBy: actorUsername,
            updatedByUserId: ownerId,
        });

        return res.json({
            success: true,
            message: 'User removed from project folder',
            data: deleted,
        });
    }

    /** GET /project-file-manager/:id/access/:userId — check one user's permissions */
    static async getUserAccess(req, res) {
        const id = parseId(req.params.id);
        const userId = parseId(req.params.userId);
        if (!id || !userId) {
            return res.status(400).json({
                success: false,
                message: 'Valid id and userId are required',
            });
        }

        const existing = await ProjectFileManagerModel.findById(id);
        if (!existing) {
            return notFound(res, 'Project file manager folder not found');
        }

        const access = await ProjectFileManagerModel.findUserAccess(id, userId);
        return res.json({
            success: true,
            data: access || {
                project_folder_id: id,
                user_id: userId,
                role: null,
            },
        });
    }
}

wrapController(ProjectFileManagerController, [
    'list',
    'syncFromDisk',
    'myAccess',
    'getByProjectId',
    'getById',
    'create',
    'createPcbFolders',
    'update',
    'remove',
    'listUsers',
    'assignUsers',
    'updateUser',
    'removeUser',
    'getUserAccess',
]);

export default ProjectFileManagerController;
