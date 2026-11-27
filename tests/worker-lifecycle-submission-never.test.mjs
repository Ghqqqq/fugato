import test from 'node:test';
import assert from 'node:assert/strict';
import { lifecycleHarness } from './fake-codex-fixture.mjs';
const {
  fs, path, initGitRepo, resolveStateDir, run, readJobFile, script, alive, fixture, json, direct, waitUntil, patchJob
} = await lifecycleHarness();

const storedJob = (f, id) => readJobFile(path.join(resolveStateDir(f.repo, f.env), "jobs", `${id}.json`));

test("submission records distinguish a dead wrapper's pending start from a never-submitted turn (never submitted)", async t => {
  const { readyBroker, requireLocalSockets } = await import('./helpers.mjs');
  const { sendBrokerShutdown } = await import('../plugins/codex/scripts/lib/broker-lifecycle.mjs');
  if (!await requireLocalSockets(t)) return;
  const brokerFile = f => path.join(resolveStateDir(f.repo, f.env), "broker.json");
  const requests = f => fs.existsSync(path.join(f.dir, "fake-codex-state.json.requests.jsonl")) ? f.requests() : [];
  const follow = (f, threadId, cwd = f.repo) => run(process.execPath,
    [script, "task", "--thread", threadId, "--sandbox", "read-only", "--direct", "--quiet", "follow up"], { cwd, env: f.env });
  const workspace = f => { const cwd = path.join(f.dir, "other-workspace"); fs.mkdirSync(cwd); initGitRepo(cwd); return cwd; };
  const kill = async pid => { process.kill(pid, "SIGKILL"); await waitUntil(() => !alive(pid)); };

  await t.test("explicit start rejection clears submission before failure or broker retry", async () => {
    const f = fixture("reject-turn-start"), gate = path.join(f.dir, "fake-codex-state.json.reject-start");
    fs.writeFileSync(gate, JSON.stringify({ code: -32602, message: "unsupported effort for selected model" }));
    const first = f.call("task", "--fresh", "--sandbox", "read-only", "--direct", "--quiet", "--timeout-sec", "1", "invalid");
    const rejected = storedJob(f, JSON.parse(first.stdout.trim().split("\n").at(-1)).jobId);
    fs.rmSync(gate);
    const corrected = JSON.parse(f.call("task", "--to", rejected.id, "--sandbox", "read-only", "--direct", "--quiet", "corrected").stdout.trim().split("\n").at(-1));

    const malformed = fixture("malformed-turn-start");
    const lostReply = malformed.call("task", "--fresh", "--sandbox", "read-only", "--report", "--json", "malformed reply");
    const lost = storedJob(malformed, /Job handle: ([^;]+)/.exec(lostReply.stderr)?.[1]);
    const busy = fixture("reject-turn-start"), busyGate = path.join(busy.dir, "fake-codex-state.json.reject-start");
    const keeper = await readyBroker(busy.repo, busy.env);
    try {
      const seed = direct(busy.call("task", "--fresh", "--sandbox", "read-only", "--direct", "--quiet", "seed"));
      fs.writeFileSync(busyGate, JSON.stringify({ code: -32001, message: "Shared Codex broker is busy." }));
      const launch = json(busy.call("task", "--to", seed.jobId, "--detached", "--json", "busy"));
      await waitUntil(() => fs.readFileSync(storedJob(busy, launch.jobId).logFile, "utf8").includes("waiting for it to finish"));
      const waiting = storedJob(busy, launch.jobId);
      await kill(waiting.pid);
      // A retry can race the kill; age its dead-owner lock without sleeping.
      const admission = path.join(busy.env.CODEX_COMPANION_HOME, "duet", "thread-admission");
      for (const lock of fs.readdirSync(admission)) for (const owner of fs.readdirSync(path.join(admission, lock))) {
        if (owner.startsWith(`owner-${waiting.pid}-`)) fs.utimesSync(path.join(admission, lock, owner), 0, 0);
      }
      fs.rmSync(busyGate);
      const retry = JSON.parse(busy.call("task", "--to", launch.jobId, "--direct", "--quiet", "retry").stdout.trim().split("\n").at(-1));
      assert.deepEqual({ rejected: { submission: rejected.turnSubmission, turnStatus: rejected.result?.turnStatus,
        turnEnded: rejected.result?.turnEnded, follow: corrected.status },
      malformed: { submitted: Boolean(lost.turnSubmission), turnStatus: lost.result?.turnStatus ?? null },
      busy: { submission: waiting.turnSubmission, turnId: waiting.turnId ?? null,
        recovery: storedJob(busy, launch.jobId).recovery?.turnStatus, follow: retry.status,
        turns: busy.state().threads[0].turns.length } },
      { rejected: { submission: null, turnStatus: "notStarted", turnEnded: true, follow: "completed" },
        malformed: { submitted: true, turnStatus: null },
        busy: { submission: null, turnId: null, recovery: "notStarted", follow: "completed", turns: 2 } });
    } finally { fs.rmSync(busyGate, { force: true }); keeper.close(); }
  });

  for (const scenario of ["recycled pid", "retired explicit endpoint", "live override with stale record", "cross-workspace replacement", "legacy record"]) {
    await t.test(scenario, async () => {
      const f = fixture("before-turn-start"), stateFile = path.join(f.dir, "fake-codex-state.json"), remote = workspace(f);
      const launch = json(f.call("task", "--fresh", "--detached", "--json", "never submitted"));
      let keeper;
      try {
        await waitUntil(() => fs.existsSync(stateFile + ".before-start"));
        const original = storedJob(f, launch.jobId);
        assert.ok(original.threadId && !original.turnId);
        await kill(original.pid);
        const broker = JSON.parse(fs.readFileSync(brokerFile(f)));
        await sendBrokerShutdown(broker.endpoint); await waitUntil(() => !alive(broker.pid));
        assert.equal(requests(f).filter(request => request.method === "turn/start").length, 0);
        if (scenario === "recycled pid") fs.writeFileSync(brokerFile(f), JSON.stringify({ ...broker, pid: process.pid }));
        if (scenario === "retired explicit endpoint") f.env.CODEX_COMPANION_APP_SERVER_ENDPOINT = broker.endpoint;
        if (scenario === "live override with stale record") {
          keeper = await readyBroker(remote, f.env); f.env.CODEX_COMPANION_APP_SERVER_ENDPOINT = keeper.endpoint;
        }
        if (scenario === "cross-workspace replacement") {
          keeper = await readyBroker(f.repo, f.env);
          assert.equal(direct(follow(f, original.threadId, remote)).status, "completed");
        }
        if (scenario === "legacy record") {
          // Remove the creation discriminator from both durable copies.
          const stateDir = resolveStateDir(f.repo, f.env), file = path.join(stateDir, "jobs", `${original.id}.json`);
          const record = storedJob(f, original.id), index = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json")));
          delete record.turnSubmission;
          for (const candidate of index.jobs) if (candidate.id === original.id) delete candidate.turnSubmission;
          fs.writeFileSync(file, JSON.stringify(record)); fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify(index));
          patchJob(f, original.id, { startedAt: new Date(Date.now() + 60000).toISOString() });
          assert.equal(direct(follow(f, original.threadId, remote), 2).blockers[0].code, "thread_busy");
          patchJob(f, original.id, { startedAt: new Date(Date.now() - 60000).toISOString() });
        }
        const before = requests(f).length;
        json(f.call("result", original.id, "--details"), 1);
        assert.equal(storedJob(f, original.id).recovery.turnStatus, "notStarted");
        if (scenario === "legacy record") assert.equal(requests(f).slice(before).filter(request => request.method === "thread/read").length, 1);
        else {
          assert.equal(original.turnSubmission, null);
          assert.equal(storedJob(f, original.id).recovery.source, "submission-record");
          assert.deepEqual(requests(f).slice(before), [], "a never-submitted job needs no runtime read");
        }
        assert.equal(direct(follow(f, original.threadId)).status, "completed");
      } finally { fs.writeFileSync(stateFile + ".release-start", "release"); keeper?.close(); }
    });
  }

  await t.test("submission write failure sends no turn", () => {
    const f = fixture("task-ok"), preload = path.join(f.dir, "fail-submission.mjs");
    fs.writeFileSync(preload, `import fs from 'node:fs';
      const rename = fs.renameSync;
      fs.renameSync = function(source, target) {
        if (String(target).includes('/jobs/') && String(target).endsWith('.json')) {
          const record = JSON.parse(fs.readFileSync(source, 'utf8'));
          if (record.turnSubmission) throw Object.assign(new Error('injected submission write failure'), { code: 'EIO' });
        }
        return rename.call(this, source, target);
      };`);
    f.env.NODE_OPTIONS = `--import=${preload}`;
    const report = direct(f.call("task", "--fresh", "--direct", "--quiet", "fixture"), 1);
    assert.equal(report.status, "failed");
    assert.equal(storedJob(f, report.jobId).status, "failed");
    assert.equal(storedJob(f, report.jobId).result.turnStatus, "notStarted");
    assert.equal(storedJob(f, report.jobId).turnSubmission, null);
    assert.equal(requests(f).filter(request => request.method === "turn/start").length, 0);
  });
});
