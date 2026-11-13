// Renders Fugato's real display helpers with fixture data and writes span rows as JSON.
const [, , ROOT, LIVE, OUT] = process.argv;
const native = await import(`${ROOT}/plugins/codex/hooks/native-agent.mjs`);
const L = await import(`${LIVE}/layout.js`);
const M = await import(`${LIVE}/model.js`);
import fs from 'node:fs';

// ---- tree → rows -------------------------------------------------------
function textSpans(node, inherited = {}) {
  if (typeof node === 'string') return [{ text: node, ...inherited }];
  const props = { ...inherited, ...pick(node.props ?? {}) };
  return (node.children ?? []).flatMap(child => textSpans(child, props));
}
const pick = p => Object.fromEntries(Object.entries(p).filter(([k]) => ['color', 'bold', 'italic', 'dimColor'].includes(k)));
function treeRows(node) {
  if (!node || typeof node === 'string') return [];
  if (node.type === 'Text') return [textSpans(node)];
  const kids = node.children ?? [];
  if (node.type === 'Box' && node.props?.flexDirection !== 'column' && kids.every(k => k?.type === 'Text' || typeof k === 'string'))
    return [kids.flatMap(k => textSpans(k))];
  return kids.flatMap(treeRows);
}
const norm = rows => rows.map(r => r.filter(s => s.text !== '').map(s => ({ t: s.text, c: s.color ?? (s.dimColor ? 'subtle' : 'text'), b: !!s.bold, i: !!s.italic })));

// ---- scenario ----------------------------------------------------------
const t0 = Date.parse('2026-11-13T09:00:00.000Z'), at = s => new Date(t0 + s * 1000).toISOString();
const NOW = t0 + 505_000;
const cwd = '/Users/ada/code/net-client', home = '/Users/ada';
const out = {};

// Native agent rows --------------------------------------------------------
function agentRows(columns, view, progress, { collapsed = false } = {}) {
  const e = { viewport: { columns } };
  const ctx = { view, cwd, home };
  const entries = native.foldEntries(progress.map(native.logEntry).filter(Boolean).map(x => ({ ...x, at: (view.elapsedMs ?? 0) - 12000 })));
  const rows = [];
  rows.push(...treeRows(native.headerRow(e, view)));
  if (!collapsed) rows.push(...treeRows({ type: 'Box', props: { flexDirection: 'column' }, children: [
    { type: 'Box', props: {}, children: [{ type: 'Text', props: { color: 'claude' }, children: ['Claude › '] },
      { type: 'Text', props: { color: 'subtle', italic: true }, children: [view.brief.length > columns - 9 ? view.brief.slice(0, columns - 10) + '…' : view.brief] }] }] }), []);
  const feed = [];
  let previous;
  for (const entry of entries) {
    if (!collapsed && previous && (entry.kind === 'message') !== (previous === 'message')) feed.push([]);
    feed.push(...treeRows(native.logRows(e, entry, ctx)));
    previous = entry.kind;
  }
  if (collapsed) {
    const tail = feed.filter(r => r.length);
    if (view.status === 'running' || view.showStatus) tail.push(...treeRows(native.statusRow(e, view)));
    rows.push(...tail.slice(-3));
  } else rows.push(...feed);
  return rows;
}
const workers = {
  zhang: { name: 'Zhang', role: 'investigator', model: 'gpt-6.1-sol', effort: 'medium', sandbox: 'read-only', cwd,
    status: 'completed', elapsedMs: 112_000, pane: true, showStatus: true,
    brief: 'Find why tests/net/retry.test.ts fails about one run in twenty. Read-only.',
    progress: ['Codex: I\'ll find where the retry delay is scheduled and how the test waits for it.',
      'Bash(rg -n "setTimeout|retryDelay" src/net) · Done', 'Bash(sed -n 1,80p src/net/backoff.ts) · Done',
      'Bash(sed -n 1,60p tests/net/retry.test.ts) · Done', 'Bash(git log -3 --oneline -- src/net/backoff.ts) · Done',
      'Bash(npm test -- tests/net/retry.test.ts --repeat 40) · Error: exit 1 (38s)'] },
  sohonie: { name: 'Sohonie', role: 'implementer', model: 'gpt-6.1-sol', effort: 'xhigh', cwd,
    status: 'completed', elapsedMs: 252_000, pane: true, showStatus: true,
    brief: 'Make tests/net/retry.test.ts deterministic: inject the clock into Backoff and use a fake clock in the test.',
    progress: ['Codex: The test waits on a real 100 ms timer while Backoff adds up to 100 ms of jitter, so the two race. I\'ll inject the clock.',
      'Bash(rg -n "new Backoff" src tests) · Done', 'Bash(sed -n 1,80p src/net/backoff.ts) · Done',
      `Update(${cwd}/src/net/backoff.ts) · +14 −6`, `Update(${cwd}/tests/net/retry.test.ts) · +9 −3`,
      'Codex: Both files compile. Running the test fifty times to show the flake is gone.',
      'Bash(npm test -- tests/net/retry.test.ts --repeat 50) · Done (41s)', 'Bash(npm run typecheck) · Done (6s)'] },
  noether: { name: 'Noether', role: 'reviewer', model: 'gpt-6-astra', effort: 'xhigh', sandbox: 'read-only', cwd,
    status: 'running', elapsedMs: 125_000, pane: true,
    brief: 'Review Sohonie\'s change to src/net/backoff.ts for correctness and regressions. Read-only.',
    progress: ['Codex: I\'ll read the diff, then try to break the injected clock with a long stress run.',
      'Bash(git diff HEAD~1 -- src/net) · Done', 'Bash(rg -n "Backoff\\(" src) · Done',
      'Bash(npm test -- tests/net --repeat 20) · Done (38s)', 'Bash(node scripts/stress-retry.mjs --runs 200) · running'] },
};
// Collapsed Agent rows in the main transcript (header + last three rows).
for (const [key, w] of Object.entries(workers)) out[`collapsed-${key}`] = { rows: norm(agentRows(Number(process.env.LEFT_COLS ?? 54), w, w.progress, { collapsed: true })) };
// Full agent view of Sohonie with its report block.
const report = { status: 'completed', worker: 'Sohonie', jobId: 'task-mw3k2a-7fq1xz',
  summary: 'Backoff now takes a clock, and the retry test drives a fake one, so the delay no longer races a real timer.\n\nFifty repeated runs pass; the public Backoff API is unchanged.',
  changedFiles: ['src/net/backoff.ts', 'tests/net/retry.test.ts'],
  checks: { ran: ['npm test -- tests/net/retry.test.ts --repeat 50: exit 0', 'npm run typecheck: exit 0'], claimed: [], omitted: 0 },
  keyFindings: ['The flake came from up to 100 ms of jitter racing a fixed 100 ms wait in the test.'],
  usage: { totalTokens: 612000 }, next: 'SendMessage to Sohonie to continue', details: "fugato result 'task-mw3k2a-7fq1xz' --details" };
for (const columns of [96, 80]) {
  const w = workers.sohonie;
  const rows = agentRows(columns, w, w.progress);
  rows.push([]);
  const drawn = native.reportMarkdown({ text: JSON.stringify(report) }, { viewport: { columns } });
  rows.push(...treeRows(drawn));
  // The report finds the worker's display in a live session; this fixture has none, so add what it shows there.
  const last = rows.at(-1);
  if (last?.[0]?.text === 'done') rows[rows.length - 1] = [last[0], { text: ' · 4m 12s · 612k tokens · /fugato-live Sohonie', color: 'subtle' }];
  out[`agent-${columns}`] = { rows: norm(rows) };
}

// Live pane -----------------------------------------------------------------
const marker = (id, s) => ({ jobId: id, jobFile: `/jobs/${id}.json`, title: 'Codex Task', summary: id, createdAt: at(s), workspaceRoot: cwd });
const ev = (seq, s, type, extra) => ({ seq, at: at(s), type, ...extra });
const cmd = (seq, s, command, exitCode, durationMs) => ev(seq, s, 'commandExecution', { command: `/bin/zsh -lc ${JSON.stringify(command)}`,
  lifecycle: exitCode === undefined ? 'started' : 'completed', ...(exitCode === undefined ? {} : { exitCode, durationMs }) });
const job = (id, name, agentType, model, effort, start, end, status, prompt, activity, usage) => M.jobView({
  id, status, agentName: name, startedAt: at(start), ...(end ? { completedAt: at(end) } : {}),
  request: { agentType, model, effort, cwd, prompt, report: true }, activity,
  ...(usage ? { usage: { inputTokens: usage, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: usage } } : {}),
}, marker(id, start), true, NOW);
const jobs = [
  job('job-z', 'Zhang', 'fugato:codex-investigator', 'gpt-6.1-sol', 'medium', 0, 112, 'completed', workers.zhang.brief, [
    ev(1, 4, 'agentMessage', { body: 'I\'ll find where the retry delay is scheduled and how the test waits for it.' }),
    cmd(2, 8, 'rg -n "setTimeout|retryDelay" src/net', 0, 200), cmd(3, 12, 'sed -n 1,80p src/net/backoff.ts', 0, 100),
    cmd(4, 30, 'npm test -- tests/net/retry.test.ts --repeat 40', 1, 38000),
    ev(5, 110, 'agentMessage', { body: '[completed] The test waits a fixed 100 ms while Backoff adds up to 100 ms of jitter.' }),
  ], 184000),
  job('job-s', 'Sohonie', 'fugato:codex-implementer', 'gpt-6.1-sol', 'xhigh', 120, 372, 'completed', workers.sohonie.brief, [
    ev(1, 124, 'agentMessage', { body: 'I\'ll inject the clock into Backoff and drive a fake clock from the test.' }),
    ev(2, 180, 'fileChange', { path: `${cwd}/src/net/backoff.ts`, added: 14, removed: 6, status: 'completed' }),
    ev(3, 200, 'fileChange', { path: `${cwd}/tests/net/retry.test.ts`, added: 9, removed: 3, status: 'completed' }),
    cmd(4, 260, 'npm test -- tests/net/retry.test.ts --repeat 50', 0, 41000),
  ], 612000),
  job('job-n', 'Noether', 'fugato:codex-reviewer', 'gpt-6-astra', 'xhigh', 380, null, 'running', workers.noether.brief, [
    ev(1, 384, 'agentMessage', { body: 'I\'ll read the diff, then try to break the injected clock with a long stress run.' }),
    cmd(2, 390, 'git diff HEAD~1 -- src/net', 0, 300), cmd(3, 396, 'rg -n "Backoff\\(" src', 0, 200),
    cmd(4, 410, 'npm test -- tests/net --repeat 20', 0, 38000),
    ev(5, 470, 'agentMessage', { body: 'The clock is injected everywhere Backoff is built. Twenty runs pass; now a 200-run stress pass.' }),
    cmd(6, 493, 'node scripts/stress-retry.mjs --runs 200', undefined),
  ], 341000),
];
function pane(columns, rows, selectedId, extraState = {}, rooms = []) {
  const state = { jobs, forumRooms: rooms, selectedId, nowMs: NOW, usageByJob: {}, ...extraState };
  const norm2 = M.normalizeSessions(state);
  const sessions = M.visibleSessions(norm2);
  const entries = [...rooms, ...sessions];
  const lines = [L.listTitle(norm2, columns)];
  for (const entry of entries) lines.push(L.tableRow(entry, ('roomId' in entry ? `forum:${entry.roomId}` : entry.id) === selectedId, columns, norm2, entries));
  const selected = rooms.find(r => `forum:${r.roomId}` === selectedId) ?? sessions.find(s => s.id === selectedId);
  const layout = L.paneLayout(norm2, selected, rows, false, columns);
  if (layout.header.clear) lines.push([{ text: 'Clear finished', color: 'subtle' }]);
  lines.push([{ text: '─'.repeat(columns), color: 'subtle' }]);
  lines.push(...layout.top);
  const view = norm2.feeds?.[selectedId];
  const feed = L.feedLines(selected, NOW, columns, view).map(line => line.spans);
  const body = rows - lines.length - 2;
  lines.push(...feed.slice(Math.max(0, feed.length - body)));
  while (lines.length < rows - 2) lines.push([]);
  lines.push([{ text: '─'.repeat(columns), color: 'subtle' }]);
  const f = L.footerLayout(selected, norm2, columns, true, 0);
  lines.push(f.toggle !== undefined ? [...f.leftSpans, { text: f.toggleGap }, { text: f.toggle, color: 'suggestion' }] : [...f.leftSpans, { text: f.gap }, { text: f.right, color: 'subtle' }]);
  return lines;
}
out['pane-64'] = { rows: norm(pane(64, 30, 'job-n')) };
out['pane-58'] = { rows: norm(pane(58, 30, 'job-n')) };

// Forum ----------------------------------------------------------------------
const post = (seq, s, kind, author, title, body, extra = {}) => ({ seq, at: at(s), kind, title, body,
  author: author === 'chair' ? { kind: 'chair', name: 'chair' } : { kind: 'member', name: author },
  thread: extra.thread ?? seq, replyTo: extra.replyTo ?? null, label: extra.label ?? '', refs: extra.refs ?? [], mentions: extra.mentions ?? [] });
const posts = [
  post(1, 20, 'finding', 'critic', 'Jitter can exceed the test\'s wait', 'Backoff adds up to 100 ms of jitter; the test waits a fixed 100 ms.', { label: 'observed' }),
  post(2, 60, 'idea', 'conjecturer', 'Inject the clock', 'Pass a clock to Backoff and drive it from the test.'),
  post(3, 140, 'candidate', 'improver', 'Clock injection with a default', 'Backoff(options, clock = systemClock). The test passes a fake clock and advances it past the maximum delay.\nNo call site changes; the public API stays the same.', { replyTo: 2, thread: 2, refs: ['src/net/backoff.ts', 'tests/net/retry.test.ts'] }),
  post(4, 220, 'finding', 'critic', 'Fifty runs pass with the candidate', 'Repeated the suite fifty times with the candidate applied; no failures.', { replyTo: 3, thread: 2, label: 'observed' }),
  post(5, 260, 'question', 'steward', 'Keep jitter in production?', 'Removing jitter would also fix the test, but it changes behaviour under load.', { mentions: ['chair'] }),
  post(6, 330, 'decision', 'chair', 'Accept the clock injection', 'Accept the improver\'s candidate; keep jitter in production.', { replyTo: 3, thread: 2 }),
];
const room = { roomId: 'rt-mw3k9q-4c1e0a2b', sessionId: 's', goal: 'Choose how to make the retry test deterministic', status: 'open',
  intensity: 'standard', members: ['conjecturer', 'critic', 'improver', 'steward'], createdAt: at(10), postCount: posts.length, posts,
  timeline: posts.map(p => (p.kind === 'decision' ? -1 : 1) * Date.parse(p.at)) };
const forumState = { feeds: { [`forum:${room.roomId}`]: { feedOffset: 0, following: true, seenLines: 0, expandedPromptIds: ['post:3'] } } };
out['forum-64'] = { rows: norm(pane(64, 34, `forum:${room.roomId}`, forumState, [room])) };

fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
if (process.env.SHOW_ROWS) for (const [k, v] of Object.entries(out)) {
  console.log(`----- ${k}`);
  for (const r of v.rows) console.log(r.map(s => s.t).join(''));
}
