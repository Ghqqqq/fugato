# Fugato 1.11.0 Upgrade & UX Specification

- **Baseline**: `main` `4696617` (release `1.10.0`)
- **Scope**: Specification only (no implementation, merge, or release here)
- **Authoring discipline**: Every claim cites `file:line`, a reproduced observation, or an attributed peer measurement on `4696617`. Items requiring live `agy` confirmation are explicitly marked as **live gate**.

## 1. Executive Summary & Release Strategy

Release `1.10.0` shipped read-only parent-bridge workspace tools (`workspace_list`, `workspace_grep`, `workspace_git_read`), staged >16 KiB approval artifacts, and Gemini roundtable seats. Live 1.10.0 usage still exposed five high-friction failures:

1. **Chair approval load & replace-all edit hazards**: Edits and commands still park one-by-one (~300 approvals across 9 jobs), and `agy`'s built-in `edit_file` replaces every match of `Target`.
2. **Unenforced Gemini boundaries & Codex/Gemini safety asymmetry**: `agy` runs under `danger-full-access` with zero path/command confinement in `permissionDecision`; only chair vigilance caught `~/.gemini` reads and `npm run build`.
3. **Unsteerable Gemini turns & fatal refusals**: Running Gemini jobs reject `SendMessage` (`GEMINI_BUSY`), while any `Deny` forces `status: "blocked"` (exit 2) and fragments `jobId` lineage.
4. **Slow runtime verification & silent `test:plugin` capture drift**: `test:runtime` takes ~5.5 min, while `test:native` replays captures only in a temp copy and never checks committed `native-captures.mjs`.
5. **Diagnostics, chair ergonomics & observability gaps**: Fragmented readiness checks, 685–855 char per-prompt reminders, brittle journal matching, `agents/` doc drift, a 20-approval truncation bug in `roundtable status`, missing live-pane room totals, and clipped Codex approval cards.

**Core architectural thesis for `1.11.0`**: Solve approval load and boundary safety *together* by shifting routine Gemini worktree edits onto Fugato-confined parent-bridge tools (`workspace_edit`, `workspace_write`) backed by a fail-closed ACP policy gate (`lib/acp-policy.mjs`) and parsed-argv per-job command grants—never by enabling `agy`'s opaque `accept-edits` mode.

## 2. Owner Decisions Respected

- **Built-in worker model defaults stay unchanged**: No changes to `BUILTIN_ROLES`, `BUILTIN_WORKER_DEFAULTS`, `HIGH_STAKES`, or `ANTIGRAVITY_DEFAULT_MODEL`.
- **Gemini sign-in policy / compliant Antigravity auth stays deferred**: Not ranked in `1.11.0` (`D2`); revisit triggers are documented explicitly.

## 3. Priority Roadmap & Dependency Order

### Next Release (`1.11.0`)

| Rank | ID | Work Item | Area | Cost | Risk |
|---|---|---|---|---|---|
| 1 | **U1** | Fail-closed ACP boundary gate & confined parent-bridge write tools (`workspace_edit`, `workspace_write`) with live `fileChange` activity | Boundary safety + Approval load | L | Med-High |
| 2 | **U2** | Scoped per-job parsed-argv command grants & structured `Deny: <guidance>` refusal recovery | Approval load + Refusals + Safety | M | Med |
| 3 | **U3** | Hybrid Gemini mid-turn steering (bridge-boundary drain + bounded in-session follow-up / explicit `--interrupt`) | Mid-turn steering | M | Med-High |
| 4 | **U4** | Verification speed (`test:runtime` split + shared template fixtures) & zero-drift `test:plugin` capture gate | Verification speed | M | Low-Med |
| 5 | **U5** | Unified read-only `fugato doctor` (`--json`, `--offline`) | Onboarding / Diagnostics | S-M | Low |
| 6 | **U6** | Chair ergonomics: compact mode reminders, journal criterion/lineage fixes & `agents/` doc-sync guard | Chair UX / Ergonomics | S | Low |
| 7 | **U7** | Observability fixes: monotonic `approvalTotals` (20-cap bug), `fugato-live` room totals & Codex approval-card clip fix | Observability / UX | S-M | Low |

### Later Work (`1.12+`)

| ID | Work Item | Area | Cost | Gate to Promote |
|---|---|---|---|---|
| **L1** | Incremental seam extraction (`native-agent.mjs` UI renderer & `codex-companion.mjs` domain modules) | Maintainability | M-L | After `1.11.0` behavior stabilizes; extract newly added `1.11.0` modules from day one |
| **L2** | Coalesced approval cards for parallel tool bursts | Approval load | M | Post-`1.11.0` live traces showing multi-approval bursts after `U1`+`U2` |
| **L3** | Persistent Antigravity (`agy`) daemon/broker | Latency / Steering | L | Live telemetry proving per-turn `agy` startup exceeds budget or ACP v2 multiplexing lands |
| **L4** | Live verification harness & staged >16 KiB approval telemetry | Release QA | S-M | First live `1.11.0` pre-release soak on real `agy >= 1.5.16` |
| **L5** | Codex detached-worktree `workspace-write` (`<common>/objects` only) | Boundary safety | M | Live Codex OS-sandbox + detached-worktree `git commit` verification |

### Dropped / Deferred

- **D1 (Dropped)**: Enabling `agy` built-in `accept-edits` / `auto` modes without Fugato-verified confinement.
- **D2 (Deferred by owner)**: Antigravity consumer sign-in policy / compliant API-key auth.
- **D3 (Dropped — owner decision)**: Changing built-in worker model defaults.
- **D4 (Dropped)**: Ad-hoc OS sandbox wrapper (`sandbox-exec`/containers) around `agy`.

**Recommended `1.11.0` execution order**: Land **U4** first (or in parallel with **U1**'s policy library) so every `1.11.0` PR benefits from fast suites and strict capture checks; then **U1** -> **U2** -> **U3** sequentially along the `antigravity.mjs` / `parent-bridge-mcp.mjs` seam; run **U5**, **U6**, **U7** in parallel on disjoint files (`approvalTotals` from **U7** merges cleanly alongside **U1**/**U2** counters).

---

## 4. Next Release (`1.11.0`) Detailed Specifications

### U1. Fail-Closed ACP Boundary Policy & Confined Parent-Bridge Write Tools

#### Problem
Gemini workers run without an OS sandbox and still park for chair approval on every edit inside their own worktree. Meanwhile, Fugato performs no automated path or command confinement before presenting ACP approvals (only chair vigilance stopped `~/.gemini` reads and `npm run build` in 1.10.0), and `agy`'s built-in `edit_file` silently replaces every occurrence of `Target`.

#### Evidence
- **No OS sandbox & no policy gate**: `plugins/codex/scripts/lib/antigravity.mjs:78-80,557` and `lib/backends.mjs:20-26` enforce `danger-full-access`. `permissionDecision` (`antigravity.mjs:388-438`) auto-allows only parent-bridge read/forum tools (`:197-214`) and performs zero path/command validation on built-in `read_file`, `edit_file`, `write_file`, or `run_command`.
- **Replace-all edit hazard**: `tests/antigravity.test.mjs:660-668` shows built-in `edit_file`'s inline payload shape (`{ Path, Target, Replacement }`); replacing every matching occurrence is a live `1.10.0` observation on `agy` that corrupted template strings and burned recovery approvals.
- **Live diff visibility trap (verified in `#8`, `#9`, `#10`)**: `autoAllowedParentBridgeTool` (`antigravity.mjs:197-214`) requires `kind === "other"` and `!call.diffs?.length` (`:522-529`). Naive bridge write tools would render as opaque `dynamicToolCall` entries in `fugato-live` instead of `Update(path) · +N −M` (`activity.mjs:103-145`, `native-agent.mjs:302`), and `antigravity.mjs:744-754` computes `touchedFiles` only from `fileChanges` collected from `tools.values()`.
- **Roundtable worktree nesting nuance**: Roundtable worktrees live inside `<isolatedHome>/duet/roundtables/<roomId>/worktrees/<persona>` (`roundtable-workspaces.mjs:55-61`); any isolated-home denylist must carve out canonical `executionCwd`.
- **Codex vs Gemini safety asymmetry (verified in `#11`, `#12`)**: Codex default jobs run under `danger-full-access` (`setup-config.mjs:386`) and `approvalPolicy: "never+elicitations"` (`codex.mjs:161-166`), bypassing Fugato's approval gate. Simply adding `--sandbox workspace-write` to Codex roundtable seats (`codex-companion.mjs:3575`) breaks detached-worktree `git commit`, because `permission-policy.mjs:58-60` excludes `<common>/objects` and `FORWARDED_APPROVALS` sets `sandbox_approval: false`.

#### Proposed Change
1. **New `plugins/codex/scripts/lib/acp-policy.mjs` (fail-closed gate in `antigravity.mjs:388-438`)**:
   - Canonicalize target paths via `realpathSync` (or nearest existing ancestor for new files) against `executionCwd` before deciding, evaluating rules in this exact order:
     - **(a) Own worktree carve-out**: if the canonical target is inside canonical `executionCwd`, it passes the boundary gate **except** for any `.git` path component. Passing (a) does not auto-approve built-in ACP tools; built-in `edit_file`/`write_file`/`run_command` still park for approval unless `U2` grants or the parent-bridge auto-allow apply.
     - **(b) Sensitive-home denylist**: otherwise auto-deny any read/write/command referencing `~/.claude`, `~/.codex`, `~/.gemini`, or `resolveIsolatedCodexHome()` (blocking sibling roundtable worktrees, `room.json`, `jobs/`, and auth/config files without waking the chair).
     - **(c) Unconditional `.git` & out-of-worktree write denial**: always auto-deny direct writes to any `.git` path component (`/.git(/|$)`) and to resolved worktree `gitdir`/`commondir`, plus any write outside canonical `executionCwd` — enforced identically for built-in ACP tools and for `workspace_edit`/`workspace_write`.
   - **Forbidden command auto-deny**: auto-deny built-in `run_command` requests matching forbidden commands (`npm run build`, `npm run verify`, `git push`, `npm publish`, `npm install`, destructive `rm -rf` outside `executionCwd`) or unparseable shell chains targeting protected paths with structured reason codes before parking.
   - **Native `edit_file` ambiguity guard**: When built-in `edit_file` targets a file inside `executionCwd`, count occurrences of `Target`. If `count > 1`, prepend a bold warning (`AMBIGUOUS: replaces N occurrences; prefer workspace_edit`) on the approval card and never auto-allow; if `count === 0`, prepend a warning (`NO MATCH: Target not found; check text or prefer workspace_edit`) on the approval card rather than auto-denying via `reject_once` (so a typo does not abort the Gemini turn).
   - **Honesty boundary**: Document in `docs/antigravity.md` and `agents/gemini-native.md` that Fugato only gates tool calls `agy` submits via `session/request_permission`, and that Codex seats remain kernel-sandboxed only when `--sandbox read-only|workspace-write` is set (deferring Codex detached-worktree `workspace-write` with `<common>/objects` to `L5`).
2. **New `plugins/codex/scripts/lib/workspace-write-tools.mjs` registered in `parent-bridge-mcp.mjs` and `autoAllowedParentBridgeTool`**:
   - **`workspace_edit({ path, target, replacement, replace_all = false, expected_occurrences })`**:
     - Confined via `acp-policy.mjs` rules (a)–(c) (rejects `..`, symlink escapes, any `.git` component or resolved `gitdir`/`commondir`, and protected roots).
     - Defaults to **single-match only**: returns `{ isError: true, content: [{ type: "text", text }] }` (never killing the Gemini turn!) if `target` matches 0 times or >1 time unless `replace_all: true` or `expected_occurrences` equals the exact match count.
     - Enforces atomic write (temp file in same dir + rename) and per-call size cap (e.g., 256 KiB).
   - **`workspace_write({ path, content, mode = "create" | "overwrite" | "append" })`**:
     - Same `acp-policy.mjs` confinement + `.git` exclusion + symlink refusal + 256 KiB cap; creates parent directories only inside canonical `executionCwd`.
   - **Live diff visibility & `touchedFiles` merge**: On successful `workspace_edit`/`workspace_write`, `parent-bridge-mcp.mjs:172` (which already holds `job`) computes line `+added`/`-removed` counts, appends a structured `fileChange` activity entry (`activity.mjs:103-145`), and records the workspace-relative path on the job record (e.g., `bridgeTouchedFiles`); `antigravity.mjs` suppresses duplicate `dynamicToolCall` chatter for these two tools and unions `bridgeTouchedFiles` into `touchedFiles` at `antigravity.mjs:744-754`.
   - **Prompt alignment**: Update `GEMINI_WORKSPACE_GUIDANCE` (`antigravity.mjs:233-234`), `plugins/codex/prompts/worker-task.md`, `plugins/codex/prompts/protocol/roundtable.md`, and `plugins/codex/agents/gemini-native.md` to direct Gemini workers to prefer `workspace_edit` / `workspace_write` over built-in `edit_file` / `write_file`.

#### User-Visible Benefit
Eliminates the majority of routine per-edit chair approvals (the largest slice of 1.10.0's ~300 approvals), prevents silent replace-all file corruption, blocks out-of-bounds reads/writes before they ever notify the chair, and keeps `fugato-live` / native agent `Update(path) · +N −M` diff lines intact.

#### Cost
**L** (~600–850 LOC across `acp-policy.mjs`, `workspace-write-tools.mjs`, `parent-bridge-mcp.mjs`, `antigravity.mjs`, prompt/doc updates, and unit + fake-ACP tests).

#### Risk
- **Symlink / TOCTOU escapes**: Mitigate by canonicalizing the target or nearest existing parent via `realpathSync`, rejecting symlink targets with `lstatSync`, and refusing `.git` path components at every depth.
- **Model continues calling built-in `edit_file`**: Mitigate via prompt guidance, zero-friction auto-allowed `workspace_edit`, and keeping native `edit_file` parked with ambiguity warnings (never auto-allowed).
- **Bridge bypass outside ACP**: Explicitly documented; kernel-enforced sandboxing remains Codex's role (`--sandbox read-only|workspace-write`).

#### Acceptance Criteria
1. Built-in ACP requests targeting `~/.claude`, `~/.codex`, `~/.gemini`, or `resolveIsolatedCodexHome()` outside canonical `executionCwd` are auto-denied locally without creating a `pendingQuestion` or waking the parent.
2. Roundtable worktree paths inside `<isolatedHome>/duet/roundtables/<roomId>/worktrees/<persona>` remain writable by their owning worker, while sibling worktrees and `<isolatedHome>/config.toml` are denied.
3. Built-in `run_command` requests matching forbidden commands (`npm run build`, `npm run verify`, `git push`, `npm publish`) are auto-denied with a structured code before parking.
4. `workspace_edit` rejects 0-match and multi-match targets by default with `{ isError: true }` (keeping the turn alive), succeeds when unique or `replace_all: true`, and refuses symlink/`.git/`/out-of-worktree paths.
5. Successful `workspace_edit` and `workspace_write` calls auto-allow via parent bridge, record `fileChange` activity with relative path and `+added`/`-removed` counts, render `Update(path)`/`Write(path)` in native logs and `fugato-live`, and merge into `touchedFiles` at `antigravity.mjs:744-754`.
6. Built-in `edit_file` with >1 occurrences of `Target` displays an ambiguity warning on the approval card and is never auto-allowed; built-in `edit_file` with 0 occurrences displays a `NO MATCH` warning on the card rather than auto-denying via `reject_once`.
7. **Post-ship live gate (not a CI acceptance criterion)**: Any aggregate approval-reduction target (e.g., cutting routine edit/command approvals in real Gemini sessions) is evaluated post-ship via `approvalTotals` (`U7`), never as a live-`agy` CI assertion.

#### Verification Commands
```sh
node --test tests/acp-policy.test.mjs tests/workspace-write-tools.test.mjs tests/antigravity.test.mjs tests/antigravity-cli.test.mjs tests/roundtable-gemini.test.mjs tests/docs-sync.test.mjs
claude plugin test plugins/codex && claude plugin test plugins/codex-live
```
*(Chair release gate only, not for delegated workers: `npm run verify`.)*

---

### U2. Scoped Per-Job Parsed-Argv Command Grants & Structured `Deny: <guidance>` Refusal Recovery

#### Problem
Even after moving reads (`1.10.0`) and edits (`U1`) to parent-bridge tools, repeated read-only verification commands (`node --test ...`, `claude plugin test ...`, `git diff`) still park one-by-one. Conversely, when the chair denies a single unsafe or wrong-headed ACP request, two layers force the entire Gemini turn into `status: "blocked"` (exit 2) without explaining why, creating a fragmented continuation `jobId`.

#### Evidence
- **Single-use approvals only**: `antigravity.mjs:399-413` and `JobRuntime.approval` (`job-runtime.mjs:891-901`) accept only fixed `ACTION_APPROVAL_OPTIONS` (`"Allow once"` or `"Deny"`) returning `"once" | "deny"`; no runtime per-job grant store or guidance payload exists.
- **Display-only shell parser already duplicated**: `native-agent.mjs:345-405` (`commandParts`, with chain splitting and a `<160`-char display cap at `:368`) and `plugins/codex-live/hooks/layout.ts:413-459` parse commands for display folding only, not security enforcement.
- **Two-layer denial -> `blocked` trap (verified in `#8`, `#10`, `#11`)**:
  - ACP v1 `RequestPermissionOutcome` (`antigravity.mjs:32-35`) carries only `reject_once` with no reason text; `docs/antigravity.md:208-209` notes `agy` usually stops the turn on `Deny`.
  - Even when `agy` continues to `end_turn` (`tests/antigravity.test.mjs:71-84`), `antigravity.mjs:434-437` unconditionally pushes `approval_denied` into `blockers` (`:750-752` adds another on `failedPermissionCheck`), and `worker-report.mjs:112-113,137` + `job-runtime.mjs:252-253` force `status: "blocked"` (exit 2 at `codex-companion.mjs:1334`, per `plugins/codex/CHANGELOG.md:529`).

#### Proposed Change
1. **Shared `plugins/codex/scripts/lib/command-classify.mjs` & runtime-only per-job command grants**:
   - Build a dedicated fail-closed argv parser in `lib/command-classify.mjs` that **does not** reuse `commandParts`'s chain splitting or `<160`-char cap (`native-agent.mjs:345-405,368`): **rejecting any unquoted shell operator outright** (`;`, `&&`, `||`, `|`, `&`, `>`, `<`, `$(`, `` ` ``, newlines, subshells, globs/expansions, or env-prefix overrides) is the security contract.
   - Update `JobRuntime.approval` (`job-runtime.mjs:891-901`) to accept dynamic card `options` (`Allow once`, `Deny`, plus **`Allow "<prefix>" for this job`** only when the command is parseable and policy-eligible — never on forbidden commands, destructive ops, or arbitrary `sh -c`/`node -e`) and return a structured `{ decision: "once" | "job_grant" | "deny", guidance?: string }` result.
   - Store grants strictly in-memory on the active `jobId` (audited in job activity, **never persisted to `config.toml`** and **never inherited** across `--to`/`--thread`/`--continue`).
   - Re-evaluate every subsequent matching command through `acp-policy.mjs` (path args inside `executionCwd`, no protected paths, no forbidden flags like `--eval`/`-e`) before auto-allowing and incrementing `approvalTotals.autoAllowed` (`U7`).
2. **Structured `Deny: <guidance>` & refusal severity split**:
   - Extend `Answer <questionId>` for `action-approval` (`antigravity.mjs:405-413`, `job-runtime.mjs:891-901`, `native-agent.mjs:1305-1321`) to accept `Deny: <guidance>` (up to 1,000 chars) alongside exact `Deny`, `Allow once`, and eligible `Allow "<prefix>" for this job`, returning `{ decision: "deny", guidance }` to `antigravity.mjs`.
   - Distinguish **soft/guided denial** (chair supplied guidance and the worker recovers cleanly to `end_turn`) from **hard/unrecovered denial**: record soft denials in `report.deniedActions[]` + `notice` instead of unconditionally forcing `status: "blocked"` when the turn later finishes cleanly with zero unresolved denials.
   - **Live gate + deterministic fallback (per chair `#13`)**:
     - **Phase A (guaranteed, zero live ACP assumptions)**: Send ACP `reject_once`; persist `<guidance>` onto the job's steering/denial queue so if `agy` continues the turn, the next parent-bridge tool result delivers `[Chair denial guidance]: ...`, and if `agy` exits on `reject_once`, Fugato deterministically records the guidance on the job and surfaces it pre-populated in `next` for the chair's continuation (no automatic respawn).
     - **Phase B (gated on live `agy >= 1.5.16` probe)**: If live probe confirms sequential `session/prompt` succeeds on the same `AcpClient` after `reject_once` ends a turn, deliver `<guidance>` via one in-session `session/prompt` on the same `jobId`, summing `usage` across sub-prompts. If the probe fails, Phase A remains active with no claim of same-turn recovery.

#### User-Visible Benefit
Repetitive test/lint runs (`node --test`, `claude plugin test`, `git diff`) require only one approval per job, and denying a mistaken worker action gives the worker concrete direction instead of blindly aborting the turn as `blocked` and fragmenting job history.

#### Cost
**M** (~350–500 LOC across `command-classify.mjs`, `acp-policy.mjs`, `antigravity.mjs`, `worker-report.mjs`, `native-agent.mjs`, docs/prompts, and tests).

#### Risk
- **Shell-injection bypass of prefix grants**: Mitigated by fail-closed argv parsing rejecting all shell metacharacters, subshells, redirects, and env overrides, plus re-running `acp-policy.mjs` on every auto-allowed invocation.
- **Over-permissive cross-job inheritance**: Mitigated by keeping grants strictly in-memory on the active `jobId` (never persisted, never inherited across `--to`/`--thread`/`--continue`).
- **False-green masking of hard refusals**: Mitigated by clearing `blocked` ONLY on chair-guided soft denials where the turn subsequently completes cleanly without unresolved denials; unguided `Deny` and policy hard-denials retain existing `blocked` (exit 2) semantics unless the chair explicitly supplied guidance and the worker recovered.

#### Acceptance Criteria
1. Parseable read-only/test commands (`node --test ...`, `claude plugin test ...`, `git diff ...`) display a third option `Allow "<prefix>" for this job`; commands with pipes, redirects, chains (`&&`, `;`, `|`), substitutions (`$()`, backticks), or forbidden commands never offer a job grant.
2. After granting `Allow "node --test" for this job`, a second `node --test <other-rel-path>` auto-allows without parking, increments `approvalTotals.autoAllowed`, and logs an audited activity entry; `node --test a && rm -rf /` or `node --test ../../outside` is refused/parked.
3. Per-job grants do not persist to `config.toml` and do not carry over to a continuation or new job on the same session.
4. Answering `Answer <questionId>\nDeny: use workspace_grep instead` records the guidance; if the worker completes cleanly (`end_turn`) with no unresolved denials, `status` is `completed` (not `blocked`) with the refusal recorded in `deniedActions[]` and `notice`.
5. Unguided `Deny` preserves `approval_denied` / `status: "blocked"` (exit 2), and `denied` commands remain excluded from `checks.ran`.
6. Phase B in-session re-prompt on the same `AcpClient` stays disabled behind a live-verified capability gate unless `agy >= 1.5.16` passes the documented live probe; Phase A fallback works without live ACP assumptions.

#### Verification Commands
```sh
node --test tests/command-classify.test.mjs tests/antigravity.test.mjs tests/antigravity-cli.test.mjs tests/worker-report.test.mjs
claude plugin test plugins/codex
```

---

### U3. Hybrid Gemini Mid-Turn Steering (Sideband Drain + Gated In-Session Follow-Up / `--interrupt`)

#### Problem
While a Gemini worker is actively running, the chair cannot steer, narrow scope, or deliver roundtable updates mid-turn: `SendMessage` is unconditionally rejected with `GEMINI_BUSY`, and forum notices wait until the turn ends.

#### Evidence
- **Hard hook refusal**: `plugins/codex/hooks/steering.mjs:29-31` returns `{ isDelivered: false, reason: GEMINI_BUSY }` whenever a `fugato:gemini-native` worker has `status === 'running'`.
- **Runtime steering exclusion**: `plugins/codex/scripts/lib/steering.mjs:92` immediately marks `antigravity` rows `deferred` (`backend_unsupported`), and `hooks/roundtable-notifier.mjs:364` skips running Gemini seats.
- **6s Codex poll withdrawal trap (verified in `#17`)**: `lib/steering.mjs:103-118` withdraws unconsumed `queued` rows after 6,000 ms with `fallback: true`, handing them back to `next(e)` (host queue). Gemini workers often spend >6s between bridge tool calls. `hooks/steering.mjs:50-57` already accepts `status: "queued"` (`fallback: false`) as delivered, though `:52-57` hardcodes `"Codex steering ..."` notices and failure reasons.
- **Proven sideband seam & guard caveat (`#37`)**: `plugins/codex/scripts/parent-bridge-mcp.mjs:126-136` (`withUnreadFooter`) appends dynamic text to bridge replies, but line `:127` skips `toolName === "forum_read"` and `!job?.request?.roundtable`. `acp-client.mjs` has no ACP v1 `turn/steer` RPC (`session/cancel` and `session/prompt` exist).

#### Proposed Change
1. **Durable Gemini steering queue (`lib/steering.mjs`, `hooks/steering.mjs`, `hooks/roundtable-notifier.mjs`)**:
   - Remove the unconditional `GEMINI_BUSY` refusal at `hooks/steering.mjs:29-31`; route running Gemini `SendMessage` through the `fugato steer` path while preserving `pendingQuestion` (`state.status === 'needs_answer'` -> `next(e)` so `Answer <questionId>` routes untouched).
   - In `lib/steering.mjs:92-120`, for `backend === "antigravity"`: when active and no `pendingQuestion`, persist the row in `<jobId>.steering.json` and return immediately with `{ status: "queued", fallback: false }` (bypassing Codex's 6s withdrawal loop). Update `hooks/steering.mjs:52-57` (both system notice and failure reason) to use backend-aware labels (`"Gemini steering ..."` vs `"Codex steering ..."`).
   - **`roundtable-notifier.mjs:364` disposition**: Keep active Gemini roundtable seats skipped by `roundtable-notifier.mjs:364` (`if (job.request?.backend === 'antigravity' && active(job)) return;`) in `1.11.0`, since active roundtable seats already receive forum unread notices on bridge tool calls via `withUnreadFooter` (`parent-bridge-mcp.mjs:126-136`); this avoids duplicate forum/steering noise and reserves `.steering.json` for direct chair `SendMessage` steers.
2. **Phase A — Bridge tool-boundary drain (guaranteed, zero live ACP assumptions)**:
   - Add a dedicated `withSteeringFooter` helper in `parent-bridge-mcp.mjs` that runs **independently of `withUnreadFooter`'s `:127` guards** (never skipping `forum_read` or non-roundtable jobs): on every `workspace_*`, `forum_*`, or `ask_parent` reply for an active Antigravity job, atomically drain undelivered rows from `<jobId>.steering.json` (marking `applied` with `appliedAt`) and append `[Chair steering update — apply immediately]`.
   - If the Gemini turn reaches `end_turn` with unconsumed queued steers still present, surface `unconsumedSteers` on the report and deliver them either via Phase B (if gate passes) or deterministic host-queue / single-command continuation fallback.
3. **Phase B — Explicit `--interrupt` & bounded in-session follow-up (LIVE GATE, per chair `#13`)**:
   - **Pre-implementation gate**: Run a manual live probe on `agy >= 1.5.16` testing (a) sequential `session/prompt` after `end_turn` and (b) `session/cancel` followed by `session/prompt` on the same `AcpClient`.
   - **If gate passes**: Support `fugato steer <jobId> --interrupt` (and native `STEER --interrupt:` prefix) to issue `session/cancel` and submit the queued steer as an in-session `session/prompt` on the same `jobId`, summing `usage` across sub-prompts (bounded to max 5 in-session re-prompts per job).
   - **If gate fails**: Keep `--interrupt` disabled with an explicit capability error (`antigravity_interrupt_unsupported`) and rely solely on Phase A sideband drain + end-of-turn continuation; never claim unverified in-session re-prompting works.

#### User-Visible Benefit
The chair can redirect a running Gemini worker mid-turn via ordinary `SendMessage` instead of hitting `GEMINI_BUSY`, waiting minutes for wasted work, or killing the job.

#### Cost
**M** (~300–450 LOC across `lib/steering.mjs`, `hooks/steering.mjs`, `parent-bridge-mcp.mjs`, `antigravity.mjs`, `fake-antigravity.mjs`, and tests).

#### Risk
- **Pure-reasoning turns with zero bridge calls**: Sideband drain only fires on parent-bridge calls; mitigated by reporting `unconsumedSteers` on exit and documenting `--interrupt` (when Phase B passes live probe) or end-of-turn delivery.
- **Duplicate delivery across sideband and host queue**: Mitigated by returning `{ status: "queued", fallback: false }` immediately for active Gemini jobs and atomically marking `applied` under the inbox lock before emitting the tool footer.
- **Live ACP `session/cancel` -> `session/prompt` incompatibility**: Mitigated by gating Phase B strictly on a pre-release live probe on real `agy >= 1.5.16` with Phase A fully functional standalone.

#### Acceptance Criteria
1. Sending `SendMessage` to a running Gemini worker without a `pendingQuestion` enqueues a row in `<jobId>.steering.json`, returns `{ isDelivered: true }` immediately without waiting 6s or falling back to `next(e)`, and emits a Gemini-labeled notice.
2. Sending `Answer <questionId>` while `state.status === 'needs_answer'` bypasses steering and resolves the parked approval/question unchanged.
3. The next `workspace_*`, `forum_*`, or `ask_parent` call on that `jobId` atomically marks queued rows `applied`, appends the chair steering footer once, and never replays applied rows on subsequent tool calls.
4. A turn that ends with unconsumed queued steers surfaces `unconsumedSteers` in the job result (or feeds one bounded in-session follow-up if Phase B's live gate is enabled).
5. When Phase B is enabled in fake-ACP tests, `--interrupt` cancels the active turn, issues an in-session `session/prompt` on the same `jobId`, sums `usage`, and enforces the max-5 re-prompt cap; when disabled, `--interrupt` fails cleanly with `antigravity_interrupt_unsupported`.

#### Verification Commands
```sh
node --test tests/antigravity.test.mjs tests/antigravity-cli.test.mjs tests/antigravity-lifecycle.test.mjs tests/roundtable-gemini.test.mjs
claude plugin test plugins/codex
```

---

### U4. Verification Speed & Zero-Drift `test:plugin` Capture Gate

#### Problem
A full `npm run test:runtime` takes ~5.5 min because two monolithic test files run serially and spawn hundreds of redundant `git` processes / sleep waits. Simultaneously, workers skipped `test:plugin`, and `test:native` silently hides replay-capture drift in committed `native-captures.mjs`, letting regressions slip until the chair's final `npm run verify`.
#### Evidence
- **Measured serial stragglers (`#14`, `#16`, `#17` on `4696617`)**:
  - `tests/worker-lifecycle.test.mjs` (2,775L, 43 tests): **256.5–258.5s** — literally the entire wall-clock ceiling of a 12-suite `--test-concurrency=6` run (`258.5s`, `#17`). Its top 5 tests consume **167.6s (~65%)**, led by a 12-subtest sequential block (`submission records...`, **53.04s**) and a 5-subtest block (`automatic inferred-turn recheck...`, **35.73s**; `#16`).
  - `tests/worker-report.test.mjs` (1,985L, 28 tests): **168.3–175.8s** (top 4 tests **84.5s / ~50%**; `#16`).
  - `tests/runtime.test.mjs` (1,996L, 51 tests): **84.2–90.9s** (already uses a local `.git` template copy + per-behavior cached executable at `:35-61`, averaging ~1.7s/test vs ~6.0s/test in `worker-lifecycle` & `worker-report`).
  - `claude plugin test plugins/codex` (`test:plugin`, **7.6–8.0s**) + `plugins/codex-live` (`test:live`, **2.6–3.2s**) total only **10.2–11.3s** (`#14`, `#17`).
- **Global 5-spawn `initGitRepo` & unmigrated fixture wrappers (`#11`, `#12`)**: `tests/helpers.mjs:98-104` runs `git init` + 4 `git config` spawns on every call across 20+ suites (`tests/test-environment.mjs:20` already provides `GIT_CONFIG_GLOBAL`). `runtime.test.mjs:44-61` and `native-integration.mjs:42-57` still generate one script per `behavior` via `generateFakeCodex(..., { mutable: true })` instead of `linkStaticExecutable` (`tests/fake-codex-fixture.mjs:26`).
- **Capture-drift blind spot (`#8`, `#11`)**: `plugins/codex/tests/native-integration.mjs:4738-4766` (`replayCaptures`) writes freshly generated captures to a *temp copy* and runs `claude plugin test <tempCopy>`, never checking committed `plugins/codex/tests/native-captures.mjs` (7,571L; broke at `:7419,7504` on `READY`/`NATIVE_GUIDE` edits). `:4751` also hardcodes a 5-file `scripts/lib/` copy list, while `native-agent.test.ts:235-245` accumulates 4 `.replaceAll(...)` shims.

#### Proposed Change
1. **Eliminate the 258s ceiling & 53s single-test floor**:
   - Promote `.git` template copy + one-time `GIT_CONFIG_GLOBAL` keys into `tests/helpers.mjs:initGitRepo`, and migrate `runtime.test.mjs`/`native-integration.mjs` non-mutable fixtures onto `linkStaticExecutable`.
   - Split `worker-lifecycle.test.mjs` and `worker-report.test.mjs` into focused files (~8–12 tests each) AND parallelize isolated `makeTempDir()` subtests inside the 53s/36s/36s mega-tests (`{ concurrency: true }`), scaling test-only `BROKER_IDLE_SEC`/`OWNER_GRACE_SEC` overrides where timing is not under test.
2. **Close `test:plugin` capture drift & add `npm run test:fast`**:
   - In `native-integration.mjs:4738-4766`, assert the generated capture equals committed `native-captures.mjs` (failing with `Run UPDATE_NATIVE_CAPTURES=1 npm run test:native` on mismatch), remove the 4 `.replaceAll` shims in `native-agent.test.ts:235-245` by normalizing or regenerating captures cleanly, and copy all of `plugins/codex/scripts/lib/` instead of the hardcoded 5-file list at `:4751`.
   - Add `npm run test:hooks` (`test:plugin && test:live`, ~11s) and `npm run test:fast` (targeted unit + `docs-sync` + `test:hooks`) and reference `test:hooks` in worker checklists (`worker-task.md`, `protocol/core.md`).

#### User-Visible Benefit
Cuts full `npm run test:runtime` wall time from ~5.5 min to <120s (target <90s), gives workers an ~11s hook/capture sanity check (`test:hooks`), and eliminates surprise `test:plugin` failures at release verification.

#### Cost
**M** (test file reorganization, fixture sharing in `tests/helpers.mjs`, capture-equality check in `native-integration.mjs`, script/doc updates).

#### Risk
- **Flaky parallel subtests**: Mitigated by enabling `{ concurrency: true }` ONLY on subtests that allocate disjoint `makeTempDir()` + isolated `CODEX_HOME`/socket paths, verified over 3 consecutive runs.
- **Over-aggressive timeout reduction hiding real race conditions**: Mitigated by keeping dedicated timing-contract tests (`broker-startup.test.mjs`, explicit owner-grace tests) at full assertions while trimming idle waits only on non-timing tests.

#### Acceptance Criteria
1. `npm run test:runtime` passes with zero skipped assertions and total passing test count **>= the `4696617` baseline** in **<= 120s** (stretch <= 90s) at `--test-concurrency=6` on developer macOS hardware, with no single test file exceeding 75s.
2. `tests/helpers.mjs:initGitRepo` uses a cached `.git` template copy + `GIT_CONFIG_GLOBAL` instead of 5 per-call `git` spawns; `runtime.test.mjs` and non-mutable `native-integration.mjs` fixtures use `linkStaticExecutable`.
3. `plugins/codex/tests/native-integration.mjs` fails whenever generated captures differ from committed `plugins/codex/tests/native-captures.mjs` (unless `UPDATE_NATIVE_CAPTURES=1`), copies all of `plugins/codex/scripts/lib/`, and `native-agent.test.ts` carries zero `.replaceAll` wording shims.
4. `npm run test:hooks` runs both `claude plugin test plugins/codex` and `claude plugin test plugins/codex-live` in <15s and is documented in `worker-task.md` and `protocol/core.md`.

#### Verification Commands
```sh
node --test tests/worker-lifecycle*.test.mjs tests/worker-report*.test.mjs tests/runtime.test.mjs tests/docs-sync.test.mjs
claude plugin test plugins/codex && claude plugin test plugins/codex-live
```
*(Chair gate for capture drift check: `node --test plugins/codex/tests/native-integration.mjs`.)*

---

### U5. Unified Read-Only `fugato doctor` (`--json`, `--offline`)

#### Problem
Readiness checks and failure modes are scattered across `fugato setup`, `fugato setup --backend antigravity`, `fugato runtime status`, and hidden markers like `native-unavailable.json`. Users hit opaque failures (e.g., `permission_mapping=claude` silently disabling Gemini seats, stale `native-unavailable.json` tripping `auto` fallback, or `agy < 1.5.15` breaking continuation) only mid-dispatch.

#### Evidence
- **Fragmented diagnostics**: `buildSetupReport` (`plugins/codex/scripts/codex-companion.mjs:533-605`) inspects only Codex; Antigravity readiness sits behind a separate branch (`:657-666`), and broker/state health behind `runtime status` (`:2812-2838`).
- **Silent cross-feature conflicts**: `permission_mapping = "claude"` (`setup-config.mjs:520-525`) breaks Gemini tasks (`codex-companion.mjs:2077`) and Gemini roundtable seats (`:3565`), yet has no single pre-flight summary.
- **Hidden dispatch degradation**: `setup-config.mjs:549,730` writes `<isolatedHome>/duet/native-unavailable.json` (`native-agent.mjs:36,50,1331`), causing `auto` dispatch to route to Bash fallback for 24h without a unified health command explaining why.
- **Version / login sensitivity**: `antigravity.mjs:37-55,68-73` resolves `agy` and catches auth failures only at launch; `agents/gemini-native.md:3` notes continuation requires `agy >= 1.5.15`.

#### Proposed Change
1. **New `plugins/codex/scripts/lib/doctor.mjs` + `fugato doctor` CLI subcommand & `/fugato:doctor` slash command**:
   - Strictly **read-only** (mutates zero config, markers, or broker state); supports `--json` and `--offline` (skips live network/auth probes).
   - Register `doctor` options in `plugins/codex/scripts/lib/command-options.mjs` and allowlist read-only `doctor` in `plugins/codex/scripts/duet-permission-hook.mjs:91-92` so Claude can run `fugato doctor` without extra shell prompts.
   - Evaluates and reports typed checks (`pass` | `warn` | `fail`, `code`, `detail`, `fix`):
     1. **Codex backend**: isolated `codex` executable, version, isolated home (`resolveIsolatedCodexHome()`), auth status (skipped under `--offline`).
     2. **Antigravity backend**: `resolveAntigravityExecutable()`, `agy --version` check (`>= 1.5.15` for continuation), cached auth / ACP initialize probe (skipped under `--offline`).
     3. **Native hooks, `fugato-live` & dispatch**: saved `--dispatch` mode, presence/age of `native-unavailable.json`, `fugato-live` companion plugin presence/manifest sanity.
     4. **Configuration conflicts**: warns/fails clearly when `permission_mapping=claude` conflicts with Gemini roles/seats, or saved `--sandbox` != `danger-full-access` affects `gemini-native`.
     5. **Broker, admission locks & state health**: broker socket liveness/PID lock, dead-owner admission locks, stale lock files, active jobs, disk usage of staged approval artifacts (`approval-artifacts.mjs`).
   - Exit codes: `0` (all pass / warnings only), `1` (one or more `fail` checks). Never prints tokens, cookies, or secrets.

#### User-Visible Benefit
One read-only command diagnoses Codex, Gemini, hooks, `fugato-live`, config conflicts, admission locks, and broker health in seconds with copy-pasteable remediation commands and machine-readable JSON for CI/bug reports.

#### Cost
**S-M** (~250–350 LOC in `lib/doctor.mjs` reusing existing setup/runtime helpers, CLI/command/permission-hook wiring, docs, and unit tests).

#### Risk
- **Slow or hanging probes**: Mitigate with hard per-probe timeouts (e.g., 3s), `--offline` mode for air-gapped/CI environments, and zero mutations.
- **Secret leakage in `--json` output**: Mitigate by emitting only booleans/versions/redacted paths and testing redaction explicitly.

#### Acceptance Criteria
1. `fugato doctor --offline --json` completes in <2s without network access, creates/modifies zero files in `CODEX_HOME`, and returns a stable schema `{ ok, checks: [{ id, status, code, summary, fix }] }`.
2. Detects and reports actionable `fix` text for: missing `agy`, `agy < 1.5.15`, active `native-unavailable.json` marker, missing/broken `fugato-live`, `permission_mapping=claude` conflict with Gemini roles, dead-owner admission locks, and stale broker socket/lock.
3. Read-only `fugato doctor` is allowlisted in `duet-permission-hook.mjs` and `command-options.mjs`, and exits `0` on healthy/warn-only setups and `1` when any check has `status: "fail"`.
4. `/fugato:doctor` command and `docs/commands.md` pass `tests/docs-sync.test.mjs`.

#### Verification Commands
```sh
node --test tests/doctor.test.mjs tests/docs-sync.test.mjs tests/cli-validation.test.mjs
```

---

### U6. Chair Ergonomics: Compact Mode Reminders, Run-Journal Fixes & `agents/` Doc-Sync Guard

#### Problem
Three recurring UX irritants tax every active session: (1) mode reminders inject 677–855 chars on every single user prompt, (2) run-journal verdicts reject ordinal indices (`1`/`#1`) and ASCII `...` prefixes while leaving superseded continuation ancestors flagged as `no_verdict`, and (3) `plugins/codex/agents/gemini-native.md:43` still contradicts 1.10.0 staged approvals because `docs-sync.test.mjs` omits `agents/`.

#### Evidence
- **Measured reminder bloat (`#10`, `#17`)**: `ultra-codex-mode.mjs:222-235` emits **847–855 chars** (`ultra`), **754–762** (`roundtable`), **696–704** (`duel`), and **677–685** (`pair`) per prompt by repeating full absolute paths twice, duplicating both 8-char hashes, and embedding the 13-role summary on every `ultra` prompt. Note `tests/ultra-codex-mode.test.mjs:144-188` asserts mid-session `agy` availability changes and saved `--role-model` overrides remain visible in `reminderText`.
- **Journal criterion & lineage bugs (`#8`, `#17`)**: `plugins/codex/scripts/lib/run-journal.mjs:241-253` only matches exact criterion strings or unique prefixes ending in Unicode `…` (`renderRun:565` displays `1.`, `2.`, ...). In `viewAt` (`:480-515`), line `:491` compares `verdictOrder.get(job.jobId) > verdictOrder.get(parentId)` (always `false` when `parentId` has no verdict), and `:508` never excludes resolved/superseded `continuationOf` ancestors from `no_verdict`.
- **`agents/` doc-sync blind spot (`#10`, `#12`)**: `plugins/codex/agents/gemini-native.md:43-44` still states `"Fugato denies questions over the 16 KiB display limit"`, while `tests/docs-sync.test.mjs:136-141` scans `docs/`, `commands/`, `skills/`, `prompts/`, omitting `plugins/codex/agents/`.

#### Proposed Change
1. **Compact `reminderText` (`ultra-codex-mode.mjs:222-235`)**: Emit one relative/shared protocol dir + compact `<file>@<hash>` pairs, replace the full 13-role table with `roles: default (Gemini on|off)` unless `--role-model` overrides exist (listing only overridden roles), targeting **<= 280 chars** across all 4 modes while preserving dynamic `agy`/override tests (`ultra-codex-mode.test.mjs:144-188`).
2. **Run-journal ergonomics (`run-journal.mjs:241-253,480-515`, `codex-companion.mjs:152-168`)**:
   - In `fugato journal add verdict` (stdin JSON `{ jobId, verdict, criteria, resolves?: [...] }`), accept 1-based ordinal selectors (`1`, `#1`), exact text, or unique prefixes ending in either Unicode `…` or ASCII `...` (rejecting ambiguous prefixes clearly).
   - Fix both `:491` and `:508`: when a verdict on a continuation job (linked via `continuationOf` or explicit stdin JSON `resolves`) resolves the lineage, clear `no_verdict` on superseded ancestor jobs in that chain while leaving unjudged independent jobs flagged.
3. **Fix `gemini-native.md:43` & extend `docs-sync.test.mjs:136-141`**: Update `plugins/codex/agents/gemini-native.md:43-44` to reflect 1.10.0 staged >16 KiB approvals, and include `plugins/codex/agents` in `docs-sync.test.mjs` scans.

#### User-Visible Benefit
Cuts per-prompt reminder overhead by ~65–70%, makes journal verdicts fast and typo-proof without bogus `no_verdict` noise on continuations, and closes agent-prompt documentation drift in CI.

#### Cost
**S** (~120–180 LOC across `ultra-codex-mode.mjs`, `run-journal.mjs`, `gemini-native.md`, `docs-sync.test.mjs`, and unit tests).

#### Risk
- **Over-clearing unjudged independent jobs**: Mitigated by clearing `no_verdict` ONLY along explicit `continuationOf` / `resolves` ancestry chains and testing independent unjudged jobs remain flagged.
- **Breaking existing reminder assertions**: Mitigated by keeping `ultra-codex-mode.test.mjs` dynamic `agy` and override detection invariants passing.

#### Acceptance Criteria
1. `reminderText()` for `ultra`, `roundtable`, `duel`, and `pair` is **<= 280 chars** with no overrides, still reflects mid-session `agy` on/off and saved `--role-model` overrides, and passes updated `ultra-codex-mode.test.mjs`.
2. `fugato journal add verdict` (stdin JSON `criteria[].criterion`) accepts `1`, `#1`, ASCII `prefix...`, and Unicode `prefix…`, rejecting out-of-range or ambiguous selectors with a clear error.
3. Recording an accepted verdict on a `continuationOf` child job clears both `open_rework` and `no_verdict` on its unjudged ancestor job(s), while an independent unjudged job remains listed under `no_verdict`.
4. `plugins/codex/agents/gemini-native.md` accurately describes staged >16 KiB approvals, and `tests/docs-sync.test.mjs` scans `plugins/codex/agents/*.md`.

#### Verification Commands
```sh
node --test tests/ultra-codex-mode.test.mjs tests/run-journal.test.mjs tests/docs-sync.test.mjs
```

---

### U7. Observability: Monotonic `approvalTotals` (20-Cap Fix), `fugato-live` Room Totals & Codex Card Clip Fix

#### Problem
Three live 1.10.0 observability defects obscure approval load and truncate Codex review cards: (1) `roundtable status` caps answered approvals at 20 per job, (2) `fugato-live` omits room approval/token totals, and (3) Codex `action-approval` cards still collapse whitespace and clip at 600 chars in the rendered UI.

#### Evidence
- **20-approval cap bug (verified in `#8`, `#9`, `#10`, `#11`, `#17`)**: `job-runtime.mjs:684,710` truncates `job.questionHistory` via `.slice(-19)` (20 max; explicitly asserted by `tests/worker-lifecycle.test.mjs` `"question history caps entries and answer length and retains timeout resolution"`). `forum.mjs:202-213` (`countJobApprovals`) derives `answered` solely from `questionHistory`.
- **Live-pane room totals constraint (`#8`, `#9`, `#11`)**: `plugins/codex-live/hooks/forum.ts:22-32`, `types/index.d.ts:132-148`, and `layout.ts:677-682` omit room approval/token totals, and `forum.ts:62-64` forbids spawning CLI helpers from the poller.
- **Codex approval-card UI clip (`#9`, `#11`, `#12`)**: `native-agent.mjs:782-793` grants verbatim `wrap: 'wrap'` rendering only when `report.backend === 'antigravity'`; Codex `action-approval` cards (including staged cards from `server-requests.mjs:134-170`) route through `plain()` (`:742-746`), collapsing newlines and clipping at 600 chars.

#### Proposed Change
1. Add monotonic `approvalTotals: { answered, denied, autoAllowed, autoDenied }` on each job record (mirroring `activityTotals` in `activity.mjs:38-55`) while keeping `questionHistory` capped at 20; update `forum.mjs:202-213` to read `approvalTotals` (falling back to `questionHistory` on legacy jobs).
2. Retain `members[].jobIds` in `plugins/codex-live/hooks/forum.ts:22-32` and aggregate room approval and token totals in `layout.ts:677-682` from already-polled `state.jobs` and `state.usageByJob` (zero CLI spawns).
3. Remove the `report.backend === 'antigravity'` restriction at `native-agent.mjs:782` so all `question?.kind === 'action-approval'` cards render verbatim with `wrap: 'wrap'`.

#### User-Visible Benefit
Accurate approval counts on >20-approval jobs, live room cost/approval visibility in `fugato-live`, and unclipped Codex action-approval cards.

#### Cost
**S-M** (~150–220 LOC across `job-runtime.mjs`, `forum.mjs`, `codex-live/hooks/{forum,layout}.ts`, `native-agent.mjs`, and tests).

#### Risk
- **Legacy job-file compatibility**: Mitigated by falling back to `questionHistory` when `approvalTotals` is absent on pre-1.11.0 job records.
- **Live-pane layout overflow**: Mitigated by compact formatting (`12.4k tok · 14 appr`) verified in `codex-live` layout snapshot tests.

#### Acceptance Criteria
1. A job answering 25 approvals retains `questionHistory.length === 20` (`tests/worker-lifecycle.test.mjs` `"question history caps entries and answer length and retains timeout resolution"`) while `approvalTotals.answered === 25` and `roundtable status` reports 25.
2. `fugato-live` renders per-room approval and token totals aggregated purely from polled job/usage state without invoking CLI helpers.
3. Codex `action-approval` cards exceeding 600 chars render verbatim with newlines preserved in `native-agent.mjs` without `plain()` clipping.

#### Verification Commands
```sh
node --test tests/forum.test.mjs tests/worker-lifecycle.test.mjs
claude plugin test plugins/codex && claude plugin test plugins/codex-live
```

---

## 5. Later Work (`1.12+`)

### L1. Incremental Seam Extraction (`native-agent.mjs` & `codex-companion.mjs`)
- **Problem**: `plugins/codex/scripts/codex-companion.mjs` (3,895L) and `plugins/codex/hooks/native-agent.mjs` (2,433L) concentrate unrelated responsibilities, raising merge-conflict risk.
- **Evidence**: `native-agent.mjs:279-817` (~539L) is pure UI rendering; `codex-companion.mjs` mixes setup, journal, roundtable, and task dispatch (`#8`, `#11`).
- **Proposed change**: Keep new `1.11.0` capabilities in separate `lib/` modules (`acp-policy.mjs`, `workspace-write-tools.mjs`, `command-classify.mjs`, `doctor.mjs`); in `1.12+`, extract `native-render.mjs` and domain command handlers incrementally after `1.11.0` churn settles.
- **Benefit**: Lower merge conflicts and clearer ownership without blocking `1.11.0` feature delivery.
- **Cost / Risk**: **M-L** / **Med** (plugin packaging copy-list regressions — mitigated by `U4` full `scripts/lib/` copy).
- **Acceptance criteria**: 1. `native-agent.mjs` < 1,900L with pure renderer moved to `hooks/native-render.mjs`. 2. `codex-companion.mjs` < 2,500L with zero CLI behavior diffs.
- **Verification**: `node --test tests/cli-validation.test.mjs tests/runtime.test.mjs && claude plugin test plugins/codex`

### L2. Coalesced Approval Cards for Parallel Tool Bursts
- **Problem**: Concurrent ACP tool requests park sequentially, multiplying chair turns when multiple non-auto-allowed commands fire together.
- **Evidence**: `antigravity.mjs:401-425` serializes permission prompts one-by-one.
- **Proposed change**: Batch concurrent pending approvals into one numbered multi-decision card (`1: Allow once, 2: Deny: ...`) only if post-`1.11.0` live traces still show multi-approval bursts after `U1`+`U2`.
- **Benefit**: Cuts remaining chair round-trips on parallel bursts.
- **Cost / Risk**: **M** / **Med** (race conditions and partial-deny UX complexity).
- **Acceptance criteria**: 1. Two concurrent ACP requests within a 150ms window produce one numbered card. 2. Partial allow/deny resolves each ACP `optionId` independently.
- **Verification**: `node --test tests/antigravity.test.mjs tests/antigravity-lifecycle.test.mjs`

### L3. Persistent Antigravity (`agy`) Daemon / Broker
- **Problem**: Each Gemini turn spawns a fresh `agy acp` child process (`antigravity.mjs:555-580`), adding startup overhead and complicating cross-turn state.
- **Evidence**: No daemon/socket layer exists for `agy` (unlike Codex's `broker-lifecycle.mjs`).
- **Proposed change**: Introduce a persistent `agy` broker only if live `1.11.0` telemetry shows per-turn `agy` cold-start dominates wall time or ACP v2 multiplexing requires long-lived connections.
- **Benefit**: Lower turn latency and live session reuse.
- **Cost / Risk**: **L** / **High** (auth refresh, orphan cleanup, crash recovery).
- **Acceptance criteria**: 1. Broker survives across 2+ sequential turns with PID lock + idle shutdown. 2. Crash recovery cleans sockets without hanging active jobs.
- **Verification**: `node --test tests/antigravity-lifecycle.test.mjs tests/broker-startup.test.mjs`

### L4. Live Verification Harness & Staged >16 KiB Telemetry
- **Problem**: Staged >16 KiB approval artifacts (`1.10.0`, `approval-artifacts.mjs`) and `U2`/`U3` Phase B live `agy` behaviors remain unverified against real `agy`.
- **Evidence**: `plugins/codex/tests/native-live-checklist.mjs` lacks automated opt-in probes for staged >16 KiB approvals and sequential `session/prompt` after `reject_once` / `session/cancel`.
- **Proposed change**: Add an opt-in manual live soak script (`FUGATO_LIVE_AGY=1`) recording observed `agy` version, staged-card round-trip, and Phase B probe results before each release.
- **Benefit**: Replaces assumptions about upstream `agy` behavior with reproducible pre-release evidence.
- **Cost / Risk**: **S-M** / **Low** (opt-in only; never runs in CI or worker sandboxes).
- **Acceptance criteria**: 1. Script runs only when explicitly opted in and outputs structured pass/fail for staged >16 KiB + sequential `session/prompt` probes. 2. Never touches production workspaces.
- **Verification**: `node --test tests/approval-artifacts.test.mjs` *(manual opt-in live run by chair only)*.

### L5. Codex Detached-Worktree `workspace-write` Sandboxing (`<common>/objects` Only)
- **Problem**: Default Codex roundtable seats omit `--sandbox` (`codex-companion.mjs:3575`), running under `danger-full-access` (`setup-config.mjs:386`) and `approvalPolicy: "never+elicitations"` (`codex.mjs:161-166`). Naively setting `--sandbox workspace-write` breaks detached-worktree `git commit` because new objects write into `<common>/objects`.
- **Evidence**: `permission-policy.mjs:58-60` deliberately excludes `<common>` from `writableRoots` (`[root, gitdir]`), and `FORWARDED_APPROVALS` (`codex.mjs:161`) sets `sandbox_approval: false` (`#11`, `#12`, `#19` L-4, `#25`).
- **Proposed change**: Gate on a live Codex OS-sandbox + detached-worktree `git commit` probe verifying that extending detached-worktree `writableRoots` with `path.join(common, "objects")` only (keeping `hooks/`, `config`, and `refs/` read-only) — or exposing a confined commit helper — lets Codex roundtable seats commit safely under `--sandbox workspace-write`.
- **Benefit**: Kernel-enforced filesystem containment for Codex roundtable seats without breaking candidate commits or exposing `.git/hooks`/`refs`.
- **Cost / Risk**: **M** / **Med** (requires live Codex OS-sandbox verification across git object creation/repack behavior).
- **Acceptance criteria**: 1. A Codex roundtable seat under `--sandbox workspace-write` stages and executes `git commit` inside its detached worktree. 2. Writes outside the worktree (including sibling worktrees, `<common>/hooks`, `<common>/config`, and `<common>/refs`) fail under the OS sandbox.
- **Verification**: `node --test tests/permission-policy.test.mjs tests/forum.test.mjs` *(plus live Codex sandbox `git commit` gate before enabling by default)*.

---

## 6. Dropped & Deferred Items

- **D1 — Dropped: Enabling `agy` built-in `accept-edits` / `auto` modes**: `docs/antigravity.md:337` and `tests/fixtures/fake-antigravity.mjs:51-52` confirm `agy` `accept-edits` has no Fugato-verified worktree confinement or single-match edit safety. `U1`'s confined parent-bridge `workspace_edit`/`workspace_write` solves the approval load without giving up boundary enforcement.
- **D2 — Deferred by owner: Antigravity consumer sign-in policy / compliant API-key auth**: Excluded from `1.11.0` per owner decision (`docs/antigravity.md#terms-and-sign-in`). **Revisit triggers**: (a) upstream `agy acp` officially ships or mandates API-key / Vertex / Workspace auth, (b) consumer sign-in enforcement blocks real workflows, or (c) the owner requests compliant enterprise auth support.
- **D3 — Dropped by owner: Changing built-in worker model defaults**: Locked by owner; all `BUILTIN_ROLES`, `BUILTIN_WORKER_DEFAULTS`, `HIGH_STAKES`, and `ANTIGRAVITY_DEFAULT_MODEL` values remain untouched.
- **D4 — Dropped: Ad-hoc OS sandbox wrapper (`sandbox-exec`/containers) around `agy`**: Wrapping `agy` in bespoke host profiles breaks `agy` auth caches, Node/IPC sockets, and cross-platform portability. Use `U1` fail-closed ACP policy for Gemini and Codex `--sandbox read-only|workspace-write` whenever kernel-enforced sandboxing is required.
