import fs from "node:fs";
import path from "node:path";
import { spawnOwned as spawn } from "../plugins/codex/scripts/lib/process.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { run, initGitRepo, waitForCondition, readyBroker } from "./helpers.mjs";
import { workerReportHarness } from "./fake-codex-fixture.mjs";
import { splitRawArgumentString } from "../plugins/codex/scripts/lib/args.mjs";

const {
  script, stateModule, fixture, storedFixtureJob, recoveryBaseline, loseTurn, directJson, callAsync, checkDecisionReport
} = await workerReportHarness();

test("owned and later waits keep a lost turn running until its exact outcome is available", () => {
  const f = fixture("lost-turn:inProgress");
  const launched = f.call("task", "--direct", "--quiet", "--timeout-sec", "1", "Hold the recorded turn open.");
  assert.equal(launched.status, 0, launched.stderr + launched.stdout);
  const running = directJson(launched), original = storedFixtureJob(f, running.jobId);
  assert.equal(running.status, "running");
  assert.ok(running.summary);
  assert.equal(running.next, running.blockers[0].recoveryCommand);
  assert.ok(running.blockers[0].cancelCommand);
  assert.equal(original.status, "failed", "the observation must not rewrite the wrapper outcome");

  const waited = f.call("wait", original.id, "--direct", "--details", "--quiet", "--timeout-sec", "1");
  assert.equal(waited.status, 0, waited.stderr + waited.stdout);
  const pending = directJson(waited);
  assert.equal(pending.status, "running");
  assert.equal(pending.recovery.status, "running");
  assert.ok(pending.recovery.recoveryCommand && pending.recovery.cancelCommand);
  assert.equal(pending.continuationCommand, undefined);

  const state = f.state();
  state.unreadable = true;
  fs.writeFileSync(path.join(f.dir, "fake-codex-state.json"), JSON.stringify(state));
  const unknown = f.call("wait", original.id, "--direct", "--quiet", "--timeout-sec", "1");
  assert.equal(unknown.status, 0, unknown.stderr + unknown.stdout);
  assert.equal(directJson(unknown).status, "running");
  assert.ok(directJson(unknown).blockers[0].recoveryCommand);

  state.unreadable = false;
  Object.assign(state.threads[0].turns[0], { status: "completed", completedAt: Math.floor(Date.now() / 1000),
    items: [{ id: "recovered-answer", type: "agentMessage", phase: "final_answer", text: JSON.stringify({
      status: "completed", summary: "Completed the recorded work.", key_findings: [], assumptions: [], verification: [], blockers: [], question: null
    }) }] });
  fs.writeFileSync(path.join(f.dir, "fake-codex-state.json"), JSON.stringify(state));
  const finished = f.call("wait", original.id, "--direct", "--quiet", "--timeout-sec", "1");
  assert.equal(finished.status, 0, finished.stderr + finished.stdout);
  assert.equal(directJson(finished).status, "completed");
  assert.equal(directJson(f.call("result", original.id, "--details")).status, "completed");
  assert.equal(f.state().nextTurnId, 2, "observation never submits another turn");
});

test("thread acceptance times out while a held turn acceptance keeps follow-ups from starting", async t => {
  const patchRuntime = (f, marker, replacement) => {
    const binary = path.join(f.dir, "codex"), source = fs.readFileSync(binary, "utf8");
    assert.ok(source.includes(marker));
    fs.writeFileSync(binary, source.replace(marker, replacement));
  };
  const configure = f => Object.assign(f.env, {
    CODEX_COMPANION_ACCEPTANCE_TIMEOUT_MS: "100",
    // A missing explicit endpoint selects a private runtime, whose exit the
    // contract can verify without waiting for a shared broker's idle policy.
    CODEX_COMPANION_APP_SERVER_ENDPOINT: `unix:${path.join(f.dir, "missing.sock")}`
  });
  const failTask = async (f, ...args) => {
    const task = callAsync(f, "task", "--report", "--json", ...args, "fixture");
    // A regression must fail the test and release its owned process, not hang
    // the test runner. This is a safety ceiling, not an elapsed-time assertion.
    const guard = setTimeout(() => task.child.kill("SIGTERM"), 10000);
    let response;
    try { response = await task.done; }
    finally { clearTimeout(guard); }
    assert.equal(response.status, 1, response.stderr + response.stdout);
    const id = /Job handle: ([^;]+)/.exec(response.stderr)?.[1];
    assert.ok(id, response.stderr);
    const saved = storedFixtureJob(f, id);
    assert.equal(saved.status, "failed");
    for (const { pid } of f.state().launches) {
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "private runtime was reaped");
    }
    return saved;
  };

  const turn = fixture("review-ok", { mutable: true });
  turn.env.CODEX_COMPANION_ACCEPTANCE_TIMEOUT_MS = "100";
  const gate = path.join(turn.dir, "release-acceptance"), waiting = path.join(turn.dir, "waiting-acceptance");
  patchRuntime(turn, "const state = loadState();\n\n  try {", "let state = loadState();\n\n  try {");
  patchRuntime(turn, 'case "turn/start": {', `case "turn/start": {
    fs.writeFileSync(${JSON.stringify(waiting)}, message.params.threadId);
    while (!fs.existsSync(${JSON.stringify(gate)})) await new Promise(resolve => setTimeout(resolve, 20));
    state = loadState();
  `);
  const broker = await readyBroker(turn.repo, turn.env);
  t.after(broker.close);
  t.after(() => fs.writeFileSync(gate, "release"));
  const held = callAsync(turn, "task", "--fresh", "--report", "--json", "fixture");
  const guard = setTimeout(() => held.child.kill("SIGTERM"), 10000);
  t.after(() => { clearTimeout(guard); held.child.kill("SIGTERM"); });
  await waitForCondition(() => fs.existsSync(waiting), "held turn/start");

  // This independent timeout crosses the same acceptance deadline while the
  // broker still holds turn/start. No sleep or elapsed-time assertion is needed.
  const start = fixture("review-ok", { mutable: true });
  configure(start);
  patchRuntime(start, 'case "thread/start": {', 'case "thread/start": { return;');
  const startupFailure = await failTask(start, "--fresh");
  assert.match(startupFailure.errorMessage, /thread\/start.*timed out/i);
  assert.equal(start.state().nextTurnId, 1);
  assert.equal(held.child.exitCode, null, "turn/start still awaits acceptance");
  const heldThreadId = fs.readFileSync(waiting, "utf8");
  const refused = turn.call("task", "--thread", heldThreadId, "--direct", "fixture follow-up");
  assert.equal(refused.status, 2, refused.stderr + refused.stdout);
  assert.equal(directJson(refused).blockers[0].code, "thread_busy");
  fs.writeFileSync(gate, "release");
  const accepted = await held.done;
  clearTimeout(guard);
  assert.equal(accepted.status, 0, accepted.stderr + accepted.stdout);
  assert.equal(directJson(accepted).status, "completed");
  assert.equal(turn.state().nextTurnId, 2, "only the originally held turn executed");
  const requests = fs.readFileSync(path.join(turn.dir, "fake-codex-state.json.requests.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(requests.filter(request => request.method === "turn/start").length, 1);

  const resume = fixture("review-ok", { mutable: true });
  configure(resume);
  const seed = resume.call("task", "--report", "--json", "fixture");
  assert.equal(seed.status, 0, seed.stderr);
  const threadId = JSON.parse(seed.stdout).threadId;
  patchRuntime(resume, 'case "thread/resume": {', `case "thread/resume": {
    if (message.params.config) {
      send({ id: message.id, error: { code: -32602, message: "unknown field config" } }); break;
    }
    return;
  `);
  const resumeFailure = await failTask(resume, "--thread", threadId);
  assert.match(resumeFailure.errorMessage, /thread\/resume.*timed out/i);
  assert.equal(resume.state().nextTurnId, 2, "resume timeout submitted no new turn");
});

test("recovery retains an MCP refusal despite a structured completed declaration", () => {
  const f = fixture("lost-turn:completed"), original = loseTurn(f), state = f.state();
  state.threads[0].turns[0].items = [
    { type: "mcpToolCall", id: "refusal", server: "node_repl", tool: "js", status: "failed",
      error: { message: "Computer Use was not approved to use Google Chrome." } },
    { type: "agentMessage", id: "final", phase: "final_answer", text: JSON.stringify({
      status: "completed", summary: "Completed the fixture task.", key_findings: [], assumptions: [], verification: [], blockers: [], question: null
    }) }
  ];
  fs.writeFileSync(path.join(f.dir, "fake-codex-state.json"), JSON.stringify(state));
  const response = f.call("wait", original.id, "--direct"), compact = directJson(response);
  assert.equal(response.status, 2, response.stderr + response.stdout);
  assert.equal(compact.status, "blocked");
  const detailsResponse = f.call("result", original.id, "--details"), report = directJson(detailsResponse);
  assert.equal(detailsResponse.status, 2);
  assert.equal(report.status, "blocked");
  assert.deepEqual(report.blockers, [{ code: "computer_use_app_not_approved", app: "Google Chrome",
    message: "Computer Use was not approved to use Google Chrome" }]);
  assert.equal(report.recovered, true);
  const saved = storedFixtureJob(f, original.id);
  assert.equal(saved.result.structured.status, "completed");
  assert.deepEqual(saved.result.blockers, report.blockers);
  assert.equal(saved.status, "blocked");
  assert.equal(f.state().nextTurnId, 2, "recovery never replays the turn");
});

test("recovery preserves a failed turn's provider classification over a completed declaration", () => {
  const f = fixture("lost-turn:completed"), original = loseTurn(f), state = f.state();
  const turn = state.threads[0].turns[0];
  turn.status = "failed";
  turn.error = { message: "Request rejected", codexErrorInfo: "cyberPolicy" };
  fs.writeFileSync(path.join(f.dir, "fake-codex-state.json"), JSON.stringify(state));
  const response = f.call("wait", original.id, "--direct"), compact = directJson(response);
  assert.equal(response.status, 2, response.stderr + response.stdout);
  assert.equal(compact.status, "blocked");
  assert.equal(compact.blockers[0].code, "provider_refused");
  const detailsResponse = f.call("result", original.id, "--details"), report = directJson(detailsResponse);
  assert.equal(detailsResponse.status, 2);
  assert.equal(report.status, "blocked");
  assert.equal(report.exitCode, 2);
  assert.equal(report.blockers[0].code, "provider_refused");
  assert.equal(report.recovered, true);
  const saved = storedFixtureJob(f, original.id);
  assert.equal(saved.result.structured.status, "completed");
  assert.equal(saved.result.codexErrorInfo, "cyberPolicy");
  assert.equal(saved.result.status, 1, "the failed runtime status remains separate from the blocked report");
  assert.equal(saved.status, "blocked");
  assert.equal(f.state().nextTurnId, 2, "recovery never replays the turn");
});

test("stored transport failures recover the exact terminal outcome and provenance without replay", async () => {
  const shared = fixture("lost-turn:completed"), baseline = recoveryBaseline(shared);
  for (const outcome of ["completed", "blocked", "needs_input", "failed", "interrupted"]) {
    const expected = outcome === "interrupted" ? "blocked" : outcome;
    const turnStatus = ["failed", "interrupted"].includes(outcome) ? outcome : "completed";
    // Terminal classification shares one real transport loss. Interruption's
    // explicit continuation retains its own runtime and turn history.
    const f = outcome === "interrupted" ? fixture("lost-turn:interrupted") : shared;
    if (f === shared) baseline.restore();
    const original = f === shared ? baseline.original : loseTurn(f);
    const state = f.state(), turn = state.threads[0].turns[0];
    turn.status = turnStatus;
    turn.error = outcome === "failed" ? { message: "Fixture worker failed" } : null;
    assert.equal(turn.status, turnStatus);
    const blockers = outcome === "blocked" ? [{ code: "fixture_dependency", message: "Fixture dependency unavailable." }] : [];
    const question = outcome === "needs_input" ? "Which fixture dependency should be used?" : null;
    const message = turn.items.find(item => item.type === "agentMessage");
    if (["blocked", "needs_input"].includes(outcome)) message.text = JSON.stringify({ ...JSON.parse(message.text), status: outcome,
      summary: "Fixture dependency unavailable.", blockers, question });
    fs.writeFileSync(path.join(f.dir, "fake-codex-state.json"), JSON.stringify(state));

    // Legacy releases persisted the diagnostic without a typed transport marker.
    if (outcome === "completed") storedFixtureJob(f, original.id, { errorMessage: "Codex broker connection closed during startup.",
      result: { status: 1, error: "Codex broker connection closed during startup.", threadId: original.threadId, turnId: original.turnId } });
    if (["completed", "interrupted"].includes(outcome)) {
      const status = directJson(f.call("status", original.id, "--json"));
      assert.equal(status.job.status, expected);
      assert.equal(status.job.turnResolution, turnStatus);
    }

    const waited = f.call("wait", original.id, "--owner", original.ownerId, "--direct");
    const exitCode = expected === "completed" ? 0 : expected === "failed" ? 1 : 2;
    assert.equal(waited.status, exitCode, waited.stderr + waited.stdout);
    const compact = directJson(waited), report = directJson(f.call("result", original.id, "--details")), saved = storedFixtureJob(f, original.id);
    assert.equal(compact.status, expected);
    assert.equal(report.status, expected);
    assert.equal(saved.status, expected);
    if (!["failed", "interrupted"].includes(outcome)) assert.equal(saved.result.structured.status, outcome);
    assert.equal(saved.result.workerStatus, expected);
    assert.equal(report.recovered, true);
    assert.equal(saved.recovered, true);
    assert.equal(report.recoveredAt, saved.recoveredAt);
    assert.equal(report.completedAt, new Date(turn.completedAt * 1000).toISOString());
    assert.equal(saved.completedAt, report.completedAt);
    assert.notEqual(report.completedAt, report.recoveredAt);
    const originalError = outcome === "completed" ? "Codex broker connection closed during startup." : original.errorMessage;
    assert.equal(report.recovery.originalError, originalError);
    assert.equal(report.recovery.wrapperEndedAt, original.completedAt);
    assert.equal(report.recovery.turnStatus, turnStatus);
    assert.equal(report.recovery.source, "thread/read");
    assert.equal(report.threadId, original.threadId);
    assert.equal(report.turnId, original.turnId);
    assert.equal(report.recovery.turnId, original.turnId);
    if (!["failed", "interrupted"].includes(outcome)) assert.deepEqual(report.blockers, question ? [{ code: "needs_input", message: question }]
      : blockers.map(blocker => ({ ...blocker, app: null, tabId: null, sessionId: null })));
    if (question) assert.equal(report.question, question);
    assert.equal(saved.errorMessage, outcome === "failed" ? "Fixture worker failed" : null);
    assert.equal(JSON.parse(fs.readFileSync(saved.resultFile)).recovery.originalError, originalError);

    const result = f.call("result", original.id, "--details");
    assert.equal(result.status, exitCode, result.stderr + result.stdout);
    const reread = directJson(result);
    assert.equal(reread.status, expected);
    assert.equal(reread.recoveredAt, report.recoveredAt);
    assert.equal(reread.completedAt, report.completedAt);
    assert.deepEqual(reread.recovery, report.recovery);
    assert.deepEqual(reread.blockers, report.blockers);
    if (question) assert.equal(reread.question, question);
    assert.deepEqual(f.state().turnReads, [{ threadId: original.threadId, includeTurns: true }]);
    assert.equal(f.state().nextTurnId, 2, "recovery never replays the turn");
    if (outcome === "interrupted") {
      assert.equal(report.blockers[0].code, "codex_runtime_restarted");
      assert.equal(report.exitCode, 2);
      assert.equal(report.interruptionReason, "codex_runtime_restarted");
      assert.equal(report.interruptionConfirmed, true);
      assert.deepEqual(splitRawArgumentString(compact.next), ["fugato", "task", "--to", compact.worker]);
      const continued = directJson(f.call(...splitRawArgumentString(compact.next).slice(1), "--direct", "Continue fixture work."));
      assert.equal(continued.status, "completed");
      assert.equal(storedFixtureJob(f, continued.jobId).threadId, original.threadId);
      assert.equal(f.state().nextTurnId, 3, "only the explicit continuation submits another turn");
    }
  }

  // Stop intent may reach the job before recovery but after its runtime dies.
  for (const stop of ["cancel", "recorded-cancel", "owner-stop", "unknown-cause"]) {
    const f = fixture("lost-turn:interrupted"), original = loseTurn(f);
    if (stop === "cancel") assert.equal(f.call("cancel", original.id, "--json").status, 0);
    else storedFixtureJob(f, original.id, stop === "recorded-cancel"
      ? { cancelRequested: { reason: "cancelled_by_user", at: new Date().toISOString() } }
      : stop === "owner-stop" ? { ownerDetachReason: "signal" }
      : { result: null, errorMessage: "Unknown wrapper failure" });
    const response = f.call("result", original.id), report = directJson(response);
    assert.equal(response.status, 1);
    assert.equal(report.status, stop.includes("cancel") ? "cancelled" : "interrupted");
    assert.equal(report.blockers?.some(blocker => blocker.code === "codex_runtime_restarted") ?? false, false);
    assert.equal(f.state().nextTurnId, 2);
  }

  const direct = fixture("lost-turn:interrupted");
  const directResponse = direct.call("task", "--direct", "Recover the runtime exit.");
  const directResult = directJson(directResponse);
  assert.equal(directResponse.status, 2);
  assert.equal(directResult.status, "blocked");
  assert.equal(directResult.blockers[0].code, "codex_runtime_restarted");
  assert.deepEqual(splitRawArgumentString(directResult.next), ["fugato", "task", "--to", directResult.worker]);
  assert.equal(direct.state().nextTurnId, 2);

  // Also cancel through the real CLI while the fake runtime is poised to exit.
  const f = fixture("lost-turn:interrupted"), gate = path.join(f.dir, "runtime-exit");
  f.env.CODEX_FIXTURE_RUNTIME_EXIT_GATE = gate;
  const launched = directJson(f.call("task", "--detached", "--report", "--json", "Wait for cancellation."));
  await waitForCondition(() => fs.existsSync(path.join(f.dir, "fake-codex-state.json")) && f.state().threads[0]?.turns?.[0]?.status === "inProgress");
  const cancellation = callAsync(f, "cancel", launched.jobId, "--json");
  try {
    await waitForCondition(() => storedFixtureJob(f, launched.jobId).cancelRequested);
  } finally { fs.writeFileSync(gate, "exit"); }
  const cancelled = directJson(await cancellation.done);
  assert.equal(cancelled.reason, "cancelled_by_user");
  const report = directJson(f.call("result", launched.jobId));
  assert.equal(report.status, "cancelled");
  assert.equal(report.blockers?.some(blocker => blocker.code === "codex_runtime_restarted") ?? false, false);
  assert.equal(f.state().nextTurnId, 2);
});

test("an unresolved transport failure stays blocked until explicit exact-turn cancel is confirmed", () => {
  const f = fixture("lost-turn:inProgress"), original = loseTurn(f);
  const changeServer = patch => fs.writeFileSync(path.join(f.dir, "fake-codex-state.json"), JSON.stringify({ ...f.state(), ...patch }));
  const status = () => directJson(f.call("status", original.id, "--json"));
  assert.equal(status().job.turnResolution, "in_progress");
  const blocked = directJson(f.call("task", "--continue", original.id, "--direct", "follow up"));
  assert.equal(blocked.status, "blocked");
  assert.ok(blocked.blockers[0].cancelCommand);
  const blocker = directJson(f.call("result", blocked.jobId, "--details")).blockers[0];
  const observe = run("/bin/sh", ["-c", blocker.recoveryCommand], { cwd: f.repo, env: f.env });
  assert.equal(directJson(observe).job.turnResolution, "in_progress");
  assert.equal(f.state().nextTurnId, 2);
  assert.equal(f.state().lastInterrupt, null);

  changeServer({ unreachable: true });
  const cancel = () => run("/bin/sh", ["-c", blocker.cancelCommand], { cwd: f.repo, env: f.env });
  const offline = f.call("cancel", original.agentName, "--json");
  assert.equal(offline.status, 2, offline.stderr + offline.stdout);
  assert.equal(directJson(offline).confirmation, "unconfirmed");
  assert.match(directJson(offline).detail, /unreachable/);
  assert.deepEqual(storedFixtureJob(f, original.id).result, original.result);
  assert.equal(storedFixtureJob(f, original.id).turnResolution, "unknown");
  assert.equal(f.state().lastInterrupt, null);
  changeServer({ unreachable: false, unreadable: true });
  assert.equal(status().job.turnResolution, "unknown");
  changeServer({ unreadable: false, ignoreInterrupt: true });
  assert.equal(cancel().status, 2, "an interrupt acknowledgement alone must not release the thread");
  assert.equal(storedFixtureJob(f, original.id).turnResolution, "in_progress");
  changeServer({ ignoreInterrupt: false });
  const stopped = cancel();
  assert.equal(stopped.status, 0, stopped.stderr + stopped.stdout);
  assert.equal(directJson(stopped).confirmation, "confirmed");
  const saved = storedFixtureJob(f, original.id);
  assert.equal(saved.status, "cancelled");
  assert.equal(saved.turnResolution, "interrupted");
  assert.equal(saved.recovery.originalError, original.errorMessage);
  assert.equal(saved.recovery.interruptRequested, true);
  assert.deepEqual(f.state().lastInterrupt, { threadId: original.threadId, turnId: original.turnId });
  assert.equal(f.state().lastThreadResume.threadId, original.threadId);
  const followup = f.call("task", "--to", original.agentName, "--direct", "follow up");
  assert.equal(followup.status, 0, followup.stderr + followup.stdout);
  assert.equal(directJson(followup).status, "completed");
  assert.equal(f.state().nextTurnId, 3);

  // A worker-reported failure, even with the old diagnostic as its text, is
  // terminal and must never be overwritten by a server read.
  const workerFailure = { status: 1, error: "Codex broker connection closed during startup.", turnEnded: true, workerStatus: "failed" };
  storedFixtureJob(f, original.id, { status: "failed", recovered: false, result: workerFailure });
  const reads = f.state().turnReads.length;
  status();
  assert.equal(f.state().turnReads.length, reads);
  assert.deepEqual(storedFixtureJob(f, original.id).result, workerFailure);

  const startup = fixture("lost-turn:startup");
  const start = startup.call("task", "--report", "--json", "fixture startup");
  assert.equal(start.status, 1);
  const startId = /Job handle: ([^;]+)/.exec(start.stderr)[1];
  const startJob = storedFixtureJob(startup, startId);
  assert.ok(!startJob.turnId);
  assert.equal(startJob.result.failureSource, "transport");
  assert.match(startJob.errorMessage, /connection closed during startup/);
});

test("running predecessor blocks a direct follow-up with an observational status command", async () => {
  const f = fixture("w5-working");
  const launch = JSON.parse(f.call("task", "--detached", "--json", "fixture work").stdout);
  const waiter = callAsync(f, "wait", launch.jobId, "--owner", launch.ownerId, "--direct");
  try {
    await waitForCondition(() => { const job = storedFixtureJob(f, launch.jobId); return job.turnId && job.ownerAttached; });
    const job = storedFixtureJob(f, launch.jobId);
    checkDecisionReport(f, f.call("wait", job.id, "--direct", "--timeout-sec", "1"), "running", 0);
    const response = f.call("task", "--thread", job.threadId, "--direct", "follow up");
    assert.equal(response.status, 2, response.stderr + response.stdout);
    const compact = directJson(response);
    const report = directJson(f.call("result", compact.jobId, "--details"));
    assert.equal(report.status, "blocked");
    assert.equal(report.turnId, null);
    assert.equal(report.blockers[0].code, "thread_busy");
    assert.equal(report.blockers[0].predecessorJobId, job.id);
    assert.equal(report.blockers[0].predecessorStatus, "running");
    assert.match(report.blockers[0].recoveryCommand, / status .* --cwd .* --json$/);
    assert.doesNotMatch(report.blockers[0].recoveryCommand, /\bwait\b|--owner/);
    assert.ok(!report.blockers[0].recoveryCommand.includes(job.ownerId));
    assert.equal(f.state().nextTurnId, 2, "blocked job must never start a turn");
    const recovery = run("/bin/sh", ["-c", report.blockers[0].recoveryCommand], { cwd: f.repo, env: f.env });
    assert.equal(recovery.status, 0, recovery.stderr + recovery.stdout);
    assert.equal(directJson(recovery).job.status, "running");
    const observed = storedFixtureJob(f, job.id);
    assert.equal(observed.ownerId, job.ownerId);
    assert.equal(observed.ownerAttached, true);
    assert.equal(observed.ownerWaitToken, job.ownerWaitToken);
    assert.equal(observed.status, "running");
    assert.ok(!observed.interruptionReason);
    assert.ok(!f.state().lastInterrupt);
    assert.equal(storedFixtureJob(f, report.jobId).status, "blocked");
  } finally {
    f.call("cancel", launch.jobId, "--json");
    waiter.child.kill("SIGTERM");
    await waiter.done;
  }
});

test("recovery fetches the exact lost turn, even after a later turn on the same thread", () => {
  const f = fixture("review-ok");
  const first = JSON.parse(f.call("task", "--report", "--json", "first task").stdout);
  const second = JSON.parse(f.call("task", "--report", "--json", "--thread", first.threadId, "follow up").stdout);
  const patch = run(process.execPath, ["--input-type=module", "-e", `
    import { readJobFile, resolveJobFile, writeJobFile, upsertJob } from ${JSON.stringify(stateModule)};
    const id = ${JSON.stringify(first.jobId)};
    const job = readJobFile(resolveJobFile(process.cwd(), id));
    delete job.result; delete job.rendered; delete job.report;
    Object.assign(job, { status: "running", pid: null });
    writeJobFile(process.cwd(), id, job);
    upsertJob(process.cwd(), { id, status: "running", pid: null });
  `], { cwd: f.repo, env: f.env });
  assert.equal(patch.status, 0, patch.stderr);
  const recovered = f.call("result", first.jobId, "--details");
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).turnId, first.turnId);
  assert.equal(JSON.parse(recovered.stdout).fileTrackingStatus, "partial");
  assert.equal(JSON.parse(recovered.stdout).sandbox, "danger-full-access", "the recovered report keeps the sandbox the job actually ran with");
  assert.equal(JSON.parse(f.call("result", "--thread", first.threadId, "--details").stdout).turnId, second.turnId);
  assert.equal(f.state().nextTurnId, 3, "recovery must not submit a third turn");

  // A missing reply cannot claim a foreign turn, including one whose wrapper
  // died. Incomplete records and two same-second starts remain unconfirmed.
  const attribution = fixture("lost-turn:inProgress");
  attribution.env.CODEX_COMPANION_HOME = path.join(attribution.dir, "isolated");
  const victim = loseTurn(attribution);
  const other = path.join(attribution.dir, "other"); fs.mkdirSync(other); initGitRepo(other);
  const seeded = run(process.execPath, ["--input-type=module", "-e", `
    import fs from "node:fs";
    import path from "node:path";
    import { writeJobFile, upsertJob, resolveStateFile, resolveStateRoot } from ${JSON.stringify(stateModule)};
    import { recordedThreadJobs } from ${JSON.stringify(new URL("../plugins/codex/scripts/lib/job-runtime.mjs", import.meta.url).href)};
    const cwd = ${JSON.stringify(other)}, job = { ...${JSON.stringify(victim)}, id: "foreign-owner", workspaceRoot: cwd, pid: null };
    const file = writeJobFile(cwd, job.id, job); upsertJob(cwd, job);
    // Metadata-only workspaces and damaged private records indexed on other
    // threads must not make every handle-less recovery ambiguous.
    const root = resolveStateRoot(), empty = path.join(root, "empty"), unrelated = path.join(root, "unrelated");
    fs.mkdirSync(path.join(empty, "jobs"), { recursive: true });
    fs.writeFileSync(path.join(empty, "jobs", "old.result.json"), "{}");
    fs.mkdirSync(path.join(root, "broker-only"));
    fs.mkdirSync(path.join(unrelated, "jobs"), { recursive: true });
    const elsewhere = { id: "elsewhere", workspaceRoot: cwd, threadId: "another-thread" };
    fs.writeFileSync(path.join(unrelated, "state.json"), JSON.stringify({ jobs: [elsewhere, { ...elsewhere, id: "missing" }] }));
    fs.writeFileSync(path.join(unrelated, "jobs", "elsewhere.json"), "{");
    fs.writeFileSync(path.join(unrelated, "jobs", "orphan.json"), JSON.stringify({ ...elsewhere, id: "orphan" }));
    console.log(JSON.stringify({ file, index: resolveStateFile(cwd), complete: recordedThreadJobs(job.threadId).complete }));
  `], { cwd: attribution.repo, env: attribution.env });
  assert.equal(seeded.status, 0, seeded.stderr);
  const files = JSON.parse(seeded.stdout), originalIndex = fs.readFileSync(files.index), originalJob = fs.readFileSync(files.file);
  assert.equal(files.complete, true);
  const requestsFile = path.join(attribution.dir, "fake-codex-state.json.requests.jsonl");
  // Damage makes attribution incomplete before terminal-state handling. Cover
  // each damage once, and both states for the readable and ambiguous cases.
  const attributionCases = [
    ["completed", "readable"], ["inProgress", "readable"],
    ...["missing-index", "malformed-index", "unreadable-index", "missing-job", "malformed-job", "unreadable-job", "orphan-job", "mismatched-turn"]
      .map((damage, index) => [index % 2 ? "inProgress" : "completed", damage]),
    ["completed", "two-missing"], ["inProgress", "two-missing"]
  ];
  for (const [status, damage] of attributionCases) {
      // Only legacy records infer notStarted when all visible turns are owned.
      storedFixtureJob(attribution, victim.id, { ...victim, turnSubmission: undefined, turnId: null, recovered: false, recovery: null,
        result: { ...victim.result, turnId: null } });
      assert.equal(Object.hasOwn(storedFixtureJob(attribution, victim.id), "turnSubmission"), false);
      const state = attribution.state(); state.threads[0].turns[0].status = status;
      fs.writeFileSync(path.join(attribution.dir, "fake-codex-state.json"), JSON.stringify(state));
      const target = damage.endsWith("index") ? files.index : files.file;
      if (damage.startsWith("missing")) fs.unlinkSync(target);
      if (damage.startsWith("malformed")) fs.writeFileSync(target, "{");
      if (damage.startsWith("unreadable")) fs.chmodSync(target, 0);
      if (damage === "orphan-job") fs.writeFileSync(files.index, JSON.stringify({ ...JSON.parse(originalIndex), jobs: [] }));
      if (damage === "mismatched-turn") fs.writeFileSync(files.file, JSON.stringify({ ...JSON.parse(originalJob), turnId: "other-turn" }));
      if (damage === "two-missing") {
        const owner = JSON.parse(originalJob), index = JSON.parse(originalIndex);
        owner.turnId = null; index.jobs[0].turnId = null;
        fs.writeFileSync(files.file, JSON.stringify(owner)); fs.writeFileSync(files.index, JSON.stringify(index));
      }
      const offset = fs.readFileSync(requestsFile, "utf8").trim().split("\n").length;
      try {
        assert.equal(attribution.call("status", victim.id, "--json").status, 0);
        const saved = storedFixtureJob(attribution, victim.id);
        assert.equal(saved.turnId, null, `${status}/${damage}`);
        assert.equal(saved.recovered === true, damage === "readable", `${status}/${damage}`);
        const cancelled = attribution.call("cancel", victim.id, "--json"), report = JSON.parse(cancelled.stdout);
        assert.equal(cancelled.status, damage === "readable" ? 0 : 2, cancelled.stderr);
        assert.equal(report.confirmation, damage === "readable" ? "confirmed" : "unconfirmed");
        assert.equal(report.turnInterruptAttempted, false);
        const requests = fs.readFileSync(requestsFile, "utf8").trim().split("\n").slice(offset).map(JSON.parse);
        assert.equal(requests.some(request => ["turn/start", "turn/interrupt", "thread/backgroundTerminals/clean"].includes(request.method)), false);
      } finally {
        if (fs.existsSync(target)) fs.chmodSync(target, 0o600);
        fs.writeFileSync(files.index, originalIndex); fs.writeFileSync(files.file, originalJob);
      }
  }
});

test("early handle and heartbeat survive a killed wrapper; result recovers without rerun", async () => {
  const f = fixture("slow-recovery-task");
  const gate = path.join(f.dir, "release-turn");
  f.env.CODEX_FIXTURE_TURN_GATE = gate;
  const child = spawn(process.execPath, [script, "task", "--report", "--json", "investigate"], {
    cwd: f.repo, env: { ...f.env, CODEX_COMPANION_PROGRESS_INTERVAL_MS: "250" }, stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "", stdout = "";
  child.stderr.on("data", data => { stderr += data; });
  child.stdout.on("data", data => { stdout += data; });
  const exited = new Promise(resolve => child.once("exit", resolve));
  const waitFor = async predicate => {
    const deadline = Date.now() + 12000;
    while (!predicate()) {
      if (Date.now() > deadline) { child.kill("SIGKILL"); throw new Error(`Timed out: ${stderr}`); }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  await waitFor(() => /Turn handle:/.test(stderr) && /Progress:/.test(stderr));
  const id = /Job handle: ([^;]+)/.exec(stderr)[1];
  assert.equal(stdout, "", "stdout must not contain progress or partial JSON");
  child.kill("SIGKILL"); await exited;
  fs.writeFileSync(gate, "finish");
  await waitFor(() => f.state().threads[0].turns?.some(t => t.status === "completed"));
  const response = f.call("result", id, "--report", "--json");
  assert.equal(response.status, 0, response.stderr + response.stdout);
  assert.equal(JSON.parse(response.stdout).status, "completed");
  assert.equal(f.state().nextTurnId, 2);
  const status = JSON.parse(f.call("status", id, "--json").stdout);
  assert.equal(status.job.recovered, true);
  assert.match(fs.readFileSync(status.job.logFile, "utf8"), /Progress:.*items, .*tools;.*last activity/);
});
