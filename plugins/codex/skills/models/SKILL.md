---
name: models
description: Choose worker roles in Fugato and check, compare or change models and reasoning efforts. Load for role selection, user model requests or an unknown-model error.
---

# Worker roles and models

Run `fugato models` or `fugato models --json` for the effective role table
and the account's Codex model catalog. Use `--all` to include hidden models.
Run `fugato models --backend antigravity` for the Gemini catalog. Check
advertised settings before choosing an explicit model and effort. If neither
the Codex runtime nor its cache can supply the catalog, run `/fugato:setup`.

## Built-in roles

| Role | Assignment | Model / effort | Codex fallback |
| --- | --- | --- | --- |
| `scan` | Scans, inventory and triage | `gpt-6.2-sol` / `low` | |
| `implement` | Implementation and fixes | `gpt-6.2-sol` / `high` | |
| `investigate` | Code tracing and evidence gathering | `gpt-6.2-sol` / `high` | |
| `review` | Code and regression review | `gpt-6.2-sol` / `medium` | |
| `debug` | Hard debugging | `gpt-6.2-astra` / `xhigh` | |
| `architect` | Deep architectural reasoning | `gpt-6.2-astra` / `xhigh` | |
| `verify` | Independent adversarial verification | `gpt-6.2-astra` / `xhigh` | |
| `judge` | Judging alternatives | `gpt-6.2-astra` / `xhigh` | |
| `visual` | Visual inspection | `gpt-6.1-terra` / `medium` | |
| `read` | Reading and synthesizing long inputs | `gemini-4-neon` / `high` | `gpt-6.2-sol` / `high` |
| `media` | Image and media analysis | `gemini-4-neon` / `high` | `gpt-6.1-terra` / `medium` |
| `research` | Source research and synthesis | `gemini-4-neon` / `high` | `gpt-6.2-sol` / `high` |
| `alt-design` | Independent alternative designs | `gemini-4-neon` / `xhigh` | `gpt-6.2-astra` / `xhigh` |

## Dispatch

Start a fresh native prompt with `DUET: --role <id> --normal`, or use
`fugato task --role <id> --normal` in background Bash when the dispatch
route selects it. Match the agent to the effective row. Use
`fugato:gemini-native` for Gemini rows when `agy` is installed and the
work is authorized for full access. Use `--backend antigravity` on the Bash
route for those rows. Without `agy`, use the effective Codex rows. A
backend mismatch fails before launch and names the agent to use.

Use `--high-stakes` on `fugato:codex-native` for security or permission
boundaries, irreversible data or state changes and migrations, public API
or compatibility guarantees, concurrency and process lifecycle, release,
CI and publishing, core architecture, or when the user asks. It fixes model
and effort to `gpt-6.2-astra` / `xhigh`. For a roundtable use
`roundtable start --high-stakes` to apply that model to all seats without an
explicit per-room model.

Explicit user model or effort choices override the corresponding role
fields. Honor those choices and omit `--high-stakes` when passing either
explicit flag. The combination is an error. The Agent tool's effort is not
forwarded when either role flag is in the DUET header. Use `--fast` only
for Codex rows when the user requests it.

Both role flags apply only to fresh dispatches. Follow-ups, `--to`,
`--thread`, `--resume`, `--resume-last`, `--continue`, `--fork` and
roundtable seat dispatch refuse them. Follow-ups inherit recorded settings.
Change the model or effort on the same thread with explicit flags in a
SendMessage DUET header or on `fugato task --to` or `--thread`.
The `--continue` form always inherits model and effort and refuses overrides.

Retry a Gemini assignment on Codex only when the job shows the normalized
`Antigravity authentication is required.` message and a `notStarted` turn
resolution. Start a fresh Codex job with the same brief, the row's explicit
fallback `--model` and `--effort`, and no role flag. Use `fugato:codex-native`
on the native route or follow the `fugato:native-fallback` skill for Bash.
Blocked jobs, permission denials and submitted turns do not qualify.

## Save role settings

Preview requested changes with `--dry-run` and apply without it:

```text
fugato setup --role-model id=model[:effort] --dry-run
fugato setup --role-model id=model[:effort]
fugato setup --role-model id=default
```

Repeat `--role-model` with each role at most once per command. Omitting the
effort clears its saved value. `id=default` clears both saved fields.
Setting or resetting `high-stakes` returns
`the high-stakes tuple is fixed at gpt-6.2-astra/xhigh`.
The legacy `--ultra-routine-model` shortcut supplies a saved Codex model for
`scan`, `implement`, `investigate` and `review`. Use
`--ultra-routine-model default` to clear it. A saved Codex `--default-model`
supplies the model for `debug`, `architect`, `verify` and `judge`. Saved role
settings take precedence. Roles inherit only models from these legacy
settings. Roleless Codex dispatches still use `--default-model` and
`--default-effort`.

Check the effective table after applying changes. The mode reminders also
show the roles in use. Saved changes apply to new dispatches.
