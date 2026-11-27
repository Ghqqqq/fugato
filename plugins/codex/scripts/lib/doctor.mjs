import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { AcpClient } from "./acp-client.mjs";
import { resolveAntigravityExecutable } from "./antigravity.mjs";
import { BROKER_BUSY_RPC_CODE, BROKER_ENDPOINT_ENV } from "./app-server.mjs";
import { parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { resolveClaudeConfigRoot } from "./claude-session-transfer.mjs";
import {
  codexRuntimeDiagnostic,
  executableOnPath,
  isolatedCodexCommand,
  resolveCodexRuntimeIdentity,
  resolveCodexSelection,
  resolveIsolatedCodexHome
} from "./codex-home.mjs";
import { cleanDisplayText } from "./display-text.mjs";
import { binaryAvailable } from "./process.mjs";
import { backendForModel } from "./roles.mjs";
import {
  defaultSandboxSetup,
  dispatchPreference,
  effectiveRoleTable,
  permissionMappingSetup,
  readNativeUnavailable,
  readPersonaModels,
  readRoleOverrides
} from "./setup-config.mjs";
import { resolveStateDir, resolveStateRoot } from "./state.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export const DOCTOR_PROBE_TIMEOUT_MS = 3000;

const PLUGIN_MANIFEST = JSON.parse(
  fs.readFileSync(new URL("../../.claude-plugin/plugin.json", import.meta.url), "utf8")
);
const NATIVE_UNAVAILABLE_TTL_MS = 24 * 60 * 60 * 1000;
const ADMISSION_LOCK_GRACE_MS = 60 * 1000;
const APPROVAL_WARN_BYTES = 10 * 1024 * 1024;
const LOCK_OWNER_PATTERN = /^owner-(\d+)-[a-f0-9-]+$/;
const ADMISSION_LOCK_PATTERN = /^[^.].*\.lock$/;
const ADMISSION_CANDIDATE_PATTERN = /^([^.].*\.lock)\.(owner-(\d+)-[a-f0-9-]+)$/;
const APPROVAL_JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,120}$/;
const SEMVER_PATTERN = /\bv?(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)\b/;

const SECRET_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi,
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bAIza[0-9A-Za-z_-]{10,}\b/g,
  /\bya29\.[0-9A-Za-z._-]{10,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{10,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:token|secret|password|passwd|api[_-]?key|cookie|authorization)\s*[:=]\s*[^\s,;'"}\]]+/gi
];

function sanitizeText(value, limit = 200) {
  let text = cleanDisplayText(value ?? "").replace(/\s+/g, " ").trim();
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, "[REDACTED]");
  }
  if (text.length > limit) {
    text = `${text.slice(0, Math.max(1, limit - 1))}…`;
  }
  return text;
}

function firstLine(value, limit = 120) {
  const line = String(value ?? "")
    .split(/\r?\n/)
    .map(part => part.trim())
    .find(Boolean) ?? "";
  return sanitizeText(line, limit);
}

function isPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function isDeadPid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}

function supportsOrderedReplay(version) {
  const match = typeof version === "string" && /^(\d+)\.(\d+)\.(\d+)(-[\w.-]+)?(?:\+[\w.-]+)?$/.exec(version);
  if (!match) return false;
  const [, major, minor, patch, prerelease] = match;
  if (Number(major) !== 1) return Number(major) > 1;
  if (Number(minor) !== 5) return Number(minor) > 5;
  return Number(patch) > 15 || (Number(patch) === 15 && !prerelease);
}

function extractSemver(text) {
  const match = SEMVER_PATTERN.exec(String(text ?? ""));
  return match ? match[1] : null;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function formatRemainingDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "<1m";
  const totalMinutes = Math.ceil(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

function regularFileExists(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    return !stat.isSymbolicLink() && stat.isFile();
  } catch {
    return false;
  }
}

function check(id, status, code, summary, fix = null) {
  return {
    id,
    status,
    code,
    summary: sanitizeText(summary, 320),
    fix: fix ? sanitizeText(fix, 320) : null
  };
}

function inspectCodexHome(env) {
  const userHome = env.HOME || env.USERPROFILE || os.homedir();
  const rawHome = env.CODEX_COMPANION_HOME || path.join(userHome, ".claude", "codex-isolated");
  let resolvedHome = null;
  try {
    resolvedHome = resolveIsolatedCodexHome(env);
  } catch (error) {
    return {
      resolvedHome: null,
      exists: false,
      valid: false,
      check: check(
        "codex.home",
        "fail",
        "codex_home_invalid",
        `Isolated Codex home configuration is invalid: ${error instanceof Error ? error.message : String(error)}.`,
        "Set CODEX_COMPANION_HOME to an absolute, dedicated directory that does not overlap ~/.codex."
      )
    };
  }

  let stat = null;
  try {
    stat = fs.lstatSync(rawHome);
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        resolvedHome,
        exists: false,
        valid: true,
        check: check(
          "codex.home",
          "warn",
          "codex_home_missing",
          "Isolated Codex home does not exist yet.",
          "Run `fugato setup` to initialize the isolated Codex home."
        )
      };
    }
    return {
      resolvedHome,
      exists: false,
      valid: false,
      check: check(
        "codex.home",
        "fail",
        "codex_home_unreadable",
        `Isolated Codex home cannot be inspected: ${error.code || error.message}.`,
        "Check permissions on the isolated Codex home directory or set CODEX_COMPANION_HOME."
      )
    };
  }

  if (stat.isSymbolicLink()) {
    return {
      resolvedHome,
      exists: true,
      valid: false,
      check: check(
        "codex.home",
        "fail",
        "codex_home_symlink",
        "Isolated Codex home must not be a symlink.",
        "Replace the symlink with a regular private directory (mode 0700) or set CODEX_COMPANION_HOME to a non-symlink directory."
      )
    };
  }

  if (!stat.isDirectory()) {
    return {
      resolvedHome,
      exists: true,
      valid: false,
      check: check(
        "codex.home",
        "fail",
        "codex_home_not_directory",
        "Isolated Codex home path exists but is not a directory.",
        "Remove the non-directory entry or set CODEX_COMPANION_HOME to a regular directory."
      )
    };
  }

  return {
    resolvedHome,
    exists: true,
    valid: true,
    check: check(
      "codex.home",
      "pass",
      "codex_home_ok",
      "Isolated Codex home exists and is a non-symlink directory."
    )
  };
}

function inspectCodexBinary(cwd, env, homeInfo, probeTimeoutMs) {
  if (!homeInfo.resolvedHome) {
    return {
      available: false,
      check: check(
        "codex.binary",
        "fail",
        "codex_selection_unavailable",
        "Skipped Codex runtime selection because isolated Codex home configuration is invalid.",
        "Fix CODEX_COMPANION_HOME first, then rerun `fugato doctor`."
      )
    };
  }

  let selection;
  try {
    selection = resolveCodexSelection(env);
  } catch (error) {
    return {
      available: false,
      check: check(
        "codex.binary",
        "fail",
        "codex_selection_invalid",
        `Codex binary selection failed: ${error instanceof Error ? error.message : String(error)}.`,
        "Fix or remove CODEX_COMPANION_BIN or runtime.json in the isolated Codex home."
      )
    };
  }

  const executable = path.isAbsolute(selection.binary)
    ? selection.binary
    : executableOnPath(selection.binary, env) ?? selection.binary;
  // Never call isolatedCodexEnv(): it creates the isolated home directory.
  const probeEnv = {
    ...env,
    CODEX_COMPANION_HOME: homeInfo.resolvedHome,
    CODEX_HOME: homeInfo.resolvedHome,
    CODEX_SQLITE_HOME: homeInfo.resolvedHome
  };

  const versionStatus = binaryAvailable(executable, ["--version"], {
    cwd,
    env: probeEnv,
    timeoutMs: probeTimeoutMs
  });
  if (!versionStatus.available) {
    const fix = selection.source === "PATH"
      ? "Install Codex with `npm install -g @openai/codex` or set CODEX_COMPANION_BIN, then rerun `fugato doctor`."
      : selection.source === "CODEX_COMPANION_BIN"
        ? "Fix or unset CODEX_COMPANION_BIN so it points to a working Codex executable."
        : "Fix or remove codexBinary in runtime.json under the isolated Codex home.";
    if (versionStatus.reason === "timeout") {
      return {
        available: false,
        check: check(
          "codex.binary",
          "fail",
          "codex_binary_timeout",
          `Codex --version probe timed out (${selection.source}).`,
          fix
        )
      };
    }
    return {
      available: false,
      check: check(
        "codex.binary",
        "fail",
        "codex_binary_missing",
        `Codex binary unavailable (${selection.source}): ${firstLine(versionStatus.detail, 120) || "not found"}.`,
        fix
      )
    };
  }

  const versionLine = firstLine(versionStatus.detail, 80) || "available";
  const appServerStatus = binaryAvailable(executable, ["app-server", "--help"], {
    cwd,
    env: probeEnv,
    timeoutMs: probeTimeoutMs
  });
  if (!appServerStatus.available) {
    return {
      available: false,
      check: check(
        "codex.binary",
        "fail",
        appServerStatus.reason === "timeout" ? "codex_app_server_timeout" : "codex_app_server_unavailable",
        `Codex ${versionLine} lacks working app-server support (${firstLine(appServerStatus.detail, 100)}).`,
        "Upgrade Codex with `npm install -g @openai/codex` or point CODEX_COMPANION_BIN to a Codex CLI with app-server support."
      )
    };
  }

  // Safe and read-only when availability.available is true.
  let warning = null;
  try {
    warning = codexRuntimeDiagnostic(cwd, { available: true }, env)?.warning ?? null;
  } catch { /* Non-fatal diagnostic check. */ }

  if (warning?.code === "desktop_managed_codex_runtime") {
    return {
      available: true,
      check: check(
        "codex.binary",
        "warn",
        "desktop_managed_codex_runtime",
        `Codex ${versionLine} (${selection.source}) is managed by a desktop app; app updates can stop active turns.`,
        "Pin a stable Codex CLI (for example npm @openai/codex) with CODEX_COMPANION_BIN or codexBinary in runtime.json."
      )
    };
  }

  return {
    available: true,
    check: check(
      "codex.binary",
      "pass",
      "codex_binary_ok",
      `Codex ${versionLine} (${selection.source}, app-server ready).`
    )
  };
}

function inspectPidLockDirectory(lockDir) {
  let stat;
  try {
    stat = fs.lstatSync(lockDir);
  } catch (error) {
    if (error.code === "ENOENT") return { present: false, stale: false, unsafe: false };
    return { present: true, stale: false, unsafe: true };
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return { present: true, stale: false, unsafe: true };
  }
  let entries;
  try {
    entries = fs.readdirSync(lockDir, { withFileTypes: true });
  } catch {
    return { present: true, stale: false, unsafe: true };
  }
  if (!entries.length) {
    return { present: true, stale: true, unsafe: false, mtimeMs: stat.mtimeMs };
  }
  let oldestMtimeMs = Infinity;
  let newestMtimeMs = 0;
  for (const entry of entries) {
    const match = LOCK_OWNER_PATTERN.exec(entry.name);
    if (!match || !isDeadPid(Number(match[1]))) {
      return { present: true, stale: false, unsafe: false };
    }
    const file = path.join(lockDir, entry.name);
    try {
      const fileStat = fs.lstatSync(file);
      if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
        return { present: true, stale: false, unsafe: true };
      }
      oldestMtimeMs = Math.min(oldestMtimeMs, fileStat.mtimeMs);
      newestMtimeMs = Math.max(newestMtimeMs, fileStat.mtimeMs);
    } catch {
      return { present: true, stale: false, unsafe: false };
    }
  }
  return { present: true, stale: true, unsafe: false, mtimeMs: newestMtimeMs || oldestMtimeMs };
}

function probeBrokerSocket(endpoint, { resolvedHome, env, timeoutMs, queryAuth }) {
  const result = {
    reachable: false,
    homeMatches: null,
    runtimeMatches: null,
    accountResponse: null,
    authBusy: false
  };
  if (!endpoint || timeoutMs <= 0) return Promise.resolve(result);
  let runtimeIdentity = null;
  try {
    runtimeIdentity = resolveCodexRuntimeIdentity(env);
  } catch { /* Missing binary must not hide broker reachability. */ }

  return new Promise(resolve => {
    let socket = null;
    let buffer = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket?.destroy();
      resolve(result);
    };
    const timer = setTimeout(finish, timeoutMs);
    let target;
    try {
      target = parseBrokerEndpoint(endpoint);
      socket = net.createConnection({ path: target.path });
    } catch {
      finish();
      return;
    }
    const send = message => {
      if (!socket.destroyed && socket.writable) {
        socket.write(`${JSON.stringify(message)}\n`);
      }
    };
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      result.reachable = true;
      send({
        id: 1,
        method: "initialize",
        params: { ...(runtimeIdentity ? { codexCompanionRuntime: runtimeIdentity } : {}) }
      });
    });
    socket.on("data", chunk => {
      buffer += chunk;
      for (let at; (at = buffer.indexOf("\n")) >= 0;) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          finish();
          return;
        }
        if (message?.id === 1 && message.result) {
          const identity = message.result;
          result.homeMatches = resolvedHome ? identity.codexCompanionHome === resolvedHome : null;
          result.runtimeMatches = runtimeIdentity && typeof identity.codexCompanionRuntime === "string"
            ? identity.codexCompanionRuntime === runtimeIdentity
            : null;
          if (!queryAuth || !result.homeMatches) {
            finish();
            return;
          }
          send({ method: "initialized", params: {} });
          send({ id: 2, method: "account/read", params: { refreshToken: false } });
        } else if (message?.id === 2) {
          if (message.error) {
            if (message.error.code === BROKER_BUSY_RPC_CODE) result.authBusy = true;
          } else {
            result.accountResponse = message.result ?? null;
          }
          finish();
          return;
        } else if (message?.error) {
          finish();
          return;
        }
      }
      if (buffer.length > 65536) finish();
    });
    socket.on("error", finish);
    socket.on("close", finish);
  });
}

async function inspectBroker(workspaceRoot, env, homeInfo, offline, probeTimeoutMs) {
  if (!homeInfo.resolvedHome || !homeInfo.valid) {
    return {
      probe: null,
      check: check(
        "runtime.broker",
        "pass",
        "broker_skipped_invalid_home",
        "Skipped broker inspection because isolated Codex home is invalid."
      )
    };
  }

  let staleLocks = 0;
  const lockRoot = path.join(homeInfo.resolvedHome, "duet", "broker-spawn");
  try {
    const lockRootStat = fs.lstatSync(lockRoot);
    if (!lockRootStat.isSymbolicLink() && lockRootStat.isDirectory()) {
      for (const entry of fs.readdirSync(lockRoot, { withFileTypes: true })) {
        const target = path.join(lockRoot, entry.name);
        const isLock = ADMISSION_LOCK_PATTERN.test(entry.name);
        const candidateMatch = isLock ? null : ADMISSION_CANDIDATE_PATTERN.exec(entry.name);
        if (!isLock && !candidateMatch) continue;
        if (candidateMatch && !isDeadPid(Number(candidateMatch[3]))) continue;
        const inspected = inspectPidLockDirectory(target);
        if (inspected.stale) staleLocks += 1;
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      return {
        probe: null,
        check: check(
          "runtime.broker",
          "warn",
          "broker_lock_dir_unreadable",
          `Could not inspect duet/broker-spawn: ${error.code || error.message}.`,
          "Check permissions on duet/broker-spawn under the isolated Codex home."
        )
      };
    }
  }

  const stateDir = resolveStateDir(workspaceRoot, env);
  const brokerFile = path.join(stateDir, "broker.json");
  let session = null;
  let corruptBrokerFile = false;
  try {
    const stat = fs.lstatSync(brokerFile);
    if (!stat.isSymbolicLink() && stat.isFile()) {
      session = JSON.parse(fs.readFileSync(brokerFile, "utf8"));
    }
  } catch (error) {
    if (error.code !== "ENOENT") corruptBrokerFile = true;
  }

  if (corruptBrokerFile) {
    return {
      probe: null,
      check: check(
        "runtime.broker",
        "warn",
        "broker_state_corrupt",
        "Recorded workspace broker.json is malformed or unreadable.",
        "Run `fugato runtime status` and remove the corrupt broker.json while idle; the next task creates a fresh broker."
      )
    };
  }

  const envEndpoint = env?.[BROKER_ENDPOINT_ENV]?.trim() || null;
  const endpoint = session?.endpoint || envEndpoint || null;
  let socketExists = false;
  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint);
      if (target.kind === "unix") {
        socketExists = Boolean(fs.lstatSync(target.path, { throwIfNoEntry: false }));
      }
    } catch { /* Malformed endpoint handled below as unreachable. */ }
  }

  const probe = endpoint
    ? await probeBrokerSocket(endpoint, {
      resolvedHome: homeInfo.resolvedHome,
      env,
      timeoutMs: Math.min(1500, probeTimeoutMs),
      queryAuth: !offline
    })
    : null;

  if (probe?.reachable && probe.homeMatches === false) {
    return {
      probe,
      check: check(
        "runtime.broker",
        "fail",
        "broker_home_mismatch",
        `Shared broker (pid ${session?.pid ?? "unknown"}) belongs to a different isolated Codex home.`,
        "Run `fugato runtime status` and restart the Claude session."
      )
    };
  }

  if (probe?.reachable && probe.runtimeMatches === false) {
    return {
      probe,
      check: check(
        "runtime.broker",
        "warn",
        "broker_runtime_stale",
        `Shared broker (pid ${session?.pid ?? "unknown"}) is running a different Codex binary than selected.${staleLocks ? ` Also found ${staleLocks} stale broker lock(s).` : ""}`,
        "Run `fugato runtime restart` when idle so the next task starts a fresh broker."
      )
    };
  }

  if ((session || envEndpoint) && !probe?.reachable) {
    const pidAlive = isPidAlive(session?.pid);
    const code = staleLocks > 0 ? "broker_stale_socket_and_lock" : "broker_stale_socket";
    return {
      probe,
      check: check(
        "runtime.broker",
        "warn",
        code,
        `Stale broker ${socketExists ? "socket" : "session"} (pid ${session?.pid ?? "unknown"}, ${pidAlive ? "process alive" : "process dead"}, unreachable)${staleLocks ? ` and ${staleLocks} stale broker spawn lock(s)` : ""}.`,
        `Run \`fugato runtime status\` to confirm no broker is active; remove the stale broker.json/socket${staleLocks ? " and duet/broker-spawn lock(s)" : ""} or start a task to recreate the broker.`
      )
    };
  }

  if (staleLocks > 0) {
    return {
      probe,
      check: check(
        "runtime.broker",
        "warn",
        "broker_stale_lock",
        `Found ${staleLocks} stale broker spawn lock(s) with dead owner PIDs.`,
        "Wait for the 30s dead-owner grace period or remove stale lock directories under duet/broker-spawn/ while no broker is starting."
      )
    };
  }

  if (probe?.reachable) {
    return {
      probe,
      check: check(
        "runtime.broker",
        "pass",
        "broker_ok",
        `Shared broker (pid ${session?.pid ?? "unknown"}) is reachable and matches the selected runtime.`
      )
    };
  }

  return {
    probe: null,
    check: check(
      "runtime.broker",
      "pass",
      "broker_idle",
      "No shared broker recorded for this workspace (starts on demand)."
    )
  };
}

function inspectCodexAuth(env, homeInfo, brokerProbe, offline) {
  if (offline) {
    return check("codex.auth", "pass", "codex_auth_skipped_offline", "Skipped (--offline).");
  }

  const loginHint = homeInfo.resolvedHome
    ? `Run \`${isolatedCodexCommand(["login"], env)}\` or \`fugato setup\` to sign in.`
    : "Run `fugato setup` to initialize the isolated Codex home and sign in.";

  // When a broker is already running for this isolated home, reuse its read-only response.
  if (brokerProbe?.reachable && brokerProbe.homeMatches && !brokerProbe.authBusy && brokerProbe.accountResponse) {
    const account = brokerProbe.accountResponse.account ?? null;
    const requiresOpenaiAuth = typeof brokerProbe.accountResponse.requiresOpenaiAuth === "boolean"
      ? brokerProbe.accountResponse.requiresOpenaiAuth
      : null;
    if (account?.type === "chatgpt") {
      return check("codex.auth", "pass", "codex_auth_ok", "Codex ChatGPT auth active (reported by running broker).");
    }
    if (account?.type === "apiKey") {
      return check("codex.auth", "pass", "codex_auth_api_key", "Codex API key auth present (reported by running broker; not verified).");
    }
    if (requiresOpenaiAuth === false) {
      return check("codex.auth", "pass", "codex_auth_provider_no_auth", "Configured Codex provider does not require OpenAI auth (reported by running broker).");
    }
    if (requiresOpenaiAuth === true) {
      return check("codex.auth", "fail", "codex_auth_unauthenticated", "Codex is not logged in (reported by running broker).", loginHint);
    }
  }

  // Zero spawned sessions even online: existence checks only, never read or print secrets.
  if (!homeInfo.resolvedHome || !homeInfo.valid || !homeInfo.exists) {
    return check(
      "codex.auth",
      "warn",
      "codex_auth_absent",
      "Codex auth absent (isolated home does not exist; not verified).",
      "Run `fugato setup` to initialize the isolated home and verify Codex login."
    );
  }

  const authPresent = regularFileExists(path.join(homeInfo.resolvedHome, "auth.json"));
  const configPresent = regularFileExists(path.join(homeInfo.resolvedHome, "config.toml"));
  const brokerNote = brokerProbe?.authBusy ? "running broker is busy" : "no running broker";

  if (authPresent) {
    return check(
      "codex.auth",
      "pass",
      "codex_auth_present_unverified",
      `Codex auth present (auth.json exists; not verified because ${brokerNote}).`
    );
  }

  if (configPresent) {
    return check(
      "codex.auth",
      "warn",
      "codex_auth_not_verified",
      `Codex auth.json absent while config.toml is present (not verified because ${brokerNote}).`,
      loginHint
    );
  }

  return check(
    "codex.auth",
    "warn",
    "codex_auth_absent",
    `Codex auth absent (auth.json and config.toml not found; not verified because ${brokerNote}).`,
    loginHint
  );
}

async function probeAntigravityInitialize(executable, cwd, env, probeTimeoutMs) {
  const client = new AcpClient(executable, cwd, {
    env,
    timeoutMs: probeTimeoutMs,
    exitGraceMs: 300
  });
  try {
    const result = await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "fugato", title: "Fugato", version: PLUGIN_MANIFEST.version ?? "0.0.0" }
    }, { timeoutMs: probeTimeoutMs });
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error };
  } finally {
    await client.close();
  }
}

async function inspectAntigravity(cwd, env, offline, probeTimeoutMs) {
  const executable = resolveAntigravityExecutable(cwd, env);
  const configuredBin = Boolean(env.FUGATO_ANTIGRAVITY_BIN);

  if (!executable) {
    return {
      available: false,
      checks: [
        check(
          "antigravity.binary",
          "warn",
          "antigravity_binary_missing",
          configuredBin
            ? "Configured FUGATO_ANTIGRAVITY_BIN was not found or is not executable; Gemini roles fall back to Codex."
            : "Antigravity CLI (agy) not found on PATH; Gemini roles fall back to Codex.",
          "Install Antigravity CLI (agy >= 1.5.15) or set FUGATO_ANTIGRAVITY_BIN, then sign in with `agy acp --login`."
        ),
        check(
          "antigravity.auth",
          "pass",
          "antigravity_auth_skipped_missing_binary",
          "Skipped (Antigravity CLI not installed)."
        )
      ]
    };
  }

  const versionProbe = binaryAvailable(executable, ["--version"], {
    cwd,
    env,
    timeoutMs: probeTimeoutMs
  });

  // Online mode runs one bounded ACP initialize (never session/new or session/prompt).
  const acpProbe = !offline && versionProbe.available
    ? await probeAntigravityInitialize(executable, cwd, env, probeTimeoutMs)
    : null;

  let binaryCheck;
  if (!versionProbe.available) {
    binaryCheck = check(
      "antigravity.binary",
      "warn",
      versionProbe.reason === "timeout" ? "antigravity_binary_timeout" : "antigravity_binary_unusable",
      versionProbe.reason === "timeout"
        ? "Antigravity CLI (agy) --version probe timed out."
        : `Antigravity CLI (agy) --version failed: ${firstLine(versionProbe.detail, 120) || "unusable"}.`,
      "Verify `agy --version` succeeds or update FUGATO_ANTIGRAVITY_BIN."
    );
  } else {
    const versionFromCli = extractSemver(versionProbe.detail);
    const versionFromAcp = acpProbe?.ok ? extractSemver(acpProbe.result?.agentInfo?.version) : null;
    const version = versionFromCli ?? versionFromAcp;
    if (!version) {
      binaryCheck = check(
        "antigravity.binary",
        "warn",
        "antigravity_version_unknown",
        "Antigravity CLI found, but version could not be parsed; Gemini continuation requires agy >= 1.5.15.",
        "Run `agy --version` and upgrade Antigravity CLI to 1.5.15 or later if continuation is needed."
      );
    } else if (!supportsOrderedReplay(version)) {
      binaryCheck = check(
        "antigravity.binary",
        "warn",
        "antigravity_version_too_old",
        `Antigravity CLI ${version} is below 1.5.15; Gemini continuation (--to/--continue/--resume-last) is unavailable.`,
        "Upgrade Antigravity CLI (agy) to 1.5.15 or later to enable Gemini session continuation."
      );
    } else {
      binaryCheck = check(
        "antigravity.binary",
        "pass",
        "antigravity_binary_ok",
        `Antigravity CLI ${version} found (continuation supported).`
      );
    }
  }

  let authCheck;
  if (offline) {
    authCheck = check(
      "antigravity.auth",
      "pass",
      "antigravity_auth_skipped_offline",
      "Skipped (--offline; no ACP initialize probe)."
    );
  } else if (!versionProbe.available) {
    authCheck = check(
      "antigravity.auth",
      "warn",
      "antigravity_auth_skipped_unusable_binary",
      "Skipped ACP initialize because agy --version failed.",
      "Fix `agy --version`, then sign in with `agy acp --login` if needed."
    );
  } else if (!acpProbe?.ok) {
    const error = acpProbe?.error;
    const detail = sanitizeText(error instanceof Error ? error.message : String(error ?? "ACP probe failed"), 140);
    if (error?.code === "ACP_REQUEST_TIMEOUT") {
      authCheck = check(
        "antigravity.auth",
        "warn",
        "antigravity_acp_timeout",
        `Antigravity ACP initialize timed out after ${probeTimeoutMs}ms.`,
        "Verify `agy acp --help` and sign in with `agy acp --login` if needed."
      );
    } else if (error?.rpcCode === -32000 || /authentication required/i.test(detail)) {
      authCheck = check(
        "antigravity.auth",
        "warn",
        "antigravity_auth_required",
        "Antigravity ACP reported authentication required.",
        "Run `agy acp --login` (or an interactive `agy` session) to sign in."
      );
    } else {
      authCheck = check(
        "antigravity.auth",
        "warn",
        "antigravity_acp_error",
        `Antigravity ACP initialize failed: ${detail}.`,
        "Verify `agy acp --help` and sign in with `agy acp --login` if needed."
      );
    }
  } else if (acpProbe.result?.protocolVersion !== 1) {
    authCheck = check(
      "antigravity.auth",
      "warn",
      "antigravity_acp_unsupported_version",
      `Antigravity negotiated unsupported ACP protocol version ${String(acpProbe.result?.protocolVersion ?? "unknown")}.`,
      "Upgrade Antigravity CLI (agy >= 1.5.15) and verify `agy acp --help`."
    );
  } else {
    const methods = Array.isArray(acpProbe.result?.authMethods)
      ? acpProbe.result.authMethods
        .map(method => sanitizeText(method?.name || method?.id || "", 60))
        .filter(Boolean)
      : [];
    const methodLabel = methods.length ? methods.join(", ") : "none advertised";
    authCheck = check(
      "antigravity.auth",
      "pass",
      "antigravity_acp_initialized",
      `Antigravity ACP v1 initialized (advertised auth methods: ${methodLabel}; sign-in is not verified by doctor; run \`agy acp --login\` if needed).`
    );
  }

  return {
    available: versionProbe.available,
    checks: [binaryCheck, authCheck]
  };
}

function inspectDispatch(env, homeInfo) {
  if (!homeInfo.resolvedHome || !homeInfo.valid) {
    return check(
      "dispatch.mode",
      "pass",
      "dispatch_skipped_invalid_home",
      "Skipped dispatch preference check because isolated Codex home is invalid."
    );
  }
  const dispatch = dispatchPreference(env);
  const unavailable = readNativeUnavailable(env);
  if (unavailable) {
    const observedMs = Date.parse(unavailable.at);
    const expiresMs = observedMs + NATIVE_UNAVAILABLE_TTL_MS;
    const expiresAt = new Date(expiresMs).toISOString();
    const remaining = formatRemainingDuration(expiresMs - Date.now());
    const resetRoute = dispatch === "auto" ? "auto" : dispatch;
    return check(
      "dispatch.mode",
      "warn",
      "native_unavailable_active",
      `Saved dispatch mode is '${dispatch}', with active native-unavailable.json marker (${unavailable.reason}, observed ${unavailable.at}, expires ${expiresAt} / in ${remaining})${dispatch === "auto" ? "; auto dispatch routes to Bash fallback" : ""}.`,
      `Run \`fugato setup --dispatch ${resetRoute}\` (or \`fugato setup --dispatch default\`) without \`--dry-run\` to clear native-unavailable.json.`
    );
  }
  if (dispatch === "bash") {
    return check(
      "dispatch.mode",
      "pass",
      "dispatch_mode_bash",
      "Saved dispatch mode: bash (no active native-unavailable.json marker)."
    );
  }
  return check(
    "dispatch.mode",
    "pass",
    "dispatch_mode_ok",
    `Saved dispatch mode: ${dispatch} (no active native-unavailable.json marker).`
  );
}

function findFugatoLivePlugin(env) {
  if (env.FUGATO_LIVE_PLUGIN_ROOT) {
    return { dir: path.resolve(env.FUGATO_LIVE_PLUGIN_ROOT), key: "fugato-live@fugato" };
  }
  const claudeRoot = resolveClaudeConfigRoot(env);
  const pluginsDir = path.join(claudeRoot, "plugins");
  const installedFile = path.join(pluginsDir, "installed_plugins.json");
  try {
    const stat = fs.lstatSync(installedFile);
    if (!stat.isSymbolicLink() && stat.isFile()) {
      const parsed = JSON.parse(fs.readFileSync(installedFile, "utf8"));
      const map = parsed?.plugins && typeof parsed.plugins === "object" && !Array.isArray(parsed.plugins)
        ? parsed.plugins
        : parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed
          : null;
      if (map) {
        for (const [key, value] of Object.entries(map)) {
          if (!/^(?:fugato-live|codex-live)(?:@|$)/.test(key)) continue;
          const entries = Array.isArray(value) ? value : [value];
          const entry = entries.find(item => item && typeof (item.installPath ?? item.path) === "string");
          if (entry) {
            return { dir: path.resolve(entry.installPath ?? entry.path), key };
          }
          return { dir: null, key };
        }
      }
    }
  } catch { /* Missing or malformed installed_plugins.json falls through to directory checks. */ }

  for (const name of ["fugato-live", "codex-live"]) {
    const candidate = path.join(pluginsDir, name);
    try {
      if (fs.statSync(candidate).isDirectory()) return { dir: candidate, key: `${name}@fugato` };
    } catch { /* Absent. */ }
  }

  const cacheDir = path.join(pluginsDir, "cache");
  try {
    if (fs.statSync(cacheDir).isDirectory()) {
      for (const marketplace of fs.readdirSync(cacheDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!marketplace.isDirectory()) continue;
        for (const pluginName of ["fugato-live", "codex-live"]) {
          const pluginDir = path.join(cacheDir, marketplace.name, pluginName);
          let versions = [];
          try {
            versions = fs.readdirSync(pluginDir, { withFileTypes: true })
              .filter(entry => entry.isDirectory())
              .map(entry => entry.name)
              .sort()
              .reverse();
          } catch { continue; }
          if (versions.length) {
            return { dir: path.join(pluginDir, versions[0]), key: `${pluginName}@${marketplace.name}` };
          }
        }
      }
    }
  } catch { /* Absent cache dir. */ }

  return null;
}

function isFugatoLiveDisabled(env, key) {
  const settingsFile = path.join(resolveClaudeConfigRoot(env), "settings.json");
  try {
    const stat = fs.lstatSync(settingsFile);
    if (stat.isSymbolicLink() || !stat.isFile()) return false;
    const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    const enabled = settings?.enabledPlugins;
    if (!enabled || typeof enabled !== "object" || Array.isArray(enabled)) return false;
    if (key && Object.hasOwn(enabled, key)) return enabled[key] === false;
    const matches = Object.entries(enabled).filter(([name]) => /^(?:fugato-live|codex-live)(?:@|$)/.test(name));
    return matches.length > 0 && matches.every(([, value]) => value === false);
  } catch {
    return false;
  }
}

function inspectFugatoLive(env) {
  const found = findFugatoLivePlugin(env);
  if (!found) {
    return check(
      "plugins.fugato_live",
      "warn",
      "fugato_live_missing",
      "Optional fugato-live companion plugin is not installed.",
      "Install the optional live pane plugin with `/plugin install fugato-live@fugato`."
    );
  }
  if (!found.dir) {
    return check(
      "plugins.fugato_live",
      "warn",
      "fugato_live_manifest_invalid",
      "fugato-live plugin entry is missing an install path.",
      "Reinstall fugato-live with `/plugin install fugato-live@fugato`."
    );
  }
  const manifestPath = path.join(found.dir, ".claude-plugin", "plugin.json");
  let manifest;
  try {
    if (!fs.statSync(manifestPath).isFile()) throw new Error("missing");
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return check(
      "plugins.fugato_live",
      "warn",
      "fugato_live_manifest_invalid",
      "fugato-live installation has a missing or unreadable .claude-plugin/plugin.json manifest.",
      "Reinstall fugato-live with `/plugin install fugato-live@fugato`."
    );
  }

  if (!manifest || typeof manifest !== "object" || manifest.name !== "fugato-live" || typeof manifest.version !== "string" || !manifest.version.trim()) {
    return check(
      "plugins.fugato_live",
      "warn",
      "fugato_live_manifest_invalid",
      "fugato-live .claude-plugin/plugin.json manifest is invalid (expected name 'fugato-live' and version).",
      "Reinstall fugato-live with `/plugin install fugato-live@fugato`."
    );
  }

  if (isFugatoLiveDisabled(env, found.key)) {
    return check(
      "plugins.fugato_live",
      "warn",
      "fugato_live_disabled",
      `fugato-live ${sanitizeText(manifest.version, 32)} is installed but disabled in Claude settings.`,
      "Enable fugato-live with `/plugin enable fugato-live@fugato`."
    );
  }

  return check(
    "plugins.fugato_live",
    "pass",
    "fugato_live_ok",
    `fugato-live ${sanitizeText(manifest.version, 32)} installed and manifest valid.`
  );
}

function inspectConfigConflicts(cwd, env, homeInfo) {
  if (!homeInfo.resolvedHome || !homeInfo.valid) {
    return [
      check(
        "config.permission_mapping",
        "pass",
        "permission_mapping_skipped_invalid_home",
        "Skipped permission_mapping check because isolated Codex home is invalid."
      ),
      check(
        "config.default_sandbox",
        "pass",
        "default_sandbox_skipped_invalid_home",
        "Skipped default_sandbox check because isolated Codex home is invalid."
      )
    ];
  }

  let geminiRoles = [];
  let geminiSeats = [];
  try {
    const roleTable = effectiveRoleTable({ env, cwd });
    const activeGeminiRoles = roleTable.roles
      .filter(row => row.backend === "antigravity")
      .map(row => row.id);
    const savedGeminiRoles = Object.entries(readRoleOverrides(env))
      .filter(([, override]) => override?.model && backendForModel(override.model) === "antigravity")
      .map(([id]) => id);
    geminiRoles = [...new Set([...activeGeminiRoles, ...savedGeminiRoles])];
    geminiSeats = Object.entries(readPersonaModels(env))
      .filter(([, override]) => override?.model && backendForModel(override.model) === "antigravity")
      .map(([id]) => id);
  } catch { /* Advisory role/persona parse errors are tolerated; config checks below still run. */ }

  const geminiTargets = [
    ...(geminiRoles.length ? [`Gemini roles (${geminiRoles.join(", ")})`] : []),
    ...(geminiSeats.length ? [`Gemini roundtable seats (${geminiSeats.join(", ")})`] : [])
  ];

  let permissionCheck;
  try {
    const { permissionMapping } = permissionMappingSetup({ env, dryRun: true });
    if (permissionMapping === "claude" && geminiTargets.length) {
      permissionCheck = check(
        "config.permission_mapping",
        "fail",
        "permission_mapping_gemini_conflict",
        `permission_mapping=claude conflicts with ${geminiTargets.join(" and ")}; Gemini tasks and seats are refused while Claude permission mapping is enabled.`,
        "Disable Claude permission mapping with `fugato setup --permission-mapping off`, or assign Codex models with `fugato setup --role-model <id>=<codex-model>` / `--persona-model <id>=<codex-model>`."
      );
    } else {
      permissionCheck = check(
        "config.permission_mapping",
        "pass",
        "permission_mapping_ok",
        permissionMapping === "claude"
          ? "permission_mapping=claude (no active Gemini roles or roundtable seats)."
          : "permission_mapping=off."
      );
    }
  } catch (error) {
    permissionCheck = check(
      "config.permission_mapping",
      "fail",
      "permission_mapping_invalid",
      `Invalid permission_mapping configuration: ${error instanceof Error ? error.message : String(error)}.`,
      "Repair with `fugato setup --permission-mapping off` or `fugato setup --permission-mapping claude`."
    );
  }

  let sandboxCheck;
  try {
    const { defaultSandbox } = defaultSandboxSetup({ env, dryRun: true });
    if (defaultSandbox !== "danger-full-access" && geminiTargets.length) {
      sandboxCheck = check(
        "config.default_sandbox",
        "warn",
        "default_sandbox_gemini_conflict",
        `default_sandbox is '${defaultSandbox}', which blocks ${geminiTargets.join(" and ")} unless --sandbox danger-full-access is passed explicitly.`,
        "Pass `--sandbox danger-full-access` on authorized Gemini tasks, or set `fugato setup --default-sandbox danger-full-access`."
      );
    } else {
      sandboxCheck = check(
        "config.default_sandbox",
        "pass",
        "default_sandbox_ok",
        `default_sandbox is '${defaultSandbox}'.`
      );
    }
  } catch (error) {
    sandboxCheck = check(
      "config.default_sandbox",
      "fail",
      "default_sandbox_invalid",
      `Invalid default_sandbox configuration: ${error instanceof Error ? error.message : String(error)}.`,
      "Repair with `fugato setup --default-sandbox danger-full-access` (or read-only / workspace-write)."
    );
  }

  return [permissionCheck, sandboxCheck];
}

function inspectAdmissionLocks(env, homeInfo) {
  if (!homeInfo.resolvedHome || !homeInfo.valid) {
    return check(
      "state.admission_locks",
      "pass",
      "admission_locks_skipped_invalid_home",
      "Skipped admission lock check because isolated Codex home is invalid."
    );
  }

  const root = path.join(homeInfo.resolvedHome, "duet", "antigravity-session-admission");
  let rootStat;
  try {
    rootStat = fs.lstatSync(root);
  } catch (error) {
    if (error.code === "ENOENT") {
      return check("state.admission_locks", "pass", "admission_locks_ok", "No dead-owner admission locks.");
    }
    return check(
      "state.admission_locks",
      "warn",
      "admission_locks_unreadable",
      `Could not inspect duet/antigravity-session-admission: ${error.code || error.message}.`,
      "Check permissions on duet/antigravity-session-admission under the isolated Codex home."
    );
  }

  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return check(
      "state.admission_locks",
      "warn",
      "admission_locks_unsafe",
      "duet/antigravity-session-admission is not a regular directory.",
      "Inspect and replace duet/antigravity-session-admission with a regular directory when idle."
    );
  }

  const graceCutoff = Date.now() - ADMISSION_LOCK_GRACE_MS;
  let deadCount = 0;
  let cleanableNow = 0;
  let liveCount = 0;
  let unsafeCount = 0;

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    const isLock = ADMISSION_LOCK_PATTERN.test(entry.name);
    const candidateMatch = isLock ? null : ADMISSION_CANDIDATE_PATTERN.exec(entry.name);
    if (!isLock && !candidateMatch) {
      unsafeCount += 1;
      continue;
    }
    const inspected = inspectPidLockDirectory(target);
    if (inspected.unsafe) {
      unsafeCount += 1;
      continue;
    }
    if (candidateMatch && !isDeadPid(Number(candidateMatch[3]))) {
      liveCount += 1;
      continue;
    }
    if (inspected.stale) {
      deadCount += 1;
      if (inspected.mtimeMs != null && inspected.mtimeMs < graceCutoff) cleanableNow += 1;
    } else if (inspected.present) {
      liveCount += 1;
    }
  }

  if (deadCount > 0) {
    return check(
      "state.admission_locks",
      "warn",
      "admission_locks_dead_owner",
      `Found ${deadCount} dead-owner Antigravity admission lock(s)${cleanableNow < deadCount ? ` (${cleanableNow} past 60s cleanup grace)` : ""}${liveCount ? `; ${liveCount} live` : ""}.`,
      "Run `fugato cleanup` to remove dead-owner Antigravity admission locks (locks become eligible after 60s)."
    );
  }

  if (unsafeCount > 0) {
    return check(
      "state.admission_locks",
      "warn",
      "admission_locks_unsafe",
      `Found ${unsafeCount} unexpected or symlinked entry/entries in duet/antigravity-session-admission.`,
      "Inspect duet/antigravity-session-admission and remove unexpected entries."
    );
  }

  return check(
    "state.admission_locks",
    "pass",
    "admission_locks_ok",
    liveCount ? `${liveCount} live Antigravity admission lock(s); no dead-owner locks.` : "No dead-owner admission locks."
  );
}

function readWorkspaceJobIdsReadOnly(workspaceDir) {
  const ids = new Set();
  const stateFile = path.join(workspaceDir, "state.json");
  try {
    const stat = fs.lstatSync(stateFile);
    if (!stat.isSymbolicLink() && stat.isFile()) {
      const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      if (Array.isArray(parsed?.jobs)) {
        for (const job of parsed.jobs) {
          if (typeof job?.id === "string" && APPROVAL_JOB_ID_PATTERN.test(job.id)) ids.add(job.id);
        }
      }
    }
  } catch { /* Fall back to jobs directory scan. */ }

  const jobsDir = path.join(workspaceDir, "jobs");
  try {
    const stat = fs.lstatSync(jobsDir);
    if (!stat.isSymbolicLink() && stat.isDirectory()) {
      for (const entry of fs.readdirSync(jobsDir, { withFileTypes: true })) {
        if (!entry.name.endsWith(".json") || entry.name.endsWith(".result.json") || entry.name.endsWith(".steering.json")) continue;
        const id = entry.name.slice(0, -5);
        if (APPROVAL_JOB_ID_PATTERN.test(id)) ids.add(id);
      }
    }
  } catch { /* Absent jobs directory. */ }

  return ids;
}

function inspectApprovalArtifacts(env, homeInfo) {
  if (!homeInfo.resolvedHome || !homeInfo.valid) {
    return check(
      "state.approval_artifacts",
      "pass",
      "approval_artifacts_skipped_invalid_home",
      "Skipped approval artifacts check because isolated Codex home is invalid."
    );
  }

  const stateRoot = resolveStateRoot(env);
  let rootStat;
  try {
    rootStat = fs.lstatSync(stateRoot);
  } catch (error) {
    if (error.code === "ENOENT") {
      return check("state.approval_artifacts", "pass", "approval_artifacts_ok", "Staged approval artifacts: 0 files, 0 B.");
    }
    return check(
      "state.approval_artifacts",
      "warn",
      "approval_artifacts_unreadable",
      `Could not inspect staged approval artifacts: ${error.code || error.message}.`,
      "Check permissions on duet/state under the isolated Codex home."
    );
  }

  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return check(
      "state.approval_artifacts",
      "warn",
      "approval_artifacts_unsafe",
      "Isolated state root is not a regular directory.",
      "Inspect duet/state under the isolated Codex home."
    );
  }

  let totalFiles = 0;
  let totalDirs = 0;
  let totalBytes = 0;
  let orphanDirs = 0;
  let orphanBytes = 0;

  for (const wsEntry of fs.readdirSync(stateRoot, { withFileTypes: true })) {
    if (wsEntry.isSymbolicLink() || !wsEntry.isDirectory()) continue;
    const workspaceDir = path.join(stateRoot, wsEntry.name);
    const approvalsDir = path.join(workspaceDir, "approvals");
    let approvalsStat;
    try {
      approvalsStat = fs.lstatSync(approvalsDir);
    } catch { continue; }
    if (approvalsStat.isSymbolicLink() || !approvalsStat.isDirectory()) continue;

    const existingIds = readWorkspaceJobIdsReadOnly(workspaceDir);
    for (const jobEntry of fs.readdirSync(approvalsDir, { withFileTypes: true })) {
      if (jobEntry.isSymbolicLink() || !jobEntry.isDirectory()) continue;
      const jobDir = path.join(approvalsDir, jobEntry.name);
      totalDirs += 1;
      let dirBytes = 0;
      try {
        for (const fileEntry of fs.readdirSync(jobDir, { withFileTypes: true })) {
          const filePath = path.join(jobDir, fileEntry.name);
          const fileStat = fs.lstatSync(filePath, { throwIfNoEntry: false });
          if (!fileStat || fileStat.isSymbolicLink() || !fileStat.isFile()) continue;
          totalFiles += 1;
          dirBytes += fileStat.size;
        }
      } catch { /* Ignore unreadable subdirectories during scan. */ }
      totalBytes += dirBytes;
      if (!existingIds.has(jobEntry.name)) {
        orphanDirs += 1;
        orphanBytes += dirBytes;
      }
    }
  }

  if (orphanDirs > 0 || totalBytes >= APPROVAL_WARN_BYTES) {
    const code = orphanDirs > 0 ? "approval_artifacts_orphaned" : "approval_artifacts_large";
    return check(
      "state.approval_artifacts",
      "warn",
      code,
      `Staged approval artifacts: ${totalFiles} file(s), ${formatBytes(totalBytes)} across ${totalDirs} job dir(s)${orphanDirs ? ` (${orphanDirs} orphaned, ${formatBytes(orphanBytes)})` : ""}.`,
      "Run `fugato cleanup --dry-run` then `fugato cleanup` to reclaim orphaned or expired staged approval artifacts."
    );
  }

  return check(
    "state.approval_artifacts",
    "pass",
    "approval_artifacts_ok",
    `Staged approval artifacts: ${totalFiles} file(s), ${formatBytes(totalBytes)}.`
  );
}

function inspectWorkspaceState(workspaceRoot, env, homeInfo) {
  if (!homeInfo.resolvedHome || !homeInfo.valid) {
    return check(
      "state.workspace",
      "pass",
      "state_workspace_skipped_invalid_home",
      "Skipped workspace state check because isolated Codex home is invalid."
    );
  }

  const stateDir = resolveStateDir(workspaceRoot, env);
  const lockInfo = inspectPidLockDirectory(path.join(stateDir, ".state-lock"));

  let activeJobs = 0;
  let totalJobs = 0;
  let indexError = false;
  const stateFile = path.join(stateDir, "state.json");
  try {
    const stat = fs.lstatSync(stateFile);
    if (!stat.isSymbolicLink() && stat.isFile()) {
      const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || (parsed.jobs !== undefined && !Array.isArray(parsed.jobs))) {
        indexError = true;
      } else {
        const jobs = parsed.jobs ?? [];
        totalJobs = jobs.length;
        activeJobs = jobs.filter(job => job && ["queued", "running"].includes(job.status)).length;
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") indexError = true;
  }

  if (indexError) {
    return check(
      "state.workspace",
      "warn",
      "state_index_unreadable",
      "Workspace state.json is malformed or unreadable.",
      "Run `fugato status` to inspect or trigger safe index recovery, or `fugato cleanup --dry-run`."
    );
  }

  if (lockInfo.stale) {
    return check(
      "state.workspace",
      "warn",
      "state_lock_stale",
      `Workspace .state-lock has a dead owner PID (${activeJobs} active job(s), ${totalJobs} recorded).`,
      "The next state operation reclaims a dead .state-lock automatically; run `fugato status` or `fugato cleanup --dry-run`."
    );
  }

  return check(
    "state.workspace",
    "pass",
    "state_workspace_ok",
    `Workspace state healthy (${activeJobs} active job(s), ${totalJobs} recorded).`
  );
}

/**
 * Strictly read-only diagnostic check of Codex, Antigravity, dispatch, plugins,
 * config compatibility, broker, admission locks and state health.
 *
 * @param {{ cwd?: string, offline?: boolean, env?: NodeJS.ProcessEnv, probeTimeoutMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, checks: Array<{ id: string, status: "pass" | "warn" | "fail", code: string, summary: string, fix: string | null }> }>}
 */
export async function runDoctor({
  cwd = process.cwd(),
  offline = false,
  env = process.env,
  probeTimeoutMs = DOCTOR_PROBE_TIMEOUT_MS
} = {}) {
  const effectiveCwd = path.resolve(cwd);
  const workspaceRoot = resolveWorkspaceRoot(effectiveCwd);
  const timeoutMs = Number.isFinite(probeTimeoutMs) && probeTimeoutMs > 0 ? probeTimeoutMs : DOCTOR_PROBE_TIMEOUT_MS;

  const homeInfo = inspectCodexHome(env);
  const codexBinary = inspectCodexBinary(effectiveCwd, env, homeInfo, timeoutMs);
  const [brokerInfo, antigravityInfo] = await Promise.all([
    inspectBroker(workspaceRoot, env, homeInfo, offline, timeoutMs),
    inspectAntigravity(effectiveCwd, env, offline, timeoutMs)
  ]);

  const codexAuthCheck = inspectCodexAuth(env, homeInfo, brokerInfo.probe, offline);
  const dispatchCheck = inspectDispatch(env, homeInfo);
  const liveCheck = inspectFugatoLive(env);
  const configChecks = inspectConfigConflicts(effectiveCwd, env, homeInfo);
  const admissionCheck = inspectAdmissionLocks(env, homeInfo);
  const approvalCheck = inspectApprovalArtifacts(env, homeInfo);
  const workspaceCheck = inspectWorkspaceState(workspaceRoot, env, homeInfo);

  const checks = [
    codexBinary.check,
    homeInfo.check,
    codexAuthCheck,
    ...antigravityInfo.checks,
    dispatchCheck,
    liveCheck,
    ...configChecks,
    brokerInfo.check,
    admissionCheck,
    approvalCheck,
    workspaceCheck
  ];

  return {
    ok: checks.every(entry => entry.status !== "fail"),
    checks
  };
}

export function renderDoctorReport(report) {
  const checks = Array.isArray(report?.checks) ? report.checks : [];
  const counts = {
    pass: checks.filter(item => item.status === "pass").length,
    warn: checks.filter(item => item.status === "warn").length,
    fail: checks.filter(item => item.status === "fail").length
  };
  const header = `Fugato Doctor: ${report?.ok ? (counts.warn ? "OK (with warnings)" : "OK") : "ISSUES FOUND"} (${counts.pass} pass, ${counts.warn} warn, ${counts.fail} fail)`;
  const idWidth = Math.max("CHECK".length, ...checks.map(item => item.id.length));
  const codeWidth = Math.max("CODE".length, ...checks.map(item => item.code.length));
  const lines = [
    header,
    `${"STATUS".padEnd(6)} | ${"CHECK".padEnd(idWidth)} | ${"CODE".padEnd(codeWidth)} | SUMMARY`,
    `${"-".repeat(6)} | ${"-".repeat(idWidth)} | ${"-".repeat(codeWidth)} | -------`
  ];
  for (const item of checks) {
    const status = item.status.toUpperCase().padEnd(6);
    lines.push(`${status} | ${item.id.padEnd(idWidth)} | ${item.code.padEnd(codeWidth)} | ${item.summary}`);
    if (item.fix) {
      lines.push(`         Fix: ${item.fix}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
