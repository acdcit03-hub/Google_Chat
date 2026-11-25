import { pool } from "../../config/db.js";

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
        ALTER TABLE google_oauth_tokens
        ADD COLUMN IF NOT EXISTS refresh_token_expires_at TIMESTAMPTZ
    `);

    await pool.query(`
        ALTER TABLE google_oauth_tokens
        ADD COLUMN IF NOT EXISTS refresh_token_expires_in INTEGER
    `);

    await pool.query(`DROP TABLE IF EXISTS google_cloud_oauth_tokens`);
    await pool.query(`DROP TABLE IF EXISTS google_cloud_projects`);

    console.log("Google OAuth token table initialized.");
};

export const upsertGoogleOAuthToken = async ({
    googleEmail,
    accessTokenEnc,
    refreshTokenEnc,
    tokenExpiry,
    scopes,
    refreshTokenExpiresAt,
    refreshTokenExpiresIn
}) => {
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
            accessTokenEnc,
            refreshTokenEnc,
            tokenExpiry,
            scopes,
            refreshTokenExpiresAt,
            refreshTokenExpiresIn
        ]
    );
};

export const findLatestGoogleOAuthToken = async (email) => {
    const result = await pool.query(
        `
        SELECT google_email, refresh_token_enc, refresh_token_expires_at
        FROM google_oauth_tokens
        WHERE ($1::text IS NULL OR LOWER(google_email) = LOWER($1))
        ORDER BY updated_at DESC NULLS LAST
        LIMIT 1
        `,
        [email || null]
    );
    return result.rows[0] || null;
};
