# Google Gemini workers through Antigravity ACP

Fugato can run Google Gemini workers through the Antigravity CLI's Agent Client
Protocol (ACP) server. Claude remains the coordinator; Antigravity supplies the
agent loop, model, tools and account authentication. Each worker has its own
`agy acp` process and uses Fugato's existing job tracking, parent questions,
reports, journal, cancellation and continuation commands.

This is an additional worker backend. Existing Codex commands and saved Codex
model defaults retain their behavior. Google tasks do not require the Codex CLI.

## Set up

Install the [Antigravity CLI](https://antigravity.google/docs/cli/acp/) using
Google's current instructions, then authenticate in an interactive terminal:

```sh
agy --version
agy acp --login
fugato setup --backend antigravity
fugato models --backend antigravity
```

The readiness check initializes ACP and creates a session without sending a
model prompt. It uses Antigravity's existing CLI credentials. Fugato does not
copy those credentials into its Codex home or change the user's Antigravity
configuration. For installations outside `PATH`, set
`FUGATO_ANTIGRAVITY_BIN` to the executable's absolute path; it is an executable
path, not a shell command with arguments.

Available models depend on the account and server. Fugato identifies itself as
`fugato`; Google's [ACP guide](https://antigravity.google/docs/ide/extensions/acp)
allows Gemini for all ACP clients and restricts third-party models to specified
IDE clients. Fugato's supported Google route is Gemini.

## Start a native worker in Claude Code

Use the new agent type:

```text
Agent(subagent_type: "fugato:gemini-native", prompt: "Investigate the parser failure, implement the agreed fix and run the relevant tests.")
```

The agent uses Antigravity's current model and thinking level unless the brief
explicitly selects values returned by `fugato models --backend antigravity`:

```text
DUET: --model <model-id> --effort <thinking-value> --max-minutes 10
Investigate the parser failure, implement the agreed fix and run the tests.
```

`DUET:` remains the compatible task-header syntax. The Gemini preset fixes
`--backend antigravity`; a conflicting backend is rejected. It does not inherit
the Claude shell's effort or Fugato's Codex model/effort preferences.

The result appears as a normal Fugato worker report. `SendMessage` answers a
pending parent question or adds a later assignment; `/tasks` stops the worker.
Messages sent during an active turn are queued for the next turn in this first
implementation. They are never reported as already injected into the active
Google prompt.

## Companion CLI

```sh
fugato task --backend antigravity --name GeminiWorker --max-minutes 10 <<'TASK'
Investigate the parser failure, implement the agreed fix and run the tests.
TASK
```

The worker can run alongside Codex workers. Assign parallel writers disjoint
paths or separate worktrees, as with existing Fugato workers.

Continue the same session by its actual reported worker name or job ID:

```sh
fugato task --to GeminiWorker <<'TASK'
Check the edge case reported by the reviewer and update the tests.
TASK
```

`--to`, `--thread`, `--continue` and tracked `--resume-last` preserve the recorded
backend. A session cannot switch between Codex and Antigravity. Continuation
uses ACP `session/load`; if the server does not advertise that capability, the
request fails with an explanation rather than creating an empty replacement
session. Historical replay during loading is excluded from the new report.

`models --backend antigravity --json` exposes model IDs and configuration options
advertised by the server. Model changes can alter the available thinking
options; Fugato applies the model first, refreshes the configuration and then
validates the requested thinking value. Unavailable values fail explicitly.

## Permissions and isolation

Antigravity executes its own tools and applies its own permission rules. ACP
client capabilities do not impose a filesystem sandbox. This version therefore
accepts only Fugato's `danger-full-access` mode for Google tasks. If a saved
default requires `read-only` or `workspace-write`, dispatch fails before starting
the server. An authorized task can explicitly select
`--sandbox danger-full-access`; sandboxed work should continue to use Codex.

Fugato forwards Antigravity's permission requests to the parent using the
existing question/answer flow. The two choices are **Allow once** and **Deny**.
Only the exact single-use answer can select the server's `allow_once` option;
ambiguous answers, missing options, cancellation and expired questions grant
nothing. Fugato does not request an always-allow option or pass
`--dangerously-skip-permissions`. Actions already permitted by Antigravity's
own rules may run without an ACP permission request.

Native plan mode and Claude permission mapping are refused because their
restrictions cannot be represented faithfully by this adapter. The plain
foreground compatibility CLI, which has no parent waiting for questions,
denies new permission requests. The normal `fugato task` launcher owns its wait
and supports the parent approval flow.

## Reports, budgets and stopping

- Text, disclosed thought chunks, tool updates and file diffs feed the existing
  activity log and report. Captured command events remain separate from the
  worker's claims about verification. Workspace snapshots track file changes.
- ACP v1 has no native Fugato JSON output-schema field. The requested report
  format is included in the prompt and parsed through the existing report
  parser; a prose answer remains a prose report.
- Reports identify `backend: antigravity` and `provider: Google Antigravity`.
  ACP `usage_update` is stored as `acpUsage` in result details. Its `used` field
  measures context occupancy, not tokens consumed in the turn. It is not
  converted to Codex token totals or a zero-cost usage claim.
- `--max-minutes`, owner loss, lease expiry and user cancellation all stop the
  same owned ACP connection. `session/cancel` is followed by a bounded wait for
  the prompt response and cleanup of the owned process group. Reports distinguish
  an acknowledged end from an unconfirmed interruption.
- If the worker crashes before saving its result, the outcome remains unknown.
  ACP v1 cannot read an exact lost turn from another connection. Fugato does not
  replay the assignment or send its session ID to Codex recovery. Inspect the
  job log and Antigravity before deciding how to proceed.

## First-version support

| Supported | Kept on the Codex route |
| --- | --- |
| Native Gemini worker and CLI tasks | Native Codex review command |
| Independent parallel workers | Existing Pair, Ultra, Duel and Roundtable default dispatch |
| Dynamic model and thinking selection | Cross-provider roundtable personas |
| Parent questions, single-use approvals and reports | Codex browser/Computer Use grants and permission mapping |
| Session continuation when advertised by the server | Claude transcript `--fork` / `transfer` |
| Cancellation, leases and running-time budgets | Codex priority `--fast` and per-turn `--max-tokens` |

Unsupported task options fail before starting Antigravity. A separate Google
worker can still contribute evidence to a Claude-led task without changing an
existing orchestration mode's dispatch policy.

## Development and live verification

The ACP tests use a real child process implementing a deterministic fake server:

```sh
node --test tests/antigravity.test.mjs tests/antigravity-cli.test.mjs
npm run test:native
npm run verify
```

The fixture covers protocol framing, bidirectional permission RPCs, dynamic
configuration, history replay, cancellation, malformed responses and child
process failures. CLI and native tests exercise dispatch and continuation without
a Codex executable. They do not establish compatibility with a particular live
Antigravity account or CLI release.

A live check requires an installed, authenticated `agy`: run the setup and
model-list commands above, use a disposable workspace for one task, continue
the returned worker and cancel a second task. Verify the reported model,
permission question and cancellation confirmation before relying on a release
in a longer workflow.

Protocol references:

- [Google's ACP guide](https://antigravity.google/docs/ide/extensions/acp)
- [ACP initialization](https://agentclientprotocol.com/protocol/v1/initialization)
- [Session setup](https://agentclientprotocol.com/protocol/v1/session-setup)
- [Session configuration](https://agentclientprotocol.com/protocol/v1/session-config-options)
- [Tool calls and permissions](https://agentclientprotocol.com/protocol/v1/tool-calls)
- [Prompt lifecycle and cancellation](https://agentclientprotocol.com/protocol/v1/prompt-turn)
