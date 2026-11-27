import "./test-environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./helpers.mjs";
import { approveDuet } from "../plugins/codex/scripts/duet-permission-hook.mjs";

const fugatoLauncher = fs.realpathSync(fileURLToPath(new URL("../plugins/codex/bin/fugato", import.meta.url)));
const duetLauncher = fs.realpathSync(fileURLToPath(new URL("../plugins/codex/bin/duet", import.meta.url)));
const quotedFugato = `'${fugatoLauncher.replace(/'/g, `'"'"'`)}'`;
const quotedDuet = `'${duetLauncher.replace(/'/g, `'"'"'`)}'`;

const hookInput = (command, extra = {}) => ({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  permission_mode: "default",
  session_id: "session-doctor",
  tool_use_id: "tool-doctor",
  cwd: process.cwd(),
  tool_input: { command, ...extra }
});

function fixture() {
  const root = makeTempDir("doctor-perm-");
  const home = path.join(root, "isolated");
  fs.mkdirSync(home, { recursive: true });
  return {
    root,
    home,
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      CLAUDE_CONFIG_DIR: path.join(root, ".claude"),
      CODEX_COMPANION_HOME: home,
      PATH: path.dirname(process.execPath)
    }
  };
}

test("permission hook allows read-only fugato doctor commands and binds session literally", () => {
  const f = fixture();
  const allowed = [
    ["fugato doctor", `${quotedFugato} 'doctor' '--session' 'session-doctor'`],
    ["fugato doctor --json", `${quotedFugato} 'doctor' '--json' '--session' 'session-doctor'`],
    ["fugato doctor --offline", `${quotedFugato} 'doctor' '--offline' '--session' 'session-doctor'`],
    ["fugato doctor --json --offline --cwd '/tmp/a b'", `${quotedFugato} 'doctor' '--json' '--offline' '--cwd' '/tmp/a b' '--session' 'session-doctor'`],
    ["fugato doctor -C /tmp/work --offline=true", `${quotedFugato} 'doctor' '-C' '/tmp/work' '--offline=true' '--session' 'session-doctor'`],
    ["fugato doctor --help", `${quotedFugato} 'doctor' '--help' '--session' 'session-doctor'`],
    ["fugato doctor -h", `${quotedFugato} 'doctor' '-h' '--session' 'session-doctor'`],
    ["duet doctor --json", `${quotedDuet} 'doctor' '--json' '--session' 'session-doctor'`],
    [`${quotedFugato} doctor --offline --json`, `${quotedFugato} 'doctor' '--offline' '--json' '--session' 'session-doctor'`],
    [`${fugatoLauncher} doctor --json`, `${quotedFugato} 'doctor' '--json' '--session' 'session-doctor'`]
  ];

  for (const [command, expected] of allowed) {
    const output = approveDuet(hookInput(command), f.env).hookSpecificOutput;
    assert.equal(output?.permissionDecision, "allow", `Expected allow for: ${command}`);
    assert.equal(output.updatedInput.command, expected, `Unexpected rewrite for: ${command}`);
    assert.equal(output.updatedInput.command.includes("--tool-use-id"), false, "read-only doctor must not attach --tool-use-id");
  }

  // Repeated hook invocation on our own fully quoted rewrite is recognized.
  const firstRewrite = approveDuet(hookInput("fugato doctor --offline --json"), f.env).hookSpecificOutput.updatedInput.command;
  const second = approveDuet(hookInput(firstRewrite), f.env).hookSpecificOutput;
  assert.equal(second?.permissionDecision, "allow");
  assert.equal(second.updatedInput.command, firstRewrite);
});

test("permission hook rejects unsafe, malformed, or untrusted fugato doctor invocations", () => {
  const f = fixture();
  const rejected = [
    "fugato doctor extra",
    "fugato doctor status",
    "fugato doctor --unknown",
    "fugato doctor --fix",
    "fugato doctor --args-stdin",
    "fugato doctor --json --json",
    "fugato doctor --offline=maybe",
    "fugato doctor --session other-session",
    "fugato doctor --help --json",
    "fugato doctor | cat",
    "fugato doctor; id",
    "fugato doctor && id",
    "fugato doctor > /tmp/report",
    "X=1 fugato doctor",
    "fugato doctor --cwd $(pwd)",
    "fugato doctor <<'DUET_TASK'\nbody\nDUET_TASK",
    "fugato 'doctor'"
  ];

  for (const command of rejected) {
    assert.deepEqual(approveDuet(hookInput(command), f.env), {}, `Expected abstain for: ${command}`);
  }

  // Unsupported permission modes.
  for (const permission_mode of [undefined, "plan"]) {
    assert.deepEqual(approveDuet({ ...hookInput("fugato doctor"), permission_mode }, f.env), {});
  }

  // Untrusted launcher shadowing PATH or shell function injection.
  fs.writeFileSync(path.join(f.root, "fugato"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  assert.deepEqual(approveDuet(hookInput("fugato doctor"), { ...f.env, PATH: `${f.root}${path.delimiter}${f.env.PATH}` }), {});
  assert.deepEqual(approveDuet(hookInput("fugato doctor"), { ...f.env, "BASH_FUNC_fugato%%": "() { :; }" }), {});
});
