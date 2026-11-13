#!/bin/sh
# Regenerate the README showcase images in docs/assets from Fugato's own display code.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../../.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# The live pane's display helpers are TypeScript; compile the ones the captures import.
"$ROOT/node_modules/.bin/tsc" --outDir "$TMP/live" --module ESNext --target ES2022 \
  --moduleResolution bundler --skipLibCheck --noCheck \
  "$ROOT/plugins/codex-live/hooks/layout.ts" "$ROOT/plugins/codex-live/hooks/model.ts" \
  "$ROOT/plugins/codex-live/hooks/command.ts" "$ROOT/plugins/codex-live/hooks/forum.ts" \
  "$ROOT/plugins/codex-live/hooks/text.ts"
for f in "$TMP"/live/*.js; do
  sed -E "s#from '\./([a-z]+)'#from './\1.js'#g" "$f" > "$f.tmp" && mv "$f.tmp" "$f"
done

node "$HERE/capture.mjs" "$ROOT" "$TMP/live" "$TMP/rows.json"
python3 "$HERE/compose.py" "$TMP/rows.json" "$ROOT/docs/assets"
python3 "$HERE/concept.py" "$ROOT/docs/assets"
