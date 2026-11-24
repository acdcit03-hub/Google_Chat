import BomGoogleSheetModel from '../../models/r2r/bomGoogleSheet.model.js';
import CategoriesFolderStructureModel from '../../models/filemanager/categoriesFolderStructure.model.js';
import ProjectFileManagerModel from '../../models/filemanager/projectFileManager.model.js';
import GoogleFileService, {
    GoogleAuthError,
} from '../../services/filemanager/googleFile.service.js';
import { resolveActor } from '../filemanager/fileManager.controller.js';
import { wrapController } from '../../middleware/error.middleware.js';

const BOM_HEADERS = [
    'SR. NO.',
    'SKU',
    'VALUE',
    'FOOTPRINT',
    'DESIGNATOR',
    'PER PCS QTY',
    'SMD/TH',
    'TOP / BOTTOM',
    'REQ. QTY',
    'DISPATCHED QTY. TO VENDOR',
    'TO BE RETURN',
    'PRICE PER PIECE',
    'COMPONENT BY',
    'COMMENT',
];

function cell(value) {
    if (value == null) return '';
    return String(value);
}

/** Extract Google Spreadsheet id from a Drive/Sheets URL. */
function extractSpreadsheetIdFromUrl(url) {
    const raw = String(url || '').trim();
    if (!raw) return '';
    return (
        raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)?.[1] ||
        raw.match(/^[a-zA-Z0-9-_]{20,}$/)?.[0] ||
        ''
    );
}

/**
 * Categories folder_scope=google_sheet — assigned BOM template spreadsheet id.
 * Prefers rows whose file/folder name looks like BOM; otherwise first with a URL.
 */
async function resolveCategoriesBomTemplateSpreadsheetId() {
    const rows = await CategoriesFolderStructureModel.findAll({
        folder_scope: 'google_sheet',
        is_active: true,
    });
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) {
        const err = new Error(
            'No categories Google Sheet assigned. Set folder_scope=google_sheet with google_sheet_url in Categories folder structure (BOM template).',
        );
        err.status = 400;
        throw err;
    }

    const score = (row) => {
        const name = `${row?.google_sheet_file_name || ''} ${row?.folder_name || ''} ${row?.folder_path || ''}`.toLowerCase();
        if (/\bbom\b|_bom|main_bom|mainbom/.test(name)) return 2;
        if (name.includes('sheet')) return 1;
        return 0;
    };

    const sorted = [...list].sort((a, b) => score(b) - score(a));
    for (const row of sorted) {
        const id = extractSpreadsheetIdFromUrl(row?.google_sheet_url);
        if (id) return { spreadsheetId: id, row };
    }

    const err = new Error(
        'Categories BOM Google Sheet has no valid google_sheet_url. Assign the template spreadsheet URL in Categories folder structure.',
    );
    err.status = 400;
    throw err;
}

/** Format YYYY-MM-DD → DD/MM/YY (sheet style); leave other values as-is. */
function formatSheetDate(value) {
    const raw = cell(value).trim();
    if (!raw) return '';
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return raw;
    return `${m[3]}/${m[2]}/${m[1].slice(2)}`;
}

function toNumber(value) {
    const n = Number(String(value ?? '').replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : 0;
}

/**
 * ACDC BOM sheet layout:
 *  Row 1: PROJECT CODE | value | PROJECT NAME | value
 *  Row 2: VERIFICATION DATE | value | CLIENT CODE | value | TOTAL PRICE FOR PER PIECE | value
 *  Row 3: VERIFICATION PERSON NAME | value | TOTAL PCB QTY | value
 *  Row 4: column headers (no TOTAL PRICE column)
 *  Row 5+: line items
 */
function formatMoney(n) {
    if (!Number.isFinite(n) || n === 0) return '';
    return String(Math.round(n * 10000) / 10000);
}

function buildBomSheetMatrix(meta = {}, rows = []) {
    const m = meta && typeof meta === 'object' ? meta : {};
    const list = Array.isArray(rows) ? rows : [];
    const pcbQty = toNumber(m.pcb_qty);

    // Cost for one PCB = Σ (PER PCS QTY × PRICE PER PIECE)
    const totalPriceForPerPiece =
        m.total_price_for_per_piece != null &&
        String(m.total_price_for_per_piece).trim() !== ''
            ? cell(m.total_price_for_per_piece)
            : formatMoney(
                  list.reduce(
                      (sum, row) =>
                          sum +
                          toNumber(row?.per_pcs_qty) *
                              toNumber(row?.price_per_piece),
                      0,
                  ),
              );

    const matrix = [
        [
            '',
            '',
            'PROJECT CODE',
            cell(m.project_code),
            'PROJECT NAME',
            cell(m.project_name),
        ],
        [
            '',
            '',
            'VERIFICATION DATE',
            formatSheetDate(m.verification_date),
            'CLIENT CODE',
            cell(m.client_code),
            'TOTAL PRICE FOR PER PIECE',
            totalPriceForPerPiece,
        ],
        [
            '',
            '',
            'VERIFICATION PERSON NAME',
            cell(m.verification_person_name),
            'TOTAL PCB QTY',
            cell(m.pcb_qty),
        ],
        BOM_HEADERS,
    ];

    list.forEach((row, index) => {
        const r = row && typeof row === 'object' ? row : {};
        const perPcs = cell(r.per_pcs_qty);
        let reqQty = cell(r.req_qty);
        if (!reqQty && perPcs && pcbQty) {
            reqQty = String(toNumber(perPcs) * pcbQty);
        }

        matrix.push([
            String(index + 1),
            cell(r.sku_mpn),
            cell(r.value),
            cell(r.footprint),
            cell(r.designator),
            perPcs,
            cell(r.smd_th),
            cell(r.top_bottom),
            reqQty,
            cell(r.dispatched_qty_to_vendor) || '0',
            cell(r.to_be_return) || '0',
            cell(r.price_per_piece),
            cell(r.component_by),
            cell(r.comment),
        ]);
    });

    return matrix;
}

class BomController {
    /** GET /r2r/bom — list sheets created by current user (admin: ?all=true for everyone) */
    static async list(req, res) {
        const { ownerId, username, isAdmin } = await resolveActor(req);
        if (ownerId == null || !username) {
            return res.status(401).json({
                success: false,
                message: 'Unauthorized',
            });
        }

        const allowAll =
            isAdmin &&
            ['1', 'true', 'yes'].includes(
                String(req.query?.all || '').trim().toLowerCase(),
            );

        const rows = await BomGoogleSheetModel.list({
            project_code: req.query?.project_code || null,
            search: req.query?.search || req.query?.q || null,
            limit: req.query?.limit,
            ...(allowAll
                ? {}
                : {
                      created_by_user_id: ownerId,
                      created_by_username: username,
                  }),
        });
        return res.json({ success: true, count: rows.length, data: rows });
    }

    /** GET /r2r/bom/:id */
    static async getById(req, res) {
        const id = Number(req.params.id);
        if (!Number.isFinite(id) || id <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Valid id is required',
            });
        }
        const row = await BomGoogleSheetModel.findById(id);
        if (!row) {
            return res.status(404).json({
                success: false,
                message: 'BOM sheet not found',
            });
        }
        return res.json({ success: true, data: row });
    }

    /**
     * POST /r2r/bom/sync-google-sheet
     * Ask sheet name → create Google Sheet (sub sheet tab) → write BOM data → store URL.
     */
    static async syncGoogleSheet(req, res) {
        const { ownerId, username } = await resolveActor(req);

        if (ownerId == null || !username) {
            console.warn('[BOM Sync] unauthorized');
            return res.status(401).json({
                success: false,
                message: 'Unauthorized',
            });
        }

        const sheetName = String(
            req.body?.sheet_name ?? req.body?.sheetName ?? '',
        ).trim();
        const meta =
            req.body?.meta && typeof req.body.meta === 'object'
                ? req.body.meta
                : {};
        const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
        const sourceSheetUrl = String(
            req.body?.source_google_sheet_url ??
                req.body?.google_sheet_url ??
                req.body?.spreadsheet_url ??
                '',
        ).trim();
        const spreadsheetIdFromBody = String(
            req.body?.spreadsheet_id ?? req.body?.google_file_id ?? '',
        ).trim();
        const spreadsheetIdMatch = sourceSheetUrl.match(
            /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/,
        );
        const targetSpreadsheetId =
            spreadsheetIdFromBody || spreadsheetIdMatch?.[1] || '';

        console.log('[BOM Sync] request received', {
            username,
            ownerId,
            sheet_name: sheetName,
            project_code: meta?.project_code,
            row_count: rows.length,
            target_spreadsheet_id: targetSpreadsheetId || null,
            mode: targetSpreadsheetId ? 'add_tab' : 'create_new',
        });

        if (!sheetName) {
            console.warn('[BOM Sync] validation failed: sheet name required');
            return res.status(400).json({
                success: false,
                message: 'Sheet name is required',
            });
        }
        if (!String(meta.project_code || '').trim()) {
            console.warn('[BOM Sync] validation failed: project code required');
            return res.status(400).json({
                success: false,
                message: 'Project code is required',
            });
        }
        if (!rows.length) {
            console.warn('[BOM Sync] validation failed: no rows');
            return res.status(400).json({
                success: false,
                message: 'At least one BOM row is required',
            });
        }

        const matrix = buildBomSheetMatrix(meta, rows);
        let googleMeta;

        try {
            if (targetSpreadsheetId) {
                // Import-link flow: add a NEW tab inside the existing workbook
                // (does not overwrite MAIN BOM / LO1 / other tabs)
                console.log('[BOM Sync] adding tab to existing spreadsheet…', {
                    spreadsheetId: targetSpreadsheetId,
                    sheetName,
                    matrix_rows: matrix.length,
                });
                googleMeta = await GoogleFileService.addGoogleSheetTabWithData({
                    userId: ownerId,
                    spreadsheetId: targetSpreadsheetId,
                    sheetTabName: sheetName,
                    values: matrix,
                });
            } else {
                const driveFolderId = String(
                    req.body?.google_drive_folder_id ||
                        process.env.GOOGLE_DRIVE_FOLDER_ID ||
                        '',
                ).trim();
                if (!driveFolderId) {
                    console.error(
                        '[BOM Sync] GOOGLE_DRIVE_FOLDER_ID is not configured',
                    );
                    return res.status(400).json({
                        success: false,
                        message:
                            'Google Drive folder is not configured (GOOGLE_DRIVE_FOLDER_ID)',
                    });
                }

                console.log('[BOM Sync] creating new Google Sheet…', {
                    sheetName,
                    driveFolderId,
                    matrix_rows: matrix.length,
                });
                googleMeta = await GoogleFileService.createGoogleSheetWithData({
                    userId: ownerId,
                    title: sheetName,
                    sheetTabName: sheetName,
                    googleDriveFolderId: driveFolderId,
                    values: matrix,
                });
            }

            console.log('[BOM Sync] Google Sheet ready', {
                mode: googleMeta.mode || 'create_new',
                google_file_id: googleMeta.google_file_id,
                url: googleMeta.url,
                sheet_title: googleMeta.sheet_title,
                rows_written: googleMeta.rows_written,
            });
        } catch (gErr) {
            if (
                gErr instanceof GoogleAuthError ||
                gErr?.code === 'GOOGLE_NOT_CONNECTED' ||
                gErr?.code === 'GOOGLE_INVALID_CLIENT' ||
                gErr?.code === 'GOOGLE_INVALID_GRANT'
            ) {
                console.error('[BOM Sync] Google auth error', {
                    code: gErr?.code,
                    message: gErr?.message,
                });
                return res.status(gErr.status || 401).json({
                    success: false,
                    message: gErr.message || 'Google account is not connected',
                });
            }
            console.error(
                '[BOM Sync] Google Sheet create/write failed:',
                gErr?.cause?.message || gErr?.message || gErr,
            );
            return res
                .status(gErr.status && gErr.status < 500 ? gErr.status : 502)
                .json({
                    success: false,
                    message:
                        gErr.status === 400 || gErr.status === 409
                            ? gErr.message
                            : 'Failed to create / sync Google Sheet',
                });
        }

        const saved = await BomGoogleSheetModel.create({
            sheet_name: sheetName,
            project_code: meta.project_code,
            project_name: meta.project_name,
            google_file_id: googleMeta.google_file_id,
            google_sheet_url: googleMeta.url,
            sheet_tab_name: googleMeta.sheet_title || sheetName,
            meta,
            rows,
            created_by_user_id: ownerId,
            created_by_username: username,
        });

        console.log('[BOM Sync] success — saved to DB', {
            id: saved.id,
            sheet_name: saved.sheet_name,
            google_sheet_url: saved.google_sheet_url,
            row_count: saved.row_count,
            mode: targetSpreadsheetId ? 'add_tab' : 'create_new',
        });

        return res.status(201).json({
            success: true,
            message: targetSpreadsheetId
                ? 'BOM synced as a new sheet tab'
                : 'BOM synced to Google Sheet',
            data: {
                id: saved.id,
                sheet_name: saved.sheet_name,
                sheet_tab_name: saved.sheet_tab_name,
                google_file_id: saved.google_file_id,
                google_sheet_url: saved.google_sheet_url,
                row_count: saved.row_count,
                project_code: saved.project_code,
                created_at: saved.created_at,
                mode: targetSpreadsheetId ? 'add_tab' : 'create_new',
            },
        });
    }

    /**
     * GET /r2r/bom/google-sheet-tabs?spreadsheet_id=… | ?url=…
     * List all worksheet tabs (subsheets) inside a Google Spreadsheet.
     */
    static async listGoogleSheetTabs(req, res) {
        const { ownerId, username } = await resolveActor(req);
        if (ownerId == null || !username) {
            return res.status(401).json({
                success: false,
                message: 'Unauthorized',
            });
        }

        const fromQuery = String(
            req.query?.spreadsheet_id ||
                req.query?.google_file_id ||
                req.query?.id ||
                '',
        ).trim();
        const url = String(
            req.query?.url ||
                req.query?.google_sheet_url ||
                req.query?.spreadsheet_url ||
                '',
        ).trim();
        const fromUrl = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)?.[1] || '';
        const spreadsheetId = fromQuery || fromUrl;

        if (!spreadsheetId) {
            return res.status(400).json({
                success: false,
                message: 'spreadsheet_id or Google Sheet url is required',
            });
        }

        try {
            const data = await GoogleFileService.listGoogleSheetTabs({
                userId: ownerId,
                spreadsheetId,
            });
            return res.json({
                success: true,
                count: data.count,
                data,
            });
        } catch (error) {
            if (error instanceof GoogleAuthError) {
                return res.status(error.status || 401).json({
                    success: false,
                    message: error.message,
                    code: error.code,
                });
            }
            const status = error?.status || 500;
            return res.status(status).json({
                success: false,
                message: error?.message || 'Failed to list sheet tabs',
            });
        }
    }

    /**
     * GET /r2r/bom/google-sheet-data?spreadsheet_id=…&sheet_tab_name=…
     * Fetch column headers + all row values from one worksheet tab.
     */
    static async getGoogleSheetTabData(req, res) {
        const { ownerId, username } = await resolveActor(req);
        if (ownerId == null || !username) {
            return res.status(401).json({
                success: false,
                message: 'Unauthorized',
            });
        }

        const fromQuery = String(
            req.query?.spreadsheet_id ||
                req.query?.google_file_id ||
                req.query?.id ||
                '',
        ).trim();
        const url = String(
            req.query?.url ||
                req.query?.google_sheet_url ||
                req.query?.spreadsheet_url ||
                '',
        ).trim();
        const fromUrl =
            url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)?.[1] || '';
        const spreadsheetId = fromQuery || fromUrl;
        const sheetTabName = String(
            req.query?.sheet_tab_name ||
                req.query?.tab ||
                req.query?.sheet_name ||
                '',
        ).trim();

        if (!spreadsheetId) {
            return res.status(400).json({
                success: false,
                message: 'spreadsheet_id or Google Sheet url is required',
            });
        }
        if (!sheetTabName) {
            return res.status(400).json({
                success: false,
                message: 'sheet_tab_name is required',
            });
        }

        try {
            const data = await GoogleFileService.readGoogleSheetTabData({
                userId: ownerId,
                spreadsheetId,
                sheetTabName,
            });
            return res.json({
                success: true,
                data,
            });
        } catch (error) {
            if (error instanceof GoogleAuthError) {
                return res.status(error.status || 401).json({
                    success: false,
                    message: error.message,
                    code: error.code,
                });
            }
            const status = error?.status || 500;
            return res.status(status).json({
                success: false,
                message: error?.message || 'Failed to read sheet tab data',
            });
        }
    }

    /**
     * POST /r2r/bom/update-google-sheet-tab
     * Write values into an existing tab only (no new sheet, no format changes).
     */
    static async updateGoogleSheetTab(req, res) {
        const { ownerId, username } = await resolveActor(req);
        if (ownerId == null || !username) {
            return res.status(401).json({
                success: false,
                message: 'Unauthorized',
            });
        }

        const sourceSheetUrl = String(
            req.body?.source_google_sheet_url ??
                req.body?.google_sheet_url ??
                req.body?.spreadsheet_url ??
                req.body?.url ??
                '',
        ).trim();
        const spreadsheetIdFromBody = String(
            req.body?.spreadsheet_id ?? req.body?.google_file_id ?? '',
        ).trim();
        const fromUrl =
            sourceSheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)?.[1] ||
            '';
        const spreadsheetId = spreadsheetIdFromBody || fromUrl;
        const sheetTabName = String(
            req.body?.sheet_tab_name ??
                req.body?.sheet_name ??
                req.body?.tab ??
                '',
        ).trim();
        const values = Array.isArray(req.body?.values) ? req.body.values : [];

        if (!spreadsheetId) {
            return res.status(400).json({
                success: false,
                message: 'spreadsheet_id or Google Sheet url is required',
            });
        }
        if (!sheetTabName) {
            return res.status(400).json({
                success: false,
                message: 'sheet_tab_name is required',
            });
        }
        if (!values.length) {
            return res.status(400).json({
                success: false,
                message: 'values matrix is required',
            });
        }

        try {
            const googleMeta = await GoogleFileService.updateGoogleSheetTabValues(
                {
                    userId: ownerId,
                    spreadsheetId,
                    sheetTabName,
                    values,
                },
            );

            return res.json({
                success: true,
                message: `Saved to tab "${googleMeta.sheet_tab_name}"`,
                data: {
                    google_file_id: googleMeta.google_file_id,
                    google_sheet_url: googleMeta.url,
                    sheet_tab_name: googleMeta.sheet_tab_name,
                    sheet_name: googleMeta.sheet_tab_name,
                    row_count: googleMeta.rows_written,
                    mode: 'update_tab',
                },
            });
        } catch (error) {
            if (error instanceof GoogleAuthError) {
                return res.status(error.status || 401).json({
                    success: false,
                    message: error.message,
                    code: error.code,
                });
            }
            const status = error?.status || 500;
            return res.status(status).json({
                success: false,
                message: error?.message || 'Failed to update sheet tab',
            });
        }
    }

    /**
     * POST /r2r/bom/add-google-sheet-tab
     * Add LO1/LO2/… by copying the LON tab from the categories structure
     * assigned BOM Google Sheet (never MAIN BOM / current LO data).
     */
    static async addGoogleSheetTab(req, res) {
        const { ownerId, username } = await resolveActor(req);
        if (ownerId == null || !username) {
            return res.status(401).json({
                success: false,
                message: 'Unauthorized',
            });
        }

        const sourceSheetUrl = String(
            req.body?.source_google_sheet_url ??
                req.body?.google_sheet_url ??
                req.body?.url ??
                '',
        ).trim();
        const spreadsheetIdFromBody = String(
            req.body?.spreadsheet_id ?? req.body?.google_file_id ?? '',
        ).trim();
        const fromUrl =
            sourceSheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)?.[1] ||
            '';
        const spreadsheetId = spreadsheetIdFromBody || fromUrl;
        const sheetTabName = String(
            req.body?.sheet_tab_name ??
                req.body?.sheet_name ??
                req.body?.tab ??
                '',
        ).trim();

        if (!spreadsheetId) {
            return res.status(400).json({
                success: false,
                message: 'spreadsheet_id or Google Sheet url is required',
            });
        }
        if (!sheetTabName) {
            return res.status(400).json({
                success: false,
                message: 'sheet_tab_name is required',
            });
        }

        try {
            // LON always from categories assigned BOM template sheet
            const { spreadsheetId: templateSpreadsheetId } =
                await resolveCategoriesBomTemplateSpreadsheetId();

            const googleMeta = await GoogleFileService.duplicateGoogleSheetTab({
                userId: ownerId,
                spreadsheetId,
                sheetTabName,
                requireLonTemplate: true,
                clearDataRowsAfterCopy: true,
                templateSpreadsheetId,
                sourceSheetTitleHints: ['LON'],
            });

            // Fill {projectcode}_{pcbcode} on new LO tab (+ MAIN BOM if label empty/missing)
            let projectPcbFill = null;
            if (googleMeta.mode !== 'already_exists') {
                try {
                    const resolved =
                        await GoogleFileService.resolveProjectPcbCodeForSpreadsheet(
                            {
                                userId: ownerId,
                                spreadsheetId,
                                dbLookup: (fileId) =>
                                    ProjectFileManagerModel.findItemByGoogleFileId(
                                        fileId,
                                    ),
                            },
                        );
                    if (resolved.project_pcb_code) {
                        projectPcbFill =
                            await GoogleFileService.fillBomHeaderProjectPcbCode(
                                {
                                    userId: ownerId,
                                    spreadsheetId,
                                    projectCode: resolved.project_code,
                                    pcbCode: resolved.pcb_code,
                                    projectPcbCode: resolved.project_pcb_code,
                                    // New LO + MAIN BOM (user wants code on both)
                                    onlySheetTitles: [
                                        googleMeta.sheet_title,
                                        'MAIN BOM',
                                    ],
                                },
                            );
                    }
                } catch (fillErr) {
                    console.warn(
                        '[BOM add tab] project_pcb_code fill skipped:',
                        fillErr?.message || fillErr,
                    );
                }
            }

            return res.status(201).json({
                success: true,
                message:
                    googleMeta.mode === 'already_exists'
                        ? `Tab "${googleMeta.sheet_title}" already exists`
                        : `Added "${googleMeta.sheet_title}" from categories LON format`,
                data: {
                    google_file_id: googleMeta.google_file_id,
                    google_sheet_url: googleMeta.url,
                    sheet_tab_name: googleMeta.sheet_title,
                    sheet_id: googleMeta.sheet_gid,
                    source_sheet_title: googleMeta.source_sheet_title || 'LON',
                    mode: googleMeta.mode || 'add_tab',
                    project_pcb_code:
                        projectPcbFill?.project_pcb_code || null,
                },
            });
        } catch (error) {
            if (error instanceof GoogleAuthError) {
                return res.status(error.status || 401).json({
                    success: false,
                    message: error.message,
                    code: error.code,
                });
            }
            const status = error?.status || 500;
            return res.status(status).json({
                success: false,
                message: error?.message || 'Failed to add sheet tab',
            });
        }
    }
}

wrapController(BomController, [
    'list',
    'getById',
    'syncGoogleSheet',
    'listGoogleSheetTabs',
    'getGoogleSheetTabData',
    'updateGoogleSheetTab',
    'addGoogleSheetTab',
]);

export default BomController;
