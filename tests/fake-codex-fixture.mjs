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

// Shared helpers for the split worker-report suites.
export async function workerReportHarness() {
  const { default: assert } = await import("node:assert/strict");
  const lifecycle = await lifecycleHarness();
  const { makeTempDir, run, initGitRepo, readJobFile, resolveStateDir, updateJob, spawnOwned: spawn, script, direct, directLines, json } = lifecycle;
  const stateModule = new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url).href;

  function fixture(behavior, options) {
    const dir = makeTempDir();
    installFakeCodex(dir, behavior, options);
    const repo = path.join(dir, "repo"); fs.mkdirSync(repo); initGitRepo(repo);
    const env = { ...buildEnv(dir), CLAUDE_PLUGIN_DATA: path.join(dir, "data"), CODEX_COMPANION_HOME: path.join(dir, "isolated") };
    const call = (...args) => run(process.execPath, [script, ...args], { cwd: repo, env });
    const state = () => JSON.parse(fs.readFileSync(path.join(dir, "fake-codex-state.json"), "utf8"));
    return { dir, repo, env, call, state };
  }

  function storedFixtureJob(f, id, patch = null) {
    if (!patch) return readJobFile(path.join(resolveStateDir(f.repo, f.env), "jobs", `${id}.json`));
    // Fixture setup uses the production lock/index writer without launching a CLI
    // just to mutate test state. Restore the home before any asynchronous work.
    const previous = process.env.CODEX_COMPANION_HOME;
    process.env.CODEX_COMPANION_HOME = f.env.CODEX_COMPANION_HOME;
    try { return updateJob(f.repo, id, () => patch); }
    finally { process.env.CODEX_COMPANION_HOME = previous; }
  }

  function switchingFixture(makeFixture = fixture) {
    const f = makeFixture("review-ok", { mutable: true }), binary = path.join(f.dir, "codex");
    const source = fs.readFileSync(binary, "utf8");
    const declaration = 'const BEHAVIOR = "review-ok";';
    const request = 'const message = JSON.parse(line);';
    assert.ok(source.includes(declaration) && source.includes(request));
    fs.writeFileSync(binary, source.replace(declaration, 'let BEHAVIOR = "review-ok";')
      .replace(request, `${request}\n  BEHAVIOR = loadState().fixtureBehavior || "review-ok";`));
    return { ...f, select(behavior) {
      const state = fs.existsSync(path.join(f.dir, "fake-codex-state.json")) ? f.state() : {};
      fs.writeFileSync(path.join(f.dir, "fake-codex-state.json"), JSON.stringify({
        nextThreadId: 1, nextTurnId: 1, appServerStarts: 0, threads: [], capabilities: null, lastInterrupt: null,
        ...state, fixtureBehavior: behavior
      }));
    } };
  }

  function loseTurn(f) {
    const response = f.call("task", "--report", "--json", "complete the fixture work");
    assert.equal(response.status, 1, response.stderr);
    const id = /Job handle: ([^;]+)/.exec(response.stderr)?.[1];
    assert.ok(id, response.stderr);
    const job = storedFixtureJob(f, id);
    assert.equal(job.status, "failed");
    assert.ok(job.threadId && job.turnId && job.errorMessage);
    assert.equal(job.result.failureSource, "transport");
    assert.equal(job.result.errorCode, "BROKER_CONNECTION_CLOSED");
    assert.equal(job.result.turnEnded, false);
    assert.match(job.errorMessage, /connection to Codex closed while the turn was running/i);
    assert.equal(job.activity.length, 36);
    assert.equal(f.state().nextTurnId, 2);
    return job;
  }

  function recoveryBaseline(f) {
    const original = loseTurn(f), backup = path.join(f.dir, "recovery-baseline");
    const files = [f.env.CODEX_COMPANION_HOME, path.join(f.dir, "fake-codex-state.json"),
      path.join(f.dir, "fake-codex-state.json.requests.jsonl")];
    const contents = file => {
      const stat = fs.lstatSync(file);
      return stat.isDirectory() ? fs.readdirSync(file).sort().map(name => [name, contents(path.join(file, name))])
        : [stat.mode & 0o777, fs.readFileSync(file).toString("base64")];
    };
    fs.mkdirSync(backup);
    const expected = files.map(contents);
    files.forEach((file, i) => fs.cpSync(file, path.join(backup, String(i)), { recursive: true }));
    return { original, restore() {
      files.forEach((file, i) => {
        fs.rmSync(file, { recursive: true, force: true });
        fs.cpSync(path.join(backup, String(i)), file, { recursive: true });
      });
      assert.deepEqual(files.map(contents), expected, "restore the job, index, markers, broker metadata and server before each recovery");
    } };
  }

  const directJson = response => {
    try { return JSON.parse(response.stdout); }
    catch { return JSON.parse(response.stdout.trim().split("\n").filter(line => line.startsWith("{")).at(-1)); }
  };

  function callAsync(f, ...args) {
    const child = spawn(process.execPath, [script, ...args], { cwd: f.repo, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    return { child, done: new Promise(resolve => child.once("close", status => resolve({ status, stdout, stderr }))) };
  }

  const checkDecisionReport = (f, output, status, code) => {
    const usage = { inputTokens: 150, cachedInputTokens: 40, outputTokens: 30, reasoningOutputTokens: 10, totalTokens: 180 };
    const result = direct(output, code);
    assert.equal(result.status, status);
    assert.deepEqual(Object.keys(result).slice(0, 4), ["status", "worker", "jobId", "summary"]);
    assert.deepEqual(Object.keys(result).slice(-2), ["next", "details"]);
    const { summary, ...envelope } = result;
    assert.ok(Buffer.byteLength(JSON.stringify(envelope)) <= 2000);
    assert.equal(result.details, `fugato result '${result.jobId}' --details`);
    assert.equal(result.next, status === "completed" ? null : status === "needs_answer" ? `fugato answer ${result.worker} --question '${result.question.id}'` : status === "running" ? `fugato wait ${result.worker}` : `fugato task --to ${result.worker}`);
    for (const key of ["waitCommand", "answerCommand", "answerAndWaitCommand", "rawOutputFile", "ownerId"]) assert.equal(Object.hasOwn(result, key), false);
    const details = json(f.call("result", result.jobId, "--details"), code);
    const reread = json(f.call("result", result.jobId), code);
    assert.equal(reread.status, result.status); assert.equal(reread.next, result.next);
    if (["running", "needs_answer"].includes(status)) {
      assert.ok(details.waitCommand);
      if (status === "needs_answer") {
        assert.deepEqual(Object.keys(result.question), ["id", "kind", "text", "options", "expiresInSec"]);
        assert.deepEqual(result.question.options, details.question.options);
        assert.ok(result.question.expiresInSec >= 0);
        assert.ok(details.answerCommand && details.answerAndWaitCommand);
      }
    } else {
      assert.deepEqual(result.usage, usage);
      assert.deepEqual(details.usage, usage);
      assert.deepEqual(storedFixtureJob(f, result.jobId).result.usage, usage);
      assert.deepEqual(Object.keys(result).slice(-3), ["usage", "next", "details"]);
      assert.equal(result.summary, fs.readFileSync(details.rawOutputFile, "utf8").trim());
      assert.deepEqual(reread, result);
      const quiet = f.call("wait", result.jobId, "--direct", "--quiet");
      assert.deepEqual(direct(quiet, code), result);
      assert.equal(quiet.stdout, `${directLines(output.stdout).at(-1)}\n`);
      const legacy = json(f.call("wait", result.jobId, "--json"), code);
      const waited = json(f.call("wait", result.jobId, "--details"), code);
      assert.deepEqual(Object.keys(legacy).filter(key => !Object.hasOwn(waited, key)), [], "no 1.3 wait report keys disappear");
      for (const key of ["status", "reportFormat", "jobId", "threadId", "turnId", "exitCode", "sandbox", "approvalPolicy", "model", "effort", "serviceTier", "touchedFiles", "preExistingChanges", "fileTrackingStatus", "fileTrackingBasis", "verification", "verificationBasis", "keyFindings", "findingsBasis", "assumptions", "blockers", "question", "rawOutputFile", "resultFile", "ownerId", "sessionId"]) {
        assert.equal(Object.hasOwn(details, key), Object.hasOwn(legacy, key), key);
        assert.deepEqual(details[key], key === "blockers" && status === "blocked"
          ? storedFixtureJob(f, result.jobId).result.structured.blockers : legacy[key], key);
      }
      assert.deepEqual(details.claimedVerification, legacy.claimedVerification ?? []);
      assert.deepEqual(result.checks?.ran ?? [], details.verification);
      assert.deepEqual(result.checks?.claimed ?? [], details.claimedVerification);
      if (status !== "completed") {
        assert.match(details.continuationCommand, / --direct$/);
        assert.equal(legacy.continuationCommand, details.continuationCommand);
        assert.equal(json(f.call("adopt", result.jobId, "--json"), 2).continuationCommand, details.continuationCommand);
      }
    }
  };

  return { lifecycle, script, stateModule, fixture, storedFixtureJob, switchingFixture, recoveryBaseline, loseTurn, directJson, callAsync, checkDecisionReport };
}
