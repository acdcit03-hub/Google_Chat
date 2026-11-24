import { spawn } from "child_process";
import { google } from "googleapis";
import { pool as appPool } from "../database.js";
import { pool, decryptToken } from "./googleAuth.js";

const cleanEnv = (value) =>
    String(value || "")
        .trim()
        .replace(/^["']|["']$/g, "")
        .trim();

const loadToken = async (email) => {
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

const readRefreshToken = (storedValue) => {
    const value = String(storedValue || "").trim();
    if (value.startsWith("1//")) return value;
    if (!value) return "";
    return decryptToken(value);
};

const refreshAccessToken = async (refreshToken) => {
    const clientId = cleanEnv(process.env.GOOGLE_CLIENT_ID);
    const clientSecret = cleanEnv(process.env.GOOGLE_CLIENT_SECRET);
    const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
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

const chatRequest = async (accessToken, url, options = {}) => {
    const response = await fetch(url, {
        method: options.method || "GET",
        headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json"
        },
        body: options.body
    });
    const data = await response.json().catch(() => ({}));
    return { response, data };
};

const findSpace = async (accessToken, spaceName) => {
    const target = spaceName.trim().toLowerCase();
    let pageToken = "";

    for (let page = 0; page < 10; page += 1) {
        const url = new URL("https://chat.googleapis.com/v1/spaces");
        url.searchParams.set("pageSize", "100");
        url.searchParams.set("filter", 'spaceType = "SPACE"');
        if (pageToken) url.searchParams.set("pageToken", pageToken);

        const { response, data } = await chatRequest(accessToken, url);
        if (!response.ok) {
            const error = new Error(
                data?.error?.message || "Google Chat could not search spaces."
            );
            error.status = response.status;
            error.code = "GOOGLE_CHAT_SPACE_ERROR";
            throw error;
        }

        const match = (data.spaces || []).find(
            (space) =>
                String(space.displayName || "").trim().toLowerCase() === target
        );
        if (match) return match;
        pageToken = data.nextPageToken || "";
        if (!pageToken) return null;
    }

    return null;
};

const createSpace = async (accessToken, spaceName) => {
    const { response, data } = await chatRequest(
        accessToken,
        "https://chat.googleapis.com/v1/spaces:setup",
        {
            method: "POST",
            body: JSON.stringify({
                space: {
                    spaceType: "SPACE",
                    displayName: spaceName
                }
            })
        }
    );
    if (!response.ok) {
        const error = new Error(
            data?.error?.message || "Google Chat did not create the space."
        );
        error.status = response.status;
        error.code = "GOOGLE_CHAT_SPACE_ERROR";
        throw error;
    }
    return data;
};

const openSpaceUri = (spaceUri) => {
    let parsed;
    try {
        parsed = new URL(String(spaceUri || ""));
    } catch {
        return false;
    }
    if (parsed.protocol !== "https:" || parsed.hostname !== "chat.google.com") {
        return false;
    }

    if (process.platform !== "win32" && process.platform !== "darwin") {
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

const spacePayload = (space, spaceName, action) => ({
    name: space.displayName || spaceName,
    action,
    space_name: space.name || null,
    space_uri: space.spaceUri || null
});

const findDirectMessage = async (accessToken, workEmail) => {
    const url = new URL("https://chat.googleapis.com/v1/spaces:findDirectMessage");
    url.searchParams.set("name", `users/${workEmail}`);
    const { response, data } = await chatRequest(accessToken, url);
    if (response.status === 404) return null;
    if (!response.ok) {
        const error = new Error(
            data?.error?.message || "Google Chat could not find the direct message."
        );
        error.status = response.status;
        error.code = "GOOGLE_CHAT_SPACE_ERROR";
        throw error;
    }
    return data;
};

const createDirectMessage = async (accessToken, workEmail) => {
    const { response, data } = await chatRequest(
        accessToken,
        "https://chat.googleapis.com/v1/spaces:setup",
        {
            method: "POST",
            body: JSON.stringify({
                space: { spaceType: "DIRECT_MESSAGE" },
                memberships: [
                    {
                        member: {
                            name: `users/${workEmail}`,
                            type: "HUMAN"
                        }
                    }
                ]
            })
        }
    );
    if (!response.ok) {
        const error = new Error(
            data?.error?.message || "Google Chat did not open the direct message."
        );
        error.status = response.status;
        error.code = "GOOGLE_CHAT_SPACE_ERROR";
        throw error;
    }
    return data;
};

const lookupWorkEmail = async (username) => {
    const result = await appPool.query(
        `
        SELECT NULLIF(TRIM(ed.work_email), '') AS work_email
        FROM employment_details ed
        LEFT JOIN personal_details pd
            ON pd.id = ed.personal_details_id
        WHERE LOWER(TRIM(COALESCE(ed.username, pd.username, '')))
            = LOWER(TRIM($1))
        ORDER BY
            CASE
                WHEN NULLIF(TRIM(ed.work_email), '') IS NULL THEN 1
                ELSE 0
            END,
        ed.updated_at DESC NULLS LAST
        LIMIT 1
        `,
        [username]
    );
    return result.rows[0]?.work_email || "";
};

const sendGoogleChatError = (res, error) => {
    const googleMessage = error.message || "Unable to open Google Chat.";
    if (/Chat app not found/i.test(googleMessage)) {
        const projectNumber = cleanEnv(process.env.GOOGLE_CLIENT_ID).split("-")[0];
        return res.status(409).json({
            success: false,
            code: "GOOGLE_CHAT_APP_NOT_CONFIGURED",
            message:
                "Save a Chat app on this Cloud project, then authorize again with this project's OAuth client.",
            configuration_url: projectNumber
                ? `https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat?project=${projectNumber}`
                : null
        });
    }
    if (/has not been used in project|it is disabled/i.test(googleMessage)) {
        const projectNumber = cleanEnv(process.env.GOOGLE_CLIENT_ID).split("-")[0];
        return res.status(409).json({
            success: false,
            code: "GOOGLE_CHAT_API_DISABLED",
            message: googleMessage,
            configuration_url: projectNumber
                ? `https://console.developers.google.com/apis/api/chat.googleapis.com/overview?project=${projectNumber}`
                : null
        });
    }
    return res.status(error.status || 500).json({
        success: false,
        code: error.code || "GOOGLE_CHAT_SPACE_ERROR",
        message: googleMessage
    });
};

const missingTokenError = (message) => {
    const error = new Error(message);
    error.status = 404;
    error.code = "GOOGLE_TOKEN_NOT_FOUND";
    return error;
};

const loadUsableAccessToken = async (email) => {
    const account = email || "";
    const tokenRow = await loadToken(account);
    if (!tokenRow?.refresh_token_enc) {
        throw missingTokenError("Your token has expired. Generate it.");
    }
    if (
        tokenRow.refresh_token_expires_at &&
        new Date(tokenRow.refresh_token_expires_at).getTime() <= Date.now()
    ) {
        const error = new Error(
            "Your token has expired. Generate it."
        );
        error.status = 403;
        error.code = "GOOGLE_REFRESH_EXPIRED";
        throw error;
    }
    const refreshToken = readRefreshToken(tokenRow.refresh_token_enc);
    if (!refreshToken.startsWith("1//")) {
        const error = new Error(
            "Your token has expired. Generate it."
        );
        error.status = 403;
        error.code = "GOOGLE_REFRESH_FAILED";
        throw error;
    }
    return refreshAccessToken(refreshToken);
};

export const createGoogleChatSpace = async (req, res) => {
    try {
        const email = String(req.body?.email || "").trim().toLowerCase();
        const spaceName = String(req.body?.name || "").trim();

        if (!spaceName) {
            return res.status(400).json({
                success: false,
                message: "Payload name is required."
            });
        }
        if (spaceName.length > 128) {
            return res.status(400).json({
                success: false,
                message: "Space name must be 128 characters or fewer."
            });
        }

        const accessToken = await loadUsableAccessToken(email);
        let existing = null;
        try {
            existing = await findSpace(accessToken, spaceName);
        } catch (error) {
            if (!/insufficient authentication scopes/i.test(error.message || "")) {
                throw error;
            }
        }
        const space = existing || (await createSpace(accessToken, spaceName));
        const openedInBrowser = openSpaceUri(space.spaceUri);

        return res.status(existing ? 200 : 201).json({
            success: true,
            message: existing
                ? openedInBrowser
                    ? "Google Chat space opened"
                    : "Google Chat space found. Open space_uri in your browser."
                : openedInBrowser
                  ? "Google Chat space created"
                  : "Google Chat space created. Open space_uri in your browser.",
            data: {
                ...spacePayload(space, spaceName, existing ? "opened" : "created"),
                browser_opened: openedInBrowser
            }
        });
    } catch (error) {
        console.error("CREATE GOOGLE CHAT SPACE ERROR:", error.message);
        return sendGoogleChatError(res, error);
    }
};

export const openEmployeeGoogleChat = async (req, res) => {
    try {
        const email = String(req.body?.email || "").trim().toLowerCase();
        const username = String(req.body?.username || "").trim();
        if (!username) {
            return res.status(400).json({
                success: false,
                message: "Username is required."
            });
        }

        const workEmail = await lookupWorkEmail(username);
        console.log(
            "Employee work email:",
            workEmail || "not found",
            "| username:",
            username
        );
        if (!workEmail) {
            return res.status(404).json({
                success: false,
                message: "Employee work email not found"
            });
        }

        const accessToken = await loadUsableAccessToken(email);
        let existing = null;
        try {
            existing = await findDirectMessage(accessToken, workEmail);
        } catch (error) {
            if (!/insufficient authentication scopes/i.test(error.message || "")) {
                throw error;
            }
        }
        const space = existing || (await createDirectMessage(accessToken, workEmail));
        const openedInBrowser = openSpaceUri(space.spaceUri);

        return res.status(existing ? 200 : 201).json({
            success: true,
            message: existing
                ? openedInBrowser
                    ? "Google Chat opened"
                    : "Google Chat found. Open space_uri in your browser."
                : openedInBrowser
                  ? "Google Chat direct message created"
                  : "Google Chat direct message created. Open space_uri in your browser.",
            data: {
                username,
                work_email: workEmail,
                ...spacePayload(space, workEmail, existing ? "opened" : "created"),
                browser_opened: openedInBrowser
            }
        });
    } catch (error) {
        console.error("OPEN EMPLOYEE GOOGLE CHAT ERROR:", error.message);
        return sendGoogleChatError(res, error);
    }
};
