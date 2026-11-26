import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { linkStaticExecutable } from "./helpers.mjs";

const FAKE_ANTIGRAVITY_FIXTURE = fileURLToPath(new URL("./fixtures/fake-antigravity.mjs", import.meta.url));

// A real stdio peer exercises framing, bidirectional requests and process
// ownership without installing agy or touching the user's Google credentials.
export function installFakeAntigravity(directory, options = {}) {
  const { behavior = "normal", version = "1.5.16", serverRequests = [], mcpPermissionRequests = [], turnUpdates = null, loadPermission, promptUsage,
    modelIds, currentModel, currentEffort, sessionGate, promptGate } = typeof options === "string" ? { behavior: options } : options;
  fs.mkdirSync(directory, { recursive: true });
  const statePath = path.join(directory, "antigravity-state.json");
  const script = path.join(directory, "fake-agy.mjs");
  fs.writeFileSync(statePath, JSON.stringify({ requests: [], serverResponses: [], sessions: [], launches: [], nextSession: 1 }));
  const config = { statePath, behavior, version, serverRequests, mcpPermissionRequests, turnUpdates, loadPermission, promptUsage, modelIds, currentModel, currentEffort, sessionGate, promptGate };
  fs.writeFileSync(path.join(directory, "antigravity-config.json"), JSON.stringify(config), "utf8");
  linkStaticExecutable(script, FAKE_ANTIGRAVITY_FIXTURE, { rewriteShebang: true });
  let binary = script;
  if (process.platform === "win32") {
    binary = path.join(directory, "agy.cmd");
    fs.writeFileSync(binary, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  }
  const state = () => JSON.parse(fs.readFileSync(statePath, "utf8"));
  return { binary, script, statePath, state, requests: () => state().requests };
}
