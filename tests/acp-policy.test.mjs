import "./test-environment.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { evaluateCommand, evaluatePath } from "../plugins/codex/scripts/lib/acp-policy.mjs";

function makePolicyFixture(prefix = "acp-policy-") {
  const dir = makeTempDir(prefix);
  const home = path.join(dir, "home");
  const isolated = path.join(dir, "isolated");
  const repo = path.join(dir, "repo");
  const outside = path.join(dir, "outside");
  for (const d of [home, isolated, repo, outside]) fs.mkdirSync(d, { recursive: true });
  const env = {
    HOME: home,
    USERPROFILE: home,
    CODEX_COMPANION_HOME: isolated
  };
  return { dir, home, isolated, repo, outside, env };
}

test("evaluatePath allows own-worktree reads and writes, including nested new files and .git reads", () => {
  const { repo, env } = makePolicyFixture("acp-own-");
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "app.mjs"), "export const x = 1;\n");

  assert.deepEqual(evaluatePath({ target: "src/app.mjs", executionCwd: repo, access: "read", env }), { allowed: true });
  assert.deepEqual(evaluatePath({ target: "src/app.mjs", executionCwd: repo, access: "write", env }), { allowed: true });
  assert.deepEqual(evaluatePath({ target: path.join(repo, "src", "app.mjs"), executionCwd: repo, access: "write", env }), { allowed: true });
  assert.deepEqual(evaluatePath({ target: ".git/HEAD", executionCwd: repo, access: "read", env }), { allowed: true });
  assert.deepEqual(evaluatePath({ target: ".git/config", executionCwd: repo, access: "read", env }), { allowed: true });
  // Non-existent nested new files inside executionCwd are allowed.
  assert.deepEqual(evaluatePath({ target: "new/deep/nested/file.mjs", executionCwd: repo, access: "write", env }), { allowed: true });
  assert.deepEqual(evaluatePath({ target: "new/deep/nested/file.mjs", executionCwd: repo, access: "read", env }), { allowed: true });
  // Normal dotfiles that are not `.git` remain writable.
  assert.deepEqual(evaluatePath({ target: ".gitignore", executionCwd: repo, access: "write", env }), { allowed: true });
  assert.deepEqual(evaluatePath({ target: ".github/workflows/ci.yml", executionCwd: repo, access: "write", env }), { allowed: true });
});

test("evaluatePath denies writes to .git paths and resolved worktree gitdir and commondir", () => {
  const { dir, repo, env } = makePolicyFixture("acp-git-");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  assert.equal(run("git", ["add", "README.md"], { cwd: repo, env }).status, 0);
  assert.equal(run("git", ["commit", "-m", "initial"], { cwd: repo, env }).status, 0);

  // Regular repo `.git` writes denied.
  for (const target of [".git", ".git/config", ".git/hooks/pre-commit", "sub/.git/config"]) {
    const res = evaluatePath({ target, executionCwd: repo, access: "write", env });
    assert.equal(res.allowed, false, `${target} should be denied`);
    assert.equal(res.code, "git_metadata_write");
    assert.ok(res.reason);
  }

  // Linked git worktree: `.git` file points at `<repo>/.git/worktrees/worker`.
  const wt = path.join(dir, "wt-worker");
  assert.equal(run("git", ["worktree", "add", "--detach", wt, "HEAD"], { cwd: repo, env }).status, 0);
  const gitdir = fs.realpathSync(path.join(repo, ".git", "worktrees", "wt-worker"));
  const commondir = fs.realpathSync(path.join(repo, ".git"));

  assert.deepEqual(evaluatePath({ target: "README.md", executionCwd: wt, access: "write", env }), { allowed: true });
  assert.deepEqual(evaluatePath({ target: ".git", executionCwd: wt, access: "read", env }), { allowed: true });

  for (const target of [
    ".git",
    ".git/config",
    ".git/hooks/x",
    path.join(gitdir, "HEAD"),
    path.join(gitdir, "index"),
    path.join(commondir, "config"),
    path.join(commondir, "hooks", "post-commit")
  ]) {
    const res = evaluatePath({ target, executionCwd: wt, access: "write", env });
    assert.equal(res.allowed, false, `${target} should be denied for write`);
    assert.equal(res.code, "git_metadata_write");
  }
});

test("evaluatePath allows own roundtable worktree inside isolated home while denying sibling worktrees and isolated config", () => {
  const { isolated, repo, env } = makePolicyFixture("acp-rt-");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "file.txt"), "base\n");
  assert.equal(run("git", ["add", "file.txt"], { cwd: repo, env }).status, 0);
  assert.equal(run("git", ["commit", "-m", "base"], { cwd: repo, env }).status, 0);

  const worktreesDir = path.join(isolated, "duet", "roundtables", "room-42", "worktrees");
  const criticWt = path.join(worktreesDir, "critic");
  const improverWt = path.join(worktreesDir, "improver");
  fs.mkdirSync(worktreesDir, { recursive: true });
  assert.equal(run("git", ["worktree", "add", "--detach", criticWt, "HEAD"], { cwd: repo, env }).status, 0);
  assert.equal(run("git", ["worktree", "add", "--detach", improverWt, "HEAD"], { cwd: repo, env }).status, 0);
  fs.writeFileSync(path.join(isolated, "config.toml"), "model = 'x'\n");

  // Own worktree inside isolated home is allowed (rule a precedes rule b).
  assert.deepEqual(evaluatePath({ target: "file.txt", executionCwd: criticWt, access: "read", env }), { allowed: true });
  assert.deepEqual(evaluatePath({ target: "file.txt", executionCwd: criticWt, access: "write", env }), { allowed: true });
  assert.deepEqual(evaluatePath({ target: "nested/new.txt", executionCwd: criticWt, access: "write", env }), { allowed: true });
  assert.deepEqual(evaluatePath({ target: ".git", executionCwd: criticWt, access: "read", env }), { allowed: true });
  assert.equal(evaluatePath({ target: ".git/config", executionCwd: criticWt, access: "write", env }).code, "git_metadata_write");

  // Sibling roundtable worktree and <isolatedHome>/config.toml are denied for BOTH read and write.
  for (const access of ["read", "write"]) {
    for (const target of [
      path.join(improverWt, "file.txt"),
      "../improver/file.txt",
      path.join(isolated, "config.toml"),
      path.join(isolated, "duet", "roundtables", "room-42", "room.json")
    ]) {
      const res = evaluatePath({ target, executionCwd: criticWt, access, env });
      assert.equal(res.allowed, false, `${access} ${target} should be denied`);
      assert.equal(res.code, "protected_home");
    }
  }
});

test("evaluatePath denies ~/.claude, ~/.codex, ~/.gemini reads and writes, outside writes, and symlink escapes", () => {
  const { home, repo, outside, env } = makePolicyFixture("acp-bounds-");
  fs.mkdirSync(path.join(home, ".gemini"), { recursive: true });
  fs.writeFileSync(path.join(home, ".gemini", "x"), "secret\n");
  fs.writeFileSync(path.join(outside, "other.txt"), "outside\n");

  // Protected homes denied for both read and write (both tilde and expanded temp HOME paths).
  for (const access of ["read", "write"]) {
    for (const target of [
      "~/.gemini/x",
      path.join(home, ".gemini", "x"),
      "~/.claude/settings.json",
      path.join(home, ".claude", "CLAUDE.md"),
      "~/.codex/auth.json",
      path.join(home, ".codex", "config.toml")
    ]) {
      const res = evaluatePath({ target, executionCwd: repo, access, env });
      assert.equal(res.allowed, false, `${access} ${target} should be denied`);
      assert.equal(res.code, "protected_home");
    }
  }

  // Non-protected outside paths: write denied (`outside_workspace`), read allowed.
  const outsideWrite = evaluatePath({ target: path.join(outside, "other.txt"), executionCwd: repo, access: "write", env });
  assert.equal(outsideWrite.allowed, false);
  assert.equal(outsideWrite.code, "outside_workspace");
  assert.deepEqual(evaluatePath({ target: path.join(outside, "other.txt"), executionCwd: repo, access: "read", env }), { allowed: true });

  // Symlink escapes inside executionCwd: existing target, dangling target, protected target, and symlink/.. traversal.
  fs.symlinkSync(path.join(outside, "other.txt"), path.join(repo, "link-outside"));
  fs.symlinkSync(path.join(outside, "does-not-exist.txt"), path.join(repo, "dangling-outside"));
  fs.symlinkSync(path.join(home, ".gemini", "x"), path.join(repo, "link-gemini"));
  fs.symlinkSync(outside, path.join(repo, "link-outside-dir"));

  const escExisting = evaluatePath({ target: "link-outside", executionCwd: repo, access: "write", env });
  assert.equal(escExisting.allowed, false);
  assert.equal(escExisting.code, "outside_workspace");

  const escDangling = evaluatePath({ target: "dangling-outside", executionCwd: repo, access: "write", env });
  assert.equal(escDangling.allowed, false);
  assert.equal(escDangling.code, "outside_workspace");

  const escDirTraversal = evaluatePath({ target: "link-outside-dir/sub/new.txt", executionCwd: repo, access: "write", env });
  assert.equal(escDirTraversal.allowed, false);
  assert.equal(escDirTraversal.code, "outside_workspace");

  const escDotDot = evaluatePath({ target: "link-outside-dir/../outside/other.txt", executionCwd: repo, access: "write", env });
  assert.equal(escDotDot.allowed, false);
  assert.equal(escDotDot.code, "outside_workspace");

  for (const access of ["read", "write"]) {
    const escHome = evaluatePath({ target: "link-gemini", executionCwd: repo, access, env });
    assert.equal(escHome.allowed, false);
    assert.equal(escHome.code, "protected_home");
  }

  // Fail closed on invalid inputs.
  assert.equal(evaluatePath({ target: "", executionCwd: repo, access: "read", env }).allowed, false);
  assert.equal(evaluatePath({ target: "a.txt", executionCwd: repo, access: "execute", env }).allowed, false);
  assert.equal(evaluatePath({ target: "a.txt", executionCwd: path.join(repo, "missing-cwd"), access: "read", env }).allowed, false);
});

test("evaluateCommand denies all denylisted commands, flag variants, and protected-home references", () => {
  const { home, isolated, repo, env } = makePolicyFixture("acp-cmd-");
  const worktreesDir = path.join(isolated, "duet", "roundtables", "r1", "worktrees");
  const ownWt = path.join(worktreesDir, "critic");
  const siblingWt = path.join(worktreesDir, "improver");
  fs.mkdirSync(ownWt, { recursive: true });
  fs.mkdirSync(siblingWt, { recursive: true });

  const deniedCommands = [
    // npm build / verify / publish / install / i / ci and flag variants
    "npm run build",
    "npm --silent run build",
    "npm run --silent build -- --watch",
    "npm --prefix packages/app run build",
    "npm run-script build",
    "npm run verify",
    "npm -s run verify",
    "npm run --if-present verify",
    "npm publish",
    "npm publish --access public --dry-run",
    "npm --registry https://registry.npmjs.org publish",
    "npm install",
    "npm install lodash --save-dev",
    "npm --offline install",
    "npm i",
    "npm i -D typescript",
    "npm ci",
    "npm --prefer-offline ci",
    // git push and variants
    "git push",
    "git push origin main",
    "git push --force-with-lease origin feat",
    "git -C repo -c user.name=test --no-pager push origin HEAD",
    // rm -rf / rm -r with absolute or ../ target and variants
    "rm -rf /tmp/foo",
    "rm -r /etc/hosts",
    "rm -fr /var/tmp/x",
    "rm -R -f /tmp/y",
    "rm --recursive --force /tmp/z",
    "rm -rf ../sibling",
    "rm -r ..",
    "rm -r ./a/../../outside",
    "rm -rf -- /abs/path",
    "rm -rf -- ../parent",
    "rm /tmp/foo -rf",
    "rm -rf ~/something",
    "rm -rf $HOME/something",
    // Chained, wrapped, and substituted denylisted commands
    "echo ok && git push origin main",
    "cd sub; npm run verify",
    "sh -c 'npm run build'",
    'bash -lc "git push --tags"',
    "echo $(npm publish)",
    "FOO=1 env BAR=2 npm ci",
    // Protected home references
    "cat ~/.gemini/settings.json",
    "cat ~/.claude/CLAUDE.md",
    "cat ~/.codex/auth.json",
    "cat $HOME/.gemini/settings.json",
    'cat "${HOME}/.claude/settings.json"',
    'cat "$HOME"/.gemini/settings.json',
    `cat ${path.join(home, ".gemini", "settings.json")}`,
    `cat ${path.join(isolated, "config.toml")}`,
    "cat $CODEX_COMPANION_HOME/config.toml",
    `cat ${path.join(siblingWt, "src", "a.js")}`
  ];

  for (const commandLine of deniedCommands) {
    const res = evaluateCommand(commandLine, { executionCwd: ownWt, env });
    assert.equal(res.allowed, false, `expected denied: ${commandLine}`);
    assert.equal(res.code, "forbidden_command", `expected forbidden_command for: ${commandLine}`);
    assert.ok(res.reason);
  }

  // Ordinary commands and references inside own executionCwd (even inside isolatedHome) are allowed.
  const allowedCommands = [
    "node --test tests/a.test.mjs",
    "git diff",
    "git status --short",
    'git log --grep="git push"',
    "ls",
    "ls -la src/",
    "npm test",
    "rm -rf tmp-local-dir",
    "rm -r ./build/cache",
    `node --test ${path.join(ownWt, "tests", "a.test.mjs")}`,
    `cat ${path.join(ownWt, "README.md")}`
  ];

  for (const commandLine of allowedCommands) {
    const res = evaluateCommand(commandLine, { executionCwd: ownWt, env });
    assert.deepEqual(res, { allowed: true }, `expected allowed: ${commandLine}`);
  }

  // Also works with a normal repo cwd outside isolatedHome.
  assert.deepEqual(evaluateCommand("node --test tests/a.test.mjs", { executionCwd: repo, env }), { allowed: true });
  assert.equal(evaluateCommand("cat ~/.gemini/settings.json", { executionCwd: repo, env }).code, "forbidden_command");
});
