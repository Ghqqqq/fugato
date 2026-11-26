<!-- Fugato protocol pair v8f0225d7 -->

## Pair mode

Reuse **Dispatch**, **Writing a brief**, **Accepting a result (every worker report, no exceptions)**, **Run journal**, **Final report**, **Hard rules** and **Scope of this protocol** for shared mechanics. Apply the following pair-specific roles and limits instead of ultra's fan-out recipes.

### Choose and assign roles

- Choose pair for a bounded task that one executor can complete end to end with Claude reviewing every delivery; do not distribute implementation or broad discovery among workers.
- Claude owns the task plan, numbered acceptance criteria, full implementer brief, evidence checks, acceptance of every diff and arbitration. Use the `implement` role for the persistent executor and `verify` for the optional read-only worker. The executor owns execution and substantive fixes. The executor must not recursively delegate. Preserve explicit user model, effort and speed choices.
- Choose the executor's sandbox once at initial dispatch: use `--sandbox read-only` only for a wholly read-only task; otherwise keep its writable sandbox throughout the task. Native `SendMessage` follow-ups inherit the recorded sandbox when no override is given. Keep the role's sandbox by never passing a `--sandbox` override on follow-ups; a role change needs a fresh thread.
- Allow at most one optional read-only verifier assignment per execution round, after the executor returns; never let it accept the executor's work. Keep the executor idle while verification runs. A Claude subagent is a verifier only, with no writable paths; it must never edit files owned by Codex, concurrently or otherwise.
- Recommend **ultra** when the work-list requires independent execution owners, competing investigation lenses, or verification coverage beyond the single-verifier allowance. After one failed live fix or any unexplained live behaviour, stop further fixes and recommend ultra's **Live debugging** recipe to the user; do not switch or attempt another fix without explicit authorization.
- Recommend **duel** when materially different designs remain contested after Claude's evidence-based adjudication, or the task needs adversarial builder/breaker scrutiny of a security boundary, irreversible data change or public compatibility guarantee.
- Before an explicitly authorized switch, stop pair dispatches, settle active ownership and journal the state, open criteria, evidence and consumed rounds. Keep only one mode active. Preserve the same assignment's rework count; a switch is not a cap reset. Without explicit authorization, stop work that requires another mode and report the recommendation and unmet criteria. If an explicit mode/budget constraint forbids switching, stop and request that decision from the user.

### Run the bounded loop

1. Scout enough to bound the task, then write the plan, observable task-level criteria and full **implementer brief** from **Writing a brief**. Specify owned paths, exact checks, escalation triggers and this round cap; start the **Run journal** before dispatch. For a wholly read-only task, forbid all writes and add `--sandbox read-only` to the executor header.
2. Dispatch the sole executor using **Dispatch**, retaining its assigned name, worker/job IDs and cwd; consider `--fork` per **Forking context**. Use the `implement` role and apply the high-stakes rule:
   ```text
   Agent(subagent_type: "fugato:codex-native", description: "<pair executor>", prompt: "DUET: --role implement --normal\n<implementer brief>")
   ```
   Follow up through `SendMessage` to that assigned native agent name; provide a complete bounded rework brief, not a fresh independent thread. Use `--fast` only if the user requests it. If shared fallback rules apply, use **Dispatch**'s same-thread follow-up route without creating a second executor or a concurrent turn on this thread.
3. Treat the initial delivery as round **initial**, followed by at most **rework-1** and **rework-2**. Wait for the actual terminal report, apply the shared status gate, inspect scope and every submitted diff, and pin the exact code/artifact state being assessed. Questions/status messages do not constitute completed rounds or acceptance.
4. If Claude requests a second opinion or shared probe acceptance requires independent confirmation, give the optional verifier one bounded **probe brief**, task criteria, a pinned diff/source state and a specific claim to refute. Do not give it the implementer's summary as a substitute for evidence. Choose exactly one provider for this round. Use the `verify` role for a Codex verifier and apply the high-stakes rule:
   ```text
   Agent(subagent_type: "fugato:codex-native", description: "<pair verifier>", prompt: "DUET: --role verify --normal --sandbox read-only\n<probe brief>")
   Agent(subagent_type: "general-purpose", description: "<pair verifier>", prompt: "<probe brief with read-only BOUNDS>")
   ```
   The Claude subagent inherits the session model: omit a model override. Use `SendMessage` to the selected verifier's assigned name for pending answers or one corrective follow-up at most; do not open a debate loop. A second incomplete report remains unverified. Further independent confirmation or broader coverage requires recommending ultra; a contested/high-risk decision requires recommending duel. Stop dependent work pending explicit authorization for any mode change.
5. Claude alone applies **Accepting a result (every worker report, no exceptions)**. Use full steps 1–7 for every changed deliverable, including documentation and tests, and every submitted diff. Use the lighter probe depth for wholly read-only answers and verifier reports, escalating to full depth under that section's rules. Confirm decision-driving probe findings as required there; never treat an unverified finding or worker verdict as acceptance.
6. If criteria fail and a rework round remains, record REWORK and `SendMessage` the executor a revised full implementer brief with confirmed findings, criterion IDs, file:line/evidence, expected fixes, unchanged ownership and remaining rounds. Recheck the complete resulting diff and rerun the specified checks yourself; changed inputs invalidate prior verification. No replacement thread, verifier correction or mode switch replenishes these two rework rounds.
7. Finish only under **Finish or stop** below. Otherwise consume the next rework round, report a named escalation recommendation, or stop with the unmet criteria; never repeat the loop without one of those transitions.

### Relay and record each round

- Make Claude the sole relay; forbid direct agent-to-agent messages. Forward findings with evidence, not raw transcripts, using: `ROUND: initial|rework-1|rework-2; FROM/TO; criterion IDs; finding/claim; pinned source or diff state; file:line/source; check and observed result; uncertainty; disposition; requested response`.
- Send verified defects and Claude's acceptance reasoning to the executor; send the claim, criteria and primary evidence to a verifier. Label unsupported claims unverified and conflicting evidence explicitly. Let neither party redefine the task criteria or adjudicate its own deliverable.
- Use **Run journal** decision entries per round to record the plan/brief revision, assigned roles and job mapping, round and remaining allowance, pinned state, relayed findings with evidence and dispositions, accepted assumptions, checks and results, unresolved criteria and next transition. Record Codex job verdicts and any Claude verifier's acceptance under the shared **Run journal** rule; do not replace per-job or per-agent evidence with a round summary. Journal switches and stops with their reasons.

### Finish or stop

- Declare done only when Claude has observed evidence for every task-level criterion, accepted every final diff/output, rerun the required checks on the final state, and resolved all blocking findings, blockers and essential questions. Complete **Final report**, including journal validation and closure; retain nonblocking uncertainty explicitly.
- At the end of rework-2, if anything required remains unmet or unverified, stop and report it under **Hard rules**. Recommend ultra for remaining breadth or duel for contested/high-risk work, but do not launch another cycle to evade the cap. Continue only under new user authorization.
- On disagreement, make one evidence-based adjudication per issue per round: record the evidence and criterion deciding it, or mark it unresolved. Do not relay repeated unsupported assertions. Recommend duel for unresolved design/risk disputes before the cap, without switching automatically; ask the user only for a material requirement, tradeoff or authority decision the existing request cannot settle, bundling questions once per phase.
- If a party needs input, answer from authorized context through `SendMessage` and the shared **Dispatch** question handling; otherwise pause dependent work and collect the essential question. No answer means no assumed permission. If a party is blocked or the runtime is unavailable, stop affected work, preserve evidence/edits and report the blocker; never retry around a denial. A blocked optional verification cannot be reported as a passed check.
- If a party fails or is interrupted, inspect its recovery evidence through **Dispatch**; a substantive executor retry consumes a remaining rework round on the same thread. If that thread cannot continue, stop pair and report the required reassignment. For a verifier failure, permit only its one corrective follow-up, then leave it unverified and recommend escalation or stop. User stop ends dispatch immediately; continue a user-stopped party only with the user's consent.

### Cost

Budget for one persistent executor, at most three execution deliveries and one optional verifier assignment per delivery. Each verifier may receive at most one corrective follow-up. A Claude verifier uses the owner's Claude subagent quota; escalation to duel also uses that quota for its Claude participant. Use shared **Scope of this protocol** for task completion and mode-off behaviour.
