import "./test-environment.mjs";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import {
  acpProcessGone,
  parseProcStatStartTime,
  processStartIdentity,
  stopOrphanedAcpGroup
} from "../plugins/codex/scripts/lib/acp-process.mjs";

function mockPlatform(t, value) {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value });
  t.after(() => {
    Object.defineProperty(process, "platform", platform);
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

test("parseProcStatStartTime extracts field 22 after the final ')' when comm contains ') ('", () => {
  const stat = "4242 (agy ) ( acp) S 1 4242 4242 0 -1 4194304 100 0 0 0 12 3 0 0 20 0 1 0 987654321 12345678 100\n";
  assert.equal(parseProcStatStartTime(stat), "987654321");
  assert.equal(parseProcStatStartTime("4242 (agy) S 1 4242"), null);
  assert.equal(parseProcStatStartTime("4242 agy S 1 4242 4242 0 -1 0 0 0 0 0 0 0 0 0 0 0 0 0 987654321"), null);
  assert.equal(parseProcStatStartTime("4242 (agy) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 notanumber"), null);
});

test("processStartIdentity formats Linux, POSIX ps, and Windows start identities and rejects invalid PIDs", t => {
  assert.equal(processStartIdentity(0), null);
  assert.equal(processStartIdentity(1), null);
  assert.equal(processStartIdentity(-5), null);
  assert.equal(processStartIdentity(NaN), null);

  mockPlatform(t, "linux");
  const linuxStat = "42000 (agy ) ( acp) S 1 42000 42000 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 12345678 0 0\n";
  t.mock.method(fs, "readFileSync", file => {
    if (file === "/proc/sys/kernel/random/boot_id") return "boot-uuid-1234\n";
    if (file === "/proc/42000/stat") return linuxStat;
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  });
  assert.equal(processStartIdentity(42000), "linux:boot-uuid-1234:12345678");
  assert.equal(processStartIdentity(99999), null);
  t.mock.restoreAll();

  Object.defineProperty(process, "platform", { value: "darwin" });
  t.mock.method(childProcess, "spawnSync", (bin, args, opts) => {
    assert.equal(bin, "/bin/ps");
    assert.deepEqual(args, ["-o", "lstart=", "-p", "42000"]);
    assert.equal(opts.env.LC_ALL, "C");
    assert.equal(opts.env.TZ, "UTC");
    return { status: 0, stdout: "Wed Jan  1 00:00:02 2025    \n" };
  });
  syncBuiltinESMExports();
  assert.equal(processStartIdentity(42000), "ps:Wed Jan  1 00:00:02 2025");
  t.mock.restoreAll();

  Object.defineProperty(process, "platform", { value: "win32" });
  t.mock.method(childProcess, "spawnSync", () => ({
    status: 0,
    stdout: JSON.stringify({ command: "agy acp", started: "2025-01-01T00:00:01.0991234Z" })
  }));
  syncBuiltinESMExports();
  assert.equal(processStartIdentity(42000), "win:2025-01-01T00:00:01.099Z");
});

test("processIdentity compares recorded acpProcessStart independently of wall-clock skew", async t => {
  mockPlatform(t, "linux");
  const pid = 42000;
  const signals = [];
  let alive = true;
  let currentTick = "200";
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
  t.mock.method(childProcess, "spawnSync", () => ({
    status: 0,
    stdout: `${pid} S Wed Jan  1 00:00:02 2025 /bin/agy acp`
  }));
  t.mock.method(fs, "readFileSync", file => {
    if (file === "/proc/sys/kernel/random/boot_id") return "boot-1\n";
    if (file === `/proc/${pid}/stat` && currentTick !== null) {
      return `${pid} (agy) S 1 ${pid} ${pid} 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${currentTick} 0 0\n`;
    }
    throw Object.assign(new Error("EACCES"), { code: "EACCES" });
  });
  syncBuiltinESMExports();

  // Different start identity is "reused" even when ps lstart looks older than acpProcessRecordedAt.
  const reusedJob = {
    acpProcessPid: pid,
    acpProcessGroup: true,
    acpExecutable: "/bin/agy",
    acpProcessRecordedAt: "2025-01-01T00:00:10.000Z",
    acpProcessStart: "linux:boot-1:100"
  };
  assert.equal(acpProcessGone(reusedJob), true);
  await stopOrphanedAcpGroup(reusedJob);
  assert.deepEqual(signals, []);

  // Matching start identity is "owned" even when ps lstart looks newer than acpProcessRecordedAt.
  const ownedJob = {
    acpProcessPid: pid,
    acpProcessGroup: true,
    acpExecutable: "/bin/agy",
    acpProcessRecordedAt: "2025-01-01T00:00:00.000Z",
    acpProcessStart: "linux:boot-1:200"
  };
  assert.equal(acpProcessGone(ownedJob), false);
  await stopOrphanedAcpGroup(ownedJob);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);

  // Unavailable current start identity is "unknown": neither gone nor signalled.
  alive = true;
  signals.length = 0;
  currentTick = null;
  assert.equal(acpProcessGone(ownedJob), false);
  await stopOrphanedAcpGroup(ownedJob);
  assert.deepEqual(signals, []);
});
