import { test, expect, mock } from 'claude-code/testing';
import { reportMarkdown } from '../hooks/native-agent.mjs';

test('Gemini mid-turn steering queues immediately with Gemini notices, passes reserved Answer syntax to next(e), and renders unconsumedSteers reports', async ($, on) => {
  const store = new Map<string, any>();
  let agents: any[] = [{ id: 'gem-1', name: 'Curie', type: 'fugato:gemini-native', status: 'running' }];
  const steerCalls: any[] = [];
  const hostDeliveries: string[] = [];
  let steerMode: 'queued' | 'failed' | 'deferred' = 'queued';

  mock.env(on, {});
  mock.clock(on, { now: 1800000000000 });
  const transcript = mock.session(on);
  on('session.id', () => ({ value: 'gemini-plugin-session-1234567890-abcdef' }));
  on('store.get', (_: any, e: any) => ({ value: store.get(e.key) }));
  on('agent.list', () => ({ value: agents }));
  on('session.send', (_: any, e: any) => {
    hostDeliveries.push(e.text);
    return { isDelivered: true };
  });
  on('process.run', (_: any, e: any) => {
    steerCalls.push({ argv: [...e.argv], stdin: e.init?.stdin ?? '' });
    const deliveryId = e.argv[e.argv.indexOf('--delivery-id') + 1];
    const receipt = steerMode === 'failed'
      ? { jobId: 'task-gem-1', deliveryId, status: 'failed', fallback: false, reason: 'inbox_full' }
      : steerMode === 'deferred'
        ? { jobId: 'task-gem-1', deliveryId, status: 'deferred', fallback: true, reason: 'pending_question' }
        : { jobId: 'task-gem-1', deliveryId, status: 'queued', fallback: false, reason: null };
    return { value: { exitCode: 0, stdout: JSON.stringify(receipt), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } };
  });

  const session = 'gemini-plugin-session-1234567890-abcdef';
  const key = `native:v2:${session}:gem-1`;
  store.set(key, { session, cwd: '/repo', jobId: 'task-gem-1', ownerId: 'owner-gem-1', status: 'running' });

  // Running Gemini worker without pending question routes through fugato steer with <=64 char ID and emits Gemini notice.
  const queued = await $.session.send({ to: 'Curie', text: 'Focus on parser tests.' });
  expect(queued).toEqual({ isDelivered: true });
  expect(steerCalls).toHaveLength(1);
  expect(steerCalls[0].argv[2]).toBe('steer');
  expect(steerCalls[0].argv[steerCalls[0].argv.indexOf('--delivery-id') + 1]).toMatch(/^[A-Za-z0-9._:-]{1,64}$/);
  expect(steerCalls[0].stdin).toBe('Focus on parser tests.');
  expect(hostDeliveries).toEqual([]);
  expect(transcript.appended().at(-1)?.message.content[0].text).toBe('Gemini steering queued.');

  // Reserved Answer syntax goes straight to host delivery even while running or after answering q1 (never steered).
  store.set(key, { session, cwd: '/repo', jobId: 'task-gem-1', ownerId: 'owner-gem-1', status: 'needs_answer', intent: { kind: 'answer', turnId: 'turn-2' } });
  const lateAnswer = 'Answer q-1\nDeny';
  expect(await $.session.send({ to: 'Curie', text: lateAnswer })).toEqual({ isDelivered: true });
  expect(steerCalls).toHaveLength(1);
  expect(hostDeliveries).toEqual([lateAnswer]);

  // Failed receipt emits Gemini-labelled reason and notice.
  store.set(key, { session, cwd: '/repo', jobId: 'task-gem-1', ownerId: 'owner-gem-1', status: 'running' });
  steerMode = 'failed';
  const failed = await $.session.send({ to: 'Curie', text: 'Overflow note.' });
  expect(failed.isDelivered).toBe(false);
  expect(failed.reason).toContain('Gemini steering failed (inbox_full)');
  expect(transcript.appended().at(-1)?.message.content[0].text).toBe('Gemini steering failed.');

  // Parked needs_answer bypasses steering so Answer <questionId> goes straight to the host queue.
  steerMode = 'queued';
  store.set(key, { session, cwd: '/repo', jobId: 'task-gem-1', ownerId: 'owner-gem-1', status: 'needs_answer' });
  const answer = 'Answer q-7\nAllow once';
  const answered = await $.session.send({ to: 'Curie', text: answer });
  expect(answered).toEqual({ isDelivered: true });
  expect(steerCalls).toHaveLength(2);
  expect(hostDeliveries).toEqual([lateAnswer, answer]);

  // Native report card accepts compact Gemini report carrying unconsumedSteers, unconsumedSteersOmitted and notice.
  const compactReport = {
    status: 'completed',
    worker: 'Curie',
    jobId: 'task-gem-1',
    backend: 'antigravity',
    provider: 'Google Antigravity',
    summary: 'Completed the parser review.',
    unconsumedSteers: [{ id: 'del-1', text: 'Also check EOF handling.' }],
    unconsumedSteersOmitted: 2,
    notice: '3 mid-turn steering messages were not delivered before the Gemini turn ended; resend with SendMessage if still needed.',
    next: null,
    details: "fugato result 'task-gem-1' --details"
  };
  const card = reportMarkdown({ text: JSON.stringify(compactReport) }, { viewport: { columns: 120 } });
  expect(card?.type).toBe('Box');
  const plain = (node: any): string => typeof node === 'string' ? node : (node.children ?? []).map(plain).join('');
  expect(plain(card)).toContain('not delivered before the Gemini turn ended');
});
