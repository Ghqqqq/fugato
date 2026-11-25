import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { makeTempDir, initGitRepo, waitForCondition, writeExecutable } from "./helpers.mjs";
import { buildEnv } from "./fake-codex-fixture.mjs";
import { installFakeAntigravity } from "./fake-antigravity-fixture.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";

const script = new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url).pathname;
const stateModule = new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url).href;

function fixture(behavior = "normal") {
  const dir = makeTempDir("agy-cli-"), repo = path.join(dir, "repo");
  fs.mkdirSync(repo); initGitRepo(repo);
  const acp = installFakeAntigravity(dir, { behavior });
  const codexCalls = path.join(dir, "unexpected-codex.jsonl");
  const codexTrap = path.join(dir, "unexpected-codex");
  writeExecutable(codexTrap, `#!/usr/bin/env node\nrequire("node:fs").appendFileSync(${JSON.stringify(codexCalls)}, JSON.stringify(process.argv.slice(2)) + "\\n"); process.exit(97);\n`);
  const env = { ...buildEnv(dir), FUGATO_ANTIGRAVITY_BIN: acp.binary,
    CODEX_COMPANION_BIN: path.join(dir, "missing-codex"),
    CODEX_COMPANION_HOME: path.join(dir, "isolated"), CLAUDE_PLUGIN_DATA: path.join(dir, "data"),
    CODEX_COMPANION_SESSION_ID: "antigravity-cli-session" };
  const invoke = (args, input) => spawnSync(process.execPath, [script, ...args], {
    cwd: repo, env, input, encoding: "utf8", timeout: 30000, killSignal: "SIGKILL"
  });
  const stored = id => JSON.parse(fs.readFileSync(path.join(resolveStateDir(repo, env), "jobs", `${id}.json`), "utf8"));
  const patch = (id, fields) => {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e",
      `import { updateJob } from ${JSON.stringify(stateModule)}; updateJob(process.cwd(), ${JSON.stringify(id)}, () => (${JSON.stringify(fields)}));`],
    { cwd: repo, env, encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
  };
  return { dir, repo, env, acp, codexCalls, codexTrap, stored, patch, invoke,
    call: (...args) => invoke(args),
    requests: () => { try { return acp.requests(); } catch (error) { if (error.code === "ENOENT") return []; throw error; } } };
}

function json(result, status = 0) {
  assert.equal(result.status, status, `${result.error?.message ?? ""}\n${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}
function direct(result, status = 0) {
  assert.equal(result.status, status, `${result.error?.message ?? ""}\n${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout.trim().split("\n").at(-1));
}
const prompts = f => f.requests().filter(message => message.method === "session/prompt");
const assertNoCodex = f => assert.equal(fs.existsSync(f.codexCalls), false, "Google tasks must never invoke Codex");

test("Google verification reports the run_command command line and uses legacy fallbacks in order", () => {
  const f = fixture("command-precedence");
  const done = direct(f.call("task", "--backend", "antigravity", "--direct", "Run the calculator tests."));
  assert.equal(done.status, "completed");
  const job = f.stored(done.jobId);
  assert.deepEqual(job.result.commandExecutions.map(value => value.command), ["pwd", "ls -a", "ls -l", "python3 test_calc.py"]);
  assert.ok(job.report.verification.includes("python3 test_calc.py: exit 0, completed"));
});

test("Google tasks run without Codex and continuations retain their backend and session", () => {
  const f = fixture();
  const first = direct(f.call("task", "--backend", "antigravity", "--model", "gemini-4-neon", "--effort", "high",
    "--name", "GeminiWorker", "--direct", "Complete the fixture assignment."));
  assert.equal(first.status, "completed");
  const original = f.stored(first.jobId);
  assert.equal(original.request.backend, "antigravity");
  assert.equal(original.request.model, "gemini-4-neon");
  assert.equal(original.request.effort, "high");
  assert.equal(original.request.sandbox, "danger-full-access");
  assert.ok(original.threadId);
  assert.equal(original.result.backend, "antigravity");
  assert.equal(original.result.turnEnded, true);
  assert.equal(prompts(f).length, 1);
  assert.equal(fs.existsSync(path.join(f.env.CODEX_COMPANION_HOME, "config.toml")), false,
    "Google dispatch cannot write Codex runtime setup");
  const status = f.call("status", first.jobId);
  assert.equal(status.status, 0, status.stderr);
  assert.doesNotMatch(status.stdout, /Resume in Codex|Codex session ID/i,
    "status cannot direct a Google worker to Codex resume");

  // A trap makes an incorrectly selected recovery/default provider observable.
  f.env.CODEX_COMPANION_BIN = f.codexTrap;
  for (const flags of [["--to", first.worker], ["--continue", first.jobId]]) {
    const next = direct(f.call("task", ...flags, "--direct", "Verify the previous answer."));
    assert.equal(next.status, "completed");
    const saved = f.stored(next.jobId);
    assert.equal(saved.threadId, original.threadId);
    assert.equal(saved.request.backend, "antigravity");
    assert.deepEqual([saved.request.model, saved.request.effort], ["gemini-4-neon", "high"]);
  }
  assert.equal(prompts(f).length, 3);
  assert.equal(f.requests().filter(message => message.method === "session/load").length, 2);
  const switched = f.call("task", "--to", first.worker, "--backend", "codex", "--json", "Continue.");
  assert.notEqual(switched.status, 0);
  assert.match(switched.stderr + switched.stdout, /backend|provider/i);
  assert.equal(prompts(f).length, 3, "a backend switch must fail before submitting a prompt");
  assertNoCodex(f);
});

test("Google model discovery uses the ACP catalog without a Codex default or a model turn", () => {
  const f = fixture(); f.env.CODEX_COMPANION_BIN = f.codexTrap;
  const setup = json(f.call("setup", "--backend", "antigravity", "--json"));
  assert.equal(setup.backend, "antigravity");
  assert.equal(setup.ready, true);
  assert.equal(prompts(f).length, 0);
  assert.equal(fs.existsSync(path.join(f.env.CODEX_COMPANION_HOME, "config.toml")), false);
  const catalog = json(f.call("models", "--backend", "antigravity", "--json"));
  const gemini = ["gemini-4-neon", "gemini-4-carbon", "gemini-pro-orchestrator", "gemini-3.8-flash"];
  assert.deepEqual(catalog.models.map(model => model.slug), gemini);
  assert.deepEqual(catalog.configOptions.find(value => value.id === "model").options.map(option => option.value), gemini);
  assert.equal(prompts(f).length, 0);
  const done = direct(f.call("task", "--backend", "antigravity", "--direct", "Complete a default-model assignment."));
  assert.equal(done.status, "completed");
  const saved = f.stored(done.jobId);
  assert.equal(saved.result.model, "gemini-4-neon");
  assert.notEqual(saved.request.effort, "xhigh");
  assert.ok(!f.requests().some(message => message.method === "session/set_config_option" && /^gpt-|xhigh/.test(String(message.params?.value))));
  assertNoCodex(f);
});

test("Google tasks submit only with an allowed Gemini model", () => {
  const f = fixture("non-gemini-default");
  const task = (...flags) => f.call("task", "--backend", "antigravity", "--direct", ...flags, "Check the model selection.");
  const rejected = task("--model", "claude-opus-5-5");
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr + rejected.stdout, /only Gemini models/);
  assert.equal(prompts(f).length, 0);
  const offset = f.requests().length;
  const completed = direct(task());
  assert.equal(completed.status, "completed");
  assert.equal(f.stored(completed.jobId).result.model, "gemini-4-neon");
  const requests = f.requests().slice(offset);
  assert.deepEqual(requests.map(value => value.method), ["initialize", "session/new", "session/set_config_option", "session/prompt"]);
  assert.equal(requests[2].params.value, "gemini-4-neon");

  const none = fixture("no-gemini");
  const unavailable = none.call("task", "--backend", "antigravity", "--direct", "Check the model selection.");
  assert.notEqual(unavailable.status, 0);
  assert.match(unavailable.stderr + unavailable.stdout, /did not advertise a Gemini model/);
  assert.equal(prompts(none).length, 0);
});

test("Google task launches use the ACP handshake for readiness without a help probe", () => {
  const f = fixture();
  assert.equal(direct(f.call("task", "--backend", "antigravity", "--direct", "Check readiness.")).status, "completed");
  assert.deepEqual(f.acp.state().launches.map(launch => launch.args), [["acp"]]);
  const bad = fixture("no-acp");
  const failed = bad.call("task", "--backend", "antigravity", "--direct", "Check readiness.");
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr + failed.stdout, /Install Antigravity CLI/);
  assert.match(failed.stderr + failed.stdout, /agy acp --login/);
  assert.equal(prompts(bad).length, 0);
  assert.deepEqual(bad.acp.state().launches.map(launch => launch.args), [["acp"]]);
});

test("a Google server without session loading cannot silently replace a continued worker", () => {
  const f = fixture("no-load"); f.env.CODEX_COMPANION_BIN = f.codexTrap;
  const first = direct(f.call("task", "--backend", "antigravity", "--direct", "Complete the first assignment."));
  assert.equal(first.status, "completed");
  const next = f.call("task", "--to", first.worker, "--direct", "Continue with the prior context.");
  assert.notEqual(next.status, 0);
  assert.match(next.stderr + next.stdout, /load|resum|continu/i);
  assert.equal(prompts(f).length, 1);
  assert.equal(f.requests().filter(message => message.method === "session/new").length, 1);
  assertNoCodex(f);
});

test("Google resume without a prior task cannot discover a Codex thread", () => {
  const f = fixture();
  f.env.CODEX_COMPANION_BIN = f.codexTrap;
  f.env.CODEX_COMPANION_SESSION_ID = "";
  const resumed = f.call("task", "--backend", "antigravity", "--resume-last", "--json", "Continue the prior assignment.");
  assert.notEqual(resumed.status, 0);
  assert.equal(prompts(f).length, 0);
  assertNoCodex(f);
});

test("Google dispatch refuses unsupported safety and Codex-only options before launching ACP", async t => {
  const cases = [
    ["read-only", ["--sandbox", "read-only"]],
    ["workspace-write", ["--sandbox", "workspace-write"]],
    ["write=false", ["--write=false"]],
    ["plan mode", ["--claude-permission-mode", "plan"]],
    ["fork", ["--fork"]],
    ["roundtable", ["--roundtable", "rt-fixture-room", "--persona", "critic"]],
    ["token budget", ["--max-tokens", "200"]],
    ["fast tier", ["--fast"]],
    ["browser grants", ["--approve-browser-origin", "https://example.com"]],
    ["Computer Use grants", ["--approve-computer-app", "com.example.Fixture"]]
  ];
  for (const [name, flags] of cases) await t.test(name, () => {
    const f = fixture(); f.env.CODEX_COMPANION_BIN = f.codexTrap;
    const result = f.call("task", "--backend", "antigravity", ...flags, "--json", "Complete the fixture.");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /Antigravity|ACP|backend/i);
    assert.equal(f.requests().length, 0);
    assertNoCodex(f);
  });
  await t.test("saved permission mapping", () => {
    const f = fixture(); f.env.CODEX_COMPANION_BIN = f.codexTrap;
    json(f.call("setup", "--permission-mapping", "claude", "--json"));
    const result = f.call("task", "--backend", "antigravity", "--claude-permission-mode", "default", "--json", "Complete the fixture.");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /Antigravity|ACP|backend/i);
    assert.equal(f.requests().length, 0);
    assertNoCodex(f);
  });
});

test("owned Google permission requests wait for the parent's exact single-use approval", async t => {
  for (const answer of ["Allow once", "yes"]) await t.test(answer, () => {
    const f = fixture("permission"); f.env.CODEX_COMPANION_BIN = f.codexTrap;
    const launch = json(f.call("task", "--backend", "antigravity", "--detached", "--json", "Complete the approved fixture operation."));
    const pending = json(f.call("wait", launch.jobId, "--owner", launch.ownerId, "--json"));
    assert.equal(pending.status, "needs_answer");
    assert.deepEqual(pending.question.options, ["Allow once", "Deny"]);
    const before = f.acp.state().serverResponses ?? [];
    assert.equal(before.length, 0, "the adapter cannot grant permission before a parent answer");
    json(f.invoke(["answer", launch.jobId, "--question", pending.question.id, "--owner", launch.ownerId, "--json"], answer));
    const completed = f.call("wait", launch.jobId, "--owner", launch.ownerId, "--json");
    assert.ok([0, 2].includes(completed.status), completed.stderr + completed.stdout);
    const responses = f.acp.state().serverResponses;
    assert.equal(responses.length, 1);
    const outcome = responses[0].result.outcome;
    if (answer === "Allow once") {
      assert.equal(outcome.outcome, "selected");
      assert.equal(outcome.optionId, "allow");
    } else {
      assert.ok(outcome.outcome === "cancelled" || outcome.optionId === "deny");
    }
    assertNoCodex(f);
  });
});

test("Google cancellation and running-time budgets stop the owned ACP turn", async t => {
  for (const mode of ["cancel", "budget"]) await t.test(mode, async () => {
    const f = fixture("hold"); f.env.CODEX_COMPANION_BIN = f.codexTrap;
    const launch = json(f.call("task", "--backend", "antigravity", "--detached", "--max-minutes", "1", "--json", "Hold until cancelled."));
    await waitForCondition(() => f.stored(launch.jobId).turnId && prompts(f).length, "Google prompt submission", 15000);
    if (mode === "cancel") {
      const cancelled = json(f.call("cancel", launch.jobId, "--json"));
      assert.equal(cancelled.confirmation, "confirmed");
    } else {
      f.patch(launch.jobId, { budget: { ...f.stored(launch.jobId).budget, consumedMs: 60000 } });
    }
    await waitForCondition(() => ["cancelled", "interrupted"].includes(f.stored(launch.jobId).status), "Google stop confirmation", 15000);
    const saved = f.stored(launch.jobId);
    assert.equal(saved.result.turnEnded, true);
    assert.equal(saved.result.interruptionConfirmed, true);
    assert.equal(saved.result.interruptionReason, mode === "cancel" ? "cancelled_by_user" : "budget_exceeded:max_minutes");
    assert.equal(f.requests().filter(message => message.method === "session/cancel").length, 1);
    assertNoCodex(f);
  });
});

test("lost Google outcomes never send ACP session handles to Codex recovery", () => {
  const f = fixture();
  const first = direct(f.call("task", "--backend", "antigravity", "--direct", "Complete the fixture."));
  const saved = f.stored(first.jobId), before = prompts(f).length;
  // Model loss of the wrapper's outcome receipt after session/prompt was sent.
  f.patch(first.jobId, { status: "failed", pid: null, result: null, report: null,
    recovered: false, turnResolution: null, launcherPid: null, ownerAttached: false,
    errorMessage: "Worker exited before its outcome was recorded.",
    turnSubmission: saved.turnSubmission ?? { at: new Date().toISOString() } });
  f.env.CODEX_COMPANION_BIN = f.codexTrap;
  const retentionModule = new URL("../plugins/codex/scripts/lib/retention.mjs", import.meta.url).href;
  const jobFile = path.join(resolveStateDir(f.repo, f.env), "jobs", `${first.jobId}.json`);
  const retention = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { reconcileAutomaticTask } from ${JSON.stringify(retentionModule)}; await reconcileAutomaticTask(${JSON.stringify(jobFile)}, Date.now() + 48 * 3600000, Date.now() + 5000);`],
  { cwd: f.repo, env: f.env, encoding: "utf8", timeout: 10000 });
  assert.equal(retention.status, 0, retention.stderr);
  assertNoCodex(f);
  const observed = json(f.call("status", first.jobId, "--json"));
  assert.notEqual(observed.job.status, "completed");
  const cancelled = f.call("cancel", first.jobId, "--json");
  assert.ok([0, 2].includes(cancelled.status), cancelled.stderr + cancelled.stdout);
  assert.equal(prompts(f).length, before, "recovery must not replay an uncertain assignment");
  assertNoCodex(f);
});
