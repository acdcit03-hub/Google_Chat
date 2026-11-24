import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import {
    getOnlineStatus,
    getOnlineUsers,
    heartbeatUserSession,
    logoutUserSession
} from "../../controllers/users/userSession.controller.js";

const router = express.Router();

router.post("/logout", requireAuth, logoutUserSession);
router.post("/heartbeat", requireAuth, heartbeatUserSession);
router.get("/online-status", requireAuth, getOnlineStatus);
router.get("/online", requireAuth, getOnlineUsers);

export default router;
