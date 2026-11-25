import { findWorkEmailByUsername } from "../../models/Employee/EmploymentDetails.model.js";
import { cleanEnv } from "../../services/GoogleChat/googleAuth.service.js";
import {
    addSpaceMember,
    callerUserResourceNames,
    createDirectMessage,
    createSpace,
    findDirectMessage,
    findSpace,
    getSpaceMembership,
    listSpaceMembers,
    loadUsableAccessToken,
    openSpaceUri,
    removeSpaceMember,
    spacePayload
} from "../../services/GoogleChat/googleChat.service.js";

const sendGoogleChatError = (res, error) => {
    const googleMessage = error.message || "Unable to open Google Chat.";
    if (/Chat app not found/i.test(googleMessage)) {
        const projectNumber = cleanEnv(process.env.googleAuth_client).split("-")[0];
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
        const projectNumber = cleanEnv(process.env.googleAuth_client).split("-")[0];
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

export const createGoogleChatSpace = async (req, res) => {
    try {
        const username = String(req.body?.username || "").trim();
        const spaceName = String(req.body?.space_name || "").trim();
        const memberUsernames = Array.isArray(req.body?.member)
            ? req.body.member
            : null;

        if (!username) {
            return res.status(400).json({
                success: false,
                message: "username is required."
            });
        }
        if (!spaceName) {
            return res.status(400).json({
                success: false,
                message: "space_name is required."
            });
        }
        if (spaceName.length > 128) {
            return res.status(400).json({
                success: false,
                message: "Space name must be 128 characters or fewer."
            });
        }
        if (req.body?.member != null && !Array.isArray(req.body.member)) {
            return res.status(400).json({
                success: false,
                message: "member must be a list of usernames."
            });
        }

        const fromEmail = await findWorkEmailByUsername(username);
        console.log(
            "Create Google Chat space from:",
            username,
            fromEmail || "not found",
            "| space_name:",
            spaceName
        );
        if (!fromEmail) {
            return res.status(404).json({
                success: false,
                message: `Work email not found for ${username}.`
            });
        }

        const accessToken = await loadUsableAccessToken(fromEmail);
        let existing = null;
        try {
            existing = await findSpace(accessToken, spaceName);
        } catch (error) {
            if (!/insufficient authentication scopes/i.test(error.message || "")) {
                throw error;
            }
        }
        const space = existing || (await createSpace(accessToken, spaceName));
        const memberResults = [];
        const desiredMembers = [];
        const seenMembers = new Set();
        for (const rawMember of memberUsernames || []) {
            const memberUsername = String(rawMember || "").trim();
            const memberKey = memberUsername.toLowerCase();
            if (!memberUsername || seenMembers.has(memberKey)) continue;
            seenMembers.add(memberKey);

            const memberEmail = await findWorkEmailByUsername(memberUsername);
            if (!memberEmail) {
                memberResults.push({
                    username: memberUsername,
                    status: "work_email_not_found"
                });
                continue;
            }
            desiredMembers.push({
                username: memberUsername,
                email: memberEmail
            });
        }

        if (Array.isArray(memberUsernames)) {
            const keepMembershipNames = new Set();
            const callerUsers = await callerUserResourceNames(accessToken, fromEmail);
            let callerMembershipName = "";
            try {
                const callerMembership = await getSpaceMembership(
                    accessToken,
                    space.name,
                    fromEmail
                );
                callerMembershipName = callerMembership?.name || "";
                if (callerMembershipName) keepMembershipNames.add(callerMembershipName);
            } catch (error) {
                memberResults.push({
                    status: "failed",
                    message: error.message
                });
            }

            const membersToAdd = [];
            if (!memberResults.some((item) => item.status === "failed" && !item.username)) {
                for (const person of desiredMembers) {
                    try {
                        const membership = await getSpaceMembership(
                            accessToken,
                            space.name,
                            person.email
                        );
                        if (membership?.name) {
                            keepMembershipNames.add(membership.name);
                            memberResults.push({
                                username: person.username,
                                email: person.email,
                                status: "already_member"
                            });
                        } else {
                            membersToAdd.push(person);
                        }
                    } catch (error) {
                        memberResults.push({
                            username: person.username,
                            email: person.email,
                            status: "failed",
                            message: error.message
                        });
                    }
                }

                const canRemove = Boolean(callerMembershipName || callerUsers.size > 1);
                if (canRemove) {
                    try {
                        const currentMembers = await listSpaceMembers(accessToken, space.name);
                        for (const membership of currentMembers) {
                            const userResource = String(membership.member?.name || "");
                            if (membership.member?.type && membership.member.type !== "HUMAN") {
                                continue;
                            }
                            if (!membership.member || membership.groupMember) continue;
                            if (callerUsers.has(userResource)) continue;
                            if (callerMembershipName && membership.name === callerMembershipName) {
                                continue;
                            }
                            if (keepMembershipNames.has(membership.name)) continue;
                            try {
                                await removeSpaceMember(accessToken, membership.name);
                                memberResults.push({
                                    status: "removed",
                                    ...(membership.member.displayName
                                        ? { name: membership.member.displayName }
                                        : {})
                                });
                            } catch (error) {
                                memberResults.push({
                                    status: "failed",
                                    message: error.message,
                                    ...(membership.member.displayName
                                        ? { name: membership.member.displayName }
                                        : {})
                                });
                            }
                        }
                    } catch (error) {
                        memberResults.push({
                            status: "failed",
                            message: error.message
                        });
                    }
                }

                for (const person of membersToAdd) {
                    try {
                        const status = await addSpaceMember(
                            accessToken,
                            space.name,
                            person.email
                        );
                        memberResults.push({
                            username: person.username,
                            email: person.email,
                            status
                        });
                    } catch (error) {
                        memberResults.push({
                            username: person.username,
                            email: person.email,
                            status: "failed",
                            message: error.message
                        });
                    }
                }
            }
        }
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
                username,
                email: fromEmail,
                space_name: spaceName,
                ...spacePayload(space, spaceName, existing ? "opened" : "created"),
                member: memberResults,
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
        const fromUsername = String(req.body?.from_username || "").trim();
        const toUsername = String(req.body?.to_username || "").trim();
        if (!fromUsername || !toUsername) {
            return res.status(400).json({
                success: false,
                message: "from_username and to_username are required."
            });
        }

        const fromEmail = await findWorkEmailByUsername(fromUsername);
        const toEmail = await findWorkEmailByUsername(toUsername);
        console.log(
            "Open Google Chat from:",
            fromUsername,
            fromEmail || "not found",
            "| to:",
            toUsername,
            toEmail || "not found"
        );
        if (!fromEmail) {
            return res.status(404).json({
                success: false,
                message: `Work email not found for ${fromUsername}.`
            });
        }
        if (!toEmail) {
            return res.status(404).json({
                success: false,
                message: `Work email not found for ${toUsername}.`
            });
        }

        const accessToken = await loadUsableAccessToken(fromEmail);
        let existing = null;
        try {
            existing = await findDirectMessage(accessToken, toEmail);
        } catch (error) {
            if (!/insufficient authentication scopes/i.test(error.message || "")) {
                throw error;
            }
        }
        const space = existing || (await createDirectMessage(accessToken, toEmail));
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
                from_username: fromUsername,
                from_email: fromEmail,
                to_username: toUsername,
                to_email: toEmail,
                ...spacePayload(space, toEmail, existing ? "opened" : "created"),
                browser_opened: openedInBrowser
            }
        });
    } catch (error) {
        console.error("OPEN EMPLOYEE GOOGLE CHAT ERROR:", error.message);
        return sendGoogleChatError(res, error);
    }
};
