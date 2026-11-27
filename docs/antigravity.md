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

## Roles and thinking levels

When `agy` is installed, the built-in `read`, `media` and `research` roles
request `gemini-4-neon` / `high`. The `alt-design` role requests
`gemini-4-neon` / `xhigh`. Saved role settings can change these rows.
Without `agy`, the [effective role table](ultra-codex.md#worker-roles) uses their
Codex fallbacks. Executable discovery does not check sign-in.

A roleless fresh Gemini worker requests `gemini-4-neon` / `xhigh`. If that
default model or thinking level is unavailable, Fugato selects from the
advertised models or keeps the model's current thinking level. Explicit model
and effort values must be supported. A continuation inherits the settings
used on its thread. The native agent header and `fugato-live` show the
dispatch settings and update when agy selects a fallback.

`fugato models --backend antigravity` lists the account's advertised
`gemini-*` IDs and labels Neon as the Fugato default when available. Thinking
options apply to agy's current model. In the `--json` output, `isDefault`
identifies that current model and `isFugatoDefault` identifies Neon.
[`listAntigravityModels` and `setSelection`](../plugins/codex/scripts/lib/antigravity.mjs)

## Start a native worker in Claude Code

```text
Agent(subagent_type: "fugato:gemini-native", prompt: "Investigate the parser failure, implement the agreed fix and run the relevant tests.")
```

For a fresh assignment with a Gemini-backed role, put a DUET header first.

```text
DUET: --role research --normal --max-minutes 10
Compare the official sources and summarize the evidence.
```

Use explicit `--model <gemini-model-id>` or `--effort <thinking-value>`
for a user choice. The native preset fixes the backend to `antigravity`.
A mismatched role fails before launch and names the agent to dispatch.
For `--high-stakes` use `fugato:codex-native`. The Claude shell's effort
and saved Codex defaults do not select Gemini settings.

The automatic Codex fallback applies only to a classified authentication
failure before prompt submission (`notStarted` with an auth error before
`session/prompt`). Dispatch the same brief fresh on `fugato:codex-native`
with the fallback row's explicit `--model` and `--effort` and no role flag.
Blocked jobs, permission denials and submitted turns never trigger this
fallback. Escalating a resolved Gemini job that still fails after a rework is
a separate step: a fresh `fugato:codex-native` dispatch with `--high-stakes`
(see the protocol's Worker roles section).

You can use `SendMessage` from the main conversation while a Gemini worker is
running to steer the turn (see [Mid-turn steering](#mid-turn-steering)). Once
the turn finishes, send a plain brief to start the next assignment on the same
session. Use `/tasks` to stop the worker.
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

## Mid-turn steering

ACP v1 has no `turn/steer` RPC, so Fugato delivers mid-turn steering to a
running Gemini worker at parent-bridge tool boundaries.

- When the chair sends `SendMessage` to a running `fugato:gemini-native` worker
  that has no pending question, Fugato persists the note immediately in
  `<jobId>.steering.json`, returns delivered without waiting on the Codex 6 s
  poll loop, and records a `Gemini steering queued.` notice.
- On the worker's next parent-bridge tool call (`workspace_*`, `forum_*`, or
  `ask_parent`, including non-roundtable jobs and `forum_read`), the bridge
  atomically drains all queued notes, marks them `applied` with `appliedAt`,
  and appends them once to the tool reply framed as
  `[Chair steering update — apply immediately]` (or `[Chair denial guidance]`
  for denial guidance). Subsequent tool replies never repeat already-applied
  notes.
- Delivery happens only at parent-bridge tool boundaries. During a
  pure-reasoning stretch or local tool sequence with no parent-bridge calls,
  queued notes stay undrained until the turn ends. At turn end, Fugato marks
  any remaining queued notes terminal so they are never delivered twice, and
  surfaces them on the job report in `unconsumedSteers` (`[{ id, text }]`,
  bounded to 3 clipped entries plus `unconsumedSteersOmitted`) alongside a
  warning `notice` telling the chair to resend with `SendMessage` if still
  needed.
- If a question or approval is pending (`needs_answer`), steering defers and
  `Answer <questionId>` routing is unchanged. Active Gemini roundtable seats
  continue to receive forum unread notices via bridge tool footers rather than
  the steering queue.
  [Steering queue](../plugins/codex/scripts/lib/steering.mjs) ·
  [Bridge footer drain](../plugins/codex/scripts/parent-bridge-mcp.mjs)

## Companion CLI

```sh
fugato task --backend antigravity --role research --normal --name GeminiWorker --max-minutes 10 <<'TASK'
Compare the official sources and summarize the evidence.
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
`Allow once` applies only to the operation shown. For a safe, parseable
`run_command` matching one of the four parsed-argv allowlist forms—`node --test <file>...`
(existing regular files), `claude plugin test <dir>` (an existing directory),
`npm test`, or `npm run test` / `npm run test:<name>`—the card also offers a
third option: `Allow "<prefix>" for this job`. Commands must contain no quotes,
no shell operators, expansions, globs, or non-ASCII characters, and no `.`,
`..`, or `node_modules` path segments; every path argument must exist and
`realpath` inside the job execution directory, and any `Cwd`/`cwd` field must
`realpath` to that exact execution directory. `git` commands are never
grantable and show only `Allow once` and `Deny`—use the auto-allowed,
hook-free `workspace_git_read` tool for `git` inspection instead. Answering the
exact job-grant option allows the command and grants that prefix in memory for
the current job only—never written to `config.toml` or the job file and never
inherited by `--continue`, `--to`, `--thread`, or a new job. Later matching
`run_command` calls in the same job auto-allow without parking and emit an
argument-free `permissionAutoAllowed` activity entry
(`job grant auto-allowed: <prefix>`). Note that a `node --test` or `npm test`
(or `npm run test` / `npm run test:<name>`) grant lets the worker run test code
it can edit in its worktree for the rest of that job, so grant it only when
that is acceptable.
[Command classification](../plugins/codex/scripts/lib/command-classify.mjs)

If the operation changes while the answer is pending, or if agy's `rawInput`
and its `args` copy disagree, Fugato denies the request with
`operation-changed-before-approval`. You may deny either with plain `Deny` or
with `Deny: <guidance>` (1–1,000 trimmed characters after `Deny:`); both are
accepted by native `Answer <questionId>` replies and `fugato answer`. Guidance
is queued for the worker and delivered with its next parent-bridge tool result
as `[Chair denial guidance]`. If agy then ends the turn normally and every
blocker is such a guided denial, the job completes with `deniedActions`
(`[{ code, guidance }]`) and a notice instead of `blocked`. Otherwise (agy
stops the turn, a plain `Deny`, or any other blocker) Fugato reports the job as
blocked with `approval_denied`, recording `guidance` on that blocker. Any
answer other than `Allow once`, the exact displayed job-grant option, `Deny`,
or `Deny: <guidance>` denies the request.

For a CLI task, run the `fugato answer` command in the report's `next` field.
The command already targets the displayed question ID. Pass just the answer
body on stdin.
The foreground compatibility CLI denies requests because it has no waiting
parent. [Question handling](../plugins/codex/scripts/lib/job-runtime.mjs)

Each question shows separately labelled, JSON-quoted fields for the supplied
arguments, locations and operation details, with control and bidirectional
formatting characters escaped. When a diff string in `Operation details` is
identical to a string value in `Arguments`, the display replaces the duplicate
with an explicit reference such as `{"sameAs":"Arguments.Content"}` so changed
text appears once while the binding check still compares the full original
fields. Questions up to 16 KiB raw UTF-8 bytes are shown inline. Larger
operations are staged verbatim as `0600` files under
`<stateDir>/approvals/<jobId>/<sha256>.txt` and presented as a compact card
under 2 KiB containing the metadata, byte size, `SHA-256` digest and
`Exact operation` path to read in full before answering. At answer time,
`Allow once` proceeds only if the original fields are unchanged and the staged
file still hashes to its recorded SHA-256; otherwise Fugato denies with
`operation-changed-before-approval`. Operations that cannot be staged or
represented safely are denied with `operation-too-large-to-display-exactly`. A
request of kind `other` with reviewable input can reach Claude. An execution
request without a command line is denied. [`permissionReview` and
`permissionDecision`](../plugins/codex/scripts/lib/antigravity.mjs) ·
[Approval artifacts](../plugins/codex/scripts/lib/approval-artifacts.mjs)

Every Gemini worker's parent bridge also exposes three read-only workspace
tools—`workspace_list`, `workspace_grep` and `workspace_git_read`—scoped to
the job's execution directory (`CODEX_COMPANION_BRIDGE_EXEC_CWD`). They run
without a shell, reject path/symlink escapes and untrusted git config hooks or
pagers, cap output size and runtime, and are auto-allowed one call at a time
with argument-free `permissionAutoAllowed` audit entries in job activity.
Codex bridges do not expose these tools. [`workspace-read-tools.mjs`](../plugins/codex/scripts/lib/workspace-read-tools.mjs)

The bridge also exposes two confined write tools, auto-allowed the same way.
`workspace_edit({ path, target, replacement, replace_all?, expected_occurrences? })`
changes exactly one match by default and returns an error with the match count
and line numbers (leaving the file unchanged and the turn alive) for zero or
several matches. `workspace_write({ path, content, mode? })` creates
(default), overwrites or appends. Both accept only workspace-relative paths,
refuse `..`, symlinks, any `.git` component and results over 256 KiB, write
atomically, and record a `fileChange` entry (`Update(path) · +N −M` /
`Write(path)`) whose path joins the turn's `touchedFiles`. Gemini workers are
told to prefer them; the built-in `edit_file` and `write_file` still park.
When a built-in `edit_file` would replace several matches, or finds none, its
card starts with `AMBIGUOUS:` or `NO MATCH:`.
[`workspace-write-tools.mjs`](../plugins/codex/scripts/lib/workspace-write-tools.mjs)

Before any request parks, Fugato applies a fail-closed boundary policy.
Inside the job's execution directory a request passes the gate, except a write
to any `.git` path; passing is not approval. Outside it, reads and writes under
`~/.claude`, `~/.codex`, `~/.gemini` or the isolated Fugato home (including
sibling roundtable worktrees), writes to the worktree's `gitdir`/`commondir`, and
any other write are denied locally without waking Claude. Commands that run
`npm run build`, `npm run verify`, `npm publish`, `npm install`/`ci`,
`git push`, a recursive `rm` of an absolute or parent path, or that reference a
protected home are denied the same way, as is a command whose working directory
lies outside the job's directory. Paths are taken from every path-like argument
(including nested and array values, `file:` URIs and diff targets) and resolved
against the request's own working directory; a tool not clearly read-only is
checked as a write. Each denial ends up as a blocker with
its policy code (`protected_home`, `outside_workspace`, `git_metadata_write`,
`forbidden_command`). Fugato gates only the tool calls agy submits through
`session/request_permission`; it is not an operating-system sandbox.
[`acp-policy.mjs`](../plugins/codex/scripts/lib/acp-policy.mjs)

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

## Roundtable

Gemini workers can take explicit [roundtable](roundtable.md) seats alongside
Codex members. Pick a Gemini seat with per-room
`fugato roundtable start --persona-model id=gemini-*[:effort]` or saved
`fugato setup --persona-model id=gemini-*[:effort]`. Role-derived seats stay
Codex. `agy` must be installed and Claude permission mapping must be `off`, or
`roundtable start` fails before creating the room.

For each Gemini seat, `roundtable start` prints `backend: "antigravity"`,
`agentType: "fugato:gemini-native"`, and a `DUET: --backend antigravity ...`
header. The chair dispatches the printed `agentType` and `header`. Gemini seats
require full access; a seat task with any other sandbox is refused before
launch.

Gemini members receive forum notices only between turns, never mid-turn. While a
Gemini turn is running, parent-bridge tool calls other than `forum_read` append
a read-only one-line unread footer (listing at most 3 sequence references by
kind only, with no titles, bodies or peer author names) whenever visible unread
chair posts or mentions exist beyond the member's read and notification cursors;
computing the footer never mutates `room.json` or cursors. Parked
approvals hold that member's notices until answered, and `fugato roundtable
status <roomId>` reports pending and answered action approvals alongside token
totals per member and for the room. Edits and commands still
park for approval in agy's default mode, while parent-bridge calls
(`ask_parent`, `forum_read`, `forum_post`, `workspace_list`, `workspace_grep`,
`workspace_git_read`, `workspace_edit`, `workspace_write`) are auto-allowed one
call at a time and audited in job activity without arguments.

Terms note: roundtable seats run `agy acp` as a backend worker. Google's FAQ
names Claude Code as third-party software, and an `antigravity-cli` collaborator
stated ([issue 1493](https://github.com/google-antigravity/antigravity-cli/issues/1493#issuecomment-6814901159),
2026-11-12) that consumer sign-in (`oauth-personal`) is not permitted as a
backend worker inside a third-party agent harness. Users decide their own
account risk; see [Terms and sign-in](#terms-and-sign-in).

## Support boundaries

| Supported on Gemini | Outside Gemini worker support |
| --- | --- |
| Native and CLI tasks, independent parallel workers, and explicit roundtable seats | Codex review and read-only roundtable seats |
| Gemini model and thinking selection | Setting agy's session mode (`default`, `accept-edits`, `auto`, `plan`) from Fugato |
| Single-use approvals and reports | Claude permission mapping and plan mode, Codex browser and Computer Use grants |
| Session continuation with agy 1.5.15+ and `session/load` | Claude transcript `--fork` and `transfer` |
| Cancellation, leases and running-time budgets | Codex priority `--fast` and a per-turn `--max-tokens` limit |

Pair, Ultra, Duel and role-derived Roundtable seats retain their existing Codex
dispatch defaults; Gemini roundtable seats require an explicit persona model.

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
