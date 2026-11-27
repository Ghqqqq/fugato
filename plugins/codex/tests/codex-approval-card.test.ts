import { test, expect } from 'claude-code/testing';
import { reportMarkdown } from '../hooks/native-agent.mjs';

test('Codex action-approval cards longer than 600 chars render verbatim with newlines preserved', () => {
  const text = [
    'Codex file-change approval. Cwd: "/work/repo"',
    '',
    'Files/diff:',
    '  --- a/src/example.mjs',
    '  +++ b/src/example.mjs',
    '  @@ -1,4 +1,6 @@',
    '    ' + 'changed line  '.repeat(60),
    '  TAIL_LINE: `**verbatim  end**`',
  ].join('\n');
  expect(text.length > 600).toBe(true);
  expect(text.includes('\n\n')).toBe(true);

  const report = {
    status: 'needs_answer',
    jobId: 'task-codex-approval',
    worker: 'Ada',
    summary: 'Permission requested.',
    details: "fugato result 'task-codex-approval' --details",
    next: 'SendMessage to Ada: "Answer q-codex\nAllow once" (or Deny)',
    question: { id: 'q-codex', kind: 'action-approval', text, options: ['Allow once', 'Deny'] },
  };
  const leaves = (node: any): string[] => typeof node === 'string' ? [node] : (node.children ?? []).flatMap(leaves);
  const nodes = (node: any): any[] => typeof node === 'string' ? [] : [node, ...(node.children ?? []).flatMap(nodes)];

  for (const columns of [32, 60, 120]) {
    const card = reportMarkdown({ text: JSON.stringify(report) }, { viewport: { columns } });
    expect(card).not.toBe(null);
    const content = leaves(card);
    expect(content).toContain(text);
    expect(content.indexOf('1. Allow once  2. Deny') > content.indexOf(text)).toBe(true);
    const textNode = nodes(card).find(node => node.children?.[0] === text);
    expect(textNode?.props).toMatchObject({ color: 'warning', wrap: 'wrap' });
  }

  // Ordinary non-approval Codex questions still collapse/clip through plain().
  const ordinary = {
    ...report,
    question: { id: 'q-ordinary', kind: 'question', text, options: ['A', 'B'] },
  };
  const ordinaryCard = reportMarkdown({ text: JSON.stringify(ordinary) }, { viewport: { columns: 80 } });
  const ordinaryText = leaves(ordinaryCard).join('');
  expect(ordinaryText).not.toContain('TAIL_LINE');
  expect(ordinaryText).toContain('…');
});
