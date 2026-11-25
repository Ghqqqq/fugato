import "./test-environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { run, makeTempDir } from "./helpers.mjs";
import { COMMAND_OPTIONS } from "../plugins/codex/scripts/lib/command-options.mjs";
import { approveDuet } from "../plugins/codex/scripts/duet-permission-hook.mjs";
import { runWithDelayedStdin, runWithRetainedStdin } from "./stdin-fixture.mjs";

const script = fileURLToPath(new URL("../plugins/codex/scripts/duet-permission-hook.mjs", import.meta.url));
const launcher = fs.realpathSync(fileURLToPath(new URL("../plugins/codex/bin/duet", import.meta.url)));
const quotedLauncher = `'${launcher.replace(/'/g, `'"'"'`)}'`;
const heredoc = head => `${head} <<'DUET_TASK'\nLiteral $(body); pipes | and "quotes"\nDUET_TASK`;
const input = (command, extra = {}) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", permission_mode: "default",
  session_id: "session-a", tool_use_id: "tool-a", cwd: process.cwd(), tool_input: { command, run_in_background: true, ...extra } });
function fixture() {
  const root = makeTempDir("permission-"), home = path.join(root, "isolated"); fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, "models_cache.json"), JSON.stringify({ models: [
    { slug: "provider:fixture", supported_reasoning_levels: [{ effort: "ultra" }] }
  ] }));
  return { root, home, env: { ...process.env, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: "", CODEX_COMPANION_HOME: home, PATH: path.dirname(process.execPath) } };
}

test("PreToolUse preserves approval and delivery bindings with delayed and retained JSON stdin", { skip: process.platform === "win32" }, async () => {
  const f = fixture(), body = "Literal 字🙂 task.\n".repeat(4000);
  const payload = input(`duet task --model provider:fixture --effort ultra <<'DUET_TASK'\n${body}DUET_TASK`, { dangerouslyDisableSandbox: true });
  const delayed = await runWithDelayedStdin(script, [], JSON.stringify(payload), { env: f.env });
  assert.equal(delayed.waited, true);
  assert.equal(delayed.status, 0, delayed.stderr);
  const expected = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: {
    ...payload.tool_input, command: `${quotedLauncher} 'task' '--model' 'provider:fixture' '--effort' 'ultra' '--session' 'session-a' '--tool-use-id' 'tool-a' <<'DUET_TASK'\n${body}DUET_TASK`
  } } };
  assert.deepEqual(JSON.parse(delayed.stdout), expected);
  const retained = await runWithRetainedStdin(script, [], JSON.stringify(payload), { env: f.env });
  assert.equal(retained.status, 0, retained.stderr);
  assert.equal(retained.inputEnded, false);
  assert.deepEqual(JSON.parse(retained.stdout), expected);
});

test("permission grammar binds session-wide cancellation and runtime actions only with valid targets", () => {
  const f = fixture();
  const commands = ["duet cancel --all --json", "duet runtime status", "duet runtime restart --json",
    "duet cancel --all Ada", "duet runtime", "duet runtime stop", "duet runtime status restart"];
  assert.deepEqual(commands.map(command => {
    const output = approveDuet(input(command), f.env).hookSpecificOutput;
    return output?.permissionDecision === "allow" && output.updatedInput.command.includes("'--session' 'session-a'");
  }), [true, true, true, false, false, false, false]);
});

test("fugato uses the legacy launcher's permission grammar and trust boundary", () => {
  const f = fixture(), canonical = fs.realpathSync(fileURLToPath(new URL("../plugins/codex/bin/fugato", import.meta.url)));
  const quotedCanonical = `'${canonical.replace(/'/g, `'"'"'`)}'`;
  const command = heredoc("fugato task --sandbox read-only --cwd '/tmp/a b'");
  const approved = approveDuet(input(command), f.env).hookSpecificOutput;
  const legacy = approveDuet(input(command.replace("fugato", "duet")), f.env).hookSpecificOutput;
  assert.equal(approved.permissionDecision, "allow");
  assert.deepEqual(approved, { ...legacy, updatedInput: { ...legacy.updatedInput,
    command: legacy.updatedInput.command.replace(quotedLauncher, quotedCanonical) } });
  assert.equal(approveDuet(input(`${quotedCanonical} status`), f.env).hookSpecificOutput.permissionDecision, "allow");
  assert.equal(approveDuet(input(`${canonical} status`), f.env).hookSpecificOutput.permissionDecision, "allow");
  assert.deepEqual(approveDuet(input("fugato 'status'"), f.env), {});
  assert.deepEqual(approveDuet(input("fugato setup"), f.env), {});
  fs.writeFileSync(path.join(f.root, "fugato"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  assert.deepEqual(approveDuet(input("fugato status"), { ...f.env, PATH: `${f.root}:${f.env.PATH}` }), {});
  assert.deepEqual(approveDuet(input("fugato status"), { ...f.env, "BASH_FUNC_fugato%%": "() { :; }" }), {});
});

test("fresh Gemini role and explicit-model dispatches receive the same delivery binding", () => {
  const f = fixture(), agy = path.join(f.root, "agy.exe");
  fs.writeFileSync(agy, "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  const env = { ...f.env, FUGATO_ANTIGRAVITY_BIN: agy };
  const task = "fugato task --backend antigravity";
  const invoke = flags => approveDuet(input(heredoc(`${task} ${flags}`)), env);
  const explicit = invoke("--model gemini-4-neon --effort high").hookSpecificOutput;
  assert.equal(explicit.permissionDecision, "allow");
  assert.ok(explicit.updatedInput.command.includes("'--session' 'session-a' '--tool-use-id' 'tool-a' <<'DUET_TASK'"));
  assert.deepEqual(invoke("--role read").hookSpecificOutput, { ...explicit, updatedInput: {
    ...explicit.updatedInput, command: explicit.updatedInput.command.replace("'--model' 'gemini-4-neon' '--effort' 'high'", "'--role' 'read'")
  } });

  for (const flags of ["--high-stakes", "--role debug", "--role read --model gpt-6.2-sol", "--role read --to Ada",
    "--role read --model ' gemini-4-neon'", "--model ' gemini-4-neon' --effort high"]) {
    assert.deepEqual(invoke(flags), {}, flags);
  }
  fs.unlinkSync(agy);
  assert.deepEqual(invoke("--role read"), {});
});

test("fresh Gemini dispatches respect Antigravity options and saved permission settings", () => {
  const f = fixture(), env = { ...f.env, FUGATO_ANTIGRAVITY_BIN: process.execPath };
  const config = path.join(f.home, "duet", "config.toml");
  fs.mkdirSync(path.dirname(config));
  for (const selection of ["--role read", "--model gemini-4-neon --effort high"]) {
    const invoke = flags => approveDuet(input(heredoc(["fugato task --backend antigravity", selection, flags].filter(Boolean).join(" "))), env);
    fs.writeFileSync(config, 'default_max_tokens = 100\n');
    for (const flags of ["--sandbox read-only", "--sandbox workspace-write", "--fast", "--max-tokens 10",
      "--fork", ...(selection.includes("--role") ? ["--roundtable rt-test-room --persona critic"] : [])]) {
      assert.deepEqual(invoke(flags), {}, flags);
    }
    if (!selection.includes("--role")) {
      assert.equal(invoke("--roundtable rt-test-room --persona critic").hookSpecificOutput.permissionDecision, "allow");
      for (const bad of ["--roundtable rt-test-room", "--persona critic", "--roundtable bad-id --persona critic",
        "--roundtable rt-test-room --persona outsider", "--roundtable rt-test-room --persona critic --sandbox read-only",
        "--roundtable rt-test-room --persona critic --fast"]) {
        assert.deepEqual(invoke(bad), {}, bad);
      }
    }
    assert.equal(invoke("--normal --max-minutes 2").hookSpecificOutput.permissionDecision, "allow");
    assert.equal(invoke("--fast=false").hookSpecificOutput.permissionDecision, "allow");
    fs.writeFileSync(config, 'default_sandbox = "read-only"\n');
    assert.deepEqual(invoke(), {});
    if (!selection.includes("--role")) assert.deepEqual(invoke("--roundtable rt-test-room --persona critic"), {});
    assert.equal(invoke("--sandbox danger-full-access").hookSpecificOutput.permissionDecision, "allow");
    fs.writeFileSync(config, 'permission_mapping = "claude"\n');
    assert.deepEqual(invoke("--sandbox danger-full-access"), {});
    if (!selection.includes("--role")) assert.deepEqual(invoke("--sandbox danger-full-access --roundtable rt-test-room --persona critic"), {});
  }
  const seatOnly = flags => approveDuet(input(heredoc(`fugato task ${flags}`)), env);
  fs.writeFileSync(config, 'default_max_tokens = 100\n');
  assert.equal(seatOnly("--backend antigravity --roundtable rt-test-room --persona critic").hookSpecificOutput.permissionDecision, "allow");
  assert.deepEqual(seatOnly("--backend antigravity --model gpt-6.2-sol --roundtable rt-test-room --persona critic"), {});
  assert.deepEqual(seatOnly("--model gemini-4-neon --roundtable rt-test-room --persona critic"), {});
});

test("permission grammar rejects unsafe commands and untrusted bindings while quoting approved commands literally", () => {
  const f = fixture(), invoke = (command, overrides = {}, env = f.env) => approveDuet({ ...input(command), ...overrides }, env);
  const unsafe = [
    "duet status | cat", "duet status; id", "duet status && id", "duet status > /tmp/report", "X=1 duet status",
    "duet task --cwd $(pwd)", 'duet task --cwd "/tmp"', "duet task --unknown", "duet setup", "duet transfer", "duet journal show", "duet cleanup",
    "duet task --approve-browser-origin https://example.com", "duet task --approve-computer-app com.example.App",
    "duet task --write", "duet task --write=false", "duet task --approval-policy never", "duet task --sandbox invalid",
    "duet task --source /tmp/session.jsonl", "duet task --fork --thread thread_1", "duet task --continue job_1 --sandbox read-only",
    "duet task --fork --source", "duet task --no-claude-md false", "duet task --lease-sec 0", "duet wait Ada --sandbox read-only",
    "duet task --json", "duet wait Ada --feed-limit 10", "duet answer Ada --json", "duet task --direct=false",
    heredoc("duet task <<'SECOND'"), heredoc("duet task") + "\nid", "duet status --session another-session",
    "duet status --session session-a --session session-a", "duet task --fast --normal", "duet task --to Ada --fresh",
    "duet task brief-on-command-line", "duet wait Ada <<'DUET_TASK'\ntext\nDUET_TASK", "duet task <<DUET_TASK\ntext\nDUET_TASK",
    "duet task --prompt-file /tmp/brief", "duet status\r\n", "duet status\0", "duet task --effort impossible", "duet answer Ada --timeout-sec 0",
    'node "$CODEX_COMPANION" status', "/tmp/duet status", "'duet' status", "duet 'status'",
    "duet task --model 'fixture model'", "duet task --model -fixture", "duet task --model _fixture", "duet task --model fixture/model",
    `duet task --model ${"m".repeat(101)}`, ...["to", "thread", "continue"].map(flag => `duet task --${flag} provider:fixture`)
  ];
  for (const [verb, schema] of Object.entries(COMMAND_OPTIONS)) {
    for (const name of schema.internalValueOptions ?? []) {
      assert.ok(!schema.valueOptions.includes(name));
      for (const separator of [" ", "="]) unsafe.push(`duet ${verb}${verb === "task" ? "" : " Ada"} --${name}${separator}foreign`);
    }
  }
  for (const command of unsafe) assert.deepEqual(invoke(command), {}, command);
  for (const command of [heredoc("duet task --sandbox read-only --cwd '/tmp/a b'"), "duet task --fork", "duet answer Ada", "duet wait Ada", "duet result Ada", "duet status", "duet cancel Ada"]) {
    const output = invoke(command).hookSpecificOutput;
    assert.equal(output.permissionDecision, "allow", command);
    assert.ok(output.updatedInput.command.startsWith(quotedLauncher));
    assert.ok(output.updatedInput.command.includes("'--session' 'session-a'"));
    if (/duet (task|answer|wait)\b/.test(command)) {
      assert.ok(output.updatedInput.command.includes("'--tool-use-id' 'tool-a'"));
      assert.deepEqual(invoke(output.updatedInput.command), {});
    }
  }
  assert.equal(invoke("duet task --model provider:fixture --effort ultra").hookSpecificOutput.permissionDecision, "allow");
  fs.rmSync(path.join(f.home, "models_cache.json"));
  assert.deepEqual(invoke("duet task --model provider:fixture --effort ultra"), {});
  assert.deepEqual(fs.readdirSync(f.home), []);
  for (const permission_mode of ["default", "bypassPermissions"]) {
    const output = invoke("duet task", { permission_mode, tool_input: { command: "duet task", dangerouslyDisableSandbox: true } }).hookSpecificOutput;
    assert.equal(output.updatedInput.dangerouslyDisableSandbox, true);
    assert.equal(output.updatedInput.command, `${quotedLauncher} 'task' '--session' 'session-a' '--tool-use-id' 'tool-a'`);
  }
  for (const permission_mode of [undefined, "plan"]) assert.deepEqual(invoke("duet task", { permission_mode }), {});
  for (const verb of ["task", "answer Ada", "wait Ada"]) {
    for (const tool_use_id of [undefined, "", "foreign;id", "x".repeat(129)]) assert.deepEqual(invoke(`duet ${verb}`, { tool_use_id }), {});
  }
  const collision = path.join(f.root, "duet"); fs.writeFileSync(collision, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  assert.deepEqual(invoke("duet status", {}, { ...f.env, PATH: `${f.root}:${f.env.PATH}` }), {});
  assert.deepEqual(invoke("duet status", {}, { ...f.env, "BASH_FUNC_duet%%": "() { :; }" }), {});
  const snapshots = path.join(f.root, ".claude", "shell-snapshots"); fs.mkdirSync(snapshots, { recursive: true });
  fs.writeFileSync(path.join(snapshots, "snapshot-bash-fixture.sh"), `alias duet=${quotedLauncher}\nhelper() { echo 'Use duet() in examples'; }\n`);
  assert.equal(invoke("duet wait Ada").hookSpecificOutput.permissionDecision, "allow");
  const probe = path.join(f.root, "probe"), log = path.join(f.root, "calls.jsonl"), shellFile = path.join(f.root, "command.sh");
  fs.writeFileSync(probe, `#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.PROBE_LOG, JSON.stringify({argv: process.argv.slice(2), stdin: require('node:fs').readFileSync(0, 'utf8')}) + '\\n');\n`, { mode: 0o755 });
  for (const value of ["G", "=duet"]) {
    const original = heredoc(`duet task --cwd ${value}`), rewritten = invoke(original).hookSpecificOutput.updatedInput.command;
    fs.writeFileSync(shellFile, `'${probe}'${rewritten.slice(quotedLauncher.length)}`);
    for (const shell of ["/bin/bash", "/bin/zsh"].filter(fs.existsSync)) {
      fs.writeFileSync(log, "");
      const aliases = shell.endsWith("zsh") ? "alias -g G='x; extra_probe' session-a=foreign tool-a=other-tool task=other-task\n" : "";
      const result = run(shell, [...(shell.endsWith("zsh") ? ["-f"] : ["--noprofile", "--norc"]), "-c",
        `extra_probe() { echo extra >> '${log}'; }\n${aliases}source '${shellFile}'`], { env: { ...f.env, PROBE_LOG: log } });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse), [{
        argv: ["task", "--cwd", value, "--session", "session-a", "--tool-use-id", "tool-a"], stdin: 'Literal $(body); pipes | and "quotes"\n'
      }]);
    }
  }
});
