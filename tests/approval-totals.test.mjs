import "./test-environment.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { makeTempDir } from "./helpers.mjs";
import { appendActivity, isDeniedApproval, recordApprovalResolution, seedApprovalTotals } from "../plugins/codex/scripts/lib/activity.mjs";
import { answerQuestion, askParentQuestion } from "../plugins/codex/scripts/lib/job-runtime.mjs";
import { createJobProgressUpdater } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";
import { countJobApprovals, createRoom, renderRoundtableStatus, roundtableStatus, updateMember } from "../plugins/codex/scripts/lib/forum.mjs";
import { readJobFile, resolveJobFile, resolveStateDirForRoot, upsertJob, writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";

function makeRoundtableFixture() {
  const dir = makeTempDir("approval-totals-");
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "app.txt"), "hello\n");
  const env = { ...process.env, CODEX_COMPANION_SESSION_ID: "chair-session" };
  const room = createRoom({
    sessionId: "chair-session",
    workspaceRoot: repo,
    goal: "Verify monotonic approvalTotals beyond the 20-entry questionHistory cap.",
    members: [
      { persona: "critic", model: "gemini-4-neon", effort: "high", backend: "antigravity" },
      { persona: "improver", model: "gpt-6.2-sol", effort: "high", backend: "codex" }
    ]
  }, env);
  return { dir, repo, env, room };
}

function seedRunningJob(repo, id, extra = {}) {
  const job = {
    id,
    sessionId: "chair-session",
    workspaceRoot: repo,
    status: "running",
    ownerId: "owner",
    questionTimeoutSec: 60,
    ...extra
  };
  writeJobFile(repo, id, job);
  upsertJob(repo, job);
  return job;
}

test("25 answered action-approvals keep questionHistory capped at 20 while approvalTotals and roundtable status report 25", async t => {
  const f = makeRoundtableFixture();
  const jobId = "task-25-approvals";
  seedRunningJob(f.repo, jobId, { threadId: "thr-critic", turnId: "turn-1" });
  let now = 200_000;
  t.mock.method(Date, "now", () => now);

  const answers = [
    ...Array.from({ length: 21 }, () => "Allow once"),
    "Deny",
    "Deny: use workspace_grep instead",
    "deny",
    "deny: stay inside worktree"
  ];
  assert.equal(answers.length, 25);

  for (let i = 0; i < answers.length; i++) {
    now += 1000;
    const pendingPromise = askParentQuestion(f.repo, jobId, {
      question: `Approve action #${i + 1}`,
      options: ["Allow once", "Deny"],
      kind: "action-approval"
    });
    const asking = readJobFile(resolveJobFile(f.repo, jobId)).pendingQuestion;
    assert.ok(asking, `pendingQuestion #${i + 1} recorded`);
    answerQuestion(f.repo, jobId, asking.id, answers[i], "owner");
    const result = await pendingPromise;
    assert.equal(result.resolution, "answered");
  }

  // Non-action-approval questions and timed-out action-approvals do not inflate totals.
  now += 1000;
  const plainQuestion = askParentQuestion(f.repo, jobId, {
    question: "Clarify scope?",
    options: ["A", "B"],
    kind: "question",
    callId: "call-q1"
  });
  const plainPending = readJobFile(resolveJobFile(f.repo, jobId)).pendingQuestion;
  answerQuestion(f.repo, jobId, plainPending.id, "Deny: not an action approval", "owner");
  assert.equal((await plainQuestion).resolution, "answered");

  now += 1000;
  const timedOut = askParentQuestion(f.repo, jobId, {
    question: "Approve timed-out command",
    options: ["Allow once", "Deny"],
    kind: "action-approval"
  });
  const timeoutPending = readJobFile(resolveJobFile(f.repo, jobId)).pendingQuestion;
  now = timeoutPending.expiresAt;
  assert.equal((await timedOut).resolution, "timeout");

  const saved = readJobFile(resolveJobFile(f.repo, jobId));
  assert.equal(saved.questionHistory.length, 20);
  assert.deepEqual(saved.approvalTotals, { answered: 25, denied: 4, autoAllowed: 0, autoDenied: 0 });
  assert.deepEqual(countJobApprovals([saved]), { pending: 0, answered: 25 });

  // Also check a second active job with 1 pending action-approval.
  const pendingJobId = "task-pending-approval";
  seedRunningJob(f.repo, pendingJobId, {
    threadId: "thr-critic",
    turnId: "turn-2",
    pendingQuestion: { id: "a-pending", kind: "action-approval", text: "Run git status", options: ["Allow once", "Deny"] }
  });
  updateMember(f.room.roomId, "critic", { status: "active", jobIds: [jobId, pendingJobId], threadId: "thr-critic" }, f.env);

  const status = roundtableStatus({ roomId: f.room.roomId, sessionId: "chair-session" }, f.env);
  const critic = status.members.find(member => member.name === "critic");
  assert.deepEqual(critic.approvals, { pending: 1, answered: 25 });
  assert.deepEqual(critic.approvalTotals, { answered: 25, denied: 4, autoAllowed: 0, autoDenied: 0 });
  assert.deepEqual(status.totals.approvals, { pending: 1, answered: 25 });
  assert.deepEqual(status.totals.approvalTotals, { answered: 25, denied: 4, autoAllowed: 0, autoDenied: 0 });

  const rendered = renderRoundtableStatus(status);
  assert.match(rendered, /Approvals: 1 pending, 25 answered;/);
  assert.match(rendered, /critic: active; .+; approvals 1\/25;/);
});

test("legacy job records without approvalTotals fall back to questionHistory and seed cleanly on new resolutions", async t => {
  const f = makeRoundtableFixture();
  const jobsDir = path.join(resolveStateDirForRoot(f.repo, f.env), "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  const legacyJobId = "legacy-job-1";
  const legacyRecord = {
    id: legacyJobId,
    sessionId: "chair-session",
    workspaceRoot: f.repo,
    threadId: "thr-improver",
    turnId: "turn-legacy",
    status: "completed",
    questionHistory: [
      { id: "a1", kind: "action-approval", answer: "Allow once", resolution: "answered" },
      { id: "a2", kind: "action-approval", answer: "Deny", resolution: "answered" },
      { id: "a3", kind: "action-approval", answer: "Deny: out of scope", resolution: "answered" },
      { id: "a4", kind: "action-approval", answer: null, resolution: "timeout" },
      { id: "q1", kind: "question", answer: "Yes", resolution: "answered" }
    ]
  };
  fs.writeFileSync(path.join(jobsDir, `${legacyJobId}.json`), JSON.stringify(legacyRecord));
  updateMember(f.room.roomId, "improver", { status: "active", jobIds: [legacyJobId], threadId: "thr-improver" }, f.env);

  assert.deepEqual(countJobApprovals([legacyRecord]), { pending: 0, answered: 3 });
  const status = roundtableStatus({ roomId: f.room.roomId, sessionId: "chair-session" }, f.env);
  const improver = status.members.find(member => member.name === "improver");
  assert.deepEqual(improver.approvals, { pending: 0, answered: 3 });
  assert.deepEqual(improver.approvalTotals, { answered: 3, denied: 2, autoAllowed: 0, autoDenied: 0 });
  assert.deepEqual(status.totals.approvals, { pending: 0, answered: 3 });
  assert.deepEqual(status.totals.approvalTotals, { answered: 3, denied: 2, autoAllowed: 0, autoDenied: 0 });

  // Upgrading a legacy record already at the 20-entry cap preserves all 20 prior answers before eviction.
  const upgradedId = "legacy-upgrade-20";
  let now = 300_000;
  t.mock.method(Date, "now", () => now);
  seedRunningJob(f.repo, upgradedId, {
    questionHistory: Array.from({ length: 20 }, (_, i) => ({
      id: `old-${i}`,
      kind: "action-approval",
      answer: i === 0 ? "Deny" : "Allow once",
      resolution: "answered"
    }))
  });
  const pendingPromise = askParentQuestion(f.repo, upgradedId, {
    question: "Action #21",
    options: ["Allow once", "Deny"],
    kind: "action-approval"
  });
  const asking = readJobFile(resolveJobFile(f.repo, upgradedId)).pendingQuestion;
  answerQuestion(f.repo, upgradedId, asking.id, "Deny: x", "owner");
  assert.equal((await pendingPromise).resolution, "answered");

  const upgraded = readJobFile(resolveJobFile(f.repo, upgradedId));
  assert.equal(upgraded.questionHistory.length, 20);
  assert.deepEqual(upgraded.approvalTotals, { answered: 21, denied: 2, autoAllowed: 0, autoDenied: 0 });
  assert.deepEqual(countJobApprovals([upgraded]), { pending: 0, answered: 21 });
});

test("denial variants and permissionAutoAllowed activities increment monotonic approvalTotals", () => {
  assert.equal(isDeniedApproval("answered", "Deny"), true);
  assert.equal(isDeniedApproval("answered", "deny"), true);
  assert.equal(isDeniedApproval("answered", "Deny: x"), true);
  assert.equal(isDeniedApproval("answered", "  deny: guidance"), true);
  assert.equal(isDeniedApproval("denied", null), true);
  assert.equal(isDeniedApproval("deny", undefined), true);
  assert.equal(isDeniedApproval("answered", "Allow once"), false);
  assert.equal(isDeniedApproval("timeout", null), false);

  // Resolution denial without an answer increments denied without incrementing answered.
  const deniedNoAnswer = recordApprovalResolution({}, { kind: "action-approval", resolution: "denied", answer: null });
  assert.deepEqual(deniedNoAnswer.approvalTotals, { answered: 0, denied: 1, autoAllowed: 0, autoDenied: 0 });

  // permissionAutoAllowed increments autoAllowed monotonically across the 500-event activity window.
  const f = makeRoundtableFixture();
  const jobId = "task-auto-allowed";
  seedRunningJob(f.repo, jobId, { threadId: "thr-critic", turnId: "turn-auto" });
  const updater = createJobProgressUpdater(f.repo, jobId);

  updater({
    message: "parent bridge tool auto-allowed: workspace_list",
    activity: [
      { type: "permissionAutoAllowed", lifecycle: "completed", status: "approved", tool: "workspace_list", text: "parent bridge tool auto-allowed: workspace_list" },
      { type: "permissionAutoAllowed", lifecycle: "completed", status: "approved", tool: "workspace_grep", text: "parent bridge tool auto-allowed: workspace_grep" }
    ]
  });

  // Push >500 ordinary events to evict the original permissionAutoAllowed entries from retained activity.
  updater({
    message: "burst",
    activity: Array.from({ length: 505 }, (_, i) => ({ type: "agentMessage", text: `msg ${i}` }))
  });
  updater({
    message: "parent bridge tool auto-allowed: workspace_git_read",
    activity: [
      { type: "permissionAutoAllowed", lifecycle: "completed", status: "approved", tool: "workspace_git_read", text: "parent bridge tool auto-allowed: workspace_git_read" }
    ]
  });

  const saved = readJobFile(resolveJobFile(f.repo, jobId));
  assert.equal(saved.activity.length, 500);
  assert.deepEqual(saved.approvalTotals, { answered: 0, denied: 0, autoAllowed: 3, autoDenied: 0 });

  // Preserves future autoDenied values rather than clobbering them to 0.
  const withAutoDenied = appendActivity(
    { activity: [], approvalTotals: { answered: 1, denied: 1, autoAllowed: 2, autoDenied: 4 } },
    [{ type: "permissionAutoAllowed", lifecycle: "completed", status: "approved", tool: "workspace_list" }]
  );
  assert.deepEqual(withAutoDenied.approvalTotals, { answered: 1, denied: 1, autoAllowed: 3, autoDenied: 4 });
  assert.deepEqual(seedApprovalTotals({}), { answered: 0, denied: 0, autoAllowed: 0, autoDenied: 0 });

  updateMember(f.room.roomId, "critic", { status: "active", jobIds: [jobId], threadId: "thr-critic" }, f.env);
  const status = roundtableStatus({ roomId: f.room.roomId, sessionId: "chair-session" }, f.env);
  assert.deepEqual(status.totals.approvalTotals, { answered: 0, denied: 0, autoAllowed: 3, autoDenied: 0 });
});
