import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "./state.mjs";

const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,120}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
const CREATE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);
const SAME_UID = stat => !process.getuid || stat.uid === process.getuid();

function assertValidJobId(jobId) {
  if (typeof jobId !== "string" || !JOB_ID_PATTERN.test(jobId)) {
    throw new Error("Invalid approval artifact job ID.");
  }
}

export function approvalArtifactDir(workspaceRoot, jobId, env = process.env) {
  if (typeof workspaceRoot !== "string" || !workspaceRoot.trim()) {
    throw new Error("Approval artifact workspace root is required.");
  }
  assertValidJobId(jobId);
  const approvalsDir = path.join(resolveStateDir(workspaceRoot, env), "approvals");
  const dir = path.join(approvalsDir, jobId);
  if (path.dirname(dir) !== approvalsDir) {
    throw new Error("Invalid approval artifact path.");
  }
  return dir;
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !SAME_UID(stat)) {
    throw new Error("Approval artifact directory is not a trusted directory.");
  }
}

function readVerifiedFile(filePath, expectedLength = null) {
  const fd = fs.openSync(filePath, READ_FLAGS);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || !SAME_UID(stat)) return null;
    const named = fs.lstatSync(filePath);
    if (!named.isFile() || named.isSymbolicLink() || named.dev !== stat.dev || named.ino !== stat.ino) return null;
    if (expectedLength !== null && stat.size !== expectedLength) return null;
    const chunks = [];
    const chunk = Buffer.allocUnsafe(Math.min(Math.max(stat.size, 1), 65536));
    let total = 0;
    for (;;) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      total += read;
      if (expectedLength !== null && total > expectedLength) return null;
      chunks.push(Buffer.from(chunk.subarray(0, read)));
    }
    const after = fs.fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || total !== stat.size) return null;
    return Buffer.concat(chunks, total);
  } finally {
    fs.closeSync(fd);
  }
}

export function stageApprovalArtifact(workspaceRoot, jobId, text, env = process.env) {
  if (typeof text !== "string") {
    throw new TypeError("Approval artifact text must be a string.");
  }
  const dir = approvalArtifactDir(workspaceRoot, jobId, env);
  const approvalsDir = path.dirname(dir);
  ensurePrivateDir(approvalsDir);
  ensurePrivateDir(dir);
  const buffer = Buffer.from(text, "utf8");
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const filePath = path.join(dir, `${sha256}.txt`);
  let created = false;
  try {
    const fd = fs.openSync(filePath, CREATE_FLAGS, 0o600);
    created = true;
    try {
      let offset = 0;
      while (offset < buffer.length) {
        const written = fs.writeSync(fd, buffer, offset, buffer.length - offset);
        if (written <= 0) throw new Error("Short write staging approval artifact.");
        offset += written;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if (created) {
      try { fs.unlinkSync(filePath); } catch { /* Best-effort cleanup of partial file. */ }
      throw error;
    }
    if (error?.code !== "EEXIST") throw error;
    const existing = readVerifiedFile(filePath, buffer.length);
    if (!existing || Buffer.compare(existing, buffer) !== 0) {
      throw new Error("Existing approval artifact content does not match expected text.");
    }
  }
  return { path: filePath, sha256, bytes: buffer.length };
}

export function verifyApprovalArtifact(artifact) {
  try {
    const filePath = artifact?.path;
    const sha256 = artifact?.sha256;
    if (typeof filePath !== "string" || !filePath || typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256)) {
      return false;
    }
    const fd = fs.openSync(filePath, READ_FLAGS);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || !SAME_UID(stat)) return false;
      const named = fs.lstatSync(filePath);
      if (!named.isFile() || named.isSymbolicLink() || named.dev !== stat.dev || named.ino !== stat.ino) return false;
      if (artifact.bytes !== undefined && stat.size !== artifact.bytes) return false;
      const hash = createHash("sha256");
      const chunk = Buffer.allocUnsafe(65536);
      let total = 0;
      for (;;) {
        const read = fs.readSync(fd, chunk, 0, chunk.length, null);
        if (read === 0) break;
        total += read;
        hash.update(chunk.subarray(0, read));
      }
      const after = fs.fstatSync(fd);
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || total !== stat.size) return false;
      return hash.digest("hex") === sha256;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}
