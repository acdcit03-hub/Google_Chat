import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import { google } from 'googleapis';

dotenv.config();

function cleanEnv(value) {
    return String(value || '')
        .trim()
        .replace(/^["']|["']$/g, '')
        .trim();
}

function getGmailConfig() {
    const clientId = cleanEnv(process.env.EMAIL_CLIENT_ID);
    const clientSecret = cleanEnv(process.env.EMAIL_CLIENT_SECRET);
    const refreshToken = cleanEnv(process.env.EMAIL_REFRESH_TOKEN);
    const gmailUser = cleanEnv(process.env.GMAIL_USER);

    const missing = [];
    if (!clientId) missing.push('EMAIL_CLIENT_ID');
    if (!clientSecret) missing.push('EMAIL_CLIENT_SECRET');
    if (!refreshToken) missing.push('EMAIL_REFRESH_TOKEN');
    if (!gmailUser) missing.push('GMAIL_USER');

    if (missing.length) {
        throw new Error(
            `Gmail API mailer is not configured. Missing: ${missing.join(', ')}`,
        );
    }

    return { clientId, clientSecret, refreshToken, gmailUser };
}

function getGmailClient() {
    const { clientId, clientSecret, refreshToken } = getGmailConfig();
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    return google.gmail({ version: 'v1', auth: oauth2Client });
}

function encodeSubject(subject) {
    const value = String(subject || '');
    // Encode non-ASCII safely for RFC 2047
    if (/^[\x20-\x7E]*$/.test(value)) return value;
    return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/**
 * Build RFC 2822/MIME message and Base64URL-encode for Gmail API.
 */
function createRawEmail({ from, to, subject, html, text }) {
    const boundary = `mixed_${Date.now().toString(16)}`;
    const hasHtml = html != null && String(html).length > 0;
    const hasText = text != null && String(text).length > 0;

    const headers = [
        `From: ${from}`,
        `To: ${to}`,
        `Subject: ${encodeSubject(subject)}`,
        'MIME-Version: 1.0',
    ];

    let body;
    if (hasHtml && hasText) {
        headers.push(
            `Content-Type: multipart/alternative; boundary="${boundary}"`,
        );
        body = [
            `--${boundary}`,
            'Content-Type: text/plain; charset="UTF-8"',
            'Content-Transfer-Encoding: 7bit',
            '',
            String(text),
            `--${boundary}`,
            'Content-Type: text/html; charset="UTF-8"',
            'Content-Transfer-Encoding: 7bit',
            '',
            String(html),
            `--${boundary}--`,
            '',
        ].join('\r\n');
    } else if (hasHtml) {
        headers.push('Content-Type: text/html; charset="UTF-8"');
        headers.push('Content-Transfer-Encoding: 7bit');
        body = String(html);
    } else {
        headers.push('Content-Type: text/plain; charset="UTF-8"');
        headers.push('Content-Transfer-Encoding: 7bit');
        body = String(text || '');
    }

    const message = `${headers.join('\r\n')}\r\n\r\n${body}`;
    return Buffer.from(message, 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function resolveFromAddress(gmailUser) {
    const mailFrom = cleanEnv(process.env.MAIL_FROM);
    // Keep existing MAIL_FROM display form when it already uses GMAIL_USER
    if (mailFrom && mailFrom.toLowerCase().includes(gmailUser.toLowerCase())) {
        return mailFrom;
    }
    return `HR Team <${gmailUser}>`;
}

function sanitizeGoogleError(err) {
    const data = err?.response?.data || {};
    const oauthError = String(data.error || '').toLowerCase();
    const desc = String(
        data.error_description ||
            data.error?.message ||
            (Array.isArray(data.error?.errors) && data.error.errors[0]?.message) ||
            err?.message ||
            '',
    );
    const status = Number(err?.code || err?.status || data?.error?.code || 0);

    if (oauthError === 'invalid_client' || /client secret is invalid/i.test(desc)) {
        return new Error(
            'Gmail OAuth client is invalid. Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.',
        );
    }
    if (
        oauthError === 'invalid_grant' ||
        /invalid_grant/i.test(desc) ||
        /token has been expired or revoked/i.test(desc)
    ) {
        return new Error(
            'Gmail refresh token is invalid or revoked. Generate a new EMAIL_REFRESH_TOKEN with gmail.send scope.',
        );
    }
    if (
        status === 403 ||
        /insufficient.*(authentication )?scopes/i.test(desc) ||
        /ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(String(data.error || ''))
    ) {
        return new Error(
            'Gmail API token is missing required scope. Re-authorize OAuth with https://www.googleapis.com/auth/gmail.send (and Drive/Sheets scopes if you reuse the same EMAIL_REFRESH_TOKEN), then update .env.',
        );
    }
    if (status === 401 || oauthError === 'unauthorized') {
        return new Error('Gmail API authentication failed.');
    }
    return new Error(desc || 'Gmail API send failed.');
}

async function sendViaGmailApi({ to, subject, html, text }) {
    const { gmailUser } = getGmailConfig();
    const gmail = getGmailClient();
    const raw = createRawEmail({
        from: resolveFromAddress(gmailUser),
        to,
        subject,
        html,
        text,
    });

    try {
        const result = await gmail.users.messages.send({
            userId: 'me',
            requestBody: { raw },
        });
        return result.data;
    } catch (err) {
        throw sanitizeGoogleError(err);
    }
}

// Validate config once at module load (do not log secrets)
try {
    getGmailConfig();
    console.log('Gmail API mailer configured');
} catch (err) {
    console.error('Gmail API mailer config error:', err.message);
}

const sendCredentialsMail = async (toEmail, name, username) => {
    const token = jwt.sign(
        {
            username,
            purpose: 'set-password',
        },
        process.env.JWT_SECRET,
        {
            expiresIn: '7d',
        },
    );

    const setPasswordUrl = `${process.env.SET_PASSWORD_URL}?token=${token}`;

    const subject = 'Welcome to HRMS - Employee Account Created';
    const html = `
            <!DOCTYPE html>
            <html lang="en">
            <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>HRMS Account Setup</title>
            </head>
                
            <body
                style="
                    margin:0;
                    padding:0;
                    background:#f6f8fa;
                    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;
                    color:#24292f;
                "
            >
                
            <table
                role="presentation"
                width="100%"
                cellpadding="0"
                cellspacing="0"
                border="0"
                style="background:#f6f8fa;"
            >
            <tr>
            <td align="center" style="padding:32px 16px;">
                
            <table
                role="presentation"
                width="100%"
                cellpadding="0"
                cellspacing="0"
                border="0"
                style="
                    max-width:500px;
                    background:#ffffff;
                    border:1px solid #d0d7de;
                    border-radius:6px;
                "
            >
                
            <tr>
            <td style="padding:32px;">
                
            <p
                style="
                    margin:0 0 24px;
                    font-size:22px;
                    font-weight:600;
                    color:#194146;
                "
            >
                Welcome to HRMS
            </p>
                
            <p
                style="
                    margin:0 0 20px;
                    font-size:14px;
                    line-height:22px;
                    color:#24292f;
                "
            >
                Hello <strong>${name}</strong>,
            </p>
                
            <p
                style="
                    margin:0 0 20px;
                    font-size:14px;
                    line-height:22px;
                    color:#57606a;
                "
            >
                Your HRMS employee account has been created successfully.
                Use the username below and create your password to access your account.
            </p>
                
            <table
                role="presentation"
                width="100%"
                cellpadding="0"
                cellspacing="0"
                border="0"
                style="
                    margin:0 0 24px;
                    border:1px solid #d0d7de;
                    border-radius:6px;
                    background:#f6f8fa;
                "
            >
            <tr>
                
            <td
                style="
                    width:35%;
                    padding:12px;
                    font-size:13px;
                    font-weight:600;
                    color:#194146;
                    border-right:1px solid #d0d7de;
                "
            >
            Username
            </td>
                
            <td
                style="
                    padding:12px;
                    font-size:13px;
                    color:#57606a;
                "
            >
            ${username}
            </td>
                
            </tr>
            </table>
                
            <p
                style="
                    margin:0 0 16px;
                    font-size:14px;
                    line-height:22px;
                    color:#57606a;
                "
            >
            Click the button below to create your password.
            </p>
                
            <table
                role="presentation"
                cellpadding="0"
                cellspacing="0"
                border="0"
                style="margin-bottom:24px;"
            >
            <tr>
                
            <td
                align="center"
                style="
                    background:#194146;
                    border-radius:6px;
                "
            >
            <a
                href="${setPasswordUrl}"
                style="
                    display:inline-block;
                    padding:12px 24px;
                    color:#ffffff;
                    text-decoration:none;
                    font-size:14px;
                    font-weight:600;
                    border-radius:6px;
                "
            >
            Set Password
            </a>
            </td>
                
            </tr>
            </table>
                
            <p
                style="
                    margin:0;
                    font-size:12px;
                    line-height:20px;
                    color:#6e7781;
                "
            >
            For your security, please do not share this email or password setup link with anyone.
            </p>
                
            </td>
            </tr>
                
            <tr>
            <td
                style="
                    padding:16px 32px;
                    border-top:1px solid #d8dee4;
                "
            >
            <p
                style="
                    margin:0;
                    font-size:11px;
                    line-height:18px;
                    color:#8c959f;
                "
            >
            This is an automated message from the HRMS system.
            Please do not reply to this email.
            <br><br>
            © ${new Date().getFullYear()} HRMS. All Rights Reserved.
            </p>
            </td>
            </tr>
                
            </table>
                
            </td>
            </tr>
            </table>
                
            </body>
            </html>
            `;

    // Send in background and return immediately so callers are not blocked
    sendViaGmailApi({ to: toEmail, subject, html })
        .then((info) => console.log('Email sent via Gmail API:', info?.id || info))
        .catch((err) => console.error('Mail send error:', err.message));

    return { queued: true };
};

const sendOTPmail = async (toEmail, otp, expiresInSeconds = 60) => {
    const subject = 'ERP Password Reset';
    const html = `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>ERP Password Reset</title>
            </head>

            <body style="margin:0;padding:0;background:#f6f8fa;font-family:Arial,Helvetica,sans-serif;">

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f6f8fa;padding:40px 0;">
            <tr>
            <td align="center">

            <table role="presentation"
                   width="100%"
                   cellpadding="0"
                   cellspacing="0"
                   border="0"
                   style="
                        max-width:560px;
                        background:#ffffff;
                        border:1px solid #d0d7de;
                        border-radius:8px;
                        overflow:hidden;
                   ">

                <!-- Header -->
                <tr>
                    <td align="center"
                        style="
                            background:#194146;
                            padding:22px;
                        ">
                        <h2
                            style="
                                margin:0;
                                color:#ffffff;
                                font-size:24px;
                                font-weight:700;
                            "
                        >
                            HRMS Password Reset
                        </h2>
                    </td>
                </tr>

                <!-- Body -->
                <tr>
                    <td style="padding:35px;">

                        <p
                            style="
                                margin:0 0 20px;
                                font-size:15px;
                                color:#24292f;
                            "
                        >
                            Hello,
                        </p>

                        <p
                            style="
                                margin:0 0 25px;
                                font-size:15px;
                                line-height:24px;
                                color:#57606a;
                            "
                        >
                            We received a request to reset the password for your
                            <strong>HRMS account</strong>.
                            Please use the verification code below to continue.
                        </p>

                        <!-- OTP -->
                        <table
                            role="presentation"
                            align="center"
                            cellpadding="0"
                            cellspacing="0"
                            border="0"
                            style="margin:30px auto;"
                        >
                            <tr>
                                <td
                                    style="
                                        background:#f6f8fa;
                                        border:1px solid #d0d7de;
                                        border-radius:8px;
                                        padding:18px 35px;
                                        text-align:center;
                                    "
                                >
                                    <span
                                        style="
                                            font-size:32px;
                                            font-weight:bold;
                                            letter-spacing:8px;
                                            color:#194146;
                                        "
                                    >
                                        ${otp}
                                    </span>
                                </td>
                            </tr>
                        </table>

                        <p
                            style="
                                margin:0 0 20px;
                                font-size:15px;
                                color:#57606a;
                                text-align:center;
                            "
                        >
                            This verification code is valid for
                            <strong>${expiresInSeconds} seconds</strong>.
                        </p>

                        <hr
                            style="
                                border:none;
                                border-top:1px solid #e5e7eb;
                                margin:30px 0;
                            "
                        >

                        <p
                            style="
                                margin:0;
                                font-size:14px;
                                line-height:24px;
                                color:#6e7781;
                            "
                        >
                            If you did not request a password reset, you can safely ignore this email.
                            For your security, never share this verification code with anyone.
                        </p>

                        <p
                            style="
                                margin-top:30px;
                                font-size:15px;
                                color:#333;
                            "
                        >
                            Regards,<br>
                            <strong>HR Team</strong>
                        </p>

                    </td>
                </tr>

                <!-- Footer -->
                <tr>
                    <td
                        align="center"
                        style="
                            background:#194146;
                            color:#ffffff;
                            padding:15px;
                            font-size:12px;
                        "
                    >
                        This is an automated email from the HRMS System.<br>
                        Please do not reply to this email.
                        <br><br>
                        © ${new Date().getFullYear()} HRMS. All Rights Reserved.
                    </td>
                </tr>

            </table>

            </td>
            </tr>
            </table>

            </body>
            </html>
        `;

    // Send in background and return immediately so callers are not blocked
    sendViaGmailApi({ to: toEmail, subject, html })
        .then((info) => console.log('OTP email sent via Gmail API:', info?.id || info))
        .catch((err) => console.error('OTP mail send error:', err.message));

    return { queued: true };
};

export { sendOTPmail, createRawEmail, sendViaGmailApi };
export default sendCredentialsMail;
