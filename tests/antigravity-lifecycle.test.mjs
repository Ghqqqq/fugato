import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, waitForCondition, writeExecutable } from "./helpers.mjs";
import { answerQuestion, PARENT_BRIDGE_ENV } from "../plugins/codex/scripts/lib/job-runtime.mjs";
import { resolveJobFile, unresolvedTask, updateJob, upsertJob, writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";

const cli = fileURLToPath(new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url));
const fugato = fileURLToPath(new URL("../plugins/codex/bin/fugato", import.meta.url));

function fixture() {
  const dir = makeTempDir("acp-lifecycle-"), repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  initGitRepo(repo);
  const executable = path.join(dir, "agy"), events = path.join(dir, "requests.jsonl");
  fs.writeFileSync(events, "");
  writeExecutable(executable, "#!" + process.execPath + "\n" + String.raw`
const fs = require("node:fs"), readline = require("node:readline"), { spawn } = require("node:child_process");
if (process.argv.includes("--help")) process.exit(0);
const { ACP_MODE: mode, ACP_EVENTS: file } = process.env;
let sessionId = process.env.ACP_SESSION_ID || "session-" + process.pid;
const configOptions = [{ id: "model", type: "select", currentValue: "gemini-fixture",
  options: [{ value: "gemini-fixture", name: "Gemini fixture" }] }];
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
readline.createInterface({ input: process.stdin }).on("line", line => {
  const { id, method, params } = JSON.parse(line);
  fs.appendFileSync(file, JSON.stringify({ pid: process.pid, method, params }) + "\n");
  if (method === "initialize") setTimeout(() => send({ id, result: { protocolVersion: 1, agentInfo: { name: "agy", version: "1.5.16" },
    agentCapabilities: { loadSession: true } } }), Number(process.env.ACP_INITIALIZE_DELAY_MS) || 0);
  if (method === "session/new") send({ id, result: { sessionId, configOptions } });
  if (method === "session/load") {
    sessionId = params.sessionId;
    if (mode !== "hold-load") send({ id, result: { configOptions } });
  }
  if (method === "session/prompt" && mode === "orphan") {
    // The group leader exits on SIGTERM. Its tool survives until SIGKILL.
    spawn(process.execPath, ["-e",
      'process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(process.env.ACP_EVENTS + ".tool", String(process.pid)); setInterval(() => {}, 1000)'],
      { stdio: "ignore" });
  }
  if (method === "session/prompt" && mode === "complete") {
    const answer = { status: "completed", summary: "The assignment is complete.", key_findings: ["Fixture finding"],
      assumptions: [], verification: ["Fixture check"], blockers: [], question: null };
    send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: JSON.stringify(answer) } } } });
    send({ id, result: { stopReason: "end_turn", usage: { inputTokens: 9, outputTokens: 3, totalTokens: 12 } } });
  }
  if (method === "session/prompt" && mode === "survive-eof") setInterval(() => {}, 1000);
  // A held prompt deliberately receives no session/cancel acknowledgement.
});
`);
  const env = { ...buildEnv(dir), FUGATO_ANTIGRAVITY_BIN: executable, ACP_EVENTS: events,
    CODEX_COMPANION_BIN: path.join(dir, "missing-codex"), CODEX_COMPANION_SESSION_ID: "acp-lifecycle" };
  const command = (args, { mode = "complete", status = 0, script = cli, direct = false } = {}) => {
    const run = spawnSync(process.execPath, [script, ...args], { cwd: repo, env: { ...env, ACP_MODE: mode },
      encoding: "utf8", timeout: 20000, killSignal: "SIGKILL" });
    assert.equal(run.status, status, run.error?.message ?? (run.stderr + run.stdout));
    return JSON.parse(direct ? run.stdout.trim().split("\n").at(-1) : run.stdout);
  };
  const job = id => JSON.parse(fs.readFileSync(resolveJobFile(repo, id), "utf8"));
  const requests = method => fs.readFileSync(events, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
    .filter(request => request.method === method);
  const launch = (mode, ...flags) => command(["task", "--backend", "antigravity", "--detached", "--json", ...flags, "Run the assignment."], { mode });
  const complete = (...flags) => command(["task", ...flags, "--direct", "Finish the follow-up."], { direct: true });
  return { command, complete, launch, job, requests, dir, repo, env, events, executable };
}

const alive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
};
async function killWorker(f, id) {
  const { pid } = f.job(id);
  process.kill(pid, "SIGKILL");
  await waitForCondition(() => !alive(pid), "worker exit", 5000);
}

test("a follow-up killed before session/prompt is recorded as notStarted and can continue", async () => {
  const f = fixture();
  const first = f.complete("--backend", "antigravity");
  const follow = f.command(["task", "--continue", first.jobId, "--detached", "--json", "Run the assignment."], { mode: "hold-load" });
  await waitForCondition(() => f.requests("session/load").length, "pending session/load", 10000);
  assert.equal(f.job(follow.jobId).turnSubmission, null);
  await killWorker(f, follow.jobId);
  const next = f.complete("--continue", follow.jobId);
  const lost = f.job(follow.jobId);
  assert.equal(lost.status, "failed");
  assert.equal(lost.turnResolution, "notStarted");
  assert.equal(lost.result.turnEnded, true);
  assert.equal(unresolvedTask(lost), false);
  assert.equal(next.status, "completed");
  assert.equal(f.job(next.jobId).threadId, f.job(first.jobId).threadId);
  assert.equal(f.requests("session/prompt").length, 2);
});

test("an unacknowledged cancel records process exit and reports a usable continuation", async () => {
  const f = fixture(), { jobId } = f.launch("hold");
  await waitForCondition(() => f.requests("session/prompt").length, "prompt", 10000);
  const cancelled = f.command(["cancel", jobId, "--json"], { status: 2 });
  assert.equal(cancelled.confirmation, "unconfirmed");
  const lost = f.job(jobId);
  assert.equal(lost.status, "cancelled");
  assert.equal(lost.acpProcessExited, true);
  assert.equal(lost.result.interruptionConfirmed, false);
  assert.equal(lost.result.turnEnded, true);
  assert.equal(lost.turnResolution, "unknown");
  assert.equal(unresolvedTask(lost), false);
  const details = f.command(["result", jobId, "--details"], { status: 1 });
  assert.match(details.recovery.detail, /outcome is unknown/i);
  assert.doesNotMatch(JSON.stringify(details), /"cancelCommand"|"thread_busy"/);
  assert.ok(details.continuationCommand.includes(`--continue '${jobId}'`));
  const next = f.complete("--continue", jobId);
  assert.equal(next.status, "completed");
  assert.equal(f.job(next.jobId).threadId, lost.threadId);
  assert.equal(f.requests("session/cancel").length, 1);
  assert.equal(f.requests("session/prompt").length, 2);
});

test("cancelling a crashed worker by name stops its ACP group including a stubborn tool", async t => {
  const f = fixture();
  f.env.ACP_INITIALIZE_DELAY_MS = "1200";
  const { jobId } = f.launch("orphan", "--name", "OrphanWorker");
  await waitForCondition(() => fs.existsSync(f.events + ".tool"), "tool startup", 10000);
  const tool = Number(fs.readFileSync(f.events + ".tool", "utf8")), lost = f.job(jobId);
  t.after(() => {
    for (const pid of [tool, lost.acpProcessPid]) if (alive(pid)) process.kill(pid, "SIGKILL");
  });
  assert.ok(Math.floor(Date.parse(lost.turnSubmission.at) / 1000) > Math.floor(Date.parse(lost.acpProcessRecordedAt) / 1000),
    "prompt submission supplies a later whole-second ownership proof");
  await killWorker(f, jobId);
  assert.ok(alive(lost.acpProcessPid) && alive(tool));
  const cancelled = f.command(["cancel", "OrphanWorker", "--json"], { script: fugato, status: 2 });
  assert.equal(cancelled.confirmation, "unconfirmed");
  await waitForCondition(() => !alive(lost.acpProcessPid) && !alive(tool), "orphaned group exit", 3000);
  assert.equal(f.job(jobId).acpProcessExited, true);
  assert.equal(f.job(jobId).result.interruptionConfirmed, false);
  assert.equal(f.job(jobId).turnResolution, "unknown");
  const next = f.complete("--to", "OrphanWorker");
  assert.equal(next.status, "completed");
  assert.equal(f.job(next.jobId).threadId, lost.threadId);
  assert.equal(f.requests("session/prompt").length, 2);
});

test("a reused ACP PID leaves the unrelated process running and releases the turn", async t => {
  const f = fixture(), { jobId } = f.launch("hold");
  await waitForCondition(() => f.requests("session/prompt").length, "prompt", 10000);
  const original = f.job(jobId);
  await killWorker(f, jobId);
  await waitForCondition(() => !alive(original.acpProcessPid), "ACP exit on EOF", 5000);
  // A detached group leader with even the expected trailing arguments is
  // unrelated: the executable is node -e, not the recorded agy script.
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", f.executable, "acp"],
    { detached: true, stdio: "ignore" });
  t.after(() => unrelated.kill("SIGKILL"));
  updateJob(f.repo, jobId, () => ({ acpProcessPid: unrelated.pid }));
  f.command(["cancel", jobId, "--json"], { status: 2 });
  assert.ok(alive(unrelated.pid));
  const lost = f.job(jobId);
  assert.equal(lost.acpProcessExited, true);
  assert.equal(lost.turnResolution, "unknown");
  assert.equal(unresolvedTask(lost), false);
  assert.equal(f.complete("--continue", jobId).status, "completed");
});

test("recovery publishes only the ended result artifact for the exact ACP assignment", () => {
  const f = fixture(), { jobId } = f.complete("--backend", "antigravity");
  const original = f.job(jobId), bytes = fs.readFileSync(original.resultFile, "utf8");
  const saved = JSON.parse(bytes);
  const losePublication = () => updateJob(f.repo, jobId, () => ({ status: "running", phase: "working",
    pid: original.acpProcessPid, completedAt: null, recovered: false, result: null, report: null, recovery: null, turnResolution: null }));
  losePublication();
  const report = f.command(["result", jobId, "--details"]);
  const recovered = f.job(jobId);
  assert.equal(report.status, "completed");
  assert.equal(recovered.turnResolution, "completed");
  assert.equal(recovered.result.status, 0);
  assert.equal(recovered.result.turnEnded, true);
  assert.deepEqual(recovered.result.structured.keyFindings, ["Fixture finding"]);
  assert.deepEqual(recovered.result.usage, { inputTokens: 9, outputTokens: 3, totalTokens: 12 });
  assert.equal(fs.readFileSync(original.resultFile, "utf8"), bytes);

  for (const mismatch of [{ jobId: "other-job" }, { threadId: "other-session" }, { turnId: "other-turn" }, { turnEnded: false }]) {
    losePublication();
    fs.writeFileSync(original.resultFile, JSON.stringify({ ...saved, ...mismatch }));
    f.command(["status", jobId, "--json"]);
    assert.equal(f.job(jobId).turnResolution, "unknown");
  }
  assert.equal(f.requests("session/prompt").length, 1);
});

test("an accepted cancellation is honored when recovering an ended ACP result", () => {
  const f = fixture(), { jobId } = f.complete("--backend", "antigravity");
  const original = f.job(jobId);
  updateJob(f.repo, jobId, () => ({ status: "running", phase: "working", pid: original.acpProcessPid,
    completedAt: null, result: null, report: null, cancelRequested: { reason: "cancelled_by_user", at: new Date().toISOString() } }));
  const details = f.command(["result", jobId, "--details"], { status: 1 });
  const recovered = f.job(jobId), artifact = JSON.parse(fs.readFileSync(original.resultFile, "utf8"));
  assert.equal(details.status, "cancelled");
  assert.equal(details.interruptionReason, "cancelled_by_user");
  assert.ok(details.continuationCommand.includes(jobId));
  assert.equal(recovered.status, "cancelled");
  assert.equal(recovered.turnResolution, "completed");
  for (const payload of [recovered.result, artifact]) {
    assert.equal(payload.status, 1);
    assert.equal(payload.workerStatus, "cancelled");
    assert.equal(payload.interruptionReason, "cancelled_by_user");
    assert.equal(payload.interruptionConfirmed, false);
    assert.deepEqual(payload.structured, original.result.structured);
    assert.deepEqual(payload.usage, original.result.usage);
    assert.equal(payload.rawOutput, original.result.rawOutput);
  }
});

test("a newer detached agy acp survives cancellation of a job that recorded the same PID", async t => {
  const f = fixture(), { jobId } = f.launch("hold");
  await waitForCondition(() => f.requests("session/prompt").length, "prompt", 10000);
  const original = f.job(jobId);
  assert.ok(Number.isFinite(Date.parse(original.acpProcessRecordedAt)));
  assert.equal(typeof original.acpProcessStart, "string");
  assert.ok(original.acpProcessStart.length > 0);
  await killWorker(f, jobId);
  await waitForCondition(() => !alive(original.acpProcessPid), "ACP exit on EOF", 5000);

  if (original.acpProcessStart.startsWith("ps:")) {
    // ps -o lstart= has whole-second resolution on macOS/other POSIX.
    const originalSecond = Math.floor(Date.parse(original.acpProcessStart.slice(3) + " GMT") / 1000);
    await waitForCondition(() => Math.floor(Date.now() / 1000) > originalSecond, "later ps lstart second");
  }
  const replacement = spawn(f.executable, ["acp"], { detached: true, stdio: ["pipe", "ignore", "ignore"],
    env: f.env });
  t.after(() => replacement.kill("SIGKILL"));
  replacement.stdin.write(JSON.stringify({ id: 1, method: "initialize" }) + "\n");
  await waitForCondition(() => f.requests("initialize").some(request => request.pid === replacement.pid), "replacement ACP startup");
  updateJob(f.repo, jobId, () => ({ acpProcessPid: replacement.pid }));
  assert.notEqual(f.job(jobId).acpProcessStart, original.acpProcessStart);
  // Changing the fixture PID stamps a new observation. Restore the original job's proof.
  updateJob(f.repo, jobId, () => ({
    acpProcessRecordedAt: original.acpProcessRecordedAt,
    acpProcessStart: original.acpProcessStart
  }));
  f.command(["cancel", jobId, "--json"], { status: 2 });
  assert.ok(alive(replacement.pid));
  assert.equal(f.job(jobId).acpProcessExited, true);
  assert.equal(f.job(jobId).turnResolution, "unknown");
});

test("a matching ACP process born in the recorded POSIX second stays unresolved and unsignalled",
  { skip: process.platform === "win32" }, async t => {
  const f = fixture(), { jobId } = f.launch("survive-eof");
  await waitForCondition(() => f.requests("session/prompt").length, "prompt", 10000);
  const { acpProcessPid } = f.job(jobId);
  t.after(() => { if (alive(acpProcessPid)) process.kill(acpProcessPid, "SIGKILL"); });
  await killWorker(f, jobId);
  const start = spawnSync("/bin/ps", ["-p", String(acpProcessPid), "-o", "lstart="],
    { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
  assert.equal(start.status, 0, start.error?.message ?? start.stderr);
  const recordedAt = new Date(Date.parse(start.stdout.trim() + " GMT") + 500).toISOString();
  // Delete acpProcessStart to exercise the legacy timing rule for older records.
  updateJob(f.repo, jobId, job => ({
    acpProcessStart: undefined,
    acpProcessRecordedAt: recordedAt,
    turnSubmission: { ...job.turnSubmission, at: recordedAt }
  }));
  assert.equal(f.job(jobId).acpProcessStart, undefined);
  const response = f.command(["cancel", jobId, "--json"], { status: 2 });
  assert.equal(response.confirmation, "unconfirmed");
  assert.ok(alive(acpProcessPid));
  const job = f.job(jobId);
  assert.equal(job.acpProcessExited, false);
  assert.equal(unresolvedTask(job), true);
});

test("an orphaned ACP process whose recorded start identity matches is stopped by fugato cancel", async t => {
  const f = fixture(), { jobId } = f.launch("survive-eof");
  await waitForCondition(() => f.requests("session/prompt").length, "prompt", 10000);
  const original = f.job(jobId);
  assert.equal(typeof original.acpProcessStart, "string");
  assert.ok(original.acpProcessStart.length > 0);
  t.after(() => { if (alive(original.acpProcessPid)) process.kill(original.acpProcessPid, "SIGKILL"); });
  await killWorker(f, jobId);
  assert.ok(alive(original.acpProcessPid));
  // Clear legacy timing fields so ownership is established solely by acpProcessStart.
  updateJob(f.repo, jobId, job => ({
    acpProcessRecordedAt: undefined,
    turnSubmission: { ...job.turnSubmission, at: undefined }
  }));
  const cancelled = f.command(["cancel", jobId, "--json"], { script: fugato, status: 2 });
  assert.equal(cancelled.confirmation, "unconfirmed");
  await waitForCondition(() => !alive(original.acpProcessPid), "orphaned ACP exit", 3000);
  assert.equal(alive(original.acpProcessPid), false);
  const job = f.job(jobId);
  assert.equal(job.acpProcessExited, true);
  assert.equal(job.turnResolution, "unknown");
  assert.equal(unresolvedTask(job), false);
});

test("a live ACP prompt sharing a Codex thread handle does not block a Codex continuation", async t => {
  const f = fixture();
  installFakeCodex(f.dir);
  f.env.CODEX_COMPANION_BIN = path.join(f.dir, "codex");
  const first = f.complete("--backend", "codex");
  const threadId = f.job(first.jobId).threadId;
  f.env.ACP_SESSION_ID = threadId;
  const acp = f.launch("hold");
  await waitForCondition(() => f.requests("session/prompt").length, "colliding ACP prompt", 10000);
  t.after(() => f.command(["cancel", acp.jobId, "--json"], { status: 2 }));
  assert.equal(f.job(acp.jobId).threadId, threadId);
  const next = f.complete("--continue", first.jobId);
  assert.equal(next.status, "completed");
  assert.equal(f.job(next.jobId).threadId, threadId);
  assert.equal(f.job(acp.jobId).status, "running");
  assert.equal(f.requests("session/cancel").length, 0);
  assert.equal(f.requests("session/prompt").length, 1);
});

test("ACP admission in another workspace protects a dead worker's live prompt", async t => {
  const f = fixture(), { jobId } = f.launch("survive-eof");
  await waitForCondition(() => f.requests("session/prompt").length, "prompt", 10000);
  const original = f.job(jobId);
  t.after(() => { if (alive(original.acpProcessPid)) process.kill(original.acpProcessPid, "SIGKILL"); });
  await killWorker(f, jobId);
  const other = makeTempDir("acp-other-workspace-");
  initGitRepo(other);
  const blocked = f.command(["task", "--backend", "antigravity", "--thread", original.threadId,
    "--cwd", other, "--sandbox", "danger-full-access", "--direct", "Continue elsewhere."], { direct: true, status: 2 });
  assert.equal(blocked.status, "blocked");
  const blocker = blocked.blockers.find(item => item.code === "thread_busy");
  assert.ok(blocker?.cancelCommand.includes(jobId));
  assert.ok(blocker.recoveryCommand.includes(jobId));
  assert.equal(f.requests("session/load").length, 0);
  assert.equal(f.requests("session/prompt").length, 1);
  assert.ok(alive(original.acpProcessPid));
});

test("ACP admission blocks on a missing private job in another workspace", async t => {
  const f = fixture(), { jobId } = f.launch("survive-eof");
  await waitForCondition(() => f.requests("session/prompt").length, "prompt", 10000);
  const job = f.job(jobId);
  t.after(() => { if (alive(job.acpProcessPid)) process.kill(job.acpProcessPid, "SIGKILL"); });
  await killWorker(f, jobId);
  const file = resolveJobFile(f.repo, jobId);
  fs.unlinkSync(file);
  t.after(() => fs.writeFileSync(file, JSON.stringify(job), { mode: 0o600 }));
  const other = makeTempDir("acp-missing-record-");
  initGitRepo(other);
  const blocked = f.command(["task", "--backend", "antigravity", "--thread", job.threadId,
    "--cwd", other, "--sandbox", "danger-full-access", "--direct", "Continue elsewhere."], { direct: true, status: 2 });
  const blocker = blocked.blockers.find(item => item.code === "thread_busy");
  assert.equal(blocked.status, "blocked");
  assert.match(blocker.message, /ownership.*unknown.*incomplete/i);
  assert.equal(blocker.predecessorJobId, undefined);
  assert.equal(blocker.cancelCommand, undefined);
  assert.equal(blocker.recoveryCommand, undefined);
  assert.equal(f.requests("session/load").length, 0);
  assert.equal(f.requests("session/prompt").length, 1);
});

test("implicit resume and cancel apply ACP recovery to the selected worker", async t => {
  const f = fixture(), first = f.launch("hold");
  await waitForCondition(() => f.requests("session/prompt").length, "prompt", 10000);
  const original = f.job(first.jobId);
  await killWorker(f, first.jobId);
  await waitForCondition(() => !alive(original.acpProcessPid), "ACP exit on EOF", 5000);
  const next = f.complete("--backend", "antigravity", "--resume-last");
  assert.equal(next.status, "completed");
  assert.equal(f.job(next.jobId).threadId, original.threadId);
  assert.equal(f.job(first.jobId).turnResolution, "unknown");

  f.env.ACP_INITIALIZE_DELAY_MS = "1200";
  const orphan = f.launch("survive-eof");
  await waitForCondition(() => f.requests("session/prompt").length === 3, "new prompt", 10000);
  const pid = f.job(orphan.jobId).acpProcessPid;
  t.after(() => { if (alive(pid)) process.kill(pid, "SIGKILL"); });
  await killWorker(f, orphan.jobId);
  const cancelled = f.command(["cancel", "--json"], { status: 2 });
  assert.equal(cancelled.jobId, orphan.jobId);
  assert.equal(cancelled.confirmation, "unconfirmed");
  assert.equal(f.job(orphan.jobId).acpProcessExited, true);
  assert.equal(alive(pid), false);
});

test("a submitted reservation of a dead ACP worker releases the next queued job at limit one", async () => {
  const f = fixture();
  f.command(["setup", "--max-concurrent", "1", "--json"]);
  const first = f.launch("hold");
  await waitForCondition(() => f.requests("session/prompt").length === 1, "first submitted prompt", 10000);
  const queued = f.launch("complete");
  await waitForCondition(() => f.job(queued.jobId).phase === "queued (concurrency limit)", "queued job", 10000);
  assert.equal(f.requests("session/prompt").length, 1);
  await killWorker(f, first.jobId);
  await waitForCondition(() => f.job(queued.jobId).status === "completed", "automatic queue admission", 10000);
  assert.equal(f.requests("session/prompt").length, 2);
  const observed = f.command(["status", first.jobId, "--json"]);
  assert.equal(observed.job.status, "failed");
  assert.equal(f.job(first.jobId).turnResolution, "unknown");
});

test("a legacy Codex submission recovers its missing turn ID alongside an unsubmitted ACP job", t => {
  // Fake Codex allocates the same first thread in each fixture. Give its
  // global thread inventory the same isolated home as this fixture's runtime.
  const previous = process.env.CODEX_COMPANION_HOME;
  process.env.CODEX_COMPANION_HOME = makeTempDir("codex-turn-attribution-");
  t.after(() => { process.env.CODEX_COMPANION_HOME = previous; });
  const f = fixture();
  installFakeCodex(f.dir);
  f.env.CODEX_COMPANION_BIN = path.join(f.dir, "codex");
  const { jobId } = f.complete("--backend", "codex");
  const original = f.job(jobId);
  const acp = f.complete("--backend", "antigravity");
  updateJob(f.repo, acp.jobId, () => ({ threadId: original.threadId, turnSubmission: null, turnId: null,
    startedAt: original.startedAt, result: null, report: null, status: "running", pid: process.pid }));
  const { backend, ...legacyRequest } = original.request;
  const lost = updateJob(f.repo, jobId, () => ({ backend: undefined, request: legacyRequest, turnId: null,
    result: null, report: null, status: "failed", pid: null }));
  assert.ok(lost.turnSubmission);
  assert.equal(unresolvedTask(lost), true);
  f.command(["status", jobId, "--json"]);
  const recovered = f.job(jobId);
  assert.equal(recovered.status, "completed");
  assert.equal(recovered.recovery.source, "thread/read");
  assert.equal(recovered.recovery.turnId, original.turnId);
  assert.equal(f.job(acp.jobId).turnSubmission, null);
});

test("ACP admission ignores a missing private Codex job with the same handle in another workspace", () => {
  const f = fixture(), first = f.complete("--backend", "antigravity");
  const { threadId } = f.job(first.jobId);
  const other = makeTempDir("legacy-codex-index-");
  initGitRepo(other);
  upsertJob(other, { id: "missing-codex", workspaceRoot: other, threadId, jobClass: "task", status: "running" });
  assert.equal(fs.existsSync(resolveJobFile(other, "missing-codex")), false);
  const next = f.complete("--continue", first.jobId);
  assert.equal(next.status, "completed");
  assert.deepEqual(f.requests("session/load").map(request => request.params.sessionId), [threadId]);
});

test("cancel cleans Codex terminals when a job never submitted and ACP is live on the same handle", t => {
  const previous = process.env.CODEX_COMPANION_HOME;
  process.env.CODEX_COMPANION_HOME = makeTempDir("codex-cleanup-");
  t.after(() => { process.env.CODEX_COMPANION_HOME = previous; });
  const f = fixture();
  installFakeCodex(f.dir);
  f.env.CODEX_COMPANION_BIN = path.join(f.dir, "codex");
  const { jobId } = f.complete("--backend", "codex"), { threadId, request } = f.job(jobId);
  const { backend, ...legacyRequest } = request;
  updateJob(f.repo, jobId, () => ({ backend: undefined, request: legacyRequest, turnId: null,
    turnSubmission: null, result: null, report: null, status: "failed", pid: null }));
  const acp = { id: "live-acp", workspaceRoot: f.repo, backend: "antigravity", threadId,
    turnId: "acp-active", jobClass: "task", status: "running", pid: process.pid };
  upsertJob(f.repo, acp);
  writeJobFile(f.repo, acp.id, acp);
  const cancel = f.command(["cancel", jobId, "--json"]);
  assert.equal(f.job(jobId).recovery.turnStatus, "notStarted");
  assert.equal(cancel.turnInterruptAttempted, false);
  assert.equal(cancel.backgroundTerminals.cleaned, true);
  const requests = fs.readFileSync(path.join(f.dir, "fake-codex-state.json.requests.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(requests.filter(r => r.method === "thread/backgroundTerminals/clean").map(r => r.params.threadId), [threadId]);
  assert.deepEqual(f.job(acp.id), acp);
});

test("parent questions reach their own backend when ACP and Codex share thread and turn handles", async t => {
  const f = fixture(), first = f.complete("--backend", "antigravity");
  const next = f.complete("--continue", first.jobId);
  const { threadId, turnId } = f.job(next.jobId);
  updateJob(f.repo, next.jobId, () => ({ status: "running", pid: process.pid }));
  const codex = { id: "legacy-bridge-job", workspaceRoot: f.repo, threadId, turnId, status: "running", pid: process.pid };
  upsertJob(f.repo, codex);
  writeJobFile(f.repo, codex.id, codex);
  const [server] = f.requests("session/load")[0].params.mcpServers;
  const env = Object.fromEntries(server.env.map(({ name, value }) => [name, value]));
  assert.equal(env[PARENT_BRIDGE_ENV.jobId], next.jobId);
  assert.equal(env[PARENT_BRIDGE_ENV.threadId], undefined);
  assert.equal(env.CODEX_COMPANION_BRIDGE_BACKEND, "antigravity");
  const threadEnv = { [PARENT_BRIDGE_ENV.cwd]: f.repo, [PARENT_BRIDGE_ENV.threadId]: threadId };
  for (const [target, other, binding] of [
    [next.jobId, codex.id, env],
    [next.jobId, codex.id, { ...threadEnv, CODEX_COMPANION_BRIDGE_BACKEND: "antigravity" }],
    [codex.id, next.jobId, threadEnv]
  ]) {
    const bridge = spawn(server.command, server.args, { cwd: f.repo, env: { ...f.env, ...binding }, stdio: ["pipe", "pipe", "inherit"] });
    t.after(() => bridge.kill());
    let reply;
    createInterface({ input: bridge.stdout }).on("line", line => { reply = JSON.parse(line); });
    bridge.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name: "ask_parent", arguments: { question: "Which sample?" }
    } }) + "\n");
    await waitForCondition(() => reply || f.job(target).pendingQuestion || f.job(other).pendingQuestion, "bridge question", 5000);
    assert.ok(!f.job(other).pendingQuestion);
    const pending = f.job(target).pendingQuestion;
    assert.equal(pending?.text, "Which sample?");
    answerQuestion(f.repo, target, pending.id, "Sample B");
    await waitForCondition(() => reply, "bridge answer", 5000);
    assert.equal(reply.result.content[0].text, "Sample B");
    bridge.stdin.end();
  }
});
