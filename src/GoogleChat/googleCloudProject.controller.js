
import {
  setupGoogleCloudProject
} from "./googleCloudProject.service.js";
import {
  openGoogleCloudApisPage,
  openGoogleCloudProjectCreatePage
} from "./googleCloudConsole.service.js";

const isLocalRequest = (req) => {
  const address = (req.socket.remoteAddress || "").replace(
    /^::ffff:/,
    ""
  );

  return address === "127.0.0.1" || address === "::1";
};

const rejectNonLocalRequest = (req, res) => {
  if (isLocalRequest(req)) {
    return false;
  }

  res.status(403).json({
    success: false,
    message: "Google Cloud Console can only be opened by a local API request."
  });
  return true;
};

export const openGoogleCloudProjectCreateController = async (req, res) => {
  if (rejectNonLocalRequest(req, res)) {
    return;
  }

  try {
    const url = await openGoogleCloudProjectCreatePage();

    return res.status(200).json({
      success: true,
      message:
        "Google Cloud project creation opened in the default browser. Sign in, create the project, and note its project ID.",
      data: {
        url,
        nextEndpoint: "/auth/google/setup-project/open-apis"
      }
    });
  } catch (error) {
    console.error("Unable to open Google Cloud project creation:", error);

    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

export const openGoogleCloudApisController = async (req, res) => {
  if (rejectNonLocalRequest(req, res)) {
    return;
  }

  const projectId = String(req.body?.projectId || "").trim();

  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) {
    return res.status(400).json({
      success: false,
      message: "Provide a valid Google Cloud project ID."
    });
  }

  try {
    const url = await openGoogleCloudApisPage(projectId);

    return res.status(200).json({
      success: true,
      message:
        "Google Cloud APIs & Services opened in the default browser for the selected project.",
      data: { projectId, url }
    });
  } catch (error) {
    console.error("Unable to open Google Cloud APIs & Services:", error);

    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

export const setupGoogleCloudProjectController = async (req, res) => {
  try {
    const result = await setupGoogleCloudProject();

    return res.status(200).json({
      success: true,
      message: result.projectCreated
        ? "Google Cloud project created, its ID saved in the database, and Google Chat API enabled successfully."
        : "Existing Google Cloud project selected, its ID saved in the database, and Google Chat API enabled successfully.",
      data: result
    });

  } catch (error) {
    console.error(
      "Google Cloud project setup error:",
      error.response?.data || error.message
    );

    return res.status(500).json({
      success: false,
      message:
        error.response?.data?.error?.message ||
        error.message
    });
  }
};
