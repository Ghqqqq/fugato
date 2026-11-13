"""How it works, drawn literally: Claude plans criteria and briefs, Codex workers run, Claude accepts on evidence."""
import os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.environ.get('ART_DIR', os.path.join(HERE, '..', 'fugato'))); sys.path.insert(0, HERE)
from art import INK, Glyphs as SerifGlyphs, layout, load, stroke, svg
import term

OUT = sys.argv[1]
ITALIC_SEMI = load('CormorantGaramond-Italic.ttf', {'wght': 600})
ITALIC = load('CormorantGaramond-Italic.ttf', {'wght': 500})
ROMAN = load('CormorantGaramond.ttf', {'wght': 500})
PAL = {
    'light': dict(ink='#202725', muted='#5F6E66', hair='#B9C3BD', claude='#C0613D', ok='#2F8445', canvas='#FFFFFF',
                  lanes=['#202725', '#3B4942', '#536D62']),
    'dark': dict(ink='#F5F3EC', muted='#9CAC9F', hair='#46524C', claude='#D9805F', ok='#7CC08A', canvas='#0D1117',
                 lanes=['#F5F3EC', '#C5CDC3', '#9CAC9F']),
}
MONO = 21


class Page:
    def __init__(self, theme):
        self.p, self.parts = PAL[theme], []
        self.serif, self.mono = SerifGlyphs(), term.Glyphs(MONO)

    def add(self, s):
        self.parts.append(s)

    def text(self, s, size, x, y, font=ROMAN, color=None, anchor='start'):
        w = layout(font, s, size)[1]
        x -= w if anchor == 'end' else w / 2 if anchor == 'middle' else 0
        self.add(self.serif.use(font, s, size, x, y, color or self.p['ink'])[0])
        return x + w

    def code(self, spans, x, y):
        """Monospace spans [(text, colour, bold)] with their baseline at y; returns the end x."""
        g, cw = self.mono, MONO * 0.6
        col = 0
        for t, c, b in spans:
            for ch in t:
                if ch != ' ':
                    gid = g.ref(ch, b, False)
                    if gid:
                        self.add(f'<use href="#{gid}" x="{x + col * cw:.1f}" y="{y:.1f}" fill="{c}"/>')
                col += 1
        return x + col * cw

    def line(self, x1, y1, x2, y2, color=None, width=1.6, dash=None):
        da = f' stroke-dasharray="{dash}"' if dash else ''
        self.add(f'<path d="M{x1:.1f} {y1:.1f}L{x2:.1f} {y2:.1f}" stroke="{color or self.p["hair"]}" stroke-width="{width}" stroke-linecap="round"{da}/>')

    def arrow(self, x1, x2, y, label=None):
        self.line(x1, y, x2 - 2, y, self.p['muted'], 1.6)
        self.add(f'<path d="M{x2 - 11:.1f} {y - 5.5:.1f}L{x2:.1f} {y:.1f}L{x2 - 11:.1f} {y + 5.5:.1f}" stroke="{self.p["muted"]}" '
                 f'stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>')
        if label:
            self.text(label, 24, (x1 + x2) / 2, y - 12, ITALIC, self.p['muted'], 'middle')

    def box(self, x, y, color):
        self.add(f'<rect x="{x:.1f}" y="{y - 17:.1f}" width="17" height="17" rx="2.5" fill="none" stroke="{color}" stroke-width="2"/>')

    def tick(self, x, y, color):
        self.add(f'<path d="M{x + 1:.1f} {y - 8:.1f}L{x + 7:.1f} {y - 2:.1f}L{x + 18:.1f} {y - 17:.1f}" stroke="{color}" '
                 f'stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>')

    def svg(self, w, h, title):
        # Two glyph sets share one <defs>; give the monospace ids their own prefix.
        mono_defs = ''.join(d.replace('id="g', 'id="m') for d in self.mono.defs)
        body = ''.join(p.replace('href="#g', 'href="#m') if p.startswith('<use href="#g') and ' x="' in p else p for p in self.parts)
        return svg(w, h, f'<defs>{"".join(self.serif.defs)}{mono_defs}</defs>' + body, title)


def concept(theme):
    pg = Page(theme)
    p = pg.p
    A, B, C = 0, 560, 1190
    pg.text('Claude plans', 46, A, 52, ITALIC_SEMI)
    pg.text('Codex works', 46, B, 52, ITALIC_SEMI)
    pg.text('Claude accepts', 46, C, 52, ITALIC_SEMI)
    pg.text('acceptance criteria and one brief per worker', 25, A, 92, ROMAN, p['muted'])
    pg.text('each worker on its own Codex thread', 25, B, 92, ROMAN, p['muted'])
    pg.text('evidence first, then a verdict', 25, C, 92, ROMAN, p['muted'])
    rows = [
        ('the cause of the flake is found', 'Zhang', 'investigator', 0, 250,
         ('accepted', 'cause confirmed'), 'done'),
        ('the retry test passes 50 runs', 'Sohonie', 'implementer', 120, 400,
         ('accepted', 'reran the 50 runs'), 'done'),
        ('a reviewer finds no regression', 'Noether', 'reviewer', 240, 560,
         ('waiting', 'for the review'), 'running'),
    ]
    for k, (criterion, name, role, start, end, verdict, state) in enumerate(rows):
        y = 175 + k * 92
        # Claude plans: a criterion and the brief that carries it.
        pg.box(A, y, p['claude'])
        pg.text(criterion, 29, A + 30, y, ROMAN)
        # Codex works: the worker enters after the one before it, like the mark's voices.
        x0 = B + start
        pg.arrow(A + 452, x0 - 12, y - 7, 'brief' if k == 0 else None)
        nx = pg.code([(name, p['ink'], True)], x0, y)
        lane_end = B + end
        tone = p['lanes'][k]
        d = stroke(nx + 16, y - 7, nx + 16 + (lane_end - nx - 16) * 0.55, 9, lane_end, 18)
        pg.add(f'<path d="{d}" stroke="{tone}" stroke-width="3.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>')
        if state == 'running':
            pg.line(lane_end + 10, y - 16, B + 610, y - 16, p['claude'], 3.2, '2 9')
            pg.add(f'<circle cx="{lane_end:.1f}" cy="{y - 16:.1f}" r="6.5" fill="{p["canvas"]}" stroke="{p["claude"]}" stroke-width="2.6"/>')
        else:
            pg.add(f'<circle cx="{lane_end:.1f}" cy="{y - 16:.1f}" r="6.5" fill="{tone}"/>')
            pg.arrow(lane_end + 14, C - 14, y - 16, 'report' if k == 0 else None)
        pg.code([(role, p['muted'], False)], nx + 16, y + 26)
        # Claude accepts.
        vy = y - 7
        if state == 'running':
            pg.add(f'<circle cx="{C + 9:.1f}" cy="{vy - 8.5:.1f}" r="7.5" fill="none" stroke="{p["claude"]}" stroke-width="2.4"/>')
        else:
            pg.tick(C, vy, p['ok'])
        e = pg.text(verdict[0], 29, C + 30, vy, ROMAN)
        pg.text(' · ' + verdict[1], 25, e, vy, ROMAN, p['muted'])
    return pg.svg(1600, 420, 'How Fugato works: Claude writes criteria and briefs, Codex workers run on their own threads, Claude accepts on evidence')


for theme in ('light', 'dark'):
    with open(os.path.join(OUT, f'fugato-how-it-works-{theme}.svg'), 'w') as f:
        f.write(concept(theme))
print('ok')
