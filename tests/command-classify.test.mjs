import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyCommand, COMMAND_ALLOWLIST } from "../plugins/codex/scripts/lib/command-classify.mjs";

function makeWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-classify-"));
  const cwd = path.join(root, "repo");
  const outside = path.join(root, "outside");
  fs.mkdirSync(path.join(cwd, "tests"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "plugins", "codex"), { recursive: true });
  fs.mkdirSync(path.join(outside, "ext-plugin"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "tests", "a.test.mjs"), "");
  fs.writeFileSync(path.join(cwd, "tests", "b.test.mjs"), "");
  fs.writeFileSync(path.join(cwd, "package.json"), "{}");
  fs.writeFileSync(path.join(outside, "x.mjs"), "");
  fs.symlinkSync(path.join(outside, "x.mjs"), path.join(cwd, "tests", "escape.test.mjs"));
  fs.symlinkSync(path.join(outside, "ext-plugin"), path.join(cwd, "plugins", "escape-dir"));
  fs.symlinkSync(outside, path.join(cwd, "node_modules"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, cwd, outside };
}

test("COMMAND_ALLOWLIST is exported as data with the four allowlisted rules and no git", () => {
  assert.ok(Array.isArray(COMMAND_ALLOWLIST));
  assert.equal(COMMAND_ALLOWLIST.length, 4);
  assert.equal(COMMAND_ALLOWLIST.some(rule => rule.tokens[0] === "git"), false);
});

test("classifyCommand accepts the four allowlisted forms with existing realpath-confined targets", t => {
  const { cwd } = makeWorkspace(t);
  const cases = [
    ["node --test tests/a.test.mjs", "node --test", ["node", "--test", "tests/a.test.mjs"]],
    ["node --test tests/a.test.mjs tests/b.test.mjs", "node --test", ["node", "--test", "tests/a.test.mjs", "tests/b.test.mjs"]],
    ["claude plugin test plugins/codex", "claude plugin test", ["claude", "plugin", "test", "plugins/codex"]],
    ["npm test", "npm test", ["npm", "test"]],
    ["npm run test", "npm run test", ["npm", "run", "test"]],
    ["npm run test:runtime", "npm run test:runtime", ["npm", "run", "test:runtime"]]
  ];
  for (const [commandLine, prefix, argv] of cases) {
    const result = classifyCommand(commandLine, { cwd });
    assert.equal(result.eligible, true, `${commandLine}: ${JSON.stringify(result)}`);
    assert.equal(result.prefix, prefix, commandLine);
    assert.deepEqual(result.argv, argv, commandLine);
  }
});

test("classifyCommand rejects git, quotes, shell metacharacters, review repros, and non-ASCII", t => {
  const { cwd } = makeWorkspace(t);
  const cases = [
    // Review repros & git always ineligible
    "git log -n 1 --pretty --output=tests/pwn.test.mjs --format=x",
    "git show --pretty --ext-diff HEAD",
    "git diff /tmp/dir:1/file package.json",
    "git status /etc/a:b",
    "git diff --stat",
    "git status",
    "git log -n 5",
    "git show HEAD",
    "git push",
    "node --test =npm",
    "git diff =sh package.json",
    "node --test ^-e x",
    "node --test %TEMP%/e.mjs",
    "node --test node_modules/x.mjs",
    // Quotes of any kind
    'node --test "tests/a.test.mjs"',
    "node --test 'tests/a.test.mjs'",
    // Shell operators, expansions, globs, env prefix, colon, non-ASCII
    "node --test tests/a.test.mjs; echo pwn",
    "node --test tests/a.test.mjs && rm -rf /",
    "node --test tests/a.test.mjs || echo fail",
    "node --test tests/a.test.mjs | cat",
    "node --test tests/a.test.mjs &",
    "node --test tests/a.test.mjs > out.txt",
    "node --test tests/a.test.mjs < /dev/null",
    "node --test $(echo tests/a.test.mjs)",
    "node --test `echo tests/a.test.mjs`",
    "node --test tests/a.test.mjs\nrm -rf /",
    "node --test tests/*.test.mjs",
    "node --test tests/?.test.mjs",
    "node --test tests/[ab].test.mjs",
    "node --test ~/a.test.mjs",
    "node --test $TARGET",
    "NODE_ENV=test node --test tests/a.test.mjs",
    "node --test tests/a.test.mjs # comment",
    "node --test !tests/a.test.mjs",
    "node --test tests/a\\.test.mjs",
    "node --test tests/a:b.mjs",
    "node --test tests/café.test.mjs",
    // Non-allowlisted commands & flags
    "npm run build",
    "npm run verify",
    "npm install",
    "npm ci",
    "npm publish",
    "npm run test:",
    "npm test -- --extra",
    "npm run test:runtime -- --extra",
    "rm -rf x",
    "sh -c x",
    "bash -c x",
    "node -e 1",
    "node --eval 1",
    "node -p 1",
    "node --print 1",
    "node --test -e 1",
    "node --test",
    "claude plugin test",
    "claude plugin test plugins/codex tests"
  ];
  for (const commandLine of cases) {
    const result = classifyCommand(commandLine, { cwd });
    assert.equal(result.eligible, false, `${commandLine} must be ineligible`);
    assert.equal(result.prefix, undefined);
    assert.ok(result.reason, commandLine);
  }
});

test("classifyCommand rejects symlink escapes, nonexistent paths, dot/node_modules segments, and wrong file types", t => {
  const { cwd } = makeWorkspace(t);
  const cases = [
    "node --test /abs/a.test.mjs",
    `node --test ${cwd}/tests/a.test.mjs`,
    "node --test ../outside/x.mjs",
    "node --test ./tests/a.test.mjs",
    "node --test tests/./a.test.mjs",
    "node --test tests/../tests/a.test.mjs",
    "node --test tests/escape.test.mjs",
    "node --test tests/does-not-exist.test.mjs",
    "node --test node_modules/x.mjs",
    "node --test plugins/codex",
    "claude plugin test .",
    "claude plugin test ../outside",
    "claude plugin test plugins/escape-dir",
    "claude plugin test plugins/does-not-exist",
    "claude plugin test tests/a.test.mjs"
  ];
  for (const commandLine of cases) {
    const result = classifyCommand(commandLine, { cwd });
    assert.equal(result.eligible, false, `${commandLine} must be ineligible`);
    assert.ok(result.reason, commandLine);
  }
  assert.equal(classifyCommand("node --test tests/a.test.mjs", {}).eligible, false);
});
