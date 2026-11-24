import bcrypt from "bcrypt";
import crypto from "crypto";
import { pool } from "../../database.js";

/* ================= CREATE TABLE ================= */
export const initializeMasterPasswordTable = async () => {

    const query = `
        CREATE TABLE IF NOT EXISTS master_password (
            id SERIAL PRIMARY KEY,
            password_hash TEXT NOT NULL,
            secret_key TEXT UNIQUE,
            created_by VARCHAR(255),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `;

    await pool.query(query);

    await pool.query(`
        ALTER TABLE master_password
        ADD COLUMN IF NOT EXISTS secret_key_updated_at TIMESTAMP
        DEFAULT CURRENT_TIMESTAMP;
    `);

    await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS
        master_password_secret_key_unique
        ON master_password(secret_key);
    `);

    console.log("✅ master_password table ready");
};


/* ================= CREATE MASTER PASSWORD ================= */
export const createMasterPasswordModel = async ({
    password,
    created_by
}) => {

    /* ================= CHECK EXISTING ================= */
    const existing = await pool.query(`
        SELECT id
        FROM master_password
        LIMIT 1
    `);

    if (existing.rows.length > 0) {
        throw new Error("Master password already exists");
    }

    /* ================= HASH MASTER PASSWORD ================= */
    const passwordHash = await bcrypt.hash(
        String(password),
        12
    );

    /* ================= GENERATE SECRET KEY ================= */
    const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

    let secretKey = "";

    for (let i = 0; i < 16; i++) {

        const randomIndex = crypto.randomInt(
            0,
            characters.length
        );

        secretKey += characters[randomIndex];

    }

    /* ================= FORMAT SECRET KEY ================= */
    // Example:
    // ABCD EFGH IJKL MNOP

    secretKey = secretKey
        .match(/.{1,4}/g)
        .join(" ");

    /* ================= HASH SECRET KEY ================= */
    const secretKeyHash = await bcrypt.hash(
        secretKey,
        12
    );

    /* ================= INSERT ================= */
    const result = await pool.query(
        `
            INSERT INTO master_password (
                password_hash,
                secret_key,
                created_by
            )
            VALUES ($1, $2, $3)
            RETURNING
                id,
                created_by,
                created_at
        `,
        [
            passwordHash,
            secretKeyHash,
            created_by || null
        ]
    );

    /* ================= RETURN ================= */
    return {
        ...result.rows[0],
        secret_key: secretKey
    };
};

/* ================= VERIFY MASTER PASSWORD ================= */
export const verifyMasterPasswordModel = async (password) => {
    const { rows } = await pool.query(`
        SELECT password_hash
        FROM master_password
        ORDER BY id DESC
        LIMIT 1
    `);

    if (!rows.length) {
        return false;
    }

    const passwordHash = rows[0].password_hash;

    return await bcrypt.compare(
        String(password),
        String(passwordHash)
    );
};

/* ================= GET MASTER PASSWORD ================= */
export const getMasterPasswordModel = async () => {
    const { rows } = await pool.query(`
        SELECT
            (
                SELECT json_build_object(
                    'id', mp.id,
                    'created_by', mp.created_by,
                    'created_at', mp.created_at,
                    'updated_at', mp.updated_at
                )
                FROM master_password mp
                ORDER BY mp.id DESC
                LIMIT 1
            ) AS master_password,

            COALESCE(
                (
                    SELECT json_agg(
                        json_build_object(
                            'username', ed.username,
                            'work_email', ed.work_email
                        )
                        ORDER BY ed.username
                    )
                    FROM employment_details ed
                    WHERE ed.access = 1
                ),
                '[]'::json
            ) AS admins
    `);

    const data = rows[0];

    return {
        ...(data.master_password || {}),
        is_configured: data.master_password !== null,
        admins: data.admins
    };
};

/* ================= MATCH SECRET KEY ================= */
export const matchSecretKeyModel = async (secretKey) => {

    const { rows } = await pool.query(`
        SELECT
            id,
            created_by,
            created_at,
            updated_at,
            secret_key
        FROM master_password
        ORDER BY id DESC
        LIMIT 1
    `);

    if (!rows.length) {
        return false;
    }

    const masterPassword = rows[0];

    const isMatch = await bcrypt.compare(
        String(secretKey).trim(),
        String(masterPassword.secret_key)
    );

    if (!isMatch) {
        return false;
    }

    return {
        id: masterPassword.id,
        created_by: masterPassword.created_by,
        created_at: masterPassword.created_at,
        updated_at: masterPassword.updated_at
    };
};

/* ================= RESET MASTER PASSWORD ================= */
export const resetMasterPasswordModel = async ({
    secret_key,
    new_password,
    updated_by
}) => {

    /* ================= GET MASTER PASSWORD ================= */
    const { rows } = await pool.query(`
        SELECT
            id,
            secret_key
        FROM master_password
        ORDER BY id DESC
        LIMIT 1
    `);

    if (!rows.length) {
        throw new Error("Master password is not configured");
    }

    const masterPassword = rows[0];

    /* ================= VERIFY SECRET KEY ================= */
    const isSecretKeyValid = await bcrypt.compare(
        String(secret_key).trim(),
        String(masterPassword.secret_key)
    );

    if (!isSecretKeyValid) {
        throw new Error("Invalid secret key");
    }

    /* ================= HASH NEW PASSWORD ================= */
    const newPasswordHash = await bcrypt.hash(
        String(new_password),
        12
    );

    /* ================= UPDATE PASSWORD ================= */
    const result = await pool.query(
        `
            UPDATE master_password
            SET
                password_hash = $1,
                updated_at = CURRENT_TIMESTAMP,
                created_by = COALESCE($2, created_by)
            WHERE id = $3

            RETURNING
                id,
                created_by,
                created_at,
                updated_at
        `,
        [
            newPasswordHash,
            updated_by || null,
            masterPassword.id
        ]
    );

    /* ================= RETURN ================= */
    return result.rows[0];
};

/* ================= RESET SECRET KEY ================= */
export const resetSecretKeyModel = async ({
    updated_by
}) => {

    /* ================= GET MASTER PASSWORD ================= */
    const { rows } = await pool.query(`
        SELECT
            id,
            secret_key_updated_at
        FROM master_password
        ORDER BY id DESC
        LIMIT 1
    `);

    if (!rows.length) {
        throw new Error("Master password is not configured");
    }

    const masterPassword = rows[0];

    /* ================= CHECK 60 SECOND LIMIT ================= */
    if (masterPassword.secret_key_updated_at) {
        const lastResetTime = new Date(
            masterPassword.secret_key_updated_at
        );

        const currentTime = new Date();

        const elapsedSeconds =
            (currentTime.getTime() - lastResetTime.getTime()) / 1000;

        if (elapsedSeconds < 60) {

            const remainingSeconds = Math.ceil(
                60 - elapsedSeconds
            );

            throw new Error(
                `Secret key can be reset again after ${remainingSeconds} seconds`
            );
        }
    }

    /* ================= GENERATE NEW SECRET KEY ================= */
    const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

    let secretKey = "";

    for (let i = 0; i < 16; i++) {
        const randomIndex = crypto.randomInt(
            0,
            characters.length
        );

        secretKey += characters[randomIndex];
    }

    /* ================= FORMAT SECRET KEY ================= */
    secretKey = secretKey
        .match(/.{1,4}/g)
        .join(" ");

    /* ================= HASH SECRET KEY ================= */
    const secretKeyHash = await bcrypt.hash(
        secretKey,
        12
    );

    /* ================= UPDATE SECRET KEY ================= */
    const result = await pool.query(
        `
            UPDATE master_password
            SET
                secret_key = $1,
                secret_key_updated_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP,
                created_by = COALESCE($2, created_by)
            WHERE id = $3

            RETURNING
                id,
                created_by,
                created_at,
                updated_at,
                secret_key_updated_at
        `,
        [
            secretKeyHash,
            updated_by || null,
            masterPassword.id
        ]
    );

    /* ================= RETURN ================= */
    return {
        ...result.rows[0],
        secret_key: secretKey
    };
};