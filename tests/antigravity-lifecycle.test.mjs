import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildEnv } from "./fake-codex-fixture.mjs";
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
let sessionId = "session-" + process.pid;
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
readline.createInterface({ input: process.stdin }).on("line", line => {
  const { id, method, params } = JSON.parse(line);
  fs.appendFileSync(file, JSON.stringify({ pid: process.pid, method, params }) + "\n");
  if (method === "initialize") send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  if (method === "session/new") send({ id, result: { sessionId } });
  if (method === "session/load") {
    sessionId = params.sessionId;
    if (mode !== "hold-load") send({ id, result: {} });
  }
  if (method === "session/prompt" && mode === "orphan") {
    // The group leader exits on SIGTERM. Its tool survives until SIGKILL.
    spawn(process.execPath, ["-e",
      'process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(process.env.ACP_EVENTS + ".tool", String(process.pid)); setInterval(() => {}, 1000)'],
      { stdio: "ignore" });
  }
  if (method === "session/prompt" && mode === "complete") {
    send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "The assignment is complete." } } } });
    send({ id, result: { stopReason: "end_turn" } });
  }
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
  return { command, complete, launch, job, requests, repo, events, executable };
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

test("cancelling a crashed worker by name stops its ACP group including a stubborn tool", async () => {
  const f = fixture(), { jobId } = f.launch("orphan", "--name", "OrphanWorker");
  await waitForCondition(() => fs.existsSync(f.events + ".tool"), "tool startup", 10000);
  const tool = Number(fs.readFileSync(f.events + ".tool", "utf8")), lost = f.job(jobId);
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
