import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const PLACEHOLDER_HOSTS = new Set(["your-pos-api.onrender.com"]);

const parseHttpsUrl = (value) => {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname ||
        url.username || url.password || url.search || url.hash ||
        PLACEHOLDER_HOSTS.has(url.hostname.toLowerCase())) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
};

export const getVercelDeploymentErrors = (apiUrl, vercelConfig) => {
  const errors = [];
  const normalizedApiUrl = apiUrl?.trim();
  if (!normalizedApiUrl) {
    errors.push("Set VITE_API_URL to an HTTPS API base ending in /api, or use /api with valid proxy rewrites.");
    return errors;
  }

  if (normalizedApiUrl.startsWith("/")) {
    if (normalizedApiUrl !== "/api") {
      errors.push("Relative VITE_API_URL must be exactly /api.");
      return errors;
    }

    const rewrites = Array.isArray(vercelConfig?.rewrites) ? vercelConfig.rewrites : [];
    const apiRewrite = rewrites.find((rewrite) => rewrite.source === "/api/:match*");
    const socketRewrite = rewrites.find((rewrite) => rewrite.source === "/socket.io/:match*");
    const apiDestination = parseHttpsUrl(apiRewrite?.destination || "");
    const socketDestination = parseHttpsUrl(socketRewrite?.destination || "");
    if (!apiDestination || !apiDestination.pathname.endsWith("/api/:match*")) {
      errors.push("Configure the /api Vercel rewrite to a real HTTPS backend URL ending in /api/:match*.");
    }
    if (!socketDestination || !socketDestination.pathname.endsWith("/socket.io/:match*")) {
      errors.push("Configure the /socket.io Vercel rewrite to a real HTTPS backend URL ending in /socket.io/:match*.");
    }
    if (apiDestination && socketDestination &&
        apiDestination.origin !== socketDestination.origin) {
      errors.push("The /api and /socket.io Vercel rewrites must target the same backend origin.");
    }
    return errors;
  }

  const apiDestination = parseHttpsUrl(normalizedApiUrl);
  if (!apiDestination || !apiDestination.pathname.replace(/\/+$/, "").endsWith("/api")) {
    errors.push("VITE_API_URL must be a real HTTPS API base URL ending in /api (for example, https://pos-api.example.com/api).");
  }
  return errors;
};

const verifyVercelDeployment = async () => {
  let vercelConfig;
  try {
    vercelConfig = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  } catch (error) {
    console.error("Unable to read or parse vercel.json:", error);
    process.exitCode = 1;
    return;
  }

  const errors = getVercelDeploymentErrors(process.env.VITE_API_URL, vercelConfig);
  if (errors.length > 0) {
    console.error(`Invalid Vercel API configuration:\n${errors.map((error) => `- ${error}`).join("\n")}`);
    process.exitCode = 1;
    return;
  }
  console.log("Vercel API configuration verified.");
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await verifyVercelDeployment();
}
