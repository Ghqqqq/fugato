import test from 'node:test';
import assert from 'node:assert/strict';
import { lifecycleHarness } from './fake-codex-fixture.mjs';
const {
  fs, path, makeTempDir, resolveStateDir, run, itemActivity, writeJobFile, upsertJob, updateJob, readJobFile, resolveJobFile, answerQuestion, askParentQuestion, PARENT_BRIDGE_ENV, splitRawArgumentString, bridgeScript, spawnOwned, script, alive, fixture, json, direct, directError, waitUntil, job
} = await lifecycleHarness();

const storedJob = (f, id) => readJobFile(path.join(resolveStateDir(f.repo, f.env), "jobs", `${id}.json`));

test("detached wait returns bounded safe progress, startup phases and confirmed cancellation", async () => {
  const f = fixture(); const launch = json(f.call("task", "--detached", "--report", "--json", "fixture work"));
  await waitUntil(() => storedJob(f, launch.jobId).startupTimings?.mcpReady);
  const snapshot = json(f.call("wait", launch.jobId, "--timeout-sec", "1", "--json", "--report"));
  assert.equal(snapshot.status, "running"); assert.ok(snapshot.headline);
  assert.equal(snapshot.completedItems.find(i => i.type === "commandExecution").exitCode, 0);
  for (const phase of ["brokerConnectSpawn", "appServerInitialize", "threadStart", "turnStart", "firstModelEvent", "firstToolCall", "mcpReady"]) assert.ok(snapshot.startupTimings[phase], phase);
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_FIXTURE/);
  const cancellation = json(f.call("cancel", launch.jobId, "--json")); assert.equal(cancellation.confirmation, "confirmed");
  const result = json(f.call("wait", launch.jobId, "--json", "--report"), 1);
  assert.equal(result.status, "cancelled"); assert.equal(result.interruptionConfirmed, true);
  assert.equal(f.state().lastInterrupt.turnId, snapshot.turnId);
  assert.deepEqual(result.activity, []); // This observer already consumed the command/plan events.
  assert.ok(result.cursor > 0);
  assert.doesNotMatch(fs.readFileSync(job(f, launch.jobId).logFile, "utf8"), /PRIVATE_FIXTURE/);

  // Race two real workers on one queued record. Hold the claimant outside the
  // state lock, before runtime startup, so a loser's writes cannot be hidden by
  // the winner's subsequent progress. Exercise dead-PID reclamation as well.
  const stateModule = new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url).href;
  const expired = spawnOwned(process.execPath, ["-e", ""], { env: f.env, stdio: "ignore" });
  await new Promise(resolve => expired.once("close", resolve));
  assert.equal(alive(expired.pid), false);
  for (const previousClaim of [{ pid: expired.pid, at: new Date().toISOString() }]) {
    const claim = fixture("review-ok"), id = "claim-fixture";
    const ready = path.join(claim.dir, "ready"), claimed = path.join(claim.dir, "claimed");
    const start = path.join(claim.dir, "start"), release = path.join(claim.dir, "release");
    fs.mkdirSync(ready); fs.mkdirSync(claimed);
    const record = { id, jobClass: "task", kind: "task", workspaceRoot: claim.repo,
      sessionId: claim.env.CODEX_COMPANION_SESSION_ID, ownerId: "claim-owner",
      status: "queued", phase: "queued", createdAt: new Date().toISOString(), pid: process.pid,
      ...(previousClaim ? { executionClaim: previousClaim } : {}),
      logFile: path.join(claim.dir, "job.log"),
      request: { cwd: claim.repo, jobId: id, prompt: "fixture claim", model: "gpt-6-astra", effort: "xhigh",
        sandbox: "read-only", detached: true, resumeLast: false } };
    fs.writeFileSync(record.logFile, "");
    const seeded = run(process.execPath, ["--input-type=module", "-e", `
      import { writeJobFile, upsertJob } from ${JSON.stringify(stateModule)};
      const record = ${JSON.stringify(record)};
      const file = writeJobFile(process.cwd(), record.id, record); upsertJob(process.cwd(), record);
      console.log(JSON.stringify(file));
    `], { cwd: claim.repo, env: claim.env });
    const file = json(seeded), index = path.join(path.dirname(path.dirname(file)), "state.json");
    const preload = path.join(claim.dir, "claim-gate.mjs");
    fs.writeFileSync(preload, `
      import fs from "node:fs";
      import path from "node:path";
      const wait = gate => { while (!fs.existsSync(gate)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); };
      fs.writeFileSync(path.join(${JSON.stringify(ready)}, String(process.pid)), "");
      wait(${JSON.stringify(start)});
      const rmdir = fs.rmdirSync;
      fs.rmdirSync = function(directory, ...args) {
        const result = rmdir.call(this, directory, ...args);
        if (path.basename(directory) === ".state-lock") {
          const job = fs.readFileSync(${JSON.stringify(file)}, "utf8"), current = JSON.parse(job);
          if (current.status === "queued" && current.executionClaim?.pid === process.pid) {
            fs.writeFileSync(path.join(${JSON.stringify(claimed)}, String(process.pid)),
              JSON.stringify({ job, index: fs.readFileSync(${JSON.stringify(index)}, "utf8") }));
            wait(${JSON.stringify(release)});
          }
        }
        return result;
      };
    `);
    const workers = Array.from({ length: 2 }, () => {
      const child = spawnOwned(process.execPath, ["--import", preload, script, "task-worker", "--cwd", claim.repo, "--job-id", id],
        { cwd: claim.repo, env: claim.env, stdio: ["ignore", "ignore", "pipe"] });
      const worker = { child, done: null, result: null, stderr: "" };
      child.stderr.on("data", data => { worker.stderr += data; });
      worker.done = new Promise(resolve => child.once("close", (code, signal) => { worker.result = { code, signal }; resolve(worker.result); }));
      return worker;
    });
    try {
      await waitUntil(() => fs.readdirSync(ready).length === 2);
      fs.writeFileSync(start, "");
      await waitUntil(() => fs.readdirSync(claimed).length && workers.some(worker => worker.result));
      assert.equal(fs.readdirSync(claimed).length, 1);
      const winnerPid = Number(fs.readdirSync(claimed)[0]);
      const before = JSON.parse(fs.readFileSync(path.join(claimed, String(winnerPid)), "utf8"));
      const loser = workers.find(worker => worker.child.pid !== winnerPid);
      assert.deepEqual(await loser.done, { code: 0, signal: null }, loser.stderr);
      assert.equal(fs.readFileSync(file, "utf8"), before.job);
      assert.equal(fs.readFileSync(index, "utf8"), before.index);
      assert.equal(fs.readFileSync(record.logFile, "utf8").split("\n").filter(Boolean).length, 1);
      assert.equal(fs.existsSync(path.join(claim.dir, "fake-codex-state.json")), false);
      const held = JSON.parse(before.job);
      assert.equal(held.pid, winnerPid);
      assert.equal(held.executionClaim.pid, winnerPid);
      assert.ok(Number.isFinite(Date.parse(held.executionClaim.at)));
      fs.writeFileSync(release, "");
      assert.deepEqual(await workers.find(worker => worker.child.pid === winnerPid).done, { code: 0, signal: null });
      assert.equal(JSON.parse(fs.readFileSync(file)).status, "completed");
      assert.equal(claim.requests().filter(request => request.method === "turn/start").length, 1);
      // Even after the claimant exits, a completed job cannot be replayed.
      const completed = fs.readFileSync(file, "utf8"), completedIndex = fs.readFileSync(index, "utf8");
      assert.equal(claim.call("task-worker", "--job-id", id).status, 0);
      assert.equal(fs.readFileSync(file, "utf8"), completed);
      assert.equal(fs.readFileSync(index, "utf8"), completedIndex);
      assert.equal(claim.requests().filter(request => request.method === "turn/start").length, 1);
    } finally {
      fs.writeFileSync(start, ""); fs.writeFileSync(release, "");
      for (const worker of workers) if (worker.child.exitCode === null) worker.child.kill("SIGTERM");
      await Promise.all(workers.map(worker => worker.done));
    }
  }
});

test("question history caps entries and answer length and retains timeout resolution", async t => {
  const cwd = makeTempDir(), id = "question-timeout";
  let now = 100000;
  t.mock.method(Date, "now", () => now);
  writeJobFile(cwd, id, { id, status: "running", ownerId: "owner", questionTimeoutSec: 1,
    questionHistory: Array.from({ length: 20 }, (_, i) => ({ id: `old-${i}`, resolution: "answered" })) });
  const answered = askParentQuestion(cwd, id, { question: "Choose scope?", options: ["Small", "Broad"], kind: "approval" });
  const asking = readJobFile(resolveJobFile(cwd, id)).pendingQuestion;
  answerQuestion(cwd, id, asking.id, "字".repeat(2500), "owner");
  assert.equal((await answered).resolution, "answered");
  const bounded = readJobFile(resolveJobFile(cwd, id)).questionHistory;
  assert.equal(bounded.length, 20); assert.equal(bounded[0].id, "old-1");
  assert.deepEqual(bounded.at(-1), { id: asking.id, callId: null, kind: "approval", text: "Choose scope?", options: ["Small", "Broad"],
    askedAt: new Date(now).toISOString(), answeredAt: new Date(now).toISOString(), answer: "字".repeat(2000), resolution: "answered" });
  const reply = askParentQuestion(cwd, id, { question: "Which path?", callId: "timeout-call" });
  const pending = readJobFile(resolveJobFile(cwd, id)).pendingQuestion;
  now = pending.expiresAt;
  const result = await reply;
  assert.equal(result.resolution, "timeout");
  const saved = readJobFile(resolveJobFile(cwd, id));
  assert.equal(saved.pendingQuestion, null);
  assert.equal(saved.lastQuestion.resolution, "timeout");
  assert.equal(saved.questionHistory.length, 20); assert.equal(saved.questionHistory[0].id, "old-2");
  assert.deepEqual(saved.questionHistory.at(-1), { id: pending.id, callId: "timeout-call", kind: "question", text: "Which path?", options: [],
    askedAt: pending.askedAt, answeredAt: null, answer: null, resolution: "timeout" });
  const controller = new AbortController();
  const held = askParentQuestion(cwd, id, { question: "Keep waiting?", callId: "held-call" }, { signal: controller.signal });
  const waiting = readJobFile(resolveJobFile(cwd, id));
  const busy = await askParentQuestion(cwd, id, { question: "Another question?", options: ["Later"], callId: "busy-call" });
  assert.equal(busy.resolution, "busy");
  const busySaved = readJobFile(resolveJobFile(cwd, id));
  assert.deepEqual(busySaved.pendingQuestion, waiting.pendingQuestion); assert.deepEqual(busySaved.lastQuestion, waiting.lastQuestion);
  assert.deepEqual(busySaved.questionHistory.at(-1), { id: busySaved.questionHistory.at(-1).id, callId: "busy-call", kind: "question", text: "Another question?", options: ["Later"],
    askedAt: new Date(now).toISOString(), answeredAt: null, answer: null, resolution: "busy" });
  controller.abort(); assert.equal((await held).resolution, "interrupted");
  const interrupted = readJobFile(resolveJobFile(cwd, id));
  assert.equal(interrupted.questionHistory.at(-1).callId, "held-call"); assert.equal(interrupted.questionHistory.at(-1).resolution, "interrupted");
  updateJob(cwd, id, () => ({ status: "interrupted" }));
  assert.equal((await askParentQuestion(cwd, id, { question: "Already stopped?", callId: "stopped-call" })).resolution, "interrupted");
  const stopped = readJobFile(resolveJobFile(cwd, id));
  assert.equal(stopped.questionHistory.at(-1).callId, "stopped-call"); assert.equal(stopped.questionHistory.at(-1).resolution, "interrupted");
  assert.equal(stopped.questionHistory.length, 20); assert.deepEqual(stopped.lastQuestion, interrupted.lastQuestion); assert.equal(stopped.pendingQuestion, null);
  assert.equal(itemActivity({ type: "mcpToolCall", id: "mcp-call", tool: "ask_parent" }, "completed", new Map(), "mcp-call")[0].callId, "mcp-call");

  // An abandoned bridge's question is invisible once expired, then reclaimed
  // by admission. Its delayed finally must leave the replacement approval alone.
  const { progressSnapshot } = await import('../plugins/codex/scripts/lib/job-runtime.mjs');
  updateJob(cwd, id, () => ({ status: "running" }));
  const abandoned = askParentQuestion(cwd, id, { question: "Bridge question?", callId: "abandoned-call" });
  const expired = readJobFile(resolveJobFile(cwd, id)).pendingQuestion;
  now = expired.expiresAt;
  const snapshot = progressSnapshot(readJobFile(resolveJobFile(cwd, id)));
  assert.equal(snapshot.status, "running"); assert.equal(snapshot.phase, "running");
  assert.equal(snapshot.question, undefined);
  assert.throws(() => answerQuestion(cwd, id, expired.id, "Too late", "owner"));
  const replacement = askParentQuestion(cwd, id, { question: "Approve replacement?", kind: "approval" });
  const admitted = readJobFile(resolveJobFile(cwd, id)).pendingQuestion;
  assert.notEqual(admitted.id, expired.id);
  assert.equal((await abandoned).resolution, "timeout");
  const preserved = readJobFile(resolveJobFile(cwd, id));
  assert.deepEqual(preserved.pendingQuestion, admitted); assert.equal(preserved.phase, "needs_answer");
  assert.deepEqual(preserved.questionHistory.filter(entry => entry.id === expired.id).map(entry => entry.resolution), ["expired"]);
  assert.equal((await askParentQuestion(cwd, id, { question: "Competing question?" })).resolution, "busy");
  assert.deepEqual(readJobFile(resolveJobFile(cwd, id)).pendingQuestion, admitted);
  answerQuestion(cwd, id, admitted.id, "deny", "owner");
  assert.equal((await replacement).resolution, "answered");
  const resolved = readJobFile(resolveJobFile(cwd, id));
  assert.equal(resolved.pendingQuestion, null); assert.equal(resolved.phase, "running");
});

test("an answer accepted before the deadline survives a worker poll after the deadline unless stopped", async t => {
  const cwd = makeTempDir();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  for (const stop of [null, "cancel", "abort"]) {
    const id = `deadline-${stop ?? "answered"}`, controller = new AbortController();
    writeJobFile(cwd, id, { id, status: "running", ownerId: "owner", questionTimeoutSec: 1 });
    const reply = askParentQuestion(cwd, id, { question: "Which way?" }, { signal: controller.signal });
    const pending = readJobFile(resolveJobFile(cwd, id)).pendingQuestion;
    now = pending.expiresAt - 1;
    assert.equal(answerQuestion(cwd, id, pending.id, "Use the accepted answer\nwith details", "owner").pendingQuestion.answer, "Use the accepted answer\nwith details");
    if (stop === "cancel") updateJob(cwd, id, () => ({ cancelRequested: { reason: "cancelled_by_user" } }));
    if (stop === "abort") controller.abort();
    now = pending.expiresAt + 1;
    const result = await reply;
    assert.equal(result.resolution, stop ? "interrupted" : "answered");
    if (!stop) assert.equal(result.text, "Use the accepted answer\nwith details");
    const saved = readJobFile(resolveJobFile(cwd, id));
    assert.equal(saved.pendingQuestion, null); assert.equal(saved.lastQuestion.resolution, result.resolution);
  }
});

test("per-job owners ignore ambient identity; adoption transfers the same turn and rejects the old owner", async () => {
  const f = fixture("w5-parent"); f.env.CODEX_COMPANION_OWNER_ID = "ambient-owner";
  const first = json(f.call("task", "--detached", "--json", "--lease-sec", "180", "first"));
  const second = json(f.call("task", "--detached", "--json", "second"));
  assert.notEqual(first.ownerId, second.ownerId); assert.notEqual(first.ownerId, "fixture-session"); assert.notEqual(first.ownerId, "ambient-owner");
  assert.equal(first.sessionId, "fixture-session");
  assert.equal(job(f, first.jobId).dispatchSessionId, "fixture-session");
  const initial = job(f, first.jobId).leaseExpiresAt;
  f.call("status", "--json"); f.call("result", first.jobId, "--json", "--report");
  json(f.call("wait", first.jobId, "--timeout-sec", "1", "--json"));
  json(f.call("status", first.jobId, "--owner", second.ownerId, "--json"));
  assert.equal(job(f, first.jobId).leaseExpiresAt, initial);
  // Orphan thresholds are covered with an explicit clock in the pause-policy test.
  // An old wait already in flight must notice rotation, too.
  const pending = json(f.call("wait", first.jobId, "--owner", first.ownerId, "--json"));
  const refused = direct(f.call("task", "--thread", first.threadId, "--direct", "follow-up"), 2);
  const ownerReport = json(f.call("result", first.jobId));
  const blocker = refused.blockers.find(blocker => blocker.code === "thread_busy");
  assert.equal(refused.next, ownerReport.next);
  for (const key of ["id", "kind", "text", "options"]) assert.deepEqual(blocker.question[key], ownerReport.question[key]);
  assert.ok(Number.isInteger(blocker.question.expiresInSec));
  assert.equal(refused.details.includes(refused.jobId), true);
  for (const directMode of [true]) {
    const rejected = run(process.execPath, [script, "answer", first.jobId, "--owner", "unrelated-owner", "--question", pending.question.id,
      ...(directMode ? ["--direct", "--quiet"] : ["--json"])], { cwd: f.repo, env: f.env, input: "Do not deliver" });
    assert.equal(rejected.status, 1);
    assert.equal(job(f, first.jobId).pendingQuestion.answer, undefined);
  }
  const guardedCwd = makeTempDir();
  for (const stopping of [false, true]) {
    const guarded = { id: `guarded-answer-${stopping}`, jobClass: "task", status: "running", workspaceRoot: guardedCwd, pid: process.pid,
      ownerId: "owner", leaseExpiresAt: stopping ? Date.now() + 60000 : Date.now() - 1,
      ...(stopping ? { cancelRequested: { reason: "cancelled_by_user" } } : {}),
      pendingQuestion: { id: "question", text: "Choose?", options: [], expiresAt: Date.now() + 60000 } };
    writeJobFile(guardedCwd, guarded.id, guarded); upsertJob(guardedCwd, guarded);
    for (const directMode of [true]) {
      const rejected = run(process.execPath, [script, "answer", guarded.id, "--owner", guarded.ownerId, "--question", "question",
        ...(directMode ? ["--direct", "--quiet"] : ["--json"])], { cwd: guardedCwd, input: "Do not deliver" });
      assert.equal(rejected.status, 1);
      assert.equal(readJobFile(resolveJobFile(guardedCwd, guarded.id)).pendingQuestion.answer, undefined);
    }
  }
  const oldWait = spawnOwned(process.execPath, [script, "wait", first.jobId, "--owner", first.ownerId, "--after-question", pending.question.id, "--timeout-sec", "30", "--json"], { cwd: f.repo, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
  let oldOutput = ""; oldWait.stdout.on("data", chunk => { oldOutput += chunk; });
  const oldDone = new Promise((resolve, reject) => { oldWait.on("close", resolve); oldWait.on("error", reject); });
  await waitUntil(() => storedJob(f, first.jobId).ownerAttached);
  f.env.CODEX_COMPANION_SESSION_ID = "replacement-session";
  const adopted = json(f.call("adopt", first.jobId, "--json"));
  assert.equal(adopted.status, "adopted"); assert.equal(adopted.adopted, true);
  assert.notEqual(adopted.ownerId, first.ownerId); assert.equal(adopted.sessionId, "replacement-session");
  assert.equal(job(f, first.jobId).dispatchSessionId, "fixture-session", "Adoption must not rewrite dispatch provenance");
  assert.equal(adopted.threadId, pending.threadId); assert.equal(adopted.turnId, pending.turnId);
  assert.ok(adopted.waitCommand.includes(`wait '${first.jobId}' --owner '${adopted.ownerId}'`));
  assert.equal(await oldDone, 2); assert.equal(JSON.parse(oldOutput).status, "ownership_moved");
  const initialAdopted = job(f, first.jobId).leaseExpiresAt;
  for (const cmd of ["status", "wait"]) {
    const moved = json(f.call(cmd, first.jobId, "--owner", first.ownerId, "--json"), 2);
    assert.equal(moved.status, "ownership_moved"); assert.equal(moved.ownerId, adopted.ownerId);
  }
  const rejectedAnswer = run(process.execPath, [script, "answer", first.jobId, "--owner", first.ownerId, "--question", pending.question.id, "--json"], { cwd: f.repo, env: f.env, input: "Do not deliver" });
  assert.equal(json(rejectedAnswer, 2).status, "ownership_moved");
  assert.equal(job(f, first.jobId).pendingQuestion.answer, undefined);
  assert.equal(job(f, first.jobId).leaseExpiresAt, initialAdopted);
  assert.equal(json(f.call("status", "--json")).running.some(j => j.id === first.jobId), true);
  const attached = json(f.call("wait", first.jobId, "--owner", adopted.ownerId, "--json"));
  assert.equal(attached.status, "needs_answer"); assert.equal(attached.orphaned, false);
  assert.equal(attached.questionMessage, pending.questionMessage);
  assert.deepEqual(attached.activity, [], "Adoption inherits the last delivered owner cursor");
  assert.equal(attached.cursor, pending.cursor);
  assert.ok(job(f, first.jobId).leaseExpiresAt > initialAdopted);
  const renewed = job(f, first.jobId).leaseExpiresAt;
  json(f.call("status", first.jobId, "--owner", adopted.ownerId, "--json"));
  assert.ok(job(f, first.jobId).leaseExpiresAt > renewed);
  const answer = run(process.execPath, [script, "answer", first.jobId, "--owner", adopted.ownerId, "--question", attached.question.id, "--json"], { cwd: f.repo, env: f.env, input: "Small" });
  assert.equal(json(answer).status, "answer_submitted");
  const done = json(f.call("wait", first.jobId, "--owner", adopted.ownerId, "--json"));
  assert.equal(done.status, "completed"); assert.equal(done.turnId, attached.turnId);
  assert.equal(f.state().nextTurnId, 3, "Adoption does not submit a new turn");
  json(f.call("cancel", second.jobId, "--json"));
});

test("task --continue resumes the job's thread with its recorded authorization and a parent bridge", async () => {
  const f = fixture("task-ok");
  const first = json(f.call("task", "--detached", "--json", "--sandbox", "workspace-write", "first assignment"));
  const done = json(f.call("wait", first.jobId, "--json", "--report"));
  assert.equal(done.status, "completed"); assert.equal(done.sandbox, "workspace-write");
  for (const extra of [["--sandbox", "read-only"]]) {
    const rejected = f.call("task", "--continue", first.jobId, ...extra, "--json");
    assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /--continue/);
  }

  const second = json(f.call("task", "--continue", first.jobId, "--follow", "--report", "--json", "continue with the next step"));
  assert.equal(second.status, "completed"); assert.notEqual(second.jobId, first.jobId); assert.equal(second.threadId, done.threadId);
  assert.equal(second.sandbox, "workspace-write", "the original job's narrowed sandbox is inherited, not the full-access default");
  const resume = f.state().lastThreadResume;
  assert.equal(resume.threadId, done.threadId); assert.equal(resume.sandbox, "workspace-write");
  const bridge = resume.config.mcp_servers.duet_parent;
  assert.equal(bridge.command, process.execPath); assert.match(bridge.args[0], /parent-bridge-mcp\.mjs$/);
  assert.equal(bridge.env[PARENT_BRIDGE_ENV.threadId], done.threadId, "the bridge is bound to the thread, not the job"); assert.equal(bridge.env[PARENT_BRIDGE_ENV.cwd], f.repo);
  assert.equal(fs.realpathSync(bridge.env.CODEX_COMPANION_HOME), fs.realpathSync(f.env.CODEX_COMPANION_HOME), "the bridge reaches job state through the isolated home"); assert.equal(bridge.tool_timeout_sec, 900 + 120);
  assert.equal(Object.keys(bridge.env).filter(k => !["CODEX_COMPANION_HOME", "TMPDIR", PARENT_BRIDGE_ENV.threadId, PARENT_BRIDGE_ENV.cwd].includes(k)).length, 0, "no other environment leaks into the bridge");
  assert.deepEqual(bridge.omit_tools_from, ["code_mode", "deferred"], "the tool must stay out of the deferred set or the model never sees it");
  assert.equal(bridge.tools.ask_parent.approval_mode, "approve", "approvalPolicy never would otherwise reject the call");
  assert.match(f.state().lastTurnStart.prompt, /continue with the next step/);
  assert.equal(job(f, second.jobId).request.continuedFrom, first.jobId);
  const start = f.state().lastThreadStart;
  assert.deepEqual(start.config.mcp_servers.duet_parent, { ...bridge, env: {
    [PARENT_BRIDGE_ENV.cwd]: f.repo, [PARENT_BRIDGE_ENV.jobId]: first.jobId,
    CODEX_COMPANION_HOME: bridge.env.CODEX_COMPANION_HOME,
    ...(f.env.TMPDIR ? { TMPDIR: f.env.TMPDIR } : {})
  } }, "new threads use the bridge with only the job handle and state-location variables");
  assert.equal(Object.hasOwn(start, "dynamicTools"), false);
  // An older runtime rejects the bridge override, then the dynamic registration.
  const fallback = fixture("task-ok", { mutable: true }), binary = path.join(fallback.dir, "codex");
  fs.writeFileSync(path.join(fallback.repo, "CLAUDE.md"), "PROJECT_RULE\n");
  fs.writeFileSync(binary, fs.readFileSync(binary, "utf8").replace('case "thread/start": {', `case "thread/start": {
    state.startRegistrations = [...(state.startRegistrations || []), [Boolean(message.params.config), Boolean(message.params.dynamicTools)]];
    saveState(state);
    if (message.params.config || message.params.dynamicTools) {
      send({ id: message.id, error: { code: -32602, message: message.params.config ? "unknown field config" : "dynamicTools unsupported" } });
      break;
    }`));
  const compatible = fallback.call("task", "--follow", "--report", "--json", "--effort", "high", "compatibility fallback");
  assert.deepEqual({ exit: compatible.status, registrations: fallback.state().startRegistrations },
  { exit: 0, registrations: [[true, false], [false, true], [false, false]] });
  const review = fallback.call("review", "--scope", "working-tree", "--json");
  assert.deepEqual({ exit: review.status, registrations: fallback.state().startRegistrations.slice(3) },
    { exit: 0, registrations: [[true, false], [false, false]] });

  // Unrelated errors, including serde's list of accepted fields, are not registration rejections.
  for (const originalError of ["unknown field `serviceName`, expected one of `cwd`, `model`, `config`, `dynamicTools`"]) {
    const unrelated = fixture("task-ok", { mutable: true }), unrelatedBinary = path.join(unrelated.dir, "codex");
    fs.writeFileSync(unrelatedBinary, fs.readFileSync(unrelatedBinary, "utf8").replace('case "thread/start": {', `case "thread/start": {
    state.startAttempts = (state.startAttempts || 0) + 1; saveState(state);
    if (state.startAttempts === 1) {
      send({ id: message.id, error: { code: -32602, message: ${JSON.stringify(originalError)} } }); break;
    }`));
    const failed = json(unrelated.call("task", "--follow", "--report", "--json", "unrelated model error"), 1);
    const failedJob = job(unrelated, failed.jobId);
    assert.deepEqual({ attempts: unrelated.state().startAttempts, status: failedJob.status, error: failedJob.errorMessage },
      { attempts: 1, status: "failed", error: originalError });
  }
});

test("the parent bridge answers ask_parent through the job file and reports cancellation", async t => {
  const { updateState } = await import("../plugins/codex/scripts/lib/state.mjs");
  const previousHome = process.env.CODEX_COMPANION_HOME;
  process.env.CODEX_COMPANION_HOME = path.join(makeTempDir(), "isolated");
  t.after(() => { process.env.CODEX_COMPANION_HOME = previousHome; });
  // An unrelated index-less leftover makes the inventory incomplete; exact turn
  // ownership must still route questions instead of disabling the tool.
  const leftover = path.join(process.env.CODEX_COMPANION_HOME, "duet", "state", "leftover", "jobs");
  fs.mkdirSync(leftover, { recursive: true }); fs.writeFileSync(path.join(leftover, "stray.json"), "{}");
  const openBridge = (cwd, env) => {
    const bridge = spawnOwned(process.execPath, [bridgeScript], { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    t.after(() => { if (alive(bridge.pid)) bridge.kill(); });
    const replies = []; let buffer = "";
    bridge.stdout.on("data", chunk => { buffer += chunk; let i; while ((i = buffer.indexOf("\n")) >= 0) { replies.push(JSON.parse(buffer.slice(0, i))); buffer = buffer.slice(i + 1); } });
    return { bridge, send: message => bridge.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`), reply: id => waitUntil(() => replies.find(r => r.id === id)) };
  };
  for (const binding of ["jobId"]) {
    const cwd = makeTempDir(), id = "bridge-job", threadId = `thread-bridge-${binding}`, turnId = "turn-bridge";
    writeJobFile(cwd, id, { id, status: "running", jobClass: "task", workspaceRoot: cwd, ownerId: "owner", questionTimeoutSec: 5,
      threadId: binding === "threadId" ? threadId : null, turnId });
    upsertJob(cwd, { id, status: "running", jobClass: "task", workspaceRoot: cwd,
      threadId: binding === "threadId" ? threadId : null, turnId, createdAt: "2026-01-01T00:00:00.000Z" });
    const otherCwd = makeTempDir(), queued = "bridge-queued";
    const reservation = { id: queued, status: "queued", jobClass: "task", workspaceRoot: otherCwd,
      threadId, sessionId: "other-session", createdAt: "2026-02-01T00:00:00.000Z" };
    writeJobFile(otherCwd, queued, reservation); upsertJob(otherCwd, reservation);
    const { bridge, send, reply } = openBridge(cwd, { [PARENT_BRIDGE_ENV.cwd]: cwd, [PARENT_BRIDGE_ENV[binding]]: binding === "threadId" ? threadId : id });
    bridge.stdin.write('null\n[]\ntrue\n42\n"text"\n');
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    assert.equal((await reply(1)).result.serverInfo.name, "duet-parent-bridge");
    send({ method: "notifications/initialized" });
    send({ id: 2, method: "tools/list" });
    assert.deepEqual((await reply(2)).result.tools.map(t => t.name), ["ask_parent"]);
    if (binding === "jobId") {
      send({ id: 10, method: "tools/call", params: { name: "ask_parent", arguments: { question: "Thread recorded yet?" }, _meta: { threadId } } });
      assert.equal((await reply(10)).result.isError, true, "metadata cannot supply a missing bound thread");
      updateJob(cwd, id, () => ({ threadId }));
    }
    send({ id: 11, method: "tools/call", params: { name: "ask_parent", arguments: { question: "Wrong thread?" }, _meta: { threadId: "other-thread" } } });
    assert.equal((await reply(11)).result.isError, true);
    send({ id: 3, method: "tools/call", params: { name: "ask_parent", arguments: { question: "Which way?", options: ["A", "B"] },
      _meta: { threadId, callId: "call_bridge_3", "x-codex-turn-metadata": { turn_id: turnId } } } });
    const pending = await waitUntil(() => readJobFile(resolveJobFile(cwd, id)).pendingQuestion);
    assert.equal(pending.text, "Which way?"); assert.deepEqual(pending.options, ["A", "B"]);
    assert.equal(readJobFile(resolveJobFile(otherCwd, queued)).pendingQuestion, undefined, "an unadmitted reservation cannot receive another turn's question");
    answerQuestion(cwd, id, pending.id, "Go with A", "owner");
    const answered = await reply(3);
    assert.equal(answered.result.isError, false); assert.equal(answered.result.content[0].text, "Go with A");
    assert.equal(readJobFile(resolveJobFile(cwd, id)).questionHistory.at(-1).callId, "call_bridge_3");
    for (const [requestId, separator] of [[9, "\u2029"]]) {
      const question = `Which${separator}way?`;
      const wire = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method: "tools/call", params: { name: "ask_parent", arguments: { question },
        ...(requestId === 9 ? { _meta: { callId: "invalid/call" } } : {}) } })}\r\n`);
      const cut = wire.indexOf(Buffer.from(separator)) + 1;
      bridge.stdin.write(wire.subarray(0, cut));
      bridge.stdin.write(wire.subarray(cut));
      const unicodePending = await waitUntil(() => {
        const current = readJobFile(resolveJobFile(cwd, id)).pendingQuestion;
        return current?.text === question && current;
      });
      answerQuestion(cwd, id, unicodePending.id, "Go with B", "owner");
      const unicodeReply = await reply(requestId);
      assert.equal(unicodeReply.result.isError, false);
      assert.equal(unicodeReply.result.content[0].text, "Go with B");
      assert.equal(readJobFile(resolveJobFile(cwd, id)).questionHistory.at(-1).callId, null, "missing or invalid metadata never falls back to the RPC id");
    }
    send({ id: 4, method: "tools/call", params: { name: "ask_parent", arguments: { question: "x".repeat(1001) } } });
    assert.equal((await reply(4)).result.isError, true);
    updateJob(cwd, id, () => ({ cancelRequested: { reason: "cancelled_by_user", at: new Date().toISOString() } }));
    send({ id: 5, method: "tools/call", params: { name: "ask_parent", arguments: { question: "Still there?" } } });
    assert.equal((await reply(5)).result.isError, false);
    // The broker keeps a thread loaded across runs, so one bridge process outlives
    // the job that spawned it: once that job is over, calls bind to the thread's
    // turn owner, and with none active the tool reports it instead of hanging.
    updateJob(cwd, id, () => ({ status: "completed", cancelRequested: null }));
    upsertJob(cwd, { id, status: "completed" });
    send({ id: 6, method: "tools/call", params: { name: "ask_parent", arguments: { question: "Anyone?" } } });
    const nobody = await reply(6);
    assert.equal(nobody.result.isError, true);
    const next = "bridge-job-2";
    writeJobFile(cwd, next, { id: next, status: "running", jobClass: "task", workspaceRoot: cwd, ownerId: "owner-2", questionTimeoutSec: 5, threadId, turnId: "turn-next" });
    upsertJob(cwd, { id: next, status: "running", jobClass: "task", workspaceRoot: cwd, threadId, turnId: "turn-next", createdAt: "2026-01-02T00:00:00.000Z" });
    send({ id: 7, method: "tools/call", params: { name: "ask_parent", arguments: { question: "Next job?" } } });
    const nextPending = await waitUntil(() => readJobFile(resolveJobFile(cwd, next)).pendingQuestion);
    assert.equal(nextPending.text, "Next job?"); assert.equal(readJobFile(resolveJobFile(cwd, id)).pendingQuestion, null, "the finished job is left alone");
    answerQuestion(cwd, next, nextPending.id, "Yes", "owner-2");
    assert.equal((await reply(7)).result.content[0].text, "Yes");

    const originFile = resolveJobFile(cwd, id);
    updateState(cwd, state => { state.jobs = state.jobs.filter(job => job.id !== id); });
    assert.equal(fs.existsSync(originFile), false, "the starting record is deleted after the bridge has bound its thread");
    const cross = "bridge-cross-workspace";
    const crossJob = { id: cross, status: "running", jobClass: "task", workspaceRoot: otherCwd,
      ownerId: "owner-cross", questionTimeoutSec: 5, threadId, turnId: null };
    writeJobFile(otherCwd, cross, crossJob); upsertJob(otherCwd, crossJob);
    send({ id: 12, method: "tools/call", params: { name: "ask_parent", arguments: { question: "Other workspace?" },
      _meta: { threadId, "x-codex-turn-metadata": { turn_id: "turn-cross" } } } });
    // The first lookup has run before this ping; publish the accepted turn while
    // its question waits, without asserting a timing threshold.
    send({ id: 13, method: "ping" }); await reply(13);
    updateJob(otherCwd, cross, () => ({ turnId: "turn-cross" }));
    const crossPending = await waitUntil(() => readJobFile(resolveJobFile(otherCwd, cross)).pendingQuestion);
    assert.equal(crossPending.text, "Other workspace?");
    answerQuestion(otherCwd, cross, crossPending.id, "Cross-workspace answer", "owner-cross");
    assert.equal((await reply(12)).result.content[0].text, "Cross-workspace answer");

    for (const [requestId, meta] of [[14, undefined], [15, { "x-codex-turn-metadata": { turn_id: "invalid/turn" } }]]) {
      send({ id: requestId, method: "tools/call", params: { name: "ask_parent", arguments: { question: "Ambiguous owner?" }, _meta: meta } });
      assert.equal((await reply(requestId)).result.isError, true, "missing or invalid turn metadata cannot choose between admitted owners");
    }
    bridge.stdin.end();
    await waitUntil(() => !alive(bridge.pid));
  }

  // A loaded bridge keeps its thread even when no turn asked before the starting
  // record was pruned: it captures the binding once the thread is recorded.
  const coldCwd = makeTempDir(), origin = "cold-origin", coldThread = "thread-cold";
  const originJob = { id: origin, status: "running", jobClass: "task", workspaceRoot: coldCwd, threadId: null, createdAt: "2026-03-01T00:00:00.000Z" };
  writeJobFile(coldCwd, origin, originJob); upsertJob(coldCwd, originJob);
  const cold = openBridge(coldCwd, { [PARENT_BRIDGE_ENV.cwd]: coldCwd, [PARENT_BRIDGE_ENV.jobId]: origin });
  cold.send({ id: 1, method: "tools/list" }); await cold.reply(1);
  updateJob(coldCwd, origin, () => ({ threadId: coldThread, status: "completed" }));
  cold.send({ id: 2, method: "ping" }); await cold.reply(2);
  updateState(coldCwd, state => { state.jobs = state.jobs.filter(job => job.id !== origin); });
  assert.equal(fs.existsSync(resolveJobFile(coldCwd, origin)), false);
  const current = { id: "cold-current", status: "running", jobClass: "task", workspaceRoot: coldCwd, ownerId: "owner-cold", questionTimeoutSec: 5,
    threadId: coldThread, turnId: "turn-cold", createdAt: "2026-03-02T00:00:00.000Z" };
  writeJobFile(coldCwd, current.id, current); upsertJob(coldCwd, current);
  cold.send({ id: 3, method: "tools/call", params: { name: "ask_parent", arguments: { question: "First question?" },
    _meta: { threadId: coldThread, "x-codex-turn-metadata": { turn_id: "turn-cold" } } } });
  const coldPending = await waitUntil(() => readJobFile(resolveJobFile(coldCwd, current.id)).pendingQuestion);
  answerQuestion(coldCwd, current.id, coldPending.id, "Still bound", "owner-cold");
  assert.equal((await cold.reply(3)).result.content[0].text, "Still bound");
  cold.bridge.stdin.end();
  await waitUntil(() => !alive(cold.bridge.pid));

  // Accepted answers survive a bridge crash only for an exact retry; another
  // call must not receive the orphaned answer.
  {
    const cwd = makeTempDir(), id = "bridge-orphan", threadId = "thread-orphan", turnId = "turn-orphan";
    const record = { id, status: "running", jobClass: "task", workspaceRoot: cwd, ownerId: "owner", questionTimeoutSec: 60, threadId, turnId };
    writeJobFile(cwd, id, record); upsertJob(cwd, record);
    const env = { [PARENT_BRIDGE_ENV.cwd]: cwd, [PARENT_BRIDGE_ENV.threadId]: threadId };
    const call = (rpcId, callId) => ({ id: rpcId, method: "tools/call", params: { name: "ask_parent", arguments: { question: "Choose?" },
      _meta: { threadId, callId, "x-codex-turn-metadata": { turn_id: turnId } } } });
    const read = () => readJobFile(resolveJobFile(cwd, id));
    const first = openBridge(cwd, env);
    first.send(call(1, "original-call"));
    const pending = await waitUntil(() => read().pendingQuestion);
    assert.equal(pending.caller.pid, first.bridge.pid); assert.equal(typeof pending.caller.nonce, "string");
    first.bridge.kill("SIGSTOP");
    answerQuestion(cwd, id, pending.id, "Original answer", "owner");
    const exited = new Promise(resolve => first.bridge.once("exit", resolve));
    first.bridge.kill("SIGKILL"); await exited;
    const replacement = openBridge(cwd, env);
    replacement.send(call(2, "different-call"));
    await replacement.reply(2);
    assert.equal(read().pendingQuestion.id, pending.id);
    assert.equal(read().questionHistory.at(-1).resolution, "busy");
    assert.notEqual((await replacement.reply(2)).result.content[0].text, "Original answer");
    replacement.send(call(3, "original-call"));
    assert.equal((await replacement.reply(3)).result.content[0].text, "Original answer");
    assert.equal(read().pendingQuestion, null);
    assert.equal(read().questionHistory.filter(entry => entry.id === pending.id && entry.resolution === "answered").length, 1);
    updateJob(cwd, id, () => ({ pendingQuestion: { ...pending, id: "expired-orphan", expiresAt: Date.now() - 1, answer: "EXPIRED_ANSWER" } }));
    replacement.send(call(4, "next-call"));
    const next = await waitUntil(() => { const question = read().pendingQuestion; return question && question.id !== pending.id && question.id !== "expired-orphan" && question; });
    assert.equal(next.caller.pid, replacement.bridge.pid); assert.notEqual(next.caller.nonce, pending.caller.nonce);
    assert.equal(next.answer, undefined);
    assert.equal(read().questionHistory.find(entry => entry.id === "expired-orphan").resolution, "orphaned");
    answerQuestion(cwd, id, next.id, "New answer", "owner");
    assert.equal((await replacement.reply(4)).result.content[0].text, "New answer");
    replacement.bridge.stdin.end();
    await waitUntil(() => !alive(replacement.bridge.pid));
  }
});

function startQuestionCommand(f, command, input = "") {
  const child = spawnOwned(process.execPath, splitRawArgumentString(command).slice(1), { cwd: f.repo, env: f.env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  const result = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", status => resolve({ status, stdout, stderr }));
  });
  child.stdin.end(input);
  return { child, result };
}

// Extend only the generated fixture, keeping the shared fake runtime unchanged.
function changeQuestionReply(f, code) {
  const binary = path.join(f.dir, "codex"), source = fs.readFileSync(binary, "utf8");
  const marker = '      if (!serverRequests.size && state.lastInterrupt?.turnId !== pending.turnId) emitTurnCompleted';
  assert.ok(source.includes(marker));
  fs.writeFileSync(binary, source.replace(marker, `${code}\n${marker}`));
}

test("fugato answers a named pending worker once and retains owner and sole-wait protections", async () => {
  const f = fixture("w5-parent", { mutable: true }), gate = path.join(f.dir, "answer-finish");
  const duet = new URL("../plugins/codex/bin/duet", import.meta.url).pathname;
  changeQuestionReply(f, `      while (!fs.existsSync(${JSON.stringify(gate)})) await new Promise(resolve => setTimeout(resolve, 25));`);
  const compact = direct(f.call("task", "--direct", "--owner", "parent's owner", "fixture"));
  const pending = json(f.call("result", compact.jobId, "--details"));
  assert.equal(pending.status, "needs_answer");
  const before = job(f, pending.jobId);
  const read = () => readJobFile(before.logFile.replace(/\.log$/, ".json"));
  const wrongOwner = splitRawArgumentString(pending.answerAndWaitCommand).slice(1);
  wrongOwner[wrongOwner.indexOf("--owner") + 1] = "unrelated-owner";
  directError(run(process.execPath, wrongOwner, { cwd: f.repo, env: f.env, input: "rejected" }));
  assert.equal(read().pendingQuestion.answer, undefined);
  assert.equal(read().ownerAttached, false);
  assert.equal(f.state().serverRequestReplies?.length ?? 0, 0);

  const answer = "Small PRIVATE_FIXTURE_ANSWER\nKeep $(literal) and `literal` text.";
  const owner = startQuestionCommand(f, `node "${duet}" answer ${pending.agentName.toLowerCase()}`, answer);
  try {
    await waitUntil(() => f.state().serverRequestReplies?.length === 1);
    const attached = read();
    assert.equal(attached.ownerAttached, true);
    assert.equal(attached.ownerWaitPid, owner.child.pid);
    directError(run(duet, ["wait", pending.agentName], { cwd: f.repo, env: f.env }));
    directError(run(duet, ["answer", pending.agentName], { cwd: f.repo, env: f.env, input: "retry" }));
    const protectedOwner = read();
    assert.equal(protectedOwner.ownerAttached, true);
    assert.equal(protectedOwner.ownerWaitToken, attached.ownerWaitToken);
    assert.equal(protectedOwner.ownerId, pending.ownerId);
    assert.equal(f.state().serverRequestReplies.length, 1);
    await waitUntil(() => read().leaseRenewedAt > attached.leaseRenewedAt);
    fs.writeFileSync(gate, "finish");
    const output = await owner.result, done = direct(output), saved = read();
    assert.equal(done.status, "completed"); assert.equal(saved.turnId, "turn_1");
    assert.equal(saved.ownerAttached, false); assert.equal(saved.ownerDetachReason, "returned");
    assert.equal(saved.leaseSec, before.leaseSec);
    assert.equal(saved.result.interruptionReason, null);
    assert.equal(f.state().lastInterrupt, null);
    assert.equal(f.state().nextTurnId, 2);
    assert.equal(f.state().serverRequestReplies.length, 1);
    assert.equal(f.state().serverRequestReplies[0].result.contentItems[0].text, answer);
    assert.equal(saved.questionHistory.at(-1).resolution, "answered");
    assert.equal(saved.questionHistory.at(-1).answer, answer);
    assert.equal(saved.pendingQuestion, null);
    assert.doesNotMatch(fs.readFileSync(saved.logFile, "utf8"), /PRIVATE_FIXTURE_ANSWER/);
    assert.doesNotMatch(output.stdout, /PRIVATE_FIXTURE_ANSWER/);
  } finally {
    fs.writeFileSync(gate, "finish");
    owner.child.kill("SIGTERM");
    await owner.result;
  }
  directError(run(duet, ["answer", pending.jobId], { cwd: f.repo, env: f.env, input: "Already answered." }));
  assert.equal(f.state().serverRequestReplies.length, 1);

});

test("a SIGKILLed owner wait is replaced by wait and answer --direct without interrupting the turn", async () => {
  const f = fixture("w5-parent"), compact = direct(f.call("task", "--direct", "fixture"));
  const pending = json(f.call("result", compact.jobId, "--details"));
  const jobFile = job(f, pending.jobId).logFile.replace(/\.log$/, ".json");
  const read = () => readJobFile(jobFile);
  const waits = [];
  try {
    const first = startQuestionCommand(f, pending.waitCommand); waits.push(first);
    const original = await waitUntil(() => { const current = read(); return current.ownerAttached && current.ownerWaitPid === first.child.pid && current; });
    assert.ok(original.ownerWaitToken);
    first.child.kill("SIGKILL"); await first.result;
    assert.equal(first.child.signalCode, "SIGKILL");

    const replacement = startQuestionCommand(f, pending.waitCommand); waits.push(replacement);
    const recovered = await waitUntil(() => { const current = read(); return current.ownerAttached && current.ownerWaitPid === replacement.child.pid && current; });
    assert.equal(recovered.ownerId, pending.ownerId);
    assert.notEqual(recovered.ownerWaitToken, original.ownerWaitToken);
    await waitUntil(() => read().leaseRenewedAt > recovered.leaseRenewedAt);
    assert.equal(read().status, "running");
    assert.equal(f.state().lastInterrupt, null);

    replacement.child.kill("SIGKILL"); await replacement.result;
    assert.equal(replacement.child.signalCode, "SIGKILL");
    const answering = startQuestionCommand(f, pending.answerAndWaitCommand, "Small"); waits.push(answering);
    const done = direct(await answering.result), saved = read();
    assert.equal(done.status, "completed"); assert.equal(saved.turnId, "turn_1");
    assert.equal(saved.ownerWaitPid, answering.child.pid);
    assert.notEqual(saved.ownerWaitToken, recovered.ownerWaitToken);
    assert.equal(saved.ownerId, pending.ownerId);
    assert.equal(saved.ownerAttached, false); assert.equal(saved.ownerDetachReason, "returned");
    assert.equal(saved.result.interruptionReason, null);
    assert.equal(f.state().lastInterrupt, null);
    assert.equal(f.state().nextTurnId, 2);
    assert.equal(f.state().serverRequestReplies.length, 1);
    assert.equal(f.state().serverRequestReplies[0].result.contentItems[0].text, "Small");
  } finally {
    for (const wait of waits) wait.child.kill("SIGTERM");
    await Promise.all(waits.map(wait => wait.result));
  }
});
