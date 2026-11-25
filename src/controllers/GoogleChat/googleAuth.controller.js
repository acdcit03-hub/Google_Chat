import crypto from "crypto";
import { google } from "googleapis";
import { findWorkEmailByUsername } from "../../models/Employee/EmploymentDetails.model.js";
import {
    callbackUri,
    createOAuthClient,
    isAllowedCallbackUri,
    openAuthorizationUrl,
    requireGoogleOAuthConfig,
    saveGoogleTokens,
    SETUP_SCOPES,
    signState,
    validateEmail,
    verifyState,
    withPrivateIpDeviceParams
} from "../../services/GoogleChat/googleAuth.service.js";

export const startGoogleCloudProjectOAuth = async (req, res) => {
    try {
        const username = String(req.body?.username ?? req.query?.username ?? "").trim();
        if (!username) {
            return res.status(400).json({
                success: false,
                message: "Username is required."
            });
        }

        const workEmail = await findWorkEmailByUsername(username);
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
        if (!validateEmail(workEmail)) {
            return res.status(400).json({
                success: false,
                message: "Employee work email is not a valid email."
            });
        }

        const normalizedEmail = workEmail.trim().toLowerCase();
        const redirectUri = callbackUri(req);
        if (!redirectUri) {
            return res.status(400).json({
                success: false,
                message: "This host cannot be used as the Google OAuth callback."
            });
        }

        requireGoogleOAuthConfig();
        const setupClient = new google.auth.OAuth2(
            process.env.googleAuth_client,
            process.env.googleAuth_secret,
            redirectUri
        );
        const authUrl = withPrivateIpDeviceParams(
            setupClient.generateAuthUrl({
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
            }),
            redirectUri
        );
        const browserOpened = openAuthorizationUrl(authUrl);

        return res.status(200).json({
            success: true,
            message: browserOpened
                ? "Google authorization opened. Allow access as the employee work email. The callback saves the refresh token."
                : "Open authUrl in your browser and allow access as the employee work email. The refresh token is saved only after Google returns to the callback.",
            data: {
                username,
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

export const googleAuthCallback = async (req, res) => {
    try {
        const { code, state, error } = req.query;

        if (error) {
            return res.status(400).send(
                "Google authorization was cancelled or denied."
            );
        }
        if (!code || !state || typeof code !== "string" || typeof state !== "string") {
            return res.status(400).send(
                "Authorization code or state is missing."
            );
        }

        const stateData = verifyState(state);
        if (stateData.flow !== "cloud-project-setup") {
            throw new Error("OAuth flow is not allowed.");
        }

        const redirectUri = String(stateData.redirectUri || "");
        if (!isAllowedCallbackUri(redirectUri)) {
            throw new Error("OAuth callback address is not allowed.");
        }
        if (!stateData.email) {
            throw new Error("OAuth state is missing the account email.");
        }

        requireGoogleOAuthConfig();
        const cloudAuth = createOAuthClient(redirectUri);
        const { tokens } = await cloudAuth.getToken(code);

        if (!tokens.id_token) {
            throw new Error(
                "Google did not return an ID token. Reauthorize the account."
            );
        }

        cloudAuth.setCredentials(tokens);
        const ticket = await cloudAuth.verifyIdToken({
            idToken: tokens.id_token,
            audience: process.env.googleAuth_client
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

        await saveGoogleTokens(googleEmail, tokens);

        const safeEmail = googleEmail
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");

        return res.status(200).send(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
              <meta charset="UTF-8" />
              <meta name="viewport" content="width=device-width, initial-scale=1" />
              <title>Google account connected</title>
              <style>
                :root {
                  --bg: #f5f7fa;
                  --card: #ffffff;
                  --text: #1f2937;
                  --muted: #6b7280;
                  --ok: #15803d;
                  --ok-bg: #ecfdf3;
                  --border: #e5e7eb;
                }
                * { box-sizing: border-box; }
                body {
                  margin: 0;
                  min-height: 100vh;
                  display: grid;
                  place-items: center;
                  background: var(--bg);
                  color: var(--text);
                  font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
                  padding: 24px;
                }
                .card {
                  width: 100%;
                  max-width: 420px;
                  background: var(--card);
                  border: 1px solid var(--border);
                  border-radius: 12px;
                  padding: 32px 28px;
                  text-align: center;
                  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.06);
                }
                .badge {
                  width: 56px;
                  height: 56px;
                  margin: 0 auto 16px;
                  border-radius: 50%;
                  background: var(--ok-bg);
                  color: var(--ok);
                  display: grid;
                  place-items: center;
                  font-size: 28px;
                  font-weight: 700;
                  line-height: 1;
                }
                h1 {
                  margin: 0 0 8px;
                  font-size: 22px;
                  font-weight: 650;
                }
                p {
                  margin: 0;
                  color: var(--muted);
                  font-size: 15px;
                  line-height: 1.5;
                }
                .email {
                  margin-top: 12px;
                  padding: 10px 12px;
                  border-radius: 8px;
                  background: #f9fafb;
                  border: 1px solid var(--border);
                  color: var(--text);
                  font-size: 14px;
                  word-break: break-all;
                }
                .hint {
                  margin-top: 18px;
                  font-size: 13px;
                }
              </style>
            </head>
            <body>
              <main class="card">
                <div class="badge" aria-hidden="true">✓</div>
                <h1>Google account connected</h1>
                <p>Your Google Chat refresh token was generated and saved successfully.</p>
                <div class="email">${safeEmail}</div>
                <p class="hint">You can close this window and continue in the app.</p>
              </main>
            </body>
            </html>
        `);
    } catch (error) {
        console.error("Google OAuth callback error:", error);
        const safeMessage = String(error.message || "Unknown error")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");

        return res.status(400).send(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
              <meta charset="UTF-8" />
              <meta name="viewport" content="width=device-width, initial-scale=1" />
              <title>Google authentication failed</title>
              <style>
                body {
                  margin: 0;
                  min-height: 100vh;
                  display: grid;
                  place-items: center;
                  background: #f5f7fa;
                  color: #1f2937;
                  font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
                  padding: 24px;
                }
                .card {
                  width: 100%;
                  max-width: 420px;
                  background: #fff;
                  border: 1px solid #e5e7eb;
                  border-radius: 12px;
                  padding: 32px 28px;
                  text-align: center;
                  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.06);
                }
                h1 { margin: 0 0 8px; font-size: 22px; }
                p { margin: 0; color: #6b7280; font-size: 15px; line-height: 1.5; }
                .detail {
                  margin-top: 12px;
                  padding: 10px 12px;
                  border-radius: 8px;
                  background: #fef2f2;
                  border: 1px solid #fecaca;
                  color: #991b1b;
                  font-size: 14px;
                  word-break: break-word;
                }
              </style>
            </head>
            <body>
              <main class="card">
                <h1>Google authentication failed</h1>
                <p>The refresh token could not be generated.</p>
                <div class="detail">${safeMessage}</div>
              </main>
            </body>
            </html>
        `);
    }
};
