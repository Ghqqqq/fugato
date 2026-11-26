<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/fugato-banner-dark.svg">
  <img src="docs/assets/fugato-banner-light.svg" alt="Fugato, for Claude and any number of voices: four voices enter one after another and close on a final barline" width="100%">
</picture>

**Run OpenAI Codex and optional Google Gemini workers from inside Claude Code.**
Fugato is a Claude Code plugin with a companion CLI. Claude sets the criteria
and writes a bounded brief for each worker. Workers investigate, edit and test
in parallel, and Claude checks what they actually ran before accepting anything.
Codex is the main path and runs all four modes; Gemini workers run through
Google's official Antigravity CLI (`agy acp`).

<a href="#install">Install</a> &nbsp;·&nbsp; <a href="#quick-start">Quick start</a> &nbsp;·&nbsp; <a href="#modes">Modes</a> &nbsp;·&nbsp; <a href="docs/commands.md">Documentation</a> &nbsp;·&nbsp; <a href="plugins/codex/CHANGELOG.md">Changelog</a>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/fugato-showcase-live-dark.svg">
  <img src="docs/assets/fugato-showcase-live-light.svg" alt="Claude Code with three Codex workers on one bug: the transcript shows each worker's latest commands and status, and the fugato-live pane on the right lists the workers on a shared time axis and follows the reviewer as it runs" width="100%">
</picture>

<p align="center"><sub>Three Codex workers on one bug. Claude's transcript on the left; the optional <code>fugato-live</code> pane on the right follows every worker as it runs.</sub></p>

## Install

In Claude Code:

```text
/plugin marketplace add Ghqqqq/fugato
/plugin install fugato@fugato
/reload-plugins
/fugato:setup
```

Requires Claude Code 2.1.302+ and Node.js 18.18+. For Codex workers,
`/fugato:setup` checks for a Codex CLI with `app-server` support (tested with
0.146.0) and prints the login command for Fugato's separate Codex home when
sign-in is needed; sign in with a ChatGPT plan or an OpenAI API key (Codex
workers count toward your Codex usage). If you only want Gemini workers, skip
Codex setup and install `agy` below instead.

For the live pane, add `/plugin install fugato-live@fugato`. Upgrading from Duet
or Fugato 1.6.0? Your state carries over: see the
[upgrade guide](docs/upgrading-from-duet.md).

### Google Gemini workers

Fugato also runs Gemini workers through Google's official Antigravity CLI
(`agy acp`), without requiring the Codex CLI. Google's FAQ calls third-party
access a "violation" of its Terms, and an `antigravity-cli` collaborator says
backend-worker use under consumer sign-in is "not permitted". Fugato's Gemini
workers are that case: Google recommends a Google AI Studio API key or Gemini
Enterprise, and Fugato does not yet select those sign-in methods.
[Terms and sign-in](docs/antigravity.md#terms-and-sign-in)

If you choose to proceed, install `agy` and sign in once with `agy acp --login`,
then check access and models:

```bash
fugato setup --backend antigravity
fugato models --backend antigravity
```

Dispatch `Agent(subagent_type: "fugato:gemini-native", prompt: "<brief>")` in
Claude Code or pass a brief on stdin to `fugato task --backend antigravity`. In
`agy`'s default mode, each edit and command needs approval; a running Gemini
agent refuses `SendMessage`, so wait for its `needs_answer` report and follow
`next`. For a native agent, reply with `Answer <questionId>` on the first line
and, for a permission request, exactly `Allow once` or `Deny` on the second;
from the CLI, run the `fugato answer` command that `next` shows.
[Setup and usage](docs/antigravity.md#set-up)

## Quick start

```text
/fugato:pair fix the failing parser test
```

Claude scopes the task and writes the brief. One Codex worker investigates,
makes the change and runs its checks. Claude reads the diff and reruns the
checks before accepting it. Plain requests work too:

```text
Have Codex investigate the flaky integration tests, and have another worker
review the retry logic in src/net/ in parallel. Keep both tasks read-only.
```

For a standalone read-only review of uncommitted or branch changes, run
`/fugato:review` or `/fugato:adversarial-review`.

## How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/fugato-how-it-works-dark.svg">
  <img src="docs/assets/fugato-how-it-works-light.svg" alt="Claude plans: three acceptance criteria, each carried by a brief to a worker. Workers run: Zhang, Sohonie and Noether enter one after another on their own threads. Claude accepts: two reports are accepted on evidence, the review is still running" width="100%">
</picture>

1. **Brief.** Claude defines the acceptance criteria and gives each worker a
   bounded assignment: context, owned paths and the checks to run.
2. **Work.** Each worker runs on its own Codex thread (or Antigravity session
   for Gemini) and can pause to ask Claude a question or request approval
   mid-task; the answer continues the same turn.
3. **Report.** The worker hands back a structured report that separates the
   commands it actually ran from what it claims, with assumptions and blockers.
4. **Accept.** Claude checks the evidence against the criteria, asks for
   corrections where needed, records a verdict in the run journal and
   integrates.

## Modes

Fugato dispatches workers by role from a default table with Sol for routine
work, Astra for hard and high-stakes work, and Gemini rows when `agy` is
installed. Run `fugato models` to see the effective table and
`fugato setup --role-model` to change a role.

Run a command with a task to use a mode once, or add `on` (as in
`/fugato:pair on`) to keep it for the session.

<table>
<tr>
<td width="136">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/fugato-glyph-ultra-dark.svg">
  <img src="docs/assets/fugato-glyph-ultra-light.svg" alt="Ultra glyph" width="120">
</picture>
</td>
<td>
<b><a href="docs/ultra-codex.md">Ultra</a></b><br>
Broad tasks fanned out across many bounded Codex workers, from reading and design through review and verification.<br>
<code>/fugato:ultra-codex &lt;task&gt;</code>
</td>
</tr>
<tr>
<td width="136">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/fugato-glyph-pair-dark.svg">
  <img src="docs/assets/fugato-glyph-pair-light.svg" alt="Pair glyph" width="120">
</picture>
</td>
<td>
<b><a href="docs/pair.md">Pair</a></b><br>
A bounded task for one Codex executor on one thread, with Claude reading every diff and rerunning checks.<br>
<code>/fugato:pair &lt;task&gt;</code>
</td>
</tr>
<tr>
<td width="136">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/fugato-glyph-duel-dark.svg">
  <img src="docs/assets/fugato-glyph-duel-light.svg" alt="Duel glyph" width="120">
</picture>
</td>
<td>
<b><a href="docs/duel.md">Duel</a></b><br>
A contested design or high-risk change, pairing a Codex worker against a Claude subagent with Claude as relay.<br>
<code>/fugato:duel &lt;task&gt;</code>
</td>
</tr>
<tr>
<td width="136">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/fugato-glyph-roundtable-dark.svg">
  <img src="docs/assets/fugato-glyph-roundtable-light.svg" alt="Roundtable glyph" width="120">
</picture>
</td>
<td>
<b><a href="docs/roundtable.md">Roundtable</a></b><br>
Open-ended goals explored by persistent Codex or Gemini personas in a shared forum, chaired by Claude.<br>
<code>/fugato:roundtable &lt;task&gt;</code>
</td>
</tr>
</table>

### Ultra

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/fugato-score-ultra-dark.svg">
  <img src="docs/assets/fugato-score-ultra-light.svg" alt="Ultra drawn as a score: Claude's stave above five worker voices in flight; each short phrase is accepted as it arrives while the next starts, across understand, design, implement, review and verify" width="100%">
</picture>

Claude splits the work-list across parallel readers, independent designs
with judges, one implementer per disjoint area, area × lens reviews and
adversarial verification. Accepted items advance as slots open. After one failed
live fix, competing hypotheses and a separate live diagnostic come before
another fix. `--quick` and `--thorough` set the depth; `--max-workers` caps
concurrency, never coverage. [More](docs/ultra-codex.md).

### Pair

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/fugato-score-pair-dark.svg">
  <img src="docs/assets/fugato-score-pair-light.svg" alt="Pair drawn as a score: Claude briefs one Codex executor, reviews its initial delivery and up to two rework rounds, with an optional read-only verifier, and accepts at the final barline" width="100%">
</picture>

Claude writes the criteria and a full brief, then one Codex worker does the task
end to end on a single thread. Claude reads every diff and reruns the checks
itself. At most two rework rounds follow the first delivery, and an optional
read-only verifier can challenge a round. When the task outgrows one worker,
Claude recommends ultra or duel; it never switches on its own.
[More](docs/pair.md).

### Duel

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/fugato-score-duel-dark.svg">
  <img src="docs/assets/fugato-score-duel-light.svg" alt="Duel drawn as a score: a Codex builder above and a Claude subagent breaker below, with every exchange passing through Claude's stave in between, over up to three rounds" width="100%">
</picture>

For code and bugs, Codex builds by default and a Claude subagent tries to break
the change; each finding gets an answer before the next round. For design
questions, both draft blind, cross-review, and Claude decides on the evidence.
The parties never talk directly and no one accepts their own work. Up to three
rounds; the Claude participant uses your Claude quota. [More](docs/duel.md).

### Roundtable

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/fugato-score-roundtable-dark.svg">
  <img src="docs/assets/fugato-score-roundtable-light.svg" alt="Roundtable drawn as a score: six persona voices enter alone in a sealed first round, then answer one another in threads; a candidate is followed by another member's finding before Claude decides" width="100%">
</picture>

Up to six personas (`conjecturer`, `critic`, `steward`, `improver`,
`integrator`, `calibrator`) work toward one goal through a public forum. Each
first posts an independent record, then members answer one another in threads;
Claude chairs and accepts a reviewed candidate on evidence. Choose `light`
(2 seats), `standard` (3), `deep` (5) or `full` (6), or pick any nonempty subset
with `--roles` (a reviewed final selection needs a finding from a non-author
member, so use at least two seats for that); redefine a persona's model with
`fugato setup --persona-model`, where a `gemini-*` model seats that persona on
Gemini. [More](docs/roundtable.md).

## Inside a worker

Each worker's view shows its commands and edits as they happen, with status on
the left, and ends with the report Claude checks: a summary, the files changed,
the checks run and the findings.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/fugato-showcase-agent-dark.svg">
  <img src="docs/assets/fugato-showcase-agent-light.svg" alt="A worker's transcript: commands with their status, two file edits with line counts, and the closing report with changed files, checks and findings" width="86%">
</picture>

In roundtable mode, the personas argue a goal out in a shared forum. The live
pane shows the posts as an index; press one to read it.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/fugato-showcase-forum-dark.svg">
  <img src="docs/assets/fugato-showcase-forum-light.svg" alt="The roundtable forum in the live pane: numbered posts by kind and author, replies indented under their parent, one candidate expanded with its body and references" width="70%">
</picture>

## Highlights

- **Native subagents.** `fugato:codex-native` and `fugato:gemini-native` run
  workers like Claude Code subagents. `SendMessage` follows up or answers
  questions (and steers running Codex turns); `/tasks` stops them.
- **Evidence over claims.** Captured commands are kept apart from what a worker
  says it ran, so acceptance rests on what was observed.
- **A journal that survives compaction.** Goal, criteria, verdicts and linked
  briefs stay in a run journal: `fugato journal show`.
- **Live view.** The optional `fugato-live` pane shows each worker's commands,
  edits and questions, plus this session's roundtable forums, at no Claude token
  cost.
- **A separate Codex home.** Fugato keeps its own sign-in, threads and job state
  in a separate home (default `~/.claude/codex-isolated`) and does not write its
  state into your everyday `~/.codex`.

## Good to know

- Codex runs with full access by default; lower it with
  `fugato setup --default-sandbox read-only` (or `workspace-write`). Gemini
  workers require full access, so a lowered default makes a fresh Gemini
  dispatch require an explicit `--sandbox danger-full-access`. The separate home
  separates state, not files: give parallel writers disjoint paths or separate
  worktrees.
- Codex edits bypass Claude Code's permission prompts unless you turn on
  permission mapping with `fugato setup --permission-mapping claude`. Gemini
  workers require permission mapping off and full access (dispatch is refused
  while permission mapping is on); in `agy`'s default mode, Fugato forwards
  `agy`'s approval requests to Claude.
- Fugato reports, run journals and `fugato-live` show worker token usage when
  the backend reports it, including partial Gemini counters without fabricating
  missing fields as zero. Worker tokens do not appear in Claude's `/usage`.

## Documentation

| Topic | Page |
| --- | --- |
| Commands and CLI | [Commands](docs/commands.md) |
| Google Gemini workers | [Antigravity ACP setup](docs/antigravity.md#set-up) · [Terms and sign-in](docs/antigravity.md#terms-and-sign-in) |
| Modes | [Ultra](docs/ultra-codex.md) · [Pair](docs/pair.md) · [Duel](docs/duel.md) · [Roundtable](docs/roundtable.md) |
| Dispatch, reports, questions and recovery | [Direct mode](docs/direct-mode.md) · [Worker lifecycle](docs/worker-lifecycle.md) |
| Settings, sandbox, browser and Computer Use | [Configuration](docs/configuration.md) · [Browser](docs/browser-approvals.md) · [Computer Use](docs/computer-use-approvals.md) |
| Run journal | [Run journal](docs/run-journal.md) |
| Live pane and CLAUDE.md policy | [Fugato Live](plugins/codex-live/README.md) · [Optional CLAUDE.md policy](docs/claude-md.md) |
| State, cleanup and troubleshooting | [State and retention](docs/state-and-retention.md) · [Troubleshooting](docs/troubleshooting.md) |
| Release notes | [Changelog](plugins/codex/CHANGELOG.md) |

## Development

```bash
npm ci
npm install -g "@openai/codex@$(cat .codex-version)" "@anthropic-ai/claude-code@$(cat .claude-code-version)"
npm run verify
```

`npm run verify` checks version metadata, builds TypeScript and runs the runtime,
live-pane, native-integration and plugin tests against temporary Codex homes.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Fugato is a fork of
[openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc); the review and
rescue commands come from upstream, the worker runtime, orchestration modes and
live view are Fugato additions.

<br>

<p align="center"><sub><i>fugato</i> · in the style of a fugue: distinct voices developing a shared subject.</sub></p>
