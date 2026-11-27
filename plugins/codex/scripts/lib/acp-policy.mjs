import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { resolveIsolatedCodexHome } from "./codex-home.mjs";
import { pathWithin } from "./permission-policy.mjs";
import { nearestGitBoundary } from "./workspace.mjs";

const MAX_SYMLINK_DEPTH = 40;
const MAX_COMMAND_DEPTH = 3;
const CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";

const NPM_VALUE_FLAGS = new Set([
  "--prefix", "-C", "--cwd", "--registry", "--loglevel", "--userconfig",
  "--globalconfig", "--cache", "-w", "--workspace", "--script-shell", "--location"
]);

const GIT_VALUE_FLAGS = new Set([
  "-C", "-c", "--git-dir", "--work-tree", "--namespace",
  "--super-prefix", "--config-env", "--exec-path", "--attr-source"
]);

const SHELL_WRAPPERS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const COMMAND_PREFIXES = new Set(["command", "exec", "nohup", "time"]);
const PROTECTED_HOME_SUBDIRS = [".claude", ".codex", ".gemini"];

function safeLstat(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

function resolveUserHome(env = process.env) {
  return env?.HOME || env?.USERPROFILE || os.homedir();
}

function expandLeadingTilde(targetPath, userHome) {
  if (targetPath === "~") return userHome;
  if (targetPath.startsWith("~/") || targetPath.startsWith("~\\")) {
    return path.join(userHome, targetPath.slice(2));
  }
  return targetPath;
}

function isGitSegment(segment) {
  return CASE_INSENSITIVE_FS ? segment.toLowerCase() === ".git" : segment === ".git";
}

function hasGitComponent(filePath) {
  return filePath.split(/[\\/]/).some(isGitSegment);
}

// Canonicalise an absolute path via realpath, or for a not-yet-existing path
// resolve the nearest existing ancestor (following dangling symlinks too) plus
// the remaining segments.
function canonicalizeExistingOrAncestor(absPath, depth = 0) {
  if (depth > MAX_SYMLINK_DEPTH) {
    throw Object.assign(new Error("Too many symbolic links encountered while resolving path."), { code: "ELOOP" });
  }
  try {
    return fs.realpathSync.native(absPath);
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
  }
  const tail = [];
  let current = absPath;
  for (;;) {
    const stat = safeLstat(current);
    if (stat) {
      if (stat.isSymbolicLink()) {
        const linkTarget = fs.readlinkSync(current);
        const parentReal = canonicalizeExistingOrAncestor(path.dirname(current), depth + 1);
        const combined = tail.length ? `${linkTarget}${path.sep}${tail.join(path.sep)}` : linkTarget;
        return resolveCanonical(combined, parentReal, depth + 1);
      }
      const realCurrent = fs.realpathSync.native(current);
      return tail.length ? path.join(realCurrent, ...tail) : realCurrent;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return tail.length ? path.join(current, ...tail) : current;
    }
    tail.unshift(path.basename(current));
    current = parent;
  }
}

// Resolve target against baseDir, walking component-by-component when '..' is
// present so symlink/.. follows the symlink before stepping up (matching POSIX).
function resolveCanonical(inputPath, baseDir, depth = 0) {
  if (depth > MAX_SYMLINK_DEPTH) {
    throw Object.assign(new Error("Too many symbolic links encountered while resolving path."), { code: "ELOOP" });
  }
  const parts = inputPath.split(/[\\/]+/);
  if (!parts.includes("..")) {
    const abs = path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(baseDir, inputPath);
    return canonicalizeExistingOrAncestor(abs, depth);
  }
  const parsed = path.isAbsolute(inputPath) ? path.parse(inputPath) : null;
  let current = parsed ? parsed.root : baseDir;
  const remainder = parsed ? inputPath.slice(parsed.root.length) : inputPath;
  const segments = remainder.split(/[\\/]+/).filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === ".") continue;
    if (seg === "..") {
      current = canonicalizeExistingOrAncestor(current, depth);
      current = path.dirname(current);
      continue;
    }
    const next = path.join(current, seg);
    const stat = safeLstat(next);
    if (stat?.isSymbolicLink()) {
      const linkTarget = fs.readlinkSync(next);
      const parentReal = canonicalizeExistingOrAncestor(current, depth + 1);
      const rest = segments.slice(i + 1);
      const combined = rest.length ? `${linkTarget}${path.sep}${rest.join(path.sep)}` : linkTarget;
      return resolveCanonical(combined, parentReal, depth + 1);
    }
    current = next;
  }
  return canonicalizeExistingOrAncestor(current, depth);
}

function resolveCanonicalDir(dirPath) {
  if (typeof dirPath !== "string" || !dirPath || dirPath.includes("\0")) return null;
  try {
    const real = fs.realpathSync.native(path.resolve(dirPath));
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

function resolveGitMetadataDirs(canonicalCwd) {
  const dirs = new Set();
  const boundary = nearestGitBoundary(canonicalCwd);
  if (!boundary) return [];
  const dotGit = path.join(boundary, ".git");
  const stat = safeLstat(dotGit);
  if (!stat) return [];
  try {
    if (stat.isDirectory()) {
      dirs.add(fs.realpathSync.native(dotGit));
    } else if (stat.isSymbolicLink()) {
      dirs.add(resolveCanonical(dotGit, boundary));
    } else if (stat.isFile()) {
      dirs.add(fs.realpathSync.native(dotGit));
      const raw = fs.readFileSync(dotGit, "utf8");
      const match = /^gitdir:\s*(.+?)\s*$/m.exec(raw);
      if (match) {
        const gitdir = resolveCanonical(match[1], boundary);
        dirs.add(gitdir);
        const commonFile = path.join(gitdir, "commondir");
        const commonStat = safeLstat(commonFile);
        if (commonStat?.isFile()) {
          const commonRaw = fs.readFileSync(commonFile, "utf8").trim();
          if (commonRaw) {
            dirs.add(resolveCanonical(commonRaw, gitdir));
          }
        }
      }
    }
  } catch {
    // Retain any directories already resolved; .git path segments stay denied regardless.
  }
  return [...dirs];
}

function resolveProtectedHomes(env = process.env) {
  const userHome = resolveUserHome(env);
  const canonicalHome = resolveCanonical(userHome, "/");
  const roots = new Set();
  const literalPrefixes = new Set();
  for (const subdir of PROTECTED_HOME_SUBDIRS) {
    const rawRoot = path.join(userHome, subdir);
    const canonicalRoot = resolveCanonical(rawRoot, "/");
    roots.add(canonicalRoot);
    literalPrefixes.add(rawRoot);
    literalPrefixes.add(canonicalRoot);
  }
  let isolatedHome = null;
  let isolatedError = null;
  try {
    isolatedHome = resolveCanonical(resolveIsolatedCodexHome(env), "/");
    roots.add(isolatedHome);
    literalPrefixes.add(isolatedHome);
    if (typeof env?.CODEX_COMPANION_HOME === "string" && path.isAbsolute(env.CODEX_COMPANION_HOME)) {
      literalPrefixes.add(path.resolve(env.CODEX_COMPANION_HOME));
    }
  } catch (error) {
    isolatedError = error instanceof Error ? error.message : String(error);
    if (typeof env?.CODEX_COMPANION_HOME === "string" && path.isAbsolute(env.CODEX_COMPANION_HOME)) {
      const fallback = resolveCanonical(env.CODEX_COMPANION_HOME, "/");
      roots.add(fallback);
      literalPrefixes.add(path.resolve(env.CODEX_COMPANION_HOME));
      literalPrefixes.add(fallback);
    }
  }
  return {
    userHome,
    canonicalHome,
    isolatedHome,
    isolatedError,
    roots: [...roots],
    literalPrefixes: [...literalPrefixes].sort((a, b) => b.length - a.length)
  };
}

/**
 * Fail-closed path boundary policy for Antigravity ACP tool calls and parent-bridge tools.
 *
 * IMPORTANT: Returning `{ allowed: true }` means ONLY that the path passes the
 * boundary gate. It is NOT auto-approval; built-in ACP tools still park for chair
 * approval unless separately auto-allowed by the parent-bridge or grant layer.
 *
 * Rules are evaluated in strict order:
 *   (a) Target inside canonical executionCwd -> allowed (writes deny any `.git`
 *       component and resolved gitdir/commondir with code `git_metadata_write`;
 *       reads of `.git` inside the worktree are allowed).
 *   (b) Otherwise, target inside ~/.claude, ~/.codex, ~/.gemini or
 *       resolveIsolatedCodexHome(env) -> denied with code `protected_home`
 *       (both read and write; blocks sibling roundtable worktrees).
 *   (c) Otherwise, access === "write" outside executionCwd -> denied with code
 *       `outside_workspace` (or `git_metadata_write` for resolved gitdir/commondir
 *       or `.git` components). Reads elsewhere -> allowed.
 */
/** @param {{ target?: string, executionCwd?: string, access?: string, env?: NodeJS.ProcessEnv }} [options] */
export function evaluatePath({ target, executionCwd, access, env = process.env } = {}) {
  if (access !== "read" && access !== "write") {
    return { allowed: false, code: "invalid_access", reason: "Access mode must be 'read' or 'write'." };
  }
  if (typeof target !== "string" || !target || target.includes("\0")) {
    return { allowed: false, code: "invalid_path", reason: "Target path must be a non-empty string without NUL bytes." };
  }
  const canonicalCwd = resolveCanonicalDir(executionCwd);
  if (!canonicalCwd) {
    return { allowed: false, code: "invalid_execution_cwd", reason: "executionCwd must be an existing directory." };
  }

  const userHome = resolveUserHome(env);
  const expandedTarget = expandLeadingTilde(target, userHome);
  let canonicalTarget;
  try {
    canonicalTarget = resolveCanonical(expandedTarget, canonicalCwd);
  } catch (error) {
    return {
      allowed: false,
      code: "unresolvable_path",
      reason: `Unable to resolve target path: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  const gitMetadataDirs = access === "write" ? resolveGitMetadataDirs(canonicalCwd) : [];

  // Worktree gitdir/commondir live outside the worktree checkout; always classify
  // direct writes to the active worktree's git metadata as `git_metadata_write`.
  if (access === "write" && gitMetadataDirs.some(dir => pathWithin(dir, canonicalTarget))) {
    return {
      allowed: false,
      code: "git_metadata_write",
      reason: "Direct writes to Git metadata (gitdir/commondir) are denied."
    };
  }

  // (a) Own-worktree carve-out (must precede protected_home because roundtable
  //     worktrees reside inside the isolated Fugato home).
  if (pathWithin(canonicalCwd, canonicalTarget)) {
    if (access === "write") {
      const relCanonical = path.relative(canonicalCwd, canonicalTarget);
      const rawRelative = !path.isAbsolute(expandedTarget)
        ? expandedTarget
        : pathWithin(canonicalCwd, path.resolve(expandedTarget))
          ? path.relative(canonicalCwd, path.resolve(expandedTarget))
          : "";
      if (hasGitComponent(relCanonical) || (rawRelative && hasGitComponent(rawRelative))) {
        return {
          allowed: false,
          code: "git_metadata_write",
          reason: "Direct writes to '.git' metadata paths are denied."
        };
      }
    }
    return { allowed: true };
  }

  // (b) Protected home denylist (both read and write; blocks sibling roundtable worktrees).
  const homes = resolveProtectedHomes(env);
  if (homes.isolatedError) {
    return {
      allowed: false,
      code: "protected_home",
      reason: `Cannot verify isolated home boundary (${homes.isolatedError}); denying access outside executionCwd.`
    };
  }
  for (const protectedRoot of homes.roots) {
    if (pathWithin(protectedRoot, canonicalTarget)) {
      return {
        allowed: false,
        code: "protected_home",
        reason: `Access outside executionCwd into protected home path is denied.`
      };
    }
  }

  // (c) Writes outside executionCwd are denied; non-protected reads elsewhere pass the boundary gate.
  if (access === "write") {
    if (hasGitComponent(canonicalTarget)) {
      return {
        allowed: false,
        code: "git_metadata_write",
        reason: "Direct writes to '.git' metadata paths are denied."
      };
    }
    return {
      allowed: false,
      code: "outside_workspace",
      reason: "Writes outside the job execution directory are denied."
    };
  }

  return { allowed: true };
}

// Conservative shell tokenizer for command denylist inspection. Splits on shell
// control operators while preserving quotes and extracting command substitutions.
function tokenizeShellSegments(commandLine) {
  const segments = [];
  const substitutions = [];
  let current = [];
  let buf = "";
  let rawBuf = "";
  let inToken = false;
  let quote = null;

  const flushToken = () => {
    if (inToken) {
      current.push({ value: buf, raw: rawBuf });
      buf = "";
      rawBuf = "";
      inToken = false;
    }
  };
  const flushSegment = () => {
    flushToken();
    if (current.length) {
      segments.push(current);
      current = [];
    }
  };

  for (let i = 0; i < commandLine.length; i++) {
    const ch = commandLine[i];
    const next = commandLine[i + 1];

    if (quote === "'") {
      rawBuf += ch;
      if (ch === "'") quote = null;
      else buf += ch;
      continue;
    }

    if (quote === '"') {
      rawBuf += ch;
      if (ch === "\\" && next !== undefined) {
        if (next === '"' || next === "\\" || next === "$" || next === "`") {
          buf += next;
        } else {
          buf += ch + next;
        }
        rawBuf += next;
        i++;
        continue;
      }
      if (ch === "$" && next === "(") {
        const end = findMatchingParen(commandLine, i + 2);
        if (end !== -1) {
          substitutions.push(commandLine.slice(i + 2, end));
        }
      } else if (ch === "`") {
        const end = findClosingBacktick(commandLine, i + 1);
        if (end !== -1) {
          substitutions.push(commandLine.slice(i + 1, end));
        }
      }
      if (ch === '"') quote = null;
      else buf += ch;
      continue;
    }

    // Outside quotes:
    if (ch === "\\" && next !== undefined) {
      inToken = true;
      rawBuf += ch + next;
      buf += next;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      inToken = true;
      quote = ch;
      rawBuf += ch;
      continue;
    }
    if (ch === "$" && next === "(") {
      const end = findMatchingParen(commandLine, i + 2);
      if (end !== -1) {
        const inner = commandLine.slice(i + 2, end);
        substitutions.push(inner);
        const span = commandLine.slice(i, end + 1);
        inToken = true;
        buf += span;
        rawBuf += span;
        i = end;
        continue;
      }
    }
    if (ch === "`") {
      const end = findClosingBacktick(commandLine, i + 1);
      if (end !== -1) {
        const inner = commandLine.slice(i + 1, end);
        substitutions.push(inner);
        const span = commandLine.slice(i, end + 1);
        inToken = true;
        buf += span;
        rawBuf += span;
        i = end;
        continue;
      }
    }
    if (ch === "\n" || ch === "\r") {
      flushSegment();
      continue;
    }
    if (ch === " " || ch === "\t") {
      flushToken();
      continue;
    }
    if (ch === ";" || ch === "(" || ch === ")") {
      flushSegment();
      continue;
    }
    if (ch === "&" && next === "&") {
      flushSegment();
      i++;
      continue;
    }
    if (ch === "|" && next === "|") {
      flushSegment();
      i++;
      continue;
    }
    if (ch === "|") {
      flushSegment();
      continue;
    }
    if (ch === "&") {
      // Keep `&>` / `>&` with redirections rather than splitting them.
      if (next === ">" || rawBuf.endsWith(">")) {
        inToken = true;
        buf += ch;
        rawBuf += ch;
        continue;
      }
      flushSegment();
      continue;
    }
    if (ch === "<" || ch === ">") {
      // Split standalone redirections so `<target` and `>target` stay clean tokens.
      if (inToken && !/^\d+$/.test(buf) && buf !== "&") {
        flushToken();
      }
      let op = (inToken ? buf : "") + ch;
      let rawOp = (inToken ? rawBuf : "") + ch;
      buf = "";
      rawBuf = "";
      inToken = false;
      if ((ch === ">" && (next === ">" || next === "&" || next === "|")) ||
          (ch === "<" && (next === "<" || next === "&" || next === ">"))) {
        op += next;
        rawOp += next;
        i++;
        if (op === "<<" && commandLine[i + 1] === "<") {
          op += "<";
          rawOp += "<";
          i++;
        }
      }
      current.push({ value: op, raw: rawOp, isRedirect: true });
      continue;
    }
    inToken = true;
    buf += ch;
    rawBuf += ch;
  }
  flushSegment();
  return { segments, substitutions };
}

function findMatchingParen(str, start) {
  let depth = 1;
  let quote = null;
  for (let i = start; i < str.length; i++) {
    const ch = str[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") { i++; continue; }
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === "\\") { i++; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findClosingBacktick(str, start) {
  for (let i = start; i < str.length; i++) {
    if (str[i] === "\\") { i++; continue; }
    if (str[i] === "`") return i;
  }
  return -1;
}

function stripRedirectsAndPrefixes(segment) {
  const words = [];
  for (let i = 0; i < segment.length; i++) {
    const token = segment[i];
    if (token.isRedirect) {
      // Redirects like `2>&1` or `>&2` already carry their target if a digit follows directly,
      // otherwise the next token is the redirection target (e.g. `> file.txt`).
      if (!/[<>]&/.test(token.value) || token.value.endsWith("&")) {
        i++;
      }
      continue;
    }
    words.push(token.value);
  }
  let idx = 0;
  let inEnv = false;
  while (idx < words.length) {
    const word = words[idx];
    if (word === "env" && !inEnv) {
      inEnv = true;
      idx++;
      continue;
    }
    if (inEnv && word.startsWith("-")) {
      if (word === "-u" || word === "-C" || word === "-S") idx += 2;
      else idx++;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      idx++;
      continue;
    }
    if (!inEnv && COMMAND_PREFIXES.has(word)) {
      idx++;
      while (idx < words.length && words[idx].startsWith("-")) idx++;
      continue;
    }
    break;
  }
  return words.slice(idx);
}

function isUnsafeRmTarget(target) {
  if (!target) return false;
  if (target.startsWith("/") || target.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(target)) return true;
  if (target === "~" || target.startsWith("~/") || target.startsWith("~\\")) return true;
  if (/^\$(?:HOME|\{HOME\}|TMPDIR|\{TMPDIR\}|CODEX_COMPANION_HOME|\{CODEX_COMPANION_HOME\})(?:$|[\\/])/.test(target)) {
    return true;
  }
  return target === ".." || target.split(/[\\/]/).includes("..");
}

function checkSegmentArgv(argv, depth, context) {
  if (!argv.length) return null;
  const cmd = path.posix.basename(argv[0].replaceAll("\\", "/"));
  const args = argv.slice(1);

  // Recursively inspect shell wrappers such as `sh -c "..."` / `bash -lc '...'`.
  if (SHELL_WRAPPERS.has(cmd) && depth < MAX_COMMAND_DEPTH) {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--") break;
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(arg) && typeof args[i + 1] === "string") {
        const inner = checkCommandRecursive(args[i + 1], depth + 1, context);
        if (inner) return inner;
        break;
      }
    }
  }

  // 1. npm denylist: npm run build, npm run verify, npm publish, npm install / npm i / npm ci
  if (cmd === "npm") {
    let i = 0;
    while (i < args.length) {
      const arg = args[i];
      if (arg === "--") { i++; break; }
      if (NPM_VALUE_FLAGS.has(arg)) { i += 2; continue; }
      if (arg.startsWith("-")) { i++; continue; }
      break;
    }
    const subcmd = args[i];
    if (subcmd === "publish") {
      return { allowed: false, code: "forbidden_command", reason: "Forbidden command: 'npm publish' is not allowed." };
    }
    if (subcmd === "install" || subcmd === "i" || subcmd === "ci" || subcmd === "add") {
      return { allowed: false, code: "forbidden_command", reason: `Forbidden command: 'npm ${subcmd}' is not allowed.` };
    }
    if (subcmd === "run" || subcmd === "run-script") {
      let j = i + 1;
      while (j < args.length) {
        const arg = args[j];
        if (arg === "--") { j++; break; }
        if (NPM_VALUE_FLAGS.has(arg)) { j += 2; continue; }
        if (arg.startsWith("-")) { j++; continue; }
        break;
      }
      const script = args[j];
      if (script === "build" || script === "verify") {
        return { allowed: false, code: "forbidden_command", reason: `Forbidden command: 'npm run ${script}' is not allowed.` };
      }
    }
  }

  // 2. git denylist: git push
  if (cmd === "git") {
    let i = 0;
    while (i < args.length) {
      const arg = args[i];
      if (arg === "--") { i++; break; }
      if (GIT_VALUE_FLAGS.has(arg)) { i += 2; continue; }
      if (arg.startsWith("-")) { i++; continue; }
      break;
    }
    if (args[i] === "push") {
      return { allowed: false, code: "forbidden_command", reason: "Forbidden command: 'git push' is not allowed." };
    }
  }

  // 3. rm denylist: rm -r / rm -rf with an absolute or ../ target
  if (cmd === "rm") {
    let recursive = false;
    let afterDoubleDash = false;
    const targets = [];
    for (const arg of args) {
      if (!afterDoubleDash && arg === "--") {
        afterDoubleDash = true;
        continue;
      }
      if (!afterDoubleDash && arg.startsWith("--")) {
        if (arg === "--recursive") recursive = true;
        continue;
      }
      if (!afterDoubleDash && arg.startsWith("-") && arg.length > 1) {
        if (/[rR]/.test(arg.slice(1))) recursive = true;
        continue;
      }
      targets.push(arg);
    }
    if (recursive) {
      for (const target of targets) {
        if (isUnsafeRmTarget(target)) {
          return {
            allowed: false,
            code: "forbidden_command",
            reason: `Forbidden command: recursive 'rm' targeting absolute or parent path '${target}' is not allowed.`
          };
        }
      }
    }
  }

  return null;
}

function hasGlobChar(value) {
  return /[*?[\]]/.test(value);
}

function isProtectedReferenceOutsideCwd(rawPath, canonicalCwd, protectedRoots) {
  if (hasGlobChar(rawPath)) return true;
  try {
    const canonical = resolveCanonical(rawPath, canonicalCwd || "/");
    if (canonicalCwd && pathWithin(canonicalCwd, canonical)) return false;
    return protectedRoots.some(root => pathWithin(root, canonical));
  } catch {
    return true;
  }
}

function checkProtectedText(text, { canonicalCwd, homes }) {
  // Check symbolic home references: ~/.claude, ~/.codex, ~/.gemini, $HOME/..., ${HOME}/...
  const symbolicHomeRe = /(?:^|[\s'"`=:;,(\[<>{])((?:~|\$HOME|\$\{HOME\})[\\/]\.(?:claude|codex|gemini)([^\s'"`;|&<>()]*))/g;
  for (const match of text.matchAll(symbolicHomeRe)) {
    const fullRef = match[1];
    const suffix = match[2] ?? "";
    if (suffix && !/^[\\/*?[\]]/.test(suffix)) continue;
    const rest = fullRef.replace(/^(?:~|\$HOME|\$\{HOME\})[\\/]/, "");
    const expanded = path.join(homes.canonicalHome, rest);
    if (isProtectedReferenceOutsideCwd(expanded, canonicalCwd, homes.roots)) {
      return {
        allowed: false,
        code: "forbidden_command",
        reason: `Forbidden command: references protected home path '${fullRef}'.`
      };
    }
  }

  // Check symbolic $CODEX_COMPANION_HOME / ${CODEX_COMPANION_HOME} references.
  const isolatedVarRe = /(?:^|[\s'"`=:;,(\[<>{])((?:\$CODEX_COMPANION_HOME|\$\{CODEX_COMPANION_HOME\})([^\s'"`;|&<>()]*))/g;
  for (const match of text.matchAll(isolatedVarRe)) {
    const fullRef = match[1];
    const suffix = match[2] ?? "";
    if (suffix && !/^[\\/*?[\]]/.test(suffix)) continue;
    if (!homes.isolatedHome || homes.isolatedError) {
      return {
        allowed: false,
        code: "forbidden_command",
        reason: `Forbidden command: references protected isolated home variable '${fullRef}'.`
      };
    }
    const rest = suffix.replace(/^[\\/]+/, "");
    const expanded = rest ? path.join(homes.isolatedHome, rest) : homes.isolatedHome;
    if (isProtectedReferenceOutsideCwd(expanded, canonicalCwd, homes.roots)) {
      return {
        allowed: false,
        code: "forbidden_command",
        reason: `Forbidden command: references protected isolated home path '${fullRef}'.`
      };
    }
  }

  // Check literal protected home / isolated home path prefixes (both raw and canonical).
  for (const prefix of homes.literalPrefixes) {
    if (!prefix) continue;
    let from = 0;
    while (from <= text.length) {
      const idx = text.indexOf(prefix, from);
      if (idx === -1) break;
      from = idx + prefix.length;
      const before = idx > 0 ? text[idx - 1] : "";
      if (before && !/[\s'"`=:;,(\[<>{]/.test(before)) continue;
      const after = text[idx + prefix.length] ?? "";
      if (after && !/^[\\/\s'"`;|&<>(),:\]}*?[]/.test(after)) continue;
      let end = idx + prefix.length;
      while (end < text.length && !/[\s'"`;|&<>()]/.test(text[end])) end++;
      const span = text.slice(idx, end);
      if (isProtectedReferenceOutsideCwd(span, canonicalCwd, homes.roots)) {
        return {
          allowed: false,
          code: "forbidden_command",
          reason: "Forbidden command: references a protected home or isolated Fugato path outside executionCwd."
        };
      }
    }
  }

  return null;
}

function checkCommandRecursive(commandLine, depth, context) {
  const { segments, substitutions } = tokenizeShellSegments(commandLine);

  const rawProtected = checkProtectedText(commandLine, context);
  if (rawProtected) return rawProtected;

  // Also scan unquoted tokens so quote-splitting (e.g. "$HOME"/.gemini/x) is caught.
  const unquotedJoined = segments.flatMap(seg => seg.map(t => t.value)).join(" ");
  if (unquotedJoined) {
    const tokenProtected = checkProtectedText(unquotedJoined, context);
    if (tokenProtected) return tokenProtected;
  }

  for (const segment of segments) {
    const argv = stripRedirectsAndPrefixes(segment);
    const denied = checkSegmentArgv(argv, depth, context);
    if (denied) return denied;
  }

  if (depth < MAX_COMMAND_DEPTH) {
    for (const inner of substitutions) {
      const denied = checkCommandRecursive(inner, depth + 1, context);
      if (denied) return denied;
    }
  }

  return null;
}

/**
 * Fail-closed command denylist for Antigravity ACP `run_command` requests.
 *
 * IMPORTANT: Returning `{ allowed: true }` means ONLY that the command is not
 * on the out-of-bounds denylist. It is NOT auto-approval; the command still
 * parks for chair approval unless a separate grant applies.
 */
/** @param {string} commandLine @param {{ executionCwd?: string, env?: NodeJS.ProcessEnv }} [options] */
export function evaluateCommand(commandLine, { executionCwd, env = process.env } = {}) {
  if (typeof commandLine !== "string" || !commandLine.trim() || commandLine.includes("\0")) {
    return {
      allowed: false,
      code: "forbidden_command",
      reason: "Command line must be a non-empty string without NUL bytes."
    };
  }
  const canonicalCwd = executionCwd !== undefined ? resolveCanonicalDir(executionCwd) : null;
  const homes = resolveProtectedHomes(env);
  const denied = checkCommandRecursive(commandLine, 0, { canonicalCwd, homes });
  return denied ?? { allowed: true };
}
