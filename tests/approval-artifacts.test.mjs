import "./test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir, initGitRepo } from "./helpers.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";
import { approvalArtifactDir, stageApprovalArtifact, verifyApprovalArtifact } from "../plugins/codex/scripts/lib/approval-artifacts.mjs";

function makeWorkspace(t) {
  const root = makeTempDir("approval-artifacts-");
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo, { recursive: true });
  initGitRepo(repo);
  const env = { ...process.env, CODEX_COMPANION_HOME: path.join(root, "isolated") };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, repo, env };
}

test("approvalArtifactDir resolves under approvals/<jobId> and validates jobId", t => {
  const { repo, env } = makeWorkspace(t);
  const maxId = "A".repeat(120);
  assert.equal(approvalArtifactDir(repo, "task-123_abc", env), path.join(resolveStateDir(repo, env), "approvals", "task-123_abc"));
  assert.equal(approvalArtifactDir(repo, maxId, env), path.join(resolveStateDir(repo, env), "approvals", maxId));
  for (const invalid of ["", "../escape", "a/b", "a.b", "a b", "x".repeat(121), null, undefined, 42]) {
    assert.throws(() => approvalArtifactDir(repo, invalid, env), /job ID/i);
    assert.throws(() => stageApprovalArtifact(repo, invalid, "payload", env), /job ID/i);
  }
  assert.throws(() => approvalArtifactDir("", "task-1", env), /workspace root/i);
});

test("stageApprovalArtifact writes 0700/0600 exclusive files, reuses identical content, and rejects mismatches or symlinks", t => {
  const { root, repo, env } = makeWorkspace(t);
  const jobId = "task-stage-1";
  const text = "Exact approval text\nwith \"quotes\", \\backslashes\\, and UTF-8 中🙂\n";
  const expectedBytes = Buffer.byteLength(text, "utf8");
  const expectedSha = createHash("sha256").update(text, "utf8").digest("hex");

  const staged = stageApprovalArtifact(repo, jobId, text, env);
  assert.equal(staged.sha256, expectedSha);
  assert.equal(staged.bytes, expectedBytes);
  assert.equal(staged.path, path.join(approvalArtifactDir(repo, jobId, env), `${expectedSha}.txt`));
  assert.equal(fs.readFileSync(staged.path, "utf8"), text);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.dirname(staged.path)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(staged.path).mode & 0o777, 0o600);
  }
  assert.equal(verifyApprovalArtifact(staged), true);
  assert.equal(verifyApprovalArtifact({ path: staged.path, sha256: staged.sha256 }), true);

  // Identical content reuses the existing file.
  assert.deepEqual(stageApprovalArtifact(repo, jobId, text, env), staged);

  // Different content at the same hash path is rejected without overwriting.
  const otherText = "different payload";
  const otherSha = createHash("sha256").update(otherText, "utf8").digest("hex");
  const conflictPath = path.join(approvalArtifactDir(repo, jobId, env), `${otherSha}.txt`);
  fs.writeFileSync(conflictPath, "corrupted existing bytes", { mode: 0o600 });
  assert.throws(() => stageApprovalArtifact(repo, jobId, otherText, env), /does not match/i);
  assert.equal(fs.readFileSync(conflictPath, "utf8"), "corrupted existing bytes");

  // Mutating, truncating, symlinking, or removing the file fails verification.
  fs.writeFileSync(staged.path, text.replace("Exact", "Altered"), { mode: 0o600 });
  assert.equal(verifyApprovalArtifact(staged), false);
  const external = path.join(root, "external.txt");
  fs.writeFileSync(external, text, { mode: 0o600 });
  fs.unlinkSync(staged.path);
  assert.equal(verifyApprovalArtifact(staged), false);
  fs.symlinkSync(external, staged.path);
  assert.equal(verifyApprovalArtifact(staged), false);
  assert.throws(() => stageApprovalArtifact(repo, jobId, text, env));
  assert.equal(verifyApprovalArtifact({ path: staged.path, sha256: "not-a-sha" }), false);
  assert.equal(verifyApprovalArtifact(null), false);
});
