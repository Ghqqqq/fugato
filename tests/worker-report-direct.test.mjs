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
  lifecycle, fixture, storedFixtureJob, directJson, callAsync, checkDecisionReport
} = await workerReportHarness();

test("writer-locked follow-ups wait for the busy broker, bound the wait and preserve fresh fallback", { timeout: 60000 }, async t => {
  const json = (result, status = 0) => { assert.equal(result.status, status, result.stderr + result.stdout); return JSON.parse(result.stdout); };
  const { CodexAppServerClient } = await import("../plugins/codex/scripts/lib/app-server.mjs");
  const { unresolvedTask } = await import("../plugins/codex/scripts/lib/state.mjs");
  const f = fixture("writer-lock", { mutable: true });
  f.env.CODEX_COMPANION_BROKER_WAIT_MS = "30000";
  // Inject the later busy rejection deterministically, after thread/resume
  // succeeds. A gate avoids racing a competing peer between individual RPCs.
  const lateBusy = path.join(f.dir, "late-busy"), binary = path.join(f.dir, "codex");
  fs.writeFileSync(binary, fs.readFileSync(binary, "utf8").replace('case "turn/start": {', `case "turn/start": {
    if (fs.existsSync(${JSON.stringify(lateBusy)}) && fs.readFileSync(${JSON.stringify(lateBusy)}, "utf8") === message.params.threadId) {
      send({ id: message.id, error: { code: -32001, message: "Shared Codex broker is busy." } }); return;
    }
  `));
  const broker = await readyBroker(f.repo, f.env);
  t.after(broker.close);
  const owner = await CodexAppServerClient.connect(f.repo, { env: f.env, brokerEndpoint: broker.endpoint });
  t.after(() => owner.close());
  const makeThread = async () => (await owner.request("thread/start", { cwd: f.repo, sandbox: "read-only" })).thread.id;
  const target = await makeThread(), timedOut = await makeThread(), stopped = await makeThread(), late = await makeThread(), other = await makeThread();
  const brokerPid = f.state().launches[0].pid;
  const requests = () => fs.readFileSync(path.join(f.dir, "fake-codex-state.json.requests.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  const turns = id => f.state().threads.find(thread => thread.id === id).turns ?? [];
  const waitLine = "Thread is loaded in the shared Codex runtime; waiting for it to finish its current turn.";
  const follow = threadId => {
    const task = callAsync(f, "task", "--thread", threadId, "--sandbox", "read-only", "--report", "--json", "fixture follow-up");
    let progress = "", ended = false;
    task.child.stderr.on("data", data => { progress += data; });
    task.child.stdout.on("data", data => { progress += data; });
    task.done.then(() => { ended = true; });
    t.after(() => { if (!ended) task.child.kill("SIGTERM"); });
    return { ...task, progress: () => progress, waiting: async () => {
      await waitForCondition(() => progress.includes(waitLine) || ended, "broker wait or task outcome", 10000).catch(error => { throw new Error(error.message + "\n" + progress); });
      assert.ok(progress.includes(waitLine), progress);
    } };
  };
  const hold = async () => (await owner.request("turn/start", { threadId: other, input: [{ type: "text", text: "hold shared runtime" }] })).turn.id;
  const release = turnId => owner.request("turn/interrupt", { threadId: other, turnId });

  const held = await hold();
  const waiting = follow(target);
  await waiting.waiting();
  const privatePid = f.state().launches.at(-1).pid;
  assert.notEqual(privatePid, brokerPid);
  assert.throws(() => process.kill(privatePid, 0), { code: "ESRCH" }, "the colliding private runtime is closed before waiting");
  assert.equal(turns(target).length, 0);
  const fresh = json(f.call("task", "--fresh", "--report", "--json", "fixture fresh"));
  assert.equal(fresh.status, "completed");
  assert.notEqual(requests().find(request => request.method === "turn/start" && request.params.threadId === fresh.threadId).serverId, brokerPid);
  await release(held);
  const completed = json(await waiting.done);
  assert.equal(completed.status, "completed");
  assert.equal(turns(target).length, 1);
  assert.equal(requests().filter(request => request.method === "turn/start" && request.params.threadId === target).length, 1);
  assert.equal(requests().find(request => request.method === "turn/start" && request.params.threadId === target).serverId, brokerPid);
  assert.equal(waiting.progress().split(waitLine).length - 1, 1);

  const heldAgain = await hold();
  f.env.CODEX_COMPANION_BROKER_WAIT_MS = "100";
  const bounded = follow(timedOut);
  const blocked = json(await bounded.done, 2);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.blockers[0].code, "thread_busy");
  assert.match(blocked.blockers[0].message, /shared runtime.*busy with another turn.*Retry after/i);
  assert.equal(turns(timedOut).length, 0);
  assert.equal(requests().some(request => request.method === "turn/start" && request.params.threadId === timedOut), false);
  const saved = storedFixtureJob(f, blocked.jobId);
  assert.equal(saved.result.turnEnded, true);
  assert.equal(saved.turnId, null);
  assert.equal(unresolvedTask(saved), false);
  assert.equal(Boolean(saved.recovered), false);
  assert.equal(json(f.call("result", blocked.jobId, "--json")).storedJob.report.blockers[0].code, "thread_busy");
  const retry = json(f.call("result", blocked.jobId), 2).next;
  assert.deepEqual(splitRawArgumentString(retry), ["fugato", "task", "--to", blocked.jobId, "--cwd", f.repo, "--sandbox", "read-only"]);
  assert.equal(bounded.progress().split(waitLine).length - 1, 1);

  // Stopping the foreground worker aborts backoff without submitting a turn.
  f.env.CODEX_COMPANION_BROKER_WAIT_MS = "30000";
  const stopping = follow(stopped);
  await stopping.waiting();
  stopping.child.kill("SIGTERM");
  const stopResponse = await stopping.done;
  assert.equal(stopResponse.status, 1, stopResponse.stderr);
  const stopReport = JSON.parse(stopResponse.stdout);
  assert.equal(stopReport.status, "interrupted");
  const stoppedJob = storedFixtureJob(f, stopReport.jobId);
  assert.equal(stoppedJob.result.turnEnded, true);
  assert.equal(stoppedJob.result.interruptionConfirmed, true);
  assert.equal(turns(stopped).length, 0);
  await release(heldAgain);
  assert.equal(json(f.call(...splitRawArgumentString(retry).slice(1), "--report", "--json", "fixture retry")).status, "completed");

  const startsBeforeLate = f.state().appServerStarts;
  fs.writeFileSync(lateBusy, late);
  const acceptedResume = follow(late);
  await acceptedResume.waiting();
  assert.equal(f.state().appServerStarts, startsBeforeLate, "an accepted broker resume never replays privately");
  fs.rmSync(lateBusy);
  assert.equal(json(await acceptedResume.done).status, "completed");
  assert.equal(turns(late).length, 1);
  assert.ok(requests().filter(request => request.params.threadId === late).every(request => request.serverId === brokerPid));
  assert.equal(acceptedResume.progress().split(waitLine).length - 1, 1);

  // With no owner and no keeper, only the waiter could pin this abandoned
  // runtime. Its socket must close between attempts so retirement releases
  // the writer lock and a new runtime can accept exactly one follow-up turn.
  const abandoned = await makeThread();
  fs.writeFileSync(path.join(f.dir, "fake-codex-state.json"), JSON.stringify({ ...f.state(), ignoreInterrupt: true }));
  const abandonedTurn = await hold();
  f.env.CODEX_COMPANION_CONNECT_TIMEOUT_MS = "5000";
  const retiring = follow(abandoned);
  await retiring.waiting();
  await owner.close();
  broker.close();
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };
  await waitForCondition(() => !alive(broker.pid) && !alive(brokerPid), "abandoned broker retires without a connected waiter", 20000);
  assert.equal(f.state().lastInterrupt.turnId, abandonedTurn);
  assert.equal(json(await retiring.done).status, "completed");
  assert.equal(turns(abandoned).length, 1);
  const accepted = requests().filter(request => request.method === "turn/start" && request.params.threadId === abandoned);
  assert.equal(accepted.length, 1);
  assert.notEqual(accepted[0].serverId, brokerPid, "a replacement runtime acquired the released writer lock");
  assert.equal(retiring.progress().split(waitLine).length - 1, 1);
});

// Shared fixture; these contracts were moved from worker-lifecycle to balance file runtime.
{
const {
  fs, path, run, activityReader, splitRawArgumentString, spawnOwned, script, fixture, json, directLines, direct, waitUntil, job
} = lifecycle;

test("task --direct streams progress as owner, then resumes without replaying activity", async () => {
  const f = fixture("w9-feed"), gate = path.join(f.dir, "finish-turn");
  f.env.CODEX_FIXTURE_TURN_GATE = gate;
  const owner = spawnOwned(process.execPath, [script, "task", "--direct", "fixture"],
    { cwd: f.repo, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  owner.stdout.on("data", chunk => { stdout += chunk; });
  owner.stderr.on("data", chunk => { stderr += chunk; });
  const closed = new Promise(resolve => owner.once("close", resolve));
  await waitUntil(() => {
    assert.equal(owner.exitCode, null, stderr || "direct owner exited before progress");
    return stdout.includes("\n");
  });
  assert.equal(owner.exitCode, null, "fixture completion is still gated");
  assert.equal(stdout.split("\n").some(line => line.startsWith("{")), false);
  fs.writeFileSync(gate, "complete");
  const done = direct({ status: await closed, stdout, stderr });
  assert.equal(done.status, "completed");
  const stored = storedFixtureJob(f, done.jobId);
  assert.equal(directLines(stdout).length - 1, stored.activity.length);
  assert.ok(stored.activity.length > 0);
  assert.equal(stored.leaseSec, 1800);
  assert.equal(stored.direct, true);
  assert.equal(stored.ownerId, json(f.call("result", done.jobId, "--details")).ownerId);
  assert.equal(stored.ownerDetachReason, "returned");
  assert.equal(stored.request.report, true);
  assert.equal(stored.request.detached, true);
  assert.doesNotMatch(JSON.stringify(done), /PRIVATE_FIXTURE/);
  const again = f.call("wait", done.jobId, "--owner", stored.ownerId, "--direct", "--details");
  const repeated = json(again);
  assert.equal(directLines(again.stdout).length, 1);
  assert.equal(repeated.activityCount, 0);
  assert.equal(repeated.turnId, stored.turnId);
  assert.equal(f.state().nextTurnId, 2);
});

test("direct questions provide executable re-wait and stdin-answer commands and preserve adoption", async () => {
  const f = fixture("w5-parent"), launch = json(f.call("task", "--detached", "--json", "--owner", "parent's owner", "fixture"));
  const output = f.call("wait", launch.jobId, "--owner", launch.ownerId, "--direct");
  const compact = direct(output);
  checkDecisionReport(f, output, "needs_answer", 0);
  const pending = json(f.call("result", launch.jobId, "--details"));
  assert.equal(compact.next, `fugato answer ${launch.agentName} --question '${pending.question.id}'`);
  assert.equal(pending.status, "needs_answer"); assert.ok(pending.question.id);
  assert.deepEqual(pending.question.options, ["Small", "Broad"]);
  assert.deepEqual(splitRawArgumentString(pending.waitCommand), ["node", script, "wait", launch.jobId, "--cwd", f.repo, "--owner", launch.ownerId, "--direct", "--after-question", pending.question.id]);
  assert.deepEqual(splitRawArgumentString(pending.answerCommand), ["node", script, "answer", launch.jobId, "--cwd", f.repo, "--owner", launch.ownerId, "--question", pending.question.id, "--json"]);
  const before = job(f, launch.jobId);
  assert.equal(before.direct, true); assert.equal(before.leaseSec, 180, "direct wait preserves the original lease duration");
  const stillPendingOutput = f.call(...splitRawArgumentString(pending.waitCommand).slice(2), "--timeout-sec", "1");
  const stillPending = direct(stillPendingOutput);
  assert.equal(directLines(stillPendingOutput.stdout).length, 1, "--after-question does not replay progress");
  assert.equal(stillPending.question.id, pending.question.id);
  assert.ok(job(f, launch.jobId).leaseExpiresAt > before.leaseExpiresAt);
  const adopted = json(f.call("adopt", launch.jobId, "--json"));
  assert.deepEqual(splitRawArgumentString(adopted.waitCommand), ["node", script, "wait", launch.jobId, "--owner", adopted.ownerId, "--cwd", f.repo, "--direct"]);
  const moved = direct(f.call("wait", launch.jobId, "--owner", launch.ownerId, "--direct"), 2);
  assert.equal(moved.status, "ownership_moved"); assert.equal(job(f, launch.jobId).ownerId, adopted.ownerId);
  assert.equal(moved.waitCommand, undefined); assert.equal(moved.answerCommand, undefined);
  const replacement = directJson(f.call(...splitRawArgumentString(adopted.waitCommand).slice(2), "--details"));
  const cursor = job(f, launch.jobId).activityCursors[activityReader(adopted.ownerId)];
  const owner = spawnOwned(process.execPath, splitRawArgumentString(replacement.waitCommand).slice(1), { cwd: f.repo, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  owner.stdout.on("data", chunk => { stdout += chunk; }); owner.stderr.on("data", chunk => { stderr += chunk; });
  const closed = new Promise(resolve => owner.on("close", resolve));
  await waitUntil(() => job(f, launch.jobId).ownerAttached);
  const answer = run(process.execPath, splitRawArgumentString(replacement.answerCommand).slice(1), { cwd: f.repo, env: f.env, input: "Small PRIVATE_FIXTURE_ANSWER" });
  assert.equal(json(answer).status, "answer_submitted");
  const done = direct({ status: await closed, stdout, stderr });
  const progress = directLines(stdout).slice(0, -1);
  assert.ok(progress.length > 0, "answering produces new progress before the final report");
  assert.equal(progress.length, storedFixtureJob(f, done.jobId).activity.filter(event => event.seq > cursor).length);
  for (const line of progress) assert.ok(Number(/^\[(\d+)\]/.exec(line)?.[1]) > cursor, "only new events are streamed");
  assert.equal(done.status, "completed"); assert.equal(job(f, done.jobId).turnId, pending.turnId);
});
}

test("directReport keeps next for 3.4 KiB action-approval questions while enforcing the 2000-byte envelope elsewhere", () => {
  const approvalText = "Antigravity requests permission.\n" + "a".repeat(3500) + "\nAllow this operation once?";
  for (const backend of ["antigravity", "codex"]) {
    const job = { id: `task-${backend}-3k`, workspaceRoot: process.cwd(),
      request: { cwd: process.cwd(), ...(backend === "antigravity" ? { backend } : {}) } };
    const payload = { status: "needs_answer", jobId: job.id,
      question: { id: "action-approval-1", kind: "action-approval", text: approvalText, options: ["Allow once", "Deny"], expiresAt: Date.now() + 60000 } };
    const report = directReport(payload, job);
    assert.equal(report.next, `fugato answer ${job.id} --question 'action-approval-1'`);
    assert.equal(report.question.text, approvalText);
    assert.equal(isC2Report(report), true);
    assert.ok(envelopeBytes(report) <= 2000);

    // Extra envelope fields are still fitted into the 2000-byte budget.
    const crowded = directReport({ ...payload, blockers: [{ code: "notice", message: "m".repeat(1500) }],
      keyFindings: Array(10).fill("k".repeat(200)) }, job);
    assert.equal(crowded.next, `fugato answer ${job.id} --question 'action-approval-1'`);
    assert.equal(crowded.question.text, approvalText);
    assert.ok(envelopeBytes(crowded) <= 2000);
    assert.equal(isC2Report(crowded), true);
  }

  // Ordinary questions remain strictly inside the 2000-byte envelope.
  const regular = directReport({ status: "needs_answer", jobId: "task-regular-3k",
    question: { id: "question-1", kind: "question", text: "q".repeat(3500), options: ["A", "B"], expiresAt: Date.now() + 60000 } },
  { id: "task-regular-3k", workspaceRoot: process.cwd(), request: { cwd: process.cwd(), backend: "antigravity" } });
  const { summary, ...envelope } = regular;
  assert.ok(Buffer.byteLength(JSON.stringify(envelope)) <= 2000);
  assert.ok(regular.question.text.length < 2000);
  assert.equal(isC2Report(regular), true);
});
