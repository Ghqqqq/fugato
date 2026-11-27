import "./test-environment.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { initGitRepo, makeTempDir } from "./helpers.mjs";
import { PARENT_BRIDGE_ENV } from "../plugins/codex/scripts/lib/job-runtime.mjs";
import { readJobFile, resolveJobFile, upsertJob, writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";
import { acpPolicyDenial, autoAllowedParentBridgeTool, editAmbiguityWarning, GEMINI_WORKSPACE_GUIDANCE } from "../plugins/codex/scripts/lib/antigravity.mjs";

const bridgeScript = fileURLToPath(new URL("../plugins/codex/scripts/parent-bridge-mcp.mjs", import.meta.url));

function fixture(prefix) {
  const dir = makeTempDir(prefix);
  const home = path.join(dir, "home"), isolated = path.join(dir, "isolated"), repo = path.join(dir, "repo"), outside = path.join(dir, "outside");
  for (const value of [home, isolated, repo, outside]) fs.mkdirSync(value, { recursive: true });
  initGitRepo(repo);
  return { dir, home, isolated, repo, outside, env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_COMPANION_HOME: isolated } };
}

test("parent bridge auto-allows workspace_edit/workspace_write on Antigravity only, with exact keys", () => {
  const serverName = "duet_parent_aabbccddeeff";
  const call = (toolName, rawInput) => ({ tool: { name: `mcp_${serverName}_${toolName}`, kind: "other", rawInput, args: structuredClone(rawInput) }, diffs: [] });
  const agy = { serverName, backend: "antigravity", roundtable: false };
  assert.equal(autoAllowedParentBridgeTool(call("workspace_edit", { path: "a.txt", target: "x", replacement: "y", toolSummary: "Edit" }), agy), "workspace_edit");
  assert.equal(autoAllowedParentBridgeTool(call("workspace_write", { path: "b.txt", content: "z", mode: "create" }), agy), "workspace_write");
  assert.equal(autoAllowedParentBridgeTool(call("workspace_edit", { path: "a.txt", target: "x", replacement: "y", Overwrite: true }), agy), null);
  assert.equal(autoAllowedParentBridgeTool(call("workspace_write", { path: "b.txt", content: "z" }), { ...agy, backend: "codex" }), null);
  assert.match(GEMINI_WORKSPACE_GUIDANCE, /workspace_edit/);
});

test("boundary policy denies protected homes, forbidden commands and out-of-worktree writes before parking", () => {
  const f = fixture("acp-wiring-policy-");
  fs.writeFileSync(path.join(f.repo, "a.txt"), "x\n");
  const deny = tool => acpPolicyDenial(tool, f.repo, f.env);
  assert.equal(deny({ name: "read_file", kind: "read", rawInput: { AbsolutePath: path.join(f.repo, "a.txt") } }), null);
  assert.equal(deny({ name: "edit_file", kind: "edit", rawInput: { Path: "a.txt", Target: "x", Replacement: "y" } }), null);
  assert.equal(deny({ name: "run_command", kind: "execute", rawInput: { CommandLine: "node --test tests/a.test.mjs" } }), null);
  assert.equal(deny({ name: "read_file", kind: "read", rawInput: { AbsolutePath: "~/.gemini/oauth_creds.json" } }).code, "protected_home");
  assert.equal(deny({ name: "read_file", kind: "read", locations: [{ path: path.join(f.isolated, "config.toml") }] }).code, "protected_home");
  assert.equal(deny({ name: "write_file", kind: "edit", rawInput: { Path: path.join(f.outside, "x.txt"), Content: "" } }).code, "outside_workspace");
  assert.equal(deny({ name: "write_file", kind: "edit", rawInput: { Path: ".git/hooks/pre-commit", Content: "" } }).code, "git_metadata_write");
  for (const CommandLine of ["npm run build", "npm run verify", "git push origin main", "npm publish", "cat ~/.codex/auth.json"]) {
    assert.equal(deny({ name: "run_command", kind: "execute", rawInput: { CommandLine } }).code, "forbidden_command", CommandLine);
  }
  assert.equal(deny({ name: "run_command", kind: "execute", rawInput: { CommandLine: "ls", Cwd: path.join(f.home, ".claude") } }).code, "protected_home");
});

test("built-in edit_file cards warn on ambiguous and missing targets but stay parked", () => {
  const f = fixture("acp-wiring-edit-");
  fs.writeFileSync(path.join(f.repo, "t.txt"), "alpha beta alpha\n");
  const card = rawInput => editAmbiguityWarning({ name: "edit_file", kind: "edit", rawInput }, f.repo);
  assert.match(card({ Path: "t.txt", Target: "alpha", Replacement: "x" }), /^AMBIGUOUS: .* 2 occurrences .*workspace_edit/);
  assert.match(card({ Path: "t.txt", Target: "gamma", Replacement: "x" }), /^NO MATCH: /);
  assert.equal(card({ Path: "t.txt", Target: "beta", Replacement: "x" }), null);
  assert.equal(card({ Path: path.join(f.outside, "t.txt"), Target: "alpha", Replacement: "x" }), null);
});

test("bridge workspace_edit/workspace_write edit inside the worktree, record fileChange activity and bridgeTouchedFiles", async t => {
  const f = fixture("acp-wiring-bridge-");
  fs.writeFileSync(path.join(f.repo, "app.txt"), "one\ntwo\n");
  const job = { id: "job-write", workspaceRoot: f.repo, backend: "antigravity", threadId: "t-write", turnId: "turn-write",
    status: "running", pid: process.pid, request: { backend: "antigravity" } };
  const previous = process.env.CODEX_COMPANION_HOME;
  process.env.CODEX_COMPANION_HOME = f.isolated;
  t.after(() => { if (previous === undefined) delete process.env.CODEX_COMPANION_HOME; else process.env.CODEX_COMPANION_HOME = previous; });
  upsertJob(f.repo, job); writeJobFile(f.repo, job.id, job);
  const child = spawn(process.execPath, [bridgeScript], { cwd: f.repo, stdio: ["pipe", "pipe", "pipe"], env: { ...f.env,
    [PARENT_BRIDGE_ENV.cwd]: f.repo, [PARENT_BRIDGE_ENV.jobId]: job.id, CODEX_COMPANION_BRIDGE_BACKEND: "antigravity", CODEX_COMPANION_BRIDGE_EXEC_CWD: f.repo } });
  t.after(() => { try { child.kill("SIGKILL"); } catch {} });
  const pending = new Map(); let nextId = 1;
  createInterface({ input: child.stdout }).on("line", line => { const msg = JSON.parse(line); pending.get(msg.id)?.(msg); pending.delete(msg.id); });
  const request = (method, params) => new Promise(resolve => { const id = nextId++; pending.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`); });
  const call = async (name, args) => (await request("tools/call", { name, arguments: args })).result;

  const names = (await request("tools/list", {})).result.tools.map(tool => tool.name);
  assert.ok(names.includes("workspace_edit") && names.includes("workspace_write"));
  const edited = await call("workspace_edit", { path: "app.txt", target: "two", replacement: "TWO" });
  assert.equal(edited.isError, false, edited.content[0].text);
  assert.equal(fs.readFileSync(path.join(f.repo, "app.txt"), "utf8"), "one\nTWO\n");
  const created = await call("workspace_write", { path: "src/new.txt", content: "a\nb\n" });
  assert.equal(created.isError, false, created.content[0].text);
  const escaped = await call("workspace_write", { path: "../outside/x.txt", content: "no" });
  assert.equal(escaped.isError, true);
  assert.equal(fs.existsSync(path.join(f.outside, "x.txt")), false);

  const stored = readJobFile(resolveJobFile(f.repo, job.id));
  assert.deepEqual(stored.bridgeTouchedFiles, ["app.txt", "src/new.txt"]);
  const changes = stored.activity.filter(event => event.type === "fileChange");
  assert.deepEqual(changes.map(({ path: file, kind, added, removed }) => ({ file, kind, added, removed })),
    [{ file: "app.txt", kind: "update", added: 1, removed: 1 }, { file: "src/new.txt", kind: "add", added: 2, removed: 0 }]);
});
