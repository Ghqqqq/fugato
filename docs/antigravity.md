# Google Gemini workers through Antigravity ACP

Claude can delegate a local task to a Gemini worker through the Antigravity
CLI's Agent Client Protocol (ACP) server. Each worker runs its own `agy acp`
process. Antigravity supplies the model and tools. Fugato tracks the job,
forwards permission questions and returns the report. Gemini tasks can run
alongside Codex tasks and do not require the Codex CLI.

## Terms and sign-in

Fugato launches Google's official `agy` binary with the single argument `acp`
and identifies itself as `fugato`. It relies on the credentials `agy` has
cached and never extracts, copies or proxies Google sign-in tokens. Google's
ACP guide lists four sign-in methods: `oauth-personal`, `oauth-business`
(Gemini Enterprise), `gemini-api-key` and `agent-platform`. Fugato does not
select or call the API-key or Gemini Enterprise sign-in methods.
[ACP guide](https://antigravity.google/docs/ide/extensions/acp) ·
[Fugato ACP client](../plugins/codex/scripts/lib/acp-client.mjs)

Google's Antigravity FAQ, in a question that names Claude Code as an example of
third-party software, states: "Using third-party software, tools, or services
to access Antigravity is a violation of our Terms of Service ... To use a
third-party coding agent with Gemini, we recommend using a Gemini Enterprise or
Google AI Studio API key." It also states: "Wrapping `agy` inside third-party
coding agents or applications, or automating account rotation, is not supported
under consumer plans." [Antigravity FAQ](https://antigravity.google/docs/faq)

On 2026-11-12, a Collaborator on Google's `antigravity-cli` repository (issue
1493) wrote that interactive ACP clients may launch the unmodified `agy acp`
"when a human user is directly driving the session", and added: "What is not
permitted under consumer sign-in (oauth-personal) is using agy acp as a backend
worker inside a third-party coding agent, autonomous agent harness, or
background orchestrator."
[antigravity-cli issue 1493](https://github.com/google-antigravity/antigravity-cli/issues/1493#issuecomment-6814901159)

Earlier replies on the Google AI Developers Forum addressed single-user
interactive clients such as T3 Code or Zed, where a human drives the session;
those replies do not establish formal Google policy.
[Forum reply on personal sign-in](https://discuss.ai.google.dev/t/tos-clarification-is-t3-code-official-antigravity-acp-agent-permitted-under-the-antigravity-terms-of-service/192027/2) ·
[Forum clarification on clients and models](https://discuss.ai.google.dev/t/conflicting-guidance-on-using-t3-code-with-personal-google-ai-subscriptions/197131/3)

Fugato's Gemini workers are that backend-worker case: Google's FAQ calls
third-party access a "violation" of its Terms of Service, and the
`antigravity-cli` collaborator states that backend-worker use under consumer
sign-in is "not permitted". If you use a personal Google sign-in with Fugato's
Gemini workers, you do so at your own account risk; Google recommends a Google
AI Studio API key or Gemini Enterprise for third-party coding agents.

## Set up

Antigravity CLI first shipped `agy acp` in 1.5.0. Use 1.5.15 or later for
continuations. Fugato has been tested live with 1.5.16.
[Antigravity CLI release notes](https://antigravity.google/docs/changelog/)

Install the CLI with Google's installer. It installs `~/.local/bin/agy` and
may add that directory to your shell profile. In the terminal that will launch
Claude Code, make it available immediately and check the version.

```sh
curl -fsSL https://antigravity.google/cli/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
agy --version
```

For native Google sign-in, run `agy acp --login` once. Open the Google URL
it prints and paste the returned code into the terminal. An interactive
`agy` session can also complete sign-in.

With the Fugato plugin installed, run these commands from the project in a
Claude Code session. From the root of a Fugato checkout, you can use
`plugins/codex/bin/fugato` in place of `fugato`. [Plugin installation](../README.md#install)

```sh
fugato setup --backend antigravity
fugato models --backend antigravity
```

Setup checks the login by initializing ACP and creating a session without a
model prompt. Launch uses the same ACP handshake and skips the old
`agy acp --help` probe. A missing executable or one that cannot speak ACP
produces install and login guidance. For a custom install, set
`FUGATO_ANTIGRAVITY_BIN` to an absolute path or a path relative to the task
directory, such as `./tools/agy`. A bare executable name uses `PATH`. Fugato
launches the exact absolute path it checked for the turn and records that path
for recovery. [Executable resolution](../plugins/codex/scripts/lib/antigravity.mjs) ·
[Worker launch](../plugins/codex/scripts/codex-companion.mjs)

## Default model and thinking level

Fresh Gemini workers request `gemini-4-neon` with `xhigh` thinking. If Neon
is unavailable, Fugato keeps agy's current Gemini model or selects the first
advertised Gemini model. It then checks the selected model's thinking options
and keeps its current level if `xhigh` is unavailable. Explicit `--model` and
`--effort` values must be supported. A continuation inherits the settings
actually used on its thread. The native agent header and `fugato-live` show
the requested settings at dispatch and update when agy selects a fallback.

`fugato models --backend antigravity` lists the account's advertised
`gemini-*` IDs and labels Neon as the Fugato default when available. Thinking
options apply to agy's current model. In the `--json` output, `isDefault`
identifies that current model and `isFugatoDefault` identifies Neon.
[`listAntigravityModels` and `setSelection`](../plugins/codex/scripts/lib/antigravity.mjs)

## Start a native worker in Claude Code

```text
Agent(subagent_type: "fugato:gemini-native", prompt: "Investigate the parser failure, implement the agreed fix and run the relevant tests.")
```

To select a model or thinking level for this assignment, put an optional
`DUET:` header on the first line of the prompt. Either flag can be supplied
on its own.

```text
DUET: --model <gemini-model-id> --effort <thinking-value> --max-minutes 10
Investigate the parser failure, implement the agreed fix and run the tests.
```

The native preset fixes the backend to `antigravity` and rejects a conflicting
backend. The Claude shell's effort and saved Codex model and effort defaults
do not select Gemini settings.

Wait for the worker's report before using `SendMessage`. A running turn
refuses messages, even if a progress notice already shows a question.
Once the turn finishes, send a plain brief to start the next assignment on
the same session. Use `/tasks` to stop the worker.
[Message routing](../plugins/codex/hooks/steering.mjs)

If the report says `needs_answer`, its `next` field shows the exact reply
format for that question. Put `Answer <questionId>` on the first line of the
message, using the displayed ID. Put the answer body on the following lines.
For example, to allow the displayed operation once, send this two-line
message with the placeholder replaced by the question ID.

```text
Answer <questionId>
Allow once
```

For a permission question, the body must be exactly `Allow once` or `Deny`.
For an ordinary question, supply a nonempty text answer of up to 8,000
characters. Fugato checks the ID against the job's actual pending question.
It refuses replies with a missing header, a stale or mismatched ID, or an
invalid body. Those replies start no work.
[`geminiAnswerNext` and `geminiMessageRefusal`](../plugins/codex/hooks/native-agent.mjs)

## Companion CLI

```sh
fugato task --backend antigravity --name GeminiWorker --max-minutes 10 <<'TASK'
Investigate the parser failure, implement the agreed fix and run the tests.
TASK
```

Use the reported worker name or job ID for a follow-up. This example continues
a worker named `GeminiWorker`.

```sh
fugato task --to GeminiWorker <<'TASK'
Check the edge case reported by the reviewer and update the tests.
TASK
```

Both `--to <jobId>` and `--continue <jobId>` keep the selected job's backend.
Bare `fugato task --resume-last` and `fugato task-resume-candidate` select
Codex jobs. Add `--backend antigravity` to either command to select Gemini
jobs. [Companion CLI](../plugins/codex/scripts/codex-companion.mjs)

Continuation requires an ACP server that advertises `session/load` and
reports agy 1.5.15 or later. Earlier versions can replay history after the
load reply, mixing old commands and messages into the new turn. Fugato
refuses the continuation before loading if either check fails. On supported
versions, it starts capturing the new report after the replay.
[`supportsOrderedReplay` and `runAntigravityTurn`](../plugins/codex/scripts/lib/antigravity.mjs)

## Permissions and isolation

Antigravity runs its own tools. Fugato requires `danger-full-access`, the
built-in sandbox default. If your saved default is `read-only` or
`workspace-write`, a fresh dispatch fails unless you explicitly pass
`--sandbox danger-full-access` in the native header or CLI command. Use it
only for assignments authorized for full access. Native `isolation: "worktree"`
and `isolation: "remote"` are refused before spawn. For parallel local writers,
assign disjoint paths or start each CLI task in a separately prepared worktree.
[Task validation](../plugins/codex/scripts/lib/backends.mjs) ·
[Native isolation checks](../plugins/codex/hooks/native-agent.mjs)

In agy's default mode, every edit and command prompts for permission. The
report card shows the full approval text with its whitespace preserved.
Claude reviews the operation and follows the report's `next` instructions.
The answer applies only to the operation shown. If the operation changes
while the answer is pending, or if agy's `rawInput` and its `args` copy
disagree, Fugato denies the request with `operation-changed-before-approval`.
After `Deny`, agy usually ends the turn and Fugato reports the job as blocked
with `approval_denied`.

For a CLI task, run the `fugato answer` command in the report's `next` field.
The command already targets the displayed question ID. Pass just the answer
body on stdin.
The foreground compatibility CLI denies requests because it has no waiting
parent. [Question handling](../plugins/codex/scripts/lib/job-runtime.mjs)

Each question shows separately labelled, JSON-quoted fields for the supplied
arguments, locations and operation details, with control and bidirectional
formatting characters escaped. A serialized question over 16 KiB is denied
with `operation-too-large-to-display-exactly`. A request of kind `other` with
reviewable input can reach Claude. An execution request without a command
line is denied. [`permissionReview` and `permissionDecision`](../plugins/codex/scripts/lib/antigravity.mjs)

## Reports, budgets and stopping

- Native report cards identify the backend as `antigravity` and the provider
  as `Google Antigravity`. The card shows the model and total tokens when
  reported. [Native report rendering](../plugins/codex/hooks/native-agent.mjs)
- Per-turn `usage` comes from the `session/prompt` result. Fugato's
  `inputTokens` includes agy's input tokens plus cache reads and writes.
  `cachedInputTokens` counts only cache reads. `reasoningOutputTokens` comes
  from agy's `thoughtTokens`. Fugato also records `outputTokens` and
  `totalTokens` when supplied. Background reports accept partial counters.
  [Usage mapping](../plugins/codex/scripts/lib/antigravity.mjs) ·
  [Background delivery](../plugins/codex/scripts/lib/report-delivery.mjs)
- In result details, `acpUsage.used` from `usage_update` measures context
  occupancy. Since turn usage arrives only at the end, Fugato refuses an
  explicit `--max-tokens` limit and ignores a saved default token limit for
  Gemini tasks. Use `--max-minutes` for a running-time budget.
  [Budget handling](../plugins/codex/scripts/codex-companion.mjs)
- Repeated status updates for the same tool call leave the final report
  intact. When an edit's arguments or locations change without a new diff,
  Fugato drops the previous diff. Captured commands use agy's
  `rawInput.CommandLine`. A permission denial stays in the report as a
  blocker. Fugato excludes the denied command from the checks that ran and
  lists the worker's own verification claims separately.
  Fugato sends the requested JSON format in the prompt and parses the response.
  [Command capture and prompt handling](../plugins/codex/scripts/lib/antigravity.mjs)
- Cancellation, lease expiry, owner loss or a time limit interrupt the
  running turn. Fugato sends `session/cancel`, waits briefly for a reply and
  cleans up the owned process group. The report records whether agy
  acknowledged cancellation.
- If a worker crashes after saving a successful result, Fugato restores the
  result that matches the job, session and turn. If the crash leaves a
  submitted turn without a recoverable result, Fugato reports its outcome as
  unknown and never replays the assignment.
  [Result recovery](../plugins/codex/scripts/codex-companion.mjs)
- While the original agy process is still running the turn, Fugato blocks a
  second prompt on the same ACP session, even from another workspace. If
  Codex and Antigravity have the same session handle, each backend uses only
  its own job records to admit a turn, clean up or route a parent question.
  [Companion CLI](../plugins/codex/scripts/codex-companion.mjs) ·
  [Parent question routing](../plugins/codex/scripts/parent-bridge-mcp.mjs)
- After a worker crash, `fugato cancel <jobId>` checks the start identity saved
  with the agy PID (Linux: boot ID and `/proc` start time; Windows: creation
  time; others: `ps` start time) and signals the agy process group only when the
  command and start identity match. A mismatch means PID reuse, and a saved
  identity that cannot be re-read leaves the process running. Records without a
  saved identity (from older versions, or when it could not be read at
  registration) keep the previous timing rule. Once gone, the concurrency slot
  is released and the session can continue.
  [`processIdentity`](../plugins/codex/scripts/lib/acp-process.mjs) ·
  [Concurrency slots](../plugins/codex/scripts/lib/concurrency.mjs)

## Support boundaries

| Supported on Gemini | Outside Gemini worker support |
| --- | --- |
| Native and CLI tasks, including independent parallel workers | Codex review and roundtable personas |
| Gemini model and thinking selection | Setting agy's session mode (`default`, `accept-edits`, `auto`, `plan`) from Fugato |
| Single-use approvals and reports | Claude permission mapping and plan mode, Codex browser and Computer Use grants |
| Session continuation with agy 1.5.15+ and `session/load` | Claude transcript `--fork` and `transfer` |
| Cancellation, leases and running-time budgets | Codex priority `--fast` and a per-turn `--max-tokens` limit |

Pair, Ultra, Duel and Roundtable retain their existing dispatch defaults.

## Development and live verification

The ACP tests launch a deterministic fixture as a child process. They cover
model selection, approval questions, history replay, usage, cancellation and
crash recovery. The CLI and native tests exercise dispatch and continuation.

```sh
node --test tests/antigravity*.test.mjs
npm run test:native
npm run verify
```

For a live check, run the setup and model-list commands above. In a disposable
workspace, start a worker, answer an edit or command question, and continue
the reported worker. Check the model and token count on its report. Cancel a
second task and check whether agy acknowledged the interruption.

Protocol references:

- [Google's ACP guide](https://antigravity.google/docs/ide/extensions/acp)
- [ACP initialization](https://agentclientprotocol.com/protocol/v1/initialization)
- [Session setup](https://agentclientprotocol.com/protocol/v1/session-setup)
- [Session configuration](https://agentclientprotocol.com/protocol/v1/session-config-options)
- [Tool calls and permissions](https://agentclientprotocol.com/protocol/v1/tool-calls)
- [Prompt lifecycle and cancellation](https://agentclientprotocol.com/protocol/v1/prompt-turn)
