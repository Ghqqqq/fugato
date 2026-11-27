import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDir, initGitRepo, run, writeExecutable } from "./helpers.mjs";
import { buildEnv } from "./fake-codex-fixture.mjs";
import { clearMode, effectiveMaxWorkers, MODE_NAMES, pruneModes, readMode, reminderText, setMode, modeFile, PROTOCOL_DIR, PROTOCOL_PARTS, protocolFile, protocolHeader, protocolParts, protocolVersion } from "../plugins/codex/scripts/lib/ultra-codex-mode.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";
import { defaultModeSetup, dispatchPreference, effectiveRoleTable, readNativeUnavailable, roleModelsSetup } from "../plugins/codex/scripts/lib/setup-config.mjs";
import { runWithRetainedStdin } from "./stdin-fixture.mjs";

const script = new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url).pathname;
const promptHook = new URL("../plugins/codex/scripts/ultra-codex-hook.mjs", import.meta.url).pathname;
const lifecycleHook = new URL("../plugins/codex/scripts/session-lifecycle-hook.mjs", import.meta.url).pathname;
const SESSION = "11111111-aaaa-4bbb-8ccc-000000000001";
const MODES = [
  { name: "ultra", verb: "ultra-codex", flags: ["--thorough", "--max-workers", "4"], options: { scale: "thorough", maxWorkers: 4 } },
  { name: "pair", verb: "pair", flags: [], options: {} },
  { name: "duel", verb: "duel", flags: ["--rounds", "2"], options: { rounds: 2 } },
  { name: "roundtable", verb: "roundtable", flags: ["--intensity", "deep", "--roles", "steward,critic,improver"], options: { intensity: "deep", roles: ["steward", "critic", "improver"] } }
];
function fixture() {
  const dir = makeTempDir(), repo = path.join(dir, "repo");
  fs.mkdirSync(repo); initGitRepo(repo);
  const baseEnv = { ...buildEnv(dir), CODEX_COMPANION_HOME: path.join(dir, "isolated"), CLAUDE_PLUGIN_DATA: path.join(dir, "data"),
    FUGATO_ANTIGRAVITY_BIN: path.join(dir, "fixture-agy.exe") };
  const env = { ...baseEnv, CODEX_COMPANION_SESSION_ID: SESSION };
  const json = result => { assert.equal(result.status, 0, result.stderr + result.stdout); return JSON.parse(result.stdout); };
  const call = (...args) => run(process.execPath, [script, ...args], { cwd: repo, env });
  const prompt = (text, sessionId = SESSION) => run(process.execPath, [promptHook], { cwd: repo, env: baseEnv,
    input: JSON.stringify({ session_id: sessionId, cwd: repo, prompt: text }) });
  const lifecycle = (event, input) => run(process.execPath, [lifecycleHook, event], { cwd: repo, env: baseEnv,
    input: JSON.stringify({ session_id: SESSION, cwd: repo, ...input }) });
  return { dir, repo, env, baseEnv, json, call, prompt, lifecycle, modeFile: id => modeFile(repo, id, env) };
}

test("mode operations and lifecycle cleanup refuse symlinked mode-directory ancestors", () => {
  for (const linked of ["duet", "ultra-codex"]) {
    const f = fixture(), home = f.env.CODEX_COMPANION_HOME, outside = path.join(f.dir, "outside-modes");
    const target = linked === "duet" ? path.join(outside, "ultra-codex") : outside;
    fs.mkdirSync(target, { recursive: true });
    const link = linked === "duet" ? path.join(home, "duet") : path.join(home, "duet", "ultra-codex");
    fs.mkdirSync(path.dirname(link), { recursive: true }); fs.symlinkSync(outside, link);
    const file = path.join(target, `${SESSION}.json`), stale = path.join(target, "stale-session.json");
    const bytes = JSON.stringify({ scale: "quick", maxWorkers: 2 });
    fs.writeFileSync(file, bytes); fs.writeFileSync(stale, bytes);
    const old = new Date(Date.now() - 31 * 86400000); fs.utimesSync(stale, old, old);
    assert.equal(readMode(f.repo, SESSION, f.env), null);
    assert.throws(() => setMode(f.repo, SESSION, { name: "pair" }, f.env), /symlink|unsafe/i);
    assert.equal(clearMode(f.repo, SESSION, f.env), false);
    assert.equal(pruneModes(f.repo, undefined, f.env), 0);
    for (const event of ["SessionStart", "SessionEnd"]) {
      const result = run(process.execPath, [lifecycleHook, event], { cwd: f.repo,
        env: { ...f.env, CODEX_COMPANION_BIN: "fixture-disabled" },
        input: JSON.stringify({ session_id: SESSION, cwd: f.repo, source: "startup" }) });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.readFileSync(file, "utf8"), bytes);
      assert.equal(fs.readFileSync(stale, "utf8"), bytes);
    }
    assert.deepEqual(fs.readdirSync(target).sort(), [`${SESSION}.json`, "stale-session.json"].sort());
    // A missing mode child must not permit mkdir through a linked ancestor.
    if (linked === "duet") {
      fs.rmSync(target, { recursive: true });
      assert.throws(() => setMode(f.repo, SESSION, { name: "pair" }, f.env), /symlink|unsafe/i);
      assert.equal(fs.existsSync(target), false);
    }
  }
});

test("modes switch on and off across workspaces while reminders and lifecycle stay session-bound", async () => {
  const f = fixture(), other = path.join(f.dir, "other");
  fs.mkdirSync(other); initGitRepo(other);
  assert.equal(f.prompt("task").stdout, "");
  const context = result => f.json(result).hookSpecificOutput.additionalContext;
  const baseline = context(f.lifecycle("SessionStart", { source: "compact" }));
  assert.match(baseline, /DUET: --role <id> --normal/);
  assert.match(baseline, /fugato:gemini-native for Gemini rows/);
  assert.match(baseline, /Use `--high-stakes` when the rule/);
  assert.match(baseline, /Set explicit `--model` or `--effort` for user choices only/);
  for (const mode of MODES) {
    const [core, active] = protocolParts(mode.name);
    const on = f.json(f.call(mode.verb, "on", ...mode.flags, "--json"));
    assert.deepEqual(on.activeMode, { name: mode.name, options: mode.options, since: on.since });
    assert.deepEqual(
      { protocolFile: on.protocolFile, protocolVersion: on.protocolVersion, protocolCoreFile: on.protocolCoreFile, protocolCoreVersion: on.protocolCoreVersion },
      { protocolFile: active.file, protocolVersion: active.version, protocolCoreFile: core.file, protocolCoreVersion: core.version }
    );
    const status = f.json(f.call(mode.verb, "status", "--cwd", other, "--json"));
    assert.deepEqual(status.activeMode, on.activeMode);
    assert.equal(status.protocolFile, active.file);
    assert.equal(status.protocolVersion, active.version);
    assert.equal(status.protocolCoreFile, core.file);
    assert.equal(status.protocolCoreVersion, core.version);
    assert.equal(modeFile(other, SESSION, f.env), f.modeFile(SESSION));
    assert.equal(fs.statSync(f.modeFile(SESSION)).mode & 0o777, 0o600);
    const reminder = f.prompt("substantive task").stdout.trim();
    assert.ok(reminder.length > 0);
    assert.ok(reminder.length <= 280, `${mode.name} reminder exceeded 280 chars (${reminder.length}): ${reminder}`);
    assert.ok(reminder.includes(`core.md@${core.version}`));
    assert.ok(reminder.includes(`${mode.name}.md@${active.version}`));
    assert.ok(reminder.includes(PROTOCOL_DIR));
    assert.match(reminder, /Re-read .* unless full text is in context \(not mentions\)\./);
    for (const otherMode of MODE_NAMES.filter(name => name !== mode.name)) {
      assert.equal(reminder.includes(protocolFile(otherMode)), false, `${mode.name} reminder must not name ${otherMode}`);
      assert.equal(reminder.includes(`${otherMode}.md`), false, `${mode.name} reminder must not name ${otherMode}.md`);
    }
    assert.equal(f.prompt("task", "another-session").stdout, "");
    assert.equal(f.prompt(`/fugato:${mode.verb} off`).stdout, "");
    assert.equal(f.lifecycle("SessionEnd", { reason: "prompt_input_exit", cwd: other }).status, 0);
    assert.equal(context(f.lifecycle("SessionStart", { source: "resume", cwd: other })), `${baseline}\n${reminder}`);
    assert.equal(context(f.lifecycle("SessionStart", { source: "compact" })), `${baseline}\n${reminder}`);
    assert.deepEqual(readMode(f.repo, SESSION, f.env).options, mode.options);
    const off = f.json(f.call(mode.verb, "off", "--json"));
    assert.equal(off.wasOn, true);
    assert.equal(off.protocolFile, active.file);
    assert.equal(off.protocolVersion, active.version);
    assert.equal(off.protocolCoreFile, core.file);
    assert.equal(off.protocolCoreVersion, core.version);
    assert.equal(f.prompt("task").stdout, "");
  }
  assert.equal(context(f.lifecycle("SessionStart", { source: "resume" })), baseline);
  assert.equal(context(f.lifecycle("SessionStart", { source: "clear" })), baseline);
  setMode(f.repo, SESSION, { name: "ultra" }, f.env);
  const retained = await runWithRetainedStdin(promptHook, [], JSON.stringify({ session_id: SESSION, cwd: f.repo, prompt: "task" }), { cwd: f.repo, env: f.baseEnv });
  assert.equal(retained.status, 0, retained.stderr);
  assert.equal(retained.inputEnded, false);
  assert.ok(retained.stdout.length > 0);
  assert.equal(f.prompt("/pair-review parser").stdout.length > 0, true);
  const stale = setMode(f.repo, "stale-session", {}, f.env), recent = setMode(f.repo, "recent-session", {}, f.env);
  const legacy = path.join(resolveStateDir(other, f.env), "ultra-codex", `${SESSION}.json`);
  fs.mkdirSync(path.dirname(legacy), { recursive: true }); fs.writeFileSync(legacy, "{}");
  const old = new Date(Date.now() - 40 * 86400000); fs.utimesSync(stale.file, old, old);
  assert.equal(f.lifecycle("SessionEnd", { cwd: other }).status, 0);
  assert.equal(fs.existsSync(f.modeFile(SESSION)), true);
  assert.equal(fs.existsSync(legacy), true);
  assert.equal(context(f.lifecycle("SessionStart", { source: "startup" })), baseline);
  assert.equal(fs.existsSync(f.modeFile(SESSION)), false);
  assert.equal(fs.existsSync(legacy), false);
  assert.equal(fs.existsSync(stale.file), false);
  assert.equal(fs.existsSync(recent.file), true);
});

test("ultra reminder stays compact and updates when agy becomes available", () => {
  const f = fixture();
  const fallbackSummary = "scan sol/low, implement|investigate|read|research sol/high, review sol/medium, " +
    "debug|architect|verify|judge|alt-design astra/xhigh, visual|media terra/medium; " +
    "high-stakes astra/xhigh; Gemini off (Codex fallbacks)";
  const start = f.json(f.lifecycle("SessionStart", { source: "startup" }));
  assert.ok(start.hookSpecificOutput.additionalContext.split("\n").includes(`Worker roles: ${fallbackSummary}.`));
  for (const verb of ["ultra-codex", "pair", "duel"]) {
    const status = f.call(verb, "status");
    assert.equal(status.status, 0, status.stderr);
    assert.ok(status.stdout.split("\n").includes(`models: roles ${fallbackSummary}; roleless default gpt-6-astra/xhigh`));
  }
  setMode(f.repo, SESSION, { scale: "quick", maxWorkers: 2 }, f.env);
  const [core, ultra] = protocolParts("ultra");
  const suffix = `Re-read core.md@${core.version}, ultra.md@${ultra.version} in ${PROTOCOL_DIR} unless full text is in context (not mentions).`;
  const reminder = () => {
    const result = f.prompt("task");
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  assert.equal(reminder(), `Ultra mode (quick, max 2; roles: default; Gemini off). ${suffix}`);
  writeExecutable(f.env.FUGATO_ANTIGRAVITY_BIN, "");
  assert.equal(reminder(), `Ultra mode (quick, max 2; roles: default; Gemini on). ${suffix}`);
});

test("reminders list only overridden roles and qualify model slugs that collide with the role table", () => {
  const f = fixture();
  roleModelsSetup({ env: f.env, models: ["implement=gpt-6.1-sol:medium", "verify=gpt-6.2-sol:high",
    "architect=gpt-6.1-astra:xhigh"] });
  const reminder = () => f.prompt("task").stdout.trim();
  setMode(f.repo, SESSION, { name: "ultra" }, f.env);
  const ultraReminder = reminder();
  assert.match(ultraReminder, /^Ultra mode \(auto, max \d+ auto; roles: overrides implement gpt-6\.1-sol\/medium, architect gpt-6\.1-astra\/xhigh, verify gpt-6\.2-sol\/high; Gemini off\)\. Re-read /);
  assert.equal(ultraReminder.includes("scan "), false, "compact reminder must omit non-overridden roles");
  assert.equal(ultraReminder.includes("high-stakes"), false, "compact reminder must omit non-overridden high-stakes");
  setMode(f.repo, SESSION, { name: "pair" }, f.env);
  const pairReminder = reminder();
  assert.match(pairReminder, /^Pair mode \(max 2 rework; roles: overrides implement gpt-6\.1-sol\/medium, verify gpt-6\.2-sol\/high; Gemini off\)\. Re-read /);
  assert.equal(pairReminder.includes("architect"), false, "pair reminder must list only pair-relevant overrides");
  setMode(f.repo, SESSION, { name: "duel", options: { rounds: 1 } }, f.env);
  assert.match(reminder(), /^Duel mode \(max 1 rounds; roles: overrides implement gpt-6\.1-sol\/medium, verify gpt-6\.2-sol\/high, architect gpt-6\.1-astra\/xhigh; Gemini off\)\. Re-read /);
  const resume = f.json(f.lifecycle("SessionStart", { source: "resume" }));
  assert.ok(resume.hookSpecificOutput.additionalContext.endsWith(reminder()));
});

test("compact reminderText stays <= 280 chars for all four modes with a >=100-char protocol path and stays hash-invalidated", () => {
  const f = fixture();
  const pad = Math.max(1, 100 - f.dir.length - "/protocol".length - 1);
  const longDir = path.join(f.dir, "p".repeat(pad), "protocol");
  assert.ok(longDir.length >= 100, `expected >=100-char protocolDir, got ${longDir.length}`);
  fs.mkdirSync(longDir, { recursive: true });
  for (const part of PROTOCOL_PARTS) fs.copyFileSync(protocolFile(part), protocolFile(part, longDir));

  const tableOff = effectiveRoleTable({ env: f.env, cwd: f.repo });
  writeExecutable(f.env.FUGATO_ANTIGRAVITY_BIN, "");
  const tableOn = effectiveRoleTable({ env: f.env, cwd: f.repo });

  const cases = [
    { name: "ultra", options: { scale: "auto", maxWorkers: "auto" } },
    { name: "ultra", options: { scale: "thorough", maxWorkers: "auto" } },
    { name: "ultra", options: { scale: "quick", maxWorkers: "unlimited" } },
    { name: "pair", options: {} },
    { name: "duel", options: { rounds: 3 } },
    { name: "roundtable", options: { intensity: "standard", roles: null } },
    { name: "roundtable", options: { intensity: "deep", roles: ["steward", "critic", "improver"] } }
  ];
  for (const table of [tableOff, tableOn]) {
    const geminiState = table.gemini.installed ? "Gemini on" : "Gemini off";
    for (const mode of cases) {
      const [core, active] = protocolParts(mode.name, longDir);
      const text = reminderText(mode, longDir, table);
      assert.ok(text.length <= 280, `${mode.name} (${geminiState}) length ${text.length} > 280: ${text}`);
      assert.ok(text.includes(longDir), `${mode.name} must name protocol directory`);
      assert.ok(text.includes(`core.md@${core.version}`), `${mode.name} must name core.md and its hash`);
      assert.ok(text.includes(`${mode.name}.md@${active.version}`), `${mode.name} must name ${mode.name}.md and its hash`);
      assert.ok(text.includes(geminiState), `${mode.name} must reflect ${geminiState}`);
      assert.match(text, /Re-read .* unless full text is in context \(not mentions\)\./);
    }
  }

  // Editing a protocol file must change the emitted version hash immediately.
  const before = reminderText({ name: "pair", options: {} }, longDir, tableOff);
  fs.appendFileSync(protocolFile("pair", longDir), "\nExtra protocol note.\n");
  const [, updatedPair] = protocolParts("pair", longDir);
  const after = reminderText({ name: "pair", options: {} }, longDir, tableOff);
  assert.notEqual(after, before);
  assert.ok(after.includes(`pair.md@${updatedPair.version}`));
});

test("mode replacement and targeted off leave running jobs and other sessions intact", () => {
  const f = fixture(), stateDir = resolveStateDir(f.repo, f.env);
  fs.mkdirSync(stateDir, { recursive: true });
  const jobs = [
    { id: "running", sessionId: SESSION, workspaceRoot: f.repo, status: "running" },
    { id: "foreign", sessionId: "other-session", workspaceRoot: f.repo, status: "running" }
  ];
  const stateFile = path.join(stateDir, "state.json"); fs.writeFileSync(stateFile, JSON.stringify({ jobs, config: {} }));
  const first = f.json(f.call("pair", "on", "--json"));
  const next = f.json(f.call("duel", "on", "--json"));
  assert.deepEqual(next.replacedMode, first.activeMode);
  assert.deepEqual(next.runningJobs.map(job => job.jobId), ["running"]);
  const roundtable = f.json(f.call("roundtable", "on", "--json"));
  assert.deepEqual(roundtable.replacedMode, next.activeMode);
  assert.deepEqual(roundtable.runningJobs.map(job => job.jobId), ["running"]);
  const before = fs.readFileSync(f.modeFile(SESSION), "utf8");
  assert.equal(f.json(f.call("pair", "off", "--json")).wasOn, false);
  assert.equal(fs.readFileSync(f.modeFile(SESSION), "utf8"), before);
  assert.deepEqual(fs.readdirSync(path.dirname(f.modeFile(SESSION))), [`${SESSION}.json`]);
  assert.equal(f.json(f.call("roundtable", "off", "--json")).wasOn, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs, jobs);
});

test("default-mode setup previews, persists and initializes only fresh sessions", () => {
  const f = fixture(), file = path.join(f.env.CODEX_COMPANION_HOME, "duet", "config.toml");
  assert.equal(defaultModeSetup({ env: f.env }).defaultMode, "off");
  assert.equal(f.json(f.call("setup", "--default-mode", "roundtable", "--dry-run", "--json")).defaultMode, "roundtable");
  assert.equal(fs.existsSync(file), false);
  f.json(f.call("setup", "--default-mode", "roundtable", "--json"));
  fs.appendFileSync(file, '# preserved\n[custom]\nvalue = "untouched"\n');
  const preference = fs.readFileSync(file, "utf8");
  assert.equal(defaultModeSetup({ env: { ...f.env, CLAUDE_PLUGIN_DATA: undefined } }).defaultMode, "roundtable");
  for (const source of ["startup", "clear"]) {
    setMode(f.repo, SESSION, { name: "duel" }, f.env);
    assert.equal(f.lifecycle("SessionStart", { source }).status, 0);
    assert.equal(readMode(f.repo, SESSION, f.env).name, "roundtable");
    assert.deepEqual(readMode(f.repo, SESSION, f.env).options, { intensity: "standard", roles: null });
  }
  clearMode(f.repo, SESSION, f.env);
  assert.equal(f.lifecycle("SessionStart", { source: "resume" }).status, 0);
  assert.equal(readMode(f.repo, SESSION, f.env), null);
  setMode(f.repo, SESSION, { name: "pair" }, f.env);
  assert.equal(f.lifecycle("SessionStart", { source: "unknown" }).status, 0);
  assert.equal(readMode(f.repo, SESSION, f.env), null);
  assert.equal(fs.readFileSync(file, "utf8"), preference);
  fs.writeFileSync(file, 'defaultMode = "off"\n' + '"x"'.repeat(28) + '\n');
  assert.equal(defaultModeSetup({ env: f.env }).defaultMode, "off");
  fs.writeFileSync(file, 'defaultMode = "unterminated');
  setMode(f.repo, SESSION, { name: "pair" }, f.env);
  assert.equal(f.lifecycle("SessionStart", { source: "startup" }).status, 0);
  assert.equal(readMode(f.repo, SESSION, f.env), null);
});

test("dispatch setup previews, persists across plugin data paths and resets startup routing", t => {
  const f = fixture(), file = path.join(f.env.CODEX_COMPANION_HOME, "duet", "config.toml");
  assert.equal(dispatchPreference(f.env), "auto");
  assert.equal(f.json(f.call("setup", "--dispatch", "bash", "--session", SESSION, "--dry-run", "--json")).dispatch, "bash");
  assert.equal(fs.existsSync(file), false);
  f.json(f.call("setup", "--dispatch", "bash", "--json"));
  assert.equal(dispatchPreference({ ...f.env, CLAUDE_PLUGIN_DATA: undefined }), "bash");
  assert.equal(f.json(f.call("setup", "--json")).dispatch, "bash");
  const alias = path.join(f.dir, "plugin-alias");
  fs.symlinkSync(new URL("../plugins/codex", import.meta.url).pathname, alias, "dir");
  const helper = run(process.execPath, [path.join(alias, "scripts", "lib", "setup-config.mjs"), "dispatch-status"], { cwd: f.repo, env: f.env });
  assert.deepEqual({ exit: helper.status, output: helper.stdout },
    { exit: 0, output: JSON.stringify({ dispatch: "bash", nativeUnavailable: null }) + "\n" });
  f.baseEnv.CODEX_COMPANION_BIN = "fixture-disabled";
  const context = () => f.json(f.lifecycle("SessionStart", { source: "startup" })).hookSpecificOutput.additionalContext;
  assert.match(context(), /background Bash.*fugato task/);
  assert.match(context(), /fugato task --role <id> --normal/);
  assert.match(context(), /fugato task --backend antigravity --role <id> --normal/);
  assert.doesNotMatch(context(), /Agent\(subagent_type:/);
  const before = fs.readFileSync(file, "utf8");
  assert.equal(f.call("setup", "--dispatch", "invalid").status, 1);
  assert.equal(f.call("setup", "--dispatch", "bash", "--default-mode", "pair").status, 1);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  const markerFile = path.join(path.dirname(file), "native-unavailable.json");
  const marker = { at: new Date(Date.now() - 25 * 3600000).toISOString(), reason: "missing_turn_start" };
  fs.writeFileSync(markerFile, JSON.stringify(marker));
  assert.equal(readNativeUnavailable(f.env), null);
  marker.at = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
  marker.availableAt = new Date(Date.now() + 86400000).toISOString();
  fs.writeFileSync(markerFile, JSON.stringify(marker));
  assert.deepEqual(readNativeUnavailable(f.env), { at: marker.at, reason: marker.reason });
  const anchor = Date.parse(marker.at), future = { unavailableAt: new Date(anchor + 7 * 86400000).toISOString(),
    availableAt: marker.availableAt, reason: marker.reason };
  fs.writeFileSync(markerFile, JSON.stringify(future));
  fs.utimesSync(markerFile, anchor / 1000, anchor / 1000);
  const now = t.mock.method(Date, "now", () => anchor + 3600000);
  assert.deepEqual(readNativeUnavailable(f.env), { at: marker.at, reason: marker.reason });
  now.mock.mockImplementation(() => anchor + 86400000);
  assert.equal(readNativeUnavailable(f.env), null);
  fs.utimesSync(markerFile, new Date(future.unavailableAt), new Date(future.unavailableAt));
  assert.equal(readNativeUnavailable(f.env), null);
  assert.deepEqual(JSON.parse(fs.readFileSync(markerFile, "utf8")), future);
  now.mock.restore();
  fs.writeFileSync(markerFile, JSON.stringify({ availableAt: marker.availableAt }));
  assert.equal(readNativeUnavailable(f.env), null);
  fs.writeFileSync(markerFile, JSON.stringify(marker));
  f.json(f.call("setup", "--dispatch", "auto", "--dry-run", "--json"));
  assert.equal(fs.existsSync(markerFile), true);
  f.json(f.call("setup", "--dispatch", "bash", "--json"));
  assert.equal(fs.existsSync(markerFile), false);
  fs.writeFileSync(markerFile, JSON.stringify(marker));
  assert.equal(f.json(f.call("setup", "--dispatch", "default", "--json")).dispatch, "auto");
  assert.equal(fs.existsSync(markerFile), false);
  assert.equal(dispatchPreference(f.env), "auto");
  fs.writeFileSync(markerFile, JSON.stringify(marker));
  f.json(f.call("setup", "--dispatch", "auto", "--json"));
  assert.equal(fs.existsSync(markerFile), false);
  fs.writeFileSync(markerFile, JSON.stringify(future));
  f.json(f.call("setup", "--dispatch", "native", "--json"));
  assert.equal(fs.existsSync(markerFile), false);
  assert.match(context(), /Agent\(subagent_type:/);
});

test("mode CLI rejects malformed controls before writes and keeps command preambles inert", () => {
  const f = fixture();
  setMode(f.repo, SESSION, { name: "pair" }, f.env);
  const file = f.modeFile(SESSION), before = fs.readFileSync(file, "utf8");
  for (const args of [
    ["setup", "--default-mode", "invalid"], ["setup", "--default-mode", "pair", "--sync-tools"],
    ["ultra-codex", "on", "--max-workers", "65"], ["ultra-codex", "on", "--quick", "--thorough"],
    ["duel", "on", "--rounds", "4"], ["pair", "status", "--rounds", "2"],
    ["pair", "on", "task text"], ["pair", "on", "--session", "../invalid"],
    ["roundtable", "on", "--intensity", "unknown"], ["roundtable", "on", "--intensity", "constructor"],
    ["roundtable", "on", "--roles", "critic,unknown"], ["roundtable", "on", "--roles", "critic,critic"],
    ["roundtable", "on", "--roles", "critic,"], ["roundtable", "off", "--intensity", "light"]
  ]) {
    assert.equal(f.call(...args).status, 1, args.join(" "));
    assert.equal(fs.readFileSync(file, "utf8"), before);
  }
  assert.equal(run(process.execPath, [script, "pair", "on"], { cwd: f.repo, env: f.baseEnv }).status, 1);
  assert.equal(f.json(run(process.execPath, [script, "pair", "status", "--json"], { cwd: f.repo, env: f.baseEnv })).sessionId, null);
  for (const mode of MODES) {
    const [core, active] = protocolParts(mode.name);
    const command = fs.readFileSync(new URL(`../plugins/codex/commands/${mode.verb}.md`, import.meta.url), "utf8");
    assert.doesNotMatch(command, /^!`[^\n]*\$ARGUMENTS/m);
    const result = run(process.execPath, [script, mode.verb, "status", "--for-command"], { cwd: f.repo, env: f.env, input: "$(exit 93) `exit 94`; off" });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`Read both ${core.file} (core v${core.version}) and ${active.file} (${mode.name} v${active.version})`));
    for (const otherMode of MODE_NAMES.filter(name => name !== mode.name)) {
      assert.equal(result.stdout.includes(`${otherMode}.md`), false, `${mode.verb} preamble must not name ${otherMode}.md`);
    }
    const bareStatus = f.call(mode.verb, "status");
    assert.equal(bareStatus.status, 0, bareStatus.stderr);
    assert.equal(bareStatus.stdout.includes("Read both"), false);
    assert.equal(bareStatus.stdout.includes(core.file), false);
    assert.equal(bareStatus.stdout.includes(active.file), false);
    const help = f.call(mode.verb, "--help");
    assert.equal(help.status, 0, help.stderr);
    assert.equal(help.stdout.includes("Read both"), false);
    assert.equal(help.stdout.includes(core.file), false);
    assert.equal(help.stdout.includes(active.file), false);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  }
  for (const part of PROTOCOL_PARTS) {
    const protocol = fs.readFileSync(protocolFile(part), "utf8");
    assert.equal(protocol.split("\n")[0], protocolHeader(part, protocolVersion(protocol)));
  }
  assert.equal(fs.existsSync(path.join(path.dirname(PROTOCOL_DIR), "ultra-codex-protocol.md")), false);
});

test("roundtable options survive reactivation and status is a mode control", () => {
  const f = fixture();
  const on = f.json(f.call("roundtable", "on", "--intensity", "full", "--roles", "critic,integrator", "--json"));
  const again = f.json(f.call("roundtable", "on", "--json"));
  assert.deepEqual(again.activeMode, on.activeMode);
  const before = fs.readFileSync(f.modeFile(SESSION), "utf8");
  assert.deepEqual(f.json(f.call("roundtable", "--json", "status")).activeMode, on.activeMode);
  assert.equal(f.json(f.call("roundtable", "--json")).mode, "on");
  assert.equal(fs.readFileSync(f.modeFile(SESSION), "utf8"), before);
});

test("ultra caps survive reactivation and legacy records migrate without rewriting on read", () => {
  const f = fixture(), file = f.modeFile(SESSION), since = "2026-01-01T00:00:00.000Z";
  f.json(f.call("ultra-codex", "on", "--max-workers", "unlimited", "--json"));
  const again = f.json(f.call("ultra-codex", "on", "--quick", "--json"));
  assert.deepEqual([again.scale, again.maxWorkersSetting, again.maxWorkers], ["quick", "unlimited", null]);
  for (const [stored, setting] of [[80, 80], [0, "auto"]]) {
    const bytes = JSON.stringify({ sessionId: SESSION, scale: "thorough", maxWorkers: stored, since });
    fs.writeFileSync(file, bytes);
    assert.deepEqual(readMode(f.repo, SESSION, f.env).options, { scale: "thorough", maxWorkers: setting });
    assert.equal(fs.readFileSync(file, "utf8"), bytes);
    const migrated = setMode(f.repo, SESSION, {}, f.env);
    assert.deepEqual(migrated.options, { scale: "auto", maxWorkers: setting });
    assert.equal(migrated.since, since);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).schemaVersion, 2);
  }
  assert.deepEqual([effectiveMaxWorkers("auto", 1), effectiveMaxWorkers("auto", 18)], [1, 16]);
  for (const value of ["broken JSON", { schemaVersion: 2, name: "duel", options: { rounds: 4 } },
    { schemaVersion: 2, name: "roundtable", options: { intensity: ["standard"], roles: null } },
    { schemaVersion: 2, name: "roundtable", options: { intensity: "standard", roles: ["critic", "critic"] } },
    { sessionId: "foreign", scale: "quick" }]) {
    const bytes = typeof value === "string" ? value : JSON.stringify(value); fs.writeFileSync(file, bytes);
    assert.equal(readMode(f.repo, SESSION, f.env), null);
    assert.equal(f.prompt("task").stdout, "");
    assert.equal(fs.readFileSync(file, "utf8"), bytes);
  }
});
