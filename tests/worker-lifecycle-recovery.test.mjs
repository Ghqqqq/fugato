import test from 'node:test';
import assert from 'node:assert/strict';
import { lifecycleHarness } from './fake-codex-fixture.mjs';
const {
  fs, path, makeTempDir, resolveStateDir, run, resolveIsolatedCodexHome, writeJobFile, upsertJob, readJobFile, JobRuntime, renewLease, markOwnerAttachment, adoptJob, ownershipNotice, spawnOwned, script, alive, fixture, json, directLines, direct, waitUntil, patchJob, job
} = await lifecycleHarness();

const storedJob = (f, id) => readJobFile(path.join(resolveStateDir(f.repo, f.env), "jobs", `${id}.json`));

test("cancel --all confirms each active session job and leaves another session's worker running", async () => {
  const f = fixture();
  const first = json(f.call("task", "--fresh", "--detached", "--json", "First worker"));
  const second = json(f.call("task", "--fresh", "--detached", "--json", "Second worker"));
  const other = json(f.call("task", "--fresh", "--detached", "--json", "--session", "other-session", "Other worker"));
  await waitUntil(() => [first, second, other].every(launch => storedJob(f, launch.jobId).turnId));
  const cancelled = json(f.call("cancel", "--all", "--json"));
  assert.deepEqual(new Set(cancelled.jobs.map(outcome => outcome.jobId)), new Set([first.jobId, second.jobId]));
  for (const outcome of cancelled.jobs) {
    assert.equal(outcome.confirmation, "confirmed");
    assert.equal(outcome.status, "cancelled");
    assert.equal(storedJob(f, outcome.jobId).result.interruptionConfirmed, true);
  }
  assert.equal(storedJob(f, other.jobId).status, "running");
  assert.equal(storedJob(f, other.jobId).cancelRequested, undefined);
  assert.deepEqual(json(f.call("cancel", "--all", "--json")).jobs, []);
  assert.equal(json(f.call("cancel", other.jobId, "--json")).confirmation, "confirmed");
});

test("cancel --all skips a selected job adopted by another session during cancellation", async () => {
  const f = fixture();
  const launches = ["First worker", "Second worker"].map(prompt => json(f.call("task", "--fresh", "--detached", "--json", prompt)));
  await waitUntil(() => launches.every(launch => storedJob(f, launch.jobId).turnId));
  const records = launches.map(launch => storedJob(f, launch.jobId));
  const preload = path.join(f.dir, "adopt-during-cancel.mjs");
  fs.writeFileSync(preload, `
    import fs from "node:fs";
    import { adoptJob } from ${JSON.stringify(new URL("../plugins/codex/scripts/lib/job-runtime.mjs", import.meta.url).href)};
    const records = ${JSON.stringify(records.map(record => ({ id: record.id, logFile: record.logFile })))};
    const append = fs.appendFileSync;
    let adopted = false;
    fs.appendFileSync = function(file, text, ...args) {
      const result = append.call(this, file, text, ...args);
      if (!adopted && String(text).includes("Cancelled by user: interrupt requested")) {
        adopted = true;
        const other = records.find(record => record.logFile !== file);
        if (!adoptJob(process.cwd(), other.id, "replacement-session").adopted) throw new Error("Fixture adoption failed");
      }
      return result;
    };
  `);
  const cancelled = json(run(process.execPath, ["--import", preload, script, "cancel", "--all", "--json"], { cwd: f.repo, env: f.env }));
  const moved = records.map(record => storedJob(f, record.id)).find(record => record.sessionId === "replacement-session");
  assert.deepEqual({ outcomes: cancelled.jobs.map(outcome => [outcome.status, outcome.reason]),
    moved: { status: moved.status, cancelRequested: moved.cancelRequested ?? null }
  }, { outcomes: [["cancelled", "cancelled_by_user"], ["skipped", "ownership_moved"]],
    moved: { status: "running", cancelRequested: null } });
  json(f.call("cancel", moved.id, "--json"));
});

test("test-home guard rejects real homes and symlink aliases before creating them", () => {
  const f = fixture();
  for (const value of ["/fixture-real-home/.claude/codex-isolated", "/fixture-real-home/.codex"]) assert.throws(() => resolveIsolatedCodexHome({ ...f.env, CODEX_COMPANION_HOME: value }), /Test-home guard/);
  const alias = path.join(f.dir, "outside"); fs.symlinkSync(path.dirname(process.env.CODEX_COMPANION_TEST_ROOT), alias);
  assert.throws(() => resolveIsolatedCodexHome({ ...f.env, CODEX_COMPANION_HOME: alias }), /Test-home guard/);
});

test("expired leases cannot be revived before the worker observes expiry", () => {
  const cwd = makeTempDir(), now = Date.now();
  const record = { id: "expired-owner-test", ownerId: "owner", status: "running", jobClass: "task", workspaceRoot: cwd, threadId: "expired-thread", leaseSec: 180, leaseRenewedAt: now - 180001, leaseExpiresAt: now - 1 };
  writeJobFile(cwd, record.id, record); upsertJob(cwd, record);
  assert.equal(renewLease(cwd, record.id, "owner").leaseExpiresAt, record.leaseExpiresAt);
  assert.equal(renewLease(cwd, record.id).leaseExpiresAt, record.leaseExpiresAt);
  const beforeAttachment = renewLease(cwd, record.id, "owner");
  assert.deepEqual(markOwnerAttachment(cwd, record.id, "owner"), beforeAttachment, "attachment must leave an expired lease and its owner state untouched");
  const adopted = adoptJob(cwd, record.id, "new-session");
  assert.equal(adopted.status, "lease_expired"); assert.equal(adopted.ownerId, record.ownerId);
  assert.ok(adopted.continuationCommand.includes("task --continue 'expired-owner-test'"));
  const runtime = new JobRuntime(cwd, record.id, { foreground: true });
  try { assert.equal(runtime.reason, "lease_expired"); } finally { runtime.close(); }
});

test("adoption preserves legacy session scope, rotates every time and rejects cancellation", () => {
  const cwd = makeTempDir();
  const record = { id: "legacy-adopt", ownerId: "legacy-session", status: "running", jobClass: "task", workspaceRoot: cwd, leaseSec: 180, leaseExpiresAt: Date.now() + 180000 };
  writeJobFile(cwd, record.id, record); upsertJob(cwd, record);
  const first = adoptJob(cwd, record.id);
  assert.equal(first.status, "adopted"); assert.equal(first.sessionId, "legacy-session");
  const second = adoptJob(cwd, record.id);
  assert.equal(second.status, "adopted"); assert.notEqual(second.ownerId, first.ownerId);
  const stored = renewLease(cwd, record.id, "legacy-session");
  assert.equal(ownershipNotice(stored, first.ownerId).status, "ownership_moved");
  assert.equal(ownershipNotice(stored, "legacy-session").status, "ownership_moved");
  writeJobFile(cwd, record.id, { ...stored, cancelRequested: { reason: "cancelled_by_user" } });
  const stopping = adoptJob(cwd, record.id);
  assert.equal(stopping.status, "interrupting"); assert.equal(stopping.ownerId, second.ownerId);
  assert.equal(stopping.continuationCommand, null);
  writeJobFile(cwd, record.id, { ...stored, sessionId: null });
  assert.equal(adoptJob(cwd, record.id).sessionId, null, "Known absence of a session is not a legacy session-ID owner");
});

test("detached fallback spawn failure throws synchronously without an unhandled error", () => {
  const dir = makeTempDir("failed-detached-spawn-");
  const result = run(process.execPath, ["--input-type=module", "-e", `
    import { spawnDetached } from ${JSON.stringify(new URL('../plugins/codex/scripts/lib/process.mjs', import.meta.url).href)};
    let threw = false;
    try {
      spawnDetached(process.execPath, ['-e', ''], { cwd: ${JSON.stringify(path.join(dir, "missing"))}, stdio: 'ignore' });
    } catch (error) { threw = error instanceof Error; }
    // Allow the failed child's asynchronous error event to fire. A synchronous
    // throw alone must not leave an unhandled event that kills this caller.
    await new Promise(resolve => setTimeout(resolve, 50));
    console.log(JSON.stringify({ threw, survived: true }));
  `], { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { threw: true, survived: true });
});

test("a direct wait whose parent exits stops its worker; unconfirmed interruptions block thread reuse until resolved", async t => {
  const stored = (f, id) => readJobFile(path.join(resolveStateDir(f.repo, f.env), "jobs", `${id}.json`));
  const changeServer = (f, patch) => fs.writeFileSync(path.join(f.dir, "fake-codex-state.json"), JSON.stringify({ ...f.state(), ...patch }));
  const stopOwner = async confirmed => {
    const f = fixture("lost-turn:owner-stop");
    f.env.CODEX_COMPANION_BROKER_IDLE_SEC = "1";
    const launch = json(f.call("task", "--detached", "--json", "fixture"));
    const processModule = new URL("../plugins/codex/scripts/lib/process.mjs", import.meta.url).href;
    const wrapper = spawnOwned(process.execPath, ["--input-type=module", "-e", `
      import { spawnOwned } from ${JSON.stringify(processModule)};
      const wait = spawnOwned(process.execPath, ${JSON.stringify([script, "wait", launch.jobId, "--owner", launch.ownerId, "--timeout-sec", "60", "--direct"])}, { stdio: ['ignore', 1, 2] });
      wait.on('exit', code => { process.exitCode = code; });
    `], { cwd: f.repo, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    wrapper.stdout.on("data", chunk => { stdout += chunk; }); wrapper.stderr.on("data", chunk => { stderr += chunk; });
    const closed = new Promise(resolve => wrapper.on("close", resolve));
    await waitUntil(() => stored(f, launch.jobId).ownerAttached && stored(f, launch.jobId).turnId);
    const workerPid = stored(f, launch.jobId).pid;
    changeServer(f, { ignoreInterrupt: !confirmed });
    wrapper.kill("SIGTERM");
    await closed;
    const lines = directLines(stdout); assert.equal(stderr, "");
    const stopped = JSON.parse(lines.at(-1));
    assert.equal(stopped.status, "owner_stopped"); assert.equal(stopped.jobId, launch.jobId); assert.equal(stopped.worker, launch.agentName);
    const stoppedJob = stored(f, launch.jobId);
    assert.equal(stoppedJob.ownerId, launch.ownerId); assert.ok(stoppedJob.threadId); assert.ok(stoppedJob.turnId);
    assert.equal(stopped.next, `fugato task --to ${launch.agentName}`);
    assert.equal(stoppedJob.ownerDetachReason, "parent_exit");
    const result = json(f.call("wait", launch.jobId, "--timeout-sec", "10", "--json"), 1);
    assert.equal(result.interruptionReason, "owner_stopped"); assert.equal(result.interruptionConfirmed, confirmed);
    await waitUntil(() => !alive(workerPid));
    const original = stored(f, launch.jobId);
    assert.equal(original.status, "interrupted"); assert.equal(original.result.turnEnded, confirmed);
    return { f, launch, original };
  };
  const preservedOutcome = (f, original, turnStatus) => {
    const saved = stored(f, original.id);
    assert.equal(saved.status, original.status); assert.equal(saved.completedAt, original.completedAt);
    assert.equal(saved.summary, original.summary); assert.equal(saved.errorMessage, original.errorMessage);
    assert.equal(saved.recovered, true); assert.equal(saved.turnResolution, turnStatus);
    assert.equal(saved.result.turnEnded, true); assert.equal(saved.result.interruptionConfirmed, true);
    assert.deepEqual([saved.recovery.source, saved.recovery.threadId, saved.recovery.turnId, saved.recovery.turnStatus], ["thread/read", original.threadId, original.turnId, turnStatus]);
    const withoutResolution = value => Object.fromEntries(Object.entries(value).filter(([key]) => !["recovered", "recoveredAt", "completedAt", "recovery", "turnEnded", "interruptionConfirmed"].includes(key)));
    assert.deepEqual(withoutResolution(saved.result), withoutResolution(original.result));
    assert.deepEqual(withoutResolution(saved.report), withoutResolution(original.report));
    assert.deepEqual(readJobFile(saved.resultFile), saved.result);
    assert.equal(fs.readFileSync(saved.rawOutputFile, "utf8"), original.result.rawOutput);
    assert.equal(json(f.call("result", original.id, "--details"), 1).status, original.status);
  };

  const { f, launch, original } = await stopOwner(false);
  let offset = f.requests().length;
  const retiring = direct(f.call("task", "--thread", original.threadId, "--direct", "follow up"), 2);
  assert.equal(retiring.status, "blocked"); assert.equal(retiring.blockers[0].code, "thread_busy"); assert.ok(retiring.blockers[0].cancelCommand);
  assert.ok(f.requests().slice(offset).every(request => request.method === "thread/read"));
  // The existing broker retires an abandoned, unconfirmed stream. Once it has
  // exited, the replacement can read the fixture's persisted exact turn.
  await waitUntil(() => !alive(f.requests()[0].serverId));
  let cancelCommand;
  for (const args of [["--to", launch.agentName]]) {
    offset = f.requests().length;
    const blocked = direct(f.call("task", ...args, "--direct", "follow up"), 2);
    assert.equal(blocked.status, "blocked"); assert.equal(blocked.blockers[0].code, "thread_busy");
    cancelCommand = blocked.blockers[0].cancelCommand; assert.ok(cancelCommand);
    assert.deepEqual(f.requests().slice(offset).map(request => request.method), ["thread/read"]);
    assert.equal(stored(f, launch.jobId).result.turnEnded, false);
  }
  changeServer(f, { unreadable: true });
  offset = f.requests().length;
  assert.equal(json(f.call("status", launch.jobId, "--json")).job.turnResolution, "unknown");
  assert.deepEqual(stored(f, launch.jobId).result, original.result);
  const unreadable = direct(f.call("task", "--thread", original.threadId, "--direct", "follow up"), 2);
  assert.equal(unreadable.blockers[0].code, "thread_busy"); assert.ok(unreadable.blockers[0].cancelCommand);
  assert.deepEqual(f.requests().slice(offset).map(request => request.method), ["thread/read", "thread/read"]);

  changeServer(f, { ignoreInterrupt: false, unreadable: false });
  offset = f.requests().length;
  const cancelled = json(run("/bin/sh", ["-c", cancelCommand], { cwd: f.repo, env: f.env }));
  assert.equal(cancelled.confirmation, "confirmed"); assert.equal(cancelled.backgroundTerminals.cleaned, true);
  preservedOutcome(f, original, "interrupted");
  const cancellationRequests = f.requests().slice(offset);
  const interrupt = cancellationRequests.findLastIndex(request => request.method === "turn/interrupt");
  assert.deepEqual(cancellationRequests[interrupt].params, { threadId: original.threadId, turnId: original.turnId });
  assert.deepEqual(cancellationRequests.slice(interrupt + 1).map(request => request.method), ["thread/read", "thread/backgroundTerminals/clean"]);
  offset = f.requests().length;
  const followup = direct(f.call("task", "--to", launch.agentName, "--direct", "follow up"));
  assert.equal(followup.status, "completed");
  assert.equal(f.requests().slice(offset).filter(request => request.method === "turn/start").length, 1);

  const userCancel = fixture("lost-turn:owner-stop");
  userCancel.env.CODEX_COMPANION_BROKER_IDLE_SEC = "1";
  const userLaunch = json(userCancel.call("task", "--detached", "--json", "fixture"));
  await waitUntil(() => stored(userCancel, userLaunch.jobId).turnId);
  const userWorkerPid = stored(userCancel, userLaunch.jobId).pid;
  changeServer(userCancel, { ignoreInterrupt: true });
  assert.equal(json(userCancel.call("cancel", userLaunch.jobId, "--json"), 2).confirmation, "unconfirmed");
  await waitUntil(() => !alive(userWorkerPid));
  await waitUntil(() => !alive(userCancel.requests()[0].serverId));
  const cancelledOriginal = stored(userCancel, userLaunch.jobId);
  assert.equal(cancelledOriginal.status, "cancelled"); assert.equal(cancelledOriginal.result.turnEnded, false);
  assert.equal(direct(userCancel.call("task", "--continue", userLaunch.jobId, "--direct", "follow up"), 2).blockers[0].code, "thread_busy");

  // Independently observed terminal turns resolve safety without replacing
  // either stopped outcome, even when the server completed or failed later.
  for (const [runtime, stopped] of [[f, original], [userCancel, cancelledOriginal]]) {
    for (const turnStatus of ["failed"]) {
      patchJob(runtime, stopped.id, { ...stopped, recovered: false, recovery: null, turnResolution: "unknown" });
      const state = runtime.state(), turn = state.threads.find(thread => thread.id === stopped.threadId).turns.find(turn => turn.id === stopped.turnId);
      Object.assign(turn, { status: turnStatus, completedAt: Math.floor(Date.now() / 1000), error: turnStatus === "failed" ? { message: "Fixture server failed" } : null });
      changeServer(runtime, state);
      offset = runtime.requests().length;
      const status = json(runtime.call("status", stopped.id, "--json")).job;
      assert.equal(status.status, stopped.status); assert.equal(status.interruptionConfirmed, true);
      assert.deepEqual(runtime.requests().slice(offset), [{ serverId: runtime.requests().at(-1).serverId, method: "thread/read", params: { threadId: stopped.threadId, includeTurns: true } }]);
      preservedOutcome(runtime, stopped, turnStatus);
      json(runtime.call("status", stopped.id, "--json"));
      assert.equal(runtime.requests().length, offset + 1);
    }
  }

  // Unreadable and ambiguous missing handles must produce an honest cancel
  // result, without submitting work or guessing which turn to interrupt.
  const missing = fixture("lost-turn:inProgress"), lost = missing.call("task", "--report", "--json", "fixture");
  const missingId = /Job handle: ([^;]+)/.exec(lost.stderr)[1], missingJob = stored(missing, missingId);
  patchJob(missing, missingId, { turnId: null, result: { ...missingJob.result, turnId: null } });
  changeServer(missing, { unreadable: true });
  assert.equal(json(missing.call("cancel", missingId, "--json"), 2).status, "interrupt_unconfirmed");
  const ambiguous = missing.state(); ambiguous.unreadable = false;
  ambiguous.threads[0].turns.push({ id: "another-turn", status: "inProgress", items: [] }); changeServer(missing, ambiguous);
  assert.equal(json(missing.call("cancel", missingId, "--json"), 2).status, "interrupt_unconfirmed");
  ambiguous.threads[0].turns.pop(); changeServer(missing, ambiguous);
  assert.equal(json(missing.call("cancel", missingId, "--json")).confirmation, "confirmed");

  // Dispatch can die after publishing its reservation but before writing the
  // private record. A live launcher is protected; abandoned launches release
  // admission without reading or claiming an earlier turn on the thread.
  const reservations = fixture("task-ok");
  const seed = direct(reservations.call("task", "--direct", "fixture"));
  const threadId = stored(reservations, seed.jobId).threadId;
  const stateModule = new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url).href;
  const { unresolvedTask } = await import(stateModule);
  const reserve = record => {
    const result = run(process.execPath, ["--input-type=module", "-e", `
      import { upsertJob } from ${JSON.stringify(stateModule)};
      upsertJob(process.cwd(), ${JSON.stringify(record)});
    `], { cwd: reservations.repo, env: reservations.env });
    assert.equal(result.status, 0, result.stderr);
  };
  const reservation = (id, patch = {}) => ({ id, jobClass: "task", kind: "task", workspaceRoot: reservations.repo,
    sessionId: reservations.env.CODEX_COMPANION_SESSION_ID, status: "queued", phase: "queued", threadId,
    pid: null, turnId: null, createdAt: new Date().toISOString(), ...patch });
  const privateFile = (f, id) => path.join(resolveStateDir(f.repo, f.env), "jobs", `${id}.json`);
  const launcher = spawnOwned(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: reservations.repo, env: reservations.env, stdio: "ignore" });
  const launcherClosed = new Promise(resolve => launcher.once("close", resolve));
  const live = reservation("task-live-reservation", { launcherPid: launcher.pid });
  try {
    reserve(live);
    assert.equal(json(reservations.call("status", live.id, "--json")).job.status, "queued");
    assert.equal(fs.existsSync(privateFile(reservations, live.id)), false);
    assert.equal(json(reservations.call("status", "--all", "--json")).running.some(job => job.id === live.id), false);
    const protectedFollowup = direct(reservations.call("task", "--thread", threadId, "--sandbox", "read-only", "--direct", "fixture"), 2);
    assert.equal(protectedFollowup.blockers[0].code, "thread_busy");
    assert.equal(reservations.state().nextTurnId, 2);
    assert.equal(fs.existsSync(privateFile(reservations, live.id)), false);
  } finally {
    launcher.kill("SIGKILL");
    await launcherClosed;
  }
  assert.equal(alive(launcher.pid), false);
  assert.equal(direct(reservations.call("task", "--thread", threadId, "--sandbox", "read-only", "--direct", "fixture")).status, "completed");
  const abandoned = stored(reservations, live.id);
  assert.equal(abandoned.status, "failed"); assert.equal(abandoned.recovery.turnStatus, "notStarted");
  assert.equal(unresolvedTask(abandoned), false); assert.ok(abandoned.errorMessage);
  assert.equal(json(reservations.call("result", live.id), 1).status, "failed");
  assert.equal(json(reservations.call("result", live.id, "--details"), 1).status, "failed");
  assert.equal(json(reservations.call("cancel", live.id, "--json")).confirmation, "confirmed");

  const legacy = reservation("task-aged-reservation", { createdAt: "2000-01-01T00:00:00.000Z" });
  reserve(legacy);
  const listed = json(reservations.call("status", "--all", "--json"));
  assert.equal(listed.running.some(job => job.id === legacy.id), false);
  assert.equal(stored(reservations, legacy.id).status, "failed");
  assert.equal(unresolvedTask(stored(reservations, legacy.id)), false);
  assert.equal(json(reservations.call("result", legacy.id, "--details"), 1).status, "failed");
  assert.equal(direct(reservations.call("task", "--thread", threadId, "--sandbox", "read-only", "--direct", "fixture")).status, "completed");

  const noThread = reservation("task-missing-before-thread", { status: "running", pid: launcher.pid, threadId: null });
  reserve(noThread);
  const notStarted = json(reservations.call("status", noThread.id, "--json")).job;
  assert.equal(notStarted.status, "failed"); assert.equal(notStarted.recovery.turnStatus, "notStarted");
  assert.equal(json(reservations.call("cancel", noThread.id, "--json")).confirmation, "confirmed");

  // Losing a started job's private record does not resolve its live server
  // turn. Exact views expose recovery, and the advertised cancel releases it.
  const indexOnly = fixture("lost-turn:owner-stop");
  indexOnly.env.CODEX_COMPANION_BROKER_IDLE_SEC = "1";
  const indexLaunch = json(indexOnly.call("task", "--detached", "--json", "fixture"));
  await waitUntil(() => stored(indexOnly, indexLaunch.jobId).turnId);
  const indexJob = stored(indexOnly, indexLaunch.jobId);
  changeServer(indexOnly, { ignoreInterrupt: true });
  process.kill(indexJob.pid, "SIGKILL");
  await waitUntil(() => !alive(indexJob.pid));
  await waitUntil(() => !alive(indexOnly.requests()[0].serverId));
  fs.unlinkSync(privateFile(indexOnly, indexJob.id));
  const missingStatus = json(indexOnly.call("status", indexJob.id, "--json"));
  assert.equal(missingStatus.job.status, "failed"); assert.ok(missingStatus.recovery.recoveryCommand);
  assert.equal(unresolvedTask(stored(indexOnly, indexJob.id)), true);
  const pending = json(indexOnly.call("result", indexJob.id), 2);
  assert.equal(pending.status, "unknown"); assert.ok(pending.blockers[0].recoveryCommand);
  assert.equal(json(indexOnly.call("result", indexJob.id, "--details"), 2).status, "unknown");
  assert.equal(direct(indexOnly.call("task", "--thread", indexJob.threadId, "--direct", "fixture"), 2).blockers[0].code, "thread_busy");
  changeServer(indexOnly, { ignoreInterrupt: false });
  const cancelMissing = json(run("/bin/sh", ["-c", pending.blockers[0].cancelCommand], { cwd: indexOnly.repo, env: indexOnly.env }));
  assert.equal(cancelMissing.confirmation, "confirmed");
  assert.equal(direct(indexOnly.call("task", "--thread", indexJob.threadId, "--direct", "fixture")).status, "completed");

  const reset = fixture("review-ok", { mutable: true }), resetBinary = path.join(reset.dir, "codex");
  const resetSource = fs.readFileSync(resetBinary, "utf8");
  const usageMarker = 'if (BEHAVIOR === "large-jsonl") {\n          emitTurnCompleted';
  assert.ok(resetSource.includes(usageMarker));
  fs.writeFileSync(resetBinary, resetSource.replace(usageMarker, `
        const resetUsage = { inputTokens: 25, cachedInputTokens: 5, cacheWriteInputTokens: 0,
          outputTokens: 5, reasoningOutputTokens: 2, totalTokens: 30 };
        for (const key of Object.keys(resetUsage)) thread.tokenUsage[key] -= 2 * resetUsage[key];
        emitUsage(resetUsage);
        ${usageMarker}`));
  const resetResult = direct(reset.call("task", "--fresh", "--direct", "fixture"));
  assert.equal(Object.hasOwn(resetResult, "usage"), false);
  assert.equal(Object.hasOwn(stored(reset, resetResult.jobId).result, "usage"), false);
});

test("a direct wait replaces a previously stored follow continuation after cancellation", () => {
  const f = fixture(), launch = json(f.call("task", "--follow", "--json", "--timeout-sec", "1", "fixture"));
  json(f.call("cancel", launch.jobId, "--json"));
  const before = json(f.call("result", launch.jobId, "--json")).storedJob.report;
  assert.match(before.continuationCommand, / --follow --report --json$/);
  const done = direct(f.call("wait", launch.jobId, "--owner", launch.ownerId, "--direct"), 1);
  const details = json(f.call("result", done.jobId, "--details"), 1);
  assert.match(details.continuationCommand, / --direct$/);
  assert.equal(json(f.call("result", launch.jobId, "--json")).storedJob.report.continuationCommand, details.continuationCommand);
  assert.equal(job(f, launch.jobId).direct, true);
});
