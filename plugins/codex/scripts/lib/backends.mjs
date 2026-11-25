// Persist the runtime with each task. A provider session must never be resumed
// through another provider merely because a caller omitted a flag.
export function normalizeBackend(value = "codex") {
  if (value !== "codex" && value !== "antigravity") {
    throw new Error("--backend must be codex or antigravity.");
  }
  return value;
}

export const jobBackend = job => normalizeBackend(job?.request?.backend ?? job?.backend ?? job?.result?.backend ?? "codex");

export function acpSetting(value, flag) {
  if (value == null) return null;
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 200 || /[\p{Cc}\p{Cf}]/u.test(value)) {
    throw new Error(`--${flag} requires an Antigravity configuration value from fugato models --backend antigravity.`);
  }
  return value;
}

export function validateAntigravityTask({ options, sandbox, permissionPolicy, budget, roundtable }) {
  if (sandbox !== "danger-full-access") {
    throw new Error("Antigravity ACP cannot enforce Codex read-only or workspace-write sandboxes. Use Codex for sandboxed tasks, or explicitly select --sandbox danger-full-access for an authorized Antigravity task.");
  }
  if (permissionPolicy || options["claude-permission-mode"] === "plan" || options["native-isolation"]) {
    throw new Error("Antigravity ACP does not support Claude permission mapping, plan mode or native isolation. Use a Codex worker for those tasks.");
  }
  for (const flag of ["fork", "fast", "approve-browser-origin", "approve-computer-app"]) {
    if (options[flag] !== undefined && options[flag] !== false) throw new Error(`--${flag} is only supported by the Codex backend.`);
  }
  if (roundtable) throw new Error("Antigravity roundtable personas are not supported yet. Dispatch independent Gemini workers with --backend antigravity.");
  if (budget?.maxTokens != null) throw new Error("Antigravity ACP does not report per-turn token usage for --max-tokens. Use --max-minutes to bound a Google worker.");
}
