"""README showcase images: Claude Code with the live pane, a worker's agent view, and the forum."""
import json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from term import Glyphs, PALETTE, draw_rows, rect, svg

ROWS = json.load(open(sys.argv[1]))
OUT = sys.argv[2]
FS, CW, LH = 12.0, 7.2, 17.0
PAD, BAR = 20.0, 30.0


def H(t, c='text', b=False, i=False):
    return {'t': t, 'c': c, 'b': b, 'i': i}


def indent(rows, n=2):
    return [[H(' ' * n)] + r if r else [] for r in rows]


def tool(desc, bullet):
    return [H('● ', bullet), H('Agent', b=True), H(f'({desc})')]


def claude(lines):
    return [[H('● ' if k == 0 else '  '), H(t)] for k, t in enumerate(lines)]


LEFT = [
    [H('> ', 'subtle'), H('Make the flaky retry test in tests/net deterministic.')],
    [H('  Have one worker trace the cause, one fix it, and a')],
    [H('  reviewer check the fix.')],
    [],
    *claude(['Running this in ultra mode: Zhang traces the flake',
             'read-only, Sohonie fixes it once the cause is known,',
             'and Noether reviews the fix.']),
    [],
    tool('Trace the retry flake', 'success'), *indent(ROWS['collapsed-zhang']['rows']), [],
    tool('Make the retry test deterministic', 'success'), *indent(ROWS['collapsed-sohonie']['rows']), [],
    *claude(['Zhang found it: a fixed 100 ms wait races up to 100 ms',
             'of jitter. I reran Sohonie\'s fix 50 times and it passes.',
             'I\'ll accept it once Noether\'s review is in.']),
    [],
    tool('Review the backoff fix', 'claude'), *indent(ROWS['collapsed-noether']['rows']),
]
LEFT_COLS, PANE_COLS, GAP = 58, 64, 3


def fit_pane(rows, n):
    """Pad or trim the blank rows above the pane's bottom rule so it is exactly n rows."""
    rule = max(k for k, r in enumerate(rows) if r and r[0]['t'].startswith('─') and k > 5)
    body, tail = rows[:rule], rows[rule:]
    while len(body) + len(tail) > n and body and not body[-1]:
        body.pop()
    while len(body) + len(tail) < n:
        body.append([])
    return body + tail


def window(theme, title, panels, width_cols, nrows, caption_rows=0):
    pal = PALETTE[theme]
    g = Glyphs(FS)
    w = PAD * 2 + width_cols * CW
    h = BAR + PAD * 1.4 + nrows * LH + PAD
    body = [rect(0.5, 0.5, w - 1, h - 1, pal['bg'], rx=10, stroke=pal['frame']),
            f'<path d="M0.5 {BAR}H{w - 0.5}" stroke="{pal["frame"]}"/>']
    body += draw_rows([[H(title, 'subtle')]], g, PAD, (BAR - LH) / 2, CW, LH, pal)
    top = BAR + PAD * 0.9
    for col, rows, opts in panels:
        x = PAD + col * CW
        for k in opts.get('bands', []):
            body.append(rect(x - 6, top + k[0] * LH - 2, opts['cols'] * CW + 12, (k[1] - k[0]) * LH + 4, pal['band'], rx=4))
        if opts.get('divider'):
            dx = x - GAP * CW / 2
            body.append(f'<path d="M{dx:.2f} {BAR}V{h - 0.5}" stroke="{pal["frame"]}"/>')
        body += draw_rows(rows, g, x, top, CW, LH, pal, opts['cols'])
    return svg(w, h, title, g.defs, body)


def save(name, text):
    with open(os.path.join(OUT, name), 'w') as f:
        f.write(text)
    print(name, len(text) // 1024, 'KB')


n = len(LEFT)
pane = fit_pane(ROWS['pane-64']['rows'], n)
for theme in ('light', 'dark'):
    save(f'fugato-showcase-live-{theme}.svg', window(theme, 'net-client — Claude Code with fugato-live',
         [(0, LEFT, {'cols': LEFT_COLS, 'bands': [(0, 3)]}), (LEFT_COLS + GAP, pane, {'cols': PANE_COLS, 'divider': True})],
         LEFT_COLS + GAP + PANE_COLS, n))
    agent = ROWS['agent-80']['rows']
    save(f'fugato-showcase-agent-{theme}.svg', window(theme, 'Sohonie — agent view', [(0, agent, {'cols': 80})], 80, len(agent)))
    forum = [r for r in ROWS['forum-64']['rows']]
    rule = max(k for k, r in enumerate(forum) if r and r[0]['t'].startswith('─'))
    while not forum[rule - 1]:
        forum.pop(rule - 1); rule -= 1
    save(f'fugato-showcase-forum-{theme}.svg', window(theme, 'fugato-live — roundtable forum', [(0, forum, {'cols': 64})], 64, len(forum)))
