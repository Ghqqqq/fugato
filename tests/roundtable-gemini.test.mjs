import "./test-environment.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { buildEnv } from "./fake-codex-fixture.mjs";
import { installFakeAntigravity } from "./fake-antigravity-fixture.mjs";
import { initGitRepo, makeTempDir, writeExecutable } from "./helpers.mjs";
import { runAntigravityTurn } from "../plugins/codex/scripts/lib/antigravity.mjs";
import { antigravityTaskSettings, formatRoundtableStartMembers, validateRoundtableSeats } from "../plugins/codex/scripts/codex-companion.mjs";
import * as forum from "../plugins/codex/scripts/lib/forum.mjs";
import { resolveRoster } from "../plugins/codex/scripts/lib/roundtable-personas.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";

const companion = new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url).pathname;


function makeFixture(acpOptions = "normal") {
  const dir = makeTempDir("rt-gemini-"), repo = path.join(dir, "repo");
  fs.mkdirSync(repo); initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "fixture\n");
  assert.equal(spawnSync("git", ["add", "README.md"], { cwd: repo }).status, 0);
  assert.equal(spawnSync("git", ["commit", "-m", "init"], { cwd: repo }).status, 0);
  const acp = installFakeAntigravity(dir, acpOptions);
  const codexCalls = path.join(dir, "unexpected-codex.jsonl"), codexTrap = path.join(dir, "codex-trap");
  writeExecutable(codexTrap, `#!/usr/bin/env node\nrequire("node:fs").appendFileSync(${JSON.stringify(codexCalls)}, "called\\n"); process.exit(97);\n`);
  const env = {
    ...buildEnv(dir), FUGATO_ANTIGRAVITY_BIN: acp.binary, CODEX_COMPANION_BIN: codexTrap,
    CODEX_COMPANION_HOME: path.join(dir, "isolated"), CLAUDE_PLUGIN_DATA: path.join(dir, "data"),
    CODEX_COMPANION_SESSION_ID: "rt-gemini-session"
  };
  const invoke = (args, input, extraEnv = {}) => spawnSync(process.execPath, [companion, ...args], {
    cwd: repo, env: { ...env, ...extraEnv }, input, encoding: "utf8", timeout: 30000, killSignal: "SIGKILL"
  });
  const stored = (cwd, id) => JSON.parse(fs.readFileSync(path.join(resolveStateDir(cwd, env), "jobs", `${id}.json`), "utf8"));
  return { dir, repo, env, acp, codexCalls, invoke, stored };
}

test("roundtable start helpers format mixed Codex/Gemini headers and enforce agy + permission mapping", () => {
  const f = makeFixture();
  const formatted = formatRoundtableStartMembers("rt-abc-1234", [
    { persona: "improver", name: "improver", model: "gpt-6.2-sol", effort: "high", workspace: { path: "/ws/improver", base: null, shared: true } },
    { persona: "critic", name: "critic", model: "gemini-4-neon", effort: "high", workspace: { path: "/ws/critic", base: null, shared: true } }
  ]);
  assert.deepEqual(formatted.map(m => [m.persona, m.backend, m.agentType]), [
    ["improver", "codex", "fugato:codex-native"],
    ["critic", "antigravity", "fugato:gemini-native"]
  ]);
  assert.equal(formatted[0].header, 'DUET: --model gpt-6.2-sol --effort high --normal --roundtable rt-abc-1234 --persona improver --cwd "/ws/improver"');
  assert.equal(formatted[1].header, 'DUET: --backend antigravity --model gemini-4-neon --effort high --roundtable rt-abc-1234 --persona critic --cwd "/ws/critic"');

  validateRoundtableSeats(formatted, { cwd: f.repo, env: f.env });
  assert.throws(() => validateRoundtableSeats(formatted, { cwd: f.repo, env: { ...f.env, FUGATO_ANTIGRAVITY_BIN: path.join(f.dir, "missing-agy") } }), /critic/);
  const cfg = path.join(f.env.CODEX_COMPANION_HOME, "duet", "config.toml");
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, 'permission_mapping = "claude"\n');
  assert.throws(() => validateRoundtableSeats(formatted, { cwd: f.repo, env: f.env }), /critic/);
  validateRoundtableSeats([formatted[0]], { cwd: f.repo, env: { ...f.env, FUGATO_ANTIGRAVITY_BIN: path.join(f.dir, "missing-agy") } });
});

test("roundtable start CLI outputs mixed Gemini/Codex seats and refuses missing agy or claude permission mapping", t => {
  const f = makeFixture();
  const roomsDir = path.join(f.env.CODEX_COMPANION_HOME, "duet", "roundtables");
  const noAgy = f.invoke(["roundtable", "start", "--roles", "improver,critic", "--persona-model", "critic=gemini-4-neon:high", "--json"], "Goal", {
    FUGATO_ANTIGRAVITY_BIN: path.join(f.dir, "missing-agy")
  });
  assert.equal(noAgy.status, 1);
  assert.match(noAgy.stderr, /critic/);
  assert.equal(fs.existsSync(roomsDir), false);

  const badEffort = f.invoke(["roundtable", "start", "--roles", "critic", "--persona-model", "critic=gemini-4-neon:max", "--json"], "Goal");
  assert.equal(badEffort.status, 1);
  assert.match(badEffort.stderr, /Gemini effort/i);
  assert.equal(fs.existsSync(roomsDir), false);

  const cfg = path.join(f.env.CODEX_COMPANION_HOME, "duet", "config.toml");
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, 'permission_mapping = "claude"\n');
  const claudeMap = f.invoke(["roundtable", "start", "--roles", "improver,critic", "--persona-model", "critic=gemini-4-neon:high", "--json"], "Goal");
  assert.equal(claudeMap.status, 1);
  assert.match(claudeMap.stderr, /critic/);
  assert.equal(fs.existsSync(roomsDir), false);

  fs.writeFileSync(cfg, 'permission_mapping = "off"\n');
  const started = f.invoke(["roundtable", "start", "--roles", "improver,critic", "--persona-model", "critic=gemini-4-neon:HIGH", "--json"], "Mixed goal");
  assert.equal(started.status, 0, started.stderr);
  const jsonRoom = JSON.parse(started.stdout);
  const [improver, critic] = jsonRoom.members;
  assert.deepEqual([improver.backend, improver.agentType], ["codex", "fugato:codex-native"]);
  assert.deepEqual([critic.backend, critic.agentType, critic.model, critic.effort], ["antigravity", "fugato:gemini-native", "gemini-4-neon", "high"]);
  assert.equal(improver.header, `DUET: --model ${improver.model} --effort ${improver.effort} --normal --roundtable ${jsonRoom.roomId} --persona improver --cwd ${JSON.stringify(improver.workspace.path)}`);
  assert.equal(critic.header, `DUET: --backend antigravity --model gemini-4-neon --effort high --roundtable ${jsonRoom.roomId} --persona critic --cwd ${JSON.stringify(critic.workspace.path)}`);

  const textStart = f.invoke(["roundtable", "start", "--roles", "improver,critic", "--persona-model", "critic=gemini-4-neon:medium"], "Text goal");
  assert.equal(textStart.status, 0, textStart.stderr);
  assert.match(textStart.stdout, /fugato:codex-native/);
  assert.match(textStart.stdout, /fugato:gemini-native/);
});

test("Gemini seat tasks honor settings precedence, reject mismatches and non-full-access sandboxes, and run end-to-end", () => {
  const seat = { model: "gemini-4-carbon", effort: "high" };
  assert.deepEqual(antigravityTaskSettings({}, null, {}, seat), { model: "gemini-4-carbon", effort: "high" });
  assert.deepEqual(antigravityTaskSettings({ model: "gemini-3.8-flash" }, { result: { model: "gemini-4-neon", effort: "low" } }, {}, seat),
    { model: "gemini-3.8-flash", effort: "low" });
  assert.deepEqual(antigravityTaskSettings({}, { request: { modelDefault: true, effortDefault: true } }, { model: "gemini-4-neon", effort: "xhigh" }, seat),
    { model: "gemini-4-carbon", effort: "high" });
  assert.deepEqual(antigravityTaskSettings({}, null, { model: "gemini-3.8-flash", effort: "medium" }, null),
    { model: "gemini-3.8-flash", effort: "medium" });
  assert.deepEqual(antigravityTaskSettings({}, null, {}, null),
    { model: "gemini-4-neon", modelDefault: true, effort: "xhigh", effortDefault: true });

  const f = makeFixture();
  const room = forum.createRoom({ sessionId: f.env.CODEX_COMPANION_SESSION_ID, workspaceRoot: f.repo, goal: "Mixed seat check", members: resolveRoster({ intensity: "light" }) }, f.env);
  const roomFile = path.join(f.env.CODEX_COMPANION_HOME, "duet", "roundtables", room.roomId, "room.json");
  const disk = JSON.parse(fs.readFileSync(roomFile, "utf8"));
  const criticSeat = disk.members.find(m => m.persona === "critic");
  criticSeat.model = "gemini-4-carbon"; criticSeat.effort = "high"; criticSeat.backend = "antigravity";
  fs.writeFileSync(roomFile, `${JSON.stringify(disk)}\n`);
  const criticWs = criticSeat.workspace.path, improverWs = disk.members.find(m => m.persona === "improver").workspace.path;

  for (const [args, pattern] of [
    [["task", "--roundtable", room.roomId, "--persona", "critic", "--cwd", criticWs, "--direct"], /fugato:gemini-native/],
    [["task", "--backend", "antigravity", "--roundtable", room.roomId, "--persona", "improver", "--cwd", improverWs, "--direct"], /fugato:codex-native/],
    [["task", "--model", "gemini-4-neon", "--direct"], /fugato:gemini-native/],
    [["task", "--backend", "antigravity", "--model", "gpt-6.2-sol", "--direct"], /only Gemini models.*fugato:codex-native/],
    [["task", "--backend", "antigravity", "--roundtable", room.roomId, "--persona", "critic", "--cwd", criticWs, "--sandbox", "read-only", "--direct"], /danger-full-access/],
    [["task", "--backend", "antigravity", "--roundtable", room.roomId, "--persona", "critic", "--cwd", criticWs, "--sandbox", "workspace-write", "--direct"], /danger-full-access/]
  ]) {
    const refused = f.invoke(args, "Seat work.");
    assert.equal(refused.status, 1, args.join(" "));
    assert.match(refused.stderr + refused.stdout, pattern);
  }
  const cfg = path.join(f.env.CODEX_COMPANION_HOME, "duet", "config.toml");
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, 'default_sandbox = "read-only"\n');
  const savedRo = f.invoke(["task", "--backend", "antigravity", "--roundtable", room.roomId, "--persona", "critic", "--cwd", criticWs, "--direct"], "Seat work.");
  assert.equal(savedRo.status, 1);
  assert.match(savedRo.stderr + savedRo.stdout, /danger-full-access/);
  fs.rmSync(cfg);
  assert.deepEqual(f.acp.requests(), []);
  assert.equal(fs.existsSync(f.codexCalls), false);

  const ran = f.invoke(["task", "--backend", "antigravity", "--roundtable", room.roomId, "--persona", "critic", "--cwd", criticWs, "--direct"], "Post independent finding.");
  assert.equal(ran.status, 0, ran.stderr + ran.stdout);
  const report = JSON.parse(ran.stdout.trim().split("\n").at(-1));
  const saved = f.stored(criticWs, report.jobId);
  assert.deepEqual([saved.request.backend, saved.request.model, saved.request.effort], ["antigravity", "gemini-4-carbon", "high"]);
  assert.equal("modelDefault" in saved.request, false);
  assert.equal("effortDefault" in saved.request, false);
  assert.deepEqual(saved.request.roundtable, { roomId: room.roomId, persona: "critic" });
  const promptText = f.acp.requests().find(r => r.method === "session/prompt").params.prompt.map(p => p.text).join("\n");
  assert.doesNotMatch(promptText, /under the duet_parent MCP server/);
  assert.match(promptText, /under Fugato.s parent-bridge MCP server/);
  const updated = forum.readRoom(room.roomId, f.env).members.find(m => m.persona === "critic");
  assert.equal(updated.status, "active");
  assert.deepEqual(updated.jobIds, [report.jobId]);
  assert.equal(updated.threadId, saved.threadId);
  assert.equal(fs.existsSync(f.codexCalls), false);
});

test("pre-enqueue throw releases a claimed roundtable seat in background and foreground paths", t => {
  const f = makeFixture();
  const started = f.invoke(["journal", "start", "--json"], JSON.stringify({ goal: "Closed run", criteria: ["Done"] }));
  assert.equal(started.status, 0, started.stderr);
  const { runId } = JSON.parse(started.stdout);
  const room = forum.createRoom({
    sessionId: f.env.CODEX_COMPANION_SESSION_ID, workspaceRoot: f.repo, goal: "Release claim on throw",
    members: resolveRoster({ intensity: "light" }), runId
  }, f.env);
  const roomFile = path.join(f.env.CODEX_COMPANION_HOME, "duet", "roundtables", room.roomId, "room.json");
  const disk = JSON.parse(fs.readFileSync(roomFile, "utf8"));
  const critic = disk.members.find(m => m.persona === "critic");
  critic.model = "gemini-4-neon"; critic.effort = "high"; critic.backend = "antigravity";
  fs.writeFileSync(roomFile, `${JSON.stringify(disk)}\n`);

  // Closing the room's run causes linkJournalJob inside buildTaskJob to throw after claim:true.
  const closed = f.invoke(["journal", "close", "--json"], JSON.stringify({ judgment: "abandoned", summary: "Closed before dispatch", openRisks: [] }));
  assert.equal(closed.status, 0, closed.stderr);

  for (const modeFlags of [["--direct"], ["--json"]]) {
    const failed = f.invoke(["task", "--backend", "antigravity", "--roundtable", room.roomId, "--persona", "critic", "--cwd", critic.workspace.path, ...modeFlags], "Should fail before enqueue.");
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr + failed.stdout, /closed/i);
    const member = forum.readRoom(room.roomId, f.env).members.find(m => m.persona === "critic");
    assert.equal(member.claimedAt ?? null, null, `claim should be released for ${modeFlags.join(" ")}`);
    assert.deepEqual(member.jobIds, []);
  }
});

test("D8 auto-allows listed parent-bridge MCP tools with random server names and argument-free audit entries on new and loaded sessions", async t => {
  const dir = makeTempDir("rt-d8-pos-");
  const prevBin = process.env.FUGATO_ANTIGRAVITY_BIN;
  t.after(() => {
    if (prevBin === undefined) delete process.env.FUGATO_ANTIGRAVITY_BIN;
    else process.env.FUGATO_ANTIGRAVITY_BIN = prevBin;
  });
  const mcpPermissionRequests = [
    { tool: "ask_parent", rawInput: { question: "SECRET_QUESTION_ARG", options: ["A", "B"], toolSummary: "Ask parent" } },
    { tool: "forum_read", rawInput: { resource: "post/1", after: 0, limit: 10, toolSummary: "Read forum" } },
    { tool: "forum_post", rawInput: { kind: "finding", body: "SECRET_FORUM_BODY", title: "Finding", toolSummary: "Post finding" } }
  ];
  const fake = installFakeAntigravity(dir, { mcpPermissionRequests });
  process.env.FUGATO_ANTIGRAVITY_BIN = fake.binary;
  const events = [], asked = [];
  const first = await runAntigravityTurn(dir, {
    prompt: "Run roundtable turn.", sandbox: "danger-full-access",
    parentBridge: { cwd: dir, jobId: "job-rt-1", roundtable: { roomId: "rt-1-abc", persona: "critic" } },
    onApprovalRequest: req => { asked.push(req); return "deny"; },
    onProgress: ev => events.push(ev)
  });
  assert.equal(first.status, 0);
  assert.deepEqual(asked, []);
  assert.deepEqual(first.blockers, []);
  const newServer = fake.requests().find(r => r.method === "session/new").params.mcpServers[0].name;
  assert.match(newServer, /^duet_parent_[0-9a-f]{12}$/);
  assert.deepEqual(fake.state().serverResponses.map(r => r.result.outcome), [
    { outcome: "selected", optionId: "allow" },
    { outcome: "selected", optionId: "allow" },
    { outcome: "selected", optionId: "allow" }
  ]);
  const auditEvents = events.flatMap(ev => ev.activity ?? []).filter(a => a.type === "permissionAutoAllowed");
  assert.deepEqual(auditEvents.map(a => a.text), [
    "parent bridge tool auto-allowed: ask_parent",
    "parent bridge tool auto-allowed: forum_read",
    "parent bridge tool auto-allowed: forum_post"
  ]);
  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /SECRET_QUESTION_ARG|SECRET_FORUM_BODY/);

  // Continuation (session/load) also generates a fresh server name and auto-allows listed tools.
  const secondEvents = [];
  const second = await runAntigravityTurn(dir, {
    prompt: "Continue roundtable turn.", sandbox: "danger-full-access", resumeThreadId: first.threadId,
    parentBridge: { cwd: dir, jobId: "job-rt-2", roundtable: { roomId: "rt-1-abc", persona: "critic" } },
    onApprovalRequest: req => { asked.push(req); return "deny"; },
    onProgress: ev => secondEvents.push(ev)
  });
  assert.equal(second.status, 0);
  assert.deepEqual(asked, []);
  const loadServer = fake.requests().find(r => r.method === "session/load").params.mcpServers[0].name;
  assert.match(loadServer, /^duet_parent_[0-9a-f]{12}$/);
  assert.notEqual(loadServer, newServer);
  assert.equal(secondEvents.flatMap(ev => ev.activity ?? []).filter(a => a.type === "permissionAutoAllowed").length, 3);

  const plainDir = makeTempDir("rt-d8-plain-");
  const plainFake = installFakeAntigravity(plainDir, { mcpPermissionRequests: [mcpPermissionRequests[0]] });
  process.env.FUGATO_ANTIGRAVITY_BIN = plainFake.binary;
  const plainEvents = [];
  const plain = await runAntigravityTurn(plainDir, {
    prompt: "Non-roundtable ask_parent.", sandbox: "danger-full-access",
    parentBridge: { cwd: plainDir, jobId: "job-plain-1" },
    onApprovalRequest: req => { asked.push(req); return "deny"; },
    onProgress: ev => plainEvents.push(ev)
  });
  assert.equal(plain.status, 0);
  assert.deepEqual(asked, []);
  assert.deepEqual(plainEvents.flatMap(ev => ev.activity ?? []).filter(a => a.type === "permissionAutoAllowed").map(a => a.text), [
    "parent bridge tool auto-allowed: ask_parent"
  ]);
});

test("D8 refuses auto-allow on every negative condition and preserves the normal review/deny path", async t => {
  const prevBin = process.env.FUGATO_ANTIGRAVITY_BIN;
  t.after(() => {
    if (prevBin === undefined) delete process.env.FUGATO_ANTIGRAVITY_BIN;
    else process.env.FUGATO_ANTIGRAVITY_BIN = prevBin;
  });
  const cases = [
    ["wrong server suffix", { roundtable: true, req: { server: "duet_parent_000000000000", tool: "ask_parent", rawInput: { question: "q", toolSummary: "s" } }, reviewable: true }],
    ["collision/substring name", { roundtable: true, req: { tool: "ask_parent", nameSuffix: "_extra", rawInput: { question: "q", toolSummary: "s" } }, reviewable: true }],
    ["kind execute", { roundtable: true, req: { tool: "ask_parent", kind: "execute", rawInput: { question: "q", toolSummary: "s" } }, reviewable: false }],
    ["non-empty locations", { roundtable: true, req: { tool: "forum_read", locations: [{ path: "/tmp/file" }], rawInput: { toolSummary: "s" } }, reviewable: true }],
    ["non-empty content", { roundtable: true, req: { tool: "forum_read", content: [{ type: "content", content: { type: "text", text: "x" } }], rawInput: { toolSummary: "s" } }, reviewable: true }],
    ["extra rawInput key", { roundtable: true, req: { tool: "forum_read", rawInput: { resource: "post/1", extra: "bad", toolSummary: "s" } }, reviewable: true }],
    ["missing allow_once", { roundtable: true, req: { tool: "ask_parent", rawInput: { question: "q", toolSummary: "s" }, options: [{ optionId: "always", name: "Always", kind: "allow_always" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] }, reviewable: false }],
    ["forum_read on non-roundtable job", { roundtable: false, req: { tool: "forum_read", rawInput: { toolSummary: "s" } }, reviewable: true }],
    ["forum_post on non-roundtable job", { roundtable: false, req: { tool: "forum_post", rawInput: { kind: "finding", body: "b", toolSummary: "s" } }, reviewable: true }]
  ];
  for (const [label, { roundtable, req, reviewable }] of cases) {
    await t.test(label, async () => {
      const dir = makeTempDir("rt-d8-neg-");
      const fake = installFakeAntigravity(dir, { mcpPermissionRequests: [req] });
      process.env.FUGATO_ANTIGRAVITY_BIN = fake.binary;
      const asked = [], events = [];
      const result = await runAntigravityTurn(dir, {
        prompt: "Check negative D8 case.", sandbox: "danger-full-access",
        parentBridge: { cwd: dir, jobId: "job-neg", ...(roundtable ? { roundtable: { roomId: "rt-1-neg", persona: "critic" } } : {}) },
        onApprovalRequest: r => { asked.push(r.toolCall.toolCallId); return "deny"; },
        onProgress: ev => events.push(ev)
      });
      assert.equal(events.flatMap(ev => ev.activity ?? []).some(a => a.type === "permissionAutoAllowed"), false);
      assert.equal(asked.length, reviewable ? 1 : 0);
      assert.deepEqual(fake.state().serverResponses[0].result.outcome, { outcome: "selected", optionId: "deny" });
      assert.ok(result.blockers.length >= 1);
    });
  }
});

test("Antigravity auto-allows workspace read tools with argument-free audit entries and passes execution cwd", async t => {
  const dir = makeTempDir("rt-ws-tools-");
  const execDir = path.join(dir, "exec-sub");
  fs.mkdirSync(execDir, { recursive: true });
  const prevBin = process.env.FUGATO_ANTIGRAVITY_BIN;
  t.after(() => {
    if (prevBin === undefined) delete process.env.FUGATO_ANTIGRAVITY_BIN;
    else process.env.FUGATO_ANTIGRAVITY_BIN = prevBin;
  });
  const mcpPermissionRequests = [
    { tool: "workspace_list", rawInput: { path: ".", depth: 2, toolSummary: "List files" } },
    { tool: "workspace_grep", rawInput: { pattern: "SECRET_GREP_TOKEN", fixed: true, toolSummary: "Search files" } },
    { tool: "workspace_git_read", rawInput: { op: "status", toolSummary: "Check git status" } }
  ];
  const fake = installFakeAntigravity(dir, { mcpPermissionRequests });
  process.env.FUGATO_ANTIGRAVITY_BIN = fake.binary;
  const events = [], asked = [];
  const res = await runAntigravityTurn(dir, {
    executionCwd: execDir, prompt: "Inspect workspace.", sandbox: "danger-full-access",
    parentBridge: { cwd: dir, jobId: "job-ws-1" },
    onApprovalRequest: req => { asked.push(req); return "deny"; },
    onProgress: ev => events.push(ev)
  });
  assert.equal(res.status, 0);
  assert.deepEqual(asked, []);
  assert.deepEqual(res.blockers, []);
  const server = fake.requests().find(r => r.method === "session/new").params.mcpServers[0];
  assert.equal(server.env.find(e => e.name === "CODEX_COMPANION_BRIDGE_EXEC_CWD")?.value, path.resolve(execDir));
  const auditEvents = events.flatMap(ev => ev.activity ?? []).filter(a => a.type === "permissionAutoAllowed");
  assert.deepEqual(auditEvents.map(a => a.text), [
    "parent bridge tool auto-allowed: workspace_list",
    "parent bridge tool auto-allowed: workspace_grep",
    "parent bridge tool auto-allowed: workspace_git_read"
  ]);
  assert.doesNotMatch(JSON.stringify(events), /SECRET_GREP_TOKEN/);
});
