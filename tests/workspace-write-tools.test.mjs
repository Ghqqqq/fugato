import "./test-environment.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { initGitRepo, makeTempDir } from "./helpers.mjs";
import {
  WORKSPACE_WRITE_MAX_BYTES,
  WORKSPACE_WRITE_TOOLS,
  WORKSPACE_WRITE_TOOL_NAMES,
  callWorkspaceWriteTool
} from "../plugins/codex/scripts/lib/workspace-write-tools.mjs";

function makeWorkspaceFixture(prefix = "ws-write-") {
  const dir = makeTempDir(prefix);
  const home = path.join(dir, "home");
  const isolated = path.join(dir, "isolated");
  const repo = path.join(dir, "repo");
  const outside = path.join(dir, "outside");
  for (const d of [home, isolated, repo, outside]) fs.mkdirSync(d, { recursive: true });
  const env = { HOME: home, USERPROFILE: home, CODEX_COMPANION_HOME: isolated };
  return { dir, home, isolated, repo, outside, env };
}

function listTempArtifacts(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.name.includes(".tmp-")) found.push(full);
    if (entry.isDirectory()) found.push(...listTempArtifacts(full));
  }
  return found;
}

test("WORKSPACE_WRITE_TOOLS exports expected MCP tool metadata and names", () => {
  assert.deepEqual(WORKSPACE_WRITE_TOOL_NAMES, ["workspace_edit", "workspace_write"]);
  assert.equal(WORKSPACE_WRITE_TOOLS.length, 2);
  for (const tool of WORKSPACE_WRITE_TOOLS) {
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.equal(tool.annotations.openWorldHint, false);
  }
});

test("workspace_edit applies unique edits with accurate line counts and preserves literal $ sequences", () => {
  const { repo, env } = makeWorkspaceFixture("ws-edit-ok-");
  const file = path.join(repo, "src", "app.mjs");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "const a = 1;\nconst b = 2;\nconst c = 3;\n");

  const res = callWorkspaceWriteTool(
    "workspace_edit",
    { path: "src/app.mjs", target: "const b = 2;", replacement: "const b = '$& $$ 20';\nconst b2 = 21;" },
    repo,
    { env }
  );
  assert.equal(res.result.isError, false);
  assert.deepEqual(res.fileChange, { path: "src/app.mjs", kind: "edit", added: 2, removed: 1 });
  assert.equal(fs.readFileSync(file, "utf8"), "const a = 1;\nconst b = '$& $$ 20';\nconst b2 = 21;\nconst c = 3;\n");
  assert.deepEqual(listTempArtifacts(repo), []);

  // Deleting two lines yields added: 0, removed: 2.
  const del = callWorkspaceWriteTool(
    "workspace_edit",
    { path: "src/app.mjs", target: "const b = '$& $$ 20';\nconst b2 = 21;\n", replacement: "" },
    repo,
    { env }
  );
  assert.equal(del.result.isError, false);
  assert.deepEqual(del.fileChange, { path: "src/app.mjs", kind: "edit", added: 0, removed: 2 });
  assert.equal(fs.readFileSync(file, "utf8"), "const a = 1;\nconst c = 3;\n");
});

test("workspace_edit returns isError with counts and 1-based line numbers on 0 or >1 matches without modifying the file", () => {
  const { repo, env } = makeWorkspaceFixture("ws-edit-ambig-");
  const file = path.join(repo, "multi.txt");
  const initial = "alpha\nneedle one\nbeta\nneedle two\ngamma\nneedle three\n";
  fs.writeFileSync(file, initial);

  // 0 matches
  const zero = callWorkspaceWriteTool(
    "workspace_edit",
    { path: "multi.txt", target: "absent", replacement: "x" },
    repo,
    { env }
  );
  assert.equal(zero.result.isError, true);
  assert.equal(zero.fileChange, undefined);
  assert.match(zero.result.content[0].text, /0 occurrence|0 match/i);
  assert.equal(fs.readFileSync(file, "utf8"), initial);

  // >1 matches by default
  const multi = callWorkspaceWriteTool(
    "workspace_edit",
    { path: "multi.txt", target: "needle", replacement: "pin" },
    repo,
    { env }
  );
  assert.equal(multi.result.isError, true);
  assert.equal(multi.fileChange, undefined);
  assert.match(multi.result.content[0].text, /3 occurrences/i);
  assert.match(multi.result.content[0].text, /2,\s*4,\s*6/);
  assert.equal(fs.readFileSync(file, "utf8"), initial);
  assert.deepEqual(listTempArtifacts(repo), []);
});

test("workspace_edit handles replace_all and expected_occurrences as specified", () => {
  const { repo, env } = makeWorkspaceFixture("ws-edit-all-");
  const file = path.join(repo, "repeat.txt");
  const initial = "foo 1\nkeep\nfoo 2\nfoo 3\n";
  fs.writeFileSync(file, initial);

  // expected_occurrences mismatch returns isError with count + line numbers and leaves file unchanged.
  const wrongCount = callWorkspaceWriteTool(
    "workspace_edit",
    { path: "repeat.txt", target: "foo", replacement: "bar", replace_all: true, expected_occurrences: 2 },
    repo,
    { env }
  );
  assert.equal(wrongCount.result.isError, true);
  assert.equal(wrongCount.fileChange, undefined);
  assert.match(wrongCount.result.content[0].text, /3 occurrences/i);
  assert.match(wrongCount.result.content[0].text, /expected 2/i);
  assert.match(wrongCount.result.content[0].text, /1,\s*3,\s*4/);
  assert.equal(fs.readFileSync(file, "utf8"), initial);

  // replace_all on 0 matches still errors.
  const zeroAll = callWorkspaceWriteTool(
    "workspace_edit",
    { path: "repeat.txt", target: "missing", replacement: "bar", replace_all: true },
    repo,
    { env }
  );
  assert.equal(zeroAll.result.isError, true);
  assert.equal(fs.readFileSync(file, "utf8"), initial);

  // expected_occurrences matching actual count succeeds.
  const exactExpected = callWorkspaceWriteTool(
    "workspace_edit",
    { path: "repeat.txt", target: "foo", replacement: "baz", expected_occurrences: 3 },
    repo,
    { env }
  );
  assert.equal(exactExpected.result.isError, false);
  assert.deepEqual(exactExpected.fileChange, { path: "repeat.txt", kind: "edit", added: 3, removed: 3 });
  assert.equal(fs.readFileSync(file, "utf8"), "baz 1\nkeep\nbaz 2\nbaz 3\n");

  // replace_all: true replaces every match.
  const allRes = callWorkspaceWriteTool(
    "workspace_edit",
    { path: "repeat.txt", target: "baz", replacement: "qux", replace_all: true },
    repo,
    { env }
  );
  assert.equal(allRes.result.isError, false);
  assert.deepEqual(allRes.fileChange, { path: "repeat.txt", kind: "edit", added: 3, removed: 3 });
  assert.equal(fs.readFileSync(file, "utf8"), "qux 1\nkeep\nqux 2\nqux 3\n");
});

test("workspace_write supports create, overwrite, and append, and rejects create on existing files", () => {
  const { repo, env } = makeWorkspaceFixture("ws-write-modes-");

  // Default mode is create; creates nested parent directories inside root.
  const created = callWorkspaceWriteTool(
    "workspace_write",
    { path: "nested/dir/notes.txt", content: "line 1\nline 2\n" },
    repo,
    { env }
  );
  assert.equal(created.result.isError, false);
  assert.deepEqual(created.fileChange, { path: "nested/dir/notes.txt", kind: "create", added: 2, removed: 0 });
  assert.equal(fs.readFileSync(path.join(repo, "nested", "dir", "notes.txt"), "utf8"), "line 1\nline 2\n");

  // create on an existing file errors and leaves content intact.
  const duplicate = callWorkspaceWriteTool(
    "workspace_write",
    { path: "nested/dir/notes.txt", content: "clobber\n", mode: "create" },
    repo,
    { env }
  );
  assert.equal(duplicate.result.isError, true);
  assert.equal(duplicate.fileChange, undefined);
  assert.match(duplicate.result.content[0].text, /already exists/i);
  assert.equal(fs.readFileSync(path.join(repo, "nested", "dir", "notes.txt"), "utf8"), "line 1\nline 2\n");

  // append adds lines to existing file.
  const appended = callWorkspaceWriteTool(
    "workspace_write",
    { path: "nested/dir/notes.txt", content: "line 3\nline 4\n", mode: "append" },
    repo,
    { env }
  );
  assert.equal(appended.result.isError, false);
  assert.deepEqual(appended.fileChange, { path: "nested/dir/notes.txt", kind: "append", added: 2, removed: 0 });
  assert.equal(fs.readFileSync(path.join(repo, "nested", "dir", "notes.txt"), "utf8"), "line 1\nline 2\nline 3\nline 4\n");

  // overwrite replaces existing file with exact diff counts.
  const overwritten = callWorkspaceWriteTool(
    "workspace_write",
    { path: "nested/dir/notes.txt", content: "line 1\nreplaced\n", mode: "overwrite" },
    repo,
    { env }
  );
  assert.equal(overwritten.result.isError, false);
  assert.deepEqual(overwritten.fileChange, { path: "nested/dir/notes.txt", kind: "overwrite", added: 1, removed: 3 });
  assert.equal(fs.readFileSync(path.join(repo, "nested", "dir", "notes.txt"), "utf8"), "line 1\nreplaced\n");

  // append on a non-existent file creates it.
  const appendNew = callWorkspaceWriteTool(
    "workspace_write",
    { path: "fresh/log.txt", content: "first\n", mode: "append" },
    repo,
    { env }
  );
  assert.equal(appendNew.result.isError, false);
  assert.deepEqual(appendNew.fileChange, { path: "fresh/log.txt", kind: "append", added: 1, removed: 0 });
  assert.deepEqual(listTempArtifacts(repo), []);
});

test("256 KiB size cap holds across create, overwrite, append, and workspace_edit", () => {
  const { repo, env } = makeWorkspaceFixture("ws-write-cap-");

  // Exact 256 KiB succeeds.
  const exact = "a".repeat(WORKSPACE_WRITE_MAX_BYTES);
  const ok = callWorkspaceWriteTool("workspace_write", { path: "exact.txt", content: exact, mode: "create" }, repo, { env });
  assert.equal(ok.result.isError, false);
  assert.equal(Buffer.byteLength(fs.readFileSync(path.join(repo, "exact.txt"), "utf8"), "utf8"), WORKSPACE_WRITE_MAX_BYTES);

  // 256 KiB + 1 byte on create fails and creates no file or parent directory.
  const tooBig = "a".repeat(WORKSPACE_WRITE_MAX_BYTES + 1);
  const bigCreate = callWorkspaceWriteTool("workspace_write", { path: "never-created/big.txt", content: tooBig, mode: "create" }, repo, { env });
  assert.equal(bigCreate.result.isError, true);
  assert.equal(fs.existsSync(path.join(repo, "never-created")), false);

  // Appending 1 byte to an exact 256 KiB file fails and preserves existing file.
  const bigAppend = callWorkspaceWriteTool("workspace_write", { path: "exact.txt", content: "x", mode: "append" }, repo, { env });
  assert.equal(bigAppend.result.isError, true);
  assert.equal(fs.statSync(path.join(repo, "exact.txt")).size, WORKSPACE_WRITE_MAX_BYTES);

  // Editing a file so the result exceeds 256 KiB fails and preserves existing file.
  const bigEdit = callWorkspaceWriteTool("workspace_edit", { path: "exact.txt", target: "a", replacement: "aa", replace_all: true }, repo, { env });
  assert.equal(bigEdit.result.isError, true);
  assert.equal(fs.statSync(path.join(repo, "exact.txt")).size, WORKSPACE_WRITE_MAX_BYTES);

  // Overwrite over 256 KiB fails.
  const bigOverwrite = callWorkspaceWriteTool("workspace_write", { path: "exact.txt", content: tooBig, mode: "overwrite" }, repo, { env });
  assert.equal(bigOverwrite.result.isError, true);
  assert.deepEqual(listTempArtifacts(repo), []);
});

test("symlinks, .git paths, absolute paths, and '..' escapes are refused for both tools", () => {
  const { repo, outside, env } = makeWorkspaceFixture("ws-write-refuse-");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "real.txt"), "hello\n");
  fs.mkdirSync(path.join(repo, "realdir"), { recursive: true });
  fs.writeFileSync(path.join(repo, "realdir", "inner.txt"), "inner\n");
  fs.writeFileSync(path.join(outside, "ext.txt"), "external\n");

  // Symlinks: pointing outside, pointing inside, dangling, and symlink parent dir.
  fs.symlinkSync(path.join(outside, "ext.txt"), path.join(repo, "sym-out"));
  fs.symlinkSync(path.join(repo, "real.txt"), path.join(repo, "sym-in"));
  fs.symlinkSync(path.join(outside, "missing.txt"), path.join(repo, "sym-dangling"));
  fs.symlinkSync(outside, path.join(repo, "sym-dir-out"));
  fs.symlinkSync(path.join(repo, "realdir"), path.join(repo, "sym-dir-in"));

  const forbiddenPaths = [
    "sym-out",
    "sym-in",
    "sym-dangling",
    "sym-dir-out/new.txt",
    "sym-dir-in/inner.txt",
    "sym-dir-in/new.txt",
    ".git",
    ".git/config",
    ".git/hooks/pre-commit",
    "sub/.git/config",
    path.join(repo, "real.txt"),
    path.join(outside, "ext.txt"),
    "../outside/ext.txt",
    "realdir/../real.txt",
    "~/.gemini/x"
  ];

  for (const badPath of forbiddenPaths) {
    const w = callWorkspaceWriteTool("workspace_write", { path: badPath, content: "nope\n", mode: "overwrite" }, repo, { env });
    assert.equal(w.result.isError, true, `workspace_write should refuse ${badPath}`);
    assert.equal(w.fileChange, undefined);

    const e = callWorkspaceWriteTool("workspace_edit", { path: badPath, target: "hello", replacement: "bad" }, repo, { env });
    assert.equal(e.result.isError, true, `workspace_edit should refuse ${badPath}`);
    assert.equal(e.fileChange, undefined);
  }

  assert.equal(fs.readFileSync(path.join(repo, "real.txt"), "utf8"), "hello\n");
  assert.equal(fs.readFileSync(path.join(outside, "ext.txt"), "utf8"), "external\n");
  assert.equal(fs.existsSync(path.join(outside, "new.txt")), false);
  assert.deepEqual(listTempArtifacts(repo), []);
});

test("existing file permissions are preserved across edits and writes and no temp files remain", () => {
  const { repo, env } = makeWorkspaceFixture("ws-write-mode-");
  const scriptPath = path.join(repo, "run.sh");
  const secretPath = path.join(repo, "secret.txt");
  fs.writeFileSync(scriptPath, "#!/bin/sh\necho v1\n", { mode: 0o755 });
  fs.writeFileSync(secretPath, "token=a\n", { mode: 0o600 });
  if (process.platform !== "win32") {
    fs.chmodSync(scriptPath, 0o755);
    fs.chmodSync(secretPath, 0o600);
  }

  const edited = callWorkspaceWriteTool("workspace_edit", { path: "run.sh", target: "v1", replacement: "v2" }, repo, { env });
  assert.equal(edited.result.isError, false);
  const appended = callWorkspaceWriteTool("workspace_write", { path: "run.sh", content: "echo done\n", mode: "append" }, repo, { env });
  assert.equal(appended.result.isError, false);
  const overwritten = callWorkspaceWriteTool("workspace_write", { path: "secret.txt", content: "token=b\n", mode: "overwrite" }, repo, { env });
  assert.equal(overwritten.result.isError, false);

  if (process.platform !== "win32") {
    assert.equal(fs.statSync(scriptPath).mode & 0o777, 0o755);
    assert.equal(fs.statSync(secretPath).mode & 0o777, 0o600);
  }
  assert.deepEqual(listTempArtifacts(repo), []);

  // Invalid tool / bad args / bad executionRoot return isError and never throw.
  assert.equal(callWorkspaceWriteTool("unknown_tool", {}, repo, { env }).result.isError, true);
  assert.equal(callWorkspaceWriteTool("workspace_edit", { path: "run.sh", target: "v2", replacement: "v3", extra: 1 }, repo, { env }).result.isError, true);
  assert.equal(callWorkspaceWriteTool("workspace_write", { path: "a.txt", content: "x" }, path.join(repo, "missing"), { env }).result.isError, true);
});
