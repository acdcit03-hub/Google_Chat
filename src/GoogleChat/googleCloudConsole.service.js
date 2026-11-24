import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import {
  saveGoogleCloudProject,
  saveGoogleTokens
} from "./googleAuth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.resolve(__dirname, "../../.env");
const CLICK_SELECT_PROJECT_SCRIPT = path.join(
  __dirname,
  "clickSelectProject.ps1"
);
const FILL_NEW_PROJECT_FORM_SCRIPT = path.join(
  __dirname,
  "fillNewProjectForm.ps1"
);
const SELECT_CREATED_PROJECT_SCRIPT = path.join(
  __dirname,
  "selectCreatedProject.ps1"
);
const ENABLE_GOOGLE_CHAT_API_SCRIPT = path.join(
  __dirname,
  "enableGoogleChatApi.ps1"
);
const FILL_OAUTH_PLAYGROUND_SCRIPT = path.join(
  __dirname,
  "fillOAuthPlaygroundScopes.ps1"
);
const OAUTH_PLAYGROUND_URL = "https://developers.google.com/oauthplayground/";
const CHAT_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/chat.spaces.readonly",
  "https://www.googleapis.com/auth/chat.spaces.create",
  "https://www.googleapis.com/auth/chat.messages.create",
  "https://www.googleapis.com/auth/chat.memberships"
];
const CHAT_API_LIBRARY_URL =
  "https://console.cloud.google.com/apis/library/chat.googleapis.com";

const PROJECT_CREATE_URL =
  "https://console.cloud.google.com/projectcreate";
const API_DASHBOARD_URL =
  "https://console.cloud.google.com/apis/dashboard";
const WELCOME_URL = "https://console.cloud.google.com/welcome";
const PROJECT_PICKER_URL =
  "https://console.cloud.google.com/projectselector2/home/dashboard";

const GOOGLE_CLOUD_PROJECT_NAME = "Google chat";

const delay = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

const readProjectFormValues = () => {
  const parsed = dotenv.parse(fs.readFileSync(ENV_PATH, "utf8"));
  const projectName = GOOGLE_CLOUD_PROJECT_NAME;
  const projectId = parsed.GOOGLE_CLOUD_PROJECT_ID?.trim();

  if (!projectId) {
    throw new Error(
      "Set GOOGLE_CLOUD_PROJECT_ID in .env."
    );
  }

  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) {
    throw new Error(
      "GOOGLE_CLOUD_PROJECT_ID in .env must be a valid Google Cloud project ID."
    );
  }

  return { projectName, projectId };
};

const runPowerShellFile = (scriptPath, args, timeoutMessage, timeoutMs = 45000) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        ...args
      ],
      { windowsHide: true }
    );

    let errorOutput = "";
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      errorOutput += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(timeoutMessage));
    }, timeoutMs);

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(output);
        return;
      }

      const error = new Error(errorOutput.trim() || timeoutMessage);
      error.stdout = output;
      reject(error);
    });
  });

const readCreatedProject = (output) => {
  const text = String(output || "");
  if (!text.includes("PROJECT_CREATED=1")) {
    return null;
  }

  const match = text.match(
    /PAGE_PROJECT_ID=([a-z][a-z0-9-]{4,28}[a-z0-9])/
  );
  return match?.[1] || null;
};

const accountChooserUrl = (email, continueUrl) => {
  const url = new URL("https://accounts.google.com/AccountChooser");
  url.searchParams.set("Email", email);
  url.searchParams.set("continue", continueUrl);
  return url.toString();
};

const clickSelectProjectButton = () =>
  runPowerShellFile(
    CLICK_SELECT_PROJECT_SCRIPT,
    [],
    "Timed out waiting to open the Select a project dialog."
  );

const selectCreatedProject = (projectName, projectId, sendCtrlO) =>
  runPowerShellFile(
    SELECT_CREATED_PROJECT_SCRIPT,
    [
      "-ProjectName",
      projectName,
      "-ProjectId",
      projectId,
      ...(sendCtrlO ? ["-SendCtrlO"] : [])
    ],
    "Timed out waiting to select the project on the Welcome page."
  );

const fillNewProjectForm = async (projectName, projectId) => {
  try {
    const output = await runPowerShellFile(
      FILL_NEW_PROJECT_FORM_SCRIPT,
      ["-ProjectName", projectName, "-ProjectId", projectId],
      "Timed out waiting to fill the New project form."
    );
    return readCreatedProject(output);
  } catch (error) {
    error.pageProjectId = readCreatedProject(error.stdout);
    throw error;
  }
};

export const openGoogleCloudWelcomePage = async (email) => {
  const { projectName, projectId } = readProjectFormValues();
  const welcomeUrl = accountChooserUrl(email, WELCOME_URL);
  await openGoogleCloudConsolePage(welcomeUrl);

  const picker = new URL(PROJECT_PICKER_URL);
  picker.searchParams.set("supportedpurview", "project");
  picker.searchParams.set("authuser", email);
  const projectPickerUrl = picker.toString();

  await delay(3000);
  await openGoogleCloudConsolePage(projectPickerUrl);
  await clickSelectProjectButton();

  const createPage = new URL(PROJECT_CREATE_URL);
  createPage.searchParams.set("authuser", email);
  const projectCreateUrl = createPage.toString();
  await delay(1000);
  await openGoogleCloudConsolePage(projectCreateUrl);

  let pageProjectId = null;
  try {
    pageProjectId = await fillNewProjectForm(projectName, projectId);
  } catch (error) {
    throw error;
  }

  if (!pageProjectId) {
    throw new Error(
      "Create was not clicked, so the project ID was not stored."
    );
  }

  await saveGoogleCloudProject(email, pageProjectId);
  const storedProjectId = pageProjectId;
  const chatApi = await enableGoogleChatApiInConsole(email, storedProjectId);

  return {
    welcomeUrl,
    projectPickerUrl,
    projectCreateUrl,
    projectName,
    projectId: storedProjectId,
    apisUrl: chatApi.url,
    chatApiStatus: chatApi.status
  };
};

export const openWelcomePage = (email) => {
  const welcomeUrl = accountChooserUrl(email, WELCOME_URL);
  return openGoogleCloudConsolePage(welcomeUrl);
};

export const clickWelcomeProjectChip = () =>
  runPowerShellFile(
    SELECT_CREATED_PROJECT_SCRIPT,
    ["-ChipOnly"],
    "Timed out waiting to open the project picker."
  );

export const openGoogleCloudProjectCreatePage = () =>
  openGoogleCloudConsolePage(PROJECT_CREATE_URL);

const readChatApiStatus = (output) => {
  const text = String(output || "");
  if (text.includes("CHAT_API_ALREADY_ENABLED=1")) {
    return "already-enabled";
  }
  if (text.includes("CHAT_API_ENABLED=1")) {
    return "enabled";
  }
  return null;
};

export const enableGoogleChatApiInConsole = async (email, projectId) => {
  const libraryUrl = new URL(CHAT_API_LIBRARY_URL);
  libraryUrl.searchParams.set("project", projectId);
  const url = await openGoogleCloudConsolePage(
    accountChooserUrl(email, libraryUrl.toString())
  );

  await delay(1500);
  const output = await runPowerShellFile(
    ENABLE_GOOGLE_CHAT_API_SCRIPT,
    [],
    "Timed out waiting to enable the Google Chat API."
  );
  const status = readChatApiStatus(output);
  if (!status) {
    throw new Error("Google Chat API was not enabled.");
  }

  return { url, status, projectId };
};

export const fillOAuthPlaygroundScopes = async (email) => {
  await openGoogleCloudConsolePage(OAUTH_PLAYGROUND_URL);
  await delay(1500);
  const output = await runPowerShellFile(
    FILL_OAUTH_PLAYGROUND_SCRIPT,
    ["-Scopes", CHAT_OAUTH_SCOPES.join(" "), "-Email", email],
    "Timed out waiting to store the refresh token.",
    100000
  );

  const text = String(output || "");
  if (!text.includes("AUTHORIZE_CLICKED=1")) {
    throw new Error("Authorize APIs was not clicked.");
  }
  if (!text.includes("ACCOUNT_SELECTED=1")) {
    throw new Error("The payload email was not selected on the Google account page.");
  }
  if (!text.includes("CONSENT_CONTINUED=1")) {
    throw new Error("Select all or Continue was not completed.");
  }

  const encoded = text.match(/REFRESH_TOKEN_B64=([A-Za-z0-9+/=]+)/)?.[1];
  const refreshToken = encoded
    ? Buffer.from(encoded, "base64").toString("utf8").trim()
    : "";
  const refreshExpiresIn = Number(text.match(/REFRESH_EXPIRES_IN=(\d+)/)?.[1]);
  if (!refreshToken.startsWith("1//") || !Number.isFinite(refreshExpiresIn) || refreshExpiresIn <= 0) {
    throw new Error("The refresh token was not stored.");
  }

  await saveGoogleTokens(email, {
    refresh_token: refreshToken,
    scope: CHAT_OAUTH_SCOPES.join(" "),
    refresh_token_expires_in: refreshExpiresIn
  });

  return {
    url: OAUTH_PLAYGROUND_URL,
    scopes: CHAT_OAUTH_SCOPES,
    refreshTokenStored: true,
    refreshTokenExpiresIn: refreshExpiresIn,
    refreshTokenExpiresAt: new Date(Date.now() + refreshExpiresIn * 1000).toISOString()
  };
};

export const openGoogleCloudApisPage = (projectId, email) => {
  const url = new URL(API_DASHBOARD_URL);
  url.searchParams.set("project", projectId);
  const dashboardUrl = email
    ? accountChooserUrl(email, url.toString())
    : url.toString();

  return openGoogleCloudConsolePage(dashboardUrl);
};

export const openGoogleCloudConsolePage = (url) => {
  if (process.platform !== "win32") {
    throw new Error(
      "Opening Google Cloud Console from the API is supported only on Windows."
    );
  }

  const parsedUrl = new URL(url);
  const allowedHosts = new Set([
    "accounts.google.com",
    "console.cloud.google.com",
    "developers.google.com"
  ]);
  if (parsedUrl.protocol !== "https:" || !allowedHosts.has(parsedUrl.hostname)) {
    throw new Error("Only Google Cloud Console, Google sign-in, and OAuth Playground URLs can be opened.");
  }

  return new Promise((resolve, reject) => {
    const browser = spawn(
      "rundll32.exe",
      ["url.dll,FileProtocolHandler", parsedUrl.toString()],
      { detached: true, stdio: "ignore" }
    );

    browser.once("error", reject);
    browser.once("spawn", () => {
      browser.unref();
      resolve(parsedUrl.toString());
    });
  });
};
