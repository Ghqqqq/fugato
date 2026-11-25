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
forwarded when either role flag is in the DUET header. Preserve explicit
user speed choices.

Both role flags apply only to fresh dispatches. Follow-ups, `--to`,
`--thread`, `--resume`, `--resume-last`, `--continue`, `--fork` and
roundtable seat dispatch refuse them. Follow-ups inherit recorded settings.
Use explicit `--model` or `--effort` to change them on the same thread.

Retry a Gemini assignment on Codex only after a classified authentication
failure before prompt submission. Start a fresh `fugato:codex-native` job
with the same brief, the row's explicit fallback `--model` and `--effort`,
and no role flag. Blocked jobs, permission denials and submitted turns never
trigger an automatic fallback.

## Save role settings

Preview requested changes with `--dry-run` and apply without it:

```text
fugato setup --role-model id=model[:effort] --dry-run
fugato setup --role-model id=model[:effort]
fugato setup --role-model id=default
```

Repeat `--role-model` for different roles. `id=default` clears the saved
model and effort. The high-stakes tuple is fixed and cannot be saved as a role.
The legacy `--ultra-routine-model` shortcut sets the model of `scan`,
`implement`, `investigate` and `review`. A saved `--default-model`
supplies the model for `debug`, `architect`, `verify` and `judge`.
Saved role fields take precedence. Roleless Codex dispatches still use
`--default-model` and `--default-effort`.

Check the effective table after applying changes. The mode reminders also
show the roles in use. Saved changes apply to new dispatches.
