import "./test-environment.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildEnv } from "./fake-codex-fixture.mjs";
import { installFakeAntigravity } from "./fake-antigravity-fixture.mjs";
import { initGitRepo, makeTempDir, writeExecutable } from "./helpers.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";
import { parseActionApprovalAnswer, actionApprovalOptions, jobGrantOption } from "../plugins/codex/scripts/lib/server-requests.mjs";
import { register as registerPlugin } from "../plugins/codex/hooks/register.mjs";
import { isValidActionApprovalAnswer } from "../plugins/codex/hooks/native-agent.mjs";

const plugin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", "codex");
const script = path.join(plugin, "scripts", "codex-companion.mjs");

function cliFixture(t, options = "grant-sequence") {
  const dir = makeTempDir("agy-grants-"), repo = path.join(dir, "repo");
  fs.mkdirSync(repo); initGitRepo(repo);
  const acp = installFakeAntigravity(dir, options);
  const codexTrap = path.join(dir, "codex-trap");
  writeExecutable(codexTrap, "#!/usr/bin/env node\nprocess.exit(97);\n");
  const env = {
    ...buildEnv(dir),
    FUGATO_ANTIGRAVITY_BIN: acp.binary,
    CODEX_COMPANION_BIN: codexTrap,
    CODEX_COMPANION_HOME: path.join(dir, "isolated"),
    CLAUDE_PLUGIN_DATA: path.join(dir, "data"),
    CODEX_COMPANION_SESSION_ID: "agy-grants-session"
  };
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const invoke = (args, input) => spawnSync(process.execPath, [script, ...args], {
    cwd: repo, env, input, encoding: "utf8", timeout: 30000, killSignal: "SIGKILL"
  });
  const stored = id => JSON.parse(fs.readFileSync(path.join(resolveStateDir(repo, env), "jobs", `${id}.json`), "utf8"));
  return { dir, repo, env, acp, invoke, call: (...args) => invoke(args), stored };
}

function json(result, status = 0) {
  assert.equal(result.status, status, `${result.error?.message ?? ""}\n${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}

test("parseActionApprovalAnswer and isValidActionApprovalAnswer accept only exact allowed forms", () => {
  const opts3 = actionApprovalOptions("node --test");
  const opts2 = actionApprovalOptions();
  assert.deepEqual(opts3, ["Allow once", 'Allow "node --test" for this job', "Deny"]);
  assert.deepEqual(opts2, ["Allow once", "Deny"]);
  assert.equal(jobGrantOption("git diff"), 'Allow "git diff" for this job');

  assert.deepEqual(parseActionApprovalAnswer("Allow once", opts3), { valid: true, decision: "once" });
  assert.deepEqual(parseActionApprovalAnswer('Allow "node --test" for this job', opts3), { valid: true, decision: "job_grant" });
  assert.deepEqual(parseActionApprovalAnswer("Deny", opts3), { valid: true, decision: "deny" });
  assert.deepEqual(parseActionApprovalAnswer("Deny: use workspace_grep instead", opts3), {
    valid: true, decision: "deny", guidance: "use workspace_grep instead"
  });
  assert.deepEqual(parseActionApprovalAnswer(`Deny: ${"g".repeat(1000)}`, opts3), {
    valid: true, decision: "deny", guidance: "g".repeat(1000)
  });

  const invalidForBoth = [
    "yes", "Allow", "allow once", "deny", "Deny:", "Deny:   ",
    "deny: use workspace_grep", "Deny use workspace_grep",
    `Deny: ${"g".repeat(1001)}`,
    'Allow "git diff" for this job',
    'Allow "node --test" for this job.'
  ];
  for (const input of invalidForBoth) {
    assert.deepEqual(parseActionApprovalAnswer(input, opts3), { valid: false, decision: "deny" }, input);
    assert.equal(isValidActionApprovalAnswer(input.trim(), opts3), false, input);
  }
  assert.deepEqual(parseActionApprovalAnswer('Allow "node --test" for this job', opts2), { valid: false, decision: "deny" });
  assert.equal(isValidActionApprovalAnswer('Allow "node --test" for this job', opts2), false);
  assert.equal(isValidActionApprovalAnswer("Allow once", opts2), true);
  assert.equal(isValidActionApprovalAnswer("Deny", opts2), true);
  assert.equal(isValidActionApprovalAnswer("Deny: use workspace_grep instead", opts2), true);
  assert.equal(isValidActionApprovalAnswer('Allow "node --test" for this job', opts3), true);
});

test("scoped job grant offers three options, auto-allows matching later command, and still parks unsafe chain with two options", t => {
  const f = cliFixture(t, "grant-sequence");
  const launch = json(f.call("task", "--backend", "antigravity", "--detached", "--json", "Run tests."));

  const first = json(f.call("wait", launch.jobId, "--owner", launch.ownerId, "--json"));
  assert.equal(first.status, "needs_answer");
  assert.match(first.question.text, /node --test tests\/a\.test\.mjs/);
  assert.deepEqual(first.question.options, ["Allow once", 'Allow "node --test" for this job', "Deny"]);

  json(f.invoke(["answer", launch.jobId, "--question", first.question.id, "--owner", launch.ownerId, "--json"], 'Allow "node --test" for this job'));

  // Command #2 (node --test tests/b.test.mjs) must auto-allow without parking.
  // The next parked question must be command #3 (node --test a.mjs && rm -rf /) with only 2 options.
  const next = json(f.call("wait", launch.jobId, "--owner", launch.ownerId, "--json"));
  assert.equal(next.status, "needs_answer");
  assert.match(next.question.text, /node --test a\.mjs && rm -rf \//);
  assert.deepEqual(next.question.options, ["Allow once", "Deny"]);

  json(f.invoke(["answer", launch.jobId, "--question", next.question.id, "--owner", launch.ownerId, "--json"], "Deny"));
  const done = f.call("wait", launch.jobId, "--owner", launch.ownerId, "--json");
  assert.equal(done.status, 2, done.stderr + done.stdout);

  const responses = f.acp.state().serverResponses.map(r => r.result.outcome.optionId);
  assert.deepEqual(responses, ["allow", "allow", "deny"]);

  const job = f.stored(launch.jobId);
  const autoAllowed = (job.activity ?? []).filter(ev => ev.type === "permissionAutoAllowed");
  assert.deepEqual(autoAllowed.map(ev => ev.text), ["job grant auto-allowed: node --test"]);
  const executed = job.result.commandExecutions.map(c => c.command);
  assert.ok(executed.includes("node --test tests/a.test.mjs"), JSON.stringify(executed));
  assert.ok(executed.includes("node --test tests/b.test.mjs"), JSON.stringify(executed));
  assert.equal(executed.includes("node --test a.mjs && rm -rf /"), false, JSON.stringify(executed));
  assert.equal(fs.existsSync(path.join(f.env.CODEX_COMPANION_HOME, "duet", "config.toml")), false);
  assert.equal("jobGrants" in job, false);
});

test("a granted prefix never auto-allows a different prefix or a path escaping cwd", async t => {
  await t.test("different allowlisted prefix still parks with three options", () => {
    const f = cliFixture(t, "grant-cross-prefix");
    const launch = json(f.call("task", "--backend", "antigravity", "--detached", "--json", "Run two prefixes."));
    const q1 = json(f.call("wait", launch.jobId, "--owner", launch.ownerId, "--json"));
    assert.deepEqual(q1.question.options, ["Allow once", 'Allow "node --test" for this job', "Deny"]);
    json(f.invoke(["answer", launch.jobId, "--question", q1.question.id, "--owner", launch.ownerId, "--json"], 'Allow "node --test" for this job'));

    const q2 = json(f.call("wait", launch.jobId, "--owner", launch.ownerId, "--json"));
    assert.equal(q2.status, "needs_answer");
    assert.match(q2.question.text, /git diff --stat/);
    assert.deepEqual(q2.question.options, ["Allow once", 'Allow "git diff" for this job', "Deny"]);
    json(f.invoke(["answer", launch.jobId, "--question", q2.question.id, "--owner", launch.ownerId, "--json"], "Allow once"));
    const done = json(f.call("wait", launch.jobId, "--owner", launch.ownerId, "--json"));
    assert.equal(done.status, "completed");
    assert.deepEqual((f.stored(launch.jobId).activity ?? []).filter(ev => ev.type === "permissionAutoAllowed"), []);
  });

  await t.test("same leading tokens with escaping path parks with only two options", () => {
    const f = cliFixture(t, "grant-escape-after-grant");
    const launch = json(f.call("task", "--backend", "antigravity", "--detached", "--json", "Run escape check."));
    const q1 = json(f.call("wait", launch.jobId, "--owner", launch.ownerId, "--json"));
    assert.deepEqual(q1.question.options, ["Allow once", 'Allow "node --test" for this job', "Deny"]);
    json(f.invoke(["answer", launch.jobId, "--question", q1.question.id, "--owner", launch.ownerId, "--json"], 'Allow "node --test" for this job'));

    const q2 = json(f.call("wait", launch.jobId, "--owner", launch.ownerId, "--json"));
    assert.equal(q2.status, "needs_answer");
    assert.match(q2.question.text, /\.\.\/outside\.test\.mjs/);
    assert.deepEqual(q2.question.options, ["Allow once", "Deny"]);
    json(f.invoke(["answer", launch.jobId, "--question", q2.question.id, "--owner", launch.ownerId, "--json"], "Deny"));
    const done = f.call("wait", launch.jobId, "--owner", launch.ownerId, "--json");
    assert.equal(done.status, 2);
    assert.deepEqual(f.acp.state().serverResponses.map(r => r.result.outcome.optionId), ["allow", "deny"]);
  });
});

test("job grants do not carry over into a continuation job or a new job", t => {
  const f = cliFixture(t, "grant-single-test");
  const firstLaunch = json(f.call("task", "--backend", "antigravity", "--detached", "--json", "First job."));
  const q1 = json(f.call("wait", firstLaunch.jobId, "--owner", firstLaunch.ownerId, "--json"));
  assert.equal(q1.status, "needs_answer");
  assert.deepEqual(q1.question.options, ["Allow once", 'Allow "node --test" for this job', "Deny"]);
  json(f.invoke(["answer", firstLaunch.jobId, "--question", q1.question.id, "--owner", firstLaunch.ownerId, "--json"], 'Allow "node --test" for this job'));
  const firstDone = json(f.call("wait", firstLaunch.jobId, "--owner", firstLaunch.ownerId, "--json"));
  assert.equal(firstDone.status, "completed");

  // Continuation job (--continue) must NOT inherit the in-memory grant.
  const contLaunch = json(f.call("task", "--continue", firstLaunch.jobId, "--detached", "--json", "Continue job."));
  const qCont = json(f.call("wait", contLaunch.jobId, "--owner", contLaunch.ownerId, "--json"));
  assert.equal(qCont.status, "needs_answer");
  assert.deepEqual(qCont.question.options, ["Allow once", 'Allow "node --test" for this job', "Deny"]);
  json(f.invoke(["answer", contLaunch.jobId, "--question", qCont.question.id, "--owner", contLaunch.ownerId, "--json"], "Allow once"));
  const contDone = json(f.call("wait", contLaunch.jobId, "--owner", contLaunch.ownerId, "--json"));
  assert.equal(contDone.status, "completed");
  assert.deepEqual((f.stored(contLaunch.jobId).activity ?? []).filter(ev => ev.type === "permissionAutoAllowed"), []);

  // Fresh job must NOT inherit the in-memory grant either.
  const freshLaunch = json(f.call("task", "--backend", "antigravity", "--detached", "--json", "New job."));
  const qFresh = json(f.call("wait", freshLaunch.jobId, "--owner", freshLaunch.ownerId, "--json"));
  assert.equal(qFresh.status, "needs_answer");
  assert.deepEqual(qFresh.question.options, ["Allow once", 'Allow "node --test" for this job', "Deny"]);
  json(f.invoke(["answer", freshLaunch.jobId, "--question", qFresh.question.id, "--owner", freshLaunch.ownerId, "--json"], "Allow once"));
  const freshDone = json(f.call("wait", freshLaunch.jobId, "--owner", freshLaunch.ownerId, "--json"));
  assert.equal(freshDone.status, "completed");
  assert.deepEqual((f.stored(freshLaunch.jobId).activity ?? []).filter(ev => ev.type === "permissionAutoAllowed"), []);
  assert.equal(fs.existsSync(path.join(f.env.CODEX_COMPANION_HOME, "duet", "config.toml")), false);
});

test("fugato answer handles Deny: <guidance>, plain Deny, Allow once, and rejects invalid text as deny", async t => {
  const cases = [
    ["guided deny", "Deny: use workspace_grep instead", "deny", "use workspace_grep instead"],
    ["plain deny", "Deny", "deny", undefined],
    ["allow once", "Allow once", "allow", undefined],
    ["yes is denied", "yes", "deny", undefined],
    ["Allow is denied", "Allow", "deny", undefined],
    ["empty Deny: is denied without guidance", "Deny:", "deny", undefined],
    ["blank Deny: is denied without guidance", "Deny:   ", "deny", undefined],
    ["overlong guidance is denied without guidance", `Deny: ${"x".repeat(1001)}`, "deny", undefined],
    ["wrong grant prefix is denied", 'Allow "git diff" for this job', "deny", undefined]
  ];
  for (const [label, answerText, expectedOutcome, expectedGuidance] of cases) {
    await t.test(label, () => {
      const f = cliFixture(t, "grant-single-test");
      const launch = json(f.call("task", "--backend", "antigravity", "--detached", "--json", label));
      const pending = json(f.call("wait", launch.jobId, "--owner", launch.ownerId, "--json"));
      assert.equal(pending.status, "needs_answer");
      json(f.invoke(["answer", launch.jobId, "--question", pending.question.id, "--owner", launch.ownerId, "--json"], answerText));
      const waited = f.call("wait", launch.jobId, "--owner", launch.ownerId, "--json");
      assert.equal(waited.status, expectedOutcome === "allow" ? 0 : 2, waited.stderr + waited.stdout);
      assert.deepEqual(f.acp.state().serverResponses.map(r => r.result.outcome.optionId), [expectedOutcome]);
      const job = f.stored(launch.jobId);
      if (expectedOutcome === "allow") {
        assert.equal(job.status, "completed");
        assert.deepEqual(job.result.blockers, []);
      } else {
        assert.equal(job.status, "blocked");
        assert.equal(job.result.blockers[0].code, "approval_denied");
        assert.equal(job.report.blockers[0].code, "approval_denied");
        if (expectedGuidance !== undefined) {
          assert.equal(job.result.blockers[0].guidance, expectedGuidance);
          assert.equal(job.report.blockers[0].guidance, expectedGuidance);
          const details = json(f.call("result", launch.jobId, "--details"), 2);
          assert.equal(details.blockers[0].guidance, expectedGuidance);
        } else {
          assert.equal("guidance" in job.result.blockers[0], false);
          assert.equal("guidance" in job.report.blockers[0], false);
        }
      }
    });
  }
});

// Minimal host harness exercising the real native-agent.mjs hooks against the real companion CLI.
function nativeHarness(t, acpBehavior) {
  const dir = makeTempDir("agy-native-grants-"), repo = path.join(dir, "repo"), home = path.join(dir, "home");
  fs.mkdirSync(repo); fs.mkdirSync(home); initGitRepo(repo);
  const acp = installFakeAntigravity(dir, acpBehavior);
  const env = {
    ...buildEnv(dir), HOME: home, USERPROFILE: home,
    FUGATO_ANTIGRAVITY_BIN: acp.binary,
    CODEX_COMPANION_BIN: path.join(dir, "missing-codex"),
    CODEX_COMPANION_HOME: path.join(dir, "isolated"),
    CLAUDE_PLUGIN_DATA: path.join(dir, "data"),
    CODEX_COMPANION_TEST_MODE: "1"
  };
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Map(), hooks = new Map(), controller = new AbortController();
  const agents = [{ id: "gemini-1", type: "fugato:gemini-native", name: "GeminiGrant", status: "running" }];
  const clone = value => JSON.parse(JSON.stringify(value));
  const $ = {
    plugin: { name: "fugato", root: plugin },
    session: {
      id: async () => "native-grant-session",
      cwd: async () => repo,
      root: async () => repo,
      append: async () => ({ uuid: "u-1" })
    },
    agent: { list: async () => agents },
    state: {
      get: async () => ({ version: 0 }),
      set: async () => ({ isSet: true, version: 1 })
    },
    settings: { read: async () => ({}) },
    command: { list: async () => [] },
    store: {
      get: async key => (store.has(key) ? clone(store.get(key)) : undefined),
      keys: async () => [...store.keys()],
      delete: async key => { store.delete(key); },
      set: async (key, value) => { store.set(key, clone(value)); }
    },
    env: { get: async key => env[key], set: async (key, value) => { env[key] = value; } },
    fs: {
      exists: async target => fs.existsSync(target),
      stat: async target => {
        const s = fs.statSync(target);
        return { kind: s.isDirectory() ? "dir" : "file", size: s.size, mtimeMs: s.mtimeMs, realPath: fs.realpathSync(target) };
      }
    },
    ui: { invalidate() {}, log() {} },
    clock: {
      now: async () => Date.now(),
      every: () => ({ cancel() {} }),
      after: () => ({ cancel() {} })
    },
    process: {
      run: async (argv, init = {}) => {
        const res = spawnSync(argv[0], argv.slice(1), {
          cwd: init.cwd || repo, env: { ...env, ...(init.env || {}) }, input: init.stdin, encoding: "utf8", timeout: init.timeoutMs || 15000
        });
        return { exitCode: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "", isStdoutTruncated: false, isStderrTruncated: false };
      },
      spawn: request => {
        let settle, fail;
        const result = new Promise((resolve, reject) => { settle = resolve; fail = reject; });
        result.catch(() => {});
        async function* stream() {
          const child = spawn(request.argv[0], request.argv.slice(1), {
            cwd: request.cwd || repo, env: { ...env, ...(request.env || {}) }, stdio: ["pipe", "pipe", "pipe"]
          });
          const queue = []; let wake, ended = false, error, exit = { code: null, signal: null };
          const push = chunk => { queue.push(chunk); wake?.(); wake = null; };
          child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
          child.stdout.on("data", text => push({ stream: "stdout", text }));
          child.stderr.on("data", text => push({ stream: "stderr", text }));
          child.on("error", err => { error = err; ended = true; wake?.(); wake = null; });
          child.on("close", (code, signal) => { exit = { code, signal }; ended = true; wake?.(); wake = null; });
          child.stdin.end(request.input ?? "");
          try {
            while (!ended || queue.length) {
              if (!queue.length) { await new Promise(resolve => { wake = resolve; }); continue; }
              yield queue.shift();
            }
            if (error) throw error;
            settle(exit);
            return exit;
          } catch (err) { fail(err); throw err; }
        }
        return Object.assign(stream(), { result });
      }
    }
  };
  const on = (name, matcher, handler) => {
    const fn = typeof matcher === "function" ? matcher : handler;
    const list = hooks.get(name) ?? [];
    list.push(fn);
    hooks.set(name, list);
    return { catch() {} };
  };
  registerPlugin(on);
  const invoke = async (name, event, next) => {
    const fns = hooks.get(name) ?? [];
    let current = Object.assign(next, { signal: controller.signal });
    for (let i = fns.length - 1; i >= 0; i--) {
      const fn = fns[i], down = current;
      current = Object.assign(ev => fn($, ev, down), { signal: controller.signal });
    }
    return current(event);
  };
  let turnNum = 0;
  const runTurn = async text => {
    const turnId = `turn-${++turnNum}`;
    if (turnNum === 1) {
      await invoke("agent.spawn", {
        tool_use_id: "spawn-1", prompt: text, description: "Native grant test",
        subagentType: "fugato:gemini-native", provider: { plugin: "fugato", tier: "user" },
        parentModel: "haiku", background: true, permissionMode: "default", fork: false,
        name: "GeminiGrant", cwd: repo
      }, async () => ({ model: "haiku", agentId: "gemini-1" }));
    }
    agents[0].status = "running";
    await invoke("turn.start", { agentId: "gemini-1", turnId, text }, async e => ({ turnId: e.turnId }));
    const stream = await invoke("turn.step", { agentId: "gemini-1", turnId, index: 0, model: "haiku", effort: "low", messageCount: 1 }, async function* () {
      assert.fail("native hook must handle the turn");
    });
    let item;
    do { item = await stream.next(); } while (!item.done);
    await invoke("turn.complete", { agentId: "gemini-1", turnId, answer: item.value.answer, durationMs: 1, isAborted: false, reason: "answer" }, async e => ({ text: e.answer }));
    agents[0].status = "completed";
    return JSON.parse(item.value.answer);
  };
  const stored = id => JSON.parse(fs.readFileSync(path.join(resolveStateDir(repo, env), "jobs", `${id}.json`), "utf8"));
  return { dir, repo, env, acp, runTurn, stored };
}

test("native adapter validator accepts Deny: <guidance> and job grants while refusing invalid answers", async t => {
  await t.test("refuses invalid bodies and accepts Deny: <guidance> with recorded blocker guidance", async () => {
    const h = nativeHarness(t, "grant-single-test");
    const q = await h.runTurn("Run one test command.");
    assert.equal(q.status, "needs_answer");
    assert.deepEqual(q.question.options, ["Allow once", 'Allow "node --test" for this job', "Deny"]);
    assert.match(q.next, /Allow "node --test" for this job/);
    assert.match(q.next, /Deny: <guidance>/);

    for (const bad of ["yes", "Allow", "Deny:", "Deny:   ", 'Allow "git diff" for this job', `Deny: ${"z".repeat(1001)}`]) {
      const refused = await h.runTurn(`Answer ${q.question.id}\n${bad}`);
      assert.equal(refused.status, "needs_answer", bad);
      assert.equal(refused.question.id, q.question.id, bad);
      assert.ok(refused.notice, bad);
    }
    assert.deepEqual(h.acp.state().serverResponses, []);

    const denied = await h.runTurn(`Answer ${q.question.id}\nDeny: use workspace_grep instead`);
    assert.equal(denied.status, "blocked");
    assert.equal(denied.blockers[0].code, "approval_denied");
    assert.deepEqual(h.acp.state().serverResponses.map(r => r.result.outcome.optionId), ["deny"]);
    const job = h.stored(q.jobId);
    assert.equal(job.result.blockers[0].guidance, "use workspace_grep instead");
    assert.equal(job.report.blockers[0].guidance, "use workspace_grep instead");
  });

  await t.test("accepts displayed job-grant option, auto-allows match, and refuses grant answer on two-option card", async () => {
    const h = nativeHarness(t, "grant-sequence");
    const q1 = await h.runTurn("Run sequence.");
    assert.equal(q1.status, "needs_answer");
    assert.deepEqual(q1.question.options, ["Allow once", 'Allow "node --test" for this job', "Deny"]);

    const q3 = await h.runTurn(`Answer ${q1.question.id}\nAllow "node --test" for this job`);
    assert.equal(q3.status, "needs_answer");
    assert.match(q3.question.text, /node --test a\.mjs && rm -rf \//);
    assert.deepEqual(q3.question.options, ["Allow once", "Deny"]);
    assert.equal(q3.next, `SendMessage to ${q3.worker}: "Answer ${q3.question.id}\nAllow once" (or Deny)`);

    // A job-grant answer must be refused on a 2-option card.
    const refused = await h.runTurn(`Answer ${q3.question.id}\nAllow "node --test" for this job`);
    assert.equal(refused.status, "needs_answer");
    assert.equal(refused.question.id, q3.question.id);

    const done = await h.runTurn(`Answer ${q3.question.id}\nDeny`);
    assert.equal(done.status, "blocked");
    assert.deepEqual(h.acp.state().serverResponses.map(r => r.result.outcome.optionId), ["allow", "allow", "deny"]);
    const job = h.stored(q1.jobId);
    assert.deepEqual((job.activity ?? []).filter(ev => ev.type === "permissionAutoAllowed").map(ev => ev.text), [
      "job grant auto-allowed: node --test"
    ]);
    assert.equal("guidance" in job.result.blockers[0], false);
  });
});
