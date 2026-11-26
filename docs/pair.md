# /fugato:pair — one executor, Claude acceptance

Pair is for a bounded task that one Codex worker can complete end to end.
Claude plans, writes the full brief and accepts every diff. Dispatch the
primary Codex worker with `--role implement`. It defaults to
`gpt-6.2-sol` / `high`. An optional Codex verifier uses `--role verify`
(default `gpt-6.2-astra` / `xhigh`). Use `--normal` unless the user
asks for fast speed. Apply the [high-stakes rule](ultra-codex.md#worker-roles)
and honor explicit user model and effort choices. Change the rows with
`fugato setup --role-model id=model[:effort]`. The mode reminder shows the
effective executor and verifier settings.

Back to the [README](../README.md). Compare [ultra](ultra-codex.md) for breadth
and [duel](duel.md) for persistent adversarial work.

## Commands

```text
Usage: /fugato:pair [on [<task>] | off | status | <task>]

/fugato:pair fix the failing parser test
/fugato:pair on
/fugato:pair on fix the failing parser test
/fugato:pair status
/fugato:pair off

fugato pair on
fugato pair status --for-command
fugato pair off
```

Pair has no mode options: no scale, worker-cap or rounds flags. No arguments
means status. CLI controls never take task text or start workers; they accept
the common workspace/session/JSON/help options. `on <task>` validates and saves
the mode before starting the task. A task without `on` runs once, preserving
the saved session mode. Use `--` for literal task text beginning with `on`,
`off`, `status` or an option-like word. See [the shared grammar](commands.md#orchestration-controls).

Only one session mode is active. Pair `on` replaces ultra or duel; pair `off`
clears only pair. A one-shot pair task while another mode is active uses pair
only for that task and reports that the session mode is unchanged. A new
substantive pair task starts a fresh primary thread; its rework retains that
thread. Session settings do not store participant identities or task counters.

## Execution and acceptance

1. Claude scouts enough to choose a plan and observable task-level criteria,
   starts/uses the run journal, and writes a full implementer brief with owned
   paths, constraints and exact checks. Read-only analysis still gets a full
   task brief with read-only bounds and sandbox.
2. One primary Codex worker investigates, implements and runs its checks on one
   thread. It does not recursively delegate or fan out.
3. Claude reads every line of each submitted diff, audits scope and assumptions,
   reruns required checks, walks the criteria against observed evidence and
   records a verdict. Self-checks and a completed report do not accept the work.
4. Rework uses a complete bounded follow-up to the same primary thread. Claude
   rechecks the complete resulting diff and final inputs before accepting it.

Claude may request **one optional read-only verifier per initial/rework result**,
after the primary returns and while it is idle. A Codex verifier uses
`--role verify --sandbox read-only`. A Claude general-purpose verifier
inherits the session model and uses the owner's Claude quota. Give it a specific
doubt, criteria and a stable candidate, then return confirmed defects to the
primary. It never writes or accepts the primary's work. No panels or concurrent
fan-out; at most one corrective verifier follow-up, then an incomplete result
remains unverified.

All deliverable changes receive full Claude acceptance. Wholly read-only answers
and verifier reports use probe acceptance, including independent confirmation
for decision-driving findings; consequential or conflicting claims require full
acceptance. Pair's single-verifier allowance still applies: broader confirmation
requires an explicit mode decision. The shared
[pair rules](../plugins/codex/prompts/protocol/pair.md#pair-mode),
[shared brief and acceptance rules](../plugins/codex/prompts/protocol/core.md#writing-a-brief-every-codex-assignment)
and [run journal](run-journal.md) define the mechanics.

## Rework limits and escalation

The initial result permits at most **two rework rounds total per task**. All
fixes, including verifier findings, share this counter. Answers to pending
questions within a running turn do not consume a round; requests to change a
completed deliverable do. A new phase, thread or mode does not replenish it.
Budget for at most three primary deliveries, plus the optional sequential
verification. If the primary thread becomes unusable, report the required
reassignment rather than silently starting a replacement pair executor.

Finish only when Claude has evidence for every criterion and no blocking
finding remains. At the cap, report unmet criteria, findings, evidence and the
recommended next decision as an incomplete outcome.

- Recommend **ultra** for independent subsystem owners, broad searches,
  competing investigation lenses or an area × lens review matrix. After one
  failed live fix or unexplained live behaviour, request ultra's live-debugging
  fan-out before another fix.
- Recommend **duel** for materially contested designs, high-risk assumptions
  or a change needing a persistent adversary.

Do not silently switch. A persistent switch needs an explicit mode-control
request; settle active ownership and journal open criteria, evidence and consumed
rounds first. Continue only safe work within pair's bounds while that decision
is unresolved.

## Shared state, version and stop rules

Pair uses the same [session record and lifecycle](state-and-retention.md#orchestration-mode-state)
and shared [core protocol](../plugins/codex/prompts/protocol/core.md) plus its own
[pair protocol](../plugins/codex/prompts/protocol/pair.md). Read both files for a
task. Controls do not load the protocol files into Claude's context.
`fugato pair status --for-command` reports both paths and body hashes; each file
is versioned independently.

**Reminder template** (placeholders):

```text
Pair mode on (executor role implement <tuple>, verifier role verify <tuple>, max 2 rework rounds). Apply pair protocol core v<core-hash> + pair v<mode-hash> to substantive tasks; re-read <absolute-core-path> (first line: <!-- Fugato protocol core v<core-hash> -->) and <absolute-pair-path> (first line: <!-- Fugato protocol pair v<mode-hash> -->) unless each file's full text is already in context from an earlier Read. Reminder/preamble version mentions do not count.
```

Round limits are protocol-managed, not runtime counters. Native-first dispatch,
Bash fallback, consent and journal rules are unchanged. Named off/switching
leaves existing jobs running and reports them; conflicting writes must settle
before new assignments. A user stop ends new dispatch immediately. Cancelling
jobs or continuing user-stopped work requires the user's consent; see
[shared controls and stop rules](commands.md#orchestration-controls).
