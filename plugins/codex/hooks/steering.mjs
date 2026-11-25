// session.send runs in the sender before the recipient's queue (host d.ts
// SessionSendInput/Result). session.receive runs inside the recipient's turn;
// it is not our interception point while turn.step owns that turn's wait.
import { GEMINI_AGENT_TYPE, isNativeType } from './presets.mjs';
import { bindingFailedKey, keyFor, knownTypes } from './native-identity.mjs';
const GEMINI_BUSY = 'This Gemini worker is in the middle of a turn and cannot take new instructions. Wait for its report, then send again; answer a displayed permission question with exactly Allow once or Deny.';
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
const ASSIGNMENT = '[Fugato Gemini assignment]\n';
export function geminiMessage(text) {
  if (text.startsWith(ASSIGNMENT)) return { text: text.slice(ASSIGNMENT.length) };
  const tag = /^\[Fugato Gemini answer ([a-zA-Z0-9_-]{1,128})\]\n/.exec(text);
  return tag ? { text: text.slice(tag[0].length), questionId: tag[1] } : { text };
}

// undefined means this turn cannot receive a message. null means the next
// message is an assignment. A string addresses one returned question.
export function returnedQuestion(state) {
  if (!state?.answer || state.incoming || ('returnedTurn' in state && state.returnedTurn !== state.turnId)) return undefined;
  if (state.answer.status === 'needs_answer') {
    return state.questionId && state.questionId === state.answer.question?.id ? state.questionId : undefined;
  }
  return ['queued', 'running', 'needs_answer'].includes(state.status) ? undefined : null;
}

// A live roster entry is authoritative. During discovery gaps resolve only a
// unique binding in this session; an id takes precedence over a display name.
async function storedRecipient($, session, to) {
  const direct = await $.store.get(keyFor(session, to)) ?? await $.store.get(bindingFailedKey(session, to));
  if (direct && (!direct.session || direct.session === session)) return { id: to, type: knownTypes.get(to) ?? direct.type };
  const prefix = keyFor(session, '');
  const guards = bindingFailedKey(session, '');
  const keys = (await $.store.keys()).filter(key => key.startsWith(prefix) || key.startsWith(guards));
  const states = await Promise.all(keys.map(key => $.store.get(key)));
  const matches = new Map();
  for (const state of states) {
    if (state?.session === session && state.agentId && state.name?.toLowerCase() === to.toLowerCase()) {
      matches.set(state.agentId, { id: state.agentId, type: knownTypes.get(state.agentId) ?? state.type });
    }
  }
  if (matches.size === 1) return matches.values().next().value;
  if ([...matches.values()].some(agent => agent.type === GEMINI_AGENT_TYPE)) return { ambiguous: true };
}

export function registerSteering(on, dispatching, resolving) {
  // Only sends currently resolving a recipient need to know that a report
  // crossed their lookup. Never bind one of those sends to the newer question.
  on('session.send', async ($, e, next) => {
    let attempted = false, gemini = false, fallback = e;
    const routes = new Map();
    for (const key of dispatching.keys()) routes.set(key, undefined);
    resolving.add(routes);
    try {
      if (typeof e.text !== 'string') return next(e);
      const escaped = e.text.startsWith('[Fugato Gemini') ? { ...e, text: ASSIGNMENT + e.text } : e;
      fallback = escaped;
      let agents = [];
      try { agents = await $.agent.list(); } catch { /* Try the durable session binding. */ }
      const matches = agents.filter(agent => agent.id === e.to || agent.name?.toLowerCase() === e.to.toLowerCase());
      const session = await $.session.id();
      const agent = matches.length === 1 ? matches[0] : await storedRecipient($, session, e.to);
      if (agent?.ambiguous || (matches.length > 1 && matches.some(row => row.type === GEMINI_AGENT_TYPE))) {
        return { isDelivered: false, reason: 'The Gemini recipient is ambiguous. Send to its agent id.' };
      }
      if (!agent) return next(escaped);
      fallback = e;
      if (!isNativeType(agent.type)) return next(e);
      gemini = agent.type === GEMINI_AGENT_TYPE;
      if (!gemini && (agent.status !== 'running' || e.agentId || !e.text.trim() || e.text.length > 65536)) return next(e);
      const key = keyFor(session, agent.id);
      const state = await $.store.get(key);
      if (gemini) {
        let id = returnedQuestion(state);
        if (!state && agent.status && agent.status !== 'running') id = null;
        if (routes.has(key)) id = routes.get(key);
        else if (dispatching.has(key)) id = undefined;
        if (id === undefined) return { isDelivered: false, reason: GEMINI_BUSY };
        if (id === null || escaped !== e) return next(escaped);
        return next({ ...e, text: `[Fugato Gemini answer ${id}]\n${e.text}` });
      }
      if (!state || state.session !== session || state.bindingPending || state.status === 'needs_answer' || state.answer?.status === 'needs_answer') return next(e);
      // An early send can precede the progress lookup that publishes jobId.
      // Resolve its durable launch nonce; never spawn or mutate its binding.
      if (!state.jobId && state.intent?.kind === 'task') await resolveJob($, state);
      if (!state.jobId || !state.ownerId) return next(e);
      const id = await deliveryId($, session, agent.id);
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
      return attempted ? { isDelivered: false, reason: UNKNOWN_REASON } : next(fallback);
    } finally { resolving.delete(routes); }
  }).catch(() => ({ isDelivered: false, reason: UNKNOWN_REASON }));
}
