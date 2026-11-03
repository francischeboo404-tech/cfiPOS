import assert from "node:assert/strict";
import test from "node:test";
import { getVercelDeploymentErrors } from "./verify-vercel-env.mjs";

const proxyConfig = {
  rewrites: [
    { source: "/api/:match*", destination: "https://pos-api.example.com/api/:match*" },
    { source: "/socket.io/:match*", destination: "https://pos-api.example.com/socket.io/:match*" },
  ],
};

test("Vercel verification requires a configured API URL", () => {
  assert.match(getVercelDeploymentErrors(undefined, proxyConfig).join(" "), /Set VITE_API_URL/);
});

test("Vercel verification accepts HTTPS direct API URLs ending in /api", () => {
  assert.deepEqual(
    getVercelDeploymentErrors("https://pos-api.example.com/api", {}),
    [],
  );
});

test("Vercel verification rejects invalid, insecure, and placeholder API URLs", () => {
  for (const url of [
    "http://pos-api.example.com/api",
    "not a URL",
    "https://your-pos-api.onrender.com/api",
    "https://pos-api.example.com",
  ]) {
    assert.notDeepEqual(getVercelDeploymentErrors(url, {}), [], url);
  }
});

test("Vercel proxy configuration accepts /api only with real API and Socket.IO rewrites", () => {
  assert.deepEqual(getVercelDeploymentErrors("/api", proxyConfig), []);
  assert.match(
    getVercelDeploymentErrors("/api", {
      rewrites: [
        { source: "/api/:match*", destination: "https://your-pos-api.onrender.com/api/:match*" },
        { source: "/socket.io/:match*", destination: "https://pos-api.example.com/socket.io/:match*" },
      ],
    }).join(" "),
    /real HTTPS backend URL/,
  );
});
