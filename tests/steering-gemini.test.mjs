import "./test-environment.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { initGitRepo, makeTempDir, run, waitForCondition } from "./helpers.mjs";
import { buildEnv } from "./fake-codex-fixture.mjs";
import { installFakeAntigravity } from "./fake-antigravity-fixture.mjs";
import { handoffSteering, queueGeminiNote, drainGeminiNotes, finalizeUnconsumedGeminiNotes } from "../plugins/codex/scripts/lib/steering.mjs";
import { registerSteering, GEMINI_BUSY } from "../plugins/codex/hooks/steering.mjs";
import { reportMarkdown } from "../plugins/codex/hooks/native-agent.mjs";
import { FRESH_ROLE_ERROR } from "../plugins/codex/scripts/lib/command-options.mjs";
import { answerQuestion, directReport, envelopeBytes, PARENT_BRIDGE_ENV } from "../plugins/codex/scripts/lib/job-runtime.mjs";
import { isC2Report } from "../plugins/codex/scripts/lib/report-delivery.mjs";
import { buildWorkerReport } from "../plugins/codex/scripts/lib/worker-report.mjs";
import { createRoom, postEvent } from "../plugins/codex/scripts/lib/forum.mjs";
import { resolveJobFile, resolveStateDir, upsertJob, writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";

const bridgeScript = fileURLToPath(new URL("../plugins/codex/scripts/parent-bridge-mcp.mjs", import.meta.url));
const companionScript = fileURLToPath(new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url));
const GEMINI_TYPE = "fugato:gemini-native";
const CODEX_TYPE = "fugato:codex-native";

function seedJob(workspaceRoot, isoHome, patch) {
  const prev = process.env.CODEX_COMPANION_HOME;
  process.env.CODEX_COMPANION_HOME = isoHome;
  try {
    const job = {
      workspaceRoot,
      status: "running",
      pid: process.pid,
      sessionId: "chair-session",
      ownerId: "owner-1",
      backend: "antigravity",
      request: { backend: "antigravity" },
      ...patch
    };
    upsertJob(workspaceRoot, job);
    writeJobFile(workspaceRoot, job.id, job);
    return job;
  } finally {
    if (prev === undefined) delete process.env.CODEX_COMPANION_HOME;
    else process.env.CODEX_COMPANION_HOME = prev;
  }
}

async function withIsolatedHome(isoHome, fn) {
  const prev = process.env.CODEX_COMPANION_HOME;
  process.env.CODEX_COMPANION_HOME = isoHome;
  try { return await fn(); }
  finally {
    if (prev === undefined) delete process.env.CODEX_COMPANION_HOME;
    else process.env.CODEX_COMPANION_HOME = prev;
  }
}

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

function makeCliFixture(acpOptions = "normal") {
  const dir = makeTempDir("steer-gemini-cli-");
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo, { recursive: true });
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "app.txt"), "hello gemini steer\n");
  assert.equal(run("git", ["add", "app.txt"], { cwd: repo }).status, 0);
  assert.equal(run("git", ["commit", "-m", "initial"], { cwd: repo }).status, 0);
  const acp = installFakeAntigravity(dir, acpOptions);
  const env = {
    ...buildEnv(dir),
    FUGATO_ANTIGRAVITY_BIN: acp.binary,
    CODEX_COMPANION_BIN: path.join(dir, "missing-codex"),
    CODEX_COMPANION_HOME: path.join(dir, "isolated"),
    CLAUDE_PLUGIN_DATA: path.join(dir, "data"),
    CODEX_COMPANION_SESSION_ID: "gemini-steer-session"
  };
  const call = (args, input) => spawnSync(process.execPath, [companionScript, ...args], {
    cwd: repo, env, input, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL"
  });
  const stored = id => JSON.parse(fs.readFileSync(path.join(resolveStateDir(repo, env), "jobs", `${id}.json`), "utf8"));
  const inbox = id => JSON.parse(fs.readFileSync(path.join(resolveStateDir(repo, env), "jobs", `${id}.steering.json`), "utf8"));
  return { dir, repo, env, acp, call, stored, inbox };
}

function createSteeringHookHarness() {
  let handler = null;
  const on = (event, fn) => {
    assert.equal(event, "session.send");
    handler = fn;
    return { catch: () => {} };
  };
  const hasRoleHeader = text => /^\s*DUET:\s+.*(?:--role(?:=|\s)|--high-stakes\b)/.test(text.split(/\r?\n/, 1)[0] ?? "");
  registerSteering(on, hasRoleHeader);
  assert.ok(handler, "registerSteering must register session.send");
  const notices = [];
  const runs = [];
  const store = new Map();
  let agents = [];
  let runImpl = async () => ({ exitCode: 0, stdout: "", stderr: "", isStdoutTruncated: false });
  const $ = {
    plugin: { root: "/plugin" },
    clock: { now: async () => 1_800_000_000_000 },
    session: {
      id: async () => "chair-session",
      append: async row => { notices.push(row); return {}; }
    },
    agent: { list: async () => agents },
    store: { get: async key => store.get(key) },
    process: {
      run: async (argv, init) => {
        runs.push({ argv, init });
        return runImpl(argv, init);
      }
    }
  };
  const invoke = (event, next = async e => ({ isDelivered: true, fallbackEvent: e })) => handler($, event, next);
  return {
    $, notices, runs, store, invoke,
    setAgents: list => { agents = list; },
    setRun: fn => { runImpl = fn; }
  };
}

test("lib/steering queues active Gemini notes immediately, defers on pendingQuestion/ended, and drains/finalizes once", async () => {
  const dir = makeTempDir("steer-gemini-lib-");
  const repo = path.join(dir, "repo");
  const isoHome = path.join(dir, "isolated");
  fs.mkdirSync(repo, { recursive: true });

  await withIsolatedHome(isoHome, async () => {
    seedJob(repo, isoHome, { id: "job-active" });

    // Active antigravity job without pending question queues immediately (no 6s wait).
    const started = Date.now();
    const receipt = await handoffSteering(repo, "job-active", {
      deliveryId: "del-1", text: "Narrow scope to parser.mjs.", sessionId: "chair-session", ownerId: "owner-1"
    });
    const elapsed = Date.now() - started;
    assert.deepEqual(receipt, { jobId: "job-active", deliveryId: "del-1", status: "queued", fallback: false, reason: null });
    assert.ok(elapsed < 1500, `Expected immediate Gemini queue without 6s poll, took ${elapsed}ms`);

    // Idempotent retry with same deliveryId + same text succeeds; mismatched text throws.
    assert.deepEqual(await handoffSteering(repo, "job-active", {
      deliveryId: "del-1", text: "Narrow scope to parser.mjs.", sessionId: "chair-session", ownerId: "owner-1"
    }), receipt);
    await assert.rejects(() => handoffSteering(repo, "job-active", {
      deliveryId: "del-1", text: "Different text.", sessionId: "chair-session", ownerId: "owner-1"
    }), /different text/i);

    // queueGeminiNote with denial-guidance source appends to the same inbox.
    const guidance = await queueGeminiNote(repo, "job-active", "Use workspace_grep instead of shell rg.", { source: "denial-guidance" });
    assert.equal(guidance.status, "queued");
    assert.equal(guidance.source, "denial-guidance");
    assert.ok(guidance.id);
    await assert.rejects(() => queueGeminiNote(repo, "job-active", "Bad source", { source: "invalid" }), /Unsupported Gemini note source/);

    // drainGeminiNotes atomically marks both applied with appliedAt and redacts stored text.
    const drained = await drainGeminiNotes(repo, "job-active");
    assert.equal(drained.length, 2);
    assert.deepEqual(drained.map(({ text, source }) => ({ text, source })), [
      { text: "Narrow scope to parser.mjs.", source: "chair-steer" },
      { text: "Use workspace_grep instead of shell rg.", source: "denial-guidance" }
    ]);
    assert.equal(drained[0].id, "del-1");
    assert.equal(drained[1].id, guidance.id);
    assert.ok(drained.every(note => typeof note.at === "string" && Number.isFinite(Date.parse(note.at))));

    // Second drain returns empty; inbox rows are applied, have appliedAt, and redact text.
    assert.deepEqual(await drainGeminiNotes(repo, "job-active"), []);
    const inboxFile = resolveJobFile(repo, "job-active").replace(/\.json$/, ".steering.json");
    const persisted = JSON.parse(fs.readFileSync(inboxFile, "utf8"));
    assert.equal(persisted.deliveries.length, 2);
    for (const row of persisted.deliveries) {
      assert.equal(row.status, "applied");
      assert.ok(Number.isFinite(Date.parse(row.appliedAt)));
      assert.equal(row.text, undefined);
      assert.ok(typeof row.textHash === "string" && row.textHash.length === 64);
    }

    // Active antigravity job WITH pendingQuestion defers with fallback: true (once).
    seedJob(repo, isoHome, {
      id: "job-question",
      pendingQuestion: { id: "q-1", kind: "action-approval", text: "Allow edit?" }
    });
    const deferredQ = await handoffSteering(repo, "job-question", {
      deliveryId: "del-q", text: "Answer q-1\nAllow once", sessionId: "chair-session", ownerId: "owner-1"
    });
    assert.deepEqual(deferredQ, { jobId: "job-question", deliveryId: "del-q", status: "deferred", fallback: true, reason: "pending_question" });
    const repeatedQ = await handoffSteering(repo, "job-question", {
      deliveryId: "del-q", text: "Answer q-1\nAllow once", sessionId: "chair-session", ownerId: "owner-1"
    });
    assert.deepEqual(repeatedQ, { jobId: "job-question", deliveryId: "del-q", status: "deferred", fallback: false, reason: "pending_question" });

    // Ended antigravity job defers with fallback: true immediately.
    seedJob(repo, isoHome, { id: "job-ended", status: "completed" });
    const deferredEnd = await handoffSteering(repo, "job-ended", {
      deliveryId: "del-end", text: "Next task brief.", sessionId: "chair-session", ownerId: "owner-1"
    });
    assert.deepEqual(deferredEnd, { jobId: "job-ended", deliveryId: "del-end", status: "deferred", fallback: true, reason: "no_active_turn" });

    // finalizeUnconsumedGeminiNotes marks remaining queued rows terminal so they are never delivered twice.
    seedJob(repo, isoHome, { id: "job-unconsumed" });
    await queueGeminiNote(repo, "job-unconsumed", "Undelivered steer 1.", { source: "chair-steer", deliveryId: "u-1" });
    await queueGeminiNote(repo, "job-unconsumed", "Undelivered steer 2.", { source: "chair-steer", deliveryId: "u-2" });
    const unconsumed = await finalizeUnconsumedGeminiNotes(repo, "job-unconsumed");
    assert.deepEqual(unconsumed, [
      { id: "u-1", text: "Undelivered steer 1." },
      { id: "u-2", text: "Undelivered steer 2." }
    ]);
    assert.deepEqual(await drainGeminiNotes(repo, "job-unconsumed"), []);
    assert.deepEqual(await finalizeUnconsumedGeminiNotes(repo, "job-unconsumed"), []);
    const endedInbox = JSON.parse(fs.readFileSync(resolveJobFile(repo, "job-unconsumed").replace(/\.json$/, ".steering.json"), "utf8"));
    for (const row of endedInbox.deliveries) {
      assert.equal(row.status, "deferred");
      assert.equal(row.reason, "turn_ended");
      assert.ok(row.fallbackClaimedAt);
      assert.equal(row.text, undefined);
    }
  });
});

test("hooks/steering routes running Gemini without pendingQuestion to steer with Gemini notices and keeps needs_answer untouched", async () => {
  assert.equal(typeof GEMINI_BUSY, "string");
  const h = createSteeringHookHarness();
  const key = "native:v2:chair-session:gem-1";
  h.setAgents([{ id: "gem-1", name: "Curie", type: GEMINI_TYPE, status: "running" }]);
  h.store.set(key, { session: "chair-session", cwd: "/repo", jobId: "task-gem-1", ownerId: "owner-gem-1", status: "running" });

  // Running Gemini worker without pending question steers immediately, no next(e) fallback.
  h.setRun(async (argv, init) => {
    assert.equal(argv[2], "steer");
    assert.equal(argv[3], "task-gem-1");
    assert.equal(init.stdin, "Skip benchmarks and finish tests.");
    const deliveryId = argv[argv.indexOf("--delivery-id") + 1];
    return {
      exitCode: 0,
      stdout: JSON.stringify({ jobId: "task-gem-1", deliveryId, status: "queued", fallback: false, reason: null }),
      stderr: "", isStdoutTruncated: false
    };
  });
  let fallbackCalls = 0;
  const delivered = await h.invoke({ to: "Curie", text: "Skip benchmarks and finish tests." }, async () => { fallbackCalls++; return { isDelivered: true }; });
  assert.deepEqual(delivered, { isDelivered: true });
  assert.equal(fallbackCalls, 0);
  assert.equal(h.runs.length, 1);
  assert.equal(h.notices.at(-1).message.content[0].text, "Gemini steering queued.");

  // Role headers on a running Gemini worker are refused with FRESH_ROLE_ERROR.
  const roleRefused = await h.invoke({ to: "Curie", text: "DUET: --role debug\nSwitch role." }, async () => { fallbackCalls++; return { isDelivered: true }; });
  assert.deepEqual(roleRefused, { isDelivered: false, reason: FRESH_ROLE_ERROR });
  assert.equal(h.runs.length, 1);

  // Failure and unknown receipts use Gemini-labelled notices and reasons.
  h.setRun(async argv => ({
    exitCode: 0,
    stdout: JSON.stringify({ jobId: "task-gem-1", deliveryId: argv[argv.indexOf("--delivery-id") + 1], status: "failed", fallback: false, reason: "inbox_full" }),
    stderr: "", isStdoutTruncated: false
  }));
  const failed = await h.invoke({ to: "Curie", text: "Another note." }, async () => { fallbackCalls++; return { isDelivered: true }; });
  assert.equal(failed.isDelivered, false);
  assert.match(failed.reason, /^Gemini steering failed \(inbox_full\)/);
  assert.equal(h.notices.at(-1).message.content[0].text, "Gemini steering failed.");

  h.setRun(async () => { throw new Error("transport lost"); });
  const unknown = await h.invoke({ to: "Curie", text: "Ambiguous note." }, async () => { fallbackCalls++; return { isDelivered: true }; });
  assert.equal(unknown.isDelivered, false);
  assert.match(unknown.reason, /^Gemini steering outcome unknown;/);
  assert.equal(fallbackCalls, 0);

  // When parked at needs_answer (state.status, state.answer, or idle agent), Answer <questionId> goes straight to next(e).
  const runsBeforeAnswer = h.runs.length;
  const answerText = "Answer q-42\nAllow once";
  for (const [agentStatus, statePatch] of [
    ["running", { status: "needs_answer" }],
    ["running", { status: "running", answer: { status: "needs_answer" } }],
    ["completed", { status: "running" }]
  ]) {
    h.setAgents([{ id: "gem-1", name: "Curie", type: GEMINI_TYPE, status: agentStatus }]);
    h.store.set(key, { session: "chair-session", cwd: "/repo", jobId: "task-gem-1", ownerId: "owner-gem-1", ...statePatch });
    const forwarded = [];
    const res = await h.invoke({ to: "Curie", text: answerText }, async e => { forwarded.push(e.text); return { isDelivered: true }; });
    assert.deepEqual(res, { isDelivered: true });
    assert.deepEqual(forwarded, [answerText]);
  }
  assert.equal(h.runs.length, runsBeforeAnswer, "needs_answer routing must bypass fugato steer");

  // Running Gemini worker continuing after an answer (state.status === 'needs_answer' with active answer intent and no state.answer) still steers.
  h.setAgents([{ id: "gem-1", name: "Curie", type: GEMINI_TYPE, status: "running" }]);
  h.store.set(key, {
    session: "chair-session", cwd: "/repo", jobId: "task-gem-1", ownerId: "owner-gem-1",
    status: "needs_answer", intent: { kind: "answer", turnId: "turn-2" }
  });
  h.setRun(async argv => ({
    exitCode: 0,
    stdout: JSON.stringify({ jobId: "task-gem-1", deliveryId: argv[argv.indexOf("--delivery-id") + 1], status: "queued", fallback: false, reason: null }),
    stderr: "", isStdoutTruncated: false
  }));
  const postAnswer = await h.invoke({ to: "Curie", text: "Post-approval redirect." }, async () => assert.fail("Expected steer, not fallback"));
  assert.deepEqual(postAnswer, { isDelivered: true });
  assert.equal(h.runs.length, runsBeforeAnswer + 1);
  assert.equal(h.notices.at(-1).message.content[0].text, "Gemini steering queued.");

  // If a pending question appeared on disk mid-turn, deferred fallback=true forwards to next(e).
  h.setRun(async argv => ({
    exitCode: 0,
    stdout: JSON.stringify({ jobId: "task-gem-1", deliveryId: argv[argv.indexOf("--delivery-id") + 1], status: "deferred", fallback: true, reason: "pending_question" }),
    stderr: "", isStdoutTruncated: false
  }));
  const deferredForwarded = [];
  const deferredRes = await h.invoke({ to: "Curie", text: answerText }, async e => { deferredForwarded.push(e.text); return { isDelivered: true }; });
  assert.deepEqual(deferredRes, { isDelivered: true });
  assert.deepEqual(deferredForwarded, [answerText]);

  // Codex worker keeps Codex-labelled notices.
  h.setAgents([{ id: "cdx-1", name: "Noether", type: CODEX_TYPE, status: "running" }]);
  h.store.set("native:v2:chair-session:cdx-1", { session: "chair-session", cwd: "/repo", jobId: "task-cdx-1", ownerId: "owner-cdx-1", status: "running" });
  h.setRun(async argv => ({
    exitCode: 0,
    stdout: JSON.stringify({ jobId: "task-cdx-1", deliveryId: argv[argv.indexOf("--delivery-id") + 1], status: "applied", fallback: false, reason: null }),
    stderr: "", isStdoutTruncated: false
  }));
  assert.deepEqual(await h.invoke({ to: "Noether", text: "Codex steer." }), { isDelivered: true });
  assert.equal(h.notices.at(-1).message.content[0].text, "Codex steering applied.");
});

test("parent-bridge drains chair-steer and denial-guidance once on non-roundtable, forum_read, forum_post, and ask_parent replies", async t => {
  const dir = makeTempDir("steer-gemini-bridge-");
  const repo = path.join(dir, "repo");
  const isoHome = path.join(dir, "isolated");
  fs.mkdirSync(repo, { recursive: true });
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "app.txt"), "hello steering bridge\n");
  assert.equal(run("git", ["add", "app.txt"], { cwd: repo }).status, 0);
  assert.equal(run("git", ["commit", "-m", "initial"], { cwd: repo }).status, 0);
  const env = { ...process.env, CODEX_COMPANION_HOME: isoHome, CODEX_COMPANION_SESSION_ID: "chair-session" };

  // 1. Non-roundtable active antigravity job: workspace_*, ask_parent, chair-steer + denial-guidance.
  seedJob(repo, isoHome, {
    id: "job-plain", threadId: "thr-plain", turnId: "turn-plain",
    backend: "antigravity", request: { backend: "antigravity" }
  });
  const plainBridge = startBridge(t, {
    cwd: repo,
    env: {
      ...env,
      [PARENT_BRIDGE_ENV.cwd]: repo,
      [PARENT_BRIDGE_ENV.jobId]: "job-plain",
      CODEX_COMPANION_BRIDGE_BACKEND: "antigravity",
      CODEX_COMPANION_BRIDGE_EXEC_CWD: repo
    }
  });
  const callPlain = async (name, args = {}) => (await plainBridge.request("tools/call", { name, arguments: args })).result;

  await withIsolatedHome(isoHome, async () => {
    const r = await handoffSteering(repo, "job-plain", {
      deliveryId: "plain-1", text: "Check edge cases in parser.", sessionId: "chair-session", ownerId: "owner-1"
    });
    assert.equal(r.status, "queued");
    assert.equal(r.fallback, false);
  });

  const firstList = await callPlain("workspace_list", { depth: 1 });
  assert.equal(firstList.isError, false);
  assert.equal(firstList.content.length, 2);
  assert.equal(firstList.content[1].text, "[Chair steering update — apply immediately]\nCheck edge cases in parser.");

  // Following tool reply has no repeated footer.
  const secondGrep = await callPlain("workspace_grep", { pattern: "hello" });
  assert.equal(secondGrep.isError, false);
  assert.equal(secondGrep.content.length, 1);

  // Denial-guidance framing via queueGeminiNote.
  await withIsolatedHome(isoHome, async () => {
    await queueGeminiNote(repo, "job-plain", "Use workspace_git_read instead of shell git.", { source: "denial-guidance" });
  });
  const gitRes = await callPlain("workspace_git_read", { op: "status" });
  assert.equal(gitRes.isError, false);
  assert.equal(gitRes.content.length, 2);
  assert.equal(gitRes.content[1].text, "[Chair denial guidance]\nUse workspace_git_read instead of shell git.");
  assert.equal((await callPlain("workspace_git_read", { op: "status" })).content.length, 1);

  // ask_parent drains mixed chair-steer + denial-guidance once on reply.
  await withIsolatedHome(isoHome, async () => {
    await queueGeminiNote(repo, "job-plain", "Keep diff under 50 lines.", { source: "chair-steer" });
    await queueGeminiNote(repo, "job-plain", "Do not run rm.", { source: "denial-guidance" });
  });
  const askPromise = callPlain("ask_parent", { question: "Proceed with option A?" });
  await waitForCondition(() => {
    const job = JSON.parse(fs.readFileSync(path.join(resolveStateDir(repo, env), "jobs", "job-plain.json"), "utf8"));
    return job.pendingQuestion?.id;
  }, "ask_parent pending question", 5000);
  await withIsolatedHome(isoHome, async () => {
    const job = JSON.parse(fs.readFileSync(resolveJobFile(repo, "job-plain"), "utf8"));
    answerQuestion(repo, "job-plain", job.pendingQuestion.id, "Yes, option A.");
  });
  const askRes = await askPromise;
  assert.equal(askRes.isError, false);
  assert.equal(askRes.content[0].text, "Yes, option A.");
  assert.equal(askRes.content.length, 2);
  assert.equal(
    askRes.content[1].text,
    "[Chair steering update — apply immediately]\nKeep diff under 50 lines.\n\n[Chair denial guidance]\nDo not run rm."
  );
  assert.equal((await callPlain("workspace_list", { depth: 1 })).content.length, 1);

  // 2. Roundtable active antigravity job: forum_read gets steering footer (independent of withUnreadFooter),
  //    and forum_post gets both unread footer and steering footer without repeating steering.
  const room = createRoom({
    sessionId: "chair-session",
    workspaceRoot: repo,
    goal: "Test steering on roundtable Gemini bridge.",
    members: [
      { persona: "critic", model: "gemini-4-neon", effort: "high", backend: "antigravity" },
      { persona: "improver", model: "gpt-6.2-sol", effort: "high", backend: "codex" }
    ]
  }, env);
  const criticWs = room.members.find(m => m.persona === "critic").workspace.path;
  seedJob(criticWs, isoHome, {
    id: "job-rt", threadId: "thr-rt", turnId: "turn-rt",
    backend: "antigravity", request: { backend: "antigravity", roundtable: { roomId: room.roomId, persona: "critic" } }
  });
  const rtBridge = startBridge(t, {
    cwd: criticWs,
    env: {
      ...env,
      [PARENT_BRIDGE_ENV.cwd]: criticWs,
      [PARENT_BRIDGE_ENV.jobId]: "job-rt",
      CODEX_COMPANION_BRIDGE_BACKEND: "antigravity",
      CODEX_COMPANION_BRIDGE_EXEC_CWD: criticWs
    }
  });
  const callRt = async (name, args = {}) => (await rtBridge.request("tools/call", { name, arguments: args })).result;

  await withIsolatedHome(isoHome, async () => {
    await handoffSteering(criticWs, "job-rt", {
      deliveryId: "rt-read-1", text: "Prioritize candidate #1.", sessionId: "chair-session", ownerId: "owner-1"
    });
  });
  const read1 = await callRt("forum_read", {});
  assert.equal(read1.isError, false);
  assert.equal(read1.content.length, 2);
  assert.equal(read1.content[1].text, "[Chair steering update — apply immediately]\nPrioritize candidate #1.");
  const read2 = await callRt("forum_read", {});
  assert.equal(read2.content.length, 1);

  postEvent(room.roomId, "chair", { kind: "decision", body: "Scope updated." }, env);
  await withIsolatedHome(isoHome, async () => {
    await handoffSteering(criticWs, "job-rt", {
      deliveryId: "rt-post-1", text: "Wrap up after posting.", sessionId: "chair-session", ownerId: "owner-1"
    });
  });
  const postRes = await callRt("forum_post", { kind: "intent", body: "Initial critic post." });
  assert.equal(postRes.isError, false);
  assert.equal(postRes.content.length, 3);
  assert.match(postRes.content[1].text, /1 unread for you/);
  assert.equal(postRes.content[2].text, "[Chair steering update — apply immediately]\nWrap up after posting.");

  // Next workspace_list keeps unread footer (forum_read not called yet) but does NOT repeat steering.
  const listAfterPost = await callRt("workspace_list", { depth: 1 });
  assert.equal(listAfterPost.content.length, 2);
  assert.match(listAfterPost.content[1].text, /1 unread for you/);

  // 3. Codex bridge job never drains Gemini notes.
  const improverWs = room.members.find(m => m.persona === "improver").workspace.path;
  seedJob(improverWs, isoHome, {
    id: "job-cdx", threadId: "thr-cdx", turnId: "turn-cdx",
    backend: "codex", request: { backend: "codex", roundtable: { roomId: room.roomId, persona: "improver" } }
  });
  await withIsolatedHome(isoHome, async () => {
    await queueGeminiNote(improverWs, "job-cdx", "Should stay untouched by Codex bridge.", { source: "chair-steer" });
  });
  const cdxBridge = startBridge(t, {
    cwd: improverWs,
    env: {
      ...env,
      [PARENT_BRIDGE_ENV.cwd]: improverWs,
      [PARENT_BRIDGE_ENV.jobId]: "job-cdx",
      CODEX_COMPANION_BRIDGE_BACKEND: "codex"
    }
  });
  const cdxRead = (await cdxBridge.request("tools/call", { name: "forum_read", arguments: {} })).result;
  assert.equal(cdxRead.isError, false);
  assert.equal(cdxRead.content.length, 1);
});

test("end-to-end Gemini turn drains mid-turn steer at bridge boundary and reports undrained steers at turn end", async () => {
  // Part A: Running Gemini turn calls parent-bridge mid-turn -> steer drained once, no unconsumedSteers at turn end.
  const gateDirA = makeTempDir("steer-gate-a-");
  const gateA = path.join(gateDirA, "release-a");
  const fA = makeCliFixture({ behavior: "steer-bridge", promptGate: gateA });
  const launchA = JSON.parse(fA.call(["task", "--backend", "antigravity", "--detached", "--json", "Run bridge steering task."]).stdout);
  assert.ok(launchA.jobId);
  await waitForCondition(() => fA.stored(launchA.jobId).turnId, "Gemini turn A started", 15_000);

  const steerStart = Date.now();
  const steerCli = fA.call(["steer", launchA.jobId, "--delivery-id", "e2e-bridge-1", "--owner", launchA.ownerId], "Focus on edge cases now.");
  assert.equal(steerCli.status, 0, steerCli.stderr + steerCli.stdout);
  assert.ok(Date.now() - steerStart < 3000, "CLI steer on running Gemini job must return immediately without 6s poll");
  assert.deepEqual(JSON.parse(steerCli.stdout), {
    jobId: launchA.jobId, deliveryId: "e2e-bridge-1", status: "queued", fallback: false, reason: null
  });

  fs.writeFileSync(gateA, "go");
  await waitForCondition(() => fA.stored(launchA.jobId).status === "completed", "Gemini turn A completed", 15_000);

  const replies = fA.acp.state().steerBridgeReplies;
  assert.equal(replies.length, 2);
  assert.equal(replies[0].content.length, 2);
  assert.equal(replies[0].content[1].text, "[Chair steering update — apply immediately]\nFocus on edge cases now.");
  assert.equal(replies[1].content.length, 1, "Second bridge call must not repeat applied steer");

  const detailsA = JSON.parse(fA.call(["result", launchA.jobId, "--details"]).stdout);
  assert.equal(detailsA.unconsumedSteers, undefined);
  assert.equal(detailsA.notice, undefined);
  const compactA = JSON.parse(fA.call(["result", launchA.jobId, "--report"]).stdout);
  assert.equal(compactA.unconsumedSteers, undefined);
  assert.equal(isC2Report(compactA), true);

  // Part B: Pure-reasoning Gemini turn with zero bridge calls ends with undrained steers -> reported in details,
  // compact report, C2 validation, and native reportMarkdown, and marked so never delivered twice.
  const gateDirB = makeTempDir("steer-gate-b-");
  const gateB = path.join(gateDirB, "release-b");
  const fB = makeCliFixture({ behavior: "normal", promptGate: gateB });
  const launchB = JSON.parse(fB.call(["task", "--backend", "antigravity", "--detached", "--json", "Pure reasoning turn."]).stdout);
  assert.ok(launchB.jobId);
  await waitForCondition(() => fB.stored(launchB.jobId).turnId, "Gemini turn B started", 15_000);

  for (const [id, text] of [["e2e-undrained-1", "Check null inputs too."], ["e2e-undrained-2", "Add regression test."]]) {
    const res = fB.call(["steer", launchB.jobId, "--delivery-id", id, "--owner", launchB.ownerId], text);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.equal(JSON.parse(res.stdout).status, "queued");
    assert.equal(JSON.parse(res.stdout).fallback, false);
  }

  fs.writeFileSync(gateB, "go");
  await waitForCondition(() => fB.stored(launchB.jobId).status === "completed", "Gemini turn B completed", 15_000);

  const detailsB = JSON.parse(fB.call(["result", launchB.jobId, "--details"]).stdout);
  assert.deepEqual(detailsB.unconsumedSteers, [
    { id: "e2e-undrained-1", text: "Check null inputs too." },
    { id: "e2e-undrained-2", text: "Add regression test." }
  ]);
  assert.match(detailsB.notice, /2 mid-turn steering messages were not delivered/i);
  assert.match(detailsB.notice, /SendMessage/);

  const compactB = JSON.parse(fB.call(["result", launchB.jobId, "--report"]).stdout);
  assert.deepEqual(compactB.unconsumedSteers, [
    { id: "e2e-undrained-1", text: "Check null inputs too." },
    { id: "e2e-undrained-2", text: "Add regression test." }
  ]);
  assert.match(compactB.notice, /not delivered/i);
  assert.match(compactB.notice, /SendMessage/);
  assert.equal(isC2Report(compactB), true, `Compact report with unconsumedSteers must pass isC2Report: ${JSON.stringify(compactB)}`);
  const card = reportMarkdown({ text: JSON.stringify(compactB) }, { viewport: { columns: 120 } });
  assert.ok(card && card.type === "Box", "Native reportMarkdown must accept compact Gemini report with unconsumedSteers and notice");

  // Rows are marked terminal and cannot be drained later.
  const inboxB = fB.inbox(launchB.jobId);
  assert.equal(inboxB.deliveries.length, 2);
  for (const row of inboxB.deliveries) {
    assert.equal(row.status, "deferred");
    assert.equal(row.reason, "turn_ended");
    assert.ok(row.fallbackClaimedAt);
    assert.equal(row.text, undefined);
  }
  await withIsolatedHome(fB.env.CODEX_COMPANION_HOME, async () => {
    assert.deepEqual(await drainGeminiNotes(fB.repo, launchB.jobId), []);
  });
});

test("unconsumedSteers is bounded to at most 10 clipped entries and stays within the C2 compact envelope", () => {
  const many = Array.from({ length: 15 }, (_, index) => ({
    id: `steer-${index + 1}`,
    text: `Instruction ${index + 1}: ` + "x".repeat(400)
  }));
  const full = buildWorkerReport({
    status: 0,
    backend: "antigravity",
    rawOutput: "Completed the task.",
    unconsumedSteers: many
  }, { jobId: "task-bounded-steers" });
  assert.equal(full.unconsumedSteers.length, 10);
  assert.ok(full.unconsumedSteers.every(entry => entry.text.length <= 240));
  assert.match(full.notice, /15 mid-turn steering messages were not delivered/);
  assert.match(full.notice, /SendMessage/);

  const compact = directReport(full, { id: "task-bounded-steers", workspaceRoot: process.cwd(), request: { backend: "antigravity" } });
  assert.ok(Array.isArray(compact.unconsumedSteers) && compact.unconsumedSteers.length >= 1 && compact.unconsumedSteers.length <= 10);
  assert.ok(compact.unconsumedSteers.every(entry => entry.text.length <= 240));
  assert.ok(typeof compact.notice === "string" && compact.notice.length <= 600);
  assert.ok(envelopeBytes(compact) <= 2000, `Expected <=2000 envelope bytes, got ${envelopeBytes(compact)}`);
  assert.equal(isC2Report(compact), true);
  assert.ok(reportMarkdown({ text: JSON.stringify(compact) }, { viewport: { columns: 120 } }));

  // Malformed unconsumedSteers is rejected by isC2Report.
  assert.equal(isC2Report({ ...compact, unconsumedSteers: [] }), false);
  assert.equal(isC2Report({ ...compact, unconsumedSteers: Array.from({ length: 11 }, (_, i) => ({ id: `s${i}`, text: "a" })) }), false);
  assert.equal(isC2Report({ ...compact, unconsumedSteers: [{ id: "s1", text: "a", extra: 1 }] }), false);
});
