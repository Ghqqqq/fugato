"""Terminal captures as SVG: span rows from capture.mjs, text set as JetBrains Mono outlines."""
import json, os, sys, unicodedata
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

FONTS = os.environ.get('MONO_FONTS', os.path.join(os.path.dirname(__file__), 'fonts'))
FACES = {(False, False): 'JetBrainsMono-Regular.ttf', (True, False): 'JetBrainsMono-Bold.ttf',
         (False, True): 'JetBrainsMono-Italic.ttf', (True, True): 'JetBrainsMono-Italic.ttf'}
_fonts = {}


def font(bold, italic):
    key = FACES[(bold, italic)]
    if key not in _fonts:
        _fonts[key] = TTFont(os.path.join(FONTS, key))
    return _fonts[key]


# Theme keys → colours. Dark is a deep ink green, light a warm paper, both from the brand mark's tones.
PALETTE = {
    'dark': dict(bg='#171B19', frame='#2C3430', bar='#1D2220', text='#E9E6DD', subtle='#8A958E', inactive='#56615B',
                 claude='#D9805F', success='#7CC08A', error='#EE7F86', warning='#E2B45A', suggestion='#A7B2EE',
                 diffAdded='#7CC08A', diffRemoved='#EE7F86', band='#222926', caption='#9CAC9F'),
    'light': dict(bg='#FBFAF6', frame='#D9D6CC', bar='#F3F1EA', text='#202725', subtle='#6E7A73', inactive='#A6ADA8',
                  claude='#C0613D', success='#2F8445', error='#C23B4A', warning='#9A6B0C', suggestion='#4B57B8',
                  diffAdded='#2F8445', diffRemoved='#C23B4A', band='#EFEDE5', caption='#536D62'),
}


class Glyphs:
    """Outline defs shared by one SVG; each (face, char) becomes a <path id> placed with <use>."""

    def __init__(self, size):
        self.size, self.defs, self.ids = size, [], {}

    def ref(self, ch, bold, italic):
        key = (ch, bold, italic)
        if key in self.ids:
            return self.ids[key]
        f = font(bold, italic)
        name = f.getBestCmap().get(ord(ch))
        s = self.size / f['head'].unitsPerEm
        gid = f'g{len(self.ids)}'
        if name is None:
            d = self.fallback(ch)
        else:
            pen = SVGPathPen(f.getGlyphSet())
            f.getGlyphSet()[name].draw(TransformPen(pen, (s, 0, 0, -s, 0, 0)))
            d = pen.getCommands()
        self.ids[key] = gid if d else None
        if d:
            self.defs.append(f'<path id="{gid}" d="{d}"/>')
        return self.ids[key]

    def fallback(self, ch):
        w, h = self.size * 0.6, self.size
        if ch == '↳':  # down then right, with an arrowhead
            x0, y0, y1, x1 = w * 0.28, -h * 0.66, -h * 0.28, w * 0.86
            t = h * 0.07
            return (f'M{x0 - t / 2:.2f} {y0:.2f}H{x0 + t / 2:.2f}V{y1 - t / 2:.2f}H{x1 - h * 0.12:.2f}V{y1 - h * 0.14:.2f}'
                    f'L{x1:.2f} {y1:.2f}L{x1 - h * 0.12:.2f} {y1 + h * 0.14:.2f}V{y1 + t / 2:.2f}H{x0 - t / 2:.2f}Z')
        return ''


def cells(ch):
    return 2 if unicodedata.east_asian_width(ch) in 'WF' else 1


def draw_rows(rows, g, x, y, cw, lh, pal, max_cols=None):
    """Draw span rows at (x, y) (y = top of first row). Returns svg fragments."""
    out = []
    base = lh * 0.74
    for r, row in enumerate(rows):
        col = 0
        by = y + r * lh + base
        for span in row:
            colour = pal.get(span['c'], pal['text'])
            for ch in span['t']:
                if max_cols is not None and col >= max_cols:
                    break
                if ch != ' ':
                    gid = g.ref(ch, span['b'] or ch == '❯', span['i'])
                    if gid:
                        out.append(f'<use href="#{gid}" x="{x + col * cw:.2f}" y="{by:.2f}" fill="{colour}"/>')
                col += cells(ch)
    return out


def rect(x, y, w, h, fill, rx=0, stroke=None):
    s = f' stroke="{stroke}"' if stroke else ''
    return f'<rect x="{x:.2f}" y="{y:.2f}" width="{w:.2f}" height="{h:.2f}" rx="{rx}" fill="{fill}"{s}/>'


def svg(w, h, title, defs, body):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:.0f} {h:.0f}" width="{w:.0f}" height="{h:.0f}">'
            f'<title>{title}</title><defs>{"".join(defs)}</defs>{"".join(body)}</svg>\n')
