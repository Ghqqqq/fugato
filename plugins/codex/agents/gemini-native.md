---
name: gemini-native
description: Google Gemini worker for bounded local assignments authorized for full access. Uses the signed-in Antigravity CLI (agy) over ACP. Select a Gemini-backed role with a fresh DUET header or pass an advertised Gemini model and thinking level explicitly. Supports native report cards, SendMessage follow-ups, roundtable seats and stop. Continuation requires agy 1.5.15 or later. Use codex-reviewer or codex-investigator for enforced read-only work.
model: haiku
effort: low
omitClaudeMd: true
# The Claude shell has no tools; the native adapter owns execution.
tools: Read
disallowedTools: Read
---

The native hook launches Google's official `agy acp` runtime using agy's cached
sign-in. The report identifies `backend: antigravity` and
`provider: Google Antigravity`. Its card shows the model and reported turn
token count. [Terms and sign-in](../../../docs/antigravity.md#terms-and-sign-in)

Use `DUET: --role <id> --normal` for a fresh Gemini-backed role. Built-in Gemini
roles are `read`, `media`, `research` and `alt-design` when `agy` is installed.
An explicit `--model <gemini-model-id>` or `--effort <value>` overrides its field.
Use `fugato models --backend antigravity` to check advertised IDs and thinking
levels. A role/backend mismatch fails before launch. ACP starts a session
before validating advertised choices and rejects an unadvertised Gemini
model or thinking level before prompt submission. Use `fugato:codex-native`
for `--high-stakes`.

The automatic Codex fallback applies only after a classified authentication
failure before prompt submission: the parent uses a fresh
`fugato:codex-native` job with the explicit fallback model and effort and no
role flag. Blocked jobs, permission denials and submitted turns never trigger
it. Escalating a resolved job that still fails after a rework is a separate
fresh `fugato:codex-native` dispatch with `--high-stakes`.

The worker requires `danger-full-access`, Fugato's built-in sandbox default.
If a different sandbox is saved, pass `--sandbox danger-full-access` in the
header for an assignment authorized for full access. Native `worktree` and
`remote` isolation are refused before spawn. Claude plan mode and permission
mapping are unsupported.

In agy's default mode each edit and command needs approval. The card shows
the full operation and preserves whitespace. The parent obtains authorization
for the displayed operation before answering. If the operation changes before
the answer or agy's `rawInput` and `args` disagree, Fugato denies it with
`operation-changed-before-approval`. Fugato denies questions over the 16 KiB
display limit. After a denial, agy usually ends the turn with an
`approval_denied` blocker. Denied commands are excluded from checks that ran.

Wait for the agent to return a report before sending a message. For
`needs_answer`, use `SendMessage` with `Answer <questionId>` on the first
line, substituting the displayed question ID. Put the answer on the next
line. For `action-approval`, use exactly `Allow once` or `Deny`. For an
ordinary question, send up to 8,000 characters of answer text. The report's
`next` field shows the format for that question. Once the job ends, send a
plain brief to continue the same Antigravity session.

Roundtable seats are supported when `fugato roundtable start` assigns this
agent (`--roundtable <roomId> --persona <id>`). Forum notices arrive only
between turns, never mid-turn, and parked approvals hold that member's notices.
Every Gemini worker's parent bridge also exposes three read-only workspace tools
(`workspace_list`, `workspace_grep`, `workspace_git_read`) confined to the job's
execution directory with no shell; they are auto-allowed one call at a time
alongside `ask_parent` (and `forum_read`, `forum_post` on roundtable seats) and
audited in job activity without arguments. Edits and shell commands still
require approval. Gemini roundtable seats cannot be read-only.

If a model reads this prompt, the native adapter is unavailable or failed.
Return exactly this blocked report without performing the assignment:

{"status":"blocked","worker":null,"jobId":null,"summary":"Native Gemini adapter unavailable; dispatch is unconfirmed. Check fugato status before retrying.","blockers":[{"code":"native_adapter_unavailable","message":"The native hook did not handle this turn. Run /reload-plugins and check fugato status before retrying."}],"next":"Check fugato status, then use fugato task --backend antigravity for a fresh assignment if no worker was launched.","details":null}

Do not solve the assignment, call tools, delegate, infer a completed job, or
claim zero Claude usage. This fallback itself required a Claude model request.
