import fs from "node:fs";
import path from "node:path";

const NON_PRINTABLE_ASCII = /[^\x20-\x7e\t]/;
const QUOTES = /['"]/;
const SAFE_TOKEN = /^[A-Za-z0-9._/:@+,-]+$/;
const NPM_TEST_SCRIPT = /^test(?::[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const MAX_NPM_SCRIPT_LENGTH = 80;

// Eligibility is strictly an allowlist held as data.
export const COMMAND_ALLOWLIST = Object.freeze([
  Object.freeze({
    id: "node-test",
    tokens: Object.freeze(["node", "--test"]),
    args: Object.freeze({ kind: "relativeFiles", min: 1 })
  }),
  Object.freeze({
    id: "claude-plugin-test",
    tokens: Object.freeze(["claude", "plugin", "test"]),
    args: Object.freeze({ kind: "relativeDir", min: 1, max: 1 })
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
  if (NON_PRINTABLE_ASCII.test(commandLine)) return { ok: false, reason: "invalid_character" };
  if (QUOTES.test(commandLine)) return { ok: false, reason: "quotes_not_allowed" };
  const trimmed = commandLine.trim();
  if (!trimmed) return { ok: false, reason: "empty_command" };
  const argv = trimmed.split(/[ \t]+/);
  for (const token of argv) {
    if (!token || !SAFE_TOKEN.test(token)) return { ok: false, reason: "disallowed_token" };
    if (token.startsWith("=")) return { ok: false, reason: "disallowed_token_prefix" };
  }
  return { ok: true, argv };
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

function validateRealPath(arg, realCwd, expectedType) {
  if (!arg || arg.startsWith("-") || arg.startsWith("=")) return { ok: false, reason: "disallowed_flag" };
  if (arg.includes(":")) return { ok: false, reason: "disallowed_colon" };
  if (arg.startsWith("/") || path.isAbsolute(arg) || path.posix.isAbsolute(arg) || path.win32.isAbsolute(arg)) {
    return { ok: false, reason: "absolute_path" };
  }
  const segments = arg.split("/");
  if (segments.some(seg => seg === "" || seg === "." || seg === ".." || seg.toLowerCase() === "node_modules")) {
    return { ok: false, reason: "disallowed_path_segment" };
  }
  let realTarget;
  try {
    realTarget = fs.realpathSync(path.resolve(realCwd, arg));
  } catch {
    return { ok: false, reason: "path_not_found" };
  }
  const rel = path.relative(realCwd, realTarget);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return { ok: false, reason: "path_outside_cwd" };
  }
  if (rel.split(path.sep).some(seg => seg.toLowerCase() === "node_modules")) {
    return { ok: false, reason: "disallowed_path_segment" };
  }
  let stat;
  try {
    stat = fs.statSync(realTarget);
  } catch {
    return { ok: false, reason: "path_not_found" };
  }
  if (expectedType === "file" && !stat.isFile()) return { ok: false, reason: "not_regular_file" };
  if (expectedType === "dir" && !stat.isDirectory()) return { ok: false, reason: "not_directory" };
  return { ok: true };
}

/** @param {string} commandLine @param {{ cwd?: string }} [options] */
export function classifyCommand(commandLine, { cwd } = {}) {
  if (typeof cwd !== "string" || !cwd.trim()) return { eligible: false, reason: "missing_cwd" };
  if (typeof commandLine !== "string" || !commandLine.trim()) return { eligible: false, reason: "empty_command" };
  const tokenized = tokenize(commandLine);
  if (!tokenized.ok) return { eligible: false, reason: tokenized.reason };
  const { argv } = tokenized;
  const rule = matchRule(argv);
  if (!rule) return { eligible: false, reason: "not_allowlisted" };

  // ":" is allowed only inside the matched npm script name.
  for (let i = 0; i < argv.length; i++) {
    const isNpmScript = rule.id === "npm-run-test" && i === 2;
    if (!isNpmScript && argv[i].includes(":")) return { eligible: false, reason: "disallowed_colon" };
    if (i >= rule.tokens.length && (argv[i].startsWith("-") || argv[i].startsWith("="))) {
      return { eligible: false, reason: "disallowed_flag" };
    }
  }

  let realCwd;
  try {
    realCwd = fs.realpathSync(path.resolve(cwd));
    if (!fs.statSync(realCwd).isDirectory()) return { eligible: false, reason: "invalid_cwd" };
  } catch {
    return { eligible: false, reason: "invalid_cwd" };
  }

  const prefix = argv.slice(0, rule.tokens.length).join(" ");
  const rest = argv.slice(rule.tokens.length);

  if (rule.args.kind === "none") {
    if (rest.length > 0) return { eligible: false, reason: "unexpected_arguments" };
    return { eligible: true, prefix, argv };
  }
  if (rule.args.kind === "relativeFiles" || rule.args.kind === "relativeDir") {
    if (rest.length < (rule.args.min ?? 0)) return { eligible: false, reason: "missing_arguments" };
    const max = "max" in rule.args ? rule.args.max : undefined;
    if (max !== undefined && rest.length > max) return { eligible: false, reason: "unexpected_arguments" };
    const expectedType = rule.args.kind === "relativeFiles" ? "file" : "dir";
    for (const arg of rest) {
      const checked = validateRealPath(arg, realCwd, expectedType);
      if (!checked.ok) return { eligible: false, reason: checked.reason };
    }
    return { eligible: true, prefix, argv };
  }
  return { eligible: false, reason: "not_allowlisted" };
}
