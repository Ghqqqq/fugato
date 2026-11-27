---
description: Run read-only Fugato diagnostics across Codex, Antigravity, dispatch, plugins, configuration and state
argument-hint: '[--json] [--offline] [--cwd <dir>]'
allowed-tools: Bash(node:*)
---

Run a strictly read-only health check for Fugato without creating or modifying files, starting brokers or sessions, changing authentication, or submitting model prompts.

Use `dangerouslyDisableSandbox: true` on the companion Bash call when running online checks so local broker sockets and `agy acp` initialize probes can run (or pass `--offline` to skip them).

Pass the raw `$ARGUMENTS` unchanged through the single-quoted heredoc below, without shell expansion. Do not split, reorder, unquote or rewrite the arguments; the companion parses them.
If an argument line is exactly `DUET_ARGS`, choose a delimiter absent from the arguments and change both heredoc delimiters together.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" doctor --args-stdin <<'DUET_ARGS'
$ARGUMENTS
DUET_ARGS
```

Present the check results and any reported `Fix:` lines directly:
- Exit `0` means no check failed (warnings are allowed). Exit `1` means one or more checks reported `fail`.
- `--offline` skips the broker auth query and Antigravity ACP `initialize` probe while still running local `--version` and filesystem checks.
- Online checks never spawn `codex app-server`, never run ACP `session/new`, and never submit model prompts: Codex auth is queried only from an already-running workspace broker (otherwise reported as present/absent/not verified by file existence alone), and Antigravity runs one bounded ACP `initialize` probe reporting advertised auth methods without verifying sign-in (suggesting `agy acp --login` when needed).
- Output never prints tokens, cookies, or secrets. Do not automatically apply fixes without explicit user request.
