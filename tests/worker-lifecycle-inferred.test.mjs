import test from 'node:test';
import assert from 'node:assert/strict';
import { lifecycleHarness } from './fake-codex-fixture.mjs';
import { buildWorkerReport } from '../plugins/codex/scripts/lib/worker-report.mjs';
import { directReport } from '../plugins/codex/scripts/lib/job-runtime.mjs';
import { sendBrokerShutdown } from '../plugins/codex/scripts/lib/broker-lifecycle.mjs';
const {
  fs, path, makeTempDir, resolveStateDir, delay, run, browserOriginSetup, transportSetup, redactActivity, itemActivity, activityReader, formatActivity, writeJobFile, upsertJob, readJobFile, resolveJobFile, resolveSessionMarkersRoot, script, alive, fixture, json, direct, directError, waitUntil, patchJob
} = await lifecycleHarness();

const storedJob = (f, id) => readJobFile(path.join(resolveStateDir(f.repo, f.env), "jobs", `${id}.json`));

// Replay only quiescent fixtures captured in this run. Copy all durable state:
// job/index/artifacts, session markers, journal, fake server and broker metadata.
async function snapshotFixture(f) {
  const brokerFile = path.join(resolveStateDir(f.repo, f.env), "broker.json");
  const broker = fs.existsSync(brokerFile) ? readJobFile(brokerFile) : null;
  if (broker?.pid && alive(broker.pid)) {
    if (broker.endpoint) await sendBrokerShutdown(broker.endpoint).catch(() => {});
    await waitUntil(() => !alive(broker.pid));
  }
  const roots = [f.dir, ...(broker?.sessionDir ? [broker.sessionDir] : [])];
  const saved = makeTempDir("lifecycle-snapshot-");
  roots.forEach((root, i) => { if (fs.existsSync(root)) fs.cpSync(root, path.join(saved, String(i)), { recursive: true }); });
  return () => roots.forEach((root, i) => {
    fs.rmSync(root, { recursive: true, force: true });
    if (fs.existsSync(path.join(saved, String(i)))) fs.cpSync(path.join(saved, String(i)), root, { recursive: true });
  });
}

async function until(check, timeout = 15000) {
  for (const end = Date.now() + timeout; Date.now() < end;) {
    const result = check();
    if (result) return result;
    await delay(50);
  }
  throw new Error("Backpressure fixture deadline expired");
}

test("transport setup is opt-in, merges the hand-written provider, backs up once and is idempotent", () => {
  const f = fixture(), home = f.env.CODEX_COMPANION_HOME; fs.mkdirSync(home);
  const file = path.join(home, "config.toml"), before = 'model_provider = "openai-http"\n# retained\n[model_providers.openai-http]\nname = "OpenAI HTTP"\nbase_url = "https://chatgpt.com/backend-api/codex"\nwire_api = "responses"\nrequires_openai_auth = true\nsupports_websockets = false\n'; fs.writeFileSync(file, before);
  assert.deepEqual(transportSetup({ mode: "http", env: f.env }).changedFiles, []);
  assert.equal(transportSetup({ env: f.env }).transport, "http"); assert.equal(fs.readFileSync(file, "utf8"), before);
  const changed = transportSetup({ mode: "websocket", env: f.env }); assert.equal(changed.backups.length, 1); assert.equal(fs.readFileSync(changed.backups[0], "utf8"), before);
  assert.match(fs.readFileSync(file, "utf8"), /# retained/); assert.deepEqual(transportSetup({ mode: "websocket", env: f.env }).changedFiles, []);
  assert.equal(json(f.call("setup", "--transport", "status", "--json")).transport.transport, "websocket");
  assert.throws(() => transportSetup({ mode: "auto", env: f.env }), /must be/);
});

test("browser origin allow/revoke merges global settings and removes exact stale denies only", () => {
  const f = fixture(), browser = path.join(f.env.CODEX_COMPANION_HOME, "browser"), sessions = path.join(browser, "sessions"); fs.mkdirSync(sessions, { recursive: true });
  const global = path.join(browser, "config.toml"), session = path.join(sessions, "fixture-thread.toml");
  const before = '# retained\n[origins]\nallowed = ["https://other.example"] # preserved comment\ndenied = ["https://EXAMPLE.COM:443"]\n[other]\nkeep = "value"\n';
  fs.writeFileSync(global, before); fs.writeFileSync(session, '[origins]\nallowed = []\ndenied = ["https://example.com", "https://child.example.com"]\n[other]\nkeep = true\n');
  assert.equal(browserOriginSetup({ allow: ["HTTPS://EXAMPLE.COM:443"], env: f.env, dryRun: true }).changedFiles.length, 2); assert.equal(fs.readFileSync(global, "utf8"), before);
  const result = browserOriginSetup({ allow: ["https://example.com"], env: f.env }); assert.equal(result.changedFiles.length, 2); assert.equal(result.backups.length, 2);
  assert.match(fs.readFileSync(global, "utf8"), /# preserved comment/); assert.match(fs.readFileSync(session, "utf8"), /child.example.com/); assert.match(fs.readFileSync(session, "utf8"), /keep = true/);
  assert.deepEqual(browserOriginSetup({ allow: ["https://example.com"], env: f.env }).changedFiles, []);
  const revoked = browserOriginSetup({ revoke: ["https://example.com"], env: f.env }); assert.ok(revoked.denied.includes("https://example.com")); assert.ok(!revoked.allowed.includes("https://example.com"));
  assert.ok(json(f.call("setup", "--list-browser-origins", "--json")).browserOrigins.denied.includes("https://example.com"));
  assert.throws(() => browserOriginSetup({ allow: ["https://example.com/path"], env: f.env }), /requires an HTTP/);
});

test("activity preserves evidence, excludes tool payloads and reports file and command outcomes", () => {
  const starts = new Map();
  assert.equal(redactActivity("ANSWER=Yes\x1b[31m\u202e"), "ANSWER=Yes ");
  const tool = itemActivity({ type: "mcpToolCall", tool: "inspect", arguments: "PRIVATE_ARGS", result: "PRIVATE_RESULT" }, "completed", starts, "tool");
  assert.doesNotMatch(JSON.stringify(tool), /PRIVATE/);
  const message = itemActivity({ type: "agentMessage", text: JSON.stringify({ status: "completed", summary: "Completed fixture work.", key_findings: ["PRIVATE_FIELD"] }) }, "completed", starts, "message")[0];
  assert.equal(message.body, "Completed fixture work.");
  assert.doesNotMatch(JSON.stringify(message), /PRIVATE_FIELD/);
  const changes = itemActivity({ type: "fileChange", status: "completed", changes: [
    { path: "new", kind: { type: "add" }, diff: "+++content\n---content\nplain\n" },
    { path: "legacy", kind: "update", diff: "@@ -1 +1 @@\n-PRIVATE_OLD\n+PRIVATE_NEW\n" },
    { path: "unknown", kind: { type: "update" }, diff: "opaque payload" }
  ] }, "completed", starts, "files");
  assert.deepEqual(changes.map(({ added, removed }) => [added, removed]), [[3, undefined], [1, 1], [undefined, undefined]]);
  assert.doesNotMatch(JSON.stringify(changes), /PRIVATE|diff|content/);
  assert.match(formatActivity({ ...changes[0], seq: 1 }), /\+3/);
  assert.doesNotMatch(formatActivity({ ...changes[0], status: "failed", seq: 1 }), /\+3/);
  for (const [status, exitCode] of [["failed", 0], ["failed", 9], ["completed", null]]) {
    assert.doesNotMatch(formatActivity({ seq: 1, type: "commandExecution", command: "node --test", status, exitCode }), /Done/);
  }
  const command = "env -u A X='" + "prefix ".repeat(24) + "' node --test x";
  const original = { type: "commandExecution", command, status: "completed", exitCode: 0 };
  assert.equal(itemActivity(original, "completed", starts, "command")[0].command, "node --test x");
  const evidence = directReport(buildWorkerReport({ status: 0, commandExecutions: [original] }), {
    result: { commandExecutions: [original] }
  });
  assert.ok(evidence.checks.ran[0].startsWith(command));
  for (const command of ["BASH_ENV=./hook /bin/bash -c 'cat input'", "X=$(touch output) cat input"]) {
    assert.ok(formatActivity({ seq: 1, type: "commandExecution", command, exitCode: 0 }).includes(command));
  }
  const multiline = itemActivity({ type: "commandExecution", command: "cat input\ntouch output" }, "completed", starts, "multiline")[0];
  assert.ok(multiline.command.endsWith("…"));
});

test("activity truncation preserves whole graphemes in capture and formatted progress", () => {
  for (const grapheme of ["👩‍💻", "e\u0301"]) {
    const prefix = "node " + "x".repeat(153), command = prefix + grapheme + "/tail.mjs";
    const event = itemActivity({ type: "commandExecution", command, status: "completed", exitCode: 0 }, "completed", new Map(), "unicode")[0];
    assert.equal(event.command, prefix + "…");
    assert.equal(formatActivity({ ...event, seq: 1 }).isWellFormed(), true);
    const message = itemActivity({ type: "agentMessage", text: "x".repeat(599) + grapheme + "/tail" }, "completed", new Map(), "message")[0];
    assert.equal(message.text, "x".repeat(599));
  }
});

test("wait persists independent owner and observer activity cursors", () => {
  const cwd = makeTempDir(), id = "cursor-job";
  const activity = [{ type: "commandExecution", command: "node --test", exitCode: 0, seq: 1 }];
  const record = { id, workspaceRoot: cwd, jobClass: "task", status: "completed", activity, activitySeq: 1, result: { status: 0, rawOutput: "fixture-output" } };
  writeJobFile(cwd, id, record); upsertJob(cwd, record);
  const read = (...extra) => json(run(process.execPath, [script, "wait", id, "--json", ...extra], { cwd }));
  assert.equal(read("--owner", "reader-a").activityCount, 1);
  assert.equal(read("--owner", "reader-a").activityCount, 0);
  assert.equal(read("--owner", "reader-b").activityCount, 1);
  assert.equal(read().activityCount, 1);
  const stored = readJobFile(resolveJobFile(cwd, id));
  for (const owner of ["reader-a", "reader-b", undefined]) assert.equal(stored.activityCursors[activityReader(owner)], 1);
});

test("inferred final answers confirm the exact turn or remain recoverable by name and job ID", async t => {
  const { unresolvedTask } = await import('../plugins/codex/scripts/lib/state.mjs');
  const stored = (shared, id) => readJobFile(path.join(resolveStateDir(shared.repo, shared.env), "jobs", `${id}.json`));
  const changeServer = (shared, patch) => fs.writeFileSync(path.join(shared.dir, "fake-codex-state.json"), JSON.stringify({ ...shared.state(), ...patch }));
  // One real inferred turn supplies both unresolved history and broker-cleanup
  // variants. Every replay starts from its complete, quiescent durable snapshot.
  const shared = fixture("inferred-final:running", { mutable: true });
  // This test owns lazy-recovery timing and replays durable snapshots. Keep
  // automatic helpers asleep until the suite's process-ledger teardown.
  shared.env.CODEX_COMPANION_INFERRED_RECHECK_MS = "3600000";
  const binary = path.join(shared.dir, "codex"), source = fs.readFileSync(binary, "utf8");
  const interruptCase = 'case "turn/interrupt": {';
  assert.ok(source.includes(interruptCase));
  fs.writeFileSync(binary, source.replace(interruptCase, `${interruptCase}
    if (state.rejectInterrupt) throw new Error("Fixture interrupt refused");
  `));
  assert.equal(run(process.execPath, [path.join(shared.dir, "codex"), "app-server"], { cwd: shared.repo, env: shared.env, input: "" }).status, 0);
  changeServer(shared, { allowInterrupt: true });
  const launch = json(shared.call("task", "--fresh", "--detached", "--json", "fixture"));
  const original = await waitUntil(() => {
    const current = stored(shared, launch.jobId);
    return current.status === "completed" && !current.pid && current;
  });
  assert.equal(original.result.inferredCompletion, true);
  assert.equal(original.result.turnEnded, false);
  assert.equal(original.result.turnStatus, "inProgress");
  assert.equal(unresolvedTask(original), true);
  await waitUntil(() => shared.state().threads.find(thread => thread.id === original.threadId).turns.find(turn => turn.id === original.turnId).status === "interrupted");
  const cleanup = shared.requests().filter(request => request.method === "turn/interrupt");
  assert.equal(cleanup.length, 1);
  assert.deepEqual(cleanup[0].params, { threadId: original.threadId, turnId: original.turnId });
  assert.equal(cleanup[0].serverId, shared.requests().find(request => request.method === "turn/start").serverId);
  await waitUntil(() => !alive(cleanup[0].serverId));
  const restore = await snapshotFixture(shared);
  const restoreRunning = () => {
    restore();
    const server = shared.state();
    Object.assign(server.threads.find(thread => thread.id === original.threadId).turns.find(turn => turn.id === original.turnId),
      { status: "inProgress", completedAt: null });
    changeServer(shared, { ...server, allowInterrupt: false });
  };
  for (const scenario of ["delayed-cancel", "historical-signal"]) await t.test(scenario, async t => {
    restoreRunning();
    if (scenario === "delayed-cancel") {
      // The replacement-broker silent deadline is retained in checkCleanup's
      // unconfirmed variant. Here a real RPC refusal gives the same durable
      // stop intent before the later exact-turn confirmation.
      changeServer(shared, { rejectInterrupt: true });
      const artifactBefore = fs.readFileSync(original.resultFile, "utf8");
      const cancel = json(shared.call("cancel", launch.jobId, "--json"), 2);
      assert.equal(cancel.status, "interrupt_unconfirmed");
      assert.equal(cancel.confirmation, "unconfirmed");
      assert.equal(cancel.turnInterruptAttempted, true); assert.equal(cancel.turnInterrupted, false);
      assert.equal(cancel.reason, "cancelled_by_user");
      const pending = stored(shared, launch.jobId);
      assert.equal(pending.ownerId, original.ownerId);
      assert.equal(pending.threadId, original.threadId); assert.equal(pending.turnId, original.turnId);
      assert.equal(pending.cancelRequested.reason, "cancelled_by_user");
      assert.deepEqual(pending.result, original.result);
      assert.equal(fs.readFileSync(pending.resultFile, "utf8"), artifactBefore);
      assert.equal(fs.readFileSync(pending.rawOutputFile, "utf8"), original.result.rawOutput);
    } else {
      patchJob(shared, launch.jobId, { ownerAttachedAt: Date.now(), ownerDetachedAt: Date.now(), ownerDetachReason: "signal" });
    }
    // The server confirms the previously requested interruption only afterward.
    const server = shared.state();
    Object.assign(server.threads.find(thread => thread.id === original.threadId).turns.find(turn => turn.id === original.turnId),
      { status: "interrupted", completedAt: Math.floor(Date.now() / 1000) });
    changeServer(shared, server);
    const output = shared.call("result", launch.jobId, "--details"), resolved = stored(shared, launch.jobId);
    t.diagnostic(JSON.stringify({ scenario, status: resolved.status, exitCode: output.status, ownerDetachReason: resolved.ownerDetachReason ?? null,
      cancelRequested: resolved.cancelRequested?.reason ?? null, interruptionReason: resolved.result.interruptionReason }));
    const expected = scenario === "delayed-cancel" ? "cancelled" : "interrupted";
    const report = json(output, expected === "completed" ? 0 : 1);
    assert.equal(report.status, expected);
    assert.equal(resolved.result.workerStatus, expected);
    assert.equal(resolved.result.turnStatus, "interrupted");
    assert.equal(resolved.result.rawOutput, original.result.rawOutput);
    assert.deepEqual(resolved.result.structured, original.result.structured);
    assert.equal(unresolvedTask(resolved), false);
    // An owner detach is stop evidence by itself; it must not write cancelRequested,
    // which would interrupt a job whose ownership merely moved.
    if (scenario === "delayed-cancel") assert.equal(resolved.cancelRequested.reason, "cancelled_by_user");
    assert.equal(resolved.result.interruptionReason, expected === "completed" ? null : expected === "cancelled" ? "cancelled_by_user" : "owner_stopped");
    assert.equal(shared.requests().filter(request => request.method === "turn/start").length, 1);
  });
  for (const [mode, selectors] of [["running", ["name", "observed"]], ["hang", ["command"]], ["failed", [null]]]) {
    const replay = mode === "running";
    if (replay) restoreRunning();
    const current = replay ? shared : fixture(`inferred-final:${mode}`);
    current.env.CODEX_COMPANION_INFERRED_RECHECK_MS = "3600000";
    const first = direct(replay
      ? current.call("wait", launch.jobId, "--direct", "--quiet")
      : current.call("task", "--fresh", "--direct", "--quiet", "fixture"), mode === "failed" ? 1 : 0);
    const f = current, original = stored(f, first.jobId);
    const ended = ["completed", "failed"].includes(mode);
    assert.equal(first.status, mode === "failed" ? "failed" : "completed");
    assert.equal(original.result.inferredCompletion, true);
    assert.equal(original.result.turnEnded, ended);
    assert.equal(original.result.turnStatus, ended ? mode : mode === "running" ? "inProgress" : null);
    assert.equal(unresolvedTask(original), !ended);
    const confirmation = f.requests().find(request => request.method === "thread/read");
    assert.deepEqual(confirmation.params, { threadId: original.threadId, includeTurns: true });
    assert.equal(confirmation.serverId, f.requests().find(request => request.method === "turn/start").serverId);

    // An unconfirmed stream retires its broker on disconnect. The replacement
    // must resolve the durable exact turn, even with no final items in history.
    if (!ended) await waitUntil(() => !alive(f.requests()[0].serverId));
    const reset = selectors.length > 1 ? await snapshotFixture(f) : null;
    for (const selector of selectors) {
      reset?.();
      if (!ended) {
        // A timed-out probe stays recoverable once the server answers again.
        if (mode === "hang") changeServer(f, { confirmationMode: "running" });
        const blocked = direct(f.call("task", "--continue", first.jobId, "--direct", "--quiet", "follow up"), 2);
        const blocker = blocked.blockers[0];
        assert.equal(blocker.code, "thread_busy"); assert.equal(blocker.predecessorJobId, first.jobId);
        assert.ok(blocker.cancelCommand);
        const status = json(f.call("status", first.jobId, "--json"));
        assert.equal(status.job.status, "completed");
        assert.equal(status.job.turnResolution, "in_progress");
        assert.ok(status.recovery.cancelCommand);
        assert.equal(stored(f, first.jobId).result.rawOutput, original.result.rawOutput);
        // Missing inference markers and normal ended records retain their old
        // eligibility; this fix does not reinterpret historical completions.
        assert.equal(unresolvedTask({ ...original, result: { ...original.result, inferredCompletion: undefined } }), false);
        assert.equal(unresolvedTask({ ...original, result: { ...original.result, turnEnded: true } }), false);
        const offset = f.requests().length;
        if (selector === "observed") {
          const server = f.state();
          Object.assign(server.threads.find(thread => thread.id === original.threadId).turns.find(turn => turn.id === original.turnId),
            { status: "completed", completedAt: Math.floor(Date.now() / 1000) });
          changeServer(f, server);
          assert.equal(json(f.call("status", first.jobId, "--json")).job.turnResolution, "completed");
        } else {
          changeServer(f, { allowInterrupt: true });
          const cancelled = json(selector === "command"
            ? run("/bin/sh", ["-c", blocker.cancelCommand], { cwd: f.repo, env: f.env })
            : f.call("cancel", selector === "name" ? original.agentName : first.jobId, "--json"));
          assert.equal(cancelled.confirmation, "confirmed"); assert.equal(cancelled.turnInterrupted, true);
        }
        const interrupts = f.requests().slice(offset).filter(request => request.method === "turn/interrupt");
        assert.equal(interrupts.length, selector === "observed" ? 0 : 1);
        if (interrupts.length) assert.deepEqual(interrupts[0].params, { threadId: original.threadId, turnId: original.turnId });
        const resolved = stored(f, first.jobId);
        assert.equal(resolved.status, selector === "observed" ? "completed" : "cancelled"); assert.equal(resolved.result.turnEnded, true);
        assert.equal(resolved.result.rawOutput, original.result.rawOutput);
        assert.deepEqual(resolved.result.structured, original.result.structured);
        assert.equal(fs.readFileSync(resolved.rawOutputFile, "utf8"), original.result.rawOutput);
        assert.deepEqual(readJobFile(resolved.resultFile), resolved.result);
        assert.equal(resolved.report.summary, original.report.summary);
        assert.equal(unresolvedTask(resolved), false);
      }
      t.diagnostic(JSON.stringify({ mode, selector, turnEnded: original.result.turnEnded }));
    }
    const followup = direct(f.call("task", "--continue", first.jobId, "--direct", "--quiet", "follow up"));
    assert.equal(followup.status, "completed");
    assert.equal(f.requests().filter(request => request.method === "turn/start").length, 2);
  }
  const subagent = fixture("with-subagent-no-main-turn-completed");
  const first = direct(subagent.call("task", "--fresh", "--direct", "--quiet", "fixture"));
  assert.equal(first.status, "completed");
  assert.equal(stored(subagent, first.jobId).result.inferredCompletion, true);
  assert.equal(subagent.requests().filter(request => request.method === "thread/read").length, 1);
});

test("direct mode validates incompatible options before creating state", () => {
  const f = fixture();
  assert.equal(f.call("task", "--quiet", "fixture").status, 1);
  for (const args of [["--direct", "--json"], ["--direct", "--timeout-sec", "3601"],
    ["--direct", "--lease-sec", "bad"], ["--direct", "--prompt-file", path.join(f.repo, "missing")]]) {
    directError(f.call("task", ...args, "fixture"));
  }
  directError(f.call("wait", "missing-job", "--direct", "--json"));
  assert.equal(fs.existsSync(path.join(f.env.CODEX_COMPANION_HOME, "duet", "state")), false);
  assert.equal(fs.existsSync(resolveSessionMarkersRoot(f.env)), false);
});
