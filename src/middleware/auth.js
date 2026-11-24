import jwt from 'jsonwebtoken';

function extractToken(req) {
    const authHeader = req?.headers?.authorization ?? req?.headers?.Authorization;
    if (authHeader) {
        const value = String(authHeader).trim();
        if (value.toLowerCase().startsWith('bearer ')) {
            return value.slice(7).trim();
        }
        return value;
    }

    const headerToken =
        req?.headers?.['x-access-token'] ??
        req?.headers?.token ??
        req?.headers?.tokened ??
        null;
    if (headerToken) return String(headerToken).trim();

    const cookieHeader = req?.headers?.cookie;
    if (cookieHeader) {
        const match = String(cookieHeader).match(/(?:^|;\s*)tokened=([^;]+)/);
        if (match?.[1]) {
            return decodeURIComponent(match[1].trim());
        }
    }

    return null;
}

function resolveUserFromToken(token) {
    if (!token || !process.env.JWT_SECRET) {
        return null;
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const id = decoded?.id ?? decoded?.userId ?? decoded?.user_id ?? decoded?.sub ?? null;
        const n = id == null ? NaN : parseInt(String(id), 10);
        if (!Number.isFinite(n)) return null;

        const usernameRaw =
            decoded?.username ?? decoded?.user_name ?? decoded?.userName ?? null;
        const username =
            usernameRaw != null && String(usernameRaw).trim()
                ? String(usernameRaw).trim()
                : null;

        const accessRaw = decoded?.access ?? decoded?.Access ?? 0;
        const access = Number.isFinite(Number(accessRaw)) ? Number(accessRaw) : 0;

        const personalDetailsIdRaw =
            decoded?.personalDetailsId ?? decoded?.personal_details_id ?? null;
        const personalDetailsId = Number.parseInt(String(personalDetailsIdRaw), 10);

        const sessionRaw = decoded?.session_id ?? decoded?.sessionId ?? null;
        const session_id =
            sessionRaw != null && String(sessionRaw).trim()
                ? String(sessionRaw).trim()
                : null;

        return {
            id: n,
            username,
            access,
            ...(Number.isInteger(personalDetailsId) ? { personalDetailsId } : {}),
            ...(session_id ? { session_id } : {})
        };
    } catch {
        return null;
    }
}

/** Attach req.user when a valid token is sent; does not block public routes. */
export function attachUserFromToken(req, _res, next) {
    const user = resolveUserFromToken(extractToken(req));
    if (user != null) {
        req.user = {
            ...(req.user || {}),
            id: user.id,
            access: user.access,
            ...(user.username ? { username: user.username } : {}),
            ...(user.personalDetailsId ? { personalDetailsId: user.personalDetailsId } : {}),
            ...(user.session_id ? { session_id: user.session_id } : {}),
        };
    }
    next();
}

/** Reject requests without a valid token (use on protected routes only). */
export function requireAuth(req, res, next) {
    const token = extractToken(req);
    if (!token) {
        return res.status(401).json({ message: 'No token provided' });
    }

    const user = resolveUserFromToken(token);
    if (user == null) {
        return res.status(401).json({ message: 'Invalid token' });
    }

    req.user = {
        id: user.id,
        access: user.access,
        ...(user.username ? { username: user.username } : {}),
        ...(user.personalDetailsId ? { personalDetailsId: user.personalDetailsId } : {}),
        ...(user.session_id ? { session_id: user.session_id } : {}),
    };
    next();
}

export { requireAuth as authMiddleware };

export const checkAuthorizationHeader = (req, res, next) => {
    const authorization = req.headers.authorization;

    if (!authorization) {
        return res.status(401).json({
            success: false,
            message: "Authorization header is required"
        });
    }

    next();
};