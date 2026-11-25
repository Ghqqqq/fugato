import "./test-environment.mjs";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { acpProcessGone, stopOrphanedAcpGroup } from "../plugins/codex/scripts/lib/acp-process.mjs";
import { spawnOwned } from "../plugins/codex/scripts/lib/process.mjs";

function mockPlatform(t, value) {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value });
  t.after(() => { Object.defineProperty(process, "platform", platform); t.mock.restoreAll(); syncBuiltinESMExports(); });
}

test("ACP ownership uses the registration second and resolves its tie only with a later submission", async t => {
  mockPlatform(t, "linux");
  const pid = 42000, signals = [];
  let alive = true;
  t.mock.method(process, "kill", (target, signal) => {
    if (signal === 0) {
      assert.equal(target, pid);
      if (!alive) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    } else {
      assert.equal(target, -pid);
      signals.push(signal);
      alive = false;
    }
    return true;
  });
  t.mock.method(childProcess, "spawnSync", () => ({ status: 0, stdout: pid + " S Wed Jan  1 00:00:02 2025 /bin/agy acp" }));
  syncBuiltinESMExports();
  const stamp = sec => `2025-01-01T00:00:0${sec}.100Z`;
  for (const [registered, submitted, identity] of [
    [1, 3, "reused"], [3, 3, "owned"], [2, 3, "owned"], [2, 2, "unknown"], [2, null, "unknown"],
    [null, 2, "unknown"], [null, 1, "reused"], [null, 3, "owned"], [null, null, "unknown"]
  ]) {
    const job = { acpProcessPid: pid, acpProcessGroup: true, acpExecutable: "/bin/agy",
      acpProcessRecordedAt: registered && stamp(registered), turnSubmission: submitted && { at: stamp(submitted) } };
    alive = true;
    signals.length = 0;
    assert.equal(acpProcessGone(job), identity === "reused", JSON.stringify(job));
    await stopOrphanedAcpGroup(job);
    assert.deepEqual(signals, identity === "owned" ? ["SIGTERM", "SIGKILL"] : [], JSON.stringify(job));
  }
});

test("Windows ACP recovery recognizes the verbatim cmd line from the process launcher", t => {
  mockPlatform(t, "win32");
  let commandLine, started;
  t.mock.method(childProcess, "spawn", (command, args, options) => {
    assert.equal(options.windowsVerbatimArguments, true);
    commandLine = [command, ...args].join(" ");
    return {};
  });
  t.mock.method(childProcess, "spawnSync", () => ({ status: 0, stdout: JSON.stringify({ command: commandLine, started }) }));
  syncBuiltinESMExports();
  for (const executable of [String.raw`C:\Program Files\A^B\agy.CMD`, String.raw`C:\work tree\node_modules\.bin\agy.cmd`]) {
    const job = { acpProcessPid: process.pid, acpExecutable: executable, acpProcessRecordedAt: "2025-01-01T00:00:01.100Z",
      turnSubmission: { at: "2025-01-01T00:00:03.100Z" } };
    started = "2025-01-01T00:00:01.099Z";
    spawnOwned(executable, ["acp"]);
    assert.equal(acpProcessGone(job), false, commandLine);
    started = "2025-01-01T00:00:01.101Z";
    assert.equal(acpProcessGone(job), true, "a later creation millisecond proves PID reuse");
    started = "2025-01-01T00:00:01.099Z";
    spawnOwned(executable, ["other", "acp"]);
    assert.equal(acpProcessGone(job), true, "extra arguments do not identify the owned shim");
  }
});
