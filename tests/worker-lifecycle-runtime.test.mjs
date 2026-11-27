import test from 'node:test';
import assert from 'node:assert/strict';
import { lifecycleHarness } from './fake-codex-fixture.mjs';
import { createJobProgressUpdater, createProgressReporter, runTrackedJob } from '../plugins/codex/scripts/lib/tracked-jobs.mjs';
const {
  fs, path, makeTempDir, initGitRepo, resolveStateDir, run, writeJobFile, upsertJob, updateJob, readJobFile, resolveJobFile, JobRuntime, resolveSessionMarkersRoot, AGENT_NAMES, pickAgentName, spawnOwned, script, alive, fixture, json, direct, waitUntil, patchJob, job
} = await lifecycleHarness();

const storedJob = (f, id) => readJobFile(path.join(resolveStateDir(f.repo, f.env), "jobs", `${id}.json`));

test("a broker resume waits for another runtime's active writer to release the thread", async t => {
  const { CodexAppServerClient } = await import("../plugins/codex/scripts/lib/app-server.mjs");
  const { readyBroker, requireLocalSockets } = await import("./helpers.mjs");
  if (!await requireLocalSockets(t)) return;
  const f = fixture("writer-lock");
  f.env.CODEX_COMPANION_BROKER_WAIT_MS = "30000";
  const owner = await CodexAppServerClient.connect(f.repo, { env: f.env, disableBroker: true });
  t.after(() => owner.close());
  const { thread } = await owner.request("thread/start", { cwd: f.repo, sandbox: "read-only" });
  const broker = await readyBroker(f.repo, f.env);
  t.after(broker.close);
  const brokerServerPid = f.state().launches.at(-1).pid;
  const child = spawnOwned(process.execPath, [script, "task", "--thread", thread.id, "--sandbox", "read-only", "--report", "--json", "follow up"],
    { cwd: f.repo, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", result = null;
  child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
  const done = new Promise(resolve => child.once("close", status => { result = { status, stdout, stderr }; resolve(result); }));
  t.after(async () => { if (!result) child.kill("SIGTERM"); await done; });
  const resumes = () => fs.existsSync(path.join(f.dir, "fake-codex-state.json.requests.jsonl"))
    ? f.requests().filter(request => request.method === "thread/resume" && request.params.threadId === thread.id) : [];
  await waitUntil(() => result || resumes().length >= 2);
  assert.ok(resumes().length >= 2, "the broker's active-writer rejection must retry before the holder exits");
  assert.equal(f.requests().filter(request => request.method === "turn/start").length, 0);
  await owner.close();
  const report = json(await done);
  assert.equal(report.status, "completed");
  assert.equal(report.threadId, thread.id);
  assert.ok(resumes().every(request => request.serverId === brokerServerPid));
  const starts = f.requests().filter(request => request.method === "turn/start");
  assert.equal(starts.length, 1); assert.equal(starts[0].serverId, brokerServerPid);
  assert.equal(f.state().appServerStarts, 2, "the waiter reuses the broker without spawning a private runtime");
});

test("unknown-thread follow-ups settle failed for direct and owner waits without repeated recovery reads", async t => {
  for (const directMode of [true, false]) {
    await t.test(directMode ? "direct task" : "owner wait", async () => {
      const f = fixture("task-ok"), threadId = "thr_missing";
      const task = ["task", "--thread", threadId, "--sandbox", "read-only"];
      const launch = directMode ? null : json(f.call(...task, "--detached", "--json", "follow up"));
      const args = directMode ? [...task, "--direct", "--quiet", "follow up"]
        : ["wait", launch.jobId, "--owner", launch.ownerId, "--json"];
      const child = spawnOwned(process.execPath, [script, ...args], { cwd: f.repo, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "", result = null;
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      const closed = new Promise(resolve => child.once("close", status => { result = { status, stdout, stderr }; resolve(); }));
      const requests = () => fs.existsSync(path.join(f.dir, "fake-codex-state.json.requests.jsonl")) ? f.requests() : [];
      const reads = () => requests().filter(request => request.method === "thread/read").length;
      try {
        // Bound the regression by protocol requests, independent of startup speed.
        await waitUntil(() => result || reads() > 2);
        assert.ok(reads() <= 2, "a failed resume must not keep probing an unknown thread");
        const report = directMode ? direct(result, 1) : json(result, 1);
        assert.equal(report.status, "failed");
        const saved = storedJob(f, report.jobId);
        assert.equal(saved.turnId ?? null, null);
        assert.equal(saved.result.turnStatus, "notStarted");
        assert.equal(saved.result.turnEnded, true);
        assert.equal(saved.errorMessage, `unknown thread ${threadId}`);
        assert.equal(requests().filter(request => request.method === "thread/resume").length, 1);
        assert.equal(requests().filter(request => request.method === "turn/start").length, 0);
      } finally {
        if (!result) child.kill("SIGTERM");
        await closed;
      }
    });
  }
});

test("simultaneous dispatches reserve different names while both jobs are active", async () => {
  const f = fixture();
  const preload = path.join(f.dir, "fixed-name-choice.mjs");
  fs.writeFileSync(preload, 'const random = Math.random; Math.random = () => new Error().stack.includes("pickAgentName") ? 0 : random();');
  const dispatch = name => new Promise((resolve, reject) => {
    const child = spawnOwned(process.execPath, ["--import", preload, script, "task", "--fresh", "--name", name, "--detached", "--json", "fixture"],
      { cwd: f.repo, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    child.on("error", reject);
    child.on("close", status => { try { resolve(json({ status, stdout, stderr })); } catch (error) { reject(error); } });
  });
  const launches = await Promise.all([dispatch("demo-1"), dispatch("DEMO-1")]);
  try {
    assert.equal(new Set(launches.map(launch => launch.agentName.toLowerCase())).size, 2);
    assert.ok(launches.some(launch => launch.agentName.toLowerCase() === "demo-1"));
    for (const launch of launches) {
      const saved = job(f, launch.jobId);
      assert.ok(["queued", "running"].includes(saved.status));
      assert.equal(saved.agentName, launch.agentName);
    }
  } finally {
    for (const launch of launches) json(f.call("cancel", launch.jobId, "--json"));
  }

  // Hold one connection's empty pre-check snapshot while another workspace
  // attempts admission. The second caller must finish without entering it.
  const race = fixture("review-ok", { mutable: true });
  const other = path.join(race.dir, "other"), ready = path.join(race.dir, "reads"), gate = path.join(race.dir, "release-read");
  const armed = path.join(race.dir, "hold-reads");
  fs.mkdirSync(other); initGitRepo(other); fs.mkdirSync(ready);
  const binary = path.join(race.dir, "codex"), source = fs.readFileSync(binary, "utf8");
  const reply = 'send({ id: message.id, result: { thread: { ...buildThread(thread), turns: thread.turns || [] } } });';
  assert.ok(source.includes(reply));
  fs.writeFileSync(binary, source.replace(reply, `
    if (!fs.existsSync(${JSON.stringify(armed)})) { ${reply} return; }
    fs.writeFileSync(${JSON.stringify(ready)} + '/' + process.pid, 'ready');
    const snapshot = { thread: { ...buildThread(thread), turns: thread.turns || [] } };
    const timer = setInterval(() => {
      if (fs.existsSync(${JSON.stringify(gate)})) { clearInterval(timer); send({ id: message.id, result: snapshot }); }
    }, 20);
  `));
  // Install the gate before starting the seed thread: its broker may stay warm
  // for the race, so replacing the executable afterwards misses that process.
  const first = direct(race.call("task", "--fresh", "--direct", "fixture"));
  const threadId = job(race, first.jobId).threadId;
  fs.writeFileSync(armed, "armed");
  const start = cwd => {
    const child = spawnOwned(process.execPath, [script, "task", "--thread", threadId, "--sandbox", "read-only", "--direct", "--quiet", "fixture"],
      { cwd, env: race.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
    return { child, done: new Promise(resolve => child.once("close", status => resolve({ status, stdout, stderr }))) };
  };
  const offset = race.requests().length, a = start(race.repo);
  let b;
  try {
    await waitUntil(() => fs.readdirSync(ready).length === 1);
    b = start(other);
    let secondDone = false;
    b.done.then(() => { secondDone = true; });
    await waitUntil(() => secondDone || fs.readdirSync(ready).length === 2);
    fs.writeFileSync(gate, "release");
    const results = await Promise.all([a.done, b.done]);
    const reports = results.map(result => direct(result, result.status));
    assert.deepEqual(reports.map(report => report.status).sort(), ["blocked", "completed"]);
    assert.equal(reports.find(report => report.status === "blocked").blockers[0].code, "thread_busy");
    assert.equal(race.requests().slice(offset).filter(request => request.method === "turn/start").length, 1);
  } finally {
    fs.writeFileSync(gate, "release");
    if (a.child.exitCode === null) a.child.kill("SIGTERM");
    if (b?.child.exitCode === null) b.child.kill("SIGTERM");
    await Promise.all([a.done, b?.done]);
  }

  // A fresh thread is published before its first turn is accepted. Its live
  // job must also exclude a cross-workspace follow-up without a turn handle.
  const fresh = fixture("review-ok", { mutable: true }), remote = path.join(fresh.dir, "remote");
  fs.mkdirSync(remote); initGitRepo(remote);
  const freshBinary = path.join(fresh.dir, "codex"), freshSource = fs.readFileSync(freshBinary, "utf8");
  const held = path.join(fresh.dir, "first-start"), release = path.join(fresh.dir, "release-start");
  const startCase = 'case "turn/start": {';
  assert.ok(freshSource.includes(startCase));
  fs.writeFileSync(freshBinary, freshSource.replace(startCase, `${startCase}
    if (!fs.existsSync(${JSON.stringify(held)})) {
      fs.writeFileSync(${JSON.stringify(held)}, 'held');
      await new Promise(resolve => {
        const timer = setInterval(() => {
          if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(timer); resolve(); }
        }, 20);
      });
    }
  `));
  const initial = json(fresh.call("task", "--fresh", "--detached", "--json", "fixture"));
  try {
    await waitUntil(() => fs.existsSync(held));
    const pending = job(fresh, initial.jobId);
    assert.ok(pending.threadId && !pending.turnId && alive(pending.pid));
    const refused = run(process.execPath, [script, "task", "--thread", pending.threadId, "--cwd", remote, "--sandbox", "read-only", "--direct", "--quiet", "fixture"],
      { cwd: remote, env: fresh.env });
    assert.equal(direct(refused, 2).blockers[0].code, "thread_busy");
    assert.equal(fresh.requests().filter(request => request.method === "turn/start").length, 1);
    fs.writeFileSync(release, "release");
    await waitUntil(() => storedJob(fresh, initial.jobId).status === "completed");
    // A terminal predecessor can still have a live wrapper during teardown.
    patchJob(fresh, initial.jobId, { pid: process.pid });
    const continued = direct(fresh.call("task", "--to", initial.jobId, "--direct", "--quiet", "fixture"));
    assert.equal(continued.status, "completed");
    const cross = direct(run(process.execPath, [script, "task", "--thread", pending.threadId, "--cwd", remote, "--sandbox", "read-only", "--direct", "--quiet", "fixture"],
      { cwd: remote, env: fresh.env }));
    assert.equal(cross.status, "completed");
  } finally {
    fs.writeFileSync(release, "release");
    await waitUntil(() => ["completed", "failed"].includes(job(fresh, initial.jobId).status));
  }
});

test("worker names survive exhaustion, concurrent reservations, follow-ups and legacy records", async t => {
  const first = pickAgentName([], () => 0);
  assert.notEqual(pickAgentName([first], () => 0), first);
  const exhausted = pickAgentName(AGENT_NAMES, () => 0);
  assert.ok(!AGENT_NAMES.includes(exhausted));
  assert.notEqual(pickAgentName([...AGENT_NAMES, exhausted], () => 0), exhausted);
  const f = fixture("task-ok"), now = Date.now();
  const other = path.join(f.dir, "other-workspace");
  fs.mkdirSync(other); initGitRepo(other);
  const stateModule = new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url).href;
  const markerModule = new URL("../plugins/codex/scripts/lib/session-markers.mjs", import.meta.url).href;
  const records = [
    { id: "active-old", status: "running", agentName: "Ada", age: 48 },
    { id: "recent", status: "completed", agentName: "Turing", age: 1 },
    { id: "expired", status: "completed", agentName: "Hopper", age: 25 },
    { id: "thread-old", status: "completed", agentName: "Curie", threadId: "known-thread", age: 30 },
    { id: "thread-new", status: "completed", agentName: "Noether", threadId: "known-thread", age: 26 },
    { id: "legacy", status: "completed", threadId: "legacy-thread", age: 20 },
    { id: "remote-old", status: "completed", agentName: "Euler", age: 72, workspaceRoot: other },
    { id: "foreign", status: "completed", agentName: "Kepler", age: 72, workspaceRoot: other, sessionId: "other-session" },
  ].map(({ age, ...record }) => ({ jobClass: "task", workspaceRoot: f.repo, sessionId: "fixture-session",
    ...record, createdAt: new Date(now - age * 3600000).toISOString() }));
  const seeded = run(process.execPath, ["--input-type=module", "-e", `
    import { writeJobFile, upsertJob, resolveJobFile } from ${JSON.stringify(stateModule)};
    import { writeSessionMarker } from ${JSON.stringify(markerModule)};
    const records = ${JSON.stringify(records)};
    for (const record of records) {
      writeJobFile(record.workspaceRoot, record.id, record); upsertJob(record.workspaceRoot, record); writeSessionMarker(record);
    }
    console.log(JSON.stringify(records.map(record => resolveJobFile(record.workspaceRoot, record.id))));
  `], { cwd: f.repo, env: f.env });
  const files = json(seeded), originals = files.map(file => fs.readFileSync(file, "utf8"));
  const legacyMarker = path.join(resolveSessionMarkersRoot(f.env), "fixture-session", "legacy.json");
  const markerText = fs.readFileSync(legacyMarker, "utf8");
  assert.equal(Object.hasOwn(JSON.parse(markerText), "name"), false);
  assert.equal(job(f, "legacy").agentName, undefined);
  const preload = path.join(f.dir, "fixed-name-choice.mjs");
  fs.writeFileSync(preload, 'const random = Math.random; Math.random = () => new Error().stack.includes("pickAgentName") ? 0 : random();');
  const fresh = direct(run(process.execPath, ["--import", preload, script, "task", "--fresh", "--direct", "fixture"], { cwd: f.repo, env: f.env }));
  assert.equal(fresh.worker, "Gauss", "session names stay reserved after 24 hours and across workspaces");
  const dispatch = cwd => new Promise((resolve, reject) => {
    const child = spawnOwned(process.execPath, ["--import", preload, script, "task", "--fresh", "--direct", "--cwd", cwd, "fixture"],
      { cwd: f.repo, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    child.on("error", reject);
    child.on("close", status => { try { resolve(direct({ status, stdout, stderr })); } catch (error) { reject(error); } });
  });
  const concurrent = await Promise.all([dispatch(f.repo), dispatch(other)]);
  assert.deepEqual(concurrent.map(result => result.worker).sort(), ["Faraday", "Kepler"], "atomic reservations span concurrent workspace dispatches; other sessions do not reserve names globally");
  const fake = f.state();
  fake.threads.push(...["known-thread", "legacy-thread"].map(id => ({ ...fake.threads[0], id, turns: [] })));
  fs.writeFileSync(path.join(f.dir, "fake-codex-state.json"), JSON.stringify(fake));
  const threaded = direct(f.call("task", "--thread", "known-thread", "--sandbox", "read-only", "--direct", "fixture"));
  assert.equal(threaded.worker, "Noether");
  const continued = direct(f.call("task", "--continue", "thread-old", "--sandbox", "read-only", "--direct", "fixture"));
  assert.equal(continued.worker, "Curie", "continue names the specified job, not the newest job on its thread");
  const legacy = direct(f.call("task", "--continue", "legacy", "--sandbox", "read-only", "--direct", "fixture"));
  assert.ok(AGENT_NAMES.includes(legacy.worker));
  assert.deepEqual(files.map(file => fs.readFileSync(file, "utf8")), originals);
  assert.equal(fs.readFileSync(legacyMarker, "utf8"), markerText);
  // Name reservations survive the normal 50-ended-job index cap as well.
  const pruned = json(run(process.execPath, ["--input-type=module", "-e", `
    import { updateJob, upsertJob, listSessionJobs } from ${JSON.stringify(stateModule)};
    updateJob(process.cwd(), "active-old", () => ({ status: "completed" }));
    for (const cwd of ${JSON.stringify([f.repo, other])}) {
      for (let i = 0; i < 55; i++) upsertJob(cwd, { id: "filler-" + i, status: "completed", sessionId: "fixture-session", workspaceRoot: cwd,
        createdAt: new Date(Date.now() + 1000 + i).toISOString() });
    }
    console.log(JSON.stringify(listSessionJobs(process.cwd(), "fixture-session").map(job => job.agentName).filter(Boolean)));
  `], { cwd: f.repo, env: f.env }));
  assert.deepEqual(new Set(pruned), new Set([...records.filter(record => record.sessionId === "fixture-session").map(record => record.agentName),
    fresh.worker, ...concurrent.map(result => result.worker), legacy.worker].filter(Boolean)));
  const retained = direct(run(process.execPath, ["--import", preload, script, "task", "--fresh", "--direct", "fixture"], { cwd: other, env: f.env }));
  assert.ok(![...records.filter(record => record.sessionId === "fixture-session").map(record => record.agentName),
    fresh.worker, ...concurrent.map(result => result.worker), legacy.worker].includes(retained.worker));
  // Native names reserve before spawn, sharing the atomic pool with Bash.
  const native = fixture("review-ok"), remote = path.join(native.dir, "remote");
  fs.mkdirSync(remote); initGitRepo(remote);
  const reserve = cwd => new Promise((resolve, reject) => {
    const child = spawnOwned(process.execPath, ["--import", preload, script, "reserve-name", "--session-cwd", cwd, "--preferred", "demo-1"],
      { cwd: native.repo, env: native.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
    child.on("error", reject);
    child.on("close", status => { try { resolve(json({ status, stdout, stderr }).name); } catch (error) { reject(error); } });
  });
  const names = await Promise.all([reserve(native.repo), reserve(remote)]);
  assert.equal(new Set(names.map(name => name.toLowerCase())).size, 2);
  assert.ok(names.includes("demo-1"));
  const collision = json(native.call("reserve-name", "--session-cwd", remote, "--preferred", "DEMO-1")).name;
  assert.notEqual(collision.toLowerCase(), "demo-1", "caller names share the case-insensitive session reservation namespace");
  const invalid = json(native.call("reserve-name", "--session-cwd", native.repo, "--preferred", "invalid caller label")).name;
  assert.ok(AGENT_NAMES.includes(invalid), "invalid caller labels fall back to the pool before spawn");
  const reservedPrefix = json(native.call("reserve-name", "--session-cwd", native.repo, "--preferred", "ReViEw-helper")).name;
  assert.ok(AGENT_NAMES.includes(reservedPrefix), "reserved job-id prefixes fall back to the pool before spawn");
  assert.equal(fs.existsSync(path.join(native.dir, "fake-codex-state.json.requests.jsonl")), false);
  const bash = direct(run(process.execPath, ["--import", preload, script, "task", "--fresh", "--direct", "fixture"],
    { cwd: remote, env: native.env }));
  assert.ok(!names.includes(bash.worker));
  // Claim/retry/rollback without publishing a job exercises the reservation
  // boundary itself, including competing claimants in another workspace.
  const namesModule = new URL("../plugins/codex/scripts/lib/agent-names.mjs", import.meta.url).href;
  // Exit between exclusive creation and the owner write, before any cleanup.
  // A retry must still consume the name that was reserved before native spawn.
  const interrupted = run(process.execPath, ["--input-type=module", "-e", `
    import fs from "node:fs";
    import { reserveAgentName } from ${JSON.stringify(namesModule)};
    const write = fs.writeFileSync;
    fs.writeFileSync = (file, value, options) => {
      if (value === "native-retry") { fs.openSync(file, options.flag, options.mode); process.exit(86); }
      return write(file, value, options);
    };
    reserveAgentName([], { cwd: process.cwd(), sessionId: "fixture-session", preferredName: ${JSON.stringify(names[0])}, claimOwner: "native-retry" });
  `], { cwd: native.repo, env: native.env });
  assert.equal(interrupted.status, 86, interrupted.stderr);
  const claims = json(run(process.execPath, ["--input-type=module", "-e", `
    import { reserveAgentName } from ${JSON.stringify(namesModule)};
    const options = { cwd: process.cwd(), sessionId: "fixture-session", preferredName: ${JSON.stringify(names[0])}, claimOwner: "native-retry" };
    let release, count = 0;
    const onReserved = (name, rollback) => { count++; release = rollback; };
    const first = reserveAgentName([], { ...options, onReserved });
    const retry = reserveAgentName([], { ...options, onReserved });
    const competitor = reserveAgentName([], { ...options, cwd: ${JSON.stringify(remote)}, claimOwner: "other-dispatch" });
    release();
    const reclaimed = reserveAgentName([], options);
    console.log(JSON.stringify({ first, retry, competitor, reclaimed, count }));
  `], { cwd: native.repo, env: native.env }));
  assert.equal(claims.first, names[0]); assert.equal(claims.retry, names[0]); assert.equal(claims.reclaimed, names[0]);
  assert.notEqual(claims.competitor, names[0]); assert.equal(claims.count, 1);
  const firstNative = direct(native.call("task", "--agent-name", names[0], "--dispatch-nonce", "native-retry", "--fresh", "--direct", "fixture"));
  assert.equal(firstNative.worker, names[0]);
  assert.equal(job(native, firstNative.jobId).agentName, names[0]);
  const followup = direct(native.call("task", "--to", names[0], "--direct", "fixture"));
  assert.equal(followup.worker, names[0]);
  const noSession = run(process.execPath, [script, "reserve-name", "--session-cwd", native.repo],
    { cwd: native.repo, env: { ...native.env, CODEX_COMPANION_SESSION_ID: "" } });
  assert.equal(noSession.status, 1);

});

test("internal native agent types select the declared role and reject other types before dispatch", () => {
  const f = fixture("review-ok");
  const invalid = f.call("task", "--agent-name", "typed-worker", "--agent-type", "Explore", "--direct", "fixture");
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /native agent type/i);
  assert.equal(fs.existsSync(path.join(f.dir, "fake-codex-state.json")), false);
  const first = direct(f.call("task", "--agent-name", "typed-worker", "--agent-type", "fugato:codex-reviewer", "--direct", "fixture"));
  assert.equal(job(f, first.jobId).request.agentType, "fugato:codex-reviewer");
  const second = direct(f.call("task", "--to", first.worker, "--agent-type", "fugato:codex-implementer", "--direct", "fixture"));
  assert.equal(job(f, second.jobId).request.agentType, "fugato:codex-reviewer", "continuations retain the original role context");
});

test("runtime-2: heartbeat and notification diagnostics cannot crash a tracked turn", () => {
  const f = fixture("slow-recovery-task");
  const gate = path.join(f.dir, "heartbeat-observed");
  f.env.CODEX_FIXTURE_TURN_GATE = gate;
  const result = run(process.execPath, ["--input-type=module", "-e", `
    import fs from 'node:fs';
    import { runTrackedJob, createProgressReporter, createJobProgressUpdater } from ${JSON.stringify(new URL("../plugins/codex/scripts/lib/tracked-jobs.mjs", import.meta.url).href)};
    import { runAppServerTurn, runAppServerReview } from ${JSON.stringify(new URL("../plugins/codex/scripts/lib/codex.mjs", import.meta.url).href)};
    import { resolveJobFile } from ${JSON.stringify(new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url).href)};
    setTimeout(() => process.exit(42), 15000).unref();
    const job = { id: 'progress-fault', jobClass: 'task', workspaceRoot: process.cwd(), logFile: ${JSON.stringify(path.join(f.dir, "progress.log"))} };
    const append = fs.appendFileSync, write = fs.writeSync, rename = fs.renameSync;
    let heartbeatFailures = 0, callbackFailures = 0, notificationFailures = 0, logFailures = 0, warnings = 0;
    let failedHandle = null, persistedHandle = null;
    const failure = Object.assign(new Error('injected optional diagnostic failure'), { code: 'EIO' });
    fs.appendFileSync = function(file, value, ...args) {
      if (file === job.logFile && String(value).includes('Progress: thread=')) { heartbeatFailures++; throw failure; }
      return append.call(this, file, value, ...args);
    };
    fs.writeSync = function(fd, ...args) { if (fd === 2) warnings++; return write.call(this, fd, ...args); };
    const jobFile = resolveJobFile(process.cwd(), job.id);
    fs.renameSync = function(source, target) {
      const record = target === jobFile ? JSON.parse(fs.readFileSync(source, 'utf8')) : null;
      if (!failedHandle && record?.threadId) { failedHandle = record.threadId; throw failure; }
      const result = rename.call(this, source, target);
      if (record?.status === 'running' && record.threadId === failedHandle) persistedHandle = record.threadId;
      return result;
    };
    const report = createProgressReporter({ logFile: job.logFile, onEvent: createJobProgressUpdater(process.cwd(), job.id) });
    const execution = await runTrackedJob(job, async () => {
      const payload = await runAppServerTurn(process.cwd(), { prompt: 'fixture', persistThread: true, onProgress: event => {
        report(event);
        if (typeof event === 'string' && event.startsWith('Progress: thread=')) {
          callbackFailures++; fs.writeFileSync(${JSON.stringify(gate)}, 'observed'); throw failure;
        }
        if (event?.activity?.length) { notificationFailures++; throw failure; }
      } });
      return { exitStatus: payload.status, payload, threadId: payload.threadId, turnId: payload.turnId, summary: 'done', rendered: 'done' };
    });
    const review = await runAppServerReview(process.cwd(), { target: { type: 'uncommittedChanges' }, onProgress: event => {
      if (event?.logBody) { logFailures++; throw failure; }
    } });
    console.log(JSON.stringify({ status: execution.exitStatus, turnEnded: execution.payload.turnEnded, reviewStatus: review.status, heartbeatFailures, callbackFailures, notificationFailures, logFailures, warnings, failedHandle, persistedHandle }));
  `], { cwd: f.repo, env: { ...f.env, CODEX_COMPANION_PROGRESS_INTERVAL_MS: "250", CODEX_COMPANION_APP_SERVER_ENDPOINT: `unix:${path.join(f.dir, "missing")}` } });
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.status, 0);
  assert.equal(observed.turnEnded, true);
  assert.equal(observed.reviewStatus, 0);
  for (const key of ["heartbeatFailures", "callbackFailures", "notificationFailures", "logFailures"]) assert.ok(observed[key] > 0, key);
  assert.equal(observed.warnings, 1);
  assert.ok(observed.failedHandle && observed.persistedHandle === observed.failedHandle);
  assert.equal(job(f, "progress-fault").status, "completed");
  assert.ok(f.state().launches.every(entry => !alive(entry.pid)));
});

test("runtime-3: final log failures preserve committed outcomes and required result writes still fail", () => {
  const f = fixture();
  const result = run(process.execPath, ["--input-type=module", "-e", `
    import fs from 'node:fs';
    import { runTrackedJob } from ${JSON.stringify(new URL("../plugins/codex/scripts/lib/tracked-jobs.mjs", import.meta.url).href)};
    const append = fs.appendFileSync, write = fs.writeFileSync;
    const failure = Object.assign(new Error('injected write failure'), { code: 'EIO' });
    const outcomes = [];
    for (const mode of ['task', 'required-result']) {
      const job = { id: 'final-' + mode, jobClass: mode === 'task' ? 'task' : 'review', workspaceRoot: process.cwd(),
        logFile: ${JSON.stringify(path.join(f.dir, "final.log"))},
        rawOutputFile: ${JSON.stringify(path.join(f.dir, "raw-"))} + mode,
        resultFile: ${JSON.stringify(path.join(f.dir, "result-"))} + mode };
      let failures = 0;
      fs.appendFileSync = function(file, ...args) {
        if (file === job.logFile) { failures++; throw failure; }
        return append.call(this, file, ...args);
      };
      fs.writeFileSync = function(file, ...args) {
        if (mode === 'required-result' && file === job.resultFile && failures === 0) { failures++; throw failure; }
        return write.call(this, file, ...args);
      };
      const execution = { exitStatus: 0, jobStatus: 'completed', payload: { status: 0, turnEnded: true, rawOutput: 'done' }, report: { status: 'completed' }, summary: 'done', rendered: 'done' };
      const outcome = await runTrackedJob(job, async () => execution).then(value => ({ returned: value === execution }), error => ({ rejected: error === failure }));
      outcomes.push({ mode, failures, ...outcome });
    }
    console.log(JSON.stringify(outcomes));
  `], { cwd: f.repo, env: f.env });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    { mode: "task", failures: 1, returned: true },
    { mode: "required-result", failures: 1, rejected: true }
  ]);
  for (const mode of ["task"]) {
    assert.equal(job(f, `final-${mode}`).status, "completed");
    assert.equal(json(f.call("result", `final-${mode}`, "--details")).status, "completed");
  }
  assert.equal(job(f, "final-required-result").status, "failed");
});

test("runtime stop always aborts despite progress or cancellation persistence failures", async t => {
  let tick;
  t.mock.method(globalThis, "setInterval", callback => { tick = callback; return null; });
  for (const fault of ["progress-state", "both", "reentrant"]) {
    const cwd = makeTempDir(), id = `stop-${fault}`;
    writeJobFile(cwd, id, { id, status: "running", ownerAttached: true, leaseExpiresAt: Date.now() + 180000 });
    const file = resolveJobFile(cwd, id), logFile = file.replace(/\.json$/, ".log");
    let progressCalls = 0, persistenceCalls = 0, abortEvents = 0, failedWrites = 0;
    const updater = createJobProgressUpdater(cwd, id);
    const runtime = new JobRuntime(cwd, id, { onProgress: createProgressReporter({ logFile, onEvent: event => {
      progressCalls++;
      if (fault === "progress-state") updater(event);
      if (fault === "reentrant") runtime.stop("owner_state_unavailable");
    } }) });
    runtime.abort.signal.addEventListener("abort", () => { abortEvents++; });
    const append = fs.appendFileSync, rename = fs.renameSync;
    const logWriter = t.mock.method(fs, "appendFileSync", function(target, ...args) {
      if (target === logFile && ["progress-log", "both"].includes(fault)) throw Object.assign(new Error("injected progress failure"), { code: "ENOSPC" });
      return append.call(this, target, ...args);
    });
    const jobWriter = t.mock.method(fs, "renameSync", function(source, target) {
      if (target === file) {
        persistenceCalls++;
        if (["requestCancel", "both"].includes(fault) || (fault === "progress-state" && persistenceCalls > 1)) {
          failedWrites++;
          throw Object.assign(new Error("injected persistence failure"), { code: "EIO" });
        }
      }
      return rename.call(this, source, target);
    });
    try {
      if (fault === "latched-reason") runtime.reason = "cancelled_by_user";
      assert.doesNotThrow(() => runtime.stop("cancelled_by_user"));
      runtime.stop("owner_state_unavailable");
      tick();
      assert.equal(runtime.abort.signal.aborted, true);
      assert.equal(runtime.abort.signal.reason, "cancelled_by_user");
      assert.equal(runtime.reason, "cancelled_by_user");
      assert.equal(abortEvents, 1);
      assert.equal(progressCalls, fault === "latched-reason" ? 0 : 1);
      assert.equal(failedWrites, ["progress-state", "requestCancel", "both"].includes(fault) ? 1 : 0);
    } finally { logWriter.mock.restore(); jobWriter.mock.restore(); runtime.close(); }
  }

  // stress-1: question resolution observes durable cancellation before the
  // next watchdog tick, and terminal publication rechecks intent under lock.
  const cwd = makeTempDir(), id = "cancel-question-commit";
  writeJobFile(cwd, id, { id, status: "running", jobClass: "task", workspaceRoot: cwd });
  const runtime = new JobRuntime(cwd, id);
  try {
    const asking = runtime.question({ params: { arguments: { question: "Choose?" }, callId: "cancel-call" } });
    updateJob(cwd, id, () => ({ cancelRequested: { reason: "cancelled_by_user" } }));
    await asking;
    assert.equal(runtime.reason, "cancelled_by_user");
    assert.equal(runtime.abort.signal.aborted, true);
  } finally { runtime.close(); }
  for (const [reason, outcome] of [[null, "completed"], ["cancelled_by_user", "failed"], ["owner_stopped", "completed"]]) {
    const id = `commit-${reason ?? "none"}-${outcome}`, resultFile = resolveJobFile(cwd, id).replace(/\.json$/, ".result.json");
    const tracked = { id, jobClass: "task", workspaceRoot: cwd, resultFile };
    const execution = await runTrackedJob(tracked, async () => {
      if (reason) updateJob(cwd, id, () => ({ cancelRequested: { reason } }));
      const status = outcome === "completed" ? 0 : 1;
      return { exitStatus: status, jobStatus: outcome, payload: { status, turnEnded: true }, report: { status: outcome }, rendered: "done" };
    });
    const expected = reason === "cancelled_by_user" ? "cancelled" : reason ? "interrupted" : outcome;
    const saved = readJobFile(resolveJobFile(cwd, id));
    assert.equal(saved.status, expected); assert.equal(execution.report.status, expected);
    const cancelled = json(run(process.execPath, [script, "cancel", id, "--cwd", cwd, "--json"]));
    assert.equal(cancelled.status, expected);
    assert.equal(cancelled.turnInterruptAttempted, false); assert.equal(cancelled.turnInterrupted, false);
    if (reason) {
      assert.equal(execution.exitStatus, 1); assert.equal(saved.result.interruptionReason, reason);
      assert.deepEqual(JSON.parse(fs.readFileSync(resultFile)), saved.result);
    } else assert.equal(saved.cancelRequested, undefined);
  }
  const late = fixture("review-ok");
  const committed = json(run(process.execPath, ["--input-type=module", "-e", `
    import { runTrackedJob } from ${JSON.stringify(new URL("../plugins/codex/scripts/lib/tracked-jobs.mjs", import.meta.url).href)};
    import { runAppServerTurn } from ${JSON.stringify(new URL("../plugins/codex/scripts/lib/codex.mjs", import.meta.url).href)};
    import { requestCancel } from ${JSON.stringify(new URL("../plugins/codex/scripts/lib/job-runtime.mjs", import.meta.url).href)};
    const cwd = process.cwd(), executions = [];
    // late-own-stop: the run's own final read already labelled the late stop.
    for (const id of ['late-own-stop']) executions.push(await runTrackedJob({ id, jobClass: 'task', workspaceRoot: cwd }, async () => {
      const result = await runAppServerTurn(cwd, { prompt: 'fixture', persistThread: true });
      requestCancel(cwd, id);
      const own = id === 'late-own-stop' ? { interruptionReason: 'cancelled_by_user', interruptionConfirmed: result.turnEnded } : {};
      return { exitStatus: own.interruptionReason ? 1 : result.status, jobStatus: own.interruptionReason ? 'cancelled' : 'completed',
        threadId: result.threadId, turnId: result.turnId, payload: { status: result.status, turnEnded: result.turnEnded, ...own }, report: { status: 'completed' } };
    }));
    console.log(JSON.stringify(executions));
  `], { cwd: late.repo, env: late.env }));
  assert.deepEqual(committed.map(execution => execution.jobStatus), ["cancelled"]);
  for (const id of ["late-own-stop"]) {
    const lateCancel = json(late.call("cancel", id, "--json"));
    assert.equal(lateCancel.status, "cancelled"); assert.equal(lateCancel.backgroundTerminals.cleaned, true);
    assert.equal(lateCancel.turnInterruptAttempted, false); assert.equal(lateCancel.turnInterrupted, false);
  }
  assert.equal(late.requests().filter(request => request.method === "turn/interrupt").length, 0);
  assert.equal(late.requests().filter(request => request.method === "thread/backgroundTerminals/clean").length, 1);
});
