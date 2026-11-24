
import express from "express";

import {
  startGoogleAuth,
  googleAuthCallback,
  getGoogleAuthController,
  generateGoogleAuthUrl,
  startGoogleCloudProjectOAuth
} from "./generate-google-token.js";

import {
  setupGoogleCloudProjectController,
  openGoogleCloudApisController,
  openGoogleCloudProjectCreateController
} from "./googleCloudProject.controller.js";

const router = express.Router();

router.get("/connect", startGoogleAuth);

router.post("/setup-project", startGoogleCloudProjectOAuth);
router.post("/setup-project/open-apis", openGoogleCloudApisController);
router.post("/setup-project/create-page", openGoogleCloudProjectCreateController);
router.post("/setup-project/automated", setupGoogleCloudProjectController);

router.post("/generate-url", generateGoogleAuthUrl);

router.get("/callback", googleAuthCallback);

router.post("/token", getGoogleAuthController);

export default router;
