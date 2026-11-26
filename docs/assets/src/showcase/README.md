# README showcase images

`build.sh` draws the screenshots and the diagram in the README as light and dark
SVG pairs in `docs/assets/`:

| File | What it is |
| --- | --- |
| `fugato-showcase-live-{light,dark}.svg` | Claude Code with three workers in the transcript and the fugato-live pane beside it |
| `fugato-showcase-agent-{light,dark}.svg` | One worker's agent view, ending in its report block |
| `fugato-showcase-forum-{light,dark}.svg` | A roundtable room in the live pane, with one post opened |
| `fugato-how-it-works-{light,dark}.svg` | Claude plans, workers run, Claude accepts, drawn as one task |

The terminal images are not mock-ups. `capture.mjs` runs the plugins' own
display code (`plugins/codex/hooks/native-agent.mjs` and the live pane's
`layout.ts` and `model.ts`) on a fixture: three workers making a flaky retry
test deterministic, and a roundtable choosing the fix. It writes the drawn rows
as JSON, and `compose.py` sets them in a window frame. Only the Claude Code
transcript around the agent rows on the left of the live image is written by
hand. When the display code changes, run the build again.

`concept.py` reuses the mark's stroke and the type of the other README art in
`../fugato/`.

## Regenerate

Requires Node.js with the repository's dev dependencies installed (`npm ci`),
Python 3 with `fontTools`, and two font families under the SIL Open Font
License 1.1:

- Cormorant Garamond, in `../fugato/fonts/` (see `../fugato/README.md`)
- JetBrains Mono Regular, Bold and Italic, in `fonts/` next to this file, or in
  a directory named by `MONO_FONTS`

```bash
curl -L -o /tmp/jbm.zip \
  https://github.com/JetBrains/JetBrainsMono/releases/download/v2.304/JetBrainsMono-2.304.zip
mkdir -p docs/assets/src/showcase/fonts
unzip -j -o /tmp/jbm.zip 'fonts/ttf/JetBrainsMono-Regular.ttf' 'fonts/ttf/JetBrainsMono-Bold.ttf' \
  'fonts/ttf/JetBrainsMono-Italic.ttf' -d docs/assets/src/showcase/fonts
docs/assets/src/showcase/build.sh
```

The `fonts/` directory is ignored by Git.
