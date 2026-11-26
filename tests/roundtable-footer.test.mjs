import "./test-environment.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import {
  ack, createRoom, postEvent, readIndex, readRoom, renderRoundtableStatus,
  roundtableStatus, setStatus, unreadFooter, updateMember
} from "../plugins/codex/scripts/lib/forum.mjs";
import { PARENT_BRIDGE_ENV } from "../plugins/codex/scripts/lib/job-runtime.mjs";
import { resolveStateDirForRoot, upsertJob, writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";

const bridgeScript = fileURLToPath(new URL("../plugins/codex/scripts/parent-bridge-mcp.mjs", import.meta.url));
const companionScript = fileURLToPath(new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url));

function makeFixture({ git = false } = {}) {
  const dir = makeTempDir("rt-footer-");
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo, { recursive: true });
  if (git) {
    initGitRepo(repo);
    fs.writeFileSync(path.join(repo, "app.txt"), "hello footer\n");
    assert.equal(run("git", ["add", "app.txt"], { cwd: repo }).status, 0);
    assert.equal(run("git", ["commit", "-m", "initial"], { cwd: repo }).status, 0);
  } else {
    fs.writeFileSync(path.join(repo, "app.txt"), "hello footer\n");
  }
  const isoHome = path.join(dir, "isolated");
  const env = { ...process.env, CODEX_COMPANION_HOME: isoHome, CODEX_COMPANION_SESSION_ID: "chair-session" };
  const room = createRoom({
    sessionId: "chair-session",
    workspaceRoot: repo,
    goal: "Test unread footer and status totals.",
    members: [
      { persona: "critic", model: "gemini-4-neon", effort: "high", backend: "antigravity" },
      { persona: "improver", model: "gpt-6.2-sol", effort: "high", backend: "codex" },
      { persona: "conjecturer", model: "gpt-6.2-sol", effort: "medium", backend: "codex" }
    ]
  }, env);
  const roomFile = path.join(isoHome, "duet", "roundtables", room.roomId, "room.json");
  const post = (author, kind, body = "Body text", extra = {}) => postEvent(room.roomId, author, { kind, body, ...extra }, env);
  return { dir, repo, isoHome, env, room, roomFile, post };
}

function seedJob(workspaceRoot, isoHome, patch) {
  const prev = process.env.CODEX_COMPANION_HOME;
  process.env.CODEX_COMPANION_HOME = isoHome;
  try {
    const job = { workspaceRoot, status: "running", pid: process.pid, ...patch };
    upsertJob(workspaceRoot, job);
    writeJobFile(workspaceRoot, job.id, job);
    return job;
  } finally {
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

test("unreadFooter counts chair posts and mentions, respects sealing/cursors/state, and caps refs and length", () => {
  const f = makeFixture(), id = f.room.roomId;
  assert.equal(unreadFooter(id, "critic", f.env), null);

  // Ordinary peer post and sealed peer mention stay hidden while critic is sealed.
  f.post("improver", "idea", "PEER_ORDINARY_BODY", { title: "PEER_ORDINARY_TITLE" });
  f.post("improver", "request", "PEER_MENTION_BODY", { title: "PEER_MENTION_TITLE", mentions: ["critic"] });
  assert.equal(unreadFooter(id, "critic", f.env), null);

  // Sealed member sees only chair decision (not sealed peer posts or secrets).
  const decision = f.post("chair", "decision", "CHAIR_BODY", { title: "CHAIR_TITLE" });
  const sealedFooter = unreadFooter(id, "critic", f.env);
  assert.ok(sealedFooter && !sealedFooter.includes("\n") && sealedFooter.length <= 240);
  assert.match(sealedFooter, new RegExp(`^Roundtable ${id}: 1 unread for you \\(#${decision.seq} chair decision\\) — call forum_read\\.$`));
  assert.doesNotMatch(sealedFooter, /PEER_|CHAIR_|improver/);

  // Advancing indexCursor to or past the event yields null.
  readIndex(id, "critic", {}, f.env);
  assert.equal(unreadFooter(id, "critic", f.env), null);

  // Unsealing resets indexCursor to 0 and reveals peer mention #2 plus chair #3, not ordinary #1 or own #4.
  f.post("critic", "intent", "Independent record");
  const unsealedFooter = unreadFooter(id, "critic", f.env);
  assert.ok(unsealedFooter && !unsealedFooter.includes("\n") && unsealedFooter.length <= 240);
  assert.match(unsealedFooter, /2 unread for you \(#2 request mention, #3 chair decision\)/);
  assert.doesNotMatch(unsealedFooter, /#1|#4|PEER_|CHAIR_|improver/);

  // notifiedSeq >= event.seq suppresses events even when indexCursor is lower.
  ack(id, "critic", 2, f.env);
  assert.match(unreadFooter(id, "critic", f.env), /1 unread for you \(#3 chair decision\)/);
  ack(id, "critic", 3, f.env);
  assert.equal(unreadFooter(id, "critic", f.env), null);

  // Ordinary peer post after unsealing still does not count; >3 qualifying events cap at 3 refs.
  f.post("conjecturer", "finding", "Ordinary peer finding");
  assert.equal(unreadFooter(id, "critic", f.env), null);
  f.post("chair", "finding", "Chair note 1");
  f.post("improver", "question", "Need check", { mentions: ["critic"] });
  f.post("conjecturer", "request", "Reproduce", { mentions: ["critic"] });
  f.post("chair", "decision", "Final direction");
  const capped = unreadFooter(id, "critic", f.env);
  assert.ok(capped && !capped.includes("\n") && capped.length <= 240);
  assert.match(capped, /4 unread for you \(#6 chair finding, #7 question mention, #8 request mention, \+1 more\)/);
  assert.doesNotMatch(capped, /#9|improver|conjecturer/);

  // Paused room, stopped member, and closed room all yield null.
  setStatus(id, "paused", f.env);
  assert.equal(unreadFooter(id, "critic", f.env), null);
  setStatus(id, "open", f.env);
  assert.ok(unreadFooter(id, "critic", f.env));
  updateMember(id, "critic", { status: "stopped" }, f.env);
  assert.equal(unreadFooter(id, "critic", f.env), null);
  assert.ok(unreadFooter(id, "improver", f.env));
  setStatus(id, "closed", f.env);
  assert.equal(unreadFooter(id, "improver", f.env), null);
});

test("unreadFooter is strictly read-only and never modifies room.json bytes, mtime or cursors", async t => {
  const f = makeFixture({ git: true }), id = f.room.roomId;
  const criticWs = f.room.members.find(m => m.persona === "critic").workspace.path;
  f.post("critic", "intent", "Initial critic post");
  f.post("chair", "decision", "Check edge cases");
  f.post("improver", "request", "Please verify", { mentions: ["critic"] });

  const past = new Date(Date.now() - 10_000);
  fs.utimesSync(f.roomFile, past, past);
  const beforeBytes = fs.readFileSync(f.roomFile);
  const beforeMtime = fs.statSync(f.roomFile).mtimeMs;
  const beforeMember = readRoom(id, f.env).members.find(m => m.name === "critic");

  for (let i = 0; i < 5; i++) {
    const line = unreadFooter(id, "critic", f.env);
    assert.ok(line && line.includes("2 unread for you"));
  }
  assert.deepEqual(fs.readFileSync(f.roomFile), beforeBytes);
  assert.equal(fs.statSync(f.roomFile).mtimeMs, beforeMtime);
  const afterDirect = readRoom(id, f.env).members.find(m => m.name === "critic");
  assert.deepEqual(
    [afterDirect.indexCursor, afterDirect.notifiedSeq, afterDirect.firstPendingAt],
    [beforeMember.indexCursor, beforeMember.notifiedSeq, beforeMember.firstPendingAt]
  );

  // Bridge tool calls that append the footer also leave room.json completely untouched.
  seedJob(criticWs, f.isoHome, {
    id: "job-agy-ro", sessionId: "chair-session", backend: "antigravity",
    threadId: "thr-agy-ro", turnId: "turn-agy-ro",
    request: { backend: "antigravity", roundtable: { roomId: id, persona: "critic" } }
  });
  const bridge = startBridge(t, {
    cwd: criticWs,
    env: {
      ...f.env, [PARENT_BRIDGE_ENV.cwd]: criticWs, [PARENT_BRIDGE_ENV.jobId]: "job-agy-ro",
      CODEX_COMPANION_BRIDGE_BACKEND: "antigravity", CODEX_COMPANION_BRIDGE_EXEC_CWD: criticWs
    }
  });
  const okRes = (await bridge.request("tools/call", { name: "workspace_list", arguments: { depth: 1 } })).result;
  assert.equal(okRes.isError, false);
  assert.equal(okRes.content.length, 2);
  assert.match(okRes.content[1].text, /2 unread for you/);
  const errRes = (await bridge.request("tools/call", { name: "workspace_list", arguments: { path: ".." } })).result;
  assert.equal(errRes.isError, true);
  assert.equal(errRes.content.length, 2);
  assert.equal(errRes.content[1].text, okRes.content[1].text);

  assert.deepEqual(fs.readFileSync(f.roomFile), beforeBytes);
  assert.equal(fs.statSync(f.roomFile).mtimeMs, beforeMtime);
});

test("parent-bridge appends footer only for antigravity roundtable tools except forum_read and swallows footer failures", async t => {
  const f = makeFixture({ git: true }), id = f.room.roomId;
  const criticWs = f.room.members.find(m => m.persona === "critic").workspace.path;
  const improverWs = f.room.members.find(m => m.persona === "improver").workspace.path;
  f.post("improver", "request", "Check this once unsealed", { mentions: ["critic"] });
  f.post("chair", "decision", "Shared decision");

  seedJob(criticWs, f.isoHome, {
    id: "job-agy-rt", sessionId: "chair-session", backend: "antigravity",
    threadId: "thr-agy-rt", turnId: "turn-agy-rt",
    request: { backend: "antigravity", roundtable: { roomId: id, persona: "critic" } }
  });
  const agyRt = startBridge(t, {
    cwd: criticWs,
    env: {
      ...f.env, [PARENT_BRIDGE_ENV.cwd]: criticWs, [PARENT_BRIDGE_ENV.jobId]: "job-agy-rt",
      CODEX_COMPANION_BRIDGE_BACKEND: "antigravity", CODEX_COMPANION_BRIDGE_EXEC_CWD: criticWs
    }
  });
  const callAgy = async (name, args) => (await agyRt.request("tools/call", { name, arguments: args })).result;

  const grepRes = await callAgy("workspace_grep", { pattern: "hello" });
  assert.equal(grepRes.isError, false);
  assert.equal(grepRes.content.length, 2);
  assert.match(grepRes.content[1].text, /1 unread for you \(#2 chair decision\)/);

  const gitRes = await callAgy("workspace_git_read", { op: "status" });
  assert.equal(gitRes.isError, false);
  assert.equal(gitRes.content.length, 2);

  // forum_post unseals critic so both #1 mention and #2 chair decision appear in its footer.
  const postRes = await callAgy("forum_post", { kind: "intent", body: "Initial critic record" });
  assert.equal(postRes.isError, false);
  assert.equal(postRes.content.length, 2);
  assert.match(postRes.content[1].text, /2 unread for you \(#1 request mention, #2 chair decision\)/);

  // Caught forum_post error and invalid ask_parent args error both get the footer.
  const badPost = await callAgy("forum_post", { kind: "decision", body: "Forbidden" });
  assert.equal(badPost.isError, true);
  assert.equal(badPost.content.length, 2);
  assert.match(badPost.content[1].text, /2 unread for you/);

  const badAsk = await callAgy("ask_parent", { question: "" });
  assert.equal(badAsk.isError, true);
  assert.equal(badAsk.content.length, 2);
  assert.match(badAsk.content[1].text, /2 unread for you/);

  // forum_read never gets a footer (and advances indexCursor so subsequent calls get none).
  const readRes = await callAgy("forum_read", {});
  assert.equal(readRes.isError, false);
  assert.equal(readRes.content.length, 1);

  const afterRead = await callAgy("workspace_list", { depth: 1 });
  assert.equal(afterRead.isError, false);
  assert.equal(afterRead.content.length, 1);

  // Codex roundtable job gets no footer even with unread chair decision.
  seedJob(improverWs, f.isoHome, {
    id: "job-cdx-rt", sessionId: "chair-session", backend: "codex",
    threadId: "thr-cdx-rt", turnId: "turn-cdx-rt",
    request: { backend: "codex", roundtable: { roomId: id, persona: "improver" } }
  });
  const cdxRt = startBridge(t, {
    cwd: improverWs,
    env: {
      ...f.env, [PARENT_BRIDGE_ENV.cwd]: improverWs, [PARENT_BRIDGE_ENV.jobId]: "job-cdx-rt",
      CODEX_COMPANION_BRIDGE_BACKEND: "codex"
    }
  });
  const cdxPost = (await cdxRt.request("tools/call", { name: "forum_post", arguments: { kind: "finding", body: "Codex finding" } })).result;
  assert.equal(cdxPost.isError, false);
  assert.equal(cdxPost.content.length, 1);
  const cdxBadAsk = (await cdxRt.request("tools/call", { name: "ask_parent", arguments: { question: "" } })).result;
  assert.equal(cdxBadAsk.isError, true);
  assert.equal(cdxBadAsk.content.length, 1);

  // Non-roundtable antigravity job gets no footer.
  seedJob(f.repo, f.isoHome, {
    id: "job-agy-plain", sessionId: "chair-session", backend: "antigravity",
    threadId: "thr-agy-plain", turnId: "turn-agy-plain",
    request: { backend: "antigravity" }
  });
  const agyPlain = startBridge(t, {
    cwd: f.repo,
    env: {
      ...f.env, [PARENT_BRIDGE_ENV.cwd]: f.repo, [PARENT_BRIDGE_ENV.jobId]: "job-agy-plain",
      CODEX_COMPANION_BRIDGE_BACKEND: "antigravity", CODEX_COMPANION_BRIDGE_EXEC_CWD: f.repo
    }
  });
  const plainList = (await agyPlain.request("tools/call", { name: "workspace_list", arguments: { depth: 1 } })).result;
  assert.equal(plainList.isError, false);
  assert.equal(plainList.content.length, 1);

  // Footer failure (corrupt room.json) is swallowed and never breaks the tool result.
  fs.writeFileSync(f.roomFile, "{corrupt json");
  const corruptList = await callAgy("workspace_list", { depth: 1 });
  assert.equal(corruptList.isError, false);
  assert.equal(corruptList.content.length, 1);
  assert.match(corruptList.content[0].text, /app\.txt/);
});

test("roundtableStatus and renderRoundtableStatus include per-member and room approval and token totals", () => {
  const f = makeFixture(), id = f.room.roomId;
  const jobsDir = path.join(resolveStateDirForRoot(f.repo, f.env), "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  const writeMemberJob = (persona, jobId, patch) => {
    fs.writeFileSync(path.join(jobsDir, `${jobId}.json`), JSON.stringify({
      id: jobId, sessionId: "chair-session", workspaceRoot: f.repo,
      threadId: `thr-${persona}`, turnId: `turn-${jobId}`, status: "completed", ...patch
    }));
    updateMember(id, persona, { status: "active", jobIds: [jobId], threadId: `thr-${persona}` }, f.env);
  };

  // Empty room reports zero approvals and unknown tokens.
  const emptyStatus = roundtableStatus({ roomId: id, sessionId: "chair-session" }, f.env);
  assert.deepEqual(emptyStatus.totals.approvals, { pending: 0, answered: 0 });
  assert.equal(emptyStatus.totals.usage.jobsWithUsage, 0);
  const emptyText = renderRoundtableStatus(emptyStatus);
  assert.match(emptyText, /Counts: 0 posts, 0 threads, 0 open items\nApprovals: 0 pending, 0 answered; tokens: unknown \(0 job\(s\) with usage\)\n/);
  assert.match(emptyText, /critic: seated; antigravity gemini-4-neon; jobs none; workspace .+; approvals 0\/0; tokens unknown/);

  writeMemberJob("critic", "critic-job-1", {
    backend: "antigravity",
    questionHistory: [
      { id: "a1", kind: "action-approval", answer: "Allow once", resolution: "answered" },
      { id: "a2", kind: "action-approval", answer: "Deny", resolution: "answered" },
      { id: "a3", kind: "action-approval", answer: null, resolution: "timeout" },
      { id: "q1", kind: "question", answer: "Use branch A", resolution: "answered" }
    ],
    usage: { inputTokens: 1000, outputTokens: 250, totalTokens: 1250 }
  });
  writeMemberJob("critic", "critic-job-2", {
    backend: "antigravity", status: "running", phase: "needs_answer",
    pendingQuestion: { id: "a4", kind: "action-approval", text: "Edit file" },
    questionHistory: [{ id: "a5", kind: "action-approval", answer: "Allow once", resolution: "answered" }]
  });
  writeMemberJob("improver", "improver-job-1", {
    backend: "codex", status: "running", phase: "needs_answer",
    pendingQuestion: { id: "q2", kind: "question", text: "Clarify scope?" },
    questionHistory: [{ id: "a6", kind: "action-approval", answer: "Allow once", resolution: "answered" }],
    result: { usage: { inputTokens: 400, cachedInputTokens: 100, outputTokens: 50, totalTokens: 450 } }
  });

  const status = roundtableStatus({ roomId: id, sessionId: "chair-session" }, f.env);
  assert.equal(Object.keys(status)[0], "attention");
  assert.deepEqual(status.counts, { events: 0, threads: 0, openItems: 0 });
  const byName = Object.fromEntries(status.members.map(m => [m.name, m]));
  assert.deepEqual(byName.critic.approvals, { pending: 1, answered: 3 });
  assert.equal(byName.critic.usage.inputTokens, 1000);
  assert.equal(byName.critic.usage.outputTokens, 250);
  assert.equal(byName.critic.usage.totalTokens, 1250);
  assert.equal(byName.critic.usage.jobsWithUsage, 1);
  assert.deepEqual(byName.improver.approvals, { pending: 0, answered: 1 });
  assert.equal(byName.improver.usage.totalTokens, 450);
  assert.equal(byName.improver.usage.jobsWithUsage, 1);
  assert.deepEqual(byName.conjecturer.approvals, { pending: 0, answered: 0 });
  assert.equal(byName.conjecturer.usage.jobsWithUsage, 0);
  assert.deepEqual(status.totals.approvals, { pending: 1, answered: 4 });
  assert.equal(status.totals.usage.inputTokens, 1400);
  assert.equal(status.totals.usage.outputTokens, 300);
  assert.equal(status.totals.usage.totalTokens, 1700);
  assert.equal(status.totals.usage.jobsWithUsage, 2);

  // CLI JSON and rendered text keep existing fields/prefixes and show totals.
  const cliJson = run(process.execPath, [companionScript, "roundtable", "status", id, "--json"], { cwd: f.repo, env: f.env });
  assert.equal(cliJson.status, 0, cliJson.stderr);
  assert.deepEqual(JSON.parse(cliJson.stdout).totals, status.totals);

  const cliText = run(process.execPath, [companionScript, "roundtable", "status", id], { cwd: f.repo, env: f.env });
  assert.equal(cliText.status, 0, cliText.stderr);
  assert.match(cliText.stdout, /Counts: 0 posts, 0 threads, 0 open items\nApprovals: 1 pending, 4 answered; tokens: 1700 \(2 job\(s\) with usage\)\n/);
  assert.match(cliText.stdout, /critic: active; antigravity gemini-4-neon; jobs critic-job-1:completed, critic-job-2:needs_answer; workspace .+; approvals 1\/3; tokens 1250/);
  assert.match(cliText.stdout, /improver: active; codex gpt-6\.2-sol; jobs improver-job-1:needs_answer; workspace .+; approvals 0\/1; tokens 450/);
  assert.match(cliText.stdout, /conjecturer: seated; codex gpt-6\.2-sol; jobs none; workspace .+; approvals 0\/0; tokens unknown/);

  // Partial counters without totalTokens count in jobsWithUsage and render tokens unknown.
  writeMemberJob("conjecturer", "conj-partial", { usage: { inputTokens: 120, outputTokens: 30 } });
  const partialStatus = roundtableStatus({ roomId: id, sessionId: "chair-session" }, f.env);
  const conj = partialStatus.members.find(m => m.name === "conjecturer");
  assert.equal(conj.usage.inputTokens, 120);
  assert.equal(conj.usage.outputTokens, 30);
  assert.equal(conj.usage.jobsWithUsage, 1);
  assert.match(renderRoundtableStatus(partialStatus), /conjecturer: active; codex gpt-6\.2-sol; jobs conj-partial:completed; workspace .+; approvals 0\/0; tokens unknown/);
});
