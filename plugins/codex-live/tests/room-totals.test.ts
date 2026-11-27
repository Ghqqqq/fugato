import { test, expect, mock } from 'claude-code/testing';
import type { EngineInterface, On, PaneOpenArgs } from 'claude-code';
import { createPoller } from '../hooks/poll';
import { footerLayout, paneLayout, roomTotals, width } from '../hooks/layout';
import { validView } from '../hooks/model';
import type { CodexLiveState, ForumRoom } from '../types';

const epoch = Date.parse('2026-10-18T00:00:00.000Z');
const created = (ms: number) => new Date(ms).toISOString();
const start = { cwd: '/workspace', surface: 'terminal' as const, isInteractive: true };

function guardedRoomPoller() {
  const files = new Map<string, { text: string; mtime: number }>();
  const forbidden: string[] = [];
  let now = epoch;
  let open = true;
  let version = 0;
  let state: CodexLiveState = { jobs: [], selectedId: null, nowMs: 0 };

  const engine = {
    ui: {
      panes: async () => open ? [{ id: 'fugato-live', isFocused: false }] : [],
      open: async () => { open = true; return { isPlaced: true }; },
      status: () => {},
      log: () => {},
      invalidate: () => {},
      scroll: async () => ({}),
    },
    session: { id: async () => 'session-a' },
    env: { get: async (name: string) => name === 'CODEX_COMPANION_HOME' ? '/home' : undefined },
    clock: { now: async () => now },
    fs: {
      exists: async () => true,
      list: async (path: string) => {
        const prefix = `${path}/`;
        const names = [...new Set([...files.keys()].filter(file => file.startsWith(prefix))
          .map(file => file.slice(prefix.length).split('/')[0]!))];
        return names.map(name => ({
          name,
          kind: files.has(`${prefix}${name}`) ? 'file' as const : 'dir' as const,
          size: files.get(`${prefix}${name}`)?.text.length ?? 0,
          mtimeMs: files.get(`${prefix}${name}`)?.mtime ?? 1,
          isLink: false,
        }));
      },
      read: async (path: string) => files.get(path)!.text,
      stat: async (path: string) => {
        const file = files.get(path);
        if (file) return { kind: 'file' as const, size: file.text.length, mtimeMs: file.mtime, isLink: false, realPath: path };
        return { kind: 'dir' as const, size: 0, mtimeMs: 1, isLink: false, realPath: path };
      },
    },
    state: {
      get: async () => ({ value: state, version }),
      set: async (_ref: unknown, value: CodexLiveState) => { state = value; return { isSet: true, version: ++version }; },
    },
  };

  const guard = <T extends object>(value: T, prefix: string): T => new Proxy(value, {
    get(target, key, receiver) {
      if (!(key in target)) {
        forbidden.push(`${prefix}.${String(key)}`);
        throw new Error(`Forbidden engine capability: ${prefix}.${String(key)}`);
      }
      return Reflect.get(target, key, receiver);
    },
  });
  engine.fs = guard(engine.fs, 'fs');
  engine.ui = guard(engine.ui, 'ui');
  engine.session = guard(engine.session, 'session');
  const poller = createPoller(guard(engine, 'engine') as unknown as EngineInterface);

  function addJob(id: string, data: Record<string, unknown>, offsetSec = 0) {
    const createdAt = created(epoch + offsetSec * 1000);
    files.set(`/home/duet/sessions/session-a/${id}.json`, {
      mtime: 1,
      text: JSON.stringify({ v: 1, jobId: id, jobFile: `/jobs/${id}.json`, summary: `Task ${id}`, title: 'Worker', createdAt }),
    });
    files.set(`/jobs/${id}.json`, {
      mtime: 1,
      text: JSON.stringify({ id, sessionId: 'session-a', status: 'completed', createdAt, startedAt: createdAt, completedAt: createdAt, ...data }),
    });
  }

  function setRoom(id: string, members: { name: string; persona: string; jobIds?: string[] }[], posts = 3) {
    files.set(`/home/duet/roundtables/${id}/room.json`, {
      mtime: 1,
      text: JSON.stringify({
        roomId: id, sessionId: 'session-a', status: 'open', goal: 'Audit observability totals',
        intensity: 'standard', createdAt: created(epoch), nextSeq: posts + 1, members,
      }),
    });
    files.set(`/home/duet/roundtables/${id}/events.jsonl`, { mtime: 1, text: '' });
  }

  return {
    addJob, setRoom, forbidden,
    poll: async () => { await poller(true); expect(forbidden).toEqual([]); },
    latest: () => state,
    advance: (ms: number) => { now += ms; },
  };
}

test('poller aggregates room approval and token totals without CLI spawns and respects expiry and eviction', async () => {
  const f = guardedRoomPoller();
  f.addJob('job-c1', {
    request: { backend: 'antigravity', model: 'gemini-4-neon' },
    approvalTotals: { answered: 25, denied: 2, autoAllowed: 4, autoDenied: 0 },
    questionHistory: Array.from({ length: 20 }, (_, i) => ({ id: `a-${i}`, kind: 'action-approval', answer: 'Allow once', resolution: 'answered' })),
    result: { usage: { inputTokens: 100000, outputTokens: 20000, totalTokens: 120000 } },
  }, -30);
  f.addJob('job-c2', {
    status: 'running', completedAt: undefined,
    request: { backend: 'antigravity', model: 'gemini-4-neon' },
    pendingQuestion: { id: 'q-live', kind: 'action-approval', text: 'Run tests', options: ['Allow once', 'Deny'], expiresAt: epoch + 60_000 },
    approvalTotals: { answered: 15, denied: 1, autoAllowed: 0, autoDenied: 0 },
    result: { usage: { inputTokens: 32000, outputTokens: 8000, totalTokens: 40000 } },
  }, -10);
  // Legacy job without approvalTotals falls back to questionHistory.
  f.addJob('job-i1', {
    request: { model: 'gpt-6.2-sol' },
    questionHistory: [
      { id: 'l1', kind: 'action-approval', answer: 'Allow once', resolution: 'answered' },
      { id: 'l2', kind: 'action-approval', answer: 'Deny', resolution: 'answered' },
      { id: 'l3', kind: 'action-approval', answer: null, resolution: 'timeout' },
      { id: 'q1', kind: 'question', answer: 'Branch A', resolution: 'answered' },
    ],
    result: { usage: { inputTokens: 20000, outputTokens: 4000, totalTokens: 24000 } },
  }, -20);
  // Unrelated job outside the room must never affect room totals.
  f.addJob('job-unrelated', {
    request: { model: 'gpt-6-astra' },
    approvalTotals: { answered: 99, denied: 0, autoAllowed: 0, autoDenied: 0 },
    result: { usage: { inputTokens: 400000, outputTokens: 100000, totalTokens: 500000 } },
  }, -5);

  f.setRoom('rt-a-totals', [
    { name: 'conjecturer', persona: 'conjecturer', jobIds: [] },
    { name: 'critic', persona: 'critic', jobIds: ['job-c1', 'job-c2'] },
    { name: 'improver', persona: 'improver', jobIds: ['job-i1'] },
  ]);

  await f.poll();
  const state = f.latest();
  expect(validView(state)).toBe(true);
  expect(f.forbidden).toEqual([]);

  const room = state.forumRooms?.find(r => r.roomId === 'rt-a-totals')!;
  expect(room).toBeDefined();
  expect(room.memberJobIds).toEqual({ critic: ['job-c1', 'job-c2'], improver: ['job-i1'] });
  expect(roomTotals(room, state)).toEqual({
    pending: 1, answered: 42, totalTokens: 184000, partialTokens: false, hasJobs: true,
  });

  // 60- and 80-column room headers and footers display totals without overflowing.
  const spanText = (spans: { text: string }[]) => spans.map(span => span.text).join('');
  for (const columns of [60, 80]) {
    const layout = paneLayout({ ...state, selectedId: 'forum:rt-a-totals' }, room, 20, false, columns);
    expect(layout.top.length).toBe(2);
    const header0 = spanText(layout.top[0]!);
    const header1 = spanText(layout.top[1]!);
    expect(width(header0) <= columns).toBe(true);
    expect(width(header1) <= columns).toBe(true);
    expect(header1).toContain('appr 1p/42a · 184k tok');

    for (const following of [true, false]) {
      const footer = footerLayout(room, state, columns, following, 2);
      const totalWidth = width(footer.left + (footer.toggleGap ?? '') + (footer.toggle ?? '') + footer.gap + footer.right + footer.jump)
        + (!following ? Math.min(3, Math.max(0, columns - width(footer.toggle ?? '') - width(footer.toggleGap ?? ''))) : 0);
      expect(totalWidth <= columns).toBe(true);
      if (following) expect(footer.right).toBe('184k tok');
    }
  }

  // Sweeping narrow-to-wide columns never overflows even with 6 seated members.
  const crowdedRoom: ForumRoom = {
    ...room,
    members: ['conjecturer', 'critic', 'improver', 'integrator', 'steward', 'calibrator'],
  };
  for (let columns = 0; columns <= 100; columns++) {
    const layout = paneLayout({ ...state, selectedId: 'forum:rt-a-totals' }, crowdedRoom, 20, false, columns);
    for (const row of layout.top) expect(width(spanText(row)) <= columns).toBe(true);
  }

  // Advancing past pending approval expiry drops pending from 1p to 0p.
  f.advance(60_000);
  await f.poll();
  const expiredState = f.latest();
  const expiredRoom = expiredState.forumRooms!.find(r => r.roomId === 'rt-a-totals')!;
  expect(roomTotals(expiredRoom, expiredState)).toEqual({
    pending: 0, answered: 42, totalTokens: 184000, partialTokens: false, hasJobs: true,
  });
  const expiredHeader = spanText(paneLayout(expiredState, expiredRoom, 20, false, 60).top[1]!);
  expect(expiredHeader).toContain('appr 0p/42a · 184k tok');

  // Evicted finished room jobs retain their totals via approvalsByJob and usageByJob.
  for (let i = 0; i < 24; i++) {
    f.addJob(`filler-${i}`, { request: { model: 'gpt-6-astra' } }, i + 1);
  }
  await f.poll();
  const evictedState = f.latest();
  expect(evictedState.jobs.some(job => job.id === 'job-c1')).toBe(false);
  const evictedRoom = evictedState.forumRooms!.find(r => r.roomId === 'rt-a-totals')!;
  expect(roomTotals(evictedRoom, evictedState)).toEqual({
    pending: 0, answered: 42, totalTokens: 184000, partialTokens: false, hasJobs: true,
  });
});

test('mounted fugato-live pane renders polled room totals in 60- and 80-column headers with zero process calls', async ($, on: On) => {
  const clock = mock.clock(on, { now: epoch });
  mock.env(on, { HOME: '/user', CODEX_COMPANION_HOME: '/isolated' });
  const files = new Map<string, { text: string; mtime: number }>();
  let processCalls = 0;
  let open = false;
  const opens: PaneOpenArgs[] = [];

  on('session.start', (_$, e) => ({ cwd: e.cwd }));
  on('session.id', () => ({ value: 'session-a' }));
  on('command.register', (_$, e) => ({ value: { command: e.name } }));
  on('ui.panes', () => ({ value: open ? [{ id: 'fugato-live', title: 'Fugato', isShown: true, isFocused: false, isPlaced: true }] : [] }));
  on('ui.open', (_$, e) => { opens.push(e); open = true; return { value: { isPlaced: true } }; });
  on('ui.status', () => ({ value: undefined }));
  on('process.run', () => { processCalls++; return { deny: 'CLI spawns are forbidden in fugato-live' }; });
  on('process.spawn', async function* () { processCalls++; return { deny: 'CLI spawns are forbidden in fugato-live' }; });
  on('fs.exists', () => ({ value: true }));
  on('fs.stat', (_$, e) => {
    if (e.path === '/isolated') return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: '/isolated' } };
    const file = files.get(e.path);
    return file ? { value: { kind: 'file', size: file.text.length, mtimeMs: file.mtime, isLink: false } }
      : { deny: 'ENOENT: no such file or directory' };
  });
  on('fs.list', (_$, e) => {
    const prefix = `${e.path}/`;
    const names = [...new Set([...files.keys()].filter(path => path.startsWith(prefix))
      .map(path => path.slice(prefix.length).split('/')[0]!))];
    return {
      value: names.map(name => ({
        name,
        kind: files.has(`${prefix}${name}`) ? 'file' as const : 'dir' as const,
        size: 1,
        mtimeMs: 1,
        isLink: false,
      })),
    };
  });
  on('fs.read', (_$, e) => {
    const file = files.get(e.path);
    return file ? { value: file.text } : { deny: 'ENOENT' };
  });

  files.set('/isolated/duet/sessions/session-a/rt-j1.json', {
    mtime: 1,
    text: JSON.stringify({ v: 1, jobId: 'rt-j1', jobFile: '/jobs/rt-j1.json', summary: 'Critic audit', title: 'Gemini Task', createdAt: created(epoch) }),
  });
  files.set('/jobs/rt-j1.json', {
    mtime: 1,
    text: JSON.stringify({
      id: 'rt-j1', sessionId: 'session-a', status: 'running', createdAt: created(epoch), startedAt: created(epoch),
      request: { backend: 'antigravity', model: 'gemini-4-neon' },
      pendingQuestion: { id: 'q-1', kind: 'action-approval', text: 'Run test', options: ['Allow once', 'Deny'], expiresAt: epoch + 60_000 },
      approvalTotals: { answered: 42, denied: 3, autoAllowed: 8, autoDenied: 0 },
      result: { usage: { inputTokens: 150000, outputTokens: 34000, totalTokens: 184000 } },
    }),
  });
  files.set('/isolated/duet/roundtables/rt-a-live/room.json', {
    mtime: 1,
    text: JSON.stringify({
      roomId: 'rt-a-live', sessionId: 'session-a', status: 'open', goal: 'Review U7 changes',
      intensity: 'standard', createdAt: created(epoch), nextSeq: 2,
      members: [
        { name: 'conjecturer', persona: 'conjecturer', jobIds: [] },
        { name: 'critic', persona: 'critic', jobIds: ['rt-j1'] },
      ],
    }),
  });
  files.set('/isolated/duet/roundtables/rt-a-live/events.jsonl', { mtime: 1, text: '' });

  await $.session.start(start);
  await clock.advance(1000);

  for (const bodyColumns of [60, 80]) {
    const ui = await $.ui.mount({
      plugin: 'fugato-live',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'fugato-live',
      props: { title: 'Fugato', isFocused: true, bodyColumns, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 20 }, view: {} },
    });
    if (bodyColumns === 60) await ui.press({ key: 'forum:rt-a-live' });
    const header0 = (await ui.find({ key: 'forum-pinned-0' }))?.text ?? '';
    const header1 = (await ui.find({ key: 'forum-pinned-1' }))?.text ?? '';
    expect(width(header0) <= bodyColumns).toBe(true);
    expect(width(header1) <= bodyColumns).toBe(true);
    expect(header1).toContain('conjecturer · critic');
    expect(header1).toContain('appr 1p/42a · 184k tok');
    await ui.unmount();
  }
  expect(processCalls).toBe(0);
});
