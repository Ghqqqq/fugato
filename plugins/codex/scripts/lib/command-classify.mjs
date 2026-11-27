import path from "node:path";

const CONTROL_OR_NEWLINE = /[\u0000-\u0008\u000a-\u001f\u007f]/;
const FORBIDDEN_UNQUOTED = new Set([";", "&", "|", ">", "<", "(", ")", "{", "}", "`", "$", "*", "?", "[", "]", "~", "\\"]);
const FORBIDDEN_EMBEDDED = /[;&|><`$*?[\]~\\]/;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WINDOWS_ABSOLUTE = /^[A-Za-z]:|^\\\\/;
const NPM_TEST_SCRIPT = /^test(?::[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const MAX_NPM_SCRIPT_LENGTH = 80;

const GIT_COMMON_DIFF_FLAGS = Object.freeze([
  "--stat", "--numstat", "--shortstat", "--name-only", "--name-status", "--summary", "--compact-summary",
  "--patch", "-p", "--no-patch", "-s", "--raw", "--check", "--word-diff",
  "--no-color", "--color", "--no-ext-diff", "--no-textconv",
  "-w", "--ignore-all-space", "-b", "--ignore-space-change", "--ignore-blank-lines",
  "-M", "-C", "--no-renames"
]);

const GIT_SAFE_FLAGS = Object.freeze({
  diff: Object.freeze({
    booleans: new Set([...GIT_COMMON_DIFF_FLAGS, "--cached", "--staged"]),
    enumValues: new Map([["--color", new Set(["always", "never", "auto"])]]),
    nonNegIntFlags: new Set(["-U", "--unified"]),
    shortAttachedInt: /^-U\d+$/,
    safeStringFlags: new Set(["--diff-filter"])
  }),
  status: Object.freeze({
    booleans: new Set(["-s", "--short", "-b", "--branch", "-sb", "-bs", "--porcelain", "--ignored", "--no-ahead-behind", "-u", "-uno", "-unormal", "-uall", "--untracked-files", "--long", "-v", "--verbose"]),
    enumValues: new Map([
      ["--porcelain", new Set(["v1", "v2"])],
      ["--untracked-files", new Set(["no", "normal", "all"])]
    ]),
    nonNegIntFlags: new Set(),
    shortAttachedInt: null,
    safeStringFlags: new Set()
  }),
  log: Object.freeze({
    booleans: new Set([...GIT_COMMON_DIFF_FLAGS, "--oneline", "--graph", "--decorate", "--no-decorate", "--all", "--abbrev-commit", "--reverse", "--first-parent", "--merges", "--no-merges", "--follow"]),
    enumValues: new Map([["--color", new Set(["always", "never", "auto"])]]),
    posIntFlags: new Set(["-n", "--max-count"]),
    nonNegIntFlags: new Set(["-U", "--unified"]),
    shortAttachedInt: /^(?:-n?[1-9]\d*|-U\d+)$/,
    safeStringFlags: new Set(["--format", "--pretty", "--grep", "--author", "--since", "--until", "--after", "--before", "--diff-filter"])
  }),
  show: Object.freeze({
    booleans: new Set([...GIT_COMMON_DIFF_FLAGS, "--oneline", "--abbrev-commit"]),
    enumValues: new Map([["--color", new Set(["always", "never", "auto"])]]),
    nonNegIntFlags: new Set(["-U", "--unified"]),
    shortAttachedInt: /^-U\d+$/,
    safeStringFlags: new Set(["--format", "--pretty", "--diff-filter"])
  })
});

// Eligibility is strictly an allowlist held as data.
export const COMMAND_ALLOWLIST = Object.freeze([
  Object.freeze({
    id: "node-test",
    tokens: Object.freeze(["node", "--test"]),
    args: Object.freeze({ kind: "relativePaths", min: 1 })
  }),
  Object.freeze({
    id: "claude-plugin-test",
    tokens: Object.freeze(["claude", "plugin", "test"]),
    args: Object.freeze({ kind: "relativePaths", min: 1, max: 1 })
  }),
  Object.freeze({
    id: "git-read",
    tokens: Object.freeze(["git", Object.freeze(["diff", "status", "log", "show"])]),
    args: Object.freeze({ kind: "gitRead", flagsBySubcommand: GIT_SAFE_FLAGS })
  }),
  Object.freeze({
    id: "npm-test",
    tokens: Object.freeze(["npm", "test"]),
    args: Object.freeze({ kind: "none" })
  }),
  Object.freeze({
    id: "npm-run-test",
    tokens: Object.freeze(["npm", "run", NPM_TEST_SCRIPT]),
    args: Object.freeze({ kind: "none" })
  })
]);

function tokenize(commandLine) {
  if (CONTROL_OR_NEWLINE.test(commandLine)) return { ok: false, reason: "newline_or_control" };
  const argv = [];
  let i = 0;
  const len = commandLine.length;
  while (i < len) {
    while (i < len && (commandLine[i] === " " || commandLine[i] === "\t")) i++;
    if (i >= len) break;
    if (commandLine[i] === "#") return { ok: false, reason: "shell_comment" };
    let token = "";
    while (i < len && commandLine[i] !== " " && commandLine[i] !== "\t") {
      const ch = commandLine[i];
      if (ch === "'" || ch === '"') {
        const quote = ch;
        i++;
        let closed = false;
        while (i < len) {
          const inner = commandLine[i];
          if (inner === quote) {
            i++;
            closed = true;
            break;
          }
          if (FORBIDDEN_EMBEDDED.test(inner)) return { ok: false, reason: "embedded_shell_operator_or_expansion" };
          token += inner;
          i++;
        }
        if (!closed) return { ok: false, reason: "unclosed_quote" };
      } else {
        if (FORBIDDEN_UNQUOTED.has(ch)) return { ok: false, reason: "shell_operator_or_expansion" };
        token += ch;
        i++;
      }
    }
    argv.push(token);
  }
  if (!argv.length) return { ok: false, reason: "empty_command" };
  if (ENV_ASSIGNMENT.test(argv[0])) return { ok: false, reason: "env_prefix" };
  return { ok: true, argv };
}

function isRelativeInsideCwd(arg, cwd) {
  if (typeof arg !== "string" || !arg.length) return false;
  if (FORBIDDEN_EMBEDDED.test(arg) || CONTROL_OR_NEWLINE.test(arg)) return false;
  if (path.isAbsolute(arg) || path.posix.isAbsolute(arg) || path.win32.isAbsolute(arg) || WINDOWS_ABSOLUTE.test(arg)) return false;
  const normalized = path.posix.normalize(arg);
  if (normalized === ".." || normalized.startsWith("../")) return false;
  const base = path.resolve(cwd);
  const resolved = path.resolve(base, arg);
  const rel = path.relative(base, resolved);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return false;
  return true;
}

function matchRule(argv) {
  for (const rule of COMMAND_ALLOWLIST) {
    if (argv.length < rule.tokens.length) continue;
    let matched = true;
    for (let i = 0; i < rule.tokens.length; i++) {
      const pattern = rule.tokens[i];
      const token = argv[i];
      if (typeof pattern === "string") {
        if (token !== pattern) { matched = false; break; }
      } else if (Array.isArray(pattern)) {
        if (!pattern.includes(token)) { matched = false; break; }
      } else if (pattern instanceof RegExp) {
        if (!pattern.test(token) || token.length > MAX_NPM_SCRIPT_LENGTH) { matched = false; break; }
      } else {
        matched = false;
        break;
      }
    }
    if (matched) return rule;
  }
  return null;
}

function validateGitPositional(arg, cwd, afterDoubleDash) {
  if (!arg || arg.startsWith(":")) return false;
  if (afterDoubleDash) return isRelativeInsideCwd(arg, cwd);
  const colon = arg.indexOf(":");
  if (colon > 0) {
    const rev = arg.slice(0, colon);
    const target = arg.slice(colon + 1);
    // Reject single-letter drive prefixes like C:/foo and require relative path inside cwd.
    if (/^[A-Za-z]$/.test(rev)) return false;
    return isRelativeInsideCwd(target, cwd);
  }
  return isRelativeInsideCwd(arg, cwd);
}

function validateGitArgs(subcommand, rest, cwd, flagsBySubcommand) {
  const spec = flagsBySubcommand[subcommand];
  if (!spec) return { ok: false, reason: "unsupported_git_subcommand" };
  let afterDoubleDash = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (afterDoubleDash) {
      if (!validateGitPositional(arg, cwd, true)) return { ok: false, reason: "path_outside_cwd" };
      continue;
    }
    if (arg === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (arg.startsWith("-")) {
      if (spec.booleans.has(arg)) continue;
      if (spec.shortAttachedInt?.test(arg)) continue;
      const eq = arg.indexOf("=");
      if (eq > 0) {
        const flag = arg.slice(0, eq);
        const value = arg.slice(eq + 1);
        if (!value) return { ok: false, reason: "invalid_flag_value" };
        if (spec.enumValues?.has(flag)) {
          if (!spec.enumValues.get(flag).has(value)) return { ok: false, reason: "invalid_flag_value" };
          continue;
        }
        if (spec.posIntFlags?.has(flag)) {
          if (!/^[1-9]\d*$/.test(value)) return { ok: false, reason: "invalid_flag_value" };
          continue;
        }
        if (spec.nonNegIntFlags?.has(flag)) {
          if (!/^\d+$/.test(value)) return { ok: false, reason: "invalid_flag_value" };
          continue;
        }
        if (spec.safeStringFlags?.has(flag)) {
          if (flag === "--diff-filter" && !/^[ACDMRTUXB*a-z]+$/.test(value)) return { ok: false, reason: "invalid_flag_value" };
          continue;
        }
        return { ok: false, reason: "disallowed_flag" };
      }
      if (spec.posIntFlags?.has(arg)) {
        const next = rest[++i];
        if (!next || !/^[1-9]\d*$/.test(next)) return { ok: false, reason: "invalid_flag_value" };
        continue;
      }
      if (spec.nonNegIntFlags?.has(arg)) {
        const next = rest[++i];
        if (!next || !/^\d+$/.test(next)) return { ok: false, reason: "invalid_flag_value" };
        continue;
      }
      if (spec.safeStringFlags?.has(arg)) {
        const next = rest[++i];
        if (!next || (arg === "--diff-filter" && !/^[ACDMRTUXB*a-z]+$/.test(next))) return { ok: false, reason: "invalid_flag_value" };
        continue;
      }
      return { ok: false, reason: "disallowed_flag" };
    }
    if (!validateGitPositional(arg, cwd, false)) return { ok: false, reason: "path_outside_cwd" };
  }
  return { ok: true };
}

export function classifyCommand(commandLine, { cwd } = {}) {
  if (typeof cwd !== "string" || !cwd.trim()) return { eligible: false, reason: "missing_cwd" };
  if (typeof commandLine !== "string" || !commandLine.trim()) return { eligible: false, reason: "empty_command" };
  const tokenized = tokenize(commandLine);
  if (!tokenized.ok) return { eligible: false, reason: tokenized.reason };
  const { argv } = tokenized;
  const rule = matchRule(argv);
  if (!rule) return { eligible: false, reason: "not_allowlisted" };
  const prefix = argv.slice(0, rule.tokens.length).join(" ");
  const rest = argv.slice(rule.tokens.length);

  if (rule.args.kind === "none") {
    if (rest.length > 0) return { eligible: false, reason: "unexpected_arguments" };
    return { eligible: true, prefix, argv };
  }
  if (rule.args.kind === "relativePaths") {
    if (rest.length < (rule.args.min ?? 0)) return { eligible: false, reason: "missing_arguments" };
    if (rule.args.max !== undefined && rest.length > rule.args.max) return { eligible: false, reason: "unexpected_arguments" };
    for (const arg of rest) {
      if (arg.startsWith("-")) return { eligible: false, reason: "disallowed_flag" };
      if (!isRelativeInsideCwd(arg, cwd)) return { eligible: false, reason: "path_outside_cwd" };
    }
    return { eligible: true, prefix, argv };
  }
  if (rule.args.kind === "gitRead") {
    const valid = validateGitArgs(argv[1], rest, cwd, rule.args.flagsBySubcommand);
    if (!valid.ok) return { eligible: false, reason: valid.reason };
    return { eligible: true, prefix, argv };
  }
  return { eligible: false, reason: "not_allowlisted" };
}
