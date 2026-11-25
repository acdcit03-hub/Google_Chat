import { spawn } from "child_process";
import { findLatestGoogleOAuthToken } from "../../models/GoogleChat/googleOAuthToken.model.js";
import { readRefreshToken, refreshAccessToken } from "./googleAuth.service.js";

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

const googleChatError = (googleMessage, fallback) => {
    const error = new Error(
        /insufficient authentication scopes/i.test(googleMessage || "")
            ? "Your token has expired. Generate it."
            : googleMessage || fallback
    );
    error.code = "GOOGLE_CHAT_SPACE_ERROR";
    return error;
};

const spaceResourceName = (value) => {
    const parent = String(value || "");
    if (!parent.startsWith("spaces/")) {
        const error = new Error("Google Chat space id is missing.");
        error.status = 500;
        error.code = "GOOGLE_CHAT_SPACE_ERROR";
        throw error;
    }
    return parent;
};

const missingTokenError = (message) => {
    const error = new Error(message);
    error.status = 404;
    error.code = "GOOGLE_TOKEN_NOT_FOUND";
    return error;
};

export const loadUsableAccessToken = async (email) => {
    const tokenRow = await findLatestGoogleOAuthToken(email || "");
    if (!tokenRow?.refresh_token_enc) {
        throw missingTokenError("Your token has expired. Generate it.");
    }
    if (
        tokenRow.refresh_token_expires_at &&
        new Date(tokenRow.refresh_token_expires_at).getTime() <= Date.now()
    ) {
        const error = new Error("Your token has expired. Generate it.");
        error.status = 403;
        error.code = "GOOGLE_REFRESH_EXPIRED";
        throw error;
    }
    const refreshToken = readRefreshToken(tokenRow.refresh_token_enc);
    if (!refreshToken.startsWith("1//")) {
        const error = new Error("Your token has expired. Generate it.");
        error.status = 403;
        error.code = "GOOGLE_REFRESH_FAILED";
        throw error;
    }
    return refreshAccessToken(refreshToken);
};

export const findSpace = async (accessToken, spaceName) => {
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

export const createSpace = async (accessToken, spaceName) => {
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

export const addSpaceMember = async (accessToken, parentSpace, workEmail) => {
    const parent = spaceResourceName(parentSpace);
    const { response, data } = await chatRequest(
        accessToken,
        `https://chat.googleapis.com/v1/${parent}/members`,
        {
            method: "POST",
            body: JSON.stringify({
                member: {
                    name: `users/${workEmail}`,
                    type: "HUMAN"
                }
            })
        }
    );
    if (response.ok) return "added";
    const googleMessage = String(data?.error?.message || "");
    if (response.status === 409 || /already exists/i.test(googleMessage)) {
        return "already_member";
    }
    const error = googleChatError(googleMessage, "Google Chat could not add the member.");
    error.status = response.status;
    throw error;
};

export const getSpaceMembership = async (accessToken, parentSpace, workEmail) => {
    const parent = spaceResourceName(parentSpace);
    const { response, data } = await chatRequest(
        accessToken,
        `https://chat.googleapis.com/v1/${parent}/members/${workEmail}`
    );
    if (response.status === 404) return null;
    if (!response.ok) {
        const error = googleChatError(
            data?.error?.message,
            "Google Chat could not read the member."
        );
        error.status = response.status;
        throw error;
    }
    return data;
};

export const listSpaceMembers = async (accessToken, parentSpace) => {
    const parent = spaceResourceName(parentSpace);
    const memberships = [];
    let pageToken = "";

    for (let page = 0; page < 20; page += 1) {
        const url = new URL(`https://chat.googleapis.com/v1/${parent}/members`);
        url.searchParams.set("pageSize", "100");
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const { response, data } = await chatRequest(accessToken, url);
        if (!response.ok) {
            const error = googleChatError(
                data?.error?.message,
                "Google Chat could not list members."
            );
            error.status = response.status;
            throw error;
        }
        memberships.push(...(data.memberships || []));
        pageToken = data.nextPageToken || "";
        if (!pageToken) break;
    }

    return memberships;
};

export const removeSpaceMember = async (accessToken, membershipName) => {
    const name = String(membershipName || "");
    if (!name.startsWith("spaces/") || !name.includes("/members/")) {
        throw googleChatError("", "Google Chat membership id is missing.");
    }
    const { response, data } = await chatRequest(
        accessToken,
        `https://chat.googleapis.com/v1/${name}`,
        { method: "DELETE" }
    );
    if (response.ok || response.status === 404) return;
    const error = googleChatError(
        data?.error?.message,
        "Google Chat could not remove the member."
    );
    error.status = response.status;
    throw error;
};

export const callerUserResourceNames = async (accessToken, workEmail) => {
    const names = new Set();
    if (workEmail) names.add(`users/${workEmail.toLowerCase()}`);
    try {
        const response = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        const profile = await response.json().catch(() => ({}));
        if (profile?.id) names.add(`users/${profile.id}`);
    } catch {
        return names;
    }
    return names;
};

export const openSpaceUri = (spaceUri) => {
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

export const spacePayload = (space, spaceName, action) => ({
    name: space.displayName || spaceName,
    action,
    space_name: space.name || null,
    space_uri: space.spaceUri || null
});

export const findDirectMessage = async (accessToken, workEmail) => {
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

export const createDirectMessage = async (accessToken, workEmail) => {
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
