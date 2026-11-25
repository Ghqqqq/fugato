import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { lifecycleHarness } from "./fake-codex-fixture.mjs";
import { installFakeAntigravity } from "./fake-antigravity-fixture.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";
import { runAutomaticRetention } from "../plugins/codex/scripts/lib/retention.mjs";

const { fixture, json, patchJob } = await lifecycleHarness();

function mixedFixture() {
  const f = fixture("review-ok");
  const acp = installFakeAntigravity(f.dir);
  f.env.FUGATO_ANTIGRAVITY_BIN = acp.binary;
  const stateDir = resolveStateDir(f.repo, f.env);
  const stored = id => JSON.parse(fs.readFileSync(path.join(stateDir, "jobs", `${id}.json`)));
  const task = (...flags) => {
    const report = json(f.call("task", "--direct", "--quiet", ...flags, "Complete the assignment."));
    assert.equal(report.status, "completed", report.summary);
    return stored(report.jobId);
  };
  return { ...f, acp, stateDir, stored, task };
}

test("resume-last and rescue select the latest task on the requested backend", () => {
  const f = mixedFixture();
  const empty = f.call("task", "--resume-last", "--json", "Continue.");
  assert.notEqual(empty.status, 0);
  assert.match(empty.stderr, /No previous Codex task thread was found for this repository\./);

  const codex = f.task("--sandbox", "read-only");
  const gemini = f.task("--backend", "antigravity");
  const candidate = (...flags) => json(f.call("task-resume-candidate", "--json", ...flags)).candidate;
  assert.equal(candidate().id, codex.id);
  assert.equal(candidate("--backend", "antigravity").id, gemini.id);
  assert.equal(f.task("--resume-last").threadId, codex.threadId);
  assert.equal(f.task("--resume-last", "--backend", "antigravity").threadId, gemini.threadId);
  assert.equal(f.state().lastThreadResume.threadId, codex.threadId);
  assert.equal(f.acp.requests().find(message => message.method === "session/load").params.sessionId, gemini.threadId);
});

test("an exact --to job supplies the backend and settings when another provider shares its handle", () => {
  const f = mixedFixture();
  const codex = f.task("--sandbox", "read-only", "--model", "gpt-5.4", "--effort", "low");
  f.task("--to", codex.id, "--sandbox", "workspace-write", "--effort", "medium");
  const gemini = f.task("--backend", "antigravity", "--model", "fixture-gemini", "--effort", "high");
  const follow = original => {
    const job = f.task("--to", original.id);
    assert.equal(job.request.settingsInheritance.jobId, original.id);
    assert.equal(job.followUpOf, original.id);
    assert.equal(job.threadId, original.threadId);
    for (const key of ["backend", "sandbox", "model", "effort"]) assert.equal(job.request[key], original.request[key], key);
    return job;
  };
  // Point only the newer, distracting record at the target provider's real session.
  patchJob(f, gemini.id, { threadId: codex.threadId });
  const newerCodex = follow(codex);
  patchJob(f, gemini.id, { threadId: gemini.threadId });
  patchJob(f, newerCodex.id, { threadId: gemini.threadId });
  follow(gemini);
  assert.equal(f.state().lastThreadResume.threadId, codex.threadId);
  assert.equal(f.acp.requests().find(message => message.method === "session/load").params.sessionId, gemini.threadId);
});

test("continuing a never-submitted ACP job loads its recorded Antigravity session", () => {
  const f = mixedFixture();
  const original = f.task("--backend", "antigravity", "--effort", "high");
  patchJob(f, original.id, { status: "failed", turnId: null, turnSubmission: null, report: null,
    result: { turnStatus: "notStarted", turnEnded: true } });
  const next = f.task("--continue", original.id, "--sandbox", "danger-full-access");
  assert.equal(next.request.backend, "antigravity");
  assert.equal(next.request.effort, original.request.effort);
  assert.equal(next.request.continuedFrom, original.id);
  assert.equal(f.acp.requests().find(message => message.method === "session/load").params.sessionId, original.threadId);
  assert.equal(fs.existsSync(path.join(f.dir, "fake-codex-state.json")), false);
});

test("a saved token budget applies to Codex and an explicit Antigravity token budget fails before launch", () => {
  const f = mixedFixture();
  json(f.call("setup", "--default-max-tokens", "20000", "--default-max-minutes", "10", "--json"));
  const launched = f.call("task", "--backend", "antigravity", "--direct", "--quiet", "Complete the assignment.");
  const gemini = f.stored(json(launched).jobId);
  assert.equal(gemini.status, "completed");
  assert.equal(launched.stderr.split("\n").filter(line => /ignor.*default.*max-tokens/i.test(line)).length, 1);
  assert.equal(gemini.request.budget.maxTokens, null);
  assert.equal(gemini.request.budget.maxMinutes, 10);
  const launches = f.acp.state().launches.length;
  const refused = f.call("task", "--to", gemini.id, "--max-tokens", "200", "--json", "Continue.");
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Antigravity ACP.*--max-tokens/);
  assert.equal(f.acp.state().launches.length, launches);
  assert.equal(f.task().request.budget.maxTokens, 20000);
  assert.equal(f.task("--max-tokens", "30000").request.budget.maxTokens, 30000);
});

test("five stale ACP records leave the first maintenance pass available for Codex recovery", async () => {
  const f = mixedFixture();
  const codex = f.task();
  const result = { turnEnded: false, interruptionConfirmed: false };
  patchJob(f, codex.id, { status: "interrupted", result, report: null, ownerAttached: false, pid: null, launcherPid: null });
  const indexFile = path.join(f.stateDir, "state.json");
  const index = JSON.parse(fs.readFileSync(indexFile));
  const stopped = index.jobs.find(job => job.id === codex.id);
  for (let i = 0; i < 5; i++) {
    const id = `acp-${i}`; // Recovery visits job paths in lexical order.
    const record = { id, backend: "antigravity", request: { backend: "antigravity", cwd: f.repo },
      workspaceRoot: f.repo, jobClass: "task", status: "interrupted", updatedAt: stopped.updatedAt,
      threadId: `google-${i}`, turnId: `turn-${i}`, result };
    fs.writeFileSync(path.join(f.stateDir, "jobs", `${id}.json`), JSON.stringify(record));
    index.jobs.push(record);
  }
  fs.writeFileSync(indexFile, JSON.stringify(index));
  const pass = await runAutomaticRetention({ cwd: f.repo, env: f.env, now: Date.now() + 2 * 86400000 });
  assert.deepEqual(pass.errors, []);
  assert.equal(pass.reconciliationAttempts, 1);
  assert.equal(pass.jobsReconciled, 1);
  assert.equal(f.stored(codex.id).recovery.turnId, codex.turnId);
});
