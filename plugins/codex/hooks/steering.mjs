// session.send runs in the sender before the recipient's queue (host d.ts
// SessionSendInput/Result). session.receive runs inside the recipient's turn;
// it is not our interception point while turn.step owns that turn's wait.
import { GEMINI_AGENT_TYPE, isNativeType } from './presets.mjs';
const UNKNOWN_REASON = 'Codex steering outcome unknown; the message may or may not have reached the running turn and will not be resent automatically. Inspect the Fugato job before resending.';
async function deliveryId($, session, agentId) {
  return `${session}:${agentId}:${await $.clock.now()}:${Math.random().toString(36).slice(2)}`;
}
function command($, state, args, input = '') {
  return { argv: ['node', `${$.plugin.root}/bin/fugato`, ...args, '--cwd', state.cwd, '--session', state.session], cwd: state.cwd, input };
}
async function resolveJob($, state) {
  const request = command($, state, ['status', '--all', '--json', '--dispatch-nonce', state.intent.nonce]);
  const result = await $.process.run(request.argv, { cwd: request.cwd, timeoutMs: 5000 });
  if (result.exitCode !== 0 || result.isStdoutTruncated) return;
  const snapshot = JSON.parse(result.stdout);
  const jobs = [...(snapshot.running ?? []), snapshot.latestFinished, ...(snapshot.recent ?? [])].filter(Boolean);
  const matches = jobs.filter(job => job.sessionId === state.session && job.dispatchNonce === state.intent.nonce);
  if (matches.length === 1) Object.assign(state, { jobId: matches[0].id, ownerId: matches[0].ownerId });
}
// Capture a Gemini message's purpose at the sender. The host may deliver the
// message in a later turn, after a different permission question is displayed.
const deliveryPrefix = '[Fugato Gemini ';
export const deferredWake = id => `${deliveryPrefix}resume ${id}]`;
export function geminiDelivery(text) {
  const match = /^\[Fugato Gemini (assignment|answer ([^\]\n]+))\]\n/.exec(text);
  return match && { questionId: match[2], text: text.slice(match[0].length) };
}
// A question can be displayed while a sender is resolving the recipient.
// Remember that ordering without comparing wall clocks or retaining history.
const resolvingSends = new Set();
export function displayedGeminiQuestion(id) {
  for (const laterQuestions of resolvingSends) laterQuestions.add(id);
}
export function registerSteering(on) {
  on('session.send', async ($, e, next) => {
    let attempted = false, gemini = false;
    const laterQuestions = new Set();
    try {
      // Only the main conversation steers. Subagent and teammate sends keep the
      // ordinary queue, where the teammate mailbox guard judges them.
      if (typeof e.text !== 'string' || !e.text.trim() || e.text.length > 65536) return next(e);
      if (e.agentId && !e.text.startsWith(deliveryPrefix)) return next(e);
      resolvingSends.add(laterQuestions);
      const agents = await $.agent.list();
      const matches = agents.filter(agent => agent.id === e.to || agent.name?.toLowerCase() === e.to.toLowerCase());
      if (matches.length !== 1 || !isNativeType(matches[0].type)) return next(e);
      gemini = matches[0].type === GEMINI_AGENT_TYPE;
      if (!gemini && matches[0].status !== 'running') return next(e);
      const session = await $.session.id();
      const state = await $.store.get(`native:v2:${session}:${matches[0].id}`);
      if (gemini || state?.backend === 'antigravity') {
        gemini = true;
        if (e.origin?.kind === 'plugin' && e.origin.name === 'fugato'
          && state?.deferredAssignments?.some(item => e.text === deferredWake(item.id))) return next(e);
        const shown = !e.agentId && state?.answer?.status === 'needs_answer' && state.questionId
          && state.answer.question?.id === state.questionId && !laterQuestions.has(state.questionId);
        // Ordinary assignments stay verbatim, including DUET headers. Escape
        // a literal protocol-looking first line so it cannot impersonate a wake.
        const tag = shown ? `answer ${state.questionId}` : e.text.startsWith(deliveryPrefix) ? 'assignment' : null;
        return await next(tag ? { ...e, text: `${deliveryPrefix}${tag}]\n${e.text}` } : e);
      }
      if (e.agentId || !state || state.session !== session || state.bindingPending || state.status === 'needs_answer' || state.answer?.status === 'needs_answer') return next(e);
      // An early send can precede the progress lookup that publishes jobId.
      // Resolve its durable launch nonce; never spawn or mutate its binding.
      if (!state.jobId && state.intent?.kind === 'task') await resolveJob($, state);
      if (!state.jobId || !state.ownerId) return next(e);
      const id = await deliveryId($, session, matches[0].id);
      const request = command($, state, ['steer', state.jobId, '--delivery-id', id, '--owner', state.ownerId], e.text);
      attempted = true;
      const result = await $.process.run(request.argv, { cwd: request.cwd, stdin: request.input, timeoutMs: 12000 });
      if (result.exitCode !== 0 || result.isStdoutTruncated) throw new Error('Steering receipt unavailable.');
      const receipt = JSON.parse(result.stdout);
      if (receipt.jobId !== state.jobId || receipt.deliveryId !== id || !['queued', 'applied', 'deferred', 'failed', 'unknown'].includes(receipt.status)) throw new Error('Invalid steering receipt.');
      if (receipt.status === 'deferred' && receipt.fallback === true) return next(e);
      const text = `Codex steering ${receipt.status}${receipt.status === 'unknown' ? '; acknowledgement missing, message will not be replayed' : ''}.`;
      try { await $.session.append({ message: { type: 'system', content: [{ type: 'text', text }] } }); }
      catch { /* A notice failure cannot replay a durable delivery. */ }
      if (receipt.status === 'unknown') return { isDelivered: false, reason: UNKNOWN_REASON };
      return receipt.status === 'failed' ? { isDelivered: false,
        reason: `Codex steering failed (${receipt.reason ?? 'steer_rejected'}); the message will not be resent automatically. Inspect the Fugato job before resending.` } : { isDelivered: true };
    } catch {
      // After process launch a lost receipt is ambiguous. Never release that
      // text to the host queue, which could start a second Codex turn.
      if (gemini) return { isDelivered: false, reason: 'Gemini message routing could not be confirmed. Check the worker before resending.' };
      return attempted ? { isDelivered: false, reason: UNKNOWN_REASON } : next(e);
    } finally { resolvingSends.delete(laterQuestions); }
  }).catch(() => ({ isDelivered: false, reason: UNKNOWN_REASON }));
}
