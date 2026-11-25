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
  const normalize = value => windows ? value.toLowerCase() : value;
  const expected = new Set([executable, (windows ? path.win32 : path).basename(executable)]);
  try { expected.add(fs.realpathSync(executable)); } catch { /* The binary may since have been removed. */ }
  // Account for a shebang interpreter or a Windows .cmd shim. Only accept
  // the executable and its single literal ACP argument, never a substring.
  let invocation = normalize(command);
  if (windows) {
    const shim = /^"?(?:[^"]*\\)?cmd\.exe"? \/d \/s \/c "(.+) ([^ ]+)"$/.exec(invocation);
    if (shim) {
      // The executable is cmd-escaped once. Local npm shims escape their
      // quoted argument twice because the shim forwards it through %*.
      const unescape = value => value.replace(/\^(.)/g, "$1");
      const name = unescape(shim[1]);
      const arg = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/.test(name) ? unescape(unescape(shim[2])) : unescape(shim[2]);
      return arg === '"acp"' && [...expected].some(candidate => name === normalize(candidate));
    }
    invocation = invocation.replace(/^"([^"]+)" /, "$1 ");
  }
  invocation = invocation.replace(/^(?:[^\s]*[\\/])?(?:node|sh|bash|dash|zsh|python[\d.]*)(?:\.exe)?\s+/, "");
  return [...expected].some(name => invocation === normalize(name) + " acp");
}

function pidExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

/** @type {import("node:child_process").SpawnSyncOptionsWithStringEncoding} */
const INSPECT_OPTIONS = { encoding: "utf8", timeout: 1000, windowsHide: true };
const LSTART_PATTERN = /^\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4}$/;

export function parseProcStatStartTime(stat) {
  if (typeof stat !== "string") return null;
  const open = stat.indexOf("(");
  const close = stat.lastIndexOf(")");
  if (open === -1 || close <= open) return null;
  const rest = stat.slice(close + 1);
  if (!/^\s/.test(rest)) return null;
  // Field 3 (state) is index 0 after the final ")", so field 22 (starttime) is index 19.
  const startTime = rest.trim().split(/\s+/)[19];
  return startTime && /^\d+$/.test(startTime) ? startTime : null;
}

function queryWindowsProcess(pid) {
  const shell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const query = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($p) { @{ command=$p.CommandLine; started=$p.CreationDate.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress }`;
  const result = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", query], INSPECT_OPTIONS);
  if (result.error || result.status !== 0 || !result.stdout?.trim()) return null;
  try {
    const row = JSON.parse(result.stdout);
    const startedAt = typeof row?.started === "string" ? Date.parse(row.started) : NaN;
    return {
      command: row?.command,
      startedAt,
      startIdentity: Number.isFinite(startedAt) ? `win:${new Date(startedAt).toISOString()}` : null
    };
  } catch {
    return { parseError: true };
  }
}

export function processStartIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  if (process.platform === "linux") {
    try {
      const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      const startTime = parseProcStatStartTime(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
      return bootId && startTime ? `linux:${bootId}:${startTime}` : null;
    } catch {
      return null;
    }
  }
  if (process.platform === "win32") {
    return queryWindowsProcess(pid)?.startIdentity ?? null;
  }
  const result = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)],
    { ...INSPECT_OPTIONS, env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
  const lstart = !result.error && result.status === 0 ? (result.stdout ?? "").trim() : "";
  return LSTART_PATTERN.test(lstart) ? `ps:${lstart}` : null;
}

// Inspection failure is distinct from a missing or reused PID. In particular
// it cannot authorize a group signal or release a submitted reservation.
function processIdentity(job) {
  const pid = job.acpProcessPid;
  if (!Number.isSafeInteger(pid) || pid <= 1) return "unknown";
  if (!pidExists(pid)) return "absent";
  let command, startedAt, currentStart;
  if (process.platform === "win32") {
    const row = queryWindowsProcess(pid);
    if (row?.parseError) return "unknown";
    if (row) {
      command = row.command;
      startedAt = row.startedAt;
      currentStart = row.startIdentity;
    }
  } else {
    // lstart uses the locale's weekday/month and the process timezone.
    const result = spawnSync("/bin/ps", ["-ww", "-p", String(pid), "-o", "pgid=,stat=,lstart=,args="],
      { ...INSPECT_OPTIONS, env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
    const row = !result.error && result.status === 0 && typeof result.stdout === "string" &&
      /^\s*(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+?)\s*$/.exec(result.stdout);
    if (row) {
      if (row[2].startsWith("Z")) return "absent";
      // AcpClient spawns detached. A different process group proves PID reuse.
      if (Number(row[1]) !== pid) return "reused";
      startedAt = Date.parse(row[3] + " GMT");
      command = row[4];
      if (process.platform !== "linux") currentStart = `ps:${row[3]}`;
    }
  }
  if (!command) return pidExists(pid) ? "unknown" : "absent";
  const executable = job.acpExecutable ?? acpExecutable(job.request?.cwd ?? job.workspaceRoot ?? process.cwd());
  if (!matchesInvocation(command, executable)) return "reused";
  if (typeof job.acpProcessStart === "string" && job.acpProcessStart) {
    const start = currentStart !== undefined ? currentStart : processStartIdentity(pid);
    if (!start) return "unknown";
    return start === job.acpProcessStart ? "owned" : "reused";
  }
  const observation = job.acpProcessRecordedAt ?? job.turnSubmission?.at;
  const recordedAt = typeof observation === "string" ? Date.parse(observation) : NaN;
  if (!Number.isFinite(startedAt) || !Number.isFinite(recordedAt)) return "unknown";
  const windows = process.platform === "win32";
  const cutoff = windows ? recordedAt : Math.floor(recordedAt / 1000) * 1000;
  if (startedAt !== cutoff) return startedAt < cutoff ? "owned" : "reused";
  // ps rounds to seconds. If the registered child survived into a later
  // submission second, a replacement could not have been born in this one.
  const submittedAt = job.turnSubmission?.at;
  return !windows && typeof submittedAt === "string" && Date.parse(submittedAt) >= cutoff + 1000 ? "owned" : "unknown";
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
