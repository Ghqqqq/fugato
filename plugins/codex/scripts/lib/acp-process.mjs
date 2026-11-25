import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { executableOnPath, terminateProcessTree } from "./process.mjs";

export const isAntigravityJob = job => (job?.request?.backend ?? job?.backend ?? job?.result?.backend) === "antigravity";

export function acpExecutable(cwd) {
  const command = process.env.FUGATO_ANTIGRAVITY_BIN || "agy";
  return command.includes(path.sep) ? path.resolve(cwd, command) : executableOnPath(command) ?? command;
}

function matchesInvocation(command, executable) {
  const windows = process.platform === "win32";
  const normalize = value => windows ? value.toLowerCase().replaceAll('"', "").replace(/\^(.)/g, "$1") : value;
  const expected = new Set([executable, path.basename(executable)]);
  try { expected.add(fs.realpathSync(executable)); } catch { /* The binary may since have been removed. */ }
  // Account for a shebang interpreter or a Windows .cmd shim. Only accept
  // the executable and its single literal ACP argument, never a substring.
  let invocation = normalize(command);
  if (windows) invocation = invocation.replace(/^(?:.*\\)?cmd\.exe \/d \/s \/c /, "");
  invocation = invocation.replace(/^(?:[^\s]*[\\/])?(?:node|sh|bash|dash|zsh|python[\d.]*)(?:\.exe)?\s+/, "");
  return [...expected].some(name => invocation === normalize(name) + " acp");
}

function pidExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

// Inspection failure is distinct from a missing or reused PID. In particular
// it cannot authorize a group signal or release a submitted reservation.
function processIdentity(job) {
  const pid = job.acpProcessPid;
  if (!Number.isSafeInteger(pid) || pid <= 1) return "unknown";
  if (!pidExists(pid)) return "absent";
  /** @type {import("node:child_process").SpawnSyncOptionsWithStringEncoding} */
  const options = { encoding: "utf8", timeout: 1000, windowsHide: true };
  let command, startedAt;
  if (process.platform === "win32") {
    const shell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const query = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($p) { @{ command=$p.CommandLine; started=$p.CreationDate.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress }`;
    const result = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", query], options);
    if (!result.error && result.status === 0 && result.stdout.trim()) {
      try { const row = JSON.parse(result.stdout); command = row.command; startedAt = Date.parse(row.started); }
      catch { return "unknown"; }
    }
  } else {
    // lstart uses the locale's weekday/month and the process timezone.
    const result = spawnSync("/bin/ps", ["-ww", "-p", String(pid), "-o", "pgid=,stat=,lstart=,args="],
      { ...options, env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
    const row = !result.error && result.status === 0 &&
      /^\s*(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+?)\s*$/.exec(result.stdout);
    if (row) {
      if (row[2].startsWith("Z")) return "absent";
      // AcpClient spawns detached. A different process group proves PID reuse.
      if (Number(row[1]) !== pid) return "reused";
      startedAt = Date.parse(row[3] + " GMT");
      command = row[4];
    }
  }
  if (!command) return pidExists(pid) ? "unknown" : "absent";
  const executable = job.acpExecutable ?? acpExecutable(job.request?.cwd ?? job.workspaceRoot ?? process.cwd());
  if (!matchesInvocation(command, executable)) return "reused";
  const recordedAt = Date.parse(job.acpProcessRecordedAt ?? job.turnSubmission?.at);
  if (!Number.isFinite(startedAt) || !Number.isFinite(recordedAt)) return "unknown";
  // ps reports only whole seconds. A matching executable born anywhere in
  // the recorded second could be a replacement. CreationDate retains ms.
  const cutoff = process.platform === "win32" ? recordedAt : Math.floor(recordedAt / 1000) * 1000;
  if (startedAt === cutoff) return "unknown";
  return startedAt < cutoff ? "owned" : "reused";
}

const gone = identity => identity === "absent" || identity === "reused";
export const acpProcessGone = job => job.acpProcessExited === true || gone(processIdentity(job));

export async function stopOrphanedAcpGroup(job) {
  if (job.acpProcessExited || job.acpProcessGroup !== true || processIdentity(job) !== "owned") return;
  const pid = job.acpProcessPid;
  if (process.platform === "win32") {
    terminateProcessTree(pid);
  } else {
    const signalGroup = signal => {
      try { process.kill(-pid, signal); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    };
    signalGroup("SIGTERM");
    await delay(200);
    // The verified group's descendants can outlive its leader. While they
    // hold that PGID it cannot be reassigned. Never escalate on a reused PID.
    const identity = processIdentity(job);
    if (identity === "owned" || identity === "absent") signalGroup("SIGKILL");
  }
  for (const deadline = Date.now() + 1000; Date.now() < deadline && !acpProcessGone(job);) await delay(50);
}
