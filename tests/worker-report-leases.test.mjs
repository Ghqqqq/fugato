import test from "node:test";
import assert from "node:assert/strict";
import { readyBroker } from "./helpers.mjs";
import { workerReportHarness } from "./fake-codex-fixture.mjs";
import { parseStructuredReport } from "../plugins/codex/scripts/lib/worker-report.mjs";
import { isC2Report } from "../plugins/codex/scripts/lib/report-delivery.mjs";

const {
  lifecycle, stateModule, storedFixtureJob, switchingFixture, directJson
} = await workerReportHarness();

const {
  fs, path, makeTempDir, run, redactActivity, writeJobFile, upsertJob, directReport, buildWorkerReport, AGENT_NAMES, splitRawArgumentString, spawnOwned, script, fixture, json, directLines, direct, job
} = lifecycle;

test("report v2 is decision-first and bounded; result and wait details retain the full report", async () => {
  const usage = { inputTokens: 150, cachedInputTokens: 40, outputTokens: 30, reasoningOutputTokens: 10, totalTokens: 180 };
  const f = fixture("review-ok");
  const first = direct(f.call("task", "--direct", "fixture"));
  assert.deepEqual(first.usage, usage, "usage sums both requests, including the update before turn/start responds");
  const threadId = storedFixtureJob(f, first.jobId).threadId;
  const follow = direct(f.call("task", "--thread", threadId, "--direct", "fixture"));
  assert.deepEqual(follow.usage, usage, "follow-ups report the whole turn's delta from cumulative thread totals");
  assert.deepEqual(json(f.call("result", follow.worker, "--details")).usage, usage);
  assert.deepEqual(storedFixtureJob(f, follow.jobId).result.usage, usage);
  assert.equal(Object.hasOwn(directReport({ status: "completed", summary: "Completed." }), "usage"), false);

  const patchRuntime = (f, marker, replacement) => {
    const binary = path.join(f.dir, "codex"), source = fs.readFileSync(binary, "utf8");
    assert.ok(source.includes(marker)); fs.writeFileSync(binary, source.replace(marker, replacement));
  };
  const requests = f => fs.readFileSync(path.join(f.dir, "fake-codex-state.json.requests.jsonl"), "utf8")
    .trim().split("\n").map(line => JSON.parse(line));
  // Lose turn/start's reply, both with and without an actually started turn.
  // Admission attributes visible turns; an invisible submission stays unresolved.
  for (const active of [true, false]) {
    const lost = fixture("lost-turn:inProgress", { mutable: true });
    const marker = "const turnId = nextTurnId(state);\n        thread.updatedAt = now();";
    patchRuntime(lost, marker, `${marker}
      if (turnId === "turn_1") {
        thread.turns = ${active ? "[buildTurn(turnId)]" : "[]"};
        saveState(state); process.exit(0);
      }
    `);
    const failed = lost.call("task", "--fresh", "--report", "--sandbox", "read-only", "--json", "fixture");
    assert.equal(failed.status, 1);
    const id = /Job handle: ([^;]+)/.exec(failed.stderr)?.[1]; assert.ok(id);
    const original = storedFixtureJob(lost, id);
    assert.ok(original.threadId && !original.turnId);
    assert.equal(original.result.failureSource, "transport");
    const offset = requests(lost).length;
    const next = direct(lost.call("task", "--thread", original.threadId, "--direct", "fixture"), 2);
    const admission = requests(lost).slice(offset);
    assert.ok(admission.some(r => r.method === "thread/read" && r.params.includeTurns));
    const recovered = storedFixtureJob(lost, id);
    assert.equal(next.status, "blocked"); assert.equal(next.blockers[0].code, "thread_busy");
    assert.equal(admission.some(r => r.method === "turn/start"), false);
    if (active) {
      assert.equal(recovered.recovery.source, "thread/read");
      assert.ok(next.blockers[0].cancelCommand);
      assert.equal(recovered.turnId, "turn_1");
      const cancelled = json(run("/bin/sh", ["-c", next.blockers[0].cancelCommand], { cwd: lost.repo, env: lost.env }));
      assert.equal(cancelled.confirmation, "confirmed");
      assert.equal(direct(lost.call("task", "--thread", original.threadId, "--direct", "fixture")).status, "completed");
    } else {
      assert.equal(recovered.recovered ?? false, false); assert.equal(recovered.status, "failed");
      assert.equal(recovered.turnResolution, "unknown");
      assert.equal(recovered.recovery.status, "unknown");
      assert.equal(requests(lost).filter(r => r.method === "turn/start").length, 1);
    }
  }

  // A private retry starts a fresh approval lifetime after a busy shared broker.
  const retry = fixture("computer-use-requests", { mutable: true });
  patchRuntime(retry, 'case "turn/start": {', `case "turn/start": {
    if (!state.busyRejected) {
      state.busyRejected = true; saveState(state);
      send({ id: message.id, error: { code: -32001, message: "Shared Codex broker is busy." } }); break;
    }
  `);
  const broker = await readyBroker(retry.repo, retry.env);
  let pending;
  try {
    pending = direct(retry.call("task", "--fresh", "--direct", "fixture"));
    assert.equal(pending.status, "needs_answer"); assert.equal(pending.question.kind, "approval");
    assert.equal(retry.state().appServerStarts, 2);
    const saved = storedFixtureJob(retry, pending.jobId);
    json(run(process.execPath, [script, "answer", saved.id, "--owner", saved.ownerId, "--question", pending.question.id, "--json"],
      { cwd: retry.repo, env: retry.env, input: "task" }));
    assert.equal(direct(retry.call("wait", saved.id, "--owner", saved.ownerId, "--direct", "--quiet")).status, "completed");
    assert.equal(fs.existsSync(path.join(retry.env.CODEX_COMPANION_HOME, "computer-use", "sessions", `${saved.threadId}.toml`)), false);
  } finally {
    if (pending) retry.call("cancel", pending.jobId, "--json");
    broker.close();
  }
});

test("v2 budgets UTF-8 text and counts omitted files/checks while details keeps expanded lists", () => {
  // cli-4: full blocker objects survive details while compact reports retain their budget.
  const blocked = fixture("structured-blocked");
  const launched = directJson(blocked.call("task", "--direct", "--quiet", "fixture"));
  const saved = storedFixtureJob(blocked, launched.jobId);
  const blockers = Array.from({ length: 7 }, (_, i) => ({ code: `fixture_${i}`, message: "x".repeat(280) + `\x1b[31mTAIL_${i}\x1b[0m`,
    app: null, tabId: `tab-${i}`, sessionId: `session-${i}` }));
  const structuredBlockers = parseStructuredReport(JSON.stringify({ status: "blocked", summary: "Stopped: fixture dependencies unavailable.",
    key_findings: [], assumptions: [], verification: [], question: null,
    blockers: blockers.map(({ tabId, sessionId, ...blocker }) => ({ ...blocker, tab_id: tabId, session_id: sessionId })) }));
  const resultWithBlockers = { ...saved.result, structured: structuredBlockers };
  storedFixtureJob(blocked, launched.jobId, { result: resultWithBlockers,
    report: buildWorkerReport(resultWithBlockers, { jobId: launched.jobId }) });
  for (const command of ["result", "wait"]) {
    const full = json(blocked.call(command, launched.jobId, "--details"), 2);
    assert.deepEqual(full.blockers, blockers.map(blocker => ({ ...blocker, message: redactActivity(blocker.message) })));
    assert.equal(full.blockersOmitted, 0);
  }
  const compactBlockers = directJson(blocked.call("result", launched.jobId));
  assert.ok(compactBlockers.blockers.length <= 3);
  assert.equal(isC2Report(compactBlockers), true);
  assert.ok(compactBlockers.blockers.every(blocker => blocker.message.length <= 240));
  const legacyBlockers = json(blocked.call("wait", launched.jobId, "--json"), 2);
  assert.equal(legacyBlockers.blockers.length + legacyBlockers.blockersOmitted, blockers.length);
  storedFixtureJob(blocked, launched.jobId, { result: { ...resultWithBlockers,
    blockers: [{ ...blockers[0], message: "Short runtime refusal." }] } });
  assert.deepEqual(json(blocked.call("result", launched.jobId, "--details"), 2).blockers,
    blockers.map(blocker => ({ ...blocker, message: redactActivity(blocker.message) })));
  const cwd = makeTempDir(), id = "long-structured-report", createdAt = new Date().toISOString();
  const entries = ["\x1b[31mLong finding\x1b[0m\n" + "detail ".repeat(80).trimEnd(), "字".repeat(2100), ...Array.from({ length: 28 }, (_, i) => `Entry ${i}\nwith details`)];
  const structured = parseStructuredReport(JSON.stringify({ status: "completed", summary: "Completed the work. " + "字".repeat(9000), key_findings: entries, assumptions: entries, verification: entries, blockers: [], question: null }));
  const result = { status: 0, structured, rawOutput: structured.summary, touchedFiles: entries,
    commandExecutions: entries.map(command => ({ command, exitCode: 0, status: "completed" })) };
  const report = buildWorkerReport(result, { jobId: id });
  const record = { id, workspaceRoot: cwd, jobClass: "task", status: "completed", createdAt, result, report,
    activity: Array.from({ length: 75 }, (_, i) => ({ seq: i + 1, type: "agentMessage", text: "\x1b[31mFixture\x1b[0m\n\r\u202e " + "details ".repeat(40) })) };
  writeJobFile(cwd, id, record); upsertJob(cwd, record);
  const output = run(process.execPath, [script, "wait", id, "--direct"], { cwd });
  const compact = direct(output);
  assert.equal(directLines(output.stdout).length, 76, "direct progress has no feed cap");
  assert.equal(compact.summary.length, 8000); assert.equal(compact.summaryTruncated, true);
  assert.equal(compact.details, `fugato result '${id}' --details`, "unnamed jobs use the job ID");
  const { summary, ...envelope } = compact;
  assert.ok(Buffer.byteLength(JSON.stringify(envelope)) <= 2000);
  assert.equal(compact.changedFiles.length + compact.changedFilesOmitted, entries.length);
  assert.equal(compact.checks.ran.length + compact.checks.claimed.length + compact.checks.omitted, entries.length * 2);
  // Match the CLI's workspace context so both projections budget identical handles.
  assert.deepEqual(compact, directReport(report, { ...record, workspaceRoot: process.cwd(), result: { ...result,
    structured: { ...structured, keyFindings: entries.slice(0, 12), assumptions: entries.slice(0, 12) } } }), "expanded storage preserves compact v2");
  const full = json(run(process.execPath, [script, "wait", id, "--details"], { cwd }));
  const legacy = json(run(process.execPath, [script, "wait", id, "--json"], { cwd }));
  for (const key of ["keyFindings", "assumptions"]) {
    assert.deepEqual(full[key], entries.map(value => redactActivity(value).slice(0, 2000)), key);
    assert.ok(full[key][0].length > 300); assert.ok(full[key][0].includes("\n")); assert.equal(full[key][1].length, 2000);
    assert.deepEqual(legacy[key], report[key], "non-direct lists retain the report builder's bounds");
    assert.ok(legacy[key][0].length <= 300);
  }
  const expanded = entries.map(value => redactActivity(value).slice(0, 2000));
  const ran = result.commandExecutions.map(c => redactActivity(`${c.command}: exit ${c.exitCode}, ${c.status}`).slice(0, 2000));
  for (const details of [full, json(run(process.execPath, [script, "result", id, "--details"], { cwd }))]) {
    assert.deepEqual(details.touchedFiles, expanded);
    assert.deepEqual(details.verification, ran);
    assert.deepEqual(details.claimedVerification, expanded);
    assert.deepEqual(details.keyFindings, expanded);
    assert.deepEqual(details.assumptions, expanded);
    for (const key of ["touchedFilesOmitted", "verificationOmitted", "claimedVerificationOmitted", "keyFindingsOmitted", "assumptionsOmitted"]) assert.equal(details[key], 0);
  }
  const checks = Array.from({ length: 503 }, (_, i) => `Check ${i}`);
  const parsed = parseStructuredReport(JSON.stringify({ status: "completed", summary: "Completed.", verification: checks, key_findings: checks, assumptions: checks }));
  assert.deepEqual(parsed.verification, checks.slice(0, 500));
  assert.equal(parsed.verificationOmitted, 3);
  const largeResult = { ...result, touchedFiles: checks, structured: parsed, commandExecutions: checks.map(command => ({ command, exitCode: 0, status: "completed" })) };
  const largeRecord = { ...record, result: largeResult, report: buildWorkerReport(largeResult, { jobId: id }) };
  writeJobFile(cwd, id, largeRecord); upsertJob(cwd, largeRecord);
  const capped = json(run(process.execPath, [script, "result", id, "--details"], { cwd }));
  for (const key of ["touchedFiles", "verification", "claimedVerification", "keyFindings", "assumptions"]) {
    assert.equal(capped[key].length, 500);
    assert.equal(capped[`${key}Omitted`], 3);
  }
  const cappedCompact = json(run(process.execPath, [script, "result", id], { cwd }));
  assert.equal(cappedCompact.changedFiles.length + cappedCompact.changedFilesOmitted, checks.length);
  assert.equal(cappedCompact.checks.ran.length + cappedCompact.checks.claimed.length + cappedCompact.checks.omitted, checks.length * 2);
  const ordinary = Array.from({ length: 40 }, (_, i) => ({ command: `printf ${i} ${"x".repeat(80)}`, exitCode: 0, status: "completed" }));
  const checkCommands = ["npm test", "npm run lint", "pnpm run build", "yarn test", "node --test", "python -m pytest", "go test ./...",
    "cargo test", "cargo build", "tsc --noEmit", "npx eslint .", "make test", "pnpm run typecheck", "npm run test:unit", "yarn lint", "yarn build"];
  const failedByExit = { command: "git diff --check", exitCode: 1, status: "completed" };
  const failedByStatus = { command: "sh verify.sh", exitCode: null, status: "failed" };
  for (const { name, commands, failed, kept } of [
    { name: "final failing test", commands: [...ordinary.slice(0, -1), { command: "npm test", exitCode: 1, status: "failed" }], failed: 1, kept: ["npm test: exit 1, failed"] },
    { name: "long failing command", commands: [{ command: "x".repeat(400), exitCode: 1, status: "failed" }], failed: 1, kept: [] },
    { name: "failure beyond details cap", commands: [...Array.from({ length: 500 }, (_, i) => ({ command: `printf ${i}`, exitCode: 0, status: "completed" })),
      { command: "npm test", exitCode: 1, status: "failed" }], failed: 1, kept: ["npm test: exit 1, failed"] },
    { name: "5000 captured commands", commands: [...Array.from({ length: 4999 }, (_, i) => ({ command: `printf ${i}`, exitCode: i < 100 ? 1 : 0,
      status: i < 100 ? "failed" : "completed" })), { command: "npm test", exitCode: 1, status: "failed" }], failed: 101, kept: ["npm test: exit 1, failed"] },
    { name: "check priority and recency", commands: [...checkCommands.map(command => ({ command, exitCode: 0, status: "completed" })), failedByExit, failedByStatus, ...ordinary],
      failed: 2, kept: [...checkCommands.map(command => `${command}: exit 0, completed`), "git diff --check: exit 1, completed", "sh verify.sh: exit unknown, failed"] }
  ]) {
    const checkResult = { status: 0, rawOutput: "Completed.", commandExecutions: commands };
    const checkRecord = { ...record, result: checkResult, report: buildWorkerReport(checkResult, { jobId: id }) };
    writeJobFile(cwd, id, checkRecord); upsertJob(cwd, checkRecord);
    const projected = json(run(process.execPath, [script, "result", id], { cwd }));
    const expanded = json(run(process.execPath, [script, "result", id, "--details"], { cwd }));
    assert.equal(projected.checks.failed, failed, name);
    assert.equal(expanded.checks.failed, failed, name);
    assert.equal(expanded.verification.length, Math.min(500, commands.length), name);
    assert.equal(expanded.verificationOmitted, Math.max(0, commands.length - 500), name);
    assert.equal(projected.checks.ran.length + projected.checks.omitted, commands.length, name);
    assert.ok(projected.checks.ran.every(value => value.length <= 240), name);
    assert.ok(kept.every(value => projected.checks.ran.includes(value)), name);
    const { summary, ...envelope } = projected;
    assert.ok(Buffer.byteLength(JSON.stringify(envelope)) <= 2000, name);
    if (name === "long failing command") assert.ok(projected.checks.ran[0].endsWith(": exit 1, failed"));
    else {
      const chronology = projected.checks.ran.map(value => commands.findIndex(c => value === `${c.command}: exit ${c.exitCode ?? "unknown"}, ${c.status}`));
      assert.deepEqual(chronology, [...chronology].sort((a, b) => a - b), name);
      assert.ok(projected.checks.omitted > 0, name);
      if (name === "check priority and recency") {
        const survivingOrdinary = projected.checks.ran.filter(value => value.startsWith("printf "));
        assert.ok(survivingOrdinary.length > 0);
        assert.deepEqual(survivingOrdinary, ordinary.slice(-survivingOrdinary.length).map(c => `${c.command}: exit 0, completed`));
      }
    }
  }
  assert.equal(compact.checks.failed, undefined, "successful checks omit the failure count");
  assert.equal(full.checks?.failed, undefined, "successful details omit the failure count");
  assert.ok(legacy.assumptions.length <= 3); assert.ok(legacy.claimedVerification.length <= 3);
  const pending = directReport({ status: "needs_answer", jobId: id, question: { id: "q", text: "字".repeat(1000), options: Array(6).fill("字".repeat(160)), expiresAt: Date.now() + 10000 }, blockers: [{ code: "fixture", message: "字".repeat(500) }] });
  const { summary: pendingSummary, ...pendingEnvelope } = pending;
  assert.ok(Buffer.byteLength(JSON.stringify(pendingEnvelope)) <= 2000);
  assert.equal(pending.next, `fugato answer ${id} --question 'q'`);
  for (const options of [Array(165).fill("12345678"), Array(500).fill(""), Array(500).fill("😀".repeat(80))]) {
    const question = { id: "question-'quoted", text: "Choose a scope.", options };
    const compact = directReport({ status: "needs_answer", jobId: id, question });
    const { summary, ...envelope } = compact;
    assert.ok(Buffer.byteLength(JSON.stringify(envelope)) <= 2000);
    assert.equal(compact.question.options.length + (compact.question.optionsOmitted ?? 0), options.length);
    assert.deepEqual(splitRawArgumentString(compact.next), ["fugato", "answer", id, "--question", question.id]);
    assert.equal(question.options.length, options.length, "fitting leaves the full options intact");
  }
  const astral = "a".repeat(7999) + "😀";
  const unicode = directReport({ status: "completed", jobId: id, summary: astral });
  assert.equal(unicode.summary, astral.slice(0, 7999));
  assert.equal(unicode.summaryTruncated, true);
  const astralRecord = { ...record, result: { ...result, structured: { ...structured, summary: astral } } };
  writeJobFile(cwd, id, astralRecord);
  assert.equal(json(run(process.execPath, [script, "result", id, "--details"], { cwd })).summary, unicode.summary);
  const errorReport = buildWorkerReport({ status: 0, rawOutput: "Completed.", error: "Runtime error." });
  assert.equal(errorReport.status, "blocked");
  assert.equal(errorReport.blockers[0].code, "error");
  const recoveryCommand = "fugato status predecessor --json";
  const busy = directReport({ status: "blocked", jobId: id, blockers: [{ code: "thread_busy", message: "Active predecessor.", recoveryCommand }] });
  assert.equal(busy.blockers[0].recoveryCommand, recoveryCommand);
  assert.equal(busy.next, recoveryCommand);
  assert.equal(directReport({ status: "blocked", jobId: id, blockers: [{ code: "thread_busy", cancelCommand: "fugato cancel original" }] }).next, null);
  for (const fields of [
    { app: "com.apple.TextEdit" }, { app: "Fixture  App", sessionId: "Fixture  Session" },
    { tab_id: "123", session_id: "00000000-0000-0000-0000-000000000001" },
    { app: "字".repeat(1000), tabId: "😀".repeat(1000), sessionId: "s".repeat(1000) }
  ]) {
    const parsed = parseStructuredReport(JSON.stringify({ status: "blocked", summary: "Blocked.", blockers: [{ code: "fixture", message: "字".repeat(1000), ...fields }] }));
    const projected = directReport(buildWorkerReport({ status: 0, structured: parsed }, { jobId: id }));
    const { summary, ...envelope } = projected;
    assert.ok(Buffer.byteLength(JSON.stringify(envelope)) <= 2000);
    for (const key of ["app", "tabId", "sessionId"]) {
      const value = parsed.blockers[0][key];
      if (value && value.length <= 240) assert.equal(projected.blockers[0][key], value);
      if (value) assert.ok(projected.blockers[0][key].length <= 240);
    }
  }
  // Recovery commands must fit even when shell quoting expands a real cwd.
  let longCwd = cwd;
  while (longCwd.length < 935) longCwd = path.join(longCwd, "w".repeat(Math.min(70, 936 - longCwd.length)));
  const quotedCwd = path.join(cwd, ...Array(10).fill("q" + "'".repeat(40)));
  for (const [i, workspace] of [path.join(cwd, "short"), longCwd, quotedCwd].entries()) {
    fs.mkdirSync(workspace, { recursive: true });
    for (const code of [null, "context_window_exceeded", "provider_refused"]) {
      const id = `recovery-${i}-${code ?? "answer"}`;
      const pendingQuestion = { id: "current", text: "Continue?", options: [], expiresAt: Date.now() + 60000 };
      const outcome = { status: "blocked", jobId: id, blockers: [{ code, message: "Fixture" }] };
      const record = { id, jobClass: "task", workspaceRoot: workspace, request: { cwd: workspace }, createdAt,
        status: code ? "blocked" : "running", pid: code ? null : process.pid,
        ...(code ? { completedAt: createdAt, report: outcome, result: { status: 1, turnEnded: true, structured: outcome } }
          : { pendingQuestion }) };
      const file = writeJobFile(workspace, id, record); upsertJob(workspace, record);
      const response = run(process.execPath, [script, ...(code ? ["result", id]
        : ["answer", id, "--question", "stale", "--direct", "--quiet"])], { cwd });
      const compact = json(response, code ? 2 : 1), { summary, ...envelope } = compact;
      assert.equal(compact.jobId, id);
      assert.equal(isC2Report(compact), true);
      assert.ok(Buffer.byteLength(JSON.stringify(envelope)) <= 2000);
      assert.equal(compact.next === null, code ? workspace === quotedCwd : workspace === longCwd);
      const details = splitRawArgumentString(compact.details);
      assert.equal(json(run(process.execPath, [script, ...details.slice(1)], { cwd }), code ? 2 : 0).jobId, id);
      if (compact.next !== null) assert.deepEqual(splitRawArgumentString(compact.next),
        code ? ["fugato", "task", "--fresh", "--cwd", workspace] : details.slice(0, -1));
      if (!code) assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).pendingQuestion, pendingQuestion);
    }
  }

  const historyCwd = makeTempDir();
  for (let i = 0; i < 51; i++) {
    const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
    const entry = { id: `history-${i}`, workspaceRoot: historyCwd, jobClass: "task", status: "completed",
      sessionId: i ? "history-other" : "history-own", threadId: `history-thread-${i}`, turnId: `history-turn-${i}`,
      createdAt: timestamp, updatedAt: timestamp, result: { status: 0, turnEnded: true } };
    writeJobFile(historyCwd, entry.id, entry); upsertJob(historyCwd, entry);
  }
  const status = (...args) => json(run(process.execPath, [script, "status", "--json", ...args],
    { cwd: historyCwd, env: { CODEX_COMPANION_SESSION_ID: "history-own" } }));
  const own = status(), all = status("--all");
  assert.equal(own.latestFinished.id, "history-0");
  assert.equal(own.historyOmitted, 0);
  assert.equal(all.recent.length + Number(Boolean(all.latestFinished)), 50);
  assert.equal(all.historyOmitted, 1);
});

test("direct tasks preserve lease precedence, input forms, run settings and continuation inheritance", async () => {
  const f = fixture("review-ok"); f.env.CODEX_COMPANION_LEASE_SEC = "27";
  const promptFile = path.join(f.repo, "prompt.txt"); fs.writeFileSync(promptFile, "fixture from prompt file");
  const firstOutput = f.call("task", "--direct", "--quiet", "--fresh", "--prompt-file", promptFile, "--model", "spark", "--effort", "high", "--fast", "--write", "--sandbox", "workspace-write", "--approve-browser-origin", "https://example.com", "--approve-computer-app", "com.apple.TextEdit", "--owner", "explicit-owner", "--question-timeout-sec", "42", "--cwd", f.repo);
  const first = direct(firstOutput);
  assert.equal(directLines(firstOutput.stdout).length, 1, "task --direct --quiet prints just its JSON");
  const observed = f.call("wait", first.jobId, "--direct");
  assert.deepEqual(direct(observed), first);
  assert.equal(`${directLines(observed.stdout).at(-1)}\n`, firstOutput.stdout, "quiet and streaming task payloads are byte-identical for the same job");
  const firstDetails = json(f.call("result", first.jobId, "--details"));
  assert.ok(AGENT_NAMES.includes(first.worker));
  assert.equal(job(f, first.jobId).agentName, first.worker);
  assert.equal(job(f, first.jobId).leaseSec, 27); assert.equal(firstDetails.ownerId, "explicit-owner");
  assert.equal(firstDetails.model, "gpt-5.3-codex-spark"); assert.equal(firstDetails.effort, "high"); assert.equal(firstDetails.serviceTier, "priority");
  assert.equal(job(f, first.jobId).questionTimeoutSec, 42);
  assert.match(f.state().lastTurnStart.prompt, /fixture from prompt file/);
  const continued = direct(run(process.execPath, [script, "task", "--continue", first.jobId, "--direct", "--report", "--lease-sec", "39"], { cwd: f.repo, env: f.env, input: "fixture from stdin" }));
  assert.equal(job(f, continued.jobId).leaseSec, 39); const continuedDetails = json(f.call("result", continued.jobId, "--details"));
  assert.equal(continuedDetails.threadId, firstDetails.threadId);
  for (const key of ["agentName", "sandbox", "model", "effort", "serviceTier", "approvedBrowserOrigins", "approvedComputerApps"]) assert.deepEqual(continuedDetails[key], firstDetails[key], key);
  assert.match(f.state().lastTurnStart.prompt, /fixture from stdin/);
  const threaded = direct(f.call("task", "--direct", "--thread", firstDetails.threadId, "--normal", "fixture next turn"));
  assert.equal(threaded.worker, first.worker);
  assert.equal(job(f, threaded.jobId).agentName, first.worker);
  const threadedDetails = json(f.call("result", threaded.jobId, "--details"));
  assert.equal(threadedDetails.threadId, firstDetails.threadId); assert.equal(threadedDetails.serviceTier, null);

  const retained = f;
  const older = direct(retained.call("task", "--fresh", "--direct", "--sandbox", "danger-full-access", "--effort", "high", "fixture"));
  const anchor = direct(retained.call("task", "--to", older.worker, "--direct", "--sandbox", "read-only", "--effort", "low", "--dispatch-nonce", "retained-dispatch", "fixture"));
  const threadId = storedFixtureJob(retained, anchor.jobId).threadId;
  const mutate = (f, code) => json(run(process.execPath, ["--input-type=module", "-e", `
    import { updateState, updateJob, listJobs } from ${JSON.stringify(stateModule)};
    ${code}
    console.log(JSON.stringify(listJobs(process.cwd())));
  `], { cwd: f.repo, env: f.env }));
  const flood = count => `updateState(process.cwd(), state => state.jobs.push(...Array.from({ length: ${count} }, (_, i) => ({
    id: "filler-" + i, threadId: "filler-thread-" + i, status: "completed", jobClass: "task", result: { turnEnded: true },
    sessionId: "fixture-session", createdAt: new Date(Date.now() + i + 1).toISOString(), updatedAt: new Date(Date.now() + i + 1).toISOString()
  }))));`;
  mutate(retained, `updateJob(process.cwd(), ${JSON.stringify(older.jobId)}, () => ({ activityCursors: { observer: 1 } }));`);
  const indexed = mutate(retained, flood(55));
  assert.ok(indexed.some(record => record.id === anchor.jobId));
  const visible = json(retained.call("status", "--all", "--json"));
  assert.equal(visible.recent.length + 1, 50);
  assert.ok(!visible.recent.some(record => record.id === anchor.jobId));
  mutate(retained, `updateState(process.cwd(), state => state.jobs.push({ id: "foreign-nonce", threadId: "foreign-thread", jobClass: "task",
    sessionId: "another-session", dispatchNonce: "retained-dispatch", status: "completed", result: { turnEnded: true }, createdAt: new Date().toISOString() }));`);
  const nonce = json(retained.call("status", "--all", "--json", "--dispatch-nonce", "retained-dispatch"));
  assert.deepEqual([...nonce.running, nonce.latestFinished, ...nonce.recent].filter(Boolean).map(record => record.id), [anchor.jobId]);
  const resumed = direct(retained.call("task", "--thread", threadId, "--direct", "fixture"));
  const settings = storedFixtureJob(retained, resumed.jobId).request;
  assert.deepEqual([settings.sandbox, settings.effort], ["read-only", "low"]);
  mutate(retained, `updateState(process.cwd(), state => { state.jobs = state.jobs.filter(job => job.threadId !== ${JSON.stringify(threadId)}); });`);
  const turns = retained.state().nextTurnId;
  const unknown = direct(retained.call("task", "--thread", threadId, "--direct", "fixture"), 2);
  assert.equal(unknown.blockers[0].code, "thread_settings_unknown");
  assert.equal(retained.state().nextTurnId, turns);
  assert.equal(direct(retained.call("task", "--thread", threadId, "--sandbox", "read-only", "--direct", "fixture")).status, "completed");

  const lost = fixture("lost-turn:inProgress");
  const failed = direct(lost.call("task", "--fresh", "--direct", "--timeout-sec", "1", "--sandbox", "read-only", "fixture"));
  const original = storedFixtureJob(lost, failed.jobId);
  storedFixtureJob(lost, failed.jobId, { completedAt: "2000-01-01T00:00:00.000Z" });
  assert.ok(mutate(lost, flood(210)).some(record => record.id === failed.jobId));
  const retentionModule = new URL("../plugins/codex/scripts/lib/retention.mjs", import.meta.url).href;
  const afterRetention = mutate(lost, `import { planRetention, applyRetention } from ${JSON.stringify(retentionModule)};
    const result = await applyRetention(planRetention({ days: 1 }));
    if (result.errors.length || result.jobsDeleted) throw new Error(JSON.stringify(result));`);
  assert.ok(afterRetention.some(record => record.id === failed.jobId));
  const blocked = direct(lost.call("task", "--thread", original.threadId, "--sandbox", "read-only", "--direct", "fixture"), 2);
  assert.equal(blocked.blockers[0].code, "thread_busy");
  const beforeWait = lost.requests().length;
  assert.equal(direct(lost.call("wait", failed.worker, "--direct", "--timeout-sec", "1")).jobId, failed.jobId);
  assert.ok(lost.requests().slice(beforeWait).some(request => request.method === "thread/read"));
  assert.equal(lost.state().nextTurnId, 2);

  const aliases = retained;
  const initial = direct(aliases.call("task", "--fresh", "--direct", "--sandbox", "read-only", "--model", "gpt-5.4", "--effort", "low", "--fast", "fixture"));
  const resumedThread = storedFixtureJob(aliases, initial.jobId).threadId;
  for (const flag of ["--resume", "--resume-last"]) {
    const follow = direct(aliases.call("task", flag, "--direct", "fixture"));
    const record = storedFixtureJob(aliases, follow.jobId);
    assert.equal(record.threadId, resumedThread);
    assert.deepEqual([record.request.sandbox, record.request.model, record.request.effort, record.request.serviceTier], ["read-only", "gpt-5.4", "low", "priority"]);
    assert.equal(aliases.state().lastTurnStart.sandboxPolicy.type, "readOnly");
  }
  mutate(aliases, `updateState(process.cwd(), state => { state.jobs = [{ id: "unknown-resume", jobClass: "task", status: "completed",
    sessionId: "fixture-session", threadId: ${JSON.stringify(resumedThread)}, result: { turnEnded: true }, createdAt: new Date().toISOString() }]; });`);
  const beforeUnknown = aliases.state().nextTurnId;
  for (const flag of ["--resume", "--resume-last"]) {
    assert.equal(direct(aliases.call("task", flag, "--direct", "fixture"), 2).blockers[0].code, "thread_settings_unknown");
  }
  assert.equal(aliases.state().nextTurnId, beforeUnknown);
  assert.equal(direct(aliases.call("task", "--resume-last", "--sandbox", "read-only", "--direct", "fixture")).status, "completed");

  const refused = switchingFixture(fixture); refused.select("w5-parent");
  const live = direct(refused.call("task", "--fresh", "--direct", "--sandbox", "read-only", "--effort", "low", "fixture"));
  const liveJob = storedFixtureJob(refused, live.jobId);
  const decline = () => new Promise((resolve, reject) => {
    const child = spawnOwned(process.execPath, [script, "task", "--thread", liveJob.threadId, "--sandbox", "danger-full-access", "--effort", "xhigh", "--direct", "--quiet", "fixture"],
      { cwd: refused.repo, env: refused.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject); child.on("close", status => { try { resolve(direct({ status, stdout, stderr }, 2)); } catch (error) { reject(error); } });
  });
  const attempts = await Promise.all([decline(), decline()]);
  for (const attempt of attempts) {
    assert.equal(storedFixtureJob(refused, attempt.jobId).report.blockers[0].predecessorJobId, live.jobId);
  }
  assert.equal(refused.state().nextTurnId, 2);
  const answer = id => direct(run(process.execPath, [script, "answer", id, "--direct"], { cwd: refused.repo, env: refused.env, input: "Small" }));
  answer(live.jobId);
  refused.select("review-ok");
  const checkFollow = (selector = ["--to", live.worker]) => {
    const follow = direct(refused.call("task", ...selector, "--direct", "fixture"));
    const stored = storedFixtureJob(refused, follow.jobId);
    assert.deepEqual([stored.request.sandbox, stored.request.effort], ["read-only", "low"]);
    assert.equal(refused.state().lastTurnStart.sandboxPolicy.type, "readOnly");
    assert.equal(follow.status, "completed");
    return storedFixtureJob(refused, follow.jobId);
  };
  checkFollow();
  const started = checkFollow(["--continue", attempts[0].jobId]);
  const neverStarted = { ...started, id: "never-started", status: "failed", turnId: null, recovered: true,
    recovery: { turnStatus: "notStarted" }, result: { turnEnded: true }, report: { status: "failed" },
    createdAt: new Date(Date.now() + 1000).toISOString(), request: { ...started.request, sandbox: "danger-full-access", effort: "xhigh" } };
  mutate(refused, `import { writeJobFile, upsertJob } from ${JSON.stringify(stateModule)};
    const record = ${JSON.stringify(neverStarted)}; writeJobFile(process.cwd(), record.id, record); upsertJob(process.cwd(), record);`);
  checkFollow();
});
