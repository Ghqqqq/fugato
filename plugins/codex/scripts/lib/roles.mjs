const codex = (model, effort) => Object.freeze({ backend: "codex", model, effort });
const gemini = (effort, fallback) => Object.freeze({ backend: "antigravity", model: "gemini-4-neon", effort, fallback });
const sol = "gpt-6.2-sol", astra = "gpt-6.2-astra", terra = "gpt-6.1-terra";

export const BUILTIN_ROLES = Object.freeze({
  scan: codex(sol, "low"),
  implement: codex(sol, "high"),
  investigate: codex(sol, "high"),
  review: codex(sol, "medium"),
  debug: codex(astra, "xhigh"),
  architect: codex(astra, "xhigh"),
  verify: codex(astra, "xhigh"),
  judge: codex(astra, "xhigh"),
  visual: codex(terra, "medium"),
  read: gemini("high", codex(sol, "high")),
  media: gemini("high", codex(terra, "medium")),
  research: gemini("high", codex(sol, "high")),
  "alt-design": gemini("xhigh", codex(astra, "xhigh"))
});

export const ROLE_IDS = Object.freeze(Object.keys(BUILTIN_ROLES));
export const ROUTINE_ROLES = Object.freeze(["scan", "implement", "investigate", "review"]);
export const STRONG_ROLES = Object.freeze(["debug", "architect", "verify", "judge"]);
export const HIGH_STAKES = codex(astra, "xhigh");

export function backendForModel(model) {
  return typeof model === "string" && model.trim().startsWith("gemini-") ? "antigravity" : "codex";
}

/** @param {{ roles: { id: string, backend: string, model: string, effort: string }[] }} table
 * @param {{ role?: string, highStakes?: boolean, model?: string, effort?: string, backend?: string }} options */
export function expandRole(table, { role, highStakes = false, model, effort, backend = "codex" }) {
  if (role != null && !ROLE_IDS.includes(role)) throw new Error(`Unknown role ${role}. Use ${ROLE_IDS.join(", ")}.`);
  if (highStakes) {
    if (model != null || effort != null) throw new Error("--high-stakes fixes model and effort; drop --model/--effort or --high-stakes.");
    if (backend !== "codex") throw new Error("dispatch fugato:codex-native for --high-stakes");
    return { model: HIGH_STAKES.model, effort: HIGH_STAKES.effort, role, highStakes };
  }
  if (role == null) return { model, effort, role, highStakes };
  const row = table.roles.find(row => row.id === role);
  if (row.backend !== backend) {
    throw new Error(row.backend === "antigravity" ? `role ${role} runs on Gemini; dispatch fugato:gemini-native`
      : `role ${role} has no Gemini row; dispatch fugato:codex-native`);
  }
  return { model: model ?? row.model, effort: effort ?? row.effort, role, highStakes };
}
