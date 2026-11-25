#!/usr/bin/env node
// UserPromptSubmit hook: while an orchestration mode is on for this Claude session,
// add a one-line reminder to the prompt. Silent otherwise, and silent on any
// error: a hook failure must never block the user's prompt.
import { readHookInput } from "./lib/fs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { isModeCommandPrompt, readMode, reminderText } from "./lib/ultra-codex-mode.mjs";
import { effectiveRoleTable } from "./lib/setup-config.mjs";

try {
  const raw = (await readHookInput()).trim();
  const input = raw ? JSON.parse(raw) : {};
  const sessionId = input.session_id || process.env.CODEX_COMPANION_SESSION_ID;
  if (sessionId) {
    const cwd = input.cwd || process.cwd();
    const mode = readMode(resolveWorkspaceRoot(cwd), sessionId);
    if (mode && !isModeCommandPrompt(input.prompt)) process.stdout.write(`${reminderText(mode, undefined, effectiveRoleTable({ cwd }))}\n`);
  }
} catch { /* silent */ }
