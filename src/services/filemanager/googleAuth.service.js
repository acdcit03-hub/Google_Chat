import { google } from 'googleapis';
import { pool } from '../../config/db.js';

const SHEETS_DRIVE_SCOPES = [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/drive.file',
];

let tokensTableReady = false;

export class GoogleAuthError extends Error {
    constructor(message, { status = 401, code = 'GOOGLE_AUTH' } = {}) {
        super(message);
        this.name = 'GoogleAuthError';
        this.status = status;
        this.code = code;
    }
}

/**
 * Optional per-user refresh tokens (for connected Google accounts).
 * OAuth login/connect UI is out of scope — this only reads stored tokens.
 */
export async function ensureUserGoogleTokensTable() {
    if (tokensTableReady) return;
    await pool.query(`
        CREATE TABLE IF NOT EXISTS user_google_tokens (
            user_id BIGINT PRIMARY KEY,
            refresh_token TEXT NOT NULL,
            access_token TEXT,
            expiry_date BIGINT,
            email VARCHAR(255),
            scope TEXT,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);
    tokensTableReady = true;
}

function cleanEnv(value) {
    return String(value || '')
        .trim()
        .replace(/^["']|["']$/g, '')
        .trim();
}

function createOAuth2Client() {
    const clientId = cleanEnv(process.env.GOOGLE_CLIENT_ID);
    const clientSecret = cleanEnv(process.env.GOOGLE_CLIENT_SECRET);
    const redirectUri = cleanEnv(process.env.GOOGLE_REDIRECT_URI);
    if (!clientId || !clientSecret) {
        return null;
    }
    return new google.auth.OAuth2(clientId, clientSecret, redirectUri || undefined);
}

async function getUserRefreshToken(userId) {
    if (userId == null) return null;
    await ensureUserGoogleTokensTable();
    const result = await pool.query(
        `
        SELECT refresh_token, access_token, expiry_date, email
        FROM user_google_tokens
        WHERE user_id = $1
        LIMIT 1
        `,
        [Number(userId)],
    );
    return result.rows[0] || null;
}

function getServiceAccountAuth() {
    const raw = String(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();
    if (!raw) return null;
    try {
        const credentials = JSON.parse(raw);
        if (credentials.private_key) {
            credentials.private_key = String(credentials.private_key).replace(
                /\\n/g,
                '\n',
            );
        }
        return new google.auth.GoogleAuth({
            credentials,
            scopes: SHEETS_DRIVE_SCOPES,
        });
    } catch (err) {
        console.error('Invalid GOOGLE_SERVICE_ACCOUNT_JSON:', err.message);
        return null;
    }
}

/**
 * Resolve an authenticated Google client for Drive/Sheets.
 * Order:
 * 1) user_google_tokens.refresh_token for this ERP user
 * 2) GOOGLE_REFRESH_TOKEN + GOOGLE_CLIENT_ID/SECRET
 * 3) GOOGLE_SERVICE_ACCOUNT_JSON (same pattern as Employee import)
 */
export async function getExistingGoogleAuthForUser(userId) {
    const oauth2 = createOAuth2Client();

    const userTok = await getUserRefreshToken(userId);
    if (oauth2 && userTok?.refresh_token) {
        oauth2.setCredentials({
            refresh_token: userTok.refresh_token,
            access_token: userTok.access_token || undefined,
            expiry_date: userTok.expiry_date
                ? Number(userTok.expiry_date)
                : undefined,
        });
        return { auth: oauth2, source: 'user_token' };
    }

    const envRefresh = cleanEnv(process.env.GOOGLE_REFRESH_TOKEN);
    if (oauth2 && envRefresh) {
        oauth2.setCredentials({ refresh_token: envRefresh });
        return { auth: oauth2, source: 'env_refresh_token' };
    }

    const sa = getServiceAccountAuth();
    if (sa) {
        return { auth: sa, source: 'service_account' };
    }

    throw new GoogleAuthError('Google account is not connected', {
        status: 401,
        code: 'GOOGLE_NOT_CONNECTED',
    });
}

export function getDriveClient(auth) {
    return google.drive({ version: 'v3', auth });
}

export function getSheetsClient(auth) {
    return google.sheets({ version: 'v4', auth });
}

/**
 * Map Google OAuth/API auth failures to a safe client-facing error.
 * Never expose client_secret / refresh_token in the message.
 */
export function mapGoogleApiAuthError(err) {
    const data = err?.response?.data || {};
    const oauthError = String(data.error || err?.errors?.[0]?.reason || '').toLowerCase();
    const desc = String(data.error_description || err?.message || '');

    if (
        oauthError === 'invalid_client' ||
        /client secret is invalid/i.test(desc) ||
        /invalid_client/i.test(desc)
    ) {
        return new GoogleAuthError(
            'Google OAuth client is invalid. Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env (they must belong to the same OAuth client).',
            { status: 401, code: 'GOOGLE_INVALID_CLIENT' },
        );
    }
    if (
        oauthError === 'invalid_grant' ||
        /invalid_grant/i.test(desc) ||
        /token has been expired or revoked/i.test(desc)
    ) {
        return new GoogleAuthError(
            'Google refresh token is invalid or revoked. Generate a new GOOGLE_REFRESH_TOKEN for this OAuth client.',
            { status: 401, code: 'GOOGLE_INVALID_GRANT' },
        );
    }
    if (err?.status === 401 || err?.code === 401 || oauthError === 'unauthorized') {
        return new GoogleAuthError('Google account is not connected', {
            status: 401,
            code: 'GOOGLE_NOT_CONNECTED',
        });
    }
    return null;
}

