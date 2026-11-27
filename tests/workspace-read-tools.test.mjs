import "./test-environment.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { initGitRepo, makeTempDir, writeExecutable } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { installFakeAntigravity } from "./fake-antigravity-fixture.mjs";
import { PARENT_BRIDGE_ENV } from "../plugins/codex/scripts/lib/job-runtime.mjs";
import { upsertJob, writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";
import { autoAllowedParentBridgeTool, parentBridgeToolKeys, runAntigravityTurn } from "../plugins/codex/scripts/lib/antigravity.mjs";

const bridgeScript = fileURLToPath(new URL("../plugins/codex/scripts/parent-bridge-mcp.mjs", import.meta.url));
const companionScript = fileURLToPath(new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url));

function startBridge(t, { cwd, env }) {
  const child = spawn(process.execPath, [bridgeScript], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { try { child.kill("SIGKILL"); } catch {} });
  const pending = new Map();
  let nextId = 1;
  createInterface({ input: child.stdout }).on("line", line => {
    const msg = JSON.parse(line);
    const waiter = pending.get(msg.id);
    if (waiter) { pending.delete(msg.id); waiter(msg); }
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout waiting for ${method}`)); }, 15_000);
    pending.set(id, msg => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  return { child, request };
}

function seedActiveJob(workspaceRoot, { id, backend, threadId, turnId, roundtable = null }) {
  const job = {
    id, workspaceRoot, backend, threadId, turnId, status: "running", pid: process.pid,
    request: { backend, ...(roundtable ? { roundtable } : {}) }
  };
  upsertJob(workspaceRoot, job);
  writeJobFile(workspaceRoot, id, job);
  return job;
}

test("tools/list exposes workspace tools only on antigravity bridges with a valid exec cwd and keeps codex unchanged", async t => {
  const dir = makeTempDir("ws-bridge-list-");
  const prevHome = process.env.CODEX_COMPANION_HOME;
  const isoHome = path.join(dir, "isolated");
  process.env.CODEX_COMPANION_HOME = isoHome;
  t.after(() => {
    if (prevHome === undefined) delete process.env.CODEX_COMPANION_HOME;
    else process.env.CODEX_COMPANION_HOME = prevHome;
  });
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo, { recursive: true });
  seedActiveJob(repo, { id: "job-agy-plain", backend: "antigravity", threadId: "t-agy-1", turnId: "turn-1" });
  seedActiveJob(repo, { id: "job-agy-rt", backend: "antigravity", threadId: "t-agy-2", turnId: "turn-2", roundtable: { roomId: "rt-1", persona: "critic" } });
  seedActiveJob(repo, { id: "job-cdx-plain", backend: "codex", threadId: "t-cdx-1", turnId: "turn-3" });
  seedActiveJob(repo, { id: "job-cdx-rt", backend: "codex", threadId: "t-cdx-2", turnId: "turn-4", roundtable: { roomId: "rt-1", persona: "improver" } });
  const baseEnv = { ...process.env, CODEX_COMPANION_HOME: isoHome, [PARENT_BRIDGE_ENV.cwd]: repo };
  const listTools = async extraEnv => {
    const bridge = startBridge(t, { cwd: repo, env: { ...baseEnv, ...extraEnv } });
    const res = await bridge.request("tools/list");
    return res.result.tools.map(tool => tool.name);
  };
  assert.deepEqual(await listTools({
    [PARENT_BRIDGE_ENV.jobId]: "job-agy-plain", CODEX_COMPANION_BRIDGE_BACKEND: "antigravity", CODEX_COMPANION_BRIDGE_EXEC_CWD: repo
  }), ["ask_parent", "workspace_list", "workspace_grep", "workspace_git_read", "workspace_edit", "workspace_write"]);
  assert.deepEqual(await listTools({
    [PARENT_BRIDGE_ENV.jobId]: "job-agy-rt", CODEX_COMPANION_BRIDGE_BACKEND: "antigravity", CODEX_COMPANION_BRIDGE_EXEC_CWD: repo
  }), ["ask_parent", "forum_read", "forum_post", "workspace_list", "workspace_grep", "workspace_git_read", "workspace_edit", "workspace_write"]);
  assert.deepEqual(await listTools({
    [PARENT_BRIDGE_ENV.jobId]: "job-agy-plain", CODEX_COMPANION_BRIDGE_BACKEND: "antigravity"
  }), ["ask_parent"]);
  assert.deepEqual(await listTools({
    [PARENT_BRIDGE_ENV.jobId]: "job-agy-plain", CODEX_COMPANION_BRIDGE_BACKEND: "antigravity", CODEX_COMPANION_BRIDGE_EXEC_CWD: "relative/path"
  }), ["ask_parent"]);
  assert.deepEqual(await listTools({
    [PARENT_BRIDGE_ENV.jobId]: "job-agy-plain", CODEX_COMPANION_BRIDGE_BACKEND: "antigravity", CODEX_COMPANION_BRIDGE_EXEC_CWD: path.join(dir, "missing")
  }), ["ask_parent"]);
  assert.deepEqual(await listTools({
    [PARENT_BRIDGE_ENV.jobId]: "job-cdx-plain", CODEX_COMPANION_BRIDGE_BACKEND: "codex", CODEX_COMPANION_BRIDGE_EXEC_CWD: repo
  }), ["ask_parent"]);
  assert.deepEqual(await listTools({
    [PARENT_BRIDGE_ENV.jobId]: "job-cdx-rt", CODEX_COMPANION_BRIDGE_BACKEND: "codex", CODEX_COMPANION_BRIDGE_EXEC_CWD: repo
  }), ["ask_parent", "forum_read", "forum_post"]);
});

test("workspace_list, workspace_grep and workspace_git_read return expected output and truncation notes in git and non-git workspaces", async t => {
  const dir = makeTempDir("ws-bridge-ops-");
  const prevHome = process.env.CODEX_COMPANION_HOME;
  const isoHome = path.join(dir, "isolated");
  process.env.CODEX_COMPANION_HOME = isoHome;
  t.after(() => {
    if (prevHome === undefined) delete process.env.CODEX_COMPANION_HOME;
    else process.env.CODEX_COMPANION_HOME = prevHome;
  });
  const repo = path.join(dir, "repo");
  fs.mkdirSync(path.join(repo, "src", "nested"), { recursive: true });
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "alpha hello\n");
  fs.writeFileSync(path.join(repo, "src", "app.js"), `const needle = "a[0]+b";\nconst longLine = "HIT_${"x".repeat(360)}";\n`);
  fs.writeFileSync(path.join(repo, "src", "nested", "deep.js"), "ALPHA deep\n");
  fs.writeFileSync(path.join(repo, "src", "bin.dat"), Buffer.from([0, 1, 2, ...Buffer.from("alpha binary")]));
  fs.symlinkSync("README.md", path.join(repo, "link-readme"));
  assert.equal(spawnSync("git", ["add", "README.md", "src"], { cwd: repo }).status, 0);
  assert.equal(spawnSync("git", ["commit", "-m", "initial commit"], { cwd: repo }).status, 0);
  fs.writeFileSync(path.join(repo, "README.md"), "alpha hello modified\n");
  fs.writeFileSync(path.join(repo, "staged.txt"), "staged alpha\n");
  assert.equal(spawnSync("git", ["add", "staged.txt"], { cwd: repo }).status, 0);
  fs.writeFileSync(path.join(repo, "untracked.txt"), "alpha untracked\n");
  fs.writeFileSync(path.join(repo, "big.txt"), `${"A".repeat(100)}\n`.repeat(900));
  assert.equal(spawnSync("git", ["add", "big.txt"], { cwd: repo }).status, 0);

  seedActiveJob(repo, { id: "job-ops", backend: "antigravity", threadId: "t-ops", turnId: "turn-ops" });
  const bridge = startBridge(t, { cwd: repo, env: {
    ...process.env, CODEX_COMPANION_HOME: isoHome, [PARENT_BRIDGE_ENV.cwd]: repo,
    [PARENT_BRIDGE_ENV.jobId]: "job-ops", CODEX_COMPANION_BRIDGE_BACKEND: "antigravity", CODEX_COMPANION_BRIDGE_EXEC_CWD: repo
  } });
  const call = async (name, args) => (await bridge.request("tools/call", { name, arguments: args })).result;

  const listed = await call("workspace_list", { depth: 2 });
  assert.equal(listed.isError, false);
  const lines = listed.content[0].text.split("\n");
  assert.ok(!lines.some(l => l.startsWith(".git")));
  assert.ok(lines.includes("link-readme -> (symlink)"));
  assert.ok(lines.includes("src/"));
  assert.ok(lines.includes("src/app.js"));
  assert.ok(lines.includes("src/nested/"));
  assert.ok(!lines.includes("src/nested/deep.js"));
  const truncList = await call("workspace_list", { limit: 2 });
  assert.equal(truncList.isError, false);
  assert.match(truncList.content[0].text, /truncated/i);
  assert.equal(truncList.content[0].text.split("\n").length, 3);
});

test("workspace_grep and workspace_git_read handle git, non-git, binary skip, line cap and output truncation", async t => {
  const dir = makeTempDir("ws-bridge-git-");
  const prevHome = process.env.CODEX_COMPANION_HOME;
  const isoHome = path.join(dir, "isolated");
  process.env.CODEX_COMPANION_HOME = isoHome;
  t.after(() => {
    if (prevHome === undefined) delete process.env.CODEX_COMPANION_HOME;
    else process.env.CODEX_COMPANION_HOME = prevHome;
  });
  const repo = path.join(dir, "repo");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "alpha one\n");
  fs.writeFileSync(path.join(repo, "src", "app.js"), `const needle = "a[0]+b";\nconst long = "HIT_${"x".repeat(360)}";\n`);
  fs.writeFileSync(path.join(repo, "src", "bin.dat"), Buffer.from([0, 1, 2, ...Buffer.from("alpha binary")]));
  assert.equal(spawnSync("git", ["add", "."], { cwd: repo }).status, 0);
  assert.equal(spawnSync("git", ["commit", "-m", "init commit"], { cwd: repo }).status, 0);
  fs.writeFileSync(path.join(repo, "README.md"), "alpha one\nalpha two\n");
  fs.writeFileSync(path.join(repo, "untracked.txt"), "ALPHA untracked\n");
  fs.writeFileSync(path.join(repo, "big.txt"), `${"B".repeat(100)}\n`.repeat(900));
  assert.equal(spawnSync("git", ["add", "big.txt"], { cwd: repo }).status, 0);

  seedActiveJob(repo, { id: "job-git", backend: "antigravity", threadId: "t-git", turnId: "turn-git" });
  const bridge = startBridge(t, { cwd: repo, env: {
    ...process.env, CODEX_COMPANION_HOME: isoHome, [PARENT_BRIDGE_ENV.cwd]: repo,
    [PARENT_BRIDGE_ENV.jobId]: "job-git", CODEX_COMPANION_BRIDGE_BACKEND: "antigravity", CODEX_COMPANION_BRIDGE_EXEC_CWD: repo
  } });
  const call = async (name, args) => (await bridge.request("tools/call", { name, arguments: args })).result;

  const grepAll = await call("workspace_grep", { pattern: "alpha", ignore_case: true });
  assert.equal(grepAll.isError, false);
  assert.match(grepAll.content[0].text, /^README\.md:1: alpha one$/m);
  assert.match(grepAll.content[0].text, /^untracked\.txt:1: ALPHA untracked$/m);
  assert.doesNotMatch(grepAll.content[0].text, /bin\.dat/);
  const grepFixed = await call("workspace_grep", { pattern: "a[0]+b", fixed: true, glob: "*.js" });
  assert.match(grepFixed.content[0].text, /^src\/app\.js:1: const needle = "a\[0\]\+b";$/);
  const grepLong = await call("workspace_grep", { pattern: "HIT_" });
  const longText = grepLong.content[0].text.split(": ").slice(1).join(": ");
  assert.ok(longText.length <= 300);
  const grepTrunc = await call("workspace_grep", { pattern: "alpha", ignore_case: true, max_results: 1 });
  assert.match(grepTrunc.content[0].text, /truncated/i);

  const status = await call("workspace_git_read", { op: "status" });
  assert.equal(status.isError, false);
  assert.match(status.content[0].text, /M README\.md/);
  assert.match(status.content[0].text, /\?\? untracked\.txt/);
  const log = await call("workspace_git_read", { op: "log", max_count: 1 });
  assert.match(log.content[0].text, /init commit/);
  const diff = await call("workspace_git_read", { op: "diff", path: "README.md" });
  assert.match(diff.content[0].text, /\+alpha two/);
  const staged = await call("workspace_git_read", { op: "diff", staged: true });
  assert.match(staged.content[0].text, /truncated.*64 KiB/i);
  const show = await call("workspace_git_read", { op: "show", rev: "HEAD" });
  assert.match(show.content[0].text, /init commit/);

  const nonGit = path.join(dir, "plain");
  fs.mkdirSync(nonGit, { recursive: true });
  fs.writeFileSync(path.join(nonGit, "note.txt"), "plain_match\n");
  seedActiveJob(nonGit, { id: "job-plain", backend: "antigravity", threadId: "t-plain", turnId: "turn-plain" });
  const plainBridge = startBridge(t, { cwd: nonGit, env: {
    ...process.env, CODEX_COMPANION_HOME: isoHome, [PARENT_BRIDGE_ENV.cwd]: nonGit,
    [PARENT_BRIDGE_ENV.jobId]: "job-plain", CODEX_COMPANION_BRIDGE_BACKEND: "antigravity", CODEX_COMPANION_BRIDGE_EXEC_CWD: nonGit
  } });
  const nonGitGrep = (await plainBridge.request("tools/call", { name: "workspace_grep", arguments: { pattern: "plain_match" } })).result;
  assert.equal(nonGitGrep.isError, false);
  assert.equal(nonGitGrep.content[0].text, "note.txt:1: plain_match");
});

test("escapes, symlinks outside W, nonexistent paths and unsafe refs are refused with isError", async t => {
  const dir = makeTempDir("ws-bridge-esc-");
  const prevHome = process.env.CODEX_COMPANION_HOME;
  const isoHome = path.join(dir, "isolated");
  process.env.CODEX_COMPANION_HOME = isoHome;
  t.after(() => {
    if (prevHome === undefined) delete process.env.CODEX_COMPANION_HOME;
    else process.env.CODEX_COMPANION_HOME = prevHome;
  });
  const repo = path.join(dir, "repo"), outside = path.join(dir, "outside");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "file.txt"), "inside\n");
  fs.writeFileSync(path.join(outside, "secret.txt"), "outside_secret\n");
  fs.symlinkSync(outside, path.join(repo, "escape-dir"));
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(repo, "escape-file"));
  assert.equal(spawnSync("git", ["add", "file.txt"], { cwd: repo }).status, 0);
  assert.equal(spawnSync("git", ["commit", "-m", "init"], { cwd: repo }).status, 0);

  seedActiveJob(repo, { id: "job-esc", backend: "antigravity", threadId: "t-esc", turnId: "turn-esc" });
  const bridge = startBridge(t, { cwd: repo, env: {
    ...process.env, CODEX_COMPANION_HOME: isoHome, [PARENT_BRIDGE_ENV.cwd]: repo,
    [PARENT_BRIDGE_ENV.jobId]: "job-esc", CODEX_COMPANION_BRIDGE_BACKEND: "antigravity", CODEX_COMPANION_BRIDGE_EXEC_CWD: repo
  } });
  const call = async (name, args) => (await bridge.request("tools/call", { name, arguments: args })).result;

  for (const [name, args] of [
    ["workspace_list", { path: ".." }],
    ["workspace_list", { path: "../outside" }],
    ["workspace_list", { path: outside }],
    ["workspace_list", { path: "escape-dir" }],
    ["workspace_list", { path: "missing-dir" }],
    ["workspace_grep", { pattern: "outside", path: ".." }],
    ["workspace_grep", { pattern: "outside", path: outside }],
    ["workspace_grep", { pattern: "outside", path: "escape-file" }],
    ["workspace_git_read", { op: "status", path: ".." }],
    ["workspace_git_read", { op: "diff", path: outside }],
    ["workspace_git_read", { op: "log", path: "escape-dir" }],
    ["workspace_git_read", { op: "log", rev: "--exec=touch" }],
    ["workspace_git_read", { op: "show", rev: "HEAD --output=/tmp/x" }],
    ["workspace_git_read", { op: "diff", base: "-n" }],
    ["workspace_git_read", { op: "diff", base: "HEAD main" }]
  ]) {
    const res = await call(name, args);
    assert.equal(res.isError, true, `${name} ${JSON.stringify(args)} should fail`);
    assert.ok(res.content[0].text.length > 0);
  }
});

test("repo .git/config core.fsmonitor and core.pager hooks are never executed", async t => {
  const dir = makeTempDir("ws-bridge-cfg-");
  const prevHome = process.env.CODEX_COMPANION_HOME;
  const isoHome = path.join(dir, "isolated");
  process.env.CODEX_COMPANION_HOME = isoHome;
  t.after(() => {
    if (prevHome === undefined) delete process.env.CODEX_COMPANION_HOME;
    else process.env.CODEX_COMPANION_HOME = prevHome;
  });
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo, { recursive: true });
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "hello\n");
  assert.equal(spawnSync("git", ["add", "a.txt"], { cwd: repo }).status, 0);
  assert.equal(spawnSync("git", ["commit", "-m", "init"], { cwd: repo }).status, 0);
  fs.writeFileSync(path.join(repo, "a.txt"), "hello changed\n");

  const marker = path.join(dir, "trap-ran");
  const trap = path.join(dir, "trap.sh");
  writeExecutable(trap, `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\nexit 0\n`);
  assert.equal(spawnSync("git", ["config", "core.fsmonitor", trap], { cwd: repo }).status, 0);
  assert.equal(spawnSync("git", ["config", "core.pager", trap], { cwd: repo }).status, 0);

  seedActiveJob(repo, { id: "job-cfg", backend: "antigravity", threadId: "t-cfg", turnId: "turn-cfg" });
  const bridge = startBridge(t, { cwd: repo, env: {
    ...process.env, CODEX_COMPANION_HOME: isoHome, [PARENT_BRIDGE_ENV.cwd]: repo,
    [PARENT_BRIDGE_ENV.jobId]: "job-cfg", CODEX_COMPANION_BRIDGE_BACKEND: "antigravity", CODEX_COMPANION_BRIDGE_EXEC_CWD: repo
  } });
  const call = async (name, args) => (await bridge.request("tools/call", { name, arguments: args })).result;

  for (const [name, args] of [
    ["workspace_git_read", { op: "status" }],
    ["workspace_git_read", { op: "diff" }],
    ["workspace_git_read", { op: "log" }],
    ["workspace_grep", { pattern: "hello" }]
  ]) {
    const res = await call(name, args);
    assert.equal(res.isError, false, `${name} ${JSON.stringify(args)}: ${res.content[0].text}`);
  }
  assert.equal(fs.existsSync(marker), false, "untrusted core.fsmonitor/core.pager script must not run");
});

test("autoAllowedParentBridgeTool allows workspace tools on antigravity bridges and rejects extra keys or non-antigravity bridges", () => {
  const serverName = "duet_parent_aabbccddeeff";
  const agyBridge = { serverName, backend: "antigravity", roundtable: false };
  const codexBridge = { serverName, backend: "codex", roundtable: false };
  const untypedBridge = { serverName, roundtable: false };
  const makeCall = (toolName, rawInput, extra = {}) => ({
    tool: { name: `mcp_${serverName}_${toolName}`, kind: "other", rawInput, args: structuredClone(rawInput), ...extra },
    diffs: []
  });

  assert.equal(autoAllowedParentBridgeTool(makeCall("workspace_grep", { pattern: "foo", glob: "*.mjs", toolSummary: "Search" }), agyBridge), "workspace_grep");
  assert.equal(autoAllowedParentBridgeTool(makeCall("workspace_list", { path: "src", depth: 2, toolSummary: "List" }), agyBridge), "workspace_list");
  assert.equal(autoAllowedParentBridgeTool(makeCall("workspace_git_read", { op: "diff", staged: true, toolSummary: "Diff" }), agyBridge), "workspace_git_read");
  assert.equal(autoAllowedParentBridgeTool(makeCall("workspace_grep", { pattern: "foo", extra: "bad", toolSummary: "Search" }), agyBridge), null);
  assert.equal(autoAllowedParentBridgeTool(makeCall("workspace_grep", { pattern: "foo", toolSummary: "Search" }), codexBridge), null);
  assert.equal(autoAllowedParentBridgeTool(makeCall("workspace_grep", { pattern: "foo", toolSummary: "Search" }), untypedBridge), null);
  assert.ok(parentBridgeToolKeys("workspace_grep").has("pattern"));
  assert.ok(parentBridgeToolKeys("workspace_grep").has("toolSummary"));
  assert.equal(parentBridgeToolKeys("workspace_grep").has("extra"), false);
});

test("Gemini-only workspace tool guidance appears in Gemini job instructions and is absent from Codex job instructions", () => {
  const dir = makeTempDir("ws-bridge-guide-");
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo, { recursive: true });
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "fixture\n");
  assert.equal(spawnSync("git", ["add", "README.md"], { cwd: repo }).status, 0);
  assert.equal(spawnSync("git", ["commit", "-m", "init"], { cwd: repo }).status, 0);
  const acp = installFakeAntigravity(dir);
  installFakeCodex(dir);
  const env = {
    ...buildEnv(dir),
    FUGATO_ANTIGRAVITY_BIN: acp.binary,
    CODEX_COMPANION_BIN: path.join(dir, "codex"),
    CODEX_COMPANION_HOME: path.join(dir, "isolated"),
    CLAUDE_PLUGIN_DATA: path.join(dir, "data"),
    CODEX_COMPANION_SESSION_ID: "ws-guide-session"
  };

  const agyRun = spawnSync(process.execPath, [companionScript, "task", "--backend", "antigravity", "--direct", "--no-claude-md", "Inspect repository."], {
    cwd: repo, env, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL"
  });
  assert.equal(agyRun.status, 0, agyRun.stderr + agyRun.stdout);
  const agyPrompt = acp.requests().find(r => r.method === "session/prompt").params.prompt.map(p => p.text).join("\n");
  assert.match(agyPrompt, /read_file/);
  assert.match(agyPrompt, /workspace_list/);
  assert.match(agyPrompt, /workspace_grep/);
  assert.match(agyPrompt, /workspace_git_read/);

  const cdxRun = spawnSync(process.execPath, [companionScript, "task", "--backend", "codex", "--direct", "--no-claude-md", "Inspect repository."], {
    cwd: repo, env, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL"
  });
  assert.equal(cdxRun.status, 0, cdxRun.stderr + cdxRun.stdout);
  const cdxRequests = fs.readFileSync(path.join(dir, "fake-codex-state.json.requests.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  const cdxPayload = JSON.stringify(cdxRequests.filter(r => r.method === "thread/start" || r.method === "turn/start"));
  assert.doesNotMatch(cdxPayload, /workspace_list|workspace_grep|workspace_git_read/);
});
