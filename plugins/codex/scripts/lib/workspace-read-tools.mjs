import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { pathWithin } from "./permission-policy.mjs";

export const WORKSPACE_EXEC_CWD_ENV = "CODEX_COMPANION_BRIDGE_EXEC_CWD";
const GIT_TIMEOUT_MS = 10_000;
const GREP_MAX_BYTES = 256 * 1024;
const GIT_READ_MAX_BYTES = 64 * 1024;
const STDERR_MAX_BYTES = 16 * 1024;
const GREP_LINE_MAX_CHARS = 300;
const REV_PATTERN = /^[A-Za-z0-9._/~^@{}-]{1,100}$/;
const GIT_SAFE_FLAGS = [
  "-c", "core.fsmonitor=false",
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.pager=cat",
  "-c", "diff.external=",
  "-c", "color.ui=false",
  "--no-pager"
];

export const WORKSPACE_READ_TOOLS = [
  {
    name: "workspace_list",
    description: "List files and directories inside the job execution directory without a shell. Skips .git and does not follow symlinks.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, maxLength: 4096 },
        depth: { type: "integer", minimum: 1, maximum: 5 },
        limit: { type: "integer", minimum: 1, maximum: 2000 }
      },
      additionalProperties: false
    },
    annotations: { title: "List workspace files", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "workspace_grep",
    description: "Search workspace text files with git grep without a shell. Skips binary files and caps output at 256 KiB.",
    inputSchema: {
      type: "object",
      required: ["pattern"],
      properties: {
        pattern: { type: "string", minLength: 1, maxLength: 500 },
        path: { type: "string", minLength: 1, maxLength: 4096 },
        glob: { type: "string", minLength: 1, maxLength: 200 },
        ignore_case: { type: "boolean" },
        fixed: { type: "boolean" },
        max_results: { type: "integer", minimum: 1, maximum: 500 }
      },
      additionalProperties: false
    },
    annotations: { title: "Search workspace files", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "workspace_git_read",
    description: "Run read-only git status, log, diff or show inside the job execution directory without a shell. Output is capped at 64 KiB.",
    inputSchema: {
      type: "object",
      required: ["op"],
      properties: {
        op: { type: "string", enum: ["status", "log", "diff", "show"] },
        path: { type: "string", minLength: 1, maxLength: 4096 },
        rev: { type: "string", minLength: 1, maxLength: 100 },
        base: { type: "string", minLength: 1, maxLength: 100 },
        staged: { type: "boolean" },
        max_count: { type: "integer", minimum: 1, maximum: 50 }
      },
      additionalProperties: false
    },
    annotations: { title: "Read workspace git state", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }
];

export const WORKSPACE_READ_TOOL_NAMES = Object.freeze(WORKSPACE_READ_TOOLS.map(tool => tool.name));

export class WorkspaceToolError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkspaceToolError";
  }
}

export function resolveWorkspaceExecRoot(rawExecCwd) {
  if (typeof rawExecCwd !== "string" || !rawExecCwd || rawExecCwd.includes("\0") || !path.isAbsolute(rawExecCwd)) {
    return null;
  }
  try {
    const real = fs.realpathSync(rawExecCwd);
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

export function resolveWorkspacePath(workspaceRoot, inputPath = ".") {
  if (typeof inputPath !== "string" || !inputPath || inputPath.length > 4096 || inputPath.includes("\0")) {
    throw new WorkspaceToolError("path must be a non-empty string without NUL bytes.");
  }
  if (inputPath.split(/[\\/]/).includes("..")) {
    throw new WorkspaceToolError("path must not contain '..' traversal segments.");
  }
  const candidate = path.resolve(workspaceRoot, inputPath);
  let real;
  try {
    real = fs.realpathSync(candidate);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      if (!pathWithin(workspaceRoot, candidate)) {
        throw new WorkspaceToolError("path is outside the workspace execution directory.");
      }
      throw new WorkspaceToolError(`path does not exist inside the workspace: ${inputPath}`);
    }
    throw new WorkspaceToolError(`path cannot be resolved: ${error?.message ?? String(error)}`);
  }
  if (!pathWithin(workspaceRoot, real)) {
    const reason = path.isAbsolute(inputPath) && !pathWithin(workspaceRoot, candidate)
      ? "absolute path is outside the workspace execution directory."
      : "path resolves outside the workspace execution directory (for example via a symlink).";
    throw new WorkspaceToolError(reason);
  }
  const relative = path.relative(workspaceRoot, real);
  return { real, relative: relative ? relative.split(path.sep).join("/") : "" };
}

function assertPlainArgs(args, allowedKeys, toolName) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new WorkspaceToolError(`Invalid ${toolName} arguments: expected an object.`);
  }
  for (const key of Object.keys(args)) {
    if (!allowedKeys.includes(key)) {
      throw new WorkspaceToolError(`Invalid ${toolName} argument: unexpected key '${key}'.`);
    }
  }
}

function validateInt(value, fallback, min, max, label) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new WorkspaceToolError(`${label} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function validateRev(value, label) {
  if (typeof value !== "string" || !REV_PATTERN.test(value) || value.startsWith("-")) {
    throw new WorkspaceToolError(`Invalid ${label}: must be 1-100 safe ref characters and must not start with '-'.`);
  }
  return value;
}

function validateGlob(value) {
  if (typeof value !== "string" || !value || value.length > 200 || value.includes("\0")) {
    throw new WorkspaceToolError("glob must be a non-empty string up to 200 characters without NUL bytes.");
  }
  if (/^[:/\\-]/.test(value) || value.split(/[\\/]/).includes("..")) {
    throw new WorkspaceToolError("glob must be a relative pattern without '..' or pathspec magic.");
  }
  const normalized = value.startsWith("**/") ? value.slice(3) : value;
  if (!normalized || /^[:/\\-]/.test(normalized)) {
    throw new WorkspaceToolError("glob must specify a file pattern.");
  }
  return normalized;
}

function sanitizedGitEnv(baseEnv = process.env) {
  const env = { ...baseEnv, GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", PAGER: "cat" };
  delete env.GIT_EXTERNAL_DIFF;
  delete env.GIT_DIFF_OPTS;
  return env;
}

function runGitBounded(cwd, args, { maxBytes, timeoutMs = GIT_TIMEOUT_MS, env = process.env }) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: sanitizedGitEnv(env),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdoutChunks = [], stderrChunks = [];
    let stdoutBytes = 0, stderrBytes = 0, capped = false, timedOut = false, settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* process already exited */ }
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", chunk => {
      if (capped) return;
      if (stdoutBytes + chunk.length > maxBytes) {
        const remaining = maxBytes - stdoutBytes;
        if (remaining > 0) stdoutChunks.push(chunk.subarray(0, remaining));
        stdoutBytes = maxBytes;
        capped = true;
        try { child.kill("SIGKILL"); } catch { /* process already exited */ }
        return;
      }
      stdoutChunks.push(chunk);
      stdoutBytes += chunk.length;
    });
    child.stderr.on("data", chunk => {
      if (stderrBytes >= STDERR_MAX_BYTES) return;
      const slice = chunk.length > STDERR_MAX_BYTES - stderrBytes ? chunk.subarray(0, STDERR_MAX_BYTES - stderrBytes) : chunk;
      stderrChunks.push(slice);
      stderrBytes += slice.length;
    });
    child.once("error", error => finish(reject, error));
    child.once("close", (code, signal) => {
      let stdout = Buffer.concat(stdoutChunks).toString("utf8");
      if (capped) stdout = stdout.replace(/\ufffd+$/, "");
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      finish(resolve, { code, signal, stdout, stderr, capped, timedOut });
    });
  });
}

async function isInsideGitWorkTree(workspaceRoot) {
  const res = await runGitBounded(workspaceRoot, [...GIT_SAFE_FLAGS, "rev-parse", "--is-inside-work-tree"], { maxBytes: 1024 });
  return res.code === 0 && res.stdout.trim() === "true";
}

export function workspaceList(args, workspaceRoot) {
  assertPlainArgs(args, ["path", "depth", "limit"], "workspace_list");
  const { real, relative } = resolveWorkspacePath(workspaceRoot, args.path ?? ".");
  if (!fs.statSync(real).isDirectory()) {
    throw new WorkspaceToolError("workspace_list path must be a directory.");
  }
  const depth = validateInt(args.depth, 2, 1, 5, "depth");
  const limit = validateInt(args.limit, 500, 1, 2000, "limit");
  const entries = [];
  let truncated = false;
  function walk(dir, relPrefix, currentDepth) {
    let dirents;
    try { dirents = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (error) {
      if (currentDepth === 1) throw new WorkspaceToolError(`Cannot read directory: ${error?.message ?? String(error)}`);
      return;
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of dirents) {
      if (entry.name === ".git") continue;
      if (entries.length >= limit) { truncated = true; return; }
      const fullPath = path.join(dir, entry.name);
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      let isSymlink = entry.isSymbolicLink();
      let isDir = !isSymlink && entry.isDirectory();
      if (!isSymlink && !isDir && !entry.isFile()) {
        try {
          const lstat = fs.lstatSync(fullPath);
          isSymlink = lstat.isSymbolicLink();
          isDir = !isSymlink && lstat.isDirectory();
        } catch { /* treat as plain entry */ }
      }
      if (isSymlink) {
        entries.push(`${relPath} -> (symlink)`);
      } else if (isDir) {
        entries.push(`${relPath}/`);
        if (currentDepth < depth) walk(fullPath, relPath, currentDepth + 1);
        if (truncated) return;
      } else {
        entries.push(relPath);
      }
    }
  }
  walk(real, relative, 1);
  if (truncated) entries.push(`[truncated: limit of ${limit} entries reached]`);
  return entries.join("\n");
}

export async function workspaceGrep(args, workspaceRoot) {
  assertPlainArgs(args, ["pattern", "path", "glob", "ignore_case", "fixed", "max_results"], "workspace_grep");
  if (typeof args.pattern !== "string" || args.pattern.length < 1 || args.pattern.length > 500 || args.pattern.includes("\0")) {
    throw new WorkspaceToolError("pattern must be a string of 1-500 characters without NUL bytes.");
  }
  if (args.ignore_case !== undefined && typeof args.ignore_case !== "boolean") {
    throw new WorkspaceToolError("ignore_case must be a boolean.");
  }
  if (args.fixed !== undefined && typeof args.fixed !== "boolean") {
    throw new WorkspaceToolError("fixed must be a boolean.");
  }
  const maxResults = validateInt(args.max_results, 200, 1, 500, "max_results");
  const { real, relative } = resolveWorkspacePath(workspaceRoot, args.path ?? ".");
  let pathspec;
  if (args.glob !== undefined) {
    if (!fs.statSync(real).isDirectory()) throw new WorkspaceToolError("glob requires path to be a directory.");
    const glob = validateGlob(args.glob);
    pathspec = relative ? `${relative}/${glob}` : glob;
  } else {
    pathspec = relative || ".";
  }
  if (pathspec.startsWith(":")) pathspec = `./${pathspec}`;
  const inWorkTree = await isInsideGitWorkTree(workspaceRoot);
  const gitArgs = [
    ...GIT_SAFE_FLAGS, "grep",
    inWorkTree ? "--untracked" : "--no-index",
    "-n", "-I", "--no-color",
    ...(args.ignore_case ? ["-i"] : []),
    args.fixed ? "-F" : "-E",
    "-e", args.pattern, "--", pathspec
  ];
  const res = await runGitBounded(workspaceRoot, gitArgs, { maxBytes: GREP_MAX_BYTES });
  if (res.timedOut) throw new WorkspaceToolError("workspace_grep timed out after 10s.");
  if (!res.capped && res.code === 1) return "No matches.";
  if (!res.capped && res.code !== 0) throw new WorkspaceToolError(res.stderr || `git grep failed with exit code ${res.code}.`);
  const rawLines = res.stdout.split("\n");
  if (res.capped && rawLines.length > 1) rawLines.pop();
  const matches = [];
  let hitMaxResults = false;
  for (const line of rawLines) {
    if (!line) continue;
    if (matches.length >= maxResults) { hitMaxResults = true; break; }
    const m = /^(.+?):(\d+):(.*)$/.exec(line);
    if (m) {
      const rel = m[1].replace(/^\.\//, "");
      const body = m[3].replace(/\r$/, "");
      const cut = body.length > GREP_LINE_MAX_CHARS ? `${body.slice(0, GREP_LINE_MAX_CHARS - 1)}…` : body;
      matches.push(`${rel}:${m[2]}: ${cut}`);
    } else {
      const cut = line.length > GREP_LINE_MAX_CHARS ? `${line.slice(0, GREP_LINE_MAX_CHARS - 1)}…` : line;
      matches.push(cut);
    }
  }
  if (hitMaxResults && res.capped) matches.push(`[truncated: showing first ${maxResults} matches; output exceeded 256 KiB cap]`);
  else if (hitMaxResults) matches.push(`[truncated: showing first ${maxResults} matches]`);
  else if (res.capped) matches.push("[truncated: output exceeded 256 KiB cap]");
  return matches.length ? matches.join("\n") : "No matches.";
}

export async function workspaceGitRead(args, workspaceRoot) {
  assertPlainArgs(args, ["op", "path", "rev", "base", "staged", "max_count"], "workspace_git_read");
  if (!["status", "log", "diff", "show"].includes(args.op)) {
    throw new WorkspaceToolError("op must be one of: status, log, diff, show.");
  }
  const rev = args.rev !== undefined ? validateRev(args.rev, "rev") : undefined;
  const base = args.base !== undefined ? validateRev(args.base, "base") : undefined;
  if (args.staged !== undefined && typeof args.staged !== "boolean") {
    throw new WorkspaceToolError("staged must be a boolean.");
  }
  const maxCount = args.max_count !== undefined ? validateInt(args.max_count, 20, 1, 50, "max_count") : undefined;
  const rel = args.path !== undefined ? resolveWorkspacePath(workspaceRoot, args.path).relative : "";
  const rawPath = rel || ".";
  const safePath = rawPath.startsWith(":") ? `./${rawPath}` : rawPath;

  let subArgs;
  if (args.op === "status") {
    if (rev !== undefined || base !== undefined || args.staged === true || maxCount !== undefined) {
      throw new WorkspaceToolError("status accepts only the optional path argument.");
    }
    subArgs = ["status", "--short", "--branch", "--", safePath];
  } else if (args.op === "log") {
    if (args.staged === true) throw new WorkspaceToolError("staged is only supported for diff.");
    const range = base && rev ? `${base}..${rev}` : base ? `${base}..HEAD` : rev ?? null;
    subArgs = ["log", "--no-ext-diff", "--no-textconv", "--no-color", "-n", String(maxCount ?? 20), ...(range ? [range] : []), "--", safePath];
  } else if (args.op === "diff") {
    if (maxCount !== undefined) throw new WorkspaceToolError("max_count is only supported for log.");
    if (args.staged && rev !== undefined) throw new WorkspaceToolError("staged diff cannot be combined with rev; use base instead.");
    subArgs = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", ...(args.staged ? ["--cached"] : []), ...(base ? [base] : []), ...(rev ? [rev] : []), "--", safePath];
  } else {
    if (base !== undefined || args.staged === true || maxCount !== undefined) {
      throw new WorkspaceToolError("show accepts only optional rev and path arguments.");
    }
    subArgs = ["show", "--no-ext-diff", "--no-textconv", "--no-color", rev ?? "HEAD", "--", safePath];
  }

  const res = await runGitBounded(workspaceRoot, [...GIT_SAFE_FLAGS, ...subArgs], { maxBytes: GIT_READ_MAX_BYTES });
  if (res.timedOut) throw new WorkspaceToolError(`git ${args.op} timed out after 10s.`);
  if (!res.capped && res.code !== 0) {
    throw new WorkspaceToolError(res.stderr || `git ${args.op} failed with exit code ${res.code}.`);
  }
  return res.capped ? `${res.stdout}\n[truncated: output exceeded 64 KiB cap]` : res.stdout;
}

export async function callWorkspaceReadTool(name, args, workspaceRoot) {
  try {
    let text;
    if (name === "workspace_list") text = workspaceList(args, workspaceRoot);
    else if (name === "workspace_grep") text = await workspaceGrep(args, workspaceRoot);
    else if (name === "workspace_git_read") text = await workspaceGitRead(args, workspaceRoot);
    else throw new WorkspaceToolError(`Unknown workspace tool: ${name}`);
    return { content: [{ type: "text", text }], isError: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: message }], isError: true };
  }
}
