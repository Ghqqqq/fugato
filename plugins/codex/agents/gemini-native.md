---
name: gemini-native
description: Google Gemini worker for bounded local assignments authorized for full access. Uses the signed-in Antigravity CLI (agy) over ACP. Select an advertised Gemini model and its thinking level in the optional DUET header. Supports native report cards, SendMessage follow-ups and stop. Continuation requires agy 1.5.15 or later. Use codex-reviewer or codex-investigator for enforced read-only work.
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

An optional first line `DUET: --model <gemini-model-id> --effort <value>`
selects a model and thinking level. `fugato models --backend antigravity`
lists only `gemini-*` IDs and shows thinking levels only for the current model.
On a fresh task without overrides, the worker uses the current Gemini model
or selects the first advertised Gemini model, with its configured thinking
level. An explicit non-Gemini model fails before the prompt.

The worker requires `danger-full-access`, Fugato's built-in sandbox default.
If a different sandbox is saved, pass `--sandbox danger-full-access` in the
header for an assignment authorized for full access. Native `worktree` and
`remote` isolation are refused before spawn. Claude plan mode and permission
mapping are unsupported.

In agy's default mode each edit and command needs approval. For a displayed
`question.kind: "action-approval"`, the parent obtains the authorization
needed for that operation and sends exactly `Allow once` or `Deny` through
`SendMessage`. The card shows the full approval text and preserves
whitespace. Each answer applies once to the operation shown. If it changes
before the answer or agy's `rawInput` and `args` disagree, Fugato denies it
with `operation-changed-before-approval`. Fugato denies questions over the
16 KiB display limit. After `Deny`, agy usually ends the turn with an
`approval_denied` blocker. Denied commands are excluded from checks that ran.

The worker refuses `SendMessage` while a turn is running. Wait for the agent
to return a report, even if a progress notice already shows a question.
For a `needs_answer` permission report, any reply other than the two exact
choices shows the question again and starts no work. After the turn finishes,
send the next assignment to continue the same Antigravity session.

If a model reads this prompt, the native adapter is unavailable or failed.
Return exactly this blocked report without performing the assignment:

{"status":"blocked","worker":null,"jobId":null,"summary":"Native Gemini adapter unavailable; dispatch is unconfirmed. Check fugato status before retrying.","blockers":[{"code":"native_adapter_unavailable","message":"The native hook did not handle this turn. Run /reload-plugins and check fugato status before retrying."}],"next":"Check fugato status, then use fugato task --backend antigravity for a fresh assignment if no worker was launched.","details":null}

Do not solve the assignment, call tools, delegate, infer a completed job, or
claim zero Claude usage. This fallback itself required a Claude model request.
