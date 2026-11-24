import {
    expireStaleUserSessionsModel,
    getOfflineUsersModel,
    getOnlineStatusCountsModel,
    getOnlineUsersModel,
    logoutUserSessionModel,
    touchUserSessionModel,
    getClientEnvironment
} from "../../models/users/userSession.model.js";

function resolveSessionId(req) {
    const fromToken = req.user?.session_id;
    if (fromToken) return String(fromToken).trim();

    const fromBody = req.body?.session_id;
    if (fromBody) return String(fromBody).trim();

    const fromHeader = req.headers["x-session-id"];
    if (fromHeader) return String(fromHeader).trim();

    return "";
}

function resolveUserId(req) {
    const personalDetailsId = req.user?.personalDetailsId;
    if (Number.isInteger(personalDetailsId)) return personalDetailsId;
    return null;
}

export const heartbeatUserSession = async (req, res) => {
    try {
        const user_id = resolveUserId(req);
        const session_id = resolveSessionId(req);

        if (!user_id || !session_id) {
            return res.status(400).json({
                success: false,
                message: "Valid session is required"
            });
        }

        const { operating_system, browser_name } = getClientEnvironment(
            req.headers["user-agent"]
        );

        const session = await touchUserSessionModel({
            session_id,
            user_id,
            operating_system,
            browser_name
        });

        if (!session) {
            return res.status(404).json({
                success: false,
                message: "Active session not found"
            });
        }

        return res.status(200).json({
            success: true,
            message: "Heartbeat updated successfully",
            data: {
                session_id: session.session_id,
                last_seen_at: session.last_seen_at,
                is_online: true
            }
        });
    } catch (error) {
        console.error("Heartbeat session error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to update heartbeat",
            error: error.message
        });
    }
};

export const logoutUserSession = async (req, res) => {
    try {
        const user_id = resolveUserId(req);
        const session_id = resolveSessionId(req);

        if (!user_id || !session_id) {
            return res.status(400).json({
                success: false,
                message: "Valid session is required"
            });
        }

        const session = await logoutUserSessionModel({ session_id, user_id });

        if (!session) {
            return res.status(404).json({
                success: false,
                message: "Active session not found"
            });
        }

        return res.status(200).json({
            success: true,
            message: "Logged out successfully",
            data: {
                session_id: session.session_id,
                last_logout_at: session.last_logout_at,
                is_online: false
            }
        });
    } catch (error) {
        console.error("Logout session error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to logout",
            error: error.message
        });
    }
};

export const getOnlineStatus = async (req, res) => {
    try {
        await expireStaleUserSessionsModel();
        const data = await getOnlineStatusCountsModel();

        return res.status(200).json({
            success: true,
            message: "Online status fetched successfully",
            data: {
                total_users: data?.total_users ?? 0,
                online_users: data?.online_users ?? 0,
                offline_users: data?.offline_users ?? 0
            }
        });
    } catch (error) {
        console.error("Get online status error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch online status",
            error: error.message
        });
    }
};

export const getOnlineUsers = async (req, res) => {
    try {
        const filters = {
            name: req.query.name,
            browser_name: req.query.browser_name,
            operating_system: req.query.operating_system,
            work_location: req.query.work_location
        };
        const statuses = [...new Set(
            (Array.isArray(req.query.status) ? req.query.status : [req.query.status])
                .filter(value => value != null && String(value).trim() !== "")
                .flatMap(value => String(value).split(","))
                .map(value => value.trim().toLowerCase())
                .filter(Boolean)
        )];
        const invalidStatus = statuses.find(value => !["online", "offline"].includes(value));

        if (invalidStatus) {
            return res.status(400).json({
                success: false,
                message: "status must be online or offline"
            });
        }

        const includeOnline = !statuses.length || statuses.includes("online");
        const includeOffline = !statuses.length || statuses.includes("offline");
        const paginationEnabled = String(req.query.pagination ?? "true").toLowerCase() !== "false";
        const pageNumber = Number(req.query.page ?? 1);
        const limitNumber = Number(req.query.limit ?? 20);

        if (paginationEnabled) {
            if (!Number.isInteger(pageNumber) || pageNumber <= 0) {
                return res.status(400).json({
                    success: false,
                    message: "page must be a positive integer"
                });
            }

            if (!Number.isInteger(limitNumber) || limitNumber <= 0) {
                return res.status(400).json({
                    success: false,
                    message: "limit must be a positive integer"
                });
            }
        }

        await expireStaleUserSessionsModel();
        const [users, offlineUsers] = await Promise.all([
            includeOnline ? getOnlineUsersModel(filters) : [],
            includeOffline ? getOfflineUsersModel(filters) : []
        ]);

        const data = [
            ...users.map(user => ({ ...user, status: "online" })),
            ...offlineUsers.map(user => ({ ...user, status: "offline" }))
        ];
        const total = data.length;
        const pageData = paginationEnabled
            ? data.slice((pageNumber - 1) * limitNumber, pageNumber * limitNumber)
            : data;

        return res.status(200).json({
            success: true,
            message: "Users fetched successfully",
            total_users: total,
            online_users: users.length,
            offline_count: offlineUsers.length,
            data: pageData,
            pagination: paginationEnabled
                ? {
                    enabled: true,
                    total,
                    page: pageNumber,
                    limit: limitNumber,
                    totalPages: limitNumber > 0 ? Math.ceil(total / limitNumber) : 0
                }
                : {
                    enabled: false
                }
        });
    } catch (error) {
        console.error("Get online users error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch online users",
            error: error.message
        });
    }
};

export function startUserSessionExpiryCheck() {
    const run = async () => {
        try {
            await expireStaleUserSessionsModel();
        } catch (error) {
            console.error("User session expiry check error:", error);
        }
    };

    void run();
    setInterval(run, 15000);
}
