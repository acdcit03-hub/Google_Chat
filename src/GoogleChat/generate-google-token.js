
import crypto from "crypto";
import { spawn } from "child_process";
import dotenv from "dotenv";

import {
    oauthClient,
    requireGoogleOAuthConfig,
    GOOGLE_SCOPES,
    saveGoogleTokens,
    getGoogleAuth,
    saveGoogleCloudOAuthTokens,
    getGoogleCloudProjectByEmail
} from "./googleAuth.js";
import { google } from "googleapis";
import { setupGoogleCloudProject, enableChatApiForProject } from "./googleCloudProject.service.js";

dotenv.config();

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT_ID;
const SERVICE_ACCOUNT_FILE =
    process.env.GOOGLE_SERVICE_ACCOUNT_FILE;

export const enableGoogleChatAPI = async (req, res) => {
    try {
        if (!PROJECT_ID || !SERVICE_ACCOUNT_FILE) {
            throw new Error(
                "Google Cloud project ID or service account file is missing."
            );
        }

        // Authenticate using the Google Cloud service account
        const auth = new google.auth.GoogleAuth({
            keyFile: SERVICE_ACCOUNT_FILE,
            scopes: [
                "https://www.googleapis.com/auth/cloud-platform"
            ]
        });

        const client = await auth.getClient();

        // Enable Google Chat API directly
        const response = await client.request({
            url:
                `https://serviceusage.googleapis.com/v1/projects/` +
                `${encodeURIComponent(PROJECT_ID)}/services/chat.googleapis.com:enable`,
            method: "POST"
        });

        return res.status(200).json({
            success: true,
            message: "Google Chat API enable request submitted.",
            projectId: PROJECT_ID,
            operation: response.data
        });

    } catch (error) {
        console.error(
            "Google Chat API enable error:",
            error.response?.data || error.message
        );

        return res.status(500).json({
            success: false,
            message:
                error.response?.data?.error?.message ||
                error.message
        });
    }
};

const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

// Validate email
const validateEmail = (email) => {
    return (
        typeof email === "string" &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
    );
};

// Generate signed OAuth state
const signState = (data) => {
    const payload = Buffer.from(JSON.stringify(data)).toString("base64url");

    const signature = crypto
        .createHmac("sha256", CLIENT_SECRET)
        .update(payload)
        .digest("hex");

    return `${payload}.${signature}`;
};

const createState = (email) => {
    return signState({
            email: email.trim().toLowerCase(),
            nonce: crypto.randomBytes(16).toString("hex"),
            expires: Date.now() + 10 * 60 * 1000
        });
};

const SETUP_SCOPES = [
    "openid",
    "email",
    "profile",
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/chat.spaces.readonly",
    "https://www.googleapis.com/auth/chat.spaces.create"
];

const callbackUri = (req) => {
    const host = String(req.get("host") || "").split(",")[0].trim();
    if (/^(localhost|127\.0\.0\.1):\d+$/.test(host)) {
        return `http://${host}/auth/google/callback`;
    }
    if (/^[a-z0-9-]+\.onrender\.com$/i.test(host)) {
        return `https://${host}/auth/google/callback`;
    }
    return "";
};

const isAllowedCallbackUri = (uri) =>
    /^http:\/\/(localhost|127\.0\.0\.1):\d+\/auth\/google\/callback$/.test(uri) ||
    /^https:\/\/[a-z0-9-]+\.onrender\.com\/auth\/google\/callback$/i.test(uri);

const openAuthorizationUrl = (authUrl) => {
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
            : process.platform === "darwin"
              ? { file: "open", args: [parsed.toString()] }
              : { file: "xdg-open", args: [parsed.toString()] };
    const browser = spawn(command.file, command.args, {
        detached: true,
        stdio: "ignore"
    });
    browser.unref();
    return true;
};

// Verify OAuth state
const verifyState = (state) => {
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

    const data = JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8")
    );

    if (data.expires < Date.now()) {
        throw new Error("OAuth session expired. Try again.");
    }

    return data;
};

export const startGoogleCloudProjectOAuth = async (req, res) => {
    try {
        const requestedEmail = req.body?.email ?? req.query?.email;

        if (!validateEmail(requestedEmail)) {
            return res.status(400).json({
                success: false,
                message: "Valid Google email is required."
            });
        }

        const normalizedEmail = requestedEmail.trim().toLowerCase();
        const redirectUri = callbackUri(req);
        if (!redirectUri) {
            return res.status(400).json({
                success: false,
                message: "This host cannot be used as the Google OAuth callback."
            });
        }

        requireGoogleOAuthConfig();
        const setupClient = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            redirectUri
        );
        const authUrl = setupClient.generateAuthUrl({
            access_type: "offline",
            prompt: "consent",
            include_granted_scopes: true,
            login_hint: normalizedEmail,
            scope: SETUP_SCOPES,
            state: signState({
                flow: "cloud-project-setup",
                email: normalizedEmail,
                redirectUri,
                nonce: crypto.randomBytes(16).toString("hex"),
                expires: Date.now() + 10 * 60 * 1000
            })
        });
        const browserOpened = openAuthorizationUrl(authUrl);

        return res.status(200).json({
            success: true,
            message: browserOpened
                ? "Google authorization opened. Allow access as the payload email. The callback saves the refresh token."
                : "Open authUrl in your browser and allow access. The refresh token is saved only after Google returns to the callback.",
            data: {
                email: normalizedEmail,
                authUrl,
                redirectUri,
                browser_opened: browserOpened,
                scopes: SETUP_SCOPES
            }
        });
    } catch (error) {
        console.error("Google Cloud OAuth setup error:", error);
        return res.status(500).json({
            success: false,
            message: error.response?.data?.error?.message || error.message
        });
    }
};

// Common function to generate Google URL
const createGoogleAuthUrl = (email) => {
    const state = createState(email);

    return oauthClient.generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: true,
        login_hint: email,
        scope: GOOGLE_SCOPES,
        state
    });
};

// STEP 1: Automatically redirect browser to Google authorization page
export const startGoogleAuth = async (req, res) => {
    try {
        const { email } = req.query;

        if (!validateEmail(email)) {
            return res.status(400).json({
                success: false,
                message: "Valid employee email is required."
            });
        }

        const normalizedEmail = email.trim().toLowerCase();

        const authUrl = createGoogleAuthUrl(normalizedEmail);

        // Backend redirects browser to Google
        return res.redirect(302, authUrl);

    } catch (error) {
        console.error("Google OAuth redirect error:", error);

        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

// STEP 2: Generate Google authorization URL as JSON
export const generateGoogleAuthUrl = async (req, res) => {
    try {
        const { email } = req.body;

        if (!validateEmail(email)) {
            return res.status(400).json({
                success: false,
                message: "Valid employee email is required."
            });
        }

        const normalizedEmail = email.trim().toLowerCase();

        const authUrl = createGoogleAuthUrl(normalizedEmail);

        return res.status(200).json({
            success: true,
            message: "Google authorization URL generated.",
            email: normalizedEmail,
            authUrl
        });

    } catch (error) {
        console.error("Google authorization URL error:", error);

        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

// STEP 3: Google OAuth callback
export const googleAuthCallback = async (req, res) => {
    try {
        const { code, state, error } = req.query;

        if (error) {
            return res.status(400).send(
                "Google authorization was cancelled or denied."
            );
        }

        if (!code || !state || typeof code !== "string" ||
            typeof state !== "string") {
            return res.status(400).send(
                "Authorization code or state is missing."
            );
        }

        const stateData = verifyState(state);

        if (stateData.flow === "cloud-project-setup") {
            const redirectUri = String(stateData.redirectUri || "");
            if (!isAllowedCallbackUri(redirectUri)) {
                throw new Error("OAuth callback address is not allowed.");
            }
            if (!stateData.email) {
                throw new Error("OAuth state is missing the account email.");
            }

            requireGoogleOAuthConfig();
            const cloudAuth = new google.auth.OAuth2(
                process.env.GOOGLE_CLIENT_ID,
                process.env.GOOGLE_CLIENT_SECRET,
                redirectUri
            );
            const { tokens } = await cloudAuth.getToken(code);

            if (!tokens.id_token) {
                throw new Error(
                    "Google did not return an ID token. Reauthorize the account."
                );
            }

            cloudAuth.setCredentials(tokens);
            const ticket = await cloudAuth.verifyIdToken({
                idToken: tokens.id_token,
                audience: process.env.GOOGLE_CLIENT_ID
            });
            const payload = ticket.getPayload();
            const googleEmail = payload?.email?.trim().toLowerCase();

            if (!payload?.email_verified || !googleEmail) {
                throw new Error("Google email is not verified.");
            }
            if (googleEmail !== stateData.email) {
                throw new Error(
                    "Signed-in Google email does not match the requested email."
                );
            }

            await saveGoogleCloudOAuthTokens(googleEmail, tokens);
            await saveGoogleTokens(googleEmail, tokens);

            let setupError = "";
            let result = null;
            try {
                const savedProject = await getGoogleCloudProjectByEmail(googleEmail);
                if (savedProject?.projectId) {
                    const chatApi = await enableChatApiForProject(
                        cloudAuth,
                        savedProject.projectId
                    );
                    result = {
                        projectId: savedProject.projectId,
                        chatApi
                    };
                } else {
                    result = await setupGoogleCloudProject(cloudAuth);
                }
            } catch (error) {
                setupError = error.response?.data?.error?.message || error.message;
            }

            return res.status(200).send(`
            <!DOCTYPE html>
            <html>
                <head><title>Google Chat setup</title></head>
                <body style="font-family: Arial; text-align: center; padding: 50px;">
                    <h2>Google account connected</h2>
                    <p>Refresh token saved for ${googleEmail}.</p>
                    <p>${result
                        ? `Chat API is enabled on project ${result.projectId}.`
                        : `Chat API was not enabled: ${setupError}`}</p>
                    <p>You can close this window.</p>
                </body>
            </html>
        `);
        }

        if (!stateData.email) {
            throw new Error("OAuth state is missing the account email.");
        }

        const { tokens } = await oauthClient.getToken(code);

        if (!tokens.id_token) {
            throw new Error(
                "Google did not return an ID token. Reauthorize the account."
            );
        }

        // Verify actual Google account
        const ticket = await oauthClient.verifyIdToken({
            idToken: tokens.id_token,
            audience: process.env.GOOGLE_CLIENT_ID
        });

        const payload = ticket.getPayload();

        const googleEmail = payload?.email?.trim().toLowerCase();

        if (!payload?.email_verified) {
            throw new Error("Google email is not verified.");
        }

        if (googleEmail !== stateData.email) {
            throw new Error(
                "Signed-in Google email does not match the requested employee email."
            );
        }

        // Save encrypted tokens in PostgreSQL
        await saveGoogleTokens(googleEmail, tokens);

        return res.status(200).send(`
            <!DOCTYPE html>
            <html>
                <head>
                    <title>Google Account Connected</title>
                </head>
                <body style="font-family: Arial; text-align: center; padding: 50px;">
                    <h2>Google Account Connected Successfully</h2>
                    <p>Your refresh token was saved and is valid for 7 days.</p>
                    <p>You can close this window.</p>
                </body>
            </html>
        `);

    } catch (error) {
        console.error("Google OAuth callback error:", error);

        return res.status(400).send(
            `Google authentication failed: ${error.message}`
        );
    }
};

// STEP 4: Retrieve saved employee authentication
export const getGoogleAuthController = async (req, res) => {
    try {
        const { email } = req.body;

        if (!validateEmail(email)) {
            return res.status(400).json({
                success: false,
                message: "Valid email is required."
            });
        }

        await getGoogleAuth(email);

        return res.status(200).json({
            success: true,
            message: "Google account authenticated successfully.",
            email: email.trim().toLowerCase()
        });

    } catch (error) {
        console.error("Google Auth Error:", error.message);

        return res.status(400).json({
            success: false,
            message: error.message
        });
    }
};
