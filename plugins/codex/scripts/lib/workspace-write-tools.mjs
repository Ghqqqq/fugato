import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { randomBytes } from "node:crypto";
import { evaluatePath } from "./acp-policy.mjs";
import { pathWithin } from "./permission-policy.mjs";
import { resolveWorkspaceExecRoot } from "./workspace-read-tools.mjs";

export const WORKSPACE_WRITE_MAX_BYTES = 256 * 1024;
const MAX_REPORTED_MATCH_LINES = 10;
const MAX_MYERS_EDIT_DISTANCE = 4096;
const CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";

export const WORKSPACE_WRITE_TOOLS = [
  {
    name: "workspace_edit",
    description: "Edit an existing UTF-8 text file inside the job execution directory without a shell. Defaults to requiring a single unique match of target; returns an error with match count and line numbers instead of modifying the file on 0 or multiple matches. Set replace_all=true to replace all occurrences or expected_occurrences to assert an exact count. Refuses symlinks, .git paths, absolute or '..' paths, and results over 256 KiB.",
    inputSchema: {
      type: "object",
      required: ["path", "target", "replacement"],
      properties: {
        path: { type: "string", minLength: 1, maxLength: 4096 },
        target: { type: "string", minLength: 1, maxLength: WORKSPACE_WRITE_MAX_BYTES },
        replacement: { type: "string", maxLength: WORKSPACE_WRITE_MAX_BYTES },
        replace_all: { type: "boolean" },
        expected_occurrences: { type: "integer", minimum: 1, maximum: 10000 }
      },
      additionalProperties: false
    },
    annotations: { title: "Edit workspace file", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "workspace_write",
    description: "Create, overwrite, or append to a UTF-8 text file inside the job execution directory without a shell. Defaults to mode='create' (fails if the file already exists). Creates missing parent directories only inside the execution directory. Refuses symlinks, .git paths, absolute or '..' paths, and results over 256 KiB.",
    inputSchema: {
      type: "object",
      required: ["path", "content"],
      properties: {
        path: { type: "string", minLength: 1, maxLength: 4096 },
        content: { type: "string", maxLength: WORKSPACE_WRITE_MAX_BYTES },
        mode: { type: "string", enum: ["create", "overwrite", "append"] }
      },
      additionalProperties: false
    },
    annotations: { title: "Write workspace file", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }
];

export const WORKSPACE_WRITE_TOOL_NAMES = Object.freeze(WORKSPACE_WRITE_TOOLS.map(tool => tool.name));

export class WorkspaceWriteToolError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkspaceWriteToolError";
  }
}

function safeLstat(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

function isGitSegment(segment) {
  return CASE_INSENSITIVE_FS ? segment.toLowerCase() === ".git" : segment === ".git";
}

function assertPlainArgs(args, allowedKeys, toolName) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new WorkspaceWriteToolError(`Invalid ${toolName} arguments: expected an object.`);
  }
  for (const key of Object.keys(args)) {
    if (!allowedKeys.includes(key)) {
      throw new WorkspaceWriteToolError(`Invalid ${toolName} argument: unexpected key '${key}'.`);
    }
  }
}

function resolveConfinedWriteTarget(inputPath, executionRoot, env = process.env) {
  const root = resolveWorkspaceExecRoot(executionRoot);
  if (!root) {
    throw new WorkspaceWriteToolError("Invalid or unavailable workspace execution directory.");
  }
  if (typeof inputPath !== "string" || !inputPath || inputPath.length > 4096 || inputPath.includes("\0")) {
    throw new WorkspaceWriteToolError("path must be a non-empty string up to 4096 characters without NUL bytes.");
  }
  if (path.isAbsolute(inputPath) || inputPath.startsWith("/") || inputPath.startsWith("\\") || /^[A-Za-z]:/.test(inputPath)) {
    throw new WorkspaceWriteToolError("Absolute paths are refused; provide a workspace-relative path.");
  }
  if (inputPath === "~" || inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
    throw new WorkspaceWriteToolError("Home-relative '~' paths are refused; provide a workspace-relative path.");
  }
  if (inputPath.endsWith("/") || inputPath.endsWith("\\")) {
    throw new WorkspaceWriteToolError("path must refer to a file, not a directory.");
  }
  const rawSegments = inputPath.split(/[\\/]/);
  if (rawSegments.includes("..")) {
    throw new WorkspaceWriteToolError("path must not contain '..' traversal segments.");
  }
  if (rawSegments.some(isGitSegment)) {
    throw new WorkspaceWriteToolError("path must not reference '.git' metadata.");
  }
  const relSegments = rawSegments.filter(seg => seg !== "" && seg !== ".");
  if (!relSegments.length) {
    throw new WorkspaceWriteToolError("path must refer to a file inside the workspace.");
  }

  const relative = relSegments.join("/");
  const candidate = path.join(root, ...relSegments);
  if (!pathWithin(root, candidate)) {
    throw new WorkspaceWriteToolError("path escapes the workspace execution directory.");
  }

  // Enforce the shared ACP fail-closed write policy.
  const policy = evaluatePath({ target: candidate, executionCwd: root, access: "write", env });
  if (!policy.allowed) {
    throw new WorkspaceWriteToolError(`Write denied (${policy.code}): ${policy.reason}`);
  }

  // Refuse symlinks on every existing parent inside root as well as the target itself.
  let current = root;
  let existingTargetStat = null;
  for (let i = 0; i < relSegments.length; i++) {
    current = path.join(current, relSegments[i]);
    const stat = safeLstat(current);
    if (!stat) break;
    if (stat.isSymbolicLink()) {
      throw new WorkspaceWriteToolError(`Symlinks are refused for workspace writes: ${relSegments.slice(0, i + 1).join("/")}`);
    }
    const isLast = i === relSegments.length - 1;
    if (!isLast && !stat.isDirectory()) {
      throw new WorkspaceWriteToolError(`Parent path is not a directory: ${relSegments.slice(0, i + 1).join("/")}`);
    }
    if (isLast) {
      if (stat.isDirectory()) {
        throw new WorkspaceWriteToolError(`Target path is a directory, not a file: ${relative}`);
      }
      if (!stat.isFile()) {
        throw new WorkspaceWriteToolError(`Target path is not a regular file: ${relative}`);
      }
      existingTargetStat = stat;
    }
  }

  return { root, candidate, relative, relSegments, existingTargetStat };
}

function ensureParentsInsideRoot(root, relSegments) {
  const parentSegments = relSegments.slice(0, -1);
  let current = root;
  for (let i = 0; i < parentSegments.length; i++) {
    current = path.join(current, parentSegments[i]);
    if (!pathWithin(root, current)) {
      throw new WorkspaceWriteToolError("Refused creating directory outside workspace execution root.");
    }
    const stat = safeLstat(current);
    if (!stat) {
      fs.mkdirSync(current);
      const created = safeLstat(current);
      if (!created || created.isSymbolicLink() || !created.isDirectory()) {
        throw new WorkspaceWriteToolError(`Parent directory check failed: ${parentSegments.slice(0, i + 1).join("/")}`);
      }
    } else if (stat.isSymbolicLink()) {
      throw new WorkspaceWriteToolError(`Symlink parent directory refused: ${parentSegments.slice(0, i + 1).join("/")}`);
    } else if (!stat.isDirectory()) {
      throw new WorkspaceWriteToolError(`Parent path is not a directory: ${parentSegments.slice(0, i + 1).join("/")}`);
    }
  }
  const realParent = fs.realpathSync.native(current);
  if (!pathWithin(root, realParent)) {
    throw new WorkspaceWriteToolError("Parent directory resolves outside workspace execution root.");
  }
  return realParent;
}

function splitLines(text) {
  if (text === "") return [];
  const normalized = text.endsWith("\n") ? text.slice(0, -1) : text;
  return normalized.split("\n");
}

function diffLineCounts(oldText, newText) {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  let prefix = 0;
  const minLen = Math.min(oldLines.length, newLines.length);
  while (prefix < minLen && oldLines[prefix] === newLines[prefix]) prefix++;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > prefix && newEnd > prefix && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  const n = oldEnd - prefix;
  const m = newEnd - prefix;
  if (n === 0) return { added: m, removed: 0 };
  if (m === 0) return { added: 0, removed: n };
  const maxD = Math.min(n + m, MAX_MYERS_EDIT_DISTANCE);
  const offset = maxD + 1;
  const v = new Int32Array(2 * maxD + 3);
  for (let d = 0; d <= maxD; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && oldLines[prefix + x] === newLines[prefix + y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x === n && y === m) {
        return { added: (d + m - n) / 2, removed: (d - m + n) / 2 };
      }
    }
  }
  return { added: m, removed: n };
}

function findMatchOffsets(content, target) {
  const offsets = [];
  let from = 0;
  while (from <= content.length) {
    const index = content.indexOf(target, from);
    if (index === -1) break;
    offsets.push(index);
    from = index + target.length;
  }
  return offsets;
}

function lineNumberAt(content, offset) {
  let line = 1;
  for (let i = 0; i < offset; i++) {
    if (content.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function formatLineNumbers(content, offsets) {
  const sample = offsets.slice(0, MAX_REPORTED_MATCH_LINES).map(offset => lineNumberAt(content, offset));
  const extra = offsets.length - sample.length;
  const label = sample.length === 1 ? "line" : "lines";
  return `${label} ${sample.join(", ")}${extra > 0 ? ` (+${extra} more)` : ""}`;
}

function assertContentWithinCap(content) {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > WORKSPACE_WRITE_MAX_BYTES) {
    throw new WorkspaceWriteToolError(
      `Resulting content (${bytes} bytes) exceeds the ${WORKSPACE_WRITE_MAX_BYTES}-byte (256 KiB) limit.`
    );
  }
  return bytes;
}

function atomicWriteFile(targetPath, content, { existingStat = null, requireNotExists = false } = {}) {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const tmpPath = path.join(dir, `.${base}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
  const buffer = Buffer.from(content, "utf8");
  let fd;
  let tmpCreated = false;
  try {
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);
    const createMode = existingStat ? (existingStat.mode & 0o777) : 0o666;
    fd = fs.openSync(tmpPath, flags, createMode);
    tmpCreated = true;
    let written = 0;
    while (written < buffer.length) {
      written += fs.writeSync(fd, buffer, written, buffer.length - written);
    }
    if (existingStat && process.platform !== "win32") {
      fs.fchmodSync(fd, existingStat.mode & 0o777);
    }
    fs.closeSync(fd);
    fd = undefined;

    const currentTarget = safeLstat(targetPath);
    if (currentTarget?.isSymbolicLink()) {
      throw new WorkspaceWriteToolError("Refused atomic replace: target became a symlink.");
    }
    if (requireNotExists && currentTarget) {
      throw new WorkspaceWriteToolError("File already exists.");
    }
    fs.renameSync(tmpPath, targetPath);
    tmpCreated = false;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore close errors during cleanup */ }
    }
    if (tmpCreated) {
      try { fs.rmSync(tmpPath, { force: true }); } catch { /* ignore cleanup errors */ }
    }
  }
}

export function workspaceEdit(args, executionRoot, { env = process.env } = {}) {
  assertPlainArgs(args, ["path", "target", "replacement", "replace_all", "expected_occurrences"], "workspace_edit");
  if (typeof args.target !== "string" || args.target.length === 0) {
    throw new WorkspaceWriteToolError("target must be a non-empty string.");
  }
  if (typeof args.replacement !== "string") {
    throw new WorkspaceWriteToolError("replacement must be a string.");
  }
  if (args.replace_all !== undefined && typeof args.replace_all !== "boolean") {
    throw new WorkspaceWriteToolError("replace_all must be a boolean.");
  }
  if (args.expected_occurrences !== undefined &&
      (!Number.isSafeInteger(args.expected_occurrences) || args.expected_occurrences < 1)) {
    throw new WorkspaceWriteToolError("expected_occurrences must be a positive integer.");
  }

  const { candidate, relative, existingTargetStat } = resolveConfinedWriteTarget(args.path, executionRoot, env);
  if (!existingTargetStat) {
    throw new WorkspaceWriteToolError(`File does not exist inside workspace: ${relative}`);
  }
  const original = fs.readFileSync(candidate, "utf8");
  const offsets = findMatchOffsets(original, args.target);
  const count = offsets.length;
  const replaceAll = args.replace_all === true;
  const expected = args.expected_occurrences;

  if (count === 0) {
    const expectation = expected !== undefined ? ` (expected ${expected})` : "";
    throw new WorkspaceWriteToolError(
      `workspace_edit failed: target matched 0 occurrences in ${relative}${expectation}. File left unchanged.`
    );
  }
  if (expected !== undefined && count !== expected) {
    throw new WorkspaceWriteToolError(
      `workspace_edit failed: target matched ${count} occurrence${count === 1 ? "" : "s"} in ${relative} (expected ${expected}; matches at ${formatLineNumbers(original, offsets)}). File left unchanged.`
    );
  }
  if (expected === undefined && !replaceAll && count > 1) {
    throw new WorkspaceWriteToolError(
      `workspace_edit failed: target matched ${count} occurrences in ${relative} (expected 1; matches at ${formatLineNumbers(original, offsets)}). Provide more surrounding context, set replace_all=true, or specify expected_occurrences. File left unchanged.`
    );
  }

  // Use split/join so special `$` sequences in replacement are always literal.
  const updated = original.split(args.target).join(args.replacement);
  assertContentWithinCap(updated);

  atomicWriteFile(candidate, updated, { existingStat: existingTargetStat });
  const { added, removed } = diffLineCounts(original, updated);
  return {
    text: `Edited ${relative} (${count} replacement${count === 1 ? "" : "s"}, +${added} -${removed} lines).`,
    fileChange: { path: relative, kind: "edit", added, removed }
  };
}

export function workspaceWrite(args, executionRoot, { env = process.env } = {}) {
  assertPlainArgs(args, ["path", "content", "mode"], "workspace_write");
  if (typeof args.content !== "string") {
    throw new WorkspaceWriteToolError("content must be a string.");
  }
  const mode = args.mode ?? "create";
  if (!["create", "overwrite", "append"].includes(mode)) {
    throw new WorkspaceWriteToolError("mode must be one of: create, overwrite, append.");
  }

  const { root, candidate, relative, relSegments, existingTargetStat } = resolveConfinedWriteTarget(args.path, executionRoot, env);
  if (mode === "create" && existingTargetStat) {
    throw new WorkspaceWriteToolError(
      `File already exists: ${relative}. Use mode='overwrite' or workspace_edit to modify it.`
    );
  }

  let previous = "";
  let nextContent;
  if (mode === "append" && existingTargetStat) {
    if (existingTargetStat.size > WORKSPACE_WRITE_MAX_BYTES) {
      throw new WorkspaceWriteToolError(
        `Existing file (${existingTargetStat.size} bytes) already exceeds the ${WORKSPACE_WRITE_MAX_BYTES}-byte (256 KiB) limit.`
      );
    }
    previous = fs.readFileSync(candidate, "utf8");
    nextContent = previous + args.content;
  } else if (mode === "overwrite" && existingTargetStat) {
    previous = fs.readFileSync(candidate, "utf8");
    nextContent = args.content;
  } else {
    nextContent = args.content;
  }

  const bytes = assertContentWithinCap(nextContent);
  ensureParentsInsideRoot(root, relSegments);
  atomicWriteFile(candidate, nextContent, {
    existingStat: existingTargetStat,
    requireNotExists: mode === "create"
  });

  const { added, removed } = existingTargetStat
    ? diffLineCounts(previous, nextContent)
    : { added: splitLines(nextContent).length, removed: 0 };
  const verb = mode === "create" ? "Created" : mode === "overwrite" ? "Overwrote" : "Appended to";
  return {
    text: `${verb} ${relative} (+${added} -${removed} lines, ${bytes} bytes).`,
    fileChange: { path: relative, kind: mode, added, removed }
  };
}

export function callWorkspaceWriteTool(name, args, executionRoot, { env = process.env } = {}) {
  try {
    let outcome;
    if (name === "workspace_edit") {
      outcome = workspaceEdit(args, executionRoot, { env });
    } else if (name === "workspace_write") {
      outcome = workspaceWrite(args, executionRoot, { env });
    } else {
      throw new WorkspaceWriteToolError(`Unknown workspace write tool: ${name}`);
    }
    return {
      result: { content: [{ type: "text", text: outcome.text }], isError: false },
      fileChange: outcome.fileChange
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      result: { content: [{ type: "text", text: message }], isError: true }
    };
  }
}
