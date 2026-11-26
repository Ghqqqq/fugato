import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveIsolatedCodexHome } from "./codex-home.mjs";
import { withJournalLock } from "./state.mjs";
import { contextSetup } from "./setup-config.mjs";
import { acpProcessGone, isAntigravityJob } from "./acp-process.mjs";

const alive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
};
const readJob = file => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
const ended = job => job?.result?.turnEnded === true || job?.result?.interruptionConfirmed === true || job?.interruptionConfirmed === true
  || job?.recovery?.turnStatus === "notStarted" || job?.result?.turnStatus === "notStarted" || (job?.turnSubmission === null && !job?.turnId);

// Lock order: concurrency reservation -> broker spawn -> thread admission.
// The short counter transaction never holds any broker/thread/job-state lock.
// A submitted turn's slot survives wrapper death until durable end evidence.
// Reviews never submit their reservation: only their live wrapper owns it.
const validSlots = slots => Array.isArray(slots)
  && slots.every(slot => slot && typeof slot.token === "string" && Number.isInteger(slot.pid) && typeof slot.submitted === "boolean");

export function tryAcquireConcurrency({ limit, jobFile = null, env = process.env, backend = null, acpProcessGone: probeAcpGone = acpProcessGone }) {
  if (limit === "off") return { submitted() {}, release() {} };
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid concurrency limit.");
  const directory = path.join(resolveIsolatedCodexHome(env), "duet", "concurrency"), file = path.join(directory, "slots.json");
  let current = resolveIsolatedCodexHome(env);
  for (const part of path.relative(current, file).split(path.sep)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink() || (current === file && stat && (!stat.isFile() || stat.nlink > 1))) throw new Error("Unsafe concurrency state path.");
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const probeDeadAcp = (candidates, probed) => {
    let anyGone = false;
    for (const { token, job } of candidates) {
      if (probed.has(token)) continue;
      const gone = Boolean(probeAcpGone(job));
      probed.set(token, gone);
      if (gone) anyGone = true;
    }
    return anyGone;
  };
  const preProbeDeadAcp = () => {
    const probed = new Map();
    let slots;
    try { slots = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return probed; }
    if (!validSlots(slots)) return probed;
    const candidates = [];
    for (const slot of slots) {
      if (!slot.submitted || alive(slot.pid)) continue;
      const job = readJob(slot.jobFile);
      if (!ended(job) && isAntigravityJob(job) && job.acpProcessExited !== true) candidates.push({ token: slot.token, job });
    }
    probeDeadAcp(candidates, probed);
    return probed;
  };
  const transaction = (action, probed = new Map(), unprobed = null) => withJournalLock(directory, () => {
    let slots;
    try { slots = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; slots = []; }
    if (!validSlots(slots)) throw new Error("Invalid concurrency state; refusing admission.");
    slots = slots.filter(slot => {
      const ownerAlive = alive(slot.pid);
      // Live wrappers release in finally; never read jobs or spawn probes under the lock.
      if (!slot.submitted || ownerAlive) return ownerAlive;
      const job = readJob(slot.jobFile);
      if (ended(job)) return false;
      if (isAntigravityJob(job)) {
        if (job.acpProcessExited === true) return false;
        if (probed.has(slot.token)) return !probed.get(slot.token);
        unprobed?.push({ token: slot.token, job });
        return true;
      }
      return true;
    });
    const result = action(slots), temp = `${file}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(temp, JSON.stringify(slots), { flag: "wx", mode: 0o600 }); fs.renameSync(temp, file); }
    finally { fs.rmSync(temp, { force: true }); }
    return result;
  }, { lockTimeoutMs: 1000 });
  const token = randomUUID();
  const admit = slots => {
    if (slots.length >= limit) return false;
    slots.push({ token, pid: process.pid, jobFile, submitted: false, ...(backend === "antigravity" ? { backend } : {}) });
    return true;
  };
  const probed = preProbeDeadAcp(), unprobed = [];
  let acquired = transaction(admit, probed, unprobed);
  if (!acquired && unprobed.length && probeDeadAcp(unprobed, probed)) acquired = transaction(admit, probed);
  if (!acquired) return null;
  return {
    submitted: () => transaction(slots => { const slot = slots.find(slot => slot.token === token); if (!slot) throw new Error("Concurrency reservation disappeared."); slot.submitted = true; }),
    release: () => transaction(slots => { const index = slots.findIndex(slot => slot.token === token); if (index >= 0) slots.splice(index, 1); })
  };
}

export async function acquireConcurrency({ jobFile = null, signal = null, onQueued = null, onAdmitted = null, env = process.env, acpProcessGone: probeAcpGone = acpProcessGone } = {}) {
  let queued = false;
  for (;;) {
    const limit = contextSetup({ env }).maxConcurrent;
    if (limit === "off") { if (queued) onAdmitted?.(); return tryAcquireConcurrency({ limit, env }); }
    const job = jobFile ? readJob(jobFile) : null;
    if (signal?.aborted || job?.cancelRequested || (job?.leaseExpiresAt && job.leaseExpiresAt <= Date.now())) {
      throw Object.assign(new Error("Concurrency queue interrupted or owner lease expired."), { turnStatus: "notStarted" });
    }
    const reservation = tryAcquireConcurrency({ limit, jobFile, env, backend: isAntigravityJob(job) ? "antigravity" : null, acpProcessGone: probeAcpGone });
    if (reservation) { if (queued) onAdmitted?.(); return reservation; }
    if (!queued) { queued = true; onQueued?.(); }
    if (signal?.aborted) continue;
    await new Promise(resolve => {
      const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(undefined); };
      const timer = setTimeout(done, 100);
      signal?.addEventListener("abort", done, { once: true });
    });
  }
}
