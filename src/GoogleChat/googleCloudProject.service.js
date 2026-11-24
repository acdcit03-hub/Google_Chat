
import { google } from "googleapis";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { randomBytes } from "crypto";
import { fileURLToPath } from "url";
import SettingModel from "../models/settings/setting.model.js";

// Load the .env file from the backend root directory.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ENV_PATH = path.resolve(__dirname, "../../.env");

const envResult = dotenv.config({ path: ENV_PATH });

if (envResult.error && envResult.error.code !== "ENOENT") {
  console.error("Unable to load .env file:", ENV_PATH);
  throw envResult.error;
}

// Read environment variables only AFTER dotenv.config().
let PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT_ID?.trim();
const PROJECT_NAME = "ERp-Google-Chat";
const PROJECT_ID_BASE = "google-chat";

const SERVICE_ACCOUNT_FILE = path.resolve(
  __dirname,
  "../../",
  process.env.GOOGLE_SERVICE_ACCOUNT_FILE ||
    "credentials/google-service-account.json"
);
const SERVICE_ACCOUNT_JSON =
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();

const RESOURCE_MANAGER_URL =
  "https://cloudresourcemanager.googleapis.com/v3";

const SERVICE_USAGE_URL =
  "https://serviceusage.googleapis.com/v1";

const delay = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

const generateProjectId = () => {
  return `${PROJECT_ID_BASE}-${randomBytes(6).toString("hex")}`;
};

const persistProjectId = (projectId) => {
  process.env.GOOGLE_CLOUD_PROJECT_ID = projectId;
  PROJECT_ID = projectId;
  if (!fs.existsSync(ENV_PATH)) {
    return;
  }

  let envContents = fs.readFileSync(ENV_PATH, "utf8");
  const projectIdLine =
    /^[ \t]*(?:export[ \t]+)?GOOGLE_CLOUD_PROJECT_ID[ \t]*=.*$/gm;

  if (projectIdLine.test(envContents)) {
    projectIdLine.lastIndex = 0;
    envContents = envContents.replace(
      projectIdLine,
      `GOOGLE_CLOUD_PROJECT_ID=${projectId}`
    );
  } else {
    if (envContents && !envContents.endsWith("\n")) {
      envContents += "\n";
    }

    envContents += `GOOGLE_CLOUD_PROJECT_ID=${projectId}\n`;
  }

  fs.writeFileSync(ENV_PATH, envContents, "utf8");
  process.env.GOOGLE_CLOUD_PROJECT_ID = projectId;
  PROJECT_ID = projectId;
};

// Validate configuration.
const validateConfiguration = () => {
  if (!SERVICE_ACCOUNT_JSON && !fs.existsSync(SERVICE_ACCOUNT_FILE)) {
    throw new Error(
      `Set GOOGLE_SERVICE_ACCOUNT_JSON in .env or provide a service account file at: ${SERVICE_ACCOUNT_FILE}`
    );
  }
};

// Authenticate using service account.
const getGoogleCloudClient = async () => {
  validateConfiguration();

  if (SERVICE_ACCOUNT_JSON) {
    let credentials;

    try {
      credentials = JSON.parse(SERVICE_ACCOUNT_JSON);
    } catch {
      throw new Error(
        "GOOGLE_SERVICE_ACCOUNT_JSON must contain valid service-account JSON."
      );
    }

    if (
      !credentials ||
      typeof credentials !== "object" ||
      !credentials.client_email ||
      !credentials.private_key
    ) {
      if (credentials?.web || credentials?.installed) {
        throw new Error(
          "GOOGLE_SERVICE_ACCOUNT_JSON contains an OAuth client configuration, not a service-account key. Create and download a service-account JSON key from Google Cloud Console, then set GOOGLE_SERVICE_ACCOUNT_JSON to that key."
        );
      }

      throw new Error(
        "GOOGLE_SERVICE_ACCOUNT_JSON must be a service-account key containing client_email and private_key."
      );
    }

    credentials.private_key = String(credentials.private_key).replace(
      /\\n/g,
      "\n"
    );

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: [
        "https://www.googleapis.com/auth/cloud-platform"
      ]
    });

    return auth.getClient();
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: SERVICE_ACCOUNT_FILE,
    scopes: [
      "https://www.googleapis.com/auth/cloud-platform"
    ]
  });

  return auth.getClient();
};

// Wait for Google long-running operations.
const waitForOperation = async (
  client,
  baseUrl,
  apiVersion,
  operationName,
  maxAttempts = 90
) => {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await client.request({
      url: `${baseUrl}/${apiVersion}/${operationName}`,
      method: "GET"
    });

    const operation = response.data;

    if (operation.done) {
      if (operation.error) {
        throw new Error(
          operation.error.message ||
          "Google Cloud operation failed."
        );
      }

      return operation.response || operation;
    }

    await delay(2000);
  }

  throw new Error(
    `Google operation timed out: ${operationName}`
  );
};

const getProjectById = async (client, projectId) => {
  try {
    const response = await client.request({
      url:
        `${RESOURCE_MANAGER_URL}/projects/` +
        encodeURIComponent(projectId),
      method: "GET"
    });

    return response.data;
  } catch (error) {
    if (error.response?.status === 404) {
      return null;
    }

    throw error;
  }
};

const findExistingProjectByName = async (client) => {
  const projects = [];
  let pageToken;

  do {
    const response = await client.request({
      url: `${RESOURCE_MANAGER_URL}/projects:search`,
      method: "GET",
      params: {
        query: "name:ERp*",
        pageSize: 100,
        pageToken
      }
    });

    projects.push(...(response.data.projects || []));
    pageToken = response.data.nextPageToken;
  } while (pageToken);

  const matches = [
    ...new Map(
      projects
        .filter(
          (project) =>
            project.displayName?.toLowerCase() === PROJECT_NAME.toLowerCase() &&
            (project.state || project.lifecycleState) === "ACTIVE"
        )
        .map((project) => [project.projectId, project])
    ).values()
  ];

  if (matches.length > 1) {
    throw new Error(
      `More than one active project is named "${PROJECT_NAME}". Set GOOGLE_CLOUD_PROJECT_ID to one of these IDs: ${matches.map((project) => project.projectId).join(", ")}`
    );
  }

  return matches[0] || null;
};

// Reuse the configured project or create ERp-Google-Chat with a unique ID.
const getOrCreateGoogleCloudProject = async (client) => {
  const savedSetting = await SettingModel.findByKey(
    "google_cloud_project_id"
  );
  const configuredProjectId =
    PROJECT_ID && PROJECT_ID !== PROJECT_ID_BASE
      ? PROJECT_ID
      : null;

  if (configuredProjectId) {
    const project = await getProjectById(client, configuredProjectId);

    if (!project) {
      throw new Error(
        `Configured Google Cloud project ${configuredProjectId} was not found or is not accessible to this Google account.`
      );
    }

    if ((project.state || project.lifecycleState) !== "ACTIVE") {
      throw new Error(
        `Configured Google Cloud project ${configuredProjectId} is not active.`
      );
    }

    if (project.displayName?.toLowerCase() !== PROJECT_NAME.toLowerCase()) {
      throw new Error(
        `Configured project ${configuredProjectId} is not named "${PROJECT_NAME}". Set GOOGLE_CLOUD_PROJECT_ID=${PROJECT_ID_BASE} to create or find the requested project.`
      );
    }

    return { project, created: false };
  }

  const savedProjectId = savedSetting?.value?.trim();
  if (savedProjectId && savedProjectId !== PROJECT_ID_BASE) {
    const savedProject = await getProjectById(client, savedProjectId);
    if (
      savedProject?.displayName?.toLowerCase() ===
        PROJECT_NAME.toLowerCase() &&
      (savedProject.state || savedProject.lifecycleState) === "ACTIVE"
    ) {
      return { project: savedProject, created: false };
    }
  }

  const existingProject = await findExistingProjectByName(client);
  if (existingProject) {
    return { project: existingProject, created: false };
  }

  const parent = process.env.GOOGLE_CLOUD_PARENT?.trim();
  const projectIds = [
    PROJECT_ID_BASE,
    ...Array.from({ length: 3 }, generateProjectId)
  ];

  for (const projectId of projectIds) {
    const body = {
      projectId,
      displayName: PROJECT_NAME
    };

    let createResponse;

    try {
      createResponse = await client.request({
        url: `${RESOURCE_MANAGER_URL}/projects`,
        method: "POST",
        data: parent ? { ...body, parent } : body
      });
    } catch (error) {
      if (error.response?.status !== 409) {
        throw error;
      }

      const conflictingProject = await getProjectById(client, projectId);
      if (
        conflictingProject &&
        conflictingProject?.displayName?.toLowerCase() ===
          PROJECT_NAME.toLowerCase() &&
        (conflictingProject.state || conflictingProject.lifecycleState) ===
          "ACTIVE"
      ) {
        return { project: conflictingProject, created: false };
      }

      continue;
    }

    const operationName = createResponse.data.name;

    if (!operationName) {
      throw new Error(
        "Google did not return a project creation operation."
      );
    }

    await waitForOperation(
      client,
      "https://cloudresourcemanager.googleapis.com",
      "v3",
      operationName
    );

    const finalResponse = await client.request({
      url:
        `${RESOURCE_MANAGER_URL}/projects/` +
        encodeURIComponent(projectId),
      method: "GET"
    });

    if (
      (finalResponse.data.state || finalResponse.data.lifecycleState) !==
        "ACTIVE" ||
      finalResponse.data.displayName?.toLowerCase() !==
        PROJECT_NAME.toLowerCase()
    ) {
      throw new Error(
        `New Google Cloud project was not confirmed as active "${PROJECT_NAME}".`
      );
    }

    return { project: finalResponse.data, created: true };
  }

  throw new Error(
    `Project ID "${PROJECT_ID_BASE}" is unavailable and no unique project ID could be created after 3 attempts.`
  );
};

// Check and enable Google Chat API.
const enableGoogleChatAPI = async (client, projectId) => {
  const serviceUrl =
    `${SERVICE_USAGE_URL}/projects/` +
    `${encodeURIComponent(projectId)}/services/chat.googleapis.com`;

  // Check current status.
  const currentResponse = await client.request({
    url: serviceUrl,
    method: "GET"
  });

  if (currentResponse.data.state === "ENABLED") {
    return {
      service: "chat.googleapis.com",
      enabled: true,
      alreadyEnabled: true
    };
  }

  // Enable Chat API.
  const enableResponse = await client.request({
    url: `${serviceUrl}:enable`,
    method: "POST"
  });

  const operationName = enableResponse.data.name;

  if (operationName && !enableResponse.data.done) {
    await waitForOperation(
      client,
      "https://serviceusage.googleapis.com",
      "v1",
      operationName
    );
  }

  // Verify final status.
  const finalResponse = await client.request({
    url: serviceUrl,
    method: "GET"
  });

  if (finalResponse.data.state !== "ENABLED") {
    throw new Error(
      `Google Chat API was not enabled. State: ${finalResponse.data.state}`
    );
  }

  return {
    service: "chat.googleapis.com",
    enabled: true,
    alreadyEnabled: false
  };
};

// Main setup function.
export const setupGoogleCloudProject = async (authenticatedClient = null) => {
  const client = authenticatedClient || await getGoogleCloudClient();

  // Step 1: Load the saved project, reuse a matching project, or create one.
  const projectResult =
    await getOrCreateGoogleCloudProject(client);

  const projectId =
    projectResult.project.projectId;

  if (!projectId) {
    throw new Error("Google Cloud did not return the Google Chat project ID.");
  }

  persistProjectId(projectId);
  await SettingModel.upsert("google_cloud_project_id", projectId);

  // Step 2: Enable Google Chat API.
  // Service Usage API must already be enabled in the
  // service account's own quota/credential project.
  const chatApi = await enableGoogleChatAPI(
    client,
    projectId
  );

  return {
    projectId,
    projectNumber:
      projectResult.project.projectNumber || null,
    projectName:
      projectResult.project.displayName ||
      projectResult.project.name ||
      PROJECT_NAME,
    projectCreated: projectResult.created,
    projectReused: !projectResult.created,
    chatApi,
    success: true
  };
};
