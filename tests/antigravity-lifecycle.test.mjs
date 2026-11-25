import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, waitForCondition, writeExecutable } from "./helpers.mjs";
import { resolveJobFile, unresolvedTask, updateJob } from "../plugins/codex/scripts/lib/state.mjs";

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
  if (method === "initialize") send({ id, result: { protocolVersion: 1, agentInfo: { name: "agy", version: "1.5.16" },
    agentCapabilities: { loadSession: true } } });
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

async function recordLivePeer(f, id) {
  // Exercise positive ownership with a PID observation distinguishable from
  // the peer's POSIX birth second. Both ends of the original connection live.
  const job = f.job(id);
  const nextSecond = Math.floor(Date.parse(job.acpProcessRecordedAt) / 1000) * 1000 + 1000;
  await waitForCondition(() => Date.now() >= nextSecond, "distinct PID observation second");
  assert.ok(alive(job.pid) && alive(job.acpProcessPid));
  updateJob(f.repo, id, () => ({ acpProcessRecordedAt: new Date().toISOString() }));
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
  const f = fixture(), { jobId } = f.launch("orphan", "--name", "OrphanWorker");
  await waitForCondition(() => fs.existsSync(f.events + ".tool"), "tool startup", 10000);
  const tool = Number(fs.readFileSync(f.events + ".tool", "utf8")), lost = f.job(jobId);
  t.after(() => {
    for (const pid of [tool, lost.acpProcessPid]) if (alive(pid)) process.kill(pid, "SIGKILL");
  });
  await recordLivePeer(f, jobId);
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
  await killWorker(f, jobId);
  await waitForCondition(() => !alive(original.acpProcessPid), "ACP exit on EOF", 5000);

  const replacement = spawn(f.executable, ["acp"], { detached: true, stdio: ["pipe", "ignore", "ignore"],
    env: f.env });
  t.after(() => replacement.kill("SIGKILL"));
  replacement.stdin.write(JSON.stringify({ id: 1, method: "initialize" }) + "\n");
  await waitForCondition(() => f.requests("initialize").some(request => request.pid === replacement.pid), "replacement ACP startup");
  updateJob(f.repo, jobId, () => ({ acpProcessPid: replacement.pid }));
  // Give the stale record an unambiguous upper bound across ps's whole-second
  // precision. The replacement otherwise has the exact same group and argv.
  const earlier = new Date(Date.parse(original.acpProcessRecordedAt) - 60000).toISOString();
  updateJob(f.repo, jobId, () => ({ acpProcessRecordedAt: earlier }));
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
  updateJob(f.repo, jobId, () => ({ acpProcessRecordedAt: recordedAt }));
  const response = f.command(["cancel", jobId, "--json"], { status: 2 });
  assert.equal(response.confirmation, "unconfirmed");
  assert.ok(alive(acpProcessPid));
  const job = f.job(jobId);
  assert.equal(job.acpProcessExited, false);
  assert.equal(unresolvedTask(job), true);
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

  const orphan = f.launch("survive-eof");
  await waitForCondition(() => f.requests("session/prompt").length === 3, "new prompt", 10000);
  const pid = f.job(orphan.jobId).acpProcessPid;
  t.after(() => { if (alive(pid)) process.kill(pid, "SIGKILL"); });
  await recordLivePeer(f, orphan.jobId);
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
