import { spawn } from "child_process";

const API_DASHBOARD_URL =
  "https://console.cloud.google.com/apis/dashboard";
const PROJECT_CREATE_URL =
  "https://console.cloud.google.com/projectcreate";

const accountChooserUrl = (email, continueUrl) => {
  const url = new URL("https://accounts.google.com/AccountChooser");
  url.searchParams.set("Email", email);
  url.searchParams.set("continue", continueUrl);
  return url.toString();
};

export const openGoogleCloudProjectCreatePage = () =>
  openGoogleCloudConsolePage(PROJECT_CREATE_URL);

export const openGoogleCloudApisPage = (projectId, email) => {
  const url = new URL(API_DASHBOARD_URL);
  url.searchParams.set("project", projectId);
  const dashboardUrl = email
    ? accountChooserUrl(email, url.toString())
    : url.toString();

  return openGoogleCloudConsolePage(dashboardUrl);
};

export const openGoogleCloudConsolePage = (url) => {
  const parsedUrl = new URL(url);
  const allowedHosts = new Set([
    "accounts.google.com",
    "console.cloud.google.com"
  ]);
  if (parsedUrl.protocol !== "https:" || !allowedHosts.has(parsedUrl.hostname)) {
    throw new Error("Only Google Cloud Console and Google sign-in URLs can be opened.");
  }

  const command =
    process.platform === "win32"
      ? { file: "rundll32.exe", args: ["url.dll,FileProtocolHandler", parsedUrl.toString()] }
      : process.platform === "darwin"
        ? { file: "open", args: [parsedUrl.toString()] }
        : { file: "xdg-open", args: [parsedUrl.toString()] };

  return new Promise((resolve, reject) => {
    const browser = spawn(command.file, command.args, {
      detached: true,
      stdio: "ignore"
    });
    browser.once("error", reject);
    browser.once("spawn", () => {
      browser.unref();
      resolve(parsedUrl.toString());
    });
  });
};
