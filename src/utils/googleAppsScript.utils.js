
function getScriptUrl() {
    return process.env.GOOGLE_APPS_SCRIPT_PROJECT_URL ;
}

function isGoogleAuthHtml(text) {
    return (
        text.includes('accounts.google.com') ||
        text.includes('ServiceLogin') ||
        (text.includes('Sign in') && text.includes('google.com'))
    );
}

/** Apps Script served the web-app HTML UI instead of running an API handler. */
function isAppsScriptHtmlUi(text) {
    const lower = text.toLowerCase();
    return (
        lower.includes('sandboxframe') ||
        lower.includes('usercodeapppanel') ||
        lower.includes('create project folder structure') ||
        (lower.includes('<!doctype html>') && lower.includes('google.script.run'))
    );
}

function authDeployError(status) {
    return new Error(
        `Apps Script auth failed (${status}). Redeploy the web app: Deploy → New deployment → Web app → ` +
            'Execute as: Me → Who has access: Anyone (not "Only myself"). ' +
            'Then set GOOGLE_APPS_SCRIPT_PROJECT_URL to the new /exec URL.',
    );
}

async function callAppsScriptGet(baseUrl, params) {
    const url = new URL(baseUrl);
    for (const [key, value] of Object.entries(params)) {
        if (value) url.searchParams.set(key, value);
    }

    const response = await fetch(url.toString(), {
        method: 'GET',
        redirect: 'follow',
    });
    const text = await response.text().catch(() => '');

    if (response.status === 401 || (response.ok && isGoogleAuthHtml(text))) {
        throw authDeployError(response.status);
    }
    if (!response.ok) {
        throw new Error(
            `Apps Script GET ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`,
        );
    }

    return text;
}

async function callAppsScriptPost(baseUrl, body) {
    const response = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        redirect: 'follow',
        body: JSON.stringify(body),
    });
    const text = await response.text().catch(() => '');

    if (response.status === 401 || (response.ok && isGoogleAuthHtml(text))) {
        throw authDeployError(response.status);
    }
    if (!response.ok) {
        throw new Error(
            `Apps Script POST ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`,
        );
    }

    return text;
}

function htmlUiError() {
    return new Error(
        'Apps Script returned the HTML form instead of creating folders. ' +
            'Update doGet/doPost to read project_code and return JSON.',
    );
}

/** Google Apps Script runtime error page (uncaught exception in doGet/doPost). */
function extractAppsScriptErrorHtml(text) {
    if (!text.includes('docs/script/images/favicon.ico') || !text.includes('<title>Error</title>')) {
        return null;
    }

    const monospaceMatch = text.match(
        /<div[^>]*font-family:monospace[^>]*>([\s\S]*?)<\/div>/i,
    );
    if (monospaceMatch?.[1]) {
        return monospaceMatch[1]
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&amp;/g, '&')
            .replace(/<[^>]+>/g, '')
            .trim();
    }

    const messageMatch = text.match(/class="errorMessage"[^>]*>([\s\S]*?)<\/div>/i);
    if (messageMatch?.[1]) {
        return messageMatch[1].replace(/<[^>]+>/g, '').trim();
    }

    return 'Apps Script runtime error (see Executions in script editor)';
}

function parseAppsScriptResponse(text) {
    if (isGoogleAuthHtml(text)) {
        throw authDeployError(401);
    }
    if (isAppsScriptHtmlUi(text)) {
        throw htmlUiError();
    }

    const scriptError = extractAppsScriptErrorHtml(text);
    if (scriptError) {
        throw new Error(`Apps Script error: ${scriptError}`);
    }

    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error(
            `Apps Script returned non-JSON response: ${text.slice(0, 200)}`,
        );
    }

    if (parsed && parsed.success === false) {
        throw new Error(parsed.message || parsed.error || 'Apps Script reported failure');
    }

    return parsed;
}

/** Pull a Drive/folder URL from Apps Script JSON (several key names + URL in message). */
export function extractFolderLinkFromAppsScriptResult(result) {
    if (!result || typeof result !== 'object') return null;

    const objectsToScan = [result];
    for (const key of ['data', 'result', 'folder', 'project']) {
        const nested = result[key];
        if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
            objectsToScan.push(nested);
        }
    }

    const urlKeys = [
        'link',
        'folder_url',
        'folderUrl',
        'project_folder_url',
        'projectFolderUrl',
        'url',
        'drive_link',
        'driveLink',
    ];

    for (const obj of objectsToScan) {
        for (const key of urlKeys) {
            const value = String(obj[key] ?? '').trim();
            if (/^https?:\/\//i.test(value)) return value;
        }

        const folderId = String(obj.folder_id ?? obj.folderId ?? obj.id ?? '').trim();
        if (folderId && /^[a-zA-Z0-9_-]{10,}$/.test(folderId)) {
            return `https://drive.google.com/drive/folders/${folderId}`;
        }

        const message = String(obj.message ?? obj.msg ?? '').trim();
        if (/^https?:\/\//i.test(message)) return message;

        const embedded = message.match(/https?:\/\/[^\s"'<>]+/i);
        if (embedded) return embedded[0];
    }

    return null;
}

/**
 * Project create — GET ?project_code=… (doGet → createFoldersProject).
 *
 * @param {string} projectCode
 */
export async function triggerProjectCreatedAppsScript(projectCode) {
    const project = String(projectCode ?? '').trim().toUpperCase();
    if (!project) return;

    const baseUrl = getScriptUrl();
    if (!baseUrl) return;

    const text = await callAppsScriptGet(baseUrl, { project_code: project });
    return parseAppsScriptResponse(text);
}

/**
 * PCB create — POST { project_code, pcb_code } (doPost → createFoldersPCB).
 *
 * @param {string} projectCode
 * @param {string} pcbCode
 */
export async function triggerPcbCreatedAppsScript(projectCode, pcbCode) {
    const project = String(projectCode ?? '').trim().toUpperCase();
    const pcb = String(pcbCode ?? '').trim().toUpperCase();
    if (!project || !pcb) return;

    const baseUrl = getScriptUrl();
    if (!baseUrl) return;

    const text = await callAppsScriptPost(baseUrl, {
        project_code: project,
        pcb_code: pcb,
    });
    return parseAppsScriptResponse(text);
}

export function runProjectCreatedAppsScript(projectCode) {
    const code = String(projectCode ?? '').trim();
    if (!code) {
        console.warn('[AppsScript] Skipped project: project_code is empty');
        return;
    }

    void triggerProjectCreatedAppsScript(code)
        .then((result) => {
            console.log(
                `[AppsScript] Project folders for ${code}:`,
                result?.message ?? 'ok',
            );
        })
        .catch((err) => {
            console.error(
                `[AppsScript] Project failed for ${code}:`,
                err?.message || err,
            );
        });
}

export function runPcbCreatedAppsScript(projectCode, pcbCode) {
    const project = String(projectCode ?? '').trim();
    const pcb = String(pcbCode ?? '').trim();
    if (!project || !pcb) {
        console.warn('[AppsScript] Skipped PCB: project_code and pcb_code are required');
        return;
    }

    void triggerPcbCreatedAppsScript(project, pcb)
        .then((result) => {
            console.log(
                `[AppsScript] PCB folders for ${project} / ${pcb}:`,
                result?.message ?? 'ok',
            );
        })
        .catch((err) => {
            console.error(
                `[AppsScript] PCB failed for ${project} / ${pcb}:`,
                err?.message || err,
            );
        });
}
