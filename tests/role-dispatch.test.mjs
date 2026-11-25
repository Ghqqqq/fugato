import test from "node:test";
import assert from "node:assert/strict";
import { lifecycleHarness } from "./fake-codex-fixture.mjs";
import { approveDuet } from "../plugins/codex/scripts/duet-permission-hook.mjs";
import { isC2Report } from "../plugins/codex/scripts/lib/report-delivery.mjs";

const { fixture, fs, path, run, direct, json } = await lifecycleHarness();
const launcher = new URL("../plugins/codex/bin/fugato", import.meta.url).pathname;
const freshError = "role flags apply to a fresh dispatch; follow-ups keep the recorded model and effort (use --model/--effort to change them)";
const call = (f, args, input) => run(process.execPath, [launcher, ...args], { env: f.env, cwd: f.repo, input });
const role = (table, id) => table.roles.find(row => row.id === id);

test("fugato task expands model and effort once and leaves roleless and resumed settings intact", () => {
  const f = fixture("task-ok");
  f.env.FUGATO_ANTIGRAVITY_BIN = path.join(f.dir, "missing-agy");
  const dispatch = (...flags) => {
    const report = direct(call(f, ["task", ...flags], "Run the fixture."));
    assert.equal(report.status, "completed", JSON.stringify(report));
    return { report, turn: f.state().lastTurnStart, request: json(f.call("status", report.jobId, "--json")).job.request };
  };
  for (const [flags, model, effort] of [
    [[], "gpt-6-astra", "xhigh"],
    [["--role", "read"], "gpt-6.2-sol", "high"],
    [["--role", "implement"], "gpt-6.2-sol", "high"],
    [["--role", "implement", "--effort", "medium"], "gpt-6.2-sol", "medium"],
    [["--role", "implement", "--model", "spark"], "gpt-5.3-codex-spark", "high"],
    [["--high-stakes"], "gpt-6.2-astra", "xhigh"]
  ]) {
    const { turn, request } = dispatch(...flags);
    assert.deepEqual([turn.model, turn.effort, request.model, request.effort], [model, effort, model, effort]);
    assert.equal("role" in request, flags.includes("--role"));
    assert.equal("highStakes" in request, flags.includes("--high-stakes"));
  }
  json(f.call("setup", "--role-model", "implement=first-model:low", "--json"));
  const before = dispatch("--role", "implement");
  assert.deepEqual([before.turn.model, before.turn.effort], ["first-model", "low"]);
  json(f.call("setup", "--role-model", "implement=second-model:max", "--json"));
  const resumed = dispatch("--to", before.report.jobId);
  assert.deepEqual([resumed.turn.threadId, resumed.turn.model, resumed.turn.effort], [before.turn.threadId, "first-model", "low"]);
  assert.ok(!("role" in resumed.request) && !("highStakes" in resumed.request));
});

test("job details and both status views expose dispatch choices while compact reports keep the v2 schema", () => {
  const f = fixture("task-ok");
  const report = direct(call(f, ["task", "--role", "review", "--high-stakes"], "Review the fixture."));
  assert.equal(report.status, "completed");
  const details = json(f.call("result", report.jobId, "--details"));
  const single = json(f.call("status", report.jobId, "--json")).job;
  const latest = json(f.call("status", "--json")).latestFinished;
  for (const record of [details, single.request, single, latest]) {
    assert.deepEqual([record.role, record.highStakes, record.model, record.effort], ["review", true, "gpt-6.2-astra", "xhigh"]);
  }
  for (const args of [["status"], ["status", report.jobId]]) {
    const status = f.call(...args);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /role: review \| high-stakes/);
  }
  for (const compact of [report, json(f.call("result", report.jobId))]) {
    assert.equal(isC2Report(compact), true);
    assert.ok(!("role" in compact) && !("highStakes" in compact));
  }
});

test("every follow-up selector, fork and roundtable seat refuses fresh role flags before lookup", () => {
  const f = fixture();
  for (const selector of [["--to", "Ada"], ["--thread", "thread-1"], ["--continue", "task-1"],
    ["--resume"], ["--resume-last"], ["--fork"], ["--roundtable", "rt-test-room", "--persona", "critic"]]) {
    for (const flag of [["--role", "implement"], ["--high-stakes"], ["--high-stakes=false"]]) {
      const result = call(f, ["task", ...selector, ...flag], "Continue.");
      assert.equal(result.status, 1);
      assert.equal(result.stderr.trim(), freshError);
    }
  }
  assert.equal(fs.existsSync(path.join(f.dir, "fake-codex-state.json")), false);
});

for (const [command, flags] of [["review", ["--role", "review"]], ["adversarial-review", ["--high-stakes"]]]) {
  test(`${command} refuses role flags in option position before starting a reviewer`, () => {
    const f = fixture("review-ok");
    const message = "review commands do not take --role or --high-stakes; pass --model/--effort to choose the reviewer";
    for (const result of [call(f, [command, ...flags]), call(f, [command, "--args-stdin"], flags.join(" "))]) {
      assert.equal(result.status, 1);
      assert.equal(result.stderr.trim(), message);
    }
    assert.equal(fs.existsSync(path.join(f.dir, "fake-codex-state.json")), false);
    if (command === "adversarial-review") {
      fs.writeFileSync(path.join(f.repo, "fixture.txt"), "Reviewable content\n");
      const literal = call(f, [command, "--wait", "--json", "--", "--high-stakes"]);
      assert.equal(literal.status, 0, literal.stderr);
      assert.match(f.state().lastTurnStart.prompt, /--high-stakes/);
    }
  });
}

test("unknown roles, high-stakes conflicts and cross-backend model overrides fail before launch", () => {
  const f = fixture();
  for (const [flags, message] of [
    [["--role", "unknown"], /Unknown role unknown.*implement/],
    [["--high-stakes", "--model", "explicit"], /--high-stakes fixes model and effort/],
    [["--role", "implement", "--high-stakes", "--effort", "low"], /--high-stakes fixes model and effort/],
    [["--role", "implement", "--model", "gemini-4-neon"], /gemini-4-neon.*fugato:gemini-native/]
  ]) {
    const refused = call(f, ["task", ...flags], "Run the fixture.");
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, message);
  }
  assert.equal(fs.existsSync(path.join(f.dir, "fake-codex-state.json")), false);
  assert.equal(json(f.call("status", "--json")).latestFinished, null);
});

test("setup previews, saves and resets role overrides and every catalog reports the effective table", () => {
  const f = fixture();
  const file = path.join(f.env.CODEX_COMPANION_HOME, "duet", "config.toml");
  // Only --cwd contains the relative ACP executable. Discovery never runs it.
  fs.writeFileSync(path.join(f.dir, "local-agy"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  f.env.FUGATO_ANTIGRAVITY_BIN = "./local-agy";
  const setup = (...args) => json(f.call("setup", "--cwd", f.dir, ...args, "--json"));
  const flags = ["--role-model", "implement=custom-worker:medium", "--role-model", "debug=custom-debug"];
  const preview = setup(...flags, "--dry-run");
  assert.equal(preview.dryRun, true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(preview.roles.gemini.installed, true);
  assert.equal(preview.roles.gemini.executable, path.join(f.dir, "local-agy"));
  assert.deepEqual(role(preview.roles, "implement"), { id: "implement", backend: "codex", model: "custom-worker", effort: "medium", source: "saved" });
  assert.equal(role(preview.roles, "debug").model, "custom-debug");
  const saved = setup(...flags);
  assert.deepEqual(saved.roles, preview.roles);
  assert.equal(fs.existsSync(file), true);
  const summary = setup(), status = json(f.call("status", "--cwd", f.dir, "--json"));
  assert.deepEqual(summary.roles, saved.roles);
  assert.deepEqual(status.roles, saved.roles);
  for (const key of ["defaultModel", "defaultEffort", "ultraRoutineModel"]) assert.ok(key in summary);
  for (const key of ["config", "running", "latestFinished", "recent"]) assert.ok(key in status);

  fs.writeFileSync(path.join(f.env.CODEX_COMPANION_HOME, "models_cache.json"), JSON.stringify({ models: [{ slug: "custom-worker" }] }));
  f.env.CODEX_COMPANION_BIN = path.join(f.dir, "missing-codex");
  const models = json(f.call("models", "--cwd", f.dir, "--json"));
  assert.deepEqual(models.roles, saved.roles);
  assert.ok(models.tiers.strong && models.tiers.routine && Array.isArray(models.models[0].inUse));
  for (const command of ["setup", "status", "models"]) {
    const result = f.call(command, "--cwd", f.dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /implement \| codex \| custom-worker \| medium \| saved/);
    assert.match(result.stdout, /high-stakes \| codex \| gpt-6\.2-astra \| xhigh \| fixed/);
  }
  const reset = setup("--role-model", "implement=default");
  assert.equal(role(reset.roles, "implement").source, "built-in");
  assert.equal(role(reset.roles, "debug").model, "custom-debug");
  assert.deepEqual(setup().roles, reset.roles);
});

test("high-stakes rooms use Astra for each persona except explicit room model overrides", () => {
  const f = fixture();
  json(f.call("setup", "--persona-model", "critic=saved-critic:low", "--json"));
  const room = json(call(f, ["roundtable", "start", "--cwd", f.dir, "--intensity", "full", "--high-stakes",
    "--persona-model", "improver=room-model:medium", "--json"], "Check a high-stakes change."));
  assert.equal(room.members.length, 6);
  for (const seat of room.members) assert.equal(seat.model, seat.persona === "improver" ? "room-model" : "gpt-6.2-astra");
  assert.equal(room.members.find(seat => seat.persona === "critic").effort, "low");
  assert.equal(room.members.find(seat => seat.persona === "improver").effort, "medium");
});

test("permission hook accepts fresh role flags and declines invalid combinations", () => {
  const f = fixture();
  const env = { ...f.env, PATH: path.dirname(launcher) };
  const approved = flags => approveDuet({ hook_event_name: "PreToolUse", tool_name: "Bash", permission_mode: "default",
    session_id: f.env.CODEX_COMPANION_SESSION_ID, tool_use_id: "tool-a", cwd: f.repo, tool_input: { command: "fugato task " + flags } }, env)
    .hookSpecificOutput?.permissionDecision === "allow";
  for (const flags of ["--role implement --effort medium", "--role=debug --high-stakes", "--high-stakes"]) assert.ok(approved(flags), flags);
  for (const flags of ["--role unknown", "--role debug --to Ada", "--high-stakes --effort high",
    "--role review --roundtable rt-test-room --persona critic"]) assert.equal(approved(flags), false, flags);
});
