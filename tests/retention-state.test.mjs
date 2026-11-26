import "./test-environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { resolveStateDir, tryAcquirePidLock } from "../plugins/codex/scripts/lib/state.mjs";
import { createRoom, setStatus } from "../plugins/codex/scripts/lib/forum.mjs";
import { closeMemberWorkspaces } from "../plugins/codex/scripts/lib/roundtable-workspaces.mjs";
import { resolveRoster } from "../plugins/codex/scripts/lib/roundtable-personas.mjs";
import { stageApprovalArtifact } from "../plugins/codex/scripts/lib/approval-artifacts.mjs";
import { planRetention, applyRetention, runAutomaticRetention } from "../plugins/codex/scripts/lib/retention.mjs";

const DAY = 86400000;
const DEAD_PID = 2147483647;
const cli = new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url).pathname;

function fixture({ git = false } = {}) {
  const root = makeTempDir("retention-state-"), cwd = path.join(root, "workspace");
  fs.mkdirSync(cwd);
  installFakeCodex(root);
  if (git) {
    initGitRepo(cwd);
    fs.writeFileSync(path.join(cwd, "tracked.txt"), "base\n");
    fs.writeFileSync(path.join(cwd, ".gitignore"), "ignored.tmp\n");
    assert.equal(run("git", ["add", "tracked.txt", ".gitignore"], { cwd }).status, 0);
    assert.equal(run("git", ["commit", "-m", "Initial commit"], { cwd }).status, 0);
  }
  const env = {
    ...buildEnv(root),
    CODEX_COMPANION_HOME: path.join(root, "isolated"),
    CLAUDE_CONFIG_DIR: path.join(root, "claude"),
    CODEX_COMPANION_SESSION_ID: "chair-session"
  };
  delete env.CODEX_COMPANION_RETENTION_DAYS;
  const now = Math.floor(Date.now() / 1000) * 1000;
  const old = new Date(now - 31 * DAY).toISOString();
  const recent = new Date(now - DAY).toISOString();
  return { root, cwd, env, now, old, recent, home: env.CODEX_COMPANION_HOME };
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}
function roomDir(f, roomId) {
  return path.join(f.home, "duet", "roundtables", roomId);
}
function makeRoom(f, { roles = ["critic", "improver"], status = "open", closedAt = null, closeWorktrees = false } = {}) {
  const room = createRoom({ sessionId: f.env.CODEX_COMPANION_SESSION_ID, workspaceRoot: f.cwd, goal: "Retention fixture", members: resolveRoster({ roles }) }, f.env);
  if (status !== "open") {
    const updated = setStatus(room.roomId, status, f.env);
    if (status === "closed" && closeWorktrees) closeMemberWorkspaces(updated, f.env);
    if (closedAt !== null) {
      const file = path.join(roomDir(f, room.roomId), "room.json");
      writeJson(file, { ...JSON.parse(fs.readFileSync(file, "utf8")), closedAt });
    }
  }
  return JSON.parse(fs.readFileSync(path.join(roomDir(f, room.roomId), "room.json"), "utf8"));
}
function seedJob(f, id, patch = {}, cwd = f.cwd) {
  const workspace = resolveStateDir(cwd, f.env), directory = path.join(workspace, "jobs");
  fs.mkdirSync(directory, { recursive: true });
  const record = {
    id, status: "completed", completedAt: f.old, updatedAt: f.old, ownerAttached: false, pid: null, threadId: randomUUID(), ...patch,
    logFile: path.join(directory, `${id}.log`), rawOutputFile: path.join(directory, `${id}.output.txt`), resultFile: path.join(directory, `${id}.result.json`)
  };
  const file = path.join(directory, `${id}.json`);
  writeJson(file, record);
  for (const target of [record.logFile, record.rawOutputFile, record.resultFile]) fs.writeFileSync(target, "fixture");
  const indexFile = path.join(workspace, "state.json");
  const state = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, "utf8")) : { version: 1, config: {}, jobs: [] };
  state.jobs.push(record);
  writeJson(indexFile, state);
  return { ...record, file, workspace, indexFile };
}

test("roundtable retention removes expired closed rooms and keeps open, paused, recent and unsafe rooms", async () => {
  const f = fixture(); // non-git shared workspace
  const expired = makeRoom(f, { status: "closed", closedAt: f.old });
  const open = makeRoom(f, { status: "open" });
  const paused = makeRoom(f, { status: "paused" });
  const recent = makeRoom(f, { status: "closed", closedAt: f.recent });
  const boundary = makeRoom(f, { status: "closed", closedAt: new Date(f.now - 30 * DAY).toISOString() });
  const invalidDir = path.join(f.home, "duet", "roundtables", "rt-bad-json");
  fs.mkdirSync(invalidDir, { recursive: true });
  fs.writeFileSync(path.join(invalidDir, "room.json"), "{broken");
  const outside = path.join(f.root, "outside-room");
  fs.mkdirSync(outside, { recursive: true });
  writeJson(path.join(outside, "room.json"), { ...expired, roomId: "rt-link-room" });
  const linkedDir = path.join(f.home, "duet", "roundtables", "rt-link-room");
  fs.symlinkSync(outside, linkedDir);

  const plan = planRetention({ now: f.now, env: f.env });
  assert.deepEqual(plan.rooms.map(r => r.roomId), [expired.roomId]);
  assert.ok(plan.rooms[0].bytes > 0);
  assert.ok(plan.roomsRetained.some(r => r.roomId === "rt-bad-json"));
  assert.ok(plan.roomsRetained.some(r => r.roomId === "rt-link-room"));
  assert.equal(plan.errors.length, 2);

  const applied = await applyRetention(plan);
  assert.equal(applied.roomsDeleted, 1);
  assert.equal(applied.bytesFreed, plan.rooms[0].bytes);
  assert.equal(fs.existsSync(roomDir(f, expired.roomId)), false);
  for (const keep of [roomDir(f, open.roomId), roomDir(f, paused.roomId), roomDir(f, recent.roomId), roomDir(f, boundary.roomId), invalidDir, linkedDir, outside, f.cwd]) {
    assert.ok(fs.existsSync(keep), `expected kept: ${keep}`);
  }
});

test("roundtable retention protects dirty, ignored, committed or unknown worktrees and removes clean leftovers via git", async () => {
  const f = fixture({ git: true });
  const dirtyRoom = makeRoom(f, { status: "closed", closedAt: f.old });
  const dirtyMember = dirtyRoom.members.find(m => m.persona === "critic");
  fs.writeFileSync(path.join(dirtyMember.workspace.path, "ignored.tmp"), "local ignored");

  const commitRoom = makeRoom(f, { status: "closed", closedAt: f.old });
  const commitMember = commitRoom.members.find(m => m.persona === "improver");
  fs.writeFileSync(path.join(commitMember.workspace.path, "tracked.txt"), "changed\n");
  assert.equal(run("git", ["add", "tracked.txt"], { cwd: commitMember.workspace.path }).status, 0);
  assert.equal(run("git", ["commit", "-m", "Member work"], { cwd: commitMember.workspace.path }).status, 0);

  const cleanRoom = makeRoom(f, { status: "closed", closedAt: f.old });
  const cleanPaths = cleanRoom.members.map(m => m.workspace.path);
  const alreadyClosed = makeRoom(f, { status: "closed", closedAt: f.old, closeWorktrees: true });

  const plan = planRetention({ now: f.now, env: f.env });
  assert.deepEqual(plan.rooms.map(r => r.roomId).sort(), [cleanRoom.roomId, alreadyClosed.roomId].sort());
  assert.deepEqual(plan.errors, []);
  const dirtyRetained = plan.roomsRetained.find(r => r.roomId === dirtyRoom.roomId);
  const commitRetained = plan.roomsRetained.find(r => r.roomId === commitRoom.roomId);
  assert.ok(dirtyRetained && dirtyRetained.reason.includes("critic") && dirtyRetained.reason.includes(dirtyMember.workspace.path));
  assert.ok(commitRetained && commitRetained.reason.includes("improver") && commitRetained.reason.includes(commitMember.workspace.path));

  const applied = await applyRetention(plan);
  assert.equal(applied.roomsDeleted, 2);
  assert.deepEqual(applied.errors, []);
  assert.equal(fs.existsSync(roomDir(f, cleanRoom.roomId)), false);
  assert.equal(fs.existsSync(roomDir(f, alreadyClosed.roomId)), false);
  assert.ok(fs.existsSync(roomDir(f, dirtyRoom.roomId)));
  assert.ok(fs.existsSync(dirtyRoom.members.find(m => m.persona === "improver").workspace.path), "whole dirty room including clean sibling worktree is retained");
  assert.ok(fs.existsSync(roomDir(f, commitRoom.roomId)));
  const worktrees = run("git", ["worktree", "list", "--porcelain"], { cwd: f.cwd }).stdout;
  for (const wt of cleanPaths) assert.equal(worktrees.includes(wt), false, "clean worktree unregistered via git worktree remove");
});

test("roundtable apply rechecks under lock for reopened/modified rooms, locked worktrees and unknown status", async () => {
  const f = fixture({ git: true });
  const reopened = makeRoom(f, { status: "closed", closedAt: f.old, closeWorktrees: true });
  const dirtied = makeRoom(f, { status: "closed", closedAt: f.old });
  const lockedWt = makeRoom(f, { status: "closed", closedAt: f.old });
  const brokenWt = makeRoom(f, { status: "closed", closedAt: f.old });
  const brokenMember = brokenWt.members.find(m => m.persona === "critic");
  fs.unlinkSync(path.join(brokenMember.workspace.path, ".git")); // makes memberWorkspaceStatus return hasChanges: null

  const plan = planRetention({ now: f.now, env: f.env });
  assert.deepEqual(plan.rooms.map(r => r.roomId).sort(), [reopened.roomId, dirtied.roomId, lockedWt.roomId].sort());
  const brokenRetained = plan.roomsRetained.find(r => r.roomId === brokenWt.roomId);
  assert.ok(brokenRetained && brokenRetained.reason.includes("critic") && brokenRetained.reason.includes(brokenMember.workspace.path));

  // Modify rooms after planning: reopen one, dirty another, git-lock a clean worktree on the third.
  const reopenedFile = path.join(roomDir(f, reopened.roomId), "room.json");
  writeJson(reopenedFile, { ...JSON.parse(fs.readFileSync(reopenedFile, "utf8")), status: "open", closedAt: null });
  const dirtiedMember = dirtied.members.find(m => m.persona === "critic");
  fs.writeFileSync(path.join(dirtiedMember.workspace.path, "new.txt"), "untracked");
  const lockedMember = lockedWt.members.find(m => m.persona === "critic");
  assert.equal(run("git", ["worktree", "lock", lockedMember.workspace.path], { cwd: f.cwd }).status, 0);

  const applied = await applyRetention(plan);
  assert.equal(applied.roomsDeleted, 0);
  for (const room of [reopened, dirtied, lockedWt, brokenWt]) assert.ok(fs.existsSync(roomDir(f, room.roomId)));
  assert.ok(applied.roomsRetained.some(r => r.roomId === dirtied.roomId && r.reason.includes("critic") && r.reason.includes(dirtiedMember.workspace.path)));
  assert.ok(applied.roomsRetained.some(r => r.roomId === lockedWt.roomId && r.reason.includes("critic") && r.reason.includes(lockedMember.workspace.path)));
  assert.equal(applied.errors.length, 1);
});

test("admission lock retention removes old dead locks/candidates and keeps live, fresh, unrecognized or symlinked entries", async () => {
  const f = fixture();
  const root = path.join(f.home, "duet", "antigravity-session-admission");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const oldDate = new Date(f.now - 120 * 1000);
  const freshDate = new Date(f.now - 20 * 1000);
  const sha = text => createHash("sha256").update(text).digest("hex");
  const makeLock = (name, files, mtime) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    for (const [file, body] of files) {
      const target = path.join(dir, file);
      fs.writeFileSync(target, body);
      fs.utimesSync(target, mtime, mtime);
    }
    fs.utimesSync(dir, mtime, mtime);
    return dir;
  };
  const deadOld = makeLock(`${sha("dead-old")}.lock`, [[`owner-${DEAD_PID}-${randomUUID()}`, "dead"]], oldDate);
  const deadCandidate = makeLock(`${sha("dead-cand")}.lock.owner-${DEAD_PID}-${randomUUID()}`, [[`owner-${DEAD_PID}-${randomUUID()}`, "cand"]], oldDate);
  const deadFresh = makeLock(`${sha("dead-fresh")}.lock`, [[`owner-${DEAD_PID}-${randomUUID()}`, ""]], freshDate);
  const freshCandidate = makeLock(`${sha("fresh-cand")}.lock.owner-${DEAD_PID}-${randomUUID()}`, [[`owner-${DEAD_PID}-${randomUUID()}`, ""]], freshDate);
  const liveLockPath = path.join(root, `${sha("live")}.lock`);
  const releaseLive = tryAcquirePidLock(liveLockPath);
  assert.ok(releaseLive);
  try {
    for (const name of fs.readdirSync(liveLockPath)) fs.utimesSync(path.join(liveLockPath, name), oldDate, oldDate);
    fs.utimesSync(liveLockPath, oldDate, oldDate);
    const unrecognized = makeLock(`${sha("unrec")}.lock`, [[`owner-${DEAD_PID}-${randomUUID()}`, ""], ["unexpected.txt", "keep"]], oldDate);
    const outside = path.join(f.root, "outside-lock");
    fs.mkdirSync(outside);
    const linkedLock = path.join(root, `${sha("symlink")}.lock`);
    fs.symlinkSync(outside, linkedLock);
    const symlinkInside = makeLock(`${sha("symlink-inside")}.lock`, [], oldDate);
    const outsideFile = path.join(outside, "marker");
    fs.writeFileSync(outsideFile, "x"); fs.utimesSync(outsideFile, oldDate, oldDate);
    fs.symlinkSync(outsideFile, path.join(symlinkInside, `owner-${DEAD_PID}-${randomUUID()}`));

    const plan = planRetention({ now: f.now, env: f.env });
    assert.deepEqual(plan.admissionLocks.map(item => item.path).sort(), [deadOld, deadCandidate].sort());
    assert.equal(plan.admissionLocks.reduce((sum, item) => sum + item.bytes, 0), 8);
    assert.deepEqual(plan.errors, []);

    const applied = await applyRetention(plan);
    assert.equal(applied.admissionLocksDeleted, 2);
    assert.equal(applied.bytesFreed, 8);
    assert.deepEqual(applied.errors, []);
    assert.equal(fs.existsSync(deadOld), false);
    assert.equal(fs.existsSync(deadCandidate), false);
    for (const kept of [deadFresh, freshCandidate, liveLockPath, unrecognized, linkedLock, symlinkInside, outside]) {
      assert.ok(fs.existsSync(kept), `expected kept: ${kept}`);
    }
  } finally { releaseLive(); }
});

test("approval artifact retention removes deleted-job and old orphan dirs and keeps existing, recent or unsafe dirs", async () => {
  const f = fixture();
  const expiredJob = seedJob(f, "expired-job");
  const retainedJob = seedJob(f, "retained-job", { completedAt: f.recent });
  const activeJob = seedJob(f, "active-job", { status: "running" });
  const reactivatedJob = seedJob(f, "reactivated-job");

  const expiredArt = stageApprovalArtifact(f.cwd, expiredJob.id, "expired approval payload", f.env);
  const retainedArt = stageApprovalArtifact(f.cwd, retainedJob.id, "retained approval payload", f.env);
  const activeArt = stageApprovalArtifact(f.cwd, activeJob.id, "active approval payload", f.env);
  const reactivatedArt = stageApprovalArtifact(f.cwd, reactivatedJob.id, "reactivated payload", f.env);
  const oldOrphanArt = stageApprovalArtifact(f.cwd, "orphan-old", "old orphan payload", f.env);
  const recentOrphanArt = stageApprovalArtifact(f.cwd, "orphan-recent", "recent orphan payload", f.env);
  const unsafeOrphanArt = stageApprovalArtifact(f.cwd, "orphan-unsafe", "valid file beside unexpected", f.env);
  const symlinkOrphanArt = stageApprovalArtifact(f.cwd, "orphan-symlink", "valid file beside symlink", f.env);

  const oldDate = new Date(f.old);
  for (const file of [retainedArt.path, activeArt.path, oldOrphanArt.path, unsafeOrphanArt.path, symlinkOrphanArt.path]) {
    fs.utimesSync(file, oldDate, oldDate);
  }
  fs.writeFileSync(path.join(path.dirname(unsafeOrphanArt.path), "unexpected.txt"), "keep me");
  const outside = path.join(f.root, "outside-approval.txt");
  fs.writeFileSync(outside, "outside");
  fs.symlinkSync(outside, path.join(path.dirname(symlinkOrphanArt.path), `${createHash("sha256").update("sym").digest("hex")}.txt`));

  const plan = planRetention({ now: f.now, env: f.env });
  assert.deepEqual(plan.approvalDirs.map(item => item.jobId).sort(), [expiredJob.id, "orphan-old", reactivatedJob.id].sort());
  assert.equal(plan.errors.length, 2);

  // Reactivate one job after planning; its approval dir must stay protected on apply.
  const index = JSON.parse(fs.readFileSync(reactivatedJob.indexFile, "utf8"));
  index.jobs.find(j => j.id === reactivatedJob.id).status = "running";
  writeJson(reactivatedJob.indexFile, index);

  const applied = await applyRetention(plan);
  assert.equal(applied.jobsDeleted, 1);
  assert.equal(applied.approvalDirsDeleted, 2);
  assert.equal(fs.existsSync(path.dirname(expiredArt.path)), false);
  assert.equal(fs.existsSync(path.dirname(oldOrphanArt.path)), false);
  for (const keep of [retainedArt.path, activeArt.path, reactivatedArt.path, recentOrphanArt.path, unsafeOrphanArt.path, symlinkOrphanArt.path, outside]) {
    assert.ok(fs.existsSync(keep), `expected kept: ${keep}`);
  }
});

test("cleanup dry-run and apply CLI report planned/deleted rooms, locks, approval dirs and retained rooms", () => {
  const f = fixture({ git: true });
  const expiredRoom = makeRoom(f, { status: "closed", closedAt: f.old });
  const dirtyRoom = makeRoom(f, { status: "closed", closedAt: f.old });
  const dirtyMember = dirtyRoom.members.find(m => m.persona === "critic");
  fs.writeFileSync(path.join(dirtyMember.workspace.path, "dirty.txt"), "unsaved");

  const lockRoot = path.join(f.home, "duet", "antigravity-session-admission");
  const deadLock = path.join(lockRoot, `${createHash("sha256").update("cli-dead").digest("hex")}.lock`);
  fs.mkdirSync(deadLock, { recursive: true });
  const lockMarker = path.join(deadLock, `owner-${DEAD_PID}-${randomUUID()}`);
  fs.writeFileSync(lockMarker, "lockbytes");
  const oldLockDate = new Date(f.now - 120 * 1000);
  fs.utimesSync(lockMarker, oldLockDate, oldLockDate);
  fs.utimesSync(deadLock, oldLockDate, oldLockDate);

  const orphanArt = stageApprovalArtifact(f.cwd, "cli-orphan", "a".repeat(200), f.env);
  fs.utimesSync(orphanArt.path, new Date(f.old), new Date(f.old));

  const dryJsonRun = run(process.execPath, [cli, "cleanup", "--dry-run", "--json"], { cwd: f.cwd, env: f.env });
  assert.equal(dryJsonRun.status, 0, dryJsonRun.stderr);
  const dryPlan = JSON.parse(dryJsonRun.stdout);
  assert.equal(dryPlan.rooms.length, 1);
  assert.equal(dryPlan.admissionLocks.length, 1);
  assert.equal(dryPlan.approvalDirs.length, 1);
  assert.equal(dryPlan.roomsRetained.length, 1);
  assert.ok(dryPlan.rooms[0].bytes > 0);
  assert.equal(dryPlan.admissionLocks[0].bytes, 9);
  assert.equal(dryPlan.approvalDirs[0].bytes, 200);
  for (const target of [roomDir(f, expiredRoom.roomId), deadLock, orphanArt.path]) assert.ok(fs.existsSync(target));

  const dryTextRun = run(process.execPath, [cli, "cleanup", "--dry-run"], { cwd: f.cwd, env: f.env });
  assert.equal(dryTextRun.status, 0, dryTextRun.stderr);
  assert.match(dryTextRun.stdout, /1 rooms, 1 admission locks, 1 approval dirs/);
  assert.match(dryTextRun.stdout, new RegExp(`Planned room: ${expiredRoom.roomId}.*bytes`));
  assert.match(dryTextRun.stdout, /Planned admission lock: .*9 bytes/);
  assert.match(dryTextRun.stdout, /Planned approval dir: .*200 bytes/);
  assert.match(dryTextRun.stdout, new RegExp(`Retained room: ${dirtyRoom.roomId}.*critic`));
  for (const target of [roomDir(f, expiredRoom.roomId), deadLock, orphanArt.path]) assert.ok(fs.existsSync(target));

  const applyRun = run(process.execPath, [cli, "cleanup", "--json"], { cwd: f.cwd, env: f.env });
  assert.equal(applyRun.status, 0, applyRun.stderr);
  const applied = JSON.parse(applyRun.stdout);
  assert.equal(applied.roomsDeleted, 1);
  assert.equal(applied.admissionLocksDeleted, 1);
  assert.equal(applied.approvalDirsDeleted, 1);
  assert.equal(applied.bytesFreed, dryPlan.rooms[0].bytes + 9 + 200);
  assert.equal(applied.roomsRetained.length, 1);
  assert.equal(fs.existsSync(roomDir(f, expiredRoom.roomId)), false);
  assert.equal(fs.existsSync(deadLock), false);
  assert.equal(fs.existsSync(path.dirname(orphanArt.path)), false);
  assert.ok(fs.existsSync(roomDir(f, dirtyRoom.roomId)));
});

test("automatic retention applies rooms, admission locks and approval dirs with no extra throttle and apply text lists counts", async () => {
  const f = fixture();
  const autoRoom = makeRoom(f, { status: "closed", closedAt: f.old });
  const oldLockDate = new Date(f.now - 120 * 1000);
  const autoLock = path.join(f.home, "duet", "antigravity-session-admission", `${createHash("sha256").update("auto").digest("hex")}.lock`);
  fs.mkdirSync(autoLock, { recursive: true });
  const autoMarker = path.join(autoLock, `owner-${DEAD_PID}-${randomUUID()}`);
  fs.writeFileSync(autoMarker, "");
  fs.utimesSync(autoMarker, oldLockDate, oldLockDate);
  const autoArt = stageApprovalArtifact(f.cwd, "auto-orphan", "auto approval payload", f.env);
  fs.utimesSync(autoArt.path, new Date(f.old), new Date(f.old));

  const auto = await runAutomaticRetention({ cwd: f.cwd, env: f.env, now: f.now });
  assert.equal(auto.roomsDeleted, 1);
  assert.equal(auto.admissionLocksDeleted, 1);
  assert.equal(auto.approvalDirsDeleted, 1);
  assert.ok(auto.bytesFreed >= autoArt.bytes);
  assert.deepEqual(auto.errors, []);
  assert.equal(fs.existsSync(roomDir(f, autoRoom.roomId)), false);
  assert.equal(fs.existsSync(autoLock), false);
  assert.equal(fs.existsSync(path.dirname(autoArt.path)), false);

  const g = fixture();
  const cliRoom = makeRoom(g, { status: "closed", closedAt: g.old });
  const applyText = run(process.execPath, [cli, "cleanup"], { cwd: g.cwd, env: g.env });
  assert.equal(applyText.status, 0, applyText.stderr);
  assert.match(applyText.stdout, /1 rooms, 0 admission locks, 0 approval dirs/);
  assert.equal(fs.existsSync(roomDir(g, cliRoom.roomId)), false);
});
