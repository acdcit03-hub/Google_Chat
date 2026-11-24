import express from 'express';
import jwt from "jsonwebtoken";
import { generateTestToken, requestPasswordReset, resendOTP, resetPassword, setPassword, verifyResetOTP } from '../../controllers/Auth/reset.controller.js';

const router = express.Router();

router.post("/set-password", setPassword);
router.post('/request-reset', requestPasswordReset);
router.post("/resend-otp", resendOTP);
router.post("/verify-otp", verifyResetOTP);
router.post('/reset-password', resetPassword);

router.get("/test-token", generateTestToken);

export default router;
