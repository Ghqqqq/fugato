import test from 'node:test';
import assert from 'node:assert/strict';
import { lifecycleHarness } from './fake-codex-fixture.mjs';
import { ACTIVITY_RETAINED_MAX, ACTIVITY_PENDING_MAX } from '../plugins/codex/scripts/lib/activity.mjs';
import { createJobProgressUpdater } from '../plugins/codex/scripts/lib/tracked-jobs.mjs';
import { buildWorkerReport } from '../plugins/codex/scripts/lib/worker-report.mjs';
import { fullReport, directReport } from '../plugins/codex/scripts/lib/job-runtime.mjs';
const {
  fs, path, makeTempDir, initGitRepo, buildEnv, installFakeCodex, resolveStateDir, delay, run, writeJobFile, upsertJob, updateJob, readJobFile, resolveJobFile, JobRuntime, pauseAdjustment, renewLease, markOwnerAttachment, leaseSnapshot, adoptJob, ownerLost, spawnOwned, script, alive, fixture, json, directLines, direct, waitUntil, patchJob, job
} = await lifecycleHarness();

const storedJob = (f, id) => readJobFile(path.join(resolveStateDir(f.repo, f.env), "jobs", `${id}.json`));

// Direct-mode backpressure fixture: a fake Codex burst while the parent leaves stdout undrained.
async function until(check, timeout = 15000) {
  for (const end = Date.now() + timeout; Date.now() < end;) {
    const result = check();
    if (result) return result;
    await delay(50);
  }
  throw new Error("Backpressure fixture deadline expired");
}

// Extend only the generated temporary binary, not the shared fake fixture. Each
// fileChange notification adds 100 real activity events in one state update.
// A file gate starts the burst only after the direct owner has attached.
function installBurstCodex(dir) {
  installFakeCodex(dir, "w5-working", { mutable: true });
  const binary = path.join(dir, "codex"), gate = path.join(dir, "burst-start");
  const branch = 'if (BEHAVIOR === "w5-parent" || BEHAVIOR === "w5-working") {';
  let source = fs.readFileSync(binary, "utf8");
  assert.ok(source.includes(branch));
  source = source.replace(branch, `${branch}
          let burst = 0;
          const burstTimer = setInterval(() => {
            if (!fs.existsSync(${JSON.stringify(gate)})) return;
            if (loadState().lastInterrupt || burst === 35) { clearInterval(burstTimer); return; }
            burst += 1;
            const changes = Array.from({ length: 100 }, (_, i) => ({
              path: "synthetic/" + burst + "/" + i + "/" + "x".repeat(170), kind: { type: "update" }
            }));
            send({ method: "item/completed", params: { threadId: thread.id, turnId,
              item: { id: "burst-" + burst, type: "fileChange", changes } } });
          }, 40);
  `);
  // Complete only after the reader has resumed; the real undrained interval
  // remains longer than the owner grace without waiting for a second deadline.
  const heldTimer = "const timer = null; // Held open until an explicit fixture release or turn/interrupt.";
  const completionTimer = `const timer = setInterval(() => {
    if (!fs.existsSync(${JSON.stringify(gate + "-finish")})) return;
    clearInterval(timer);
    emitTurnCompleted(thread.id, turnId, { completed: { type: "agentMessage", id: "fixture-done", text: "Completed fixture work.", phase: "final_answer" } });
  }, 25);`;
  const branchStart = source.indexOf(branch);
  assert.ok(source.indexOf(heldTimer, branchStart) >= 0);
  source = source.slice(0, branchStart) + source.slice(branchStart).replace(heldTimer, completionTimer);
  fs.writeFileSync(binary, source);
  return gate;
}

async function cleanupBackpressure(dir, env) {
  const ledger = env.CODEX_COMPANION_TEST_PROCESSES;
  const records = () => fs.existsSync(ledger) ? fs.readdirSync(ledger).filter(name => name.endsWith(".json")).map(name => JSON.parse(fs.readFileSync(path.join(ledger, name)))) : [];
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    for (const record of records()) {
      if (record.exited || !alive(record.pid)) continue;
      try { process.kill(record.detached && process.platform !== "win32" ? -record.pid : record.pid, signal); }
      catch (error) {
        if (error.code === "ESRCH" || !alive(record.pid)) continue;
        if (error.code !== "EPERM") throw error;
        try { process.kill(record.pid, signal); } catch (inner) { if (inner.code !== "ESRCH") throw inner; }
      }
    }
    for (const deadline = Date.now() + (signal === "SIGTERM" ? 700 : 15000); Date.now() < deadline;) {
      if (!records().some(record => !record.exited && alive(record.pid))) break;
      await delay(25);
    }
  }
  assert.deepEqual(records().filter(record => !record.exited && alive(record.pid)).map(record => record.pid), [], "fixture processes stopped");
  fs.rmSync(dir, { recursive: true, force: true });
}

async function backpressureScenario(script) {
  const dir = makeTempDir("bp-"), repo = path.join(dir, "repo");
  fs.mkdirSync(repo); initGitRepo(repo);
  const gate = installBurstCodex(dir);
  const env = { ...buildEnv(dir), CODEX_COMPANION_BIN: path.join(dir, "codex"),
    CLAUDE_PLUGIN_DATA: path.join(dir, "data"), CODEX_COMPANION_HOME: path.join(dir, "isolated"),
    CODEX_COMPANION_SESSION_ID: "d2-synthetic", CODEX_COMPANION_OWNER_GRACE_SEC: "1",
    CODEX_COMPANION_TEST_MODE: "1", CODEX_COMPANION_TEST_PROCESSES: path.join(dir, "processes") };
  let owner;
  try {
    const launched = run(process.execPath, [script, "task", "--fresh", "--detached", "--json", "Synthetic backpressure fixture"], { cwd: repo, env });
    assert.equal(launched.status, 0, launched.stderr);
    const launch = JSON.parse(launched.stdout);
    const file = path.join(resolveStateDir(repo, env), "jobs", `${launch.jobId}.json`);
    const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
    owner = spawnOwned(process.execPath, [script, "wait", launch.jobId, "--owner", launch.ownerId, "--direct", "--timeout-sec", "30"], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", code;
    const closed = new Promise((resolve, reject) => { owner.once("error", reject); owner.once("close", status => { code = status; resolve(); }); });
    owner.stderr.on("data", chunk => { stderr += chunk; });
    // Keep stdout undrained, but retain data if Node resumes it on child exit.
    owner.stdout.on("data", chunk => { stdout += chunk; });
    owner.stdout.pause();
    const attached = await until(() => { const current = read(); return current.ownerAttached && current.turnId && current; });
    fs.writeFileSync(gate, "start");
    await until(() => read().activityTotals?.events >= 3500 && read().leaseRenewedAt > attached.leaseRenewedAt);
    const beforeDrain = read();
    owner.stdout.resume();
    fs.writeFileSync(gate + "-finish", "finish");
    let deadline;
    try {
      await Promise.race([closed, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("Owner did not finish after draining stdout")), 15000); })]);
    } finally { clearTimeout(deadline); }
    const saved = read(), lines = stdout.trimEnd().split("\n"), final = JSON.parse(lines.at(-1));
    const omissionLines = lines.filter(line => /^… \d+ progress lines omitted$/.test(line));
    return { code, stderr, stdout, final, saved, omissionLines,
      measurements: { statusBeforeDrain: beforeDrain.status, activityEvents: saved.activity.length,
        progressLines: lines.length - 1, omittedLines: omissionLines.reduce((sum, line) => sum + Number(line.split(" ")[1]), 0),
        omissionNotices: omissionLines.length } };
  } finally {
    owner?.stdout.resume();
    await cleanupBackpressure(dir, env);
  }
}

test("owner lease expiry interrupts a running worker; a foreign owner cannot renew it", async () => {
  // cli-1: polling more slowly than the lease still keeps the selected owner alive.
  const held = fixture("w5-working");
  // A 2 s lease leaves room for timer delays on loaded CI hosts; the poll interval stays longer than the lease.
  const active = json(held.call("task", "--detached", "--json", "--lease-sec", "2", "fixture"));
  try {
    await waitUntil(() => storedJob(held, active.jobId).turnId);
    const status = json(held.call("status", active.jobId, "--owner", active.ownerId, "--wait", "--timeout-ms", "3000", "--poll-interval-ms", "3000", "--json"));
    assert.equal(status.job.status, "running");
    assert.equal(job(held, active.jobId).status, "running");
    assert.equal(job(held, active.jobId).interruptionReason ?? null, null);
  } finally {
    assert.equal(json(held.call("cancel", active.jobId, "--json")).confirmation, "confirmed");
  }
  assert.equal(job(held, active.jobId).status, "cancelled");
  const f = fixture(), launch = json(f.call("task", "--detached", "--json", "--lease-sec", "180", "--owner", "fixture-owner", "fixture"));
  await waitUntil(() => storedJob(f, launch.jobId).turnId);
  patchJob(f, launch.jobId, { leaseExpiresAt: Date.now() - 1 });
  await waitUntil(() => storedJob(f, launch.jobId).status === "interrupted");
  const result = json(f.call("wait", launch.jobId, "--timeout-sec", "6", "--json", "--report"), 1);
  assert.equal(result.status, "interrupted"); assert.equal(result.interruptionReason, "lease_expired"); assert.equal(result.interruptionConfirmed, true);
  assert.ok(result.continuationCommand.includes(`task --continue '${launch.jobId}' --cwd '${f.repo}' --follow --report --json`));
  const late = json(f.call("wait", launch.jobId, "--owner", launch.ownerId, "--json"), 1);
  assert.equal(late.interruptionReason, "lease_expired");
  assert.equal(f.state().nextTurnId, 2, "Late owner polling must not start a new turn");
  assert.equal(json(f.call("result", launch.jobId, "--json")).storedJob.report.continuationCommand, result.continuationCommand);
  const expired = json(f.call("adopt", launch.jobId, "--json"), 2);
  assert.equal(expired.status, "lease_expired"); assert.equal(expired.adopted, false);
  assert.equal(expired.continuationCommand, result.continuationCommand);
  assert.equal(job(f, launch.jobId).ownerId, launch.ownerId);
  assert.equal(f.state().nextTurnId, 2, "Expired adoption never starts another turn");
});

test("task-worker SIGTERM resolves a pending question and confirms its turn interruption", async () => {
  const f = fixture("w5-parent"), launch = json(f.call("task", "--detached", "--json", "fixture"));
  const pending = json(f.call("wait", launch.jobId, "--json"));
  const owned = job(f, launch.jobId);
  process.kill(owned.pid, "SIGTERM"); // This worker was just spawned by this fixture.
  const done = json(f.call("wait", launch.jobId, "--after-question", pending.question.id, "--json", "--report"), 1);
  assert.equal(done.interruptionReason, "signal_sigterm"); assert.equal(done.interruptionConfirmed, true);
  assert.equal(done.turnId, pending.turnId);
  await waitUntil(() => !alive(owned.pid));
});

test("cancel or parent exit interrupts foreground work without killing a saved PID", async () => {
  for (const [command, reason, scenario] of [["review", "cancelled_by_user"], ["task", "parent_exit", "startup"], ["task", "parent_exit", "closed-stderr"]]) {
    const f = fixture(command === "review" ? "w5-review" : "w5-working", scenario === "startup" ? { mutable: true } : undefined);
    const probing = path.join(f.dir, "probing"), release = path.join(f.dir, "release-probe");
    if (scenario === "startup") {
      const binary = path.join(f.dir, "codex"), anchor = 'const fs = require("node:fs");';
      const source = fs.readFileSync(binary, "utf8");
      assert.ok(source.includes(anchor));
      fs.writeFileSync(binary, source.replace(anchor, `${anchor}
        if (process.argv.includes('--version') && !fs.existsSync(${JSON.stringify(release)})) {
          fs.writeFileSync(${JSON.stringify(probing)}, 'ready');
          while (!fs.existsSync(${JSON.stringify(release)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        }
      `));
    }
    if (command === "task") json(run(process.execPath, [script, "journal", "start", "--json"], {
      cwd: f.repo, env: f.env, input: JSON.stringify({ goal: "Persist foreground interruption", criteria: [] })
    }));
    const args = command === "review" ? ["review", "--scope", "working-tree", "--json"] : ["task", "--fresh", "--json", "fixture"];
    const processModule = new URL("../plugins/codex/scripts/lib/process.mjs", import.meta.url).href;
    const parent = spawnOwned(process.execPath, ["--input-type=module", "-e", `
      import { spawnOwned } from ${JSON.stringify(processModule)};
      const child = spawnOwned(process.execPath, ${JSON.stringify([script, ...args])}, { stdio: ['ignore', 'ignore', 2] });
      child.on('exit', code => { process.exitCode = code; });
    `], { cwd: f.repo, env: f.env, stdio: ["ignore", "ignore", "pipe"] });
    const parentExit = new Promise(resolve => parent.once("exit", resolve));
    let stderr = ""; parent.stderr.on("data", chunk => { stderr += chunk; });
    const id = await waitUntil(() => /Job handle: ([^;]+);/.exec(stderr)?.[1]);
    const read = () => readJobFile(path.join(resolveStateDir(f.repo, f.env), "jobs", `${id}.json`));
    if (scenario === "startup") await until(() => fs.existsSync(probing));
    const initial = scenario === "startup" ? read() : await until(() => { const current = read(); return current.turnId && current; });
    assert.equal(initial.status, "running");
    if (command === "task" && scenario !== "startup") await until(() => read().leaseRenewedAt > initial.leaseRenewedAt);
    if (scenario === "closed-stderr") {
      const closed = new Promise(resolve => parent.stderr.once("close", resolve));
      parent.stderr.destroy();
      await closed;
    }
    if (reason === "parent_exit") {
      parent.kill("SIGKILL");
      await parentExit;
      if (scenario === "startup") fs.writeFileSync(release, "go");
    }
    else {
      const cancelled = json(f.call("cancel", id, "--json"));
      assert.equal(cancelled.confirmation, "confirmed");
    }
    await until(() => !alive(initial.pid) && !alive(parent.pid));
    const stopped = read();
    assert.equal(stopped.status, reason === "parent_exit" ? "interrupted" : "cancelled");
    assert.equal(stopped.result.interruptionReason, reason);
    assert.equal(stopped.result.interruptionConfirmed, scenario !== "startup");
    if (scenario === "startup") {
      assert.ok(!stopped.turnId);
      const requests = fs.existsSync(path.join(f.dir, "fake-codex-state.json.requests.jsonl")) ? f.requests() : [];
      assert.ok(!requests.some(request => ["thread/start", "thread/resume", "turn/start"].includes(request.method)), "parent loss during availability must not dispatch a turn");
    } else assert.equal(f.state().lastInterrupt.turnId, initial.turnId);
    if (command === "task") {
      const runDir = path.join(stopped.runStateDir, "runs", stopped.runId);
      const finishes = fs.readFileSync(path.join(runDir, "journal.jsonl"), "utf8").trim().split("\n").map(JSON.parse).filter(event => event.type === "job_finished");
      assert.equal(finishes.length, 1, "finalize the journal before any result query can recover the job");
      assert.equal(finishes[0].status, "interrupted");
      assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, finishes[0].report), "utf8")).interruptionReason, reason);
    }
    const details = json(f.call("result", id, "--details"), 1);
    assert.equal(details.status, stopped.status);
    assert.equal(details.interruptionReason, reason);
    if (command === "task") {
      // Both real processes have exited; the subsequent details query must not
      // renew the stopped worker's lease either.
      assert.equal(read().leaseRenewedAt, stopped.leaseRenewedAt);
      assert.equal(read().leaseExpiresAt, stopped.leaseExpiresAt);
    }
  }
});

test("pause adjustment excludes suspended time, caps timestamps and preserves owner-loss grace", t => {
  let now = 100000, tick;
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "setInterval", callback => { tick = callback; return null; });
  const cwd = makeTempDir(), gap = 7000;
  for (const first of ["worker", "owner"]) {
    const id = `pause-${first}`;
    const record = { id, status: "running", ownerId: "owner", ownerAttached: true,
      leaseSec: 6, leaseRenewedAt: now, leaseExpiresAt: now + 6000 };
    writeJobFile(cwd, id, record);
    const runtime = new JobRuntime(cwd, id);
    try {
      now += gap;
      if (first === "owner") assert.equal(renewLease(cwd, id, "owner").leaseExpiresAt, record.leaseExpiresAt);
      tick();
      const shifted = readJobFile(resolveJobFile(cwd, id));
      assert.equal(runtime.reason, null);
      assert.equal(shifted.lastPauseMs, gap);
      assert.equal(shifted.leaseRenewedAt, now);
      assert.equal(shifted.leaseExpiresAt, now + 6000);
      assert.equal(renewLease(cwd, id, "owner").leaseExpiresAt, now + 6000);
      assert.equal(ownerLost(shifted, now + 4999), false);
      assert.equal(ownerLost(shifted, now + 5000), true);
      const renewedFirst = { ...record, leaseRenewedAt: now, leaseExpiresAt: now + 6000 };
      assert.equal(pauseAdjustment(renewedFirst, gap, now).leaseRenewedAt, now);
      // A host pause shifts a running-time budget like the lease; it never counts as work.
      assert.equal(pauseAdjustment({ ...record, budget: { maxMinutes: 1, consumedMs: 250, runningSince: now - gap - 250 } }, gap, now).budget.runningSince, now - 250);
      assert.equal(pauseAdjustment({ ...record, cancelRequested: {} }, gap, now), null);
      assert.equal(pauseAdjustment({ ...record, status: "completed" }, gap, now), null);
    } finally { runtime.close(); }
  }
  const lease = { status: "running", leaseSec: 180, leaseRenewedAt: 1000, leaseExpiresAt: 181000 };
  assert.equal(leaseSnapshot(lease, 65999).orphaned, false);
  assert.equal(leaseSnapshot(lease, 66000).orphaned, true);
  const directLease = { ...lease, direct: true, leaseSec: 1800, leaseExpiresAt: 1801000 };
  assert.equal(leaseSnapshot(directLease, 900999).orphaned, false);
  assert.equal(leaseSnapshot(directLease, 901000).orphaned, true);
});

test("an owner renewal refused just after wake succeeds after the worker's pause adjustment", t => {
  const cwd = makeTempDir(), gap = 30 * 60 * 1000, now = Date.now();
  t.mock.method(Date, "now", () => now);
  const record = { id: "paused-owner-test", ownerId: "owner", status: "running", ownerAttached: true, leaseSec: 180, leaseRenewedAt: now - gap - 500, leaseExpiresAt: now - gap - 500 + 180000 };
  writeJobFile(cwd, record.id, record);
  assert.deepEqual(renewLease(cwd, record.id, "owner"), record, "expiry still refuses renewal before the wake tick");
  const shifted = updateJob(cwd, record.id, current => pauseAdjustment(current, gap, now));
  assert.equal(shifted.leaseRenewedAt, now - 500);
  const renewed = renewLease(cwd, record.id, "owner");
  assert.equal(renewed.leaseRenewedAt, now); assert.equal(renewed.leaseExpiresAt, now + 180000);

  // delta-1: exercise the status timer itself in both wake orderings. The
  // expired renewal stays refused until the worker adjusts its lease.
  for (const order of ["status-first"]) {
    const f = fixture(), preload = path.join(f.dir, "status-wake.mjs");
    const stateModule = new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url).href;
    const runtimeModule = new URL("../plugins/codex/scripts/lib/job-runtime.mjs", import.meta.url).href;
    fs.writeFileSync(preload, `
      import { updateJob, writeJobFile, upsertJob } from ${JSON.stringify(stateModule)};
      import { pauseAdjustment, JobRuntime } from ${JSON.stringify(runtimeModule)};
      const cwd = process.cwd(), id = 'status-wake', realNow = Date.now, timeout = globalThis.setTimeout;
      let offset = 0, renewals = 0, runtime, control;
      Date.now = () => realNow() + offset;
      const record = { id, jobClass: 'task', status: 'running', workspaceRoot: cwd, pid: process.pid,
        ownerId: 'owner', leaseSec: 1, leaseExpiresAt: Date.now() + 1000, leaseRenewedAt: Date.now() };
      writeJobFile(cwd, id, record); upsertJob(cwd, record);
      globalThis.setTimeout = (fn, ms, ...args) => {
        if (!String(fn).includes('scheduleRenewal(renewLease')) return timeout(fn, ms, ...args);
        return timeout(() => {
          if (++renewals !== 1) { fn(); return; }
          offset += 10000;
          const shift = () => updateJob(cwd, id, current => pauseAdjustment(current, 10000, Date.now()));
          if (${JSON.stringify(order)} === 'worker-first') shift();
          fn();
          if (${JSON.stringify(order)} === 'status-first') shift();
          runtime = new JobRuntime(cwd, id);
          runtime.abort.signal.addEventListener('abort', () => {
            updateJob(cwd, id, () => ({ status: 'interrupted' }));
            clearTimeout(control); runtime.close();
          });
          control = timeout(() => {
            updateJob(cwd, id, () => ({ status: 'completed', result: { status: 0, turnEnded: true } })); runtime.close();
          }, 1400);
        }, ms, ...args);
      };
      process.on('exit', () => runtime?.close());
    `);
    const status = json(run(process.execPath, ["--import", preload, script, "status", "status-wake", "--owner", "owner", "--wait",
      "--timeout-ms", "30000", "--poll-interval-ms", "100", "--json"], { cwd: f.repo, env: f.env }));
    assert.equal(status.job.status, "completed"); assert.equal(status.waitTimedOut, false);
    assert.equal(status.job.cancelRequested, undefined);
  }
});

test("watchdog rechecks stale ownership and lease observations before cancelling or aborting", t => {
  const now = 100000;
  let tick;
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "setInterval", callback => { tick = callback; return null; });
  for (const action of ["adopt", "renew", "reattach", "lease-renewed"]) {
    const cwd = makeTempDir(), id = `watchdog-${action}`;
    const record = { id, jobClass: "task", status: "running", workspaceRoot: cwd, sessionId: "old-session", ownerId: "owner",
      ownerAttached: action !== "reattach", ownerAttachedAt: now - 20000,
      ownerDetachedAt: action === "reattach" ? now - 1000 : null, ownerDetachReason: action === "reattach" ? "signal" : null,
      leaseSec: 180, leaseRenewedAt: now - 10000, leaseExpiresAt: action === "lease-renewed" ? now - 1 : now + 180000 };
    writeJobFile(cwd, id, record); upsertJob(cwd, record);
    const file = resolveJobFile(cwd, id), read = fs.readFileSync;
    let interleaved = false, progressCalls = 0;
    const reader = t.mock.method(fs, "readFileSync", function(target, ...args) {
      const contents = read.call(this, target, ...args);
      if (!interleaved && target === file) {
        interleaved = true;
        if (action === "adopt") assert.equal(adoptJob(cwd, id, "new-session").adopted, true);
        else if (action === "renew") renewLease(cwd, id, record.ownerId);
        else if (action === "reattach") markOwnerAttachment(cwd, id, record.ownerId);
        else if (action === "owner-changed") updateJob(cwd, id, () => ({ ownerId: "replacement" }));
        else if (action === "attachment-changed") updateJob(cwd, id, () => ({ ownerAttachedAt: now }));
        else updateJob(cwd, id, () => ({ leaseRenewedAt: now, leaseExpiresAt: now + 180000 }));
      }
      return contents;
    });
    let runtime;
    try {
      runtime = new JobRuntime(cwd, id, { onProgress: () => { progressCalls++; } });
      assert.equal(interleaved, true);
      assert.equal(readJobFile(file).cancelRequested, undefined);
      assert.equal(runtime.reason, null); assert.equal(runtime.abort.signal.aborted, false); assert.equal(progressCalls, 0);
      // The skipped observation must not latch the runtime: a current trigger
      // on its next tick still cancels and aborts normally.
      updateJob(cwd, id, () => ({ leaseExpiresAt: now - 1 }));
      tick();
      assert.equal(readJobFile(file).cancelRequested.reason, "lease_expired");
      assert.equal(runtime.reason, "lease_expired"); assert.equal(runtime.abort.signal.aborted, true); assert.equal(progressCalls, 1);
    } finally { reader.mock.restore(); runtime?.close(); }
  }
});

test("an owner wait that dies abruptly interrupts the worker after the grace period", async () => {
  const f = fixture(); f.env.CODEX_COMPANION_OWNER_GRACE_SEC = "2";
  const launch = json(f.call("task", "--detached", "--json", "fixture"));
  const owner = spawnOwned(process.execPath, [script, "wait", launch.jobId, "--owner", launch.ownerId, "--timeout-sec", "60", "--json"], { cwd: f.repo, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
  await waitUntil(() => storedJob(f, launch.jobId).ownerAttached && job(f, launch.jobId).turnId);
  owner.kill("SIGKILL"); // Simulates Claude Code killing the Bash command when the user stops the agent.
  const result = json(f.call("wait", launch.jobId, "--timeout-sec", "15", "--json", "--report"), 1);
  assert.equal(result.status, "interrupted"); assert.equal(result.interruptionReason, "owner_lost"); assert.equal(result.interruptionConfirmed, true);

  assert.ok(result.continuationCommand.includes(`task --continue '${launch.jobId}'`));
  assert.equal(f.state().lastInterrupt.turnId, result.turnId);
});

test("a signalled owner wait stops the worker immediately; only a silent owner gets the grace period; interrupts clean background terminals", async t => {
  const cleanMethod = "thread/backgroundTerminals/clean";
  const storedJob = (f, id) => readJobFile(path.join(resolveStateDir(f.repo, f.env), "jobs", `${id}.json`));
  const checkCleanup = (f, id, scenario, cleaned, external = false) => {
    const stored = storedJob(f, id), outcome = stored.backgroundTerminals;
    assert.equal(outcome.cleaned, cleaned);
    if (cleaned) assert.equal(outcome.detail, null);
    else { assert.equal(typeof outcome.detail, "string"); assert.ok(outcome.detail.length > 0); }
    const requests = f.requests().filter(request => request.params.threadId === stored.threadId);
    const interrupts = requests.filter(request => request.method === "turn/interrupt");
    const cleans = requests.filter(request => request.method === cleanMethod);
    assert.ok(interrupts.length > 0); assert.equal(cleans.length, 1);
    assert.deepEqual(cleans[0].params, { threadId: stored.threadId });
    assert.deepEqual(interrupts.at(-1).params, { threadId: stored.threadId, turnId: stored.turnId });
    assert.ok(requests.indexOf(interrupts.at(-1)) < requests.indexOf(cleans[0]));
    assert.equal(cleans[0].serverId, interrupts.at(-1).serverId);
    if (external) {
      const reads = requests.filter(request => request.method === "thread/read");
      assert.ok(reads.length > 0);
      assert.ok(requests.indexOf(interrupts.at(-1)) < requests.indexOf(reads[0]));
      assert.ok(requests.indexOf(reads.at(-1)) < requests.indexOf(cleans[0]));
      for (const request of reads) assert.equal(request.serverId, cleans[0].serverId);
    } else assert.equal(cleans[0].serverId, requests.find(request => request.method === "turn/start").serverId);
    const code = stored.turnResolution === "in_progress" ? 0 : 1;
    assert.deepEqual(json(f.call("result", id, "--details"), code).backgroundTerminals, outcome);
    assert.equal(Object.hasOwn(json(f.call("result", id, "--report", "--json"), code), "backgroundTerminals"), false);
    return stored;
  };
  const f = fixture();
  const launch = json(f.call("task", "--detached", "--json", "fixture"));
  const owner = spawnOwned(process.execPath, [script, "wait", launch.jobId, "--owner", launch.ownerId, "--timeout-sec", "60", "--direct"], { cwd: f.repo, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  owner.stdout.on("data", chunk => { stdout += chunk; }); owner.stderr.on("data", chunk => { stderr += chunk; });
  const ownerClosed = new Promise(resolve => owner.on("close", resolve));
  await waitUntil(() => stdout.includes("\n") && job(f, launch.jobId).ownerAttached && job(f, launch.jobId).turnId);
  owner.kill("SIGTERM"); // Claude Code stopping the agent's Bash call, or Ctrl+C on a terminal --follow.
  const code = await ownerClosed;
  assert.equal(code, 130);
  const lines = directLines(stdout);
  assert.ok(lines.length > 1, "progress precedes the owner_stopped report"); assert.equal(stderr, "");
  const stopped = JSON.parse(lines.at(-1));
  assert.equal(stopped.status, "owner_stopped"); assert.equal(stopped.jobId, launch.jobId);
  assert.equal(stopped.worker, launch.agentName);
  const result = json(f.call("wait", launch.jobId, "--timeout-sec", "10", "--json", "--report"), 1);
  assert.equal(result.status, "interrupted"); assert.equal(result.interruptionReason, "owner_stopped"); assert.equal(result.interruptionConfirmed, true);

  assert.ok(result.continuationCommand.includes(`task --continue '${launch.jobId}'`));
  const detached = job(f, launch.jobId);
  assert.equal(detached.ownerAttached, false); assert.equal(detached.ownerDetachReason, "signal");
  checkCleanup(f, launch.jobId, "owner_stopped", true);
  // ownerLost semantics, evaluated directly (this process uses the default 5 s grace).
  const active = { ...detached, status: "running" };
  assert.equal(ownerLost(active, active.ownerDetachedAt + 1), true, "signal/parent_exit/stdout_closed detaches count immediately");
  assert.equal(ownerLost({ ...active, ownerDetachReason: "returned" }, active.ownerDetachedAt + 60000), false, "a clean return falls back to the lease");
  assert.equal(ownerLost({ ...active, ownerDetachReason: null, ownerDetachedAt: null }, active.ownerDetachedAt + 60000), false, "never attached: lease only");
  const silent = { ...active, ownerAttached: true, leaseRenewedAt: 1000 };
  assert.equal(ownerLost(silent, 1000 + 4999), false); assert.equal(ownerLost(silent, 1000 + 5000), true, "a silent heartbeat is given 5 s");

  // A live worker uses its own connection, including when cleanup fails.
  // Successful live-worker cleanup was checked with the signalled owner above.
  for (const behavior of ["unsupported"]) {
    const running = fixture(); running.env.CODEX_FIXTURE_TERMINALS_CLEAN = behavior;
    const started = json(running.call("task", "--detached", "--json", "fixture"));
    await waitUntil(() => storedJob(running, started.jobId).turnId);
    const cancelled = json(running.call("cancel", started.jobId, "--json"));
    assert.equal(cancelled.status, "cancelled"); assert.equal(cancelled.confirmation, "confirmed");
    assert.equal(cancelled.turnInterruptAttempted, true); assert.equal(cancelled.turnInterrupted, true);
    assert.equal(cancelled.reason, "cancelled_by_user");
    const saved = checkCleanup(running, started.jobId, `cancel_worker_${behavior}`, behavior === "supported");
    assert.equal(saved.status, "cancelled"); assert.equal(saved.result.interruptionConfirmed, true);
    assert.deepEqual(cancelled.backgroundTerminals, saved.backgroundTerminals);
  }

  // A lost wrapper is cancelled through the replacement broker. Even an
  // unconfirmed interrupt cleans after the last exact-turn poll.
  const lost = fixture("lost-turn:inProgress");
  const failed = lost.call("task", "--report", "--json", "fixture");
  assert.equal(failed.status, 1);
  const id = /Job handle: ([^;]+)/.exec(failed.stderr)?.[1]; assert.ok(id);
  const original = storedJob(lost, id);
  assert.equal(original.result.turnEnded, false);
  await waitUntil(() => !alive(lost.requests()[0].serverId));
  for (const behavior of ["unconfirmed"]) {
    lost.env.CODEX_FIXTURE_TERMINALS_CLEAN = behavior;
    if (behavior === "unconfirmed") fs.writeFileSync(path.join(lost.dir, "fake-codex-state.json"), JSON.stringify({ ...lost.state(), ignoreInterrupt: true }));
    const confirmed = behavior !== "unconfirmed";
    const cancelled = json(lost.call("cancel", id, "--json"), confirmed ? 0 : 2);
    assert.equal(cancelled.status, confirmed ? "cancelled" : "interrupt_unconfirmed");
    assert.equal(cancelled.confirmation, confirmed ? "confirmed" : "unconfirmed");
    assert.equal(cancelled.turnInterruptAttempted, true); assert.equal(cancelled.turnInterrupted, confirmed);
    const saved = checkCleanup(lost, id, `cancel_broker_${behavior}`, behavior !== "unsupported", true);
    assert.deepEqual(cancelled.backgroundTerminals, saved.backgroundTerminals);
    if (confirmed) assert.equal(saved.result.interruptionConfirmed, true);
    else assert.deepEqual(saved.result, original.result);
  }

  // A killed worker cannot run its grant releases. Recovery restores the
  // preexisting session grant, while a live worker retains its task approval.
  const grant = fixture("computer-use-requests", { mutable: true }), binary = path.join(grant.dir, "codex");
  fs.writeFileSync(binary, fs.readFileSync(binary, "utf8").replace("if (pending.questionItem) {", "if (BEHAVIOR === 'computer-use-requests') return;\n      if (pending.questionItem) {"));
  const granted = json(grant.call("task", "--detached", "--json", "fixture"));
  const question = await waitUntil(() => storedJob(grant, granted.jobId).pendingQuestion);
  const grantJob = storedJob(grant, granted.jobId);
  const grantFile = path.join(grant.env.CODEX_COMPANION_HOME, "computer-use", "sessions", `${grantJob.threadId}.toml`);
  const baseline = '[apps]\nallowed = ["com.apple.TextEdit"]\n';
  fs.mkdirSync(path.dirname(grantFile), { recursive: true }); fs.writeFileSync(grantFile, baseline);
  json(grant.answer(granted.jobId, question.id, "Allow for this task"));
  await waitUntil(() => fs.readFileSync(grantFile, "utf8").includes("com.google.Chrome"));
  json(grant.call("status", granted.jobId, "--json"));
  assert.ok(fs.readFileSync(grantFile, "utf8").includes("com.google.Chrome"));
  process.kill(grantJob.pid, "SIGKILL"); await waitUntil(() => !alive(grantJob.pid));
  json(grant.call("status", granted.jobId, "--json"));
  assert.equal(fs.readFileSync(grantFile, "utf8"), baseline);
  assert.equal(storedJob(grant, granted.jobId).status, "failed");
  grant.call("cancel", granted.jobId, "--json");
});

test("closed stdout during direct progress stops the owner without a crash", async () => {
  const f = fixture(), launch = json(f.call("task", "--detached", "--json", "fixture"));
  const owner = spawnOwned(process.execPath, [script, "wait", launch.jobId, "--owner", launch.ownerId, "--timeout-sec", "60", "--direct"], { cwd: f.repo, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = ""; owner.stderr.on("data", chunk => { stderr += chunk; });
  const closed = new Promise(resolve => owner.on("close", resolve));
  owner.stdout.destroy();
  assert.equal(await closed, 130, stderr); assert.equal(stderr, "");
  assert.equal(job(f, launch.jobId).ownerDetachReason, "stdout_closed");
  const result = json(f.call("wait", launch.jobId, "--timeout-sec", "10", "--json"), 1);
  assert.equal(result.status, "interrupted"); assert.equal(result.interruptionReason, "owner_stopped"); assert.equal(result.interruptionConfirmed, true);
});

test("a direct owner renews under stdout backpressure and retains activity accounting", async t => {
  const result = await backpressureScenario(script);
  const payload = direct({ status: result.code, stdout: result.stdout, stderr: result.stderr });
  assert.equal(result.stderr, "");
  assert.equal(payload.status, "completed");
  assert.equal(result.saved.result.interruptionReason, null);
  assert.equal(result.saved.ownerDetachReason, "returned");
  assert.equal(result.measurements.statusBeforeDrain, "running");
  assert.ok(result.omissionLines.length >= 1, "the undrained pipe overflows the progress queue");
  assert.ok(result.measurements.omittedLines > 200, "the bounded queue sheds excess progress");
  assert.equal(result.measurements.progressLines - result.omissionLines.length + result.measurements.omittedLines, result.saved.activityTotals.events, "display omissions do not lose event accounting");
  assert.equal(result.saved.activity.length, ACTIVITY_RETAINED_MAX);
  const cwd = makeTempDir(), id = "retained-activity";
  const activity = [{ type: "commandExecution", command: "node --test", lifecycle: "started", seq: 1 }];
  const workerResult = { status: 0, rawOutput: "Completed.", commandExecutions: [{ command: "node --test", status: "completed", exitCode: 0 }] };
  const report = buildWorkerReport(workerResult, { jobId: id });
  const record = { id, workspaceRoot: cwd, jobClass: "task", status: "completed", result: workerResult, report, activity, activitySeq: 1 };
  writeJobFile(cwd, id, record); upsertJob(cwd, record);
  createJobProgressUpdater(cwd, id)({ activity: Array.from({ length: 600 }, () => ({ type: "plan", steps: [] })) });
  createJobProgressUpdater(cwd, id)({ activity: [{ type: "commandExecution", command: "node --test", lifecycle: "completed" }] });
  const retained = readJobFile(resolveJobFile(cwd, id));
  assert.equal(retained.activity.length, ACTIVITY_RETAINED_MAX);
  assert.deepEqual(retained.activityTotals, { events: 602, toolUses: 1 });
  assert.deepEqual(retained.activityPendingTools, {});
  assert.equal(fullReport(report, retained).activityCount, 602);
  assert.deepEqual(directReport(report, retained).checks, directReport(report, record).checks);
  const fresh = json(run(process.execPath, [script, "wait", id, "--owner", "late", "--json"], { cwd }));
  assert.equal(fresh.activityEvicted, 602 - ACTIVITY_RETAINED_MAX);
  assert.equal(fresh.activityCount, 602); assert.equal(fresh.cursor, 602);
  assert.equal(json(run(process.execPath, [script, "wait", id, "--owner", "late", "--json"], { cwd })).activityCount, 0);
  createJobProgressUpdater(cwd, id)({ activity: Array.from({ length: 150 }, (_, i) => ({
    type: "commandExecution", command: `pending-${i}`, lifecycle: "started"
  })) });
  const pending = readJobFile(resolveJobFile(cwd, id));
  assert.ok(Object.keys(pending.activityPendingTools).length <= ACTIVITY_PENDING_MAX);
  const stateFile = path.join(resolveStateDir(cwd), "state.json"), index = JSON.parse(fs.readFileSync(stateFile));
  assert.equal(Object.hasOwn(index.jobs.find(job => job.id === id), "activityPendingTools"), false);
  index.jobs.find(job => job.id === id).activityPendingTools = pending.activityPendingTools;
  fs.writeFileSync(stateFile, JSON.stringify(index));
  for (const args of [["status", id, "--json"], ["result", id, "--details"]]) {
    assert.equal(JSON.stringify(json(run(process.execPath, [script, ...args], { cwd }))).includes('"activityPendingTools"'), false);
  }
  createJobProgressUpdater(cwd, id)({ activity: [{ type: "commandExecution", command: "pending-149", lifecycle: "completed" }] });
  assert.equal(readJobFile(resolveJobFile(cwd, id)).activityTotals.toolUses, pending.activityTotals.toolUses);

});
