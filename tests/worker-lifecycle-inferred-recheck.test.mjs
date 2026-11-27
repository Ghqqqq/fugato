import test from 'node:test';
import assert from 'node:assert/strict';
import { lifecycleHarness } from './fake-codex-fixture.mjs';
const {
  fs, path, resolveStateDir, delay, run, readJobFile, script, alive, fixture, json, direct, patchJob
} = await lifecycleHarness();

const storedJob = (f, id) => readJobFile(path.join(resolveStateDir(f.repo, f.env), "jobs", `${id}.json`));

async function until(check, timeout = 15000) {
  for (const end = Date.now() + timeout; Date.now() < end;) {
    const result = check();
    if (result) return result;
    await delay(50);
  }
  throw new Error("Backpressure fixture deadline expired");
}

test("automatic inferred-turn recheck reconciles without a command and remains bounded", { concurrency: 5 }, async t => {
  // The broker intentionally waits four seconds before retiring an abandoned
  // stream with no terminal notification. Recheck after that existing grace.
  const launch = (allowInterrupt, initial = "6000", retry = "7000", holdRead = false) => {
    const f = fixture("inferred-final:running", holdRead ? { mutable: true } : undefined);
    Object.assign(f.env, { CODEX_COMPANION_INFERRED_RECHECK_MS: initial, CODEX_COMPANION_INFERRED_RECHECK_RETRY_MS: retry });
    if (holdRead) {
      const binary = path.join(f.dir, "codex"), source = fs.readFileSync(binary, "utf8"), branch = 'case "thread/read": {';
      assert.ok(source.includes(branch));
      fs.writeFileSync(binary, source.replace(branch, `${branch}
        if (fs.existsSync(STATE_PATH + '.hold-read')) {
          fs.writeFileSync(STATE_PATH + '.read-held', '');
          while (!fs.existsSync(STATE_PATH + '.release-read')) await new Promise(resolve => setTimeout(resolve, 20));
        }
      `));
    }
    assert.equal(run(process.execPath, [path.join(f.dir, "codex"), "app-server"], { cwd: f.repo, env: f.env, input: "" }).status, 0);
    fs.writeFileSync(path.join(f.dir, "fake-codex-state.json"), JSON.stringify({ ...f.state(), allowInterrupt }));
    const first = direct(f.call("task", "--fresh", "--direct", "--quiet", "fixture"));
    const original = storedJob(f, first.jobId);
    assert.equal(original.result.inferredCompletion, true);
    assert.equal(original.result.turnEnded, false, "report returns before reconciliation");
    return { f, original };
  };
  const helper = (f, id) => f.call("inferred-turn-recheck", id, "--cwd", f.repo);
  const quiet = result => { assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, ""); assert.equal(result.stderr, ""); };
  const reads = f => f.requests().filter(request => request.method === "thread/read");
  const bytes = (f, id) => {
    const record = storedJob(f, id);
    return [path.join(resolveStateDir(f.repo, f.env), "jobs", `${id}.json`), path.join(resolveStateDir(f.repo, f.env), "state.json"),
      record.rawOutputFile, record.resultFile, record.logFile].map(file => [fs.readFileSync(file, "utf8"), fs.statSync(file).mtimeMs]);
  };

  await Promise.all([
    t.test("broker interruption after the answer is recovered automatically; duplicates do nothing", async () => {
      const { f, original } = launch(true);
      // Only observe files from here through recovery: no status, wait, result,
      // maintenance or follow-up command can perform the reconciliation for us.
      const resolved = await until(() => {
        const current = storedJob(f, original.id);
        return current.recovery?.status === "recovered" && current;
      }, 12000);
      assert.equal(resolved.status, "completed");
      assert.equal(resolved.result.turnEnded, true);
      assert.equal(resolved.recovery.turnStatus, "interrupted");
      assert.deepEqual([resolved.recovery.threadId, resolved.recovery.turnId], [original.threadId, original.turnId]);
      assert.equal(resolved.result.rawOutput, original.result.rawOutput);
      assert.equal(JSON.parse(fs.readFileSync(resolved.resultFile)).recovery.status, "recovered");
      assert.equal(f.requests().filter(request => request.method === "turn/start").length, 1);
      const interrupts = f.requests().filter(request => request.method === "turn/interrupt");
      assert.ok(interrupts.length >= 1);
      const serverId = f.requests().find(request => request.method === "turn/start").serverId;
      assert.ok(interrupts.every(request => request.serverId === serverId), "only the original broker interrupts, including its shutdown cleanup");
      assert.ok(interrupts.every(request => request.params.threadId === original.threadId && request.params.turnId === original.turnId));
      assert.equal(reads(f).length, 2, "confirmation plus one automatic recheck");
      assert.ok(reads(f).every(request => request.params.threadId === original.threadId && request.params.includeTurns));
      await until(() => !alive(resolved.inferredRecheck.pid));
      const before = bytes(f, original.id), requestsBefore = f.requests();
      quiet(helper(f, original.id)); quiet(helper(f, original.id));
      assert.deepEqual(bytes(f, original.id), before, "already recovered jobs receive no writes");
      assert.deepEqual(f.requests(), requestsBefore);
    }),

    t.test("a busy broker rechecks privately and retries an unreachable read", async t => {
      const { readyBroker, requireLocalSockets } = await import("./helpers.mjs");
      if (!await requireLocalSockets(t)) return;
      const f = fixture("inferred-final:unreadable");
      // Keep the broker alive while sibling subtests run synchronous CLI launches.
      Object.assign(f.env, {
        CODEX_COMPANION_BROKER_IDLE_SEC: "15",
        CODEX_COMPANION_INFERRED_RECHECK_MS: "100",
        CODEX_COMPANION_INFERRED_RECHECK_RETRY_MS: "2000"
      });
      // Pin the shared broker so the abandoned stream keeps refusing other clients' reads.
      const broker = await readyBroker(f.repo, f.env);
      t.after(broker.close);
      const brokerServerPid = f.state().launches.at(-1).pid;
      const { jobId } = json(f.call("task", "--fresh", "--detached", "--json", "fixture"));
      const original = await until(() => {
        const job = storedJob(f, jobId);
        return job.status === "completed" && job;
      });
      assert.equal(original.result.inferredCompletion, true);
      assert.equal(original.result.turnEnded, false);

      const recovery = await until(() => storedJob(f, jobId).recovery);
      assert.equal(recovery.status, "unreachable");
      assert.equal(recovery.detail, "Fixture turn unavailable");
      fs.writeFileSync(path.join(f.dir, "fake-codex-state.json"), JSON.stringify({ ...f.state(), confirmationMode: "completed" }));
      await until(() => !alive(storedJob(f, jobId).inferredRecheck.pid));
      const resolved = storedJob(f, jobId);
      assert.equal(resolved.recovery.status, "recovered");
      assert.equal(resolved.status, "completed");
      assert.equal(resolved.result.turnEnded, true);
      assert.equal(resolved.result.rawOutput, original.result.rawOutput);
      const checks = reads(f);
      assert.equal(checks.length, 3, "confirmation plus two automatic reads");
      assert.equal(checks[0].serverId, brokerServerPid);
      assert.ok(checks.slice(1).every(read => read.serverId !== brokerServerPid && read.params.threadId === original.threadId));
      assert.equal(f.requests().filter(request => request.method === "turn/start").length, 1);
    }),

    t.test("a still-running turn stops after two attempts", async () => {
      const terminal = false;
      const { f, original } = launch(false, "6000", "250");
      const claimed = await until(() => storedJob(f, original.id).inferredRecheck?.pid && storedJob(f, original.id));
      const before = bytes(f, original.id), requestsBefore = f.requests();
      quiet(helper(f, original.id));
      assert.deepEqual(bytes(f, original.id), before, "a duplicate helper cannot claim the scheduled job");
      assert.deepEqual(f.requests(), requestsBefore);
      await until(() => storedJob(f, original.id).recovery?.status === "running");
      await until(() => !alive(claimed.inferredRecheck.pid));
      const resolved = storedJob(f, original.id);
      assert.equal(resolved.recovery.status, terminal ? "recovered" : "running");
      assert.equal(resolved.status, "completed");
      assert.equal(resolved.result.turnEnded, terminal);
      assert.equal(reads(f).length, 3, "confirmation plus exactly two automatic checks");
      const finished = bytes(f, original.id);
      quiet(helper(f, original.id));
      assert.deepEqual(bytes(f, original.id), finished, "an exhausted helper is never restarted");
      assert.equal(reads(f).length, 3);
    }),

    t.test("a stop recorded during the exact-turn read prevents helper writes", async () => {
      const { f, original } = launch(true, "6000", "250", true);
      const statePath = path.join(f.dir, "fake-codex-state.json");
      fs.writeFileSync(statePath + ".hold-read", "");
      await until(() => fs.existsSync(statePath + ".read-held"));
      patchJob(f, original.id, { cancelRequested: { reason: "cancelled_by_user" } });
      const before = bytes(f, original.id), pid = storedJob(f, original.id).inferredRecheck.pid;
      fs.writeFileSync(statePath + ".release-read", "");
      await until(() => !alive(pid));
      assert.deepEqual(bytes(f, original.id), before, "helper revalidates under the terminal commit lock");
      assert.equal(reads(f).length, 2);
    }),

    t.test("terminal commits exclude confirmed, non-inferred, cancelled, stopped and review jobs; spawn errors stay optional", () => {
      const f = fixture();
      const result = json(run(process.execPath, ["--input-type=module", "-e", `
        import fs from 'node:fs';
        import cp from 'node:child_process';
        import { syncBuiltinESMExports } from 'node:module';
        import { runTrackedJob } from ${JSON.stringify(new URL('../plugins/codex/scripts/lib/tracked-jobs.mjs', import.meta.url).href)};
        import { readJobFile, resolveJobFile } from ${JSON.stringify(new URL('../plugins/codex/scripts/lib/state.mjs', import.meta.url).href)};
        const spawns = [], committed = [], records = [], fallbacks = [];
        const spawnSync = cp.spawnSync;
        let unrefs = 0, fault = null;
        cp.spawnSync = (command, args, options) => {
          if (command !== process.execPath || args[0] !== '--input-type=module') return spawnSync(command, args, options);
          const target = JSON.parse(args.at(-1));
          spawns.push({ command: target.command, args: target.args, detached: target.options.detached,
            stdio: target.options.stdio, home: options.env.CODEX_COMPANION_HOME });
          committed.push(readJobFile(resolveJobFile(process.cwd(), target.args[2])).status);
          if (fault) throw new Error('fixture launcher failure');
          return { status: 0, stdout: '123456\\n' };
        };
        cp.spawn = (command, args) => {
          fallbacks.push(args[2]);
          if (fault === 'sync') throw new Error('fixture fallback failure');
          return { pid: process.pid, once() {}, unref: () => { unrefs++; } };
        };
        syncBuiltinESMExports();
        const cases = [
          { id: 'confirmed', payload: { turnEnded: true } },
          { id: 'cancel-intent', job: { cancelRequested: { reason: 'cancelled_by_user' } } },
          { id: 'review', job: { jobClass: 'review' } },
          { id: 'eligible' }, { id: 'eligible' }, { id: 'sync-failure', fault: 'sync' }, { id: 'launcher-fallback', fault: 'fallback' }
        ];
        for (const item of cases) {
          fault = item.fault;
          const tracked = { id: item.id, jobClass: 'task', workspaceRoot: process.cwd(), backgroundTerminals: {},
            logFile: process.cwd() + '/' + item.id + '.log', rawOutputFile: process.cwd() + '/' + item.id + '.txt',
            resultFile: process.cwd() + '/' + item.id + '.json', ...item.job };
          const execution = { exitStatus: 0, jobStatus: item.status ?? 'completed', threadId: 'thread', turnId: 'turn',
            payload: { status: 0, rawOutput: 'captured answer', inferredCompletion: true, turnEnded: false, ...item.payload },
            report: { status: item.status ?? 'completed', ...item.report } };
          const returned = await runTrackedJob(tracked, async () => execution);
          records.push({ id: item.id, returned: returned === execution, job: readJobFile(resolveJobFile(process.cwd(), item.id)) });
        }
        console.log(JSON.stringify({ spawns, committed, unrefs, records, fallbacks }));
      `], { cwd: f.repo, env: f.env }));
      assert.equal(result.spawns.length, 3, "one eligible launch and two injected launcher failures; no duplicate or excluded launches");
      assert.deepEqual(result.committed, ["completed", "completed", "completed"]);
      assert.deepEqual(result.fallbacks, ["sync-failure", "launcher-fallback"]);
      assert.equal(result.unrefs, 1, "spawnDetached owns unref for its successful fallback");
      for (const spawn of result.spawns) {
        assert.equal(spawn.command, process.execPath);
        assert.deepEqual(spawn.args, [script, "inferred-turn-recheck", spawn.args[2], "--cwd", f.repo]);
        assert.equal(spawn.detached, true); assert.deepEqual(spawn.stdio, ["ignore", "ignore", "ignore"]); assert.equal(spawn.home, f.env.CODEX_COMPANION_HOME);
      }
      for (const record of result.records) {
        assert.equal(record.returned, true);
        assert.equal(Boolean(record.job.inferredRecheck), ["eligible", "sync-failure", "launcher-fallback"].includes(record.id), record.id);
      }
      assert.equal(storedJob(f, "sync-failure").status, "completed");
      assert.equal(storedJob(f, "launcher-fallback").status, "completed");
    }),
  ]);
});
