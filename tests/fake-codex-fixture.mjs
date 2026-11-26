import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { fileURLToPath } from "node:url";

import { linkStaticExecutable, writeExecutable } from "./helpers.mjs";

const FAKE_CODEX_FIXTURE = fileURLToPath(new URL("./fixtures/fake-codex.cjs", import.meta.url));
const CONFIG_BLOCK_RE = /\/\/ __FAKE_CODEX_CONFIG_START__[\s\S]*?\/\/ __FAKE_CODEX_CONFIG_END__/;
let fakeCodexTemplate = null;

export function installFakeCodex(binDir, behavior = "review-ok", { mutable = false } = {}) {
  const statePath = path.join(binDir, "fake-codex-state.json");
  const scriptPath = path.join(binDir, "codex");
  const configPath = path.join(binDir, "fake-codex-config.json");
  if (mutable) {
    fakeCodexTemplate ??= fs.readFileSync(FAKE_CODEX_FIXTURE, "utf8");
    const replacement = `\tconst STATE_PATH = ${JSON.stringify(statePath)};\n\tconst BEHAVIOR = ${JSON.stringify(behavior)};`;
    const source = fakeCodexTemplate.replace(CONFIG_BLOCK_RE, () => replacement);
    fs.rmSync(configPath, { force: true });
    fs.rmSync(scriptPath, { force: true });
    writeExecutable(scriptPath, source);
  } else {
    fs.writeFileSync(configPath, JSON.stringify({ statePath, behavior }), "utf8");
    linkStaticExecutable(scriptPath, FAKE_CODEX_FIXTURE);
  }

  // On Windows, npm global binaries are invoked via .cmd wrappers.
  // Create a codex.cmd so the fake binary is discoverable by spawn with shell: true.
  if (process.platform === "win32") {
    const cmdWrapper = `@echo off\r\nnode "%~dp0codex" %*\r\n`;
    fs.writeFileSync(path.join(binDir, "codex.cmd"), cmdWrapper, { encoding: "utf8" });
  }
}

export function buildEnv(binDir) {
  const sep = process.platform === "win32" ? ";" : ":";
  return {
    ...process.env,
    HOME: path.join(binDir, "fixture-home"),
    USERPROFILE: path.join(binDir, "fixture-home"),
    CODEX_HOME: path.join(binDir, "fixture-home", ".codex"),
    CODEX_SQLITE_HOME: "",
    // Job state lives in the isolated home, so helper processes share the test
    // process's isolated home unless a fixture selects its own.
    CODEX_COMPANION_HOME: process.env.CODEX_COMPANION_HOME ?? "",
    CODEX_COMPANION_NORMAL_HOME: "",
    CODEX_COMPANION_NORMAL_SQLITE_HOME: "",
    CODEX_COMPANION_BIN: "",
    CODEX_COMPANION_APP_SERVER_ENDPOINT: "",
    CODEX_COMPANION_SESSION_ID: "",
    PATH: `${binDir}${sep}${process.env.PATH}`
  };
}

// Shared process/CLI fixture for lifecycle contracts across existing modules.
export async function lifecycleHarness() {
  const { default: assert } = await import("node:assert/strict");
const { default: fs } = await import("node:fs");
const { default: path } = await import("node:path");


const { makeTempDir, initGitRepo, run, requireLocalSockets } = await import("./helpers.mjs");

const { browserOriginSetup, transportSetup } = await import("../plugins/codex/scripts/lib/setup-config.mjs");
const { resolveIsolatedCodexHome } = await import("../plugins/codex/scripts/lib/codex-home.mjs");
const { redactActivity, itemActivity, planActivity, activityReader, formatActivity } = await import("../plugins/codex/scripts/lib/activity.mjs");
const { writeJobFile, upsertJob, updateJob, readJobFile, resolveJobFile, resolveStateDir } = await import("../plugins/codex/scripts/lib/state.mjs");
const { JobRuntime, pauseAdjustment, renewLease, markOwnerAttachment, leaseSnapshot, questionMessage, adoptJob, ownershipNotice, answerQuestion, askParentQuestion, ownerLost, directReport, progressSnapshot, PARENT_BRIDGE_ENV } = await import("../plugins/codex/scripts/lib/job-runtime.mjs");
const { buildWorkerReport } = await import("../plugins/codex/scripts/lib/worker-report.mjs");
const { resolveSessionMarkersRoot } = await import("../plugins/codex/scripts/lib/session-markers.mjs");
const { AGENT_NAMES, pickAgentName } = await import("../plugins/codex/scripts/lib/agent-names.mjs");
const { splitRawArgumentString } = await import("../plugins/codex/scripts/lib/args.mjs");
const bridgeScript = new URL("../plugins/codex/scripts/parent-bridge-mcp.mjs", import.meta.url).pathname;
const { spawnOwned } = await import("../plugins/codex/scripts/lib/process.mjs");
const script = new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url).pathname;
const hook = new URL("../plugins/codex/scripts/session-lifecycle-hook.mjs", import.meta.url).pathname;
const brokerScript = new URL("../plugins/codex/scripts/app-server-broker.mjs", import.meta.url).pathname;
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };
function fixture(behavior = "w5-working", options) {
  const dir = makeTempDir(), repo = path.join(dir, "repo"); fs.mkdirSync(repo); initGitRepo(repo); installFakeCodex(dir, behavior, options);
  const env = { ...buildEnv(dir), CLAUDE_PLUGIN_DATA: path.join(dir, "data"), CODEX_COMPANION_SESSION_ID: "fixture-session", CODEX_COMPANION_HOME: path.join(dir, "isolated") };
  return { dir, repo, env, call: (...args) => run(process.execPath, [script, ...args], { cwd: repo, env }), state: () => JSON.parse(fs.readFileSync(path.join(dir, "fake-codex-state.json"))), requests: () => fs.readFileSync(path.join(dir, "fake-codex-state.json.requests.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)), answer: (job, id, text) => run(process.execPath, [script, "answer", job, "--question", id, "--json"], { cwd: repo, env, input: text }) };
}
function json(result, code = 0) { assert.equal(result.status, code, result.stderr + result.stdout); return JSON.parse(result.stdout); }
function directLines(stdout) {
  assert.ok(stdout.endsWith("\n"), "stdout ends with a newline");
  const lines = stdout.slice(0, -1).split("\n");
  assert.equal(lines.at(-1), JSON.stringify(JSON.parse(lines.at(-1))), "last line is compact JSON");
  for (const line of lines.slice(0, -1)) {
    // Codex messages may carry up to 600 characters after their prefix; other progress stays within 200.
    assert.ok(line.length > 0 && line.length <= (/^\[\d+\] Codex: /.test(line) ? 600 + line.indexOf("Codex: ") + 7 : 200), "progress is compact and single-line");
    assert.ok(!line.startsWith("{"), "progress cannot be mistaken for JSON");
    assert.doesNotMatch(line, /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/, "progress has no terminal controls or embedded newlines");
  }
  return lines;
}
function direct(result, code = 0) {
  const payload = json({ ...result, stdout: directLines(result.stdout).at(-1) }, code);
  for (const key of ["activity", "activityOmitted", "cursor", "startupTimings", "currentItem", "completedItems", "questionMessage"]) assert.equal(Object.hasOwn(payload, key), false, key);
  return payload;
}
function directError(result) {
  const payload = json(result, 1);
  assert.equal(result.stdout.split("\n").length, 2, "exactly one error JSON line");
  assert.deepEqual(Object.keys(payload), ["status", "worker", "jobId", "summary", "next", "details"]);
  assert.equal(payload.status, "error"); assert.equal(typeof payload.summary, "string"); assert.ok(payload.summary.length);
  assert.equal(result.stderr, `${payload.summary}\n`);
  return payload;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitUntil(fn) { for (const end = Date.now() + 60000; Date.now() < end;) { const result = fn(); if (result) return result; await delay(80); } throw new Error("Fixture deadline expired"); }
function patchJob(f, id, patch) {
  const module = new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url).href;
  const result = run(process.execPath, ["--input-type=module", "-e", `import { updateJob } from ${JSON.stringify(module)}; updateJob(process.cwd(), ${JSON.stringify(id)}, () => (${JSON.stringify(patch)}));`], { cwd: f.repo, env: f.env });
  assert.equal(result.status, 0, result.stderr);
}
function job(f, id) { return json(f.call("status", id, "--json")).job; }

return { fs, path, makeTempDir, initGitRepo, run, requireLocalSockets, buildEnv, installFakeCodex, browserOriginSetup, transportSetup, resolveIsolatedCodexHome, redactActivity, itemActivity, planActivity, activityReader, formatActivity, writeJobFile, upsertJob, updateJob, readJobFile, resolveJobFile, resolveStateDir, JobRuntime, pauseAdjustment, renewLease, markOwnerAttachment, leaseSnapshot, questionMessage, adoptJob, ownershipNotice, answerQuestion, askParentQuestion, ownerLost, directReport, progressSnapshot, PARENT_BRIDGE_ENV, buildWorkerReport, resolveSessionMarkersRoot, AGENT_NAMES, pickAgentName, splitRawArgumentString, bridgeScript, spawnOwned, script, hook, brokerScript, alive, fixture, json, directLines, direct, directError, delay, waitUntil, patchJob, job };
}
