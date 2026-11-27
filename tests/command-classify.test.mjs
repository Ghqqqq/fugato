import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { classifyCommand, COMMAND_ALLOWLIST } from "../plugins/codex/scripts/lib/command-classify.mjs";

const CWD = path.resolve("/work/fugato-repo");

test("COMMAND_ALLOWLIST is exported as a non-empty data list", () => {
  assert.ok(Array.isArray(COMMAND_ALLOWLIST));
  assert.ok(COMMAND_ALLOWLIST.length >= 5);
});

test("classifyCommand accepts allowlisted commands and returns exact prefixes and argv", () => {
  const cases = [
    ["node --test tests/a.test.mjs", "node --test", ["node", "--test", "tests/a.test.mjs"]],
    ["node --test tests/a.test.mjs tests/b.test.mjs", "node --test", ["node", "--test", "tests/a.test.mjs", "tests/b.test.mjs"]],
    ['node --test "tests/my test.mjs"', "node --test", ["node", "--test", "tests/my test.mjs"]],
    ["node --test 'tests/my test.mjs'", "node --test", ["node", "--test", "tests/my test.mjs"]],
    ["node --test ./tests/sub/../a.test.mjs", "node --test", ["node", "--test", "./tests/sub/../a.test.mjs"]],
    ["claude plugin test plugins/codex", "claude plugin test", ["claude", "plugin", "test", "plugins/codex"]],
    ["claude plugin test .", "claude plugin test", ["claude", "plugin", "test", "."]],
    ["git diff", "git diff", ["git", "diff"]],
    ["git diff --stat", "git diff", ["git", "diff", "--stat"]],
    ["git diff --cached -- plugins/codex/scripts/lib/antigravity.mjs", "git diff", ["git", "diff", "--cached", "--", "plugins/codex/scripts/lib/antigravity.mjs"]],
    ["git diff main..HEAD -- tests/antigravity.test.mjs", "git diff", ["git", "diff", "main..HEAD", "--", "tests/antigravity.test.mjs"]],
    ["git status", "git status", ["git", "status"]],
    ["git status --short", "git status", ["git", "status", "--short"]],
    ["git log -n 5 --oneline", "git log", ["git", "log", "-n", "5", "--oneline"]],
    ["git log -5 --stat", "git log", ["git", "log", "-5", "--stat"]],
    ["git show --stat HEAD", "git show", ["git", "show", "--stat", "HEAD"]],
    ["git show HEAD:package.json", "git show", ["git", "show", "HEAD:package.json"]],
    ["npm test", "npm test", ["npm", "test"]],
    ["npm run test", "npm run test", ["npm", "run", "test"]],
    ["npm run test:runtime", "npm run test:runtime", ["npm", "run", "test:runtime"]]
  ];
  for (const [commandLine, prefix, argv] of cases) {
    const result = classifyCommand(commandLine, { cwd: CWD });
    assert.equal(result.eligible, true, `${commandLine}: ${JSON.stringify(result)}`);
    assert.equal(result.prefix, prefix, commandLine);
    assert.deepEqual(result.argv, argv, commandLine);
  }
});

test("classifyCommand rejects every shell operator, expansion, glob, tilde, newline, and env prefix", () => {
  const cases = [
    ["semicolon", "node --test tests/a.test.mjs; echo pwn"],
    ["embedded semicolon", "node --test tests/a.test.mjs;id"],
    ["quoted semicolon", "node --test 'tests/a;b.mjs'"],
    ["logical and", "node --test tests/a.test.mjs && rm -rf /"],
    ["logical or", "node --test tests/a.test.mjs || echo fail"],
    ["pipe", "git diff | head -n 5"],
    ["background ampersand", "node --test tests/a.test.mjs &"],
    ["stdout redirect", "git diff > out.txt"],
    ["stdin redirect", "node --test tests/a.test.mjs < /dev/null"],
    ["command substitution unquoted", "node --test $(echo tests/a.test.mjs)"],
    ["command substitution double-quoted", 'node --test "$(whoami)"'],
    ["command substitution single-quoted", "node --test '$(whoami)'"],
    ["backtick unquoted", "node --test `echo tests/a.test.mjs`"],
    ["backtick double-quoted", 'node --test "`whoami`"'],
    ["newline", "node --test tests/a.test.mjs\nrm -rf /"],
    ["carriage return", "node --test tests/a.test.mjs\r\nid"],
    ["quoted newline", 'node --test "tests/a\nb.mjs"'],
    ["glob star", "node --test tests/*.test.mjs"],
    ["quoted glob star", "node --test 'tests/*.test.mjs'"],
    ["glob question", "node --test tests/?.test.mjs"],
    ["glob brackets", "node --test tests/[ab].test.mjs"],
    ["tilde home", "node --test ~/a.test.mjs"],
    ["tilde in git", "git diff HEAD~1"],
    ["dollar var unquoted", "node --test $TARGET"],
    ["dollar var double-quoted", 'node --test "$HOME/a.test.mjs"'],
    ["dollar braces", "node --test ${TARGET}"],
    ["leading env assignment", "NODE_ENV=test node --test tests/a.test.mjs"],
    ["leading NODE_OPTIONS", "NODE_OPTIONS=--eval=1 npm test"],
    ["unclosed double quote", 'node --test "tests/a.test.mjs'],
    ["unclosed single quote", "node --test 'tests/a.test.mjs"],
    ["subshell parens", "(npm test)"],
    ["brace expansion", "node --test tests/{a,b}.test.mjs"],
    ["backslash escape", "node --test tests/a\\.test.mjs"],
    ["shell comment", "npm test # comment"]
  ];
  for (const [label, commandLine] of cases) {
    const result = classifyCommand(commandLine, { cwd: CWD });
    assert.equal(result.eligible, false, `${label}: ${commandLine} must be ineligible`);
    assert.equal(result.prefix, undefined);
    assert.ok(typeof result.reason === "string" && result.reason.length > 0, label);
  }
});

test("classifyCommand rejects non-allowlisted commands and unsafe flags", () => {
  const cases = [
    "npm run build",
    "npm run verify",
    "npm install",
    "npm ci",
    "npm publish",
    "npm run test:",
    "npm run testing",
    "npm test -- --extra",
    "npm run test:runtime -- --extra",
    "git push",
    "git push origin main",
    "git commit -m hi",
    "git -c core.fsmonitor=evil status",
    "git -C /tmp diff",
    "git diff --output=out.txt",
    "git diff --ext-diff",
    "git diff --no-index a b",
    "rm -rf x",
    "sh -c x",
    "bash -c x",
    "node -e 1",
    "node --eval 1",
    "node -p 1",
    "node --print 1",
    "node --test -e 1",
    "node --test --eval 1",
    "node --test -p 1",
    "node --test --print 1",
    "node --test --import ./evil.mjs tests/a.test.mjs",
    "node --test --test-reporter=./evil.mjs tests/a.test.mjs",
    "node --test",
    "claude plugin test",
    "claude plugin test plugins/codex plugins/codex-live",
    "/usr/bin/node --test tests/a.test.mjs",
    ""
  ];
  for (const commandLine of cases) {
    const result = classifyCommand(commandLine, { cwd: CWD });
    assert.equal(result.eligible, false, `${commandLine} must be ineligible`);
    assert.ok(result.reason);
  }
});

test("classifyCommand rejects absolute paths and paths escaping cwd", () => {
  const cases = [
    "node --test /abs/a.test.mjs",
    `node --test ${CWD}/tests/a.test.mjs`,
    "node --test ../outside.test.mjs",
    "node --test tests/../../outside.test.mjs",
    "node --test ../fugato-repo/tests/a.test.mjs",
    "node --test C:/tests/a.test.mjs",
    "claude plugin test /abs/dir",
    "claude plugin test ../outside",
    "git diff /etc/passwd",
    "git diff -- ../outside",
    "git status ../outside",
    "git log -- /tmp",
    "git show HEAD:../outside",
    "git show HEAD:/etc/passwd",
    "git diff :^../outside"
  ];
  for (const commandLine of cases) {
    const result = classifyCommand(commandLine, { cwd: CWD });
    assert.equal(result.eligible, false, `${commandLine} must be ineligible`);
    assert.ok(result.reason);
  }
  assert.equal(classifyCommand("node --test tests/a.test.mjs", {}).eligible, false);
});
