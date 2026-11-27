import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { waitForCondition, readyBroker } from "./helpers.mjs";
import { workerReportHarness } from "./fake-codex-fixture.mjs";
import { splitRawArgumentString } from "../plugins/codex/scripts/lib/args.mjs";
import { directReport, envelopeBytes } from "../plugins/codex/scripts/lib/job-runtime.mjs";
import { isC2Report } from "../plugins/codex/scripts/lib/report-delivery.mjs";

const {
  lifecycle, stateModule, fixture, storedFixtureJob, directJson, callAsync, checkDecisionReport
} = await workerReportHarness();

test("observing an older job does not change the latest resumable dispatch", () => {
  const f = fixture("review-ok");
  const first = directJson(f.call("task", "--name", "First", "--direct", "--quiet", "First task."));
  const second = directJson(f.call("task", "--name", "Second", "--direct", "--quiet", "Second task."));
  const secondThread = storedFixtureJob(f, second.jobId).threadId;
  const observed = f.call("wait", first.jobId, "--direct", "--quiet");
  assert.equal(observed.status, 0, observed.stderr);
  const candidate = directJson(f.call("task-resume-candidate", "--json"));
  assert.equal(candidate.candidate.id, second.jobId);
  const resumed = f.call("task", "--resume-last", "--direct", "--quiet", "Continue the latest task.");
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(storedFixtureJob(f, directJson(resumed).jobId).threadId, secondThread);
});

test("a session keeps its worker identity after another session continues the same thread", () => {
  const f = fixture("review-ok");
  f.env.CODEX_COMPANION_SESSION_ID = "session-A";
  const original = directJson(f.call("task", "--name", "Ada", "--direct", "--quiet", "Session A task."));
  const threadId = storedFixtureJob(f, original.jobId).threadId;
  f.env.CODEX_COMPANION_SESSION_ID = "session-B";
  assert.equal(f.call("task", "--name", "Ada", "--direct", "--quiet", "Session B task.").status, 0);
  const foreign = directJson(f.call("task", "--thread", threadId, "--direct", "--quiet", "Session B continuation."));
  assert.notEqual(foreign.worker, "Ada");
  f.env.CODEX_COMPANION_SESSION_ID = "session-A";
  const continued = f.call("task", "--to", "Ada", "--direct", "--quiet", "Session A continuation.");
  assert.equal(continued.status, 0, continued.stderr);
  const own = directJson(continued);
  assert.equal(own.worker, "Ada");
  assert.equal(storedFixtureJob(f, own.jobId).threadId, threadId);
  assert.equal(directJson(f.call("result", "Ada", "--details")).jobId, own.jobId);
});

test("explicit result and status thread selectors cannot be shadowed by worker names", () => {
  const f = fixture("review-ok");
  const first = directJson(f.call("task", "--name", "First", "--direct", "--quiet", "First task."));
  const threadId = storedFixtureJob(f, first.jobId).threadId;
  const second = directJson(f.call("task", "--name", threadId, "--direct", "--quiet", "Second task."));
  assert.equal(directJson(f.call("result", "--thread", threadId, "--details")).jobId, first.jobId);
  assert.equal(directJson(f.call("status", "--thread", threadId, "--json")).job.id, first.jobId);
  assert.equal(directJson(f.call("result", threadId, "--details")).jobId, second.jobId);
  assert.equal(f.call("result", "--thread", "First", "--details").status, 1);
  assert.equal(f.call("status", "--thread", first.jobId, "--json").status, 1);
});

// Shared fixture; these contracts were moved from worker-lifecycle to balance file runtime.
{
const {
  fs, path, makeTempDir, initGitRepo, run, activityReader, writeJobFile, upsertJob, directReport, splitRawArgumentString, spawnOwned, script, fixture, json, directLines, direct, waitUntil, job
} = lifecycle;

test("report commands resolve ambiguous, cross-workspace and adopted workers through the fugato CLI", t => {
  // cli-3: a failure before thread creation has no task continuation.
  const startup = fixture("lost-turn:startup");
  const failed = startup.call("task", "--direct", "--quiet", "fixture");
  assert.equal(failed.status, 1);
  const startupReport = directJson(failed);
  assert.equal(startupReport.next, null);
  const startupDetails = directJson(startup.call("result", startupReport.jobId, "--details"));
  assert.equal(startupDetails.threadId, null);
  assert.equal(startupDetails.continuationCommand, null);
  const cwd = makeTempDir();
  const records = ["first", "second"].map((id, i) => ({ id, workspaceRoot: cwd, jobClass: "task", agentName: "SharedWorker", threadId: `thread-${id}`,
    sessionId: "command-session", status: "needs_input", createdAt: `2026-10-23T00:00:0${i}Z`,
    report: { status: "needs_input", jobId: id, question: "Which branch?" } }));
  const save = record => { writeJobFile(cwd, record.id, record); upsertJob(cwd, record); };
  const read = id => json(run(process.execPath, [script, "result", id], { cwd, env: { CODEX_COMPANION_SESSION_ID: "command-session" } }), 2);
  records.forEach(save);
  const ambiguousLocal = run(process.execPath, [script, "status", "SharedWorker", "--json"], { cwd, env: { CODEX_COMPANION_SESSION_ID: "command-session" } });
  assert.equal(ambiguousLocal.status, 1);
  assert.match(ambiguousLocal.stderr, /ambiguous name across threads/);
  for (const { id } of records) assert.ok(ambiguousLocal.stderr.includes(`jobId=${id} |`));
  for (const { id } of records) {
    const report = read(id);
    assert.equal(report.worker, "SharedWorker");
    assert.equal(report.next, report.blockers[0].recoveryCommand);
    assert.equal(report.details, `fugato result '${id}' --details`);
    const recovered = json(run(process.execPath, [script, ...splitRawArgumentString(report.details).slice(1)], { cwd }), 2);
    assert.equal(recovered.jobId, id);
  }
  save({ ...records[1], threadId: records[0].threadId });
  assert.equal(read("first").details, "fugato result 'first' --details");
  assert.equal(read("first").next, read("first").blockers[0].recoveryCommand);
  assert.equal(read("second").details, "fugato result 'second' --details");
  assert.equal(read("second").next, read("second").blockers[0].recoveryCommand);

  const f = fixture("review-ok"), other = path.join(f.dir, "other-workspace");
  fs.mkdirSync(other); initGitRepo(other);
  f.env.PATH = `${path.dirname(new URL("../plugins/codex/bin/duet", import.meta.url).pathname)}${path.delimiter}${f.env.PATH}`;
  const execute = (command, cwd = f.repo) => run("sh", ["-c", command], { cwd, env: f.env, input: "Complete the fixture follow-up." });
  for (const verb of ["wait", "answer", "cancel"]) {
    const missing = execute(`fugato ${verb} MissingWorker`);
    assert.equal(missing.status, 1);
    assert.doesNotMatch(missing.stderr, /--thread\b/);
    const recovery = missing.stderr.match(/fugato status --all\b/)?.[0];
    assert.ok(recovery);
    assert.equal(execute(recovery).status, 0);
  }
  assert.match(execute("fugato task --to MissingWorker").stderr, /--thread\b/);
  const workers = [f.repo, other].map(workspace => {
    const launched = direct(execute("fugato task --fresh", workspace));
    const fixture = { ...f, repo: workspace };
    const original = storedFixtureJob(fixture, launched.jobId);
    storedFixtureJob(fixture, launched.jobId, { agentName: "AcrossWorker", status: "needs_input", report: { ...original.report, status: "needs_input" } });
    return { fixture, original };
  });
  for (const { original } of workers) {
    const projected = json(execute(`fugato result ${original.id}`), 2);
    assert.equal(projected.worker, "AcrossWorker");
    const cwdFlag = original.workspaceRoot === f.repo ? "" : ` --cwd '${original.workspaceRoot}'`;
    assert.equal(projected.details, `fugato result '${original.id}'${cwdFlag} --details`);
    assert.equal(projected.next, `fugato task --to AcrossWorker${cwdFlag}`);
    assert.equal(json(execute(projected.details), 2).jobId, original.id);
    const continued = direct(execute(projected.next));
    assert.equal(continued.status, "completed");
    const details = json(execute(continued.details));
    assert.equal(details.threadId, original.threadId);
    assert.equal(json(execute(projected.details), 2).jobId, original.id, "saved details still selects the earlier job after a follow-up");
    assert.equal(continued.next, null);
  }
  const adopted = workers[0];
  storedFixtureJob(adopted.fixture, adopted.original.id, { agentName: "AdoptedWorker", status: "running", leaseExpiresAt: Date.now() + 180000 });
  const moved = json(run(process.execPath, [script, "adopt", adopted.original.id, "--json"], {
    cwd: f.repo, env: { ...f.env, CODEX_COMPANION_SESSION_ID: "replacement-session" }
  }));
  assert.equal(moved.adopted, true);
  storedFixtureJob(adopted.fixture, adopted.original.id, { status: "needs_input", report: { ...adopted.original.report, status: "needs_input" } });
  const dispatchProjection = json(execute(`fugato result ${adopted.original.id}`), 2);
  f.env.CODEX_COMPANION_SESSION_ID = "replacement-session";
  const projected = json(execute(`fugato result ${adopted.original.id}`), 2);
  assert.deepEqual(dispatchProjection, { ...projected, next: `fugato task --to ${adopted.original.id}`,
    details: `fugato result '${adopted.original.id}' --details` }, "foreign-session commands use exact job handles");
  assert.equal(projected.details, `fugato result '${adopted.original.id}' --details`);
  assert.equal(projected.next, "fugato task --to AdoptedWorker");
  assert.equal(json(execute(projected.details), 2).jobId, adopted.original.id);
  const continued = direct(execute(projected.next));
  assert.equal(continued.status, "completed");
  assert.equal(json(execute(continued.details)).threadId, adopted.original.threadId);
  assert.equal(continued.next, null);

  const sequence = fixture("parent-question-sequence");
  const observer = path.join(sequence.dir, "observer's workspace");
  fs.mkdirSync(observer);
  sequence.env.PATH = `${path.dirname(new URL("../plugins/codex/bin/duet", import.meta.url).pathname)}${path.delimiter}${sequence.env.PATH}`;
  const runSequence = (command, cwd = sequence.repo) => run("sh", ["-c", command], { cwd, env: sequence.env, input: "Small" });
  const rejectedAnswer = response => {
    assert.equal(response.status, 1);
    const report = JSON.parse(response.stdout);
    assert.equal(report.status, "error");
    assert.equal(report.jobId, firstQuestion.jobId);
    assert.equal(report.worker, firstQuestion.worker);
    for (const field of ["checks", "usage", "changedFiles"]) assert.equal(report[field], undefined);
    assert.ok(report.next && report.details);
    for (const [field, args] of [["next", ["fugato", "result", report.jobId]], ["details", ["fugato", "result", report.jobId, "--details"]]]) {
      const tokens = splitRawArgumentString(report[field]);
      const cwdIndex = tokens.indexOf("--cwd");
      if (cwdIndex >= 0) assert.equal(tokens.splice(cwdIndex, 2)[1], sequence.repo);
      assert.deepEqual(tokens, args);
      assert.equal(json(runSequence(report[field], observer)).jobId, report.jobId);
    }
  };
  const firstQuestion = direct(runSequence("fugato task --fresh"));
  const secondQuestion = direct(runSequence(firstQuestion.next));
  assert.equal(secondQuestion.status, "needs_answer");
  assert.notEqual(secondQuestion.question.id, firstQuestion.question.id);
  const replies = sequence.state().serverRequestReplies.length;
  for (const target of [firstQuestion.worker, firstQuestion.jobId]) {
    const stale = runSequence(`fugato answer ${target} --question '${firstQuestion.question.id}'`);
    rejectedAnswer(stale);
    assert.equal(sequence.state().serverRequestReplies.length, replies);
    assert.equal(storedFixtureJob(sequence, firstQuestion.jobId).pendingQuestion.id, secondQuestion.question.id);
  }
  assert.equal(direct(runSequence(secondQuestion.next)).status, "completed");
  for (const question of ["", ` --question '${secondQuestion.question.id}'`]) {
    rejectedAnswer(runSequence(`fugato answer ${firstQuestion.jobId}${question}`, observer));
  }
  assert.equal(sequence.state().serverRequestReplies.length, replies + 1);

  // Reproduce pre-upgrade duplicate names: one completed worker and one real
  // pending question in another workspace, both in the same Claude session.
  const p = fixture("w5-parent"), remote = path.join(p.dir, "remote");
  fs.mkdirSync(remote); initGitRepo(remote);
  const duet = new URL("../plugins/codex/bin/duet", import.meta.url).pathname;
  const command = (...args) => run(duet, args, { cwd: p.repo, env: p.env, input: "Small" });
  const first = direct(command("task", "--fresh"));
  assert.equal(first.status, "needs_answer");
  assert.equal(direct(command("answer", first.jobId)).status, "completed");
  const ended = storedFixtureJob(p, first.jobId, { agentName: "Heisenberg" });
  const second = direct(command("task", "--fresh", "--cwd", remote));
  const remoteFixture = { ...p, repo: remote };
  const pending = storedFixtureJob(remoteFixture, second.jobId, { agentName: "Heisenberg" });
  assert.equal(second.status, "needs_answer");
  t.diagnostic(JSON.stringify({ scenario: "same-session legacy duplicate", candidates: [ended, pending].map(record => ({
    jobId: record.id, worker: record.agentName, status: record.status, pending: Boolean(record.pendingQuestion), cwd: record.workspaceRoot
  })) }));
  const resolverModule = new URL("../plugins/codex/scripts/lib/worker-resolve.mjs", import.meta.url).href;
  const resolveName = options => json(run(process.execPath, ["--input-type=module", "-e", `
    import { resolveWorkerTarget } from ${JSON.stringify(resolverModule)};
    console.log(JSON.stringify(resolveWorkerTarget(process.cwd(), "Heisenberg", ${JSON.stringify(options)}).job.id));
  `], { cwd: p.repo, env: p.env }));
  const before = p.state();
  assert.equal(resolveName({}), first.jobId, "a legacy name tie selects the caller's workspace");
  assert.equal(json(command("result", "Heisenberg")).jobId, first.jobId);
  const waited = direct(command("wait", "heisenberg"));
  assert.equal(waited.jobId, second.jobId); assert.equal(waited.status, "needs_answer");
  t.diagnostic(JSON.stringify({ command: "fugato wait heisenberg", ...waited }));
  // Active-state filtering and command filtering are independent: exercise
  // every state and every selector without their duplicate cross-product.
  for (const [status, options] of [["queued", { nameState: "pending", pending: true }],
    ["running", { nameState: "wait" }], ["needs_answer", { nameState: "cancel" }]]) {
    storedFixtureJob(p, first.jobId, { status, pendingQuestion: { ...pending.pendingQuestion, id: "legacy-question" } });
    assert.equal(resolveName(options), first.jobId);
  }
  assert.equal(p.state().nextTurnId, before.nextTurnId, "resolving legacy names never dispatches");
  assert.equal(p.state().serverRequestReplies.length, before.serverRequestReplies.length, "resolving legacy names never submits an answer");
  assert.equal(storedFixtureJob(remoteFixture, second.jobId).pendingQuestion.answer, undefined);
  // An active job with an already-answered question fits wait but not answer.
  storedFixtureJob(p, first.jobId, { status: "running", pendingQuestion: { ...pending.pendingQuestion, id: "legacy-question", answer: "Already submitted" } });
  assert.equal(resolveName({ nameState: "wait" }), first.jobId);
  const answered = direct(command("answer", "heisenberg"));
  assert.equal(answered.jobId, second.jobId); assert.equal(answered.status, "completed");
  assert.equal(p.state().serverRequestReplies.length, before.serverRequestReplies.length + 1);
  t.diagnostic(JSON.stringify({ command: "fugato answer heisenberg", ...answered }));
  storedFixtureJob(p, first.jobId, { status: "completed", pendingQuestion: null });
  const noQuestion = command("answer", "Heisenberg");
  assert.equal(noQuestion.status, 1); assert.match(noQuestion.stderr, /no pending unanswered question/);
  assert.equal(direct(command("wait", "Heisenberg")).jobId, first.jobId);
  assert.equal(direct(command("wait", first.jobId)).jobId, first.jobId, "explicit completed IDs still work");
  const third = direct(command("task", "--fresh", "--cwd", remote));
  const explicit = storedFixtureJob(remoteFixture, third.jobId, { agentName: "Heisenberg" });
  const explicitAnswer = direct(command("answer", "Heisenberg", "--question", explicit.pendingQuestion.id, "--owner", explicit.ownerId));
  assert.equal(explicitAnswer.jobId, third.jobId); assert.equal(explicitAnswer.status, "completed");
  t.diagnostic(JSON.stringify({ command: "fugato answer Heisenberg --question <id> --owner <id>", ...explicitAnswer }));

  const busy = fixture("w5-parent");
  const launched = direct(busy.call("task", "--fresh", "--direct", "fixture"));
  const rejected = direct(busy.call("task", "--to", launched.worker, "--direct", "mistaken follow-up"), 2);
  assert.equal(rejected.blockers[0].code, "thread_busy");
  const active = direct(busy.call("wait", launched.worker, "--direct"));
  assert.equal(active.jobId, launched.jobId); assert.equal(active.status, "needs_answer");
  assert.equal(json(busy.call("cancel", launched.worker, "--json")).jobId, launched.jobId);
  json(run(process.execPath, ["--input-type=module", "-e", `
    import { writeJobFile, upsertJob } from ${JSON.stringify(stateModule)};
    const original = { id: "late-answer-active", workspaceRoot: process.cwd(), jobClass: "task", sessionId: "fixture-session",
      agentName: "LateAnswer", ownerId: "late-owner", threadId: "late-thread", turnId: "late-turn", status: "running", pid: ${process.pid},
      createdAt: "2026-01-01T00:00:00Z" };
    const refused = { ...original, id: "late-answer-refused", ownerId: "refused-owner", turnId: null, status: "blocked", pid: null,
      createdAt: "2026-01-02T00:00:00Z", result: { blockers: [{ code: "thread_busy" }] } };
    for (const record of [original, refused]) { writeJobFile(process.cwd(), record.id, record); upsertJob(process.cwd(), record); }
    console.log("{}");
  `], { cwd: busy.repo, env: busy.env }));
  const late = run(process.execPath, [script, "answer", "LateAnswer", "--question", "old-question", "--owner", "late-owner", "--direct"],
    { cwd: busy.repo, env: busy.env, input: "Small" });
  assert.equal(late.status, 1); assert.match(late.stderr, /Question is no longer pending/);

  const names = fixture("w5-parent");
  const resident = direct(names.call("task", "--fresh", "--direct", "fixture"));
  const answer = id => direct(run(process.execPath, [script, "answer", id, "--direct"], { cwd: names.repo, env: names.env, input: "Small" }));
  names.env.CODEX_COMPANION_SESSION_ID = "foreign-session";
  const incoming = direct(names.call("task", "--fresh", "--direct", "fixture"));
  const foreign = storedFixtureJob(names, incoming.jobId, { agentName: resident.worker });
  names.env.CODEX_COMPANION_SESSION_ID = "fixture-session";
  const adoptedName = json(names.call("adopt", incoming.jobId, "--json"));
  assert.equal(adoptedName.adopted, true); assert.equal(adoptedName.jobId, incoming.jobId);
  assert.notEqual(adoptedName.agentName.toLowerCase(), resident.worker.toLowerCase());
  assert.equal(storedFixtureJob(names, incoming.jobId).threadId, foreign.threadId);
  assert.equal(answer(adoptedName.agentName).jobId, incoming.jobId);
  names.env.CODEX_COMPANION_SESSION_ID = "third-session";
  const completedForeign = direct(names.call("task", "--fresh", "--direct", "fixture"));
  answer(completedForeign.jobId);
  const threadSource = storedFixtureJob(names, completedForeign.jobId, { agentName: resident.worker });
  names.env.CODEX_COMPANION_SESSION_ID = "fixture-session";
  const broughtIn = direct(names.call("task", "--thread", threadSource.threadId, "--direct", "fixture"));
  assert.equal(broughtIn.status, "needs_answer");
  assert.notEqual(broughtIn.worker.toLowerCase(), resident.worker.toLowerCase());
  assert.equal(storedFixtureJob(names, broughtIn.jobId).threadId, threadSource.threadId);
  answer(broughtIn.worker); answer(resident.worker);

  for (const [session, workspaceBytes] of [["other-session", 875], ["", 950]]) {
    const scoped = fixture("review-ok");
    let remote = path.join(scoped.dir, "quoted ' workspace");
    while (workspaceBytes && Buffer.byteLength(remote) < workspaceBytes) remote = path.join(remote, "w".repeat(Math.min(180, workspaceBytes - Buffer.byteLength(remote) - 1)));
    fs.mkdirSync(remote, { recursive: true }); initGitRepo(remote);
    scoped.env.PATH = f.env.PATH;
    if (!session) scoped.env.CODEX_COMPANION_SESSION_ID = "";
    const first = direct(scoped.call("task", "--fresh", "--direct", "--cwd", remote, "fixture"));
    const remoteFixture = { ...scoped, repo: remote }, saved = storedFixtureJob(remoteFixture, first.jobId);
    const outcome = workspaceBytes ? { status: "blocked", blockers: [{ code: "fixture_blocker", message: "Review needed before continuing." }],
      usage: { inputTokens: 100000, cachedInputTokens: 100000, outputTokens: 100000, reasoningOutputTokens: 100000, totalTokens: 300000 } } : { status: "needs_input" };
    storedFixtureJob(remoteFixture, first.jobId, { status: outcome.status, report: { ...saved.report, ...outcome } });
    scoped.env.CODEX_COMPANION_SESSION_ID = session;
    const report = json(scoped.call("result", first.jobId, "--cwd", remote), 2);
    const { summary, ...envelope } = report;
    assert.ok(Buffer.byteLength(JSON.stringify(envelope)) <= 2000);
    const execute = command => run("sh", ["-c", command], { cwd: scoped.repo, env: scoped.env, input: "Follow up." });
    assert.equal(json(execute(report.details), 2).jobId, first.jobId);
    const resumed = direct(execute(report.next));
    assert.equal(json(execute(resumed.details)).threadId, saved.threadId);
  }

  for (const workspaceBytes of [875, 3000]) {
    const lost = fixture("lost-turn:inProgress");
    let remote = path.join(lost.dir, "quoted ' workspace");
    while (Buffer.byteLength(remote) < workspaceBytes) remote = path.join(remote, "w".repeat(Math.min(180, workspaceBytes - Buffer.byteLength(remote) - 1)));
    assert.equal(Buffer.byteLength(remote), workspaceBytes);
    // macOS PATH_MAX is 1024: project the 3 KB report path onto a real job in
    // a shorter workspace, then execute its compact commands against that job.
    const actualWorkspace = workspaceBytes === 875 ? remote : lost.repo;
    if (workspaceBytes === 875) { fs.mkdirSync(remote, { recursive: true }); initGitRepo(remote); }
    const remoteFixture = { ...lost, repo: actualWorkspace };
    const failed = direct(lost.call("task", "--fresh", "--direct", "--timeout-sec", "1", "--cwd", actualWorkspace, "--sandbox", "read-only", "fixture"));
    const predecessor = storedFixtureJob(remoteFixture, failed.jobId);
    const refused = direct(lost.call("task", "--thread", predecessor.threadId, "--direct", "--cwd", actualWorkspace, "follow-up"), 2);
    assert.equal(refused.blockers[0].code, "thread_busy");
    const saved = storedFixtureJob(remoteFixture, refused.jobId);
    const quote = value => `'${value.replace(/'/g, `'"'"'`)}'`;
    const payload = { ...saved.report,
      usage: { inputTokens: 100000, cachedInputTokens: 100000, outputTokens: 100000, reasoningOutputTokens: 100000, totalTokens: 300000 },
      blockers: saved.report.blockers.map(blocker => ({ ...blocker,
        cancelCommand: blocker.cancelCommand.replace(`--cwd ${quote(actualWorkspace)}`, `--cwd ${quote(remote)}`),
        recoveryCommand: blocker.recoveryCommand.replace(`--cwd ${quote(actualWorkspace)}`, `--cwd ${quote(remote)}`)
      })) };
    storedFixtureJob(remoteFixture, refused.jobId, { report: payload });
    lost.env.PATH = `${path.dirname(duet)}${path.delimiter}${lost.env.PATH}`;
    lost.env.CODEX_COMPANION_SESSION_ID = "other-session";
    const project = payload => directReport(payload, { ...saved, workspaceRoot: remote, request: { ...saved.request, cwd: remote } }, lost.env);
    const execute = command => run("sh", ["-c", command], { cwd: lost.repo, env: lost.env });
    const report = project(payload), { summary, ...envelope } = report;
    assert.ok(Buffer.byteLength(JSON.stringify(envelope)) <= 2000);
    const beforeCancel = lost.requests().length;
    const cancelled = json(execute(report.blockers[0].cancelCommand));
    assert.equal(cancelled.jobId, predecessor.id);
    assert.equal(cancelled.confirmation, "confirmed");
    assert.ok(lost.requests().slice(beforeCancel).some(request => request.method === "turn/interrupt"
      && request.params.threadId === predecessor.threadId && request.params.turnId === predecessor.turnId));
    const stillRefused = storedFixtureJob(remoteFixture, refused.jobId);
    assert.equal(stillRefused.status, "blocked");
    assert.ok(!stillRefused.cancelRequested);
    assert.equal(json(execute(report.details), 2).blockers[0].cancelCommand, payload.blockers[0].cancelCommand);

    if (workspaceBytes === 3000) {
      const legacy = { ...payload, blockers: payload.blockers.map(({ predecessorJobId, ...blocker }) => blocker) };
      storedFixtureJob(remoteFixture, refused.jobId, { report: legacy });
      const compact = project(legacy), { summary, ...envelope } = compact;
      assert.ok(Buffer.byteLength(JSON.stringify(envelope)) <= 2000);
      assert.equal(Object.hasOwn(compact.blockers[0], "cancelCommand"), false);
      const details = json(execute(compact.details), 2);
      for (const key of ["cancelCommand", "recoveryCommand"]) assert.equal(details.blockers[0][key], legacy.blockers[0][key]);
    }
  }
});
}
