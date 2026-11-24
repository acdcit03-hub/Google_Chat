import {
    getExistingGoogleAuthForUser,
    getDriveClient,
    getSheetsClient,
    GoogleAuthError,
    mapGoogleApiAuthError,
} from './googleAuth.service.js';

const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const DOC_MIME = 'application/vnd.google-apps.document';

export { GoogleAuthError };

function sheetEditUrl(spreadsheetId, gid) {
    const base = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
    if (gid == null || gid === '') return base;
    return `${base}#gid=${gid}`;
}

function docEditUrl(documentId) {
    return `https://docs.google.com/document/d/${documentId}/edit`;
}

/** Data row bands: light blue → peach → green (matches ACDC template). */
const BOM_ROW_BAND_COLORS = [
    { red: 0.867, green: 0.922, blue: 0.969 }, // light blue
    { red: 0.988, green: 0.894, blue: 0.839 }, // peach / orange
    { red: 0.886, green: 0.937, blue: 0.855 }, // light green
];
/** Table header: pale yellow */
const BOM_HEADER_BG = { red: 1, green: 0.949, blue: 0.8 };
const BOM_META_LABEL_BG = { red: 1, green: 1, blue: 1 };
const BOM_BLACK = { red: 0, green: 0, blue: 0 };
const BOM_META_HEADER_ROWS = 3;
const BOM_TABLE_HEADER_ROW = 3;
const BOM_DATA_START_ROW = 4;
const BOM_COL_COUNT = 14;
const BOM_COL_SMD_TH = 6;
const BOM_COL_TOP_BOTTOM = 7;
const BOM_COL_COMPONENT_BY = 12;

function bomRgb(color) {
    return { red: color.red, green: color.green, blue: color.blue };
}

function bomBorder(style = 'SOLID_MEDIUM', width = 2) {
    return {
        style,
        width,
        color: bomRgb(BOM_BLACK),
    };
}

function bomCellRange(sheetId, startRow, endRow, startCol = 0, endCol = BOM_COL_COUNT) {
    return {
        sheetId,
        startRowIndex: startRow,
        endRowIndex: endRow,
        startColumnIndex: startCol,
        endColumnIndex: endCol,
    };
}

function bomDropdownRule(values) {
    return {
        condition: {
            type: 'ONE_OF_LIST',
            values: values.map((v) => ({ userEnteredValue: v })),
        },
        showCustomUi: true,
        strict: false,
    };
}

function buildBomSheetFormatRequests(sheetId, dataRowCount) {
    const requests = [];
    const sid = Number(sheetId);
    if (!Number.isFinite(sid)) return requests;

    const count = Math.max(0, Number(dataRowCount) || 0);
    const dataEndRow = BOM_DATA_START_ROW + count;

    requests.push({
        updateSheetProperties: {
            properties: {
                sheetId: sid,
                gridProperties: { frozenRowCount: BOM_DATA_START_ROW },
            },
            fields: 'gridProperties.frozenRowCount',
        },
    });

    // Meta label cells (C/E/G) — bold
    for (let row = 0; row < BOM_META_HEADER_ROWS; row++) {
        for (const col of [2, 4, 6]) {
            requests.push({
                repeatCell: {
                    range: bomCellRange(sid, row, row + 1, col, col + 1),
                    cell: {
                        userEnteredFormat: {
                            textFormat: { bold: true, fontSize: 10 },
                            backgroundColor: bomRgb(BOM_META_LABEL_BG),
                            horizontalAlignment: 'LEFT',
                            verticalAlignment: 'MIDDLE',
                        },
                    },
                    fields:
                        'userEnteredFormat(textFormat,backgroundColor,horizontalAlignment,verticalAlignment)',
                },
            });
        }
    }

    // Meta block dark outer + inner borders (C1:H3)
    requests.push({
        updateBorders: {
            range: bomCellRange(sid, 0, BOM_META_HEADER_ROWS, 2, 8),
            top: bomBorder('SOLID_THICK', 3),
            bottom: bomBorder('SOLID_THICK', 3),
            left: bomBorder('SOLID_THICK', 3),
            right: bomBorder('SOLID_THICK', 3),
            innerHorizontal: bomBorder('SOLID', 1),
            innerVertical: bomBorder('SOLID', 1),
        },
    });

    // Table header — pale yellow, black bold, centered
    requests.push({
        repeatCell: {
            range: bomCellRange(
                sid,
                BOM_TABLE_HEADER_ROW,
                BOM_TABLE_HEADER_ROW + 1,
            ),
            cell: {
                userEnteredFormat: {
                    backgroundColor: bomRgb(BOM_HEADER_BG),
                    textFormat: {
                        bold: true,
                        foregroundColor: bomRgb(BOM_BLACK),
                        fontSize: 10,
                    },
                    horizontalAlignment: 'CENTER',
                    verticalAlignment: 'MIDDLE',
                    wrapStrategy: 'WRAP',
                },
            },
            fields:
                'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy)',
        },
    });

    // Dark thick borders on header cells
    requests.push({
        updateBorders: {
            range: bomCellRange(
                sid,
                BOM_TABLE_HEADER_ROW,
                BOM_TABLE_HEADER_ROW + 1,
            ),
            top: bomBorder('SOLID_THICK', 3),
            bottom: bomBorder('SOLID_THICK', 3),
            left: bomBorder('SOLID_THICK', 3),
            right: bomBorder('SOLID_THICK', 3),
            innerVertical: bomBorder('SOLID_MEDIUM', 2),
        },
    });

    // Data row band colours + thin grid
    for (let i = 0; i < count; i++) {
        const row = BOM_DATA_START_ROW + i;
        const band = BOM_ROW_BAND_COLORS[i % BOM_ROW_BAND_COLORS.length];
        requests.push({
            repeatCell: {
                range: bomCellRange(sid, row, row + 1),
                cell: {
                    userEnteredFormat: {
                        backgroundColor: bomRgb(band),
                        verticalAlignment: 'MIDDLE',
                        horizontalAlignment: 'CENTER',
                        textFormat: { fontSize: 10 },
                    },
                },
                fields:
                    'userEnteredFormat(backgroundColor,verticalAlignment,horizontalAlignment,textFormat)',
            },
        });
    }

    if (count > 0) {
        requests.push({
            updateBorders: {
                range: bomCellRange(sid, BOM_DATA_START_ROW, dataEndRow),
                top: bomBorder('SOLID', 1),
                bottom: bomBorder('SOLID', 1),
                left: bomBorder('SOLID', 1),
                right: bomBorder('SOLID', 1),
                innerHorizontal: bomBorder('SOLID', 1),
                innerVertical: bomBorder('SOLID', 1),
            },
        });

        // Dropdowns: SMD/TH, TOP / BOTTOM, COMPONENT BY
        requests.push({
            setDataValidation: {
                range: bomCellRange(
                    sid,
                    BOM_DATA_START_ROW,
                    dataEndRow,
                    BOM_COL_SMD_TH,
                    BOM_COL_SMD_TH + 1,
                ),
                rule: bomDropdownRule(['SMD', 'TH']),
            },
        });
        requests.push({
            setDataValidation: {
                range: bomCellRange(
                    sid,
                    BOM_DATA_START_ROW,
                    dataEndRow,
                    BOM_COL_TOP_BOTTOM,
                    BOM_COL_TOP_BOTTOM + 1,
                ),
                rule: bomDropdownRule(['TOP', 'BOTTOM', 'BOTH']),
            },
        });
        requests.push({
            setDataValidation: {
                range: bomCellRange(
                    sid,
                    BOM_DATA_START_ROW,
                    dataEndRow,
                    BOM_COL_COMPONENT_BY,
                    BOM_COL_COMPONENT_BY + 1,
                ),
                rule: bomDropdownRule(['ACDC', 'CLIENT']),
            },
        });
    }

    requests.push({
        autoResizeDimensions: {
            dimensions: {
                sheetId: sid,
                dimension: 'COLUMNS',
                startIndex: 0,
                endIndex: BOM_COL_COUNT,
            },
        },
    });

    return requests;
}

async function applyBomSheetFormatting(sheets, spreadsheetId, sheetId, dataRowCount) {
    const requests = buildBomSheetFormatRequests(sheetId, dataRowCount);
    if (!requests.length) return;
    await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests },
    });
}

/**
 * Move a Drive file into targetFolderId (remove other parents).
 */
export async function moveToDriveFolder(drive, fileId, targetFolderId) {
    const meta = await drive.files.get({
        fileId,
        fields: 'id,parents',
        supportsAllDrives: true,
    });
    const previousParents = (meta.data.parents || []).join(',');
    const updated = await drive.files.update({
        fileId,
        addParents: targetFolderId,
        removeParents: previousParents || undefined,
        fields: 'id,parents,webViewLink,mimeType,name',
        supportsAllDrives: true,
    });
    return updated.data;
}

export async function deleteDriveFile(drive, fileId) {
    if (!fileId) return;
    try {
        await drive.files.delete({
            fileId,
            supportsAllDrives: true,
        });
    } catch (err) {
        console.warn(
            'Failed to cleanup Google Drive file',
            fileId,
            err?.message || err,
        );
    }
}

/**
 * Grant Drive permission on a file.
 * role: reader | commenter | writer (edit)
 */
export async function shareDriveFileWithEmail(
    drive,
    fileId,
    email,
    role = 'writer',
) {
    const mail = String(email || '').trim().toLowerCase();
    if (!fileId || !mail || !mail.includes('@')) {
        return { shared: false, reason: 'invalid_email' };
    }

    try {
        await drive.permissions.create({
            fileId,
            supportsAllDrives: true,
            sendNotificationEmail: false,
            requestBody: {
                type: 'user',
                role,
                emailAddress: mail,
            },
            fields: 'id,role,emailAddress',
        });
        return { shared: true, email: mail, role };
    } catch (err) {
        // Already has access
        const status = err?.code || err?.response?.status;
        if (status === 400 || status === 403) {
            const msg = String(err?.message || '').toLowerCase();
            if (msg.includes('already') || msg.includes('duplicate')) {
                return { shared: true, email: mail, role, already: true };
            }
        }
        console.warn(
            'Failed to share Google Drive file with',
            mail,
            err?.message || err,
        );
        return {
            shared: false,
            email: mail,
            role,
            error: err?.message || 'share_failed',
        };
    }
}

/**
 * Create a Google Sheet, move into Drive folder, share edit emails, return metadata.
 * On move failure, deletes the new Sheet.
 * When sourceSpreadsheetId is set, copies that template instead of creating blank.
 */
export async function createGoogleSheet({
    userId,
    title,
    googleDriveFolderId,
    shareEditEmails = [],
    sourceSpreadsheetId = null,
}) {
    const name = String(title || '').trim();
    const folderId = String(googleDriveFolderId || '').trim();
    const sourceId = String(sourceSpreadsheetId || '').trim();
    if (!name) {
        const err = new Error('Sheet name is required');
        err.status = 400;
        throw err;
    }
    if (!folderId) {
        const err = new Error(
            'Google Drive folder is not configured for this ERP folder',
        );
        err.status = 400;
        throw err;
    }

    const { auth } = await getExistingGoogleAuthForUser(userId);
    const sheets = getSheetsClient(auth);
    const drive = getDriveClient(auth);

    let spreadsheetId = null;
    try {
        if (sourceId) {
            const copied = await drive.files.copy({
                fileId: sourceId,
                requestBody: { name },
                fields: 'id,name,webViewLink,mimeType',
                supportsAllDrives: true,
            });
            spreadsheetId = copied.data.id;
            if (!spreadsheetId) {
                throw new Error('Google Drive copy did not return file id');
            }
        } else {
        const created = await sheets.spreadsheets.create({
            requestBody: {
                properties: { title: name },
            },
            fields: 'spreadsheetId,properties.title',
        });
        spreadsheetId = created.data.spreadsheetId;
        if (!spreadsheetId) {
            throw new Error('Google Sheets API did not return spreadsheetId');
            }
        }

        await moveToDriveFolder(drive, spreadsheetId, folderId);

        const emails = Array.isArray(shareEditEmails)
            ? [
                  ...new Set(
                      shareEditEmails
                          .map((e) => String(e || '').trim().toLowerCase())
                          .filter((e) => e.includes('@')),
                  ),
              ]
            : [];
        const shares = [];
        for (const email of emails) {
            shares.push(
                await shareDriveFileWithEmail(
                    drive,
                    spreadsheetId,
                    email,
                    'writer',
                ),
            );
        }

        return {
            google_file_id: spreadsheetId,
            google_drive_folder_id: folderId,
            url: sheetEditUrl(spreadsheetId),
            mime_type: SHEET_MIME,
            name,
            file_source: 'google_sheet',
            mode: sourceId ? 'copied_from_template' : 'created',
            shares,
        };
    } catch (err) {
        if (spreadsheetId) {
            await deleteDriveFile(drive, spreadsheetId);
        }
        if (err instanceof GoogleAuthError) throw err;
        const authErr = mapGoogleApiAuthError(err);
        if (authErr) throw authErr;
        const wrapped = new Error(
            err?.message || 'Failed to create Google Sheet',
        );
        wrapped.status = err?.status || err?.code === 401 ? 401 : 502;
        wrapped.cause = err;
        throw wrapped;
    }
}

/**
 * Rename the first worksheet tab and write a 2D values matrix (overwrite).
 */
export async function writeGoogleSheetMatrix({
    userId,
    spreadsheetId,
    sheetTitle,
    values,
    applyBomFormatting = false,
}) {
    const id = String(spreadsheetId || '').trim();
    if (!id) {
        const err = new Error('spreadsheetId is required');
        err.status = 400;
        throw err;
    }

    const matrix = Array.isArray(values) ? values : [];
    const { auth } = await getExistingGoogleAuthForUser(userId);
    const sheets = getSheetsClient(auth);

    try {
        const meta = await sheets.spreadsheets.get({
            spreadsheetId: id,
            fields: 'sheets.properties(sheetId,title)',
        });
        const firstSheet = meta.data.sheets?.[0]?.properties;
        const sheetId = firstSheet?.sheetId;
        const title = String(sheetTitle || '').trim();

        if (title && sheetId != null) {
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId: id,
                requestBody: {
                    requests: [
                        {
                            updateSheetProperties: {
                                properties: {
                                    sheetId,
                                    title: title.slice(0, 100),
                                },
                                fields: 'title',
                            },
                        },
                    ],
                },
            });
        }

        const tabName =
            title ||
            String(firstSheet?.title || 'Sheet1').trim() ||
            'Sheet1';

        if (matrix.length) {
            await sheets.spreadsheets.values.clear({
                spreadsheetId: id,
                range: `'${tabName.replace(/'/g, "''")}'`,
            });
            await sheets.spreadsheets.values.update({
                spreadsheetId: id,
                range: `'${tabName.replace(/'/g, "''")}'!A1`,
                valueInputOption: 'USER_ENTERED',
                requestBody: { values: matrix },
            });
        }

        if (applyBomFormatting && sheetId != null) {
            const dataRowCount = Math.max(0, matrix.length - BOM_DATA_START_ROW);
            await applyBomSheetFormatting(sheets, id, sheetId, dataRowCount);
        }

        return {
            google_file_id: id,
            sheet_title: tabName,
            sheet_gid: sheetId ?? null,
            url: sheetEditUrl(id, sheetId),
            rows_written: matrix.length,
        };
    } catch (err) {
        if (err instanceof GoogleAuthError) throw err;
        const authErr = mapGoogleApiAuthError(err);
        if (authErr) throw authErr;
        const wrapped = new Error(
            err?.message || 'Failed to write Google Sheet data',
        );
        wrapped.status = err?.status || err?.code === 401 ? 401 : 502;
        wrapped.cause = err;
        throw wrapped;
    }
}

function colLetterFromIndex(index) {
    let n = Number(index) + 1;
    let s = '';
    while (n > 0) {
        const rem = (n - 1) % 26;
        s = String.fromCharCode(65 + rem) + s;
        n = Math.floor((n - 1) / 26);
    }
    return s || 'A';
}

function normalizeHeaderLabel(raw) {
    return String(raw || '')
        .replace(/\u200b/g, '')
        .trim()
        .toLowerCase()
        .replace(/[.]+$/g, '')
        .replace(/\s+/g, ' ');
}

/** Combined legacy label: PROJECT CODE_PCBCODE */
function isCombinedProjectPcbLabel(raw) {
    const h = normalizeHeaderLabel(raw);
    if (!h) return false;
    if (h === 'project code_pcbcode' || h === 'projectcode_pcbcode') return true;
    return h.includes('project code') && h.includes('pcb') && !/^pcb\b/.test(h);
}

/** Separate PROJECT CODE label (not PCB CODE, not combined). */
function isProjectCodeOnlyLabel(raw) {
    const h = normalizeHeaderLabel(raw);
    if (!h) return false;
    if (isCombinedProjectPcbLabel(raw)) return false;
    if (h === 'project code' || h === 'projectcode') return true;
    return h.includes('project code') && !h.includes('pcb');
}

/** Separate PCB CODE label. */
function isPcbCodeOnlyLabel(raw) {
    const h = normalizeHeaderLabel(raw);
    if (!h) return false;
    if (isCombinedProjectPcbLabel(raw)) return false;
    return (
        h === 'pcb code' ||
        h === 'pcbcode' ||
        h === 'pcb_code' ||
        (h.includes('pcb code') && !h.includes('project'))
    );
}

function isProjectCodePlaceholder(raw) {
    const t = String(raw || '')
        .replace(/\u200b/g, '')
        .trim()
        .toLowerCase();
    return (
        t === '{projectcode}' ||
        t === '{project_code}' ||
        t === '{project}'
    );
}

function isPcbCodePlaceholder(raw) {
    const t = String(raw || '')
        .replace(/\u200b/g, '')
        .trim()
        .toLowerCase();
    return t === '{pcbcode}' || t === '{pcb_code}' || t === '{pcb}';
}

function isCombinedProjectPcbPlaceholder(raw) {
    const t = String(raw || '')
        .replace(/\u200b/g, '')
        .trim()
        .toLowerCase();
    return (
        t === '{projectcode}_{pcbcode}' ||
        t === '{project_code}_{pcb_code}' ||
        t === '{projectcode_pcbcode}' ||
        (t.includes('{project') && t.includes('pcb') && t.includes('}') && t.includes('_'))
    );
}

function isOtherMetaLabel(raw) {
    const h = normalizeHeaderLabel(raw);
    if (!h) return false;
    if (
        isProjectCodeOnlyLabel(raw) ||
        isPcbCodeOnlyLabel(raw) ||
        isCombinedProjectPcbLabel(raw)
    ) {
        return false;
    }
    return (
        h.includes('project name') ||
        h.includes('verification') ||
        h.includes('client code') ||
        h.includes('total price') ||
        h.includes('total pcb') ||
        h === 'qty' ||
        h === 'sr. no' ||
        h === 'sr no'
    );
}

/**
 * Find value A1 for a given label matcher / placeholder matcher.
 * Template often has label in C and value in D or E.
 */
function findMetaValueA1(rows, quotedTab, {
    isLabel,
    isPlaceholder,
    fallbackOffset = 1,
}) {
    // 1) Explicit placeholder
    for (let r = 0; r < rows.length; r++) {
        const row = rows[r] || [];
        for (let c = 0; c < row.length; c++) {
            if (!isPlaceholder(row[c])) continue;
            return `${quotedTab}!${colLetterFromIndex(c)}${r + 1}`;
        }
    }

    // 2) Right of matching label
    for (let r = 0; r < rows.length; r++) {
        const row = rows[r] || [];
        for (let c = 0; c < row.length; c++) {
            if (!isLabel(row[c])) continue;
            let firstEmpty = null;
            for (let offset = 1; offset <= 6; offset++) {
                const idx = c + offset;
                const val = String(row[idx] ?? '')
                    .replace(/\u200b/g, '')
                    .trim();
                if (
                    isOtherMetaLabel(val) ||
                    isProjectCodeOnlyLabel(val) ||
                    isPcbCodeOnlyLabel(val) ||
                    isCombinedProjectPcbLabel(val)
                ) {
                    break;
                }
                if (isPlaceholder(val)) {
                    return `${quotedTab}!${colLetterFromIndex(idx)}${r + 1}`;
                }
                if (!val) {
                    if (firstEmpty == null) firstEmpty = idx;
                    continue;
                }
                return `${quotedTab}!${colLetterFromIndex(idx)}${r + 1}`;
            }
            if (firstEmpty != null) {
                return `${quotedTab}!${colLetterFromIndex(firstEmpty)}${r + 1}`;
            }
            return `${quotedTab}!${colLetterFromIndex(c + fallbackOffset)}${r + 1}`;
        }
    }

    return null;
}

/**
 * Write PROJECT CODE and PCB CODE into separate sheet cells.
 * - PROJECT CODE → {projectcode}
 * - PCB CODE → {pcbcode}
 * Legacy combined label PROJECT CODE_PCBCODE still gets project_pcb when present.
 */
export async function fillBomHeaderProjectPcbCode({
    userId,
    spreadsheetId,
    projectCode,
    pcbCode,
    projectPcbCode = null,
    onlySheetTitles = null,
}) {
    const id = String(spreadsheetId || '').trim();
    const project = String(projectCode || '').trim();
    const pcb = String(pcbCode || '').trim();
    const combined =
        String(projectPcbCode || '').trim() ||
        (project && pcb ? `${project}_${pcb}` : '');
    if (!id || (!project && !pcb && !combined)) {
        return { updated: false, reason: 'missing_args' };
    }

    const titleFilter = Array.isArray(onlySheetTitles)
        ? onlySheetTitles
              .map((t) => String(t || '').trim().toLowerCase())
              .filter(Boolean)
        : null;

    const { auth } = await getExistingGoogleAuthForUser(userId);
    const sheets = getSheetsClient(auth);

    try {
        const meta = await sheets.spreadsheets.get({
            spreadsheetId: id,
            fields: 'spreadsheetId,properties.title,sheets.properties(sheetId,title,index)',
        });
        const sheetList = [...(meta.data.sheets || [])].sort(
            (a, b) =>
                Number(a.properties?.index ?? 0) -
                Number(b.properties?.index ?? 0),
        );
        if (!sheetList.length) {
            return { updated: false, reason: 'no_tabs' };
        }

        const scoreTab = (title) => {
            const t = String(title || '').trim();
            if (/^main\s*bom$/i.test(t)) return 4;
            if (/^lo\d+$/i.test(t)) return 3;
            if (/^lon$/i.test(t)) return 2;
            return 0;
        };
        let ordered = [...sheetList].sort(
            (a, b) =>
                scoreTab(b.properties?.title) - scoreTab(a.properties?.title) ||
                Number(a.properties?.index ?? 0) -
                    Number(b.properties?.index ?? 0),
        );
        if (titleFilter?.length) {
            ordered = ordered.filter((s) =>
                titleFilter.includes(
                    String(s.properties?.title || '').trim().toLowerCase(),
                ),
            );
        }
        if (titleFilter?.length && !titleFilter.includes('main bom')) {
            const main = sheetList.find((s) =>
                /^main\s*bom$/i.test(
                    String(s.properties?.title || '').trim(),
                ),
            );
            if (main) ordered = [main, ...ordered];
        }

        const updates = [];
        for (const sheet of ordered) {
            const tabName = String(sheet.properties?.title || '').trim();
            if (!tabName) continue;
            const quoted = `'${tabName.replace(/'/g, "''")}'`;
            const tabScore = scoreTab(tabName);
            let rows = [];
            try {
                const got = await sheets.spreadsheets.values.get({
                    spreadsheetId: id,
                    range: `${quoted}!A1:ZZ20`,
                    majorDimension: 'ROWS',
                });
                rows = got.data.values || [];
            } catch {
                continue;
            }

            const dataWrites = [];

            // Separate PROJECT CODE
            if (project) {
                let projectA1 = findMetaValueA1(rows, quoted, {
                    isLabel: isProjectCodeOnlyLabel,
                    isPlaceholder: isProjectCodePlaceholder,
                    fallbackOffset: 1,
                });
                if (!projectA1 && tabScore >= 2) {
                    projectA1 = `${quoted}!D1`;
                }
                if (projectA1) {
                    dataWrites.push({ range: projectA1, values: [[project]] });
                }
            }

            // Separate PCB CODE
            if (pcb) {
                let pcbA1 = findMetaValueA1(rows, quoted, {
                    isLabel: isPcbCodeOnlyLabel,
                    isPlaceholder: isPcbCodePlaceholder,
                    fallbackOffset: 1,
                });
                if (!pcbA1 && tabScore >= 2) {
                    pcbA1 = `${quoted}!D2`;
                }
                if (pcbA1) {
                    dataWrites.push({ range: pcbA1, values: [[pcb]] });
                }
            }

            // Legacy combined PROJECT CODE_PCBCODE only when that label/placeholder exists
            if (combined) {
                const combinedA1 = findMetaValueA1(rows, quoted, {
                    isLabel: isCombinedProjectPcbLabel,
                    isPlaceholder: isCombinedProjectPcbPlaceholder,
                    fallbackOffset: 2,
                });
                if (combinedA1) {
                    dataWrites.push({
                        range: combinedA1,
                        values: [[combined]],
                    });
                }
            }

            // Also replace any remaining placeholders found in-row
            for (let r = 0; r < rows.length; r++) {
                const row = rows[r] || [];
                for (let c = 0; c < row.length; c++) {
                    const a1 = `${quoted}!${colLetterFromIndex(c)}${r + 1}`;
                    if (isProjectCodePlaceholder(row[c]) && project) {
                        if (!dataWrites.some((w) => w.range === a1)) {
                            dataWrites.push({
                                range: a1,
                                values: [[project]],
                            });
                        }
                    }
                    if (isPcbCodePlaceholder(row[c]) && pcb) {
                        if (!dataWrites.some((w) => w.range === a1)) {
                            dataWrites.push({
                                range: a1,
                                values: [[pcb]],
                            });
                        }
                    }
                    if (isCombinedProjectPcbPlaceholder(row[c]) && combined) {
                        if (!dataWrites.some((w) => w.range === a1)) {
                            dataWrites.push({
                                range: a1,
                                values: [[combined]],
                            });
                        }
                    }
                }
            }

            for (const write of dataWrites) {
                await sheets.spreadsheets.values.update({
                    spreadsheetId: id,
                    range: write.range,
                    valueInputOption: 'USER_ENTERED',
                    requestBody: { values: write.values },
                });
                updates.push({
                    sheet_title: tabName,
                    range: write.range,
                    value: write.values[0][0],
                });
            }
        }

        if (!updates.length) {
            return {
                updated: false,
                reason: 'label_not_found',
                project_code: project,
                pcb_code: pcb,
                project_pcb_code: combined,
            };
        }

        return {
            updated: true,
            project_code: project,
            pcb_code: pcb,
            project_pcb_code: combined,
            updates,
            sheet_title: updates[0].sheet_title,
            range: updates[0].range,
        };
    } catch (err) {
        if (err instanceof GoogleAuthError) throw err;
        const authErr = mapGoogleApiAuthError(err);
        if (authErr) throw authErr;
        console.warn('[fillBomHeaderProjectPcbCode]', err?.message || err);
        return {
            updated: false,
            reason: err?.message || 'fill_failed',
            project_code: project,
            pcb_code: pcb,
            project_pcb_code: combined,
        };
    }
}

/**
 * Resolve `{project}_{pcb}` for a spreadsheet from DB item, existing sheet
 * cells, or the Drive file title (e.g. PROJ_PCB_BOM).
 */
export async function resolveProjectPcbCodeForSpreadsheet({
    userId,
    spreadsheetId,
    dbLookup = null,
}) {
    const id = String(spreadsheetId || '').trim();
    if (!id) return { project_pcb_code: '', project_code: '', pcb_code: '' };

    // 1) project_file_manager_items row
    if (typeof dbLookup === 'function') {
        try {
            const row = await dbLookup(id);
            const stored = String(row?.project_pcb_code || '').trim();
            if (stored && !/^\{.*\}$/.test(stored)) {
                const pcb = String(row?.pcb_code || '').trim();
                const project = String(row?.project_code || '').trim();
                return {
                    project_pcb_code: stored,
                    project_code: project || stored.split('_')[0] || '',
                    pcb_code: pcb || '',
                };
            }
            const project = String(row?.project_code || '').trim();
            const pcb = String(row?.pcb_code || '').trim();
            if (project && pcb) {
                return {
                    project_pcb_code: `${project}_${pcb}`,
                    project_code: project,
                    pcb_code: pcb,
                };
            }
        } catch {
            /* fall through */
        }
    }

    // 2) Read existing MAIN BOM / LO value next to PROJECT CODE*
    try {
        const { auth } = await getExistingGoogleAuthForUser(userId);
        const sheets = getSheetsClient(auth);
        const meta = await sheets.spreadsheets.get({
            spreadsheetId: id,
            fields: 'properties.title,sheets.properties(title,index)',
        });
        const fileTitle = String(meta.data.properties?.title || '').trim();
        const sheetList = [...(meta.data.sheets || [])].sort(
            (a, b) =>
                Number(a.properties?.index ?? 0) -
                Number(b.properties?.index ?? 0),
        );
        const prefer = [...sheetList].sort((a, b) => {
            const score = (t) => {
                const x = String(t || '').trim();
                if (/^main\s*bom$/i.test(x)) return 3;
                if (/^lo\d+$/i.test(x)) return 2;
                return 0;
            };
            return (
                score(b.properties?.title) - score(a.properties?.title) ||
                Number(a.properties?.index ?? 0) -
                    Number(b.properties?.index ?? 0)
            );
        });

        for (const sheet of prefer) {
            const tabName = String(sheet.properties?.title || '').trim();
            if (!tabName) continue;
            const quoted = `'${tabName.replace(/'/g, "''")}'`;
            let rows = [];
            try {
                const got = await sheets.spreadsheets.values.get({
                    spreadsheetId: id,
                    range: `${quoted}!A1:ZZ10`,
                    majorDimension: 'ROWS',
                });
                rows = got.data.values || [];
            } catch {
                continue;
            }
            let foundProject = '';
            let foundPcb = '';
            for (const row of rows) {
                for (let c = 0; c < (row || []).length; c++) {
                    const cell = row[c];
                    const next = String(row[c + 1] ?? '')
                        .trim()
                        .replace(/^\{|\}$/g, '');
                    if (
                        isProjectCodeOnlyLabel(cell) &&
                        next &&
                        !isProjectCodePlaceholder(row[c + 1])
                    ) {
                        foundProject = next;
                    }
                    if (
                        isPcbCodeOnlyLabel(cell) &&
                        next &&
                        !isPcbCodePlaceholder(row[c + 1])
                    ) {
                        foundPcb = next;
                    }
                    if (
                        isCombinedProjectPcbLabel(cell) &&
                        next &&
                        next.includes('_') &&
                        !/projectcode/i.test(next)
                    ) {
                        const idx = next.indexOf('_');
                        foundProject = foundProject || next.slice(0, idx);
                        foundPcb = foundPcb || next.slice(idx + 1);
                    }
                }
            }
            // Also scan placeholders already filled elsewhere in row
            for (const row of rows) {
                for (let c = 0; c < (row || []).length; c++) {
                    const val = String(row[c] ?? '').trim();
                    if (
                        !foundProject &&
                        val &&
                        !isProjectCodePlaceholder(val) &&
                        !isPcbCodePlaceholder(val) &&
                        !isCombinedProjectPcbPlaceholder(val) &&
                        c > 0 &&
                        isProjectCodeOnlyLabel(row[c - 1])
                    ) {
                        foundProject = val;
                    }
                    if (
                        !foundPcb &&
                        val &&
                        !isPcbCodePlaceholder(val) &&
                        c > 0 &&
                        isPcbCodeOnlyLabel(row[c - 1])
                    ) {
                        foundPcb = val;
                    }
                }
            }
            if (foundProject || foundPcb) {
                return {
                    project_code: foundProject,
                    pcb_code: foundPcb,
                    project_pcb_code:
                        foundProject && foundPcb
                            ? `${foundProject}_${foundPcb}`
                            : '',
                };
            }
        }

        // 3) File title: {project}_{pcb}_BOM  (or {project}_{pcb})
        let baseTitle = fileTitle.replace(/_BOM$/i, '').trim();
        const lastUnderscore = baseTitle.lastIndexOf('_');
        if (lastUnderscore > 0) {
            const project = baseTitle.slice(0, lastUnderscore).trim();
            const pcb = baseTitle.slice(lastUnderscore + 1).trim();
            if (project && pcb && !/^bom$/i.test(pcb)) {
                return {
                    project_pcb_code: `${project}_${pcb}`,
                    project_code: project,
                    pcb_code: pcb,
                };
            }
        }
    } catch (err) {
        console.warn(
            '[resolveProjectPcbCodeForSpreadsheet]',
            err?.message || err,
        );
    }

    return { project_pcb_code: '', project_code: '', pcb_code: '' };
}

/**
 * On project PCB sheet create: rename template tab "LON" → "LO1"
 * (N = number). Categories template keeps LON; assigned project sheet uses LO1.
 * If LO1 already exists, uses next free LOn.
 */
export async function renameLonTabToLoNumber({
    userId,
    spreadsheetId,
    startNumber = 1,
}) {
    const id = String(spreadsheetId || '').trim();
    const start = Math.max(1, Number(startNumber) || 1);
    if (!id) {
        return { renamed: false, reason: 'missing_spreadsheet_id' };
    }

    const { auth } = await getExistingGoogleAuthForUser(userId);
    const sheets = getSheetsClient(auth);

    try {
        const meta = await sheets.spreadsheets.get({
            spreadsheetId: id,
            fields: 'sheets.properties(sheetId,title,index)',
        });
        const sheetList = meta.data.sheets || [];
        const lon = sheetList.find((s) => {
            const t = String(s.properties?.title || '')
                .trim()
                .toLowerCase();
            return t === 'lon';
        });
        if (lon?.properties?.sheetId == null) {
            return { renamed: false, reason: 'lon_not_found' };
        }

        const used = new Set(
            sheetList.map((s) =>
                String(s.properties?.title || '').trim().toLowerCase(),
            ),
        );
        let n = start;
        let newTitle = `LO${n}`;
        while (used.has(newTitle.toLowerCase())) {
            n += 1;
            newTitle = `LO${n}`;
            if (n > 999) {
                return { renamed: false, reason: 'no_free_lo_name' };
            }
        }

        await sheets.spreadsheets.batchUpdate({
            spreadsheetId: id,
            requestBody: {
                requests: [
                    {
                        updateSheetProperties: {
                            properties: {
                                sheetId: lon.properties.sheetId,
                                title: newTitle,
                            },
                            fields: 'title',
                        },
                    },
                ],
            },
        });

        try {
            await moveLoTabsToEnd(sheets, id);
        } catch {
            /* ignore reorder */
        }

        return {
            renamed: true,
            from: 'LON',
            to: newTitle,
            sheet_id: lon.properties.sheetId,
        };
    } catch (err) {
        if (err instanceof GoogleAuthError) throw err;
        const authErr = mapGoogleApiAuthError(err);
        if (authErr) throw authErr;
        console.warn('[renameLonTabToLoNumber]', err?.message || err);
        return {
            renamed: false,
            reason: err?.message || 'rename_failed',
        };
    }
}

/**
 * Add a new worksheet tab to an existing spreadsheet and write values into it.
 * Does NOT overwrite existing tabs (e.g. MAIN BOM / LO1).
 */
export async function addGoogleSheetTabWithData({
    userId,
    spreadsheetId,
    sheetTabName,
    values = [],
    applyBomFormatting = true,
}) {
    const id = String(spreadsheetId || '').trim();
    const title = String(sheetTabName || '').trim().slice(0, 100);
    if (!id) {
        const err = new Error('spreadsheetId is required');
        err.status = 400;
        throw err;
    }
    if (!title) {
        const err = new Error('Sheet tab name is required');
        err.status = 400;
        throw err;
    }

    const matrix = Array.isArray(values) ? values : [];
    const { auth } = await getExistingGoogleAuthForUser(userId);
    const sheets = getSheetsClient(auth);

    try {
        const meta = await sheets.spreadsheets.get({
            spreadsheetId: id,
            fields: 'spreadsheetId,properties.title,sheets.properties(sheetId,title)',
        });

        const existing = (meta.data.sheets || []).map((s) =>
            String(s.properties?.title || '').trim().toLowerCase(),
        );
        if (existing.includes(title.toLowerCase())) {
            const err = new Error(
                `A sheet tab named "${title}" already exists in this spreadsheet`,
            );
            err.status = 409;
            throw err;
        }

        const added = await sheets.spreadsheets.batchUpdate({
            spreadsheetId: id,
            requestBody: {
                requests: [
                    {
                        addSheet: {
                            properties: { title },
                        },
                    },
                ],
            },
        });

        const newProps =
            added.data.replies?.[0]?.addSheet?.properties || null;
        const newSheetId = newProps?.sheetId;
        const newTitle = String(newProps?.title || title).trim() || title;

        if (matrix.length) {
            await sheets.spreadsheets.values.update({
                spreadsheetId: id,
                range: `'${newTitle.replace(/'/g, "''")}'!A1`,
                valueInputOption: 'USER_ENTERED',
                requestBody: { values: matrix },
            });
        }

        if (applyBomFormatting && newSheetId != null) {
            const dataRowCount = Math.max(0, matrix.length - BOM_DATA_START_ROW);
            await applyBomSheetFormatting(sheets, id, newSheetId, dataRowCount);
        }

        return {
            google_file_id: id,
            google_drive_folder_id: null,
            url: sheetEditUrl(id, newSheetId),
            mime_type: SHEET_MIME,
            name: meta.data.properties?.title || id,
            sheet_title: newTitle,
            sheet_gid: newSheetId ?? null,
            file_source: 'google_sheet',
            rows_written: matrix.length,
            mode: 'add_tab',
        };
    } catch (err) {
        if (err instanceof GoogleAuthError) throw err;
        if (err?.status === 409) throw err;
        const authErr = mapGoogleApiAuthError(err);
        if (authErr) throw authErr;
        const wrapped = new Error(
            err?.message || 'Failed to add Google Sheet tab',
        );
        wrapped.status = err?.status || err?.code === 401 ? 401 : 502;
        wrapped.cause = err;
        throw wrapped;
    }
}

/**
 * Create a Google Sheet, optionally rename the first tab, write values, return meta.
 */
export async function createGoogleSheetWithData({
    userId,
    title,
    sheetTabName,
    googleDriveFolderId,
    shareEditEmails = [],
    values = [],
    applyBomFormatting = true,
}) {
    const created = await createGoogleSheet({
        userId,
        title,
        googleDriveFolderId,
        shareEditEmails,
    });

    try {
        const written = await writeGoogleSheetMatrix({
            userId,
            spreadsheetId: created.google_file_id,
            sheetTitle: sheetTabName || title,
            values,
            applyBomFormatting,
        });
        return {
            ...created,
            sheet_title: written.sheet_title,
            sheet_gid: written.sheet_gid,
            url: written.url || created.url,
            rows_written: written.rows_written,
        };
    } catch (err) {
        try {
            const { auth } = await getExistingGoogleAuthForUser(userId);
            await deleteDriveFile(getDriveClient(auth), created.google_file_id);
        } catch {
            /* ignore cleanup errors */
        }
        throw err;
    }
}

/**
 * Create a Google Doc in Drive folder, share edit emails, return metadata.
 */
export async function createGoogleDoc({
    userId,
    title,
    googleDriveFolderId,
    shareEditEmails = [],
}) {
    const name = String(title || '').trim();
    const folderId = String(googleDriveFolderId || '').trim();
    if (!name) {
        const err = new Error('Doc name is required');
        err.status = 400;
        throw err;
    }
    if (!folderId) {
        const err = new Error(
            'Google Drive folder is not configured for this ERP folder',
        );
        err.status = 400;
        throw err;
    }

    const { auth } = await getExistingGoogleAuthForUser(userId);
    const drive = getDriveClient(auth);

    let fileId = null;
    try {
        const created = await drive.files.create({
            requestBody: {
                name,
                mimeType: DOC_MIME,
                parents: [folderId],
            },
            fields: 'id,name,webViewLink,mimeType',
            supportsAllDrives: true,
        });
        fileId = created.data.id;

        const emails = Array.isArray(shareEditEmails)
            ? [
                  ...new Set(
                      shareEditEmails
                          .map((e) => String(e || '').trim().toLowerCase())
                          .filter((e) => e.includes('@')),
                  ),
              ]
            : [];
        const shares = [];
        for (const email of emails) {
            shares.push(
                await shareDriveFileWithEmail(drive, fileId, email, 'writer'),
            );
        }

        return {
            google_file_id: fileId,
            google_drive_folder_id: folderId,
            url: created.data.webViewLink || docEditUrl(fileId),
            mime_type: DOC_MIME,
            name: created.data.name || name,
            file_source: 'google_doc',
            shares,
        };
    } catch (err) {
        if (fileId) await deleteDriveFile(drive, fileId);
        if (err instanceof GoogleAuthError) throw err;
        const authErr = mapGoogleApiAuthError(err);
        if (authErr) throw authErr;
        const wrapped = new Error(err?.message || 'Failed to create Google Doc');
        wrapped.status = err?.status || 502;
        wrapped.cause = err;
        throw wrapped;
    }
}

/**
 * Keep non-LO tabs (MAIN BOM, LON, …) first; append all LOx tabs at the end
 * sorted numerically (LO1, LO2, LO3, …).
 */
async function moveLoTabsToEnd(sheets, spreadsheetId) {
    const meta = await sheets.spreadsheets.get({
        spreadsheetId,
        fields: 'sheets.properties(sheetId,title,index)',
    });
    const list = meta.data.sheets || [];
    if (list.length < 2) return;

    const loPattern = /^(L(?:O)?)(\d+)$/i;
    const loTabs = [];
    const otherTabs = [];

    for (const s of list) {
        const title = String(s.properties?.title || '').trim();
        const m = title.match(loPattern);
        // LON is template — keep with "other", not LO numbered group
        if (m && !/^lon$/i.test(title)) {
            loTabs.push({
                sheetId: s.properties.sheetId,
                title,
                num: Number(m[2]),
                index: Number(s.properties?.index ?? 0),
            });
        } else {
            otherTabs.push({
                sheetId: s.properties.sheetId,
                title,
                index: Number(s.properties?.index ?? 0),
            });
        }
    }

    if (!loTabs.length) return;

    otherTabs.sort((a, b) => a.index - b.index);
    loTabs.sort((a, b) => a.num - b.num || a.title.localeCompare(b.title));

    const desired = [...otherTabs, ...loTabs];
    // Apply from end → start to avoid index collisions while moving
    const requests = [];
    for (let i = desired.length - 1; i >= 0; i--) {
        const cur = list.find(
            (s) => Number(s.properties?.sheetId) === Number(desired[i].sheetId),
        );
        const curIndex = Number(cur?.properties?.index ?? -1);
        if (curIndex === i) continue;
        requests.push({
            updateSheetProperties: {
                properties: {
                    sheetId: desired[i].sheetId,
                    index: i,
                },
                fields: 'index',
            },
        });
    }

    if (!requests.length) return;
    await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests },
    });
}

/**
 * Duplicate the first (or preferred template) tab inside a spreadsheet
 * as a new tab named `sheetTabName` (e.g. LO1 / LO2).
 * Prefer LON as the format source; LO tabs are placed at the end.
 */
/**
 * Find exact "LON" tab in a sheet list (not LO1 / LO2 / LONGER).
 */
function findLonSheetInList(sheetList) {
    return (
        (sheetList || []).find((s) => {
            const t = String(s.properties?.title || '')
                .trim()
                .toLowerCase();
            return t === 'lon';
        }) || null
    );
}

/**
 * After copyTo / duplicate: rename sheet, clear data rows, move LOs to end.
 */
async function finalizeCopiedLoTab({
    sheets,
    spreadsheetId,
    newSheetId,
    title,
    clearDataRowsAfterCopy,
}) {
    const requests = [];
    if (newSheetId != null && title) {
        requests.push({
            updateSheetProperties: {
                properties: {
                    sheetId: newSheetId,
                    title,
                },
                fields: 'title',
            },
        });
    }
    if (requests.length) {
        await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: { requests },
        });
    }

    const newTitle = String(title || '').trim();
    if (clearDataRowsAfterCopy && newTitle) {
        const quoted = `'${newTitle.replace(/'/g, "''")}'`;
        try {
            await sheets.spreadsheets.values.clear({
                spreadsheetId,
                range: `${quoted}!A5:ZZ`,
            });
        } catch {
            /* formatting kept even if clear fails */
        }
    }

    await moveLoTabsToEnd(sheets, spreadsheetId);
    return newTitle;
}

export async function duplicateGoogleSheetTab({
    userId,
    spreadsheetId,
    sheetTabName,
    /** Prefer LON (categories BOM template) when creating LO1/LO2/… */
    sourceSheetTitleHints = [
        'LON',
        'LO N',
        'TEMPLATE',
        'MAIN BOM',
        'MAIN_BOM',
        'MAINBOM',
    ],
    /**
     * When true (LO add): only copy from LON — never MAIN BOM / LO data / first sheet.
     * Keeps LON format/validation; clears line-item rows after copy.
     */
    requireLonTemplate = false,
    /** After copy, clear line-item values (keep header + formatting/dropdowns). */
    clearDataRowsAfterCopy = false,
    /**
     * Categories assigned template spreadsheet id — LON is always read from here
     * (categories folder_scope=google_sheet BOM template). Required when requireLonTemplate.
     */
    templateSpreadsheetId = null,
}) {
    const id = String(spreadsheetId || '').trim();
    const title = String(sheetTabName || '').trim().slice(0, 100);
    const templateId = String(templateSpreadsheetId || '').trim();
    if (!id) {
        const err = new Error('spreadsheetId is required');
        err.status = 400;
        throw err;
    }
    if (!title) {
        const err = new Error('Sheet tab name is required');
        err.status = 400;
        throw err;
    }

    const { auth } = await getExistingGoogleAuthForUser(userId);
    const sheets = getSheetsClient(auth);

    try {
        const meta = await sheets.spreadsheets.get({
            spreadsheetId: id,
            fields: 'spreadsheetId,properties.title,sheets.properties(sheetId,title,index)',
        });

        const sheetList = meta.data.sheets || [];
        if (!sheetList.length) {
            const err = new Error('Linked Google Sheet has no tabs to copy');
            err.status = 400;
            throw err;
        }

        const existingTitles = sheetList.map((s) =>
            String(s.properties?.title || '').trim().toLowerCase(),
        );
        if (existingTitles.includes(title.toLowerCase())) {
            const existing = sheetList.find(
                (s) =>
                    String(s.properties?.title || '')
                        .trim()
                        .toLowerCase() === title.toLowerCase(),
            );
            try {
                await moveLoTabsToEnd(sheets, id);
            } catch {
                /* ignore reorder failure */
            }
            return {
                google_file_id: id,
                url: sheetEditUrl(id, existing?.properties?.sheetId),
                mime_type: SHEET_MIME,
                name: meta.data.properties?.title || id,
                sheet_title: String(existing?.properties?.title || title),
                sheet_gid: existing?.properties?.sheetId ?? null,
                mode: 'already_exists',
                file_source: 'google_sheet',
            };
        }

        // Strict LO add: LON only from categories assigned BOM template sheet
        if (requireLonTemplate) {
            if (!templateId) {
                const err = new Error(
                    'Categories BOM Google Sheet template is required to copy LON format',
                );
                err.status = 400;
                throw err;
            }

            // Always resolve LON from categories assigned spreadsheet
            const lonSourceId = templateId;
            let lonSheet = null;
            if (lonSourceId === id) {
                lonSheet = findLonSheetInList(sheetList);
            } else {
                const tmplMeta = await sheets.spreadsheets.get({
                    spreadsheetId: lonSourceId,
                    fields: 'sheets.properties(sheetId,title)',
                });
                lonSheet = findLonSheetInList(tmplMeta.data?.sheets || []);
            }

            if (lonSheet?.properties?.sheetId == null) {
                const err = new Error(
                    'LON tab not found in categories assigned BOM Google Sheet. Add a tab named "LON" to that template.',
                );
                err.status = 400;
                throw err;
            }

            const sourceTitle = String(
                lonSheet.properties.title || 'LON',
            ).trim();
            let newSheetId = null;

            if (lonSourceId === id) {
                const duplicated = await sheets.spreadsheets.batchUpdate({
                    spreadsheetId: id,
                    requestBody: {
                        requests: [
                            {
                                duplicateSheet: {
                                    sourceSheetId: lonSheet.properties.sheetId,
                                    insertSheetIndex: sheetList.length,
                                    newSheetName: title,
                                },
                            },
                        ],
                    },
                });
                newSheetId =
                    duplicated.data.replies?.[0]?.duplicateSheet?.properties
                        ?.sheetId ?? null;
            } else {
                const copied = await sheets.spreadsheets.sheets.copyTo({
                    spreadsheetId: lonSourceId,
                    sheetId: lonSheet.properties.sheetId,
                    requestBody: { destinationSpreadsheetId: id },
                });
                newSheetId = copied.data?.sheetId ?? null;
            }

            if (newSheetId == null) {
                const err = new Error(
                    'Failed to copy LON from categories assigned BOM sheet',
                );
                err.status = 502;
                throw err;
            }

            const newTitle = await finalizeCopiedLoTab({
                sheets,
                spreadsheetId: id,
                newSheetId,
                title,
                clearDataRowsAfterCopy: true,
            });

            return {
                google_file_id: id,
                url: sheetEditUrl(id, newSheetId),
                mime_type: SHEET_MIME,
                name: meta.data.properties?.title || id,
                sheet_title: newTitle || title,
                sheet_gid: newSheetId,
                mode: 'duplicated',
                source_sheet_title: sourceTitle,
                file_source: 'google_sheet',
            };
        }

        const localLon = findLonSheetInList(sheetList);

        // Non-strict path (legacy): prefer hints, then LON, then first sheet
        const hints = (sourceSheetTitleHints || []).map((h) =>
            String(h || '').trim().toLowerCase(),
        );
        let source =
            sheetList.find((s) =>
                hints.includes(
                    String(s.properties?.title || '')
                        .trim()
                        .toLowerCase(),
                ),
            ) || null;
        if (!source) source = localLon;
        if (!source) {
            source = [...sheetList].sort(
                (a, b) =>
                    Number(a.properties?.index ?? 0) -
                    Number(b.properties?.index ?? 0),
            )[0];
        }

        const sourceSheetId = source?.properties?.sheetId;
        const sourceTitle = String(source?.properties?.title || '').trim();
        if (sourceSheetId == null) {
            const err = new Error('Could not resolve sheet tab to copy');
            err.status = 400;
            throw err;
        }

        const duplicated = await sheets.spreadsheets.batchUpdate({
            spreadsheetId: id,
            requestBody: {
                requests: [
                    {
                        duplicateSheet: {
                            sourceSheetId,
                            insertSheetIndex: sheetList.length,
                            newSheetName: title,
                        },
                    },
                ],
            },
        });

        const props =
            duplicated.data.replies?.[0]?.duplicateSheet?.properties || null;
        const newSheetId = props?.sheetId ?? null;
        const newTitle = await finalizeCopiedLoTab({
            sheets,
            spreadsheetId: id,
            newSheetId,
            title: String(props?.title || title).trim() || title,
            clearDataRowsAfterCopy,
        });

        return {
            google_file_id: id,
            url: sheetEditUrl(id, newSheetId),
            mime_type: SHEET_MIME,
            name: meta.data.properties?.title || id,
            sheet_title: newTitle,
            sheet_gid: newSheetId,
            mode: 'duplicated',
            source_sheet_title: sourceTitle,
            file_source: 'google_sheet',
        };
    } catch (err) {
        if (err instanceof GoogleAuthError) throw err;
        if (err?.status && err.status < 500) throw err;
        const authErr = mapGoogleApiAuthError(err);
        if (authErr) throw authErr;
        const wrapped = new Error(
            err?.message || 'Failed to copy Google Sheet tab',
        );
        wrapped.status = err?.status || err?.code === 401 ? 401 : 502;
        wrapped.cause = err;
        throw wrapped;
    }
}

/**
 * List all worksheet tabs (subsheets) inside a Google Spreadsheet.
 */
export async function listGoogleSheetTabs({ userId, spreadsheetId }) {
    const id = String(spreadsheetId || '').trim();
    if (!id) {
        const err = new Error('spreadsheetId is required');
        err.status = 400;
        throw err;
    }

    const { auth } = await getExistingGoogleAuthForUser(userId);
    const sheets = getSheetsClient(auth);

    try {
        const meta = await sheets.spreadsheets.get({
            spreadsheetId: id,
            fields:
                'spreadsheetId,properties.title,sheets.properties(sheetId,title,index,hidden)',
        });

        const tabs = (meta.data.sheets || [])
            .map((s) => {
                const props = s.properties || {};
                const sheetId = props.sheetId;
                const title = String(props.title || '').trim();
                return { 
                    sheet_id: sheetId ?? null,
                    title,
                    index: Number(props.index ?? 0),
                    hidden: Boolean(props.hidden),
                    url: sheetEditUrl(id, sheetId),
                };
            })
            .filter((t) => t.title)
            .sort((a, b) => a.index - b.index);

        return {
            spreadsheet_id: id,
            spreadsheet_title: meta.data.properties?.title || id,
            url: sheetEditUrl(id),
            tabs,
            count: tabs.length,
        };
    } catch (err) {
        const authErr = mapGoogleApiAuthError(err);
        if (authErr) throw authErr;
        const wrapped = new Error(
            err?.message || 'Failed to list Google Sheet tabs',
        );
        wrapped.status = err?.status || err?.code === 401 ? 401 : 502;
        wrapped.cause = err;
        throw wrapped;
    }
}

function findBomHeaderRowIndex(matrix) {
    const rows = Array.isArray(matrix) ? matrix : [];
    for (let i = 0; i < Math.min(rows.length, 40); i++) {
        const joined = (rows[i] || [])
            .map((c) => String(c ?? '').trim().toLowerCase())
            .join('|');
        const hasSku = joined.includes('sku') || joined.includes('mpn');
        const hasValue = joined.includes('value');
        const hasFootprint = joined.includes('footprint');
        const hasDesignator = joined.includes('designator');
        const hasQty =
            joined.includes('qty') ||
            joined.includes('quantity') ||
            joined.includes('per pcs');
        if (hasSku && (hasValue || hasFootprint || hasDesignator) && hasQty) {
            return i;
        }
    }
    for (let i = 0; i < Math.min(rows.length, 40); i++) {
        const joined = (rows[i] || [])
            .map((c) => String(c ?? '').trim().toLowerCase())
            .join('|');
        const hasSr = joined.includes('sr') && joined.includes('no');
        const hasSku = joined.includes('sku') || joined.includes('mpn');
        if (hasSr && hasSku) return i;
    }
    return -1;
}

/**
 * Read all cell values from one worksheet tab (headers + data rows).
 */
export async function readGoogleSheetTabData({
    userId,
    spreadsheetId,
    sheetTabName,
}) {
    const id = String(spreadsheetId || '').trim();
    const title = String(sheetTabName || '').trim();
    if (!id) {
        const err = new Error('spreadsheetId is required');
        err.status = 400;
        throw err;
    }
    if (!title) {
        const err = new Error('sheet tab name is required');
        err.status = 400;
        throw err;
    }

    const { auth } = await getExistingGoogleAuthForUser(userId);
    const sheets = getSheetsClient(auth);

    try {
        const meta = await sheets.spreadsheets.get({
            spreadsheetId: id,
            fields:
                'spreadsheetId,properties.title,sheets.properties(sheetId,title,index)',
        });

        const match = (meta.data.sheets || []).find(
            (s) =>
                String(s.properties?.title || '')
                    .trim()
                    .toLowerCase() === title.toLowerCase(),
        );
        if (!match) {
            const err = new Error(
                `Sheet tab "${title}" was not found in this spreadsheet`,
            );
            err.status = 404;
            throw err;
        }

        const resolvedTitle = String(match.properties?.title || title).trim();
        const sheetId = match.properties?.sheetId ?? null;
        const quoted = `'${resolvedTitle.replace(/'/g, "''")}'`;

        const valuesRes = await sheets.spreadsheets.values.get({
            spreadsheetId: id,
            range: `${quoted}!A:ZZ`,
            majorDimension: 'ROWS',
            valueRenderOption: 'FORMATTED_VALUE',
        });

        const values = (valuesRes.data.values || []).map((row) =>
            (Array.isArray(row) ? row : []).map((cell) =>
                cell == null ? '' : String(cell),
            ),
        );

        const headerRowIndex = findBomHeaderRowIndex(values);
        const headers =
            headerRowIndex >= 0
                ? (values[headerRowIndex] || []).map((c) => String(c || '').trim())
                : [];
        const dataRows =
            headerRowIndex >= 0 ? values.slice(headerRowIndex + 1) : values.slice(1);

        return {
            spreadsheet_id: id,
            spreadsheet_title: meta.data.properties?.title || id,
            sheet_tab_name: resolvedTitle,
            sheet_id: sheetId,
            url: sheetEditUrl(id, sheetId),
            values,
            headers: headers.filter(Boolean),
            header_row_index: headerRowIndex,
            data_row_count: dataRows.length,
            row_count: values.length,
        };
    } catch (err) {
        if (err?.status) throw err;
        const authErr = mapGoogleApiAuthError(err);
        if (authErr) throw authErr;
        const wrapped = new Error(
            err?.message || 'Failed to read Google Sheet tab data',
        );
        wrapped.status = err?.status || err?.code === 401 ? 401 : 502;
        wrapped.cause = err;
        throw wrapped;
    }
}

/**
 * Overwrite cell values on an existing worksheet tab.
 * Does NOT create a new spreadsheet/tab, rename, or change formatting.
 */
export async function updateGoogleSheetTabValues({
    userId,
    spreadsheetId,
    sheetTabName,
    values = [],
}) {
    const id = String(spreadsheetId || '').trim();
    const title = String(sheetTabName || '').trim();
    if (!id) {
        const err = new Error('spreadsheetId is required');
        err.status = 400;
        throw err;
    }
    if (!title) {
        const err = new Error('sheet tab name is required');
        err.status = 400;
        throw err;
    }

    const matrix = Array.isArray(values)
        ? values.map((row) =>
              (Array.isArray(row) ? row : []).map((cell) =>
                  cell == null ? '' : String(cell),
              ),
          )
        : [];

    const { auth } = await getExistingGoogleAuthForUser(userId);
    const sheets = getSheetsClient(auth);

    try {
        const meta = await sheets.spreadsheets.get({
            spreadsheetId: id,
            fields:
                'spreadsheetId,properties.title,sheets.properties(sheetId,title,index)',
        });

        const match = (meta.data.sheets || []).find(
            (s) =>
                String(s.properties?.title || '')
                    .trim()
                    .toLowerCase() === title.toLowerCase(),
        );
        if (!match) {
            const err = new Error(
                `Sheet tab "${title}" was not found in this spreadsheet`,
            );
            err.status = 404;
            throw err;
        }

        const resolvedTitle = String(match.properties?.title || title).trim();
        const sheetId = match.properties?.sheetId ?? null;
        const quoted = `'${resolvedTitle.replace(/'/g, "''")}'`;

        // Clear values only — formatting / column widths stay intact
        await sheets.spreadsheets.values.clear({
            spreadsheetId: id,
            range: quoted,
        });

        if (matrix.length) {
            await sheets.spreadsheets.values.update({
                spreadsheetId: id,
                range: `${quoted}!A1`,
                valueInputOption: 'USER_ENTERED',
                requestBody: { values: matrix },
            });
        }

        return {
            google_file_id: id,
            spreadsheet_title: meta.data.properties?.title || id,
            sheet_tab_name: resolvedTitle,
            sheet_gid: sheetId,
            url: sheetEditUrl(id, sheetId),
            rows_written: matrix.length,
            mode: 'update_tab',
            file_source: 'google_sheet',
        };
    } catch (err) {
        if (err?.status) throw err;
        const authErr = mapGoogleApiAuthError(err);
        if (authErr) throw authErr;
        const wrapped = new Error(
            err?.message || 'Failed to update Google Sheet tab',
        );
        wrapped.status = err?.status || err?.code === 401 ? 401 : 502;
        wrapped.cause = err;
        throw wrapped;
    }
}

const GoogleFileService = {
    createGoogleSheet,
    createGoogleSheetWithData,
    addGoogleSheetTabWithData,
    duplicateGoogleSheetTab,
    listGoogleSheetTabs,
    readGoogleSheetTabData,
    updateGoogleSheetTabValues,
    writeGoogleSheetMatrix,
    fillBomHeaderProjectPcbCode,
    resolveProjectPcbCodeForSpreadsheet,
    renameLonTabToLoNumber,
    createGoogleDoc,
    moveToDriveFolder,
    deleteDriveFile,
    shareDriveFileWithEmail,
};

export default GoogleFileService;
