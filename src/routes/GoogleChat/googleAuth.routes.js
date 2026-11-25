import express from "express";
import {
    googleAuthCallback,
    startGoogleCloudProjectOAuth
} from "../../controllers/GoogleChat/googleAuth.controller.js";
import {
    createGoogleChatSpace,
    openEmployeeGoogleChat
} from "../../controllers/GoogleChat/googleChat.controller.js";

const router = express.Router();

// Opens Google Allow page for an employee username and saves the refresh token after Allow.
router.post("/setup-project", startGoogleCloudProjectOAuth);

// Google returns here after Allow. Saves the refresh token for that work email.
router.get("/callback", googleAuthCallback);

// Opens or creates a named Google Chat space and syncs the member list.
router.post("/create-google-chat-space", createGoogleChatSpace);

// Opens or creates a direct message between from_username and to_username.
router.post("/open-employee-google-chat", openEmployeeGoogleChat);

export default router;
