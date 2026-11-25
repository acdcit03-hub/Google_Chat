import crypto from "crypto";
import { spawn } from "child_process";
import dotenv from "dotenv";
import { google } from "googleapis";
import { upsertGoogleOAuthToken } from "../../models/GoogleChat/googleOAuthToken.model.js";

dotenv.config();

export const cleanEnv = (value) =>
    String(value || "")
        .trim()
        .replace(/^["']|["']$/g, "")
        .trim();

const canEncryptTokens = () =>
    /^[0-9a-fA-F]{64}$/.test(cleanEnv(process.env.GOOGLE_TOKEN_ENCRYPTION_KEY));

const getEncryptionKey = () => {
    const raw = cleanEnv(process.env.GOOGLE_TOKEN_ENCRYPTION_KEY);
    if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
        throw new Error(
            "GOOGLE_TOKEN_ENCRYPTION_KEY must contain exactly 64 hexadecimal characters."
        );
    }
    return Buffer.from(raw, "hex");
};

const CLIENT_ID = cleanEnv(process.env.googleAuth_client);
const CLIENT_SECRET = cleanEnv(process.env.googleAuth_secret);
const REDIRECT_URI = cleanEnv(process.env.GOOGLE_REDIRECT_URI);

export const requireGoogleOAuthConfig = () => {
    if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
        throw new Error("Google OAuth environment variables are missing.");
    }
};

export const createOAuthClient = (redirectUri = REDIRECT_URI) => {
    requireGoogleOAuthConfig();
    return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, redirectUri);
};

export const SETUP_SCOPES = [
    "openid",
    "email",
    "profile",
    "https://www.googleapis.com/auth/chat.spaces.readonly",
    "https://www.googleapis.com/auth/chat.spaces.create",
    "https://www.googleapis.com/auth/chat.memberships"
];

const encryptToken = (value) => {
    if (!value) return null;

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
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

export const decryptToken = (encryptedValue) => {
    if (!encryptedValue) return null;

    const [ivHex, authTagHex, encryptedHex] = encryptedValue.split(":");
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

const storeRefreshToken = (value) => {
    if (!value) return null;
    if (String(value).startsWith("1//")) return value;
    return encryptToken(value);
};

const storeAccessToken = (value) => {
    if (!value || !canEncryptTokens()) return null;
    return encryptToken(value);
};

export const saveGoogleTokens = async (email, tokens) => {
    const googleEmail = email.trim().toLowerCase();
    const expiresInSeconds = Number(tokens.refresh_token_expires_in);
    const refreshExpiresIn = Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
        ? Math.floor(expiresInSeconds)
        : null;

    await upsertGoogleOAuthToken({
        googleEmail,
        accessTokenEnc: storeAccessToken(tokens.access_token),
        refreshTokenEnc: storeRefreshToken(tokens.refresh_token),
        tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        scopes: tokens.scope ? tokens.scope.split(" ") : [],
        refreshTokenExpiresAt: tokens.refresh_token && refreshExpiresIn
            ? new Date(Date.now() + refreshExpiresIn * 1000)
            : null,
        refreshTokenExpiresIn: refreshExpiresIn
    });

    console.log(`Google tokens saved for ${googleEmail}`);
};

export const validateEmail = (email) =>
    typeof email === "string" &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

const isPrivateLanHost = (host) =>
    /^(192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}):\d+$/.test(
        host
    );

export const callbackUri = (req) => {
    const host = String(req.get("host") || "").split(",")[0].trim();
    if (/^(localhost|127\.0\.0\.1):\d+$/.test(host)) {
        return `http://${host}/auth/google/callback`;
    }
    if (/^[a-z0-9-]+\.onrender\.com$/i.test(host)) {
        return `https://${host}/auth/google/callback`;
    }
    if (isPrivateLanHost(host)) {
        return `http://${host}/auth/google/callback`;
    }
    return "";
};

export const isAllowedCallbackUri = (uri) =>
    /^http:\/\/(localhost|127\.0\.0\.1):\d+\/auth\/google\/callback$/.test(uri) ||
    /^https:\/\/[a-z0-9-]+\.onrender\.com\/auth\/google\/callback$/i.test(uri) ||
    /^http:\/\/(192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}):\d+\/auth\/google\/callback$/.test(
        uri
    );

export const signState = (data) => {
    const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
    const signature = crypto
        .createHmac("sha256", CLIENT_SECRET)
        .update(payload)
        .digest("hex");
    return `${payload}.${signature}`;
};

export const verifyState = (state) => {
    if (!state || typeof state !== "string") {
        throw new Error("Invalid OAuth state.");
    }

    const parts = state.split(".");
    if (parts.length !== 2) {
        throw new Error("Invalid OAuth state.");
    }

    const [payload, signature] = parts;
    const expectedSignature = crypto
        .createHmac("sha256", CLIENT_SECRET)
        .update(payload)
        .digest("hex");

    if (!/^[a-f0-9]{64}$/i.test(signature)) {
        throw new Error("Invalid OAuth state signature.");
    }

    const actual = Buffer.from(signature, "hex");
    const expected = Buffer.from(expectedSignature, "hex");
    if (
        actual.length !== expected.length ||
        !crypto.timingSafeEqual(actual, expected)
    ) {
        throw new Error("OAuth state verification failed.");
    }

    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (data.expires < Date.now()) {
        throw new Error("OAuth session expired. Try again.");
    }
    return data;
};

export const withPrivateIpDeviceParams = (authUrl, redirectUri) => {
    let redirectHost = "";
    try {
        redirectHost = new URL(redirectUri).host;
    } catch {
        return authUrl;
    }
    if (!isPrivateLanHost(redirectHost)) return authUrl;
    const url = new URL(authUrl);
    const deviceId = `acdc-erp-${redirectHost.replace(/[^a-z0-9]+/gi, "-")}`
        .replace(/-+/g, "-")
        .slice(0, 64);
    url.searchParams.set("device_id", deviceId);
    url.searchParams.set("device_name", "ACDC ERP");
    return url.toString();
};

export const openAuthorizationUrl = (authUrl) => {
    if (process.platform !== "win32" && process.platform !== "darwin") {
        return false;
    }
    const parsed = new URL(authUrl);
    if (parsed.protocol !== "https:" || parsed.hostname !== "accounts.google.com") {
        return false;
    }
    const command =
        process.platform === "win32"
            ? { file: "rundll32.exe", args: ["url.dll,FileProtocolHandler", parsed.toString()] }
            : { file: "open", args: [parsed.toString()] };
    const browser = spawn(command.file, command.args, {
        detached: true,
        stdio: "ignore"
    });
    browser.unref();
    return true;
};

export const readRefreshToken = (storedValue) => {
    const value = String(storedValue || "").trim();
    if (value.startsWith("1//")) return value;
    if (!value) return "";
    return decryptToken(value);
};

export const refreshAccessToken = async (refreshToken) => {
    const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
    oauth2.setCredentials({ refresh_token: refreshToken });

    try {
        const tokenResponse = await oauth2.getAccessToken();
        const accessToken =
            typeof tokenResponse === "string"
                ? tokenResponse
                : tokenResponse?.token || "";
        if (accessToken.startsWith("ya29.")) return accessToken;
    } catch (error) {
        const detail = String(
            error?.response?.data?.error_description ||
                error?.response?.data?.error ||
                error.message ||
                ""
        );
        if (!/unauthorized_client|^unauthorized$/i.test(detail)) {
            const wrapped = new Error(detail || "Google refresh failed");
            wrapped.code = "GOOGLE_REFRESH_FAILED";
            throw wrapped;
        }
    }

    const response = await fetch(
        "https://developers.google.com/oauthplayground/refreshAccessToken",
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                token_uri: "https://oauth2.googleapis.com/token",
                refresh_token: refreshToken
            })
        }
    );
    const data = await response.json().catch(() => ({}));
    const accessToken = String(data.access_token || "");
    if (!accessToken.startsWith("ya29.")) {
        const wrapped = new Error(
            data.error_description ||
                data.error ||
                "Unable to refresh the Google token stored for this email."
        );
        wrapped.code = "GOOGLE_REFRESH_FAILED";
        throw wrapped;
    }
    return accessToken;
};
