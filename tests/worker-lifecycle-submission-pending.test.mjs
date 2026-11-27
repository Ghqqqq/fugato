import test from 'node:test';
import assert from 'node:assert/strict';
import { lifecycleHarness } from './fake-codex-fixture.mjs';
const {
  fs, path, initGitRepo, resolveStateDir, run, readJobFile, script, alive, fixture, json, direct, waitUntil, patchJob
} = await lifecycleHarness();

const storedJob = (f, id) => readJobFile(path.join(resolveStateDir(f.repo, f.env), "jobs", `${id}.json`));

test("submission records distinguish a dead wrapper's pending start from a never-submitted turn (pending starts)", async t => {
  const { readyBroker, requireLocalSockets } = await import('./helpers.mjs');
  if (!await requireLocalSockets(t)) return;
  const brokerFile = f => path.join(resolveStateDir(f.repo, f.env), "broker.json");
  const requests = f => fs.existsSync(path.join(f.dir, "fake-codex-state.json.requests.jsonl")) ? f.requests() : [];
  const follow = (f, threadId, cwd = f.repo) => run(process.execPath,
    [script, "task", "--thread", threadId, "--sandbox", "read-only", "--direct", "--quiet", "follow up"], { cwd, env: f.env });
  const workspace = f => { const cwd = path.join(f.dir, "other-workspace"); fs.mkdirSync(cwd); initGitRepo(cwd); return cwd; };
  const kill = async pid => { process.kill(pid, "SIGKILL"); await waitUntil(() => !alive(pid)); };

  await t.test("unconfirmed cancellation before acceptance blocks a successor until recovery", async () => {
    const f = fixture("pending-turn-start"), stateFile = path.join(f.dir, "fake-codex-state.json");
    const keeper = await readyBroker(f.repo, f.env);
    try {
      const launch = json(f.call("task", "--fresh", "--detached", "--sandbox", "read-only", "--json", "pending"));
      await waitUntil(() => fs.existsSync(stateFile + ".start-pending"));
      const original = storedJob(f, launch.jobId);
      const cancelled = json(f.call("cancel", original.id, "--json"), 2);
      const stopped = storedJob(f, original.id);
      const successor = JSON.parse(follow(f, original.threadId).stdout.trim().split("\n").at(-1));
      const starts = requests(f).filter(request => request.method === "turn/start").length;
      fs.writeFileSync(stateFile + ".release-start", "release");
      await waitUntil(() => f.state().threads.find(thread => thread.id === original.threadId).turns?.some(turn => turn.status === "completed"));
      json(f.call("status", original.id, "--json"));
      const recovered = storedJob(f, original.id);
      fs.rmSync(stateFile + ".start-pending"); fs.rmSync(stateFile + ".release-start");
      const second = json(f.call("task", "--to", original.id, "--detached", "--sandbox", "read-only", "--json", "second pending"));
      await waitUntil(() => fs.existsSync(stateFile + ".start-pending"));
      const submitted = storedJob(f, second.jobId);
      await kill(submitted.pid);
      // Older recovered records kept the proven handle only in recovery.
      patchJob(f, original.id, { turnId: null });
      const server = f.state();
      server.threads.find(thread => thread.id === original.threadId).turns[0].startedAt = Math.floor(Date.parse(submitted.startedAt) / 1000) - 1;
      fs.writeFileSync(stateFile, JSON.stringify(server));
      fs.writeFileSync(stateFile + ".release-start", "release");
      await waitUntil(() => {
        const turns = f.state().threads.find(thread => thread.id === original.threadId).turns;
        return turns.length === 2 && turns.every(turn => turn.status === "completed");
      });
      json(f.call("status", second.jobId, "--json"));
      const later = storedJob(f, second.jobId);
      patchJob(f, original.id, { turnId: recovered.turnId });
      // Age the killed wrapper's admission lock without a timing-dependent wait.
      const admission = path.join(f.env.CODEX_COMPANION_HOME, "duet", "thread-admission");
      for (const lock of fs.readdirSync(admission)) for (const owner of fs.readdirSync(path.join(admission, lock))) {
        if (owner.startsWith(`owner-${submitted.pid}-`)) fs.utimesSync(path.join(admission, lock, owner), 0, 0);
      }
      const resumed = JSON.parse(f.call("task", "--to", second.jobId, "--direct", "--quiet", "after server completed").stdout.trim().split("\n").at(-1));
      assert.deepEqual({ confirmation: cancelled.confirmation, status: stopped.status,
        submitted: Boolean(stopped.turnSubmission), turnId: stopped.turnId ?? null,
        turnEnded: stopped.result.turnEnded, successor: successor.status, starts,
        resumed: resumed.status, recovered: recovered.recovery?.turnStatus, settled: recovered.result.turnEnded,
        recoveredTurnId: recovered.turnId ?? null, later: [later.turnId ?? null, later.status, later.result?.turnEnded] },
      { confirmation: "unconfirmed", status: "cancelled", submitted: true, turnId: null,
        turnEnded: false, successor: "blocked", starts: 1, resumed: "completed", recovered: "completed", settled: true,
        recoveredTurnId: "turn_1", later: ["turn_2", "completed", true] });
    } finally { fs.writeFileSync(stateFile + ".release-start", "release"); keeper.close(); }
  });

  for (const scenario of ["shared broker", "changed explicit owner", "private runtime", "orphaned runtime"]) {
    await t.test(scenario, async () => {
      const f = fixture("pending-turn-start"), stateFile = path.join(f.dir, "fake-codex-state.json"), remote = workspace(f);
      const keepers = [];
      if (scenario === "private runtime") {
        const preload = path.join(f.dir, "private-runtime.mjs");
        fs.writeFileSync(preload, 'if (process.argv[1]?.endsWith("/app-server-broker.mjs")) process.exit(1);');
        f.env.NODE_OPTIONS = `--import=${preload}`;
      } else keepers.push(await readyBroker(f.repo, f.env));
      if (scenario === "changed explicit owner") {
        keepers.push(await readyBroker(remote, f.env));
        f.env.CODEX_COMPANION_APP_SERVER_ENDPOINT = keepers.at(-1).endpoint;
      }
      const launch = json(f.call("task", "--fresh", "--detached", "--sandbox", "read-only", "--json", "first"));
      try {
        await waitUntil(() => fs.existsSync(stateFile + ".start-pending"));
        const original = storedJob(f, launch.jobId), runtime = f.requests().find(request => request.method === "turn/start").serverId;
        assert.ok(original.threadId && !original.turnId);
        if (scenario === "orphaned runtime") {
          await kill(keepers[0].pid);
          await waitUntil(() => storedJob(f, original.id).status === "failed" && !alive(original.pid));
          assert.equal(storedJob(f, original.id).result.failureSource, "transport");
          assert.equal(storedJob(f, original.id).result.turnEnded, false);
        } else await kill(original.pid);
        assert.ok(alive(runtime));
        if (scenario === "private runtime") assert.equal(fs.existsSync(brokerFile(f)), false);
        // Age the wrapper beyond the legacy settle window without sleeping.
        patchJob(f, original.id, { startedAt: new Date(Date.now() - 60000).toISOString() });
        if (scenario === "changed explicit owner") {
          assert.equal(direct(follow(f, original.threadId), 2).blockers[0].code, "thread_busy");
          f.env.CODEX_COMPANION_APP_SERVER_ENDPOINT = "";
        }
        f.call("result", original.id, "--details");
        const unresolved = storedJob(f, original.id);
        assert.equal(unresolved.recovered ?? false, false);
        assert.equal(unresolved.turnResolution, "unknown");
        assert.equal(direct(follow(f, original.threadId), 2).blockers[0].code, "thread_busy");
        assert.equal(direct(follow(f, original.threadId, remote), 2).blockers[0].code, "thread_busy");
        assert.equal(f.requests().filter(request => request.method === "turn/start").length, 1);
        assert.equal(original.turnSubmission.threadId, original.threadId);
        assert.equal(original.turnSubmission.transport, scenario === "private runtime" ? "direct" : "broker");
        assert.ok(Number.isFinite(Date.parse(original.turnSubmission.at)));

        fs.writeFileSync(stateFile + ".release-start", "release");
        await waitUntil(() => f.state().threads.find(thread => thread.id === original.threadId).turns?.some(turn => turn.status === "completed"));
        assert.equal(json(f.call("result", original.id, "--details")).status, "completed");
        assert.equal(storedJob(f, original.id).recovery.turnStatus, "completed");
        assert.equal(direct(f.call("task", "--to", original.id, "--direct", "--quiet", "after recovery")).status, "completed");
        assert.equal(f.requests().filter(request => request.method === "turn/start").length, 2);
      } finally { fs.writeFileSync(stateFile + ".release-start", "release"); for (const keeper of keepers) keeper.close(); }
    });
  }
});
