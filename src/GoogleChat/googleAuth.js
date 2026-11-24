
import pg from "pg";
import crypto from "crypto";
import dotenv from "dotenv";
import { google } from "googleapis";

dotenv.config();

const { Pool } = pg;

const pool = new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
});

const cleanEnv = (value) =>
    String(value || "")
        .trim()
        .replace(/^["']|["']$/g, "")
        .trim();

const getEncryptionKey = () => {
    const raw = cleanEnv(process.env.GOOGLE_TOKEN_ENCRYPTION_KEY);
    if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
        throw new Error(
            "GOOGLE_TOKEN_ENCRYPTION_KEY must contain exactly 64 hexadecimal characters."
        );
    }
    return Buffer.from(raw, "hex");
};

const CLIENT_ID = cleanEnv(process.env.GOOGLE_CLIENT_ID);
const CLIENT_SECRET = cleanEnv(process.env.GOOGLE_CLIENT_SECRET);
const REDIRECT_URI = cleanEnv(process.env.GOOGLE_REDIRECT_URI);

export const requireGoogleOAuthConfig = () => {
    if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
        throw new Error("Google OAuth environment variables are missing.");
    }
};

export const oauthClient = new google.auth.OAuth2(
    CLIENT_ID,
    CLIENT_SECRET,
    REDIRECT_URI
);

export const createOAuthClient = () => {
    requireGoogleOAuthConfig();
    return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
};

export const GOOGLE_SCOPES = [
    "openid",
    "email",
    "profile",
    "https://www.googleapis.com/auth/chat.spaces.readonly",
    "https://www.googleapis.com/auth/chat.spaces.create"
];

// Encrypt token using AES-256-GCM
export const encryptToken = (value) => {
    if (!value) return null;

    const iv = crypto.randomBytes(12);

    const cipher = crypto.createCipheriv(
        "aes-256-gcm",
        getEncryptionKey(),
        iv
    );

    const encrypted = Buffer.concat([
        cipher.update(value, "utf8"),
        cipher.final()
    ]);

    const authTag = cipher.getAuthTag();

    return [
        iv.toString("hex"),
        authTag.toString("hex"),
        encrypted.toString("hex")
    ].join(":");
};

// Decrypt token
export const decryptToken = (encryptedValue) => {
    if (!encryptedValue) return null;

    const [ivHex, authTagHex, encryptedHex] =
        encryptedValue.split(":");

    if (!ivHex || !authTagHex || !encryptedHex) {
        throw new Error("Invalid encrypted token format.");
    }

    const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        getEncryptionKey(),
        Buffer.from(ivHex, "hex")
    );

    decipher.setAuthTag(Buffer.from(authTagHex, "hex"));

    return Buffer.concat([
        decipher.update(Buffer.from(encryptedHex, "hex")),
        decipher.final()
    ]).toString("utf8");
};

// Create table
export const initializeGoogleOAuthTokensTable = async () => {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS google_oauth_tokens (
            id BIGSERIAL PRIMARY KEY,
            google_email VARCHAR(255) NOT NULL UNIQUE,
            access_token_enc TEXT,
            refresh_token_enc TEXT,
            token_expiry TIMESTAMPTZ,
            scopes TEXT[] DEFAULT ARRAY[]::TEXT[],
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        );
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS google_cloud_oauth_tokens (
            id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
            google_email VARCHAR(255) NOT NULL,
            refresh_token_enc TEXT NOT NULL,
            scopes TEXT[] DEFAULT ARRAY[]::TEXT[],
            updated_at TIMESTAMPTZ DEFAULT NOW()
        );
    `);

    await pool.query(`
        ALTER TABLE google_oauth_tokens
        ADD COLUMN IF NOT EXISTS refresh_token_expires_at TIMESTAMPTZ
    `);

    await pool.query(`
        ALTER TABLE google_oauth_tokens
        ADD COLUMN IF NOT EXISTS refresh_token_expires_in INTEGER
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS google_cloud_projects (
            id BIGSERIAL PRIMARY KEY,
            google_email VARCHAR(255) NOT NULL UNIQUE,
            project_id VARCHAR(64) NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        );
    `);

    console.log("Google OAuth token table initialized.");
};

export const saveGoogleCloudOAuthTokens = async (email, tokens) => {
    const refreshToken = tokens.refresh_token;
    let existingRefreshToken;

    if (!refreshToken) {
        const existing = await pool.query(
            "SELECT google_email, refresh_token_enc FROM google_cloud_oauth_tokens WHERE id = 1"
        );

        if (
            existing.rowCount === 0 ||
            existing.rows[0].google_email !== email.trim().toLowerCase()
        ) {
            throw new Error(
                "Google did not return a refresh token. Reauthorize and grant consent."
            );
        }

        existingRefreshToken = existing.rows[0].refresh_token_enc;
    }

    const scopes = tokens.scope ? tokens.scope.split(" ") : [];
    const encryptedRefreshToken = refreshToken
        ? encryptToken(refreshToken)
        : existingRefreshToken;

    await pool.query(
        `INSERT INTO google_cloud_oauth_tokens (
            id, google_email, refresh_token_enc, scopes, updated_at
        )
        VALUES (1, $1, $2, $3, NOW())
        ON CONFLICT (id) DO UPDATE SET
            google_email = EXCLUDED.google_email,
            refresh_token_enc = COALESCE(
                EXCLUDED.refresh_token_enc,
                google_cloud_oauth_tokens.refresh_token_enc
            ),
            scopes = CASE
                WHEN cardinality(EXCLUDED.scopes) > 0
                THEN EXCLUDED.scopes
                ELSE google_cloud_oauth_tokens.scopes
            END,
            updated_at = NOW()`,
        [
            email.trim().toLowerCase(),
            encryptedRefreshToken,
            scopes
        ]
    );
};

export const getGoogleCloudProjectByEmail = async (email) => {
    const googleEmail = email.trim().toLowerCase();
    const result = await pool.query(
        `SELECT google_email, project_id
         FROM google_cloud_projects
         WHERE google_email = $1`,
        [googleEmail]
    );

    if (result.rowCount === 0) {
        return null;
    }

    const projectId = String(result.rows[0].project_id || "").trim();
    if (!projectId) {
        return null;
    }

    return {
        email: result.rows[0].google_email,
        projectId
    };
};

export const saveGoogleCloudProject = async (email, projectId) => {
    const googleEmail = email.trim().toLowerCase();
    const normalizedProjectId = projectId.trim().toLowerCase();

    await pool.query(
        `INSERT INTO google_cloud_projects (
            google_email, project_id, updated_at
        )
        VALUES ($1, $2, NOW())
        ON CONFLICT (google_email) DO UPDATE SET
            project_id = EXCLUDED.project_id,
            updated_at = NOW()`,
        [googleEmail, normalizedProjectId]
    );
};

export const getGoogleCloudOAuthRefreshToken = async () => {
    const result = await pool.query(
        `SELECT google_email, refresh_token_enc
         FROM google_cloud_oauth_tokens
         WHERE id = 1`
    );

    if (result.rowCount === 0) {
        return null;
    }

    return {
        email: result.rows[0].google_email,
        refreshToken: decryptToken(result.rows[0].refresh_token_enc)
    };
};

// Save employee tokens
export const saveGoogleTokens = async (email, tokens) => {
    const googleEmail = email.trim().toLowerCase();

    const encryptedAccessToken = encryptToken(tokens.access_token);

    const encryptedRefreshToken = tokens.refresh_token?.startsWith("1//")
        ? tokens.refresh_token
        : encryptToken(tokens.refresh_token);

    const expiry = tokens.expiry_date
        ? new Date(tokens.expiry_date)
        : null;

    const expiresInSeconds = Number(tokens.refresh_token_expires_in);
    const refreshExpiresIn = Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
        ? Math.floor(expiresInSeconds)
        : null;
    const refreshExpiresAt = tokens.refresh_token && refreshExpiresIn
        ? new Date(Date.now() + refreshExpiresIn * 1000)
        : null;

    const scopes = tokens.scope
        ? tokens.scope.split(" ")
        : [];

    await pool.query(
        `
        INSERT INTO google_oauth_tokens (
            google_email,
            access_token_enc,
            refresh_token_enc,
            token_expiry,
            scopes,
            refresh_token_expires_at,
            refresh_token_expires_in
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)

        ON CONFLICT (google_email)
        DO UPDATE SET
            access_token_enc = COALESCE(
                EXCLUDED.access_token_enc,
                google_oauth_tokens.access_token_enc
            ),

            refresh_token_enc = COALESCE(
                EXCLUDED.refresh_token_enc,
                google_oauth_tokens.refresh_token_enc
            ),

            token_expiry = COALESCE(
                EXCLUDED.token_expiry,
                google_oauth_tokens.token_expiry
            ),

            refresh_token_expires_at = COALESCE(
                EXCLUDED.refresh_token_expires_at,
                google_oauth_tokens.refresh_token_expires_at
            ),

            refresh_token_expires_in = COALESCE(
                EXCLUDED.refresh_token_expires_in,
                google_oauth_tokens.refresh_token_expires_in
            ),

            scopes = CASE
                WHEN cardinality(EXCLUDED.scopes) > 0
                THEN EXCLUDED.scopes
                ELSE google_oauth_tokens.scopes
            END,

            updated_at = NOW()
        `,
        [
            googleEmail,
            encryptedAccessToken,
            encryptedRefreshToken,
            expiry,
            scopes,
            refreshExpiresAt,
            refreshExpiresIn
        ]
    );

    console.log(`Google tokens saved for ${googleEmail}`);
};

// Retrieve employee authentication
export const getGoogleAuth = async (email) => {
    const googleEmail = email.trim().toLowerCase();

    const result = await pool.query(
        `
        SELECT *
        FROM google_oauth_tokens
        WHERE google_email = $1
        `,
        [googleEmail]
    );

    if (result.rows.length === 0) {
        throw new Error(
            `Google account ${googleEmail} is not connected.`
        );
    }

    const row = result.rows[0];

    const storedRefreshToken = row.refresh_token_enc || "";
    const refreshToken = storedRefreshToken.startsWith("1//")
        ? storedRefreshToken
        : decryptToken(storedRefreshToken);

    if (!refreshToken) {
        throw new Error(
            `No refresh token found for ${googleEmail}. Reconnect the account.`
        );
    }

    if (
        row.refresh_token_expires_at &&
        new Date(row.refresh_token_expires_at).getTime() <= Date.now()
    ) {
        throw new Error(
            `Refresh token for ${googleEmail} expired after 7 days. Reconnect the account.`
        );
    }

    const auth = new google.auth.OAuth2(
        CLIENT_ID,
        CLIENT_SECRET,
        REDIRECT_URI
    );

    auth.setCredentials({
        refresh_token: refreshToken,
        access_token: decryptToken(row.access_token_enc),
        expiry_date: row.token_expiry
            ? new Date(row.token_expiry).getTime()
            : undefined
    });

    // Refresh the access token when required
    const { credentials } = await auth.refreshAccessToken();

    await saveGoogleTokens(googleEmail, credentials);

    return auth;
};

export { pool };
