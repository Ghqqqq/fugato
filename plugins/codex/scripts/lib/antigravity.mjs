import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { AcpClient } from "./acp-client.mjs";
import { agentMessageActivity, itemActivity, planActivity, snippet } from "./activity.mjs";
import { executableOnPath } from "./process.mjs";
import { resolveIsolatedCodexHome } from "./codex-home.mjs";
import { acquireConcurrency } from "./concurrency.mjs";
import { ASK_PARENT, PARENT_BRIDGE_ENV, PARENT_BRIDGE_SERVER } from "./job-runtime.mjs";
import { resolveJobFile, tryAcquirePidLock, updateJob } from "./state.mjs";
import { WORKSPACE_EXEC_CWD_ENV, WORKSPACE_READ_TOOLS, WORKSPACE_READ_TOOL_NAMES } from "./workspace-read-tools.mjs";
import { approvalArtifactDir, stageApprovalArtifact, verifyApprovalArtifact } from "./approval-artifacts.mjs";
import { classifyCommand } from "./command-classify.mjs";
import { ACTION_APPROVAL_OPTIONS, actionApprovalOptions } from "./server-requests.mjs";
import { finalizeUnconsumedGeminiNotes } from "./steering.mjs";

const manifest = JSON.parse(fs.readFileSync(new URL("../../.claude-plugin/plugin.json", import.meta.url), "utf8"));
export const ANTIGRAVITY_DEFAULT_MODEL = "gemini-4-neon";
export const ANTIGRAVITY_DEFAULT_EFFORT = "xhigh";
const LOGIN_HELP = "Run `agy acp --login` (or an interactive `agy` session) to sign in, then retry.";
const cancelledOutcome = () => ({ outcome: { outcome: "cancelled" } });
const notStarted = error => Object.assign(error, { turnStatus: "notStarted", turnEnded: true });
const binary = (env = process.env) => env.FUGATO_ANTIGRAVITY_BIN || "agy";
const INSTALL_HELP = "Install Antigravity CLI, check `agy acp --help`, or set FUGATO_ANTIGRAVITY_BIN to its executable path.";
// ACP's default mode asks about edits and commands. Inline display covers up to
// 16 KiB raw UTF-8; larger operations stage exact review artifacts under 2 KiB cards.
const MAX_APPROVAL_BYTES = 16 * 1024;
const MAX_STAGED_CARD_BYTES = 2 * 1024;
const UNSAFE_ARTIFACT_PATH = /[\p{Cf}\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const MAX_UNSUPPORTED_BLOCKERS = 8;
const changedOperation = { code: "operation-changed-before-approval", message: "Antigravity's operation changed or its arguments disagree." };

function denyPermission(options) {
  const deny = Array.isArray(options) && options.find(value => value?.kind === "reject_once" && typeof value.optionId === "string");
  return deny ? { outcome: { outcome: "selected", optionId: deny.optionId } } : cancelledOutcome();
}

export function resolveAntigravityExecutable(cwd, env = process.env) {
  const command = binary(env);
  if (process.platform === "win32") {
    const name = /[\\/]/.test(command) ? path.win32.resolve(cwd, command) : command;
    return executableOnPath(name, env);
  }
  if (!command.includes("/")) return executableOnPath(command, env);
  const executable = path.isAbsolute(command) ? command : path.resolve(cwd, command);
  try {
    fs.accessSync(executable, fs.constants.X_OK);
    return fs.statSync(executable).isFile() ? executable : null;
  } catch { return null; }
}

export function ensureAntigravityAvailable(cwd) {
  const executable = resolveAntigravityExecutable(cwd);
  if (!executable) throw notStarted(new Error(`Antigravity executable '${binary()}' was not found or is not executable. ${INSTALL_HELP} ${LOGIN_HELP}`));
  return executable;
}

function launchExecutable(cwd, options) {
  if (options.executable == null) return ensureAntigravityAvailable(options.requestCwd ?? cwd);
  if (!path.isAbsolute(options.executable)) throw notStarted(new Error("The supplied Antigravity executable must be an absolute path."));
  return options.executable;
}

function report(options, message, phase = null, extra = {}) {
  try { options.onProgress?.({ message, phase, ...extra }); }
  catch { /* Diagnostics cannot disable cancellation or lose a completed turn. */ }
}

function authenticationError(error) {
  if (error.rpcCode === -32000 || /authentication required/i.test(error.message)) {
    error.message = `Antigravity authentication is required. ${LOGIN_HELP}`;
  }
  return error;
}

async function initialize(client, signal = null) {
  const result = await client.request("initialize", {
    protocolVersion: 1,
    // agy owns its tools. An empty capability set does not restrict its file or
    // terminal access, and must never be represented as a sandbox guarantee.
    clientCapabilities: {},
    clientInfo: { name: "fugato", title: "Fugato", version: manifest.version }
  }, { signal }).catch(error => {
    if (!signal?.aborted) error.message += ` ${INSTALL_HELP} ${LOGIN_HELP}`;
    throw error;
  });
  if (result?.protocolVersion !== 1) throw new Error(`Antigravity negotiated unsupported ACP version ${result?.protocolVersion ?? "unknown"}. Fugato supports ACP v1. ${INSTALL_HELP} ${LOGIN_HELP}`);
  return result;
}

function supportsOrderedReplay(version) {
  const match = typeof version === "string" && /^(\d+)\.(\d+)\.(\d+)(-[\w.-]+)?(?:\+[\w.-]+)?$/.exec(version);
  if (!match) return false;
  const [, major, minor, patch, prerelease] = match;
  if (Number(major) !== 1) return Number(major) > 1;
  if (Number(minor) !== 5) return Number(minor) > 5;
  return Number(patch) > 15 || (Number(patch) === 15 && !prerelease);
}

const isGemini = model => typeof model === "string" && model.startsWith("gemini-");

function geminiModelOption(option) {
  const options = (Array.isArray(option?.options) ? option.options : []).flatMap(choice => {
    if (!Array.isArray(choice?.options)) return isGemini(choice?.value) ? [choice] : [];
    const models = choice.options.filter(value => isGemini(value?.value));
    return models.length ? [{ ...choice, options: models }] : [];
  });
  return { ...option, currentValue: isGemini(option?.currentValue) ? option.currentValue : null, options };
}

function configValues(option) {
  return Array.isArray(option?.options) ? option.options.flatMap(value => Array.isArray(value?.options) ? value.options : [value])
    .filter(value => value && typeof value.value === "string") : [];
}
function configOption(configOptions, kind) {
  const options = Array.isArray(configOptions) ? configOptions.filter(option => option?.type === "select") : [];
  return options.find(option => option.category === kind) ?? options.find(option =>
    kind === "model" ? option.id === "model" : ["thought_level", "thinking_level", "thinkingLevel", "reasoning_effort"].includes(option.id));
}
function configSelection(configOptions, kind) { return configOption(configOptions, kind)?.currentValue ?? null; }

function sessionConfiguration(sessionId = null) {
  const pending = new Map();
  return {
    sessionId, options: [],
    observe(message) {
      const params = message.params;
      if (message.method !== "session/update" || params?.update?.sessionUpdate !== "config_option_update" ||
          typeof params.sessionId !== "string" || !Array.isArray(params.update.configOptions)) return;
      if (params.sessionId === this.sessionId) this.options = params.update.configOptions;
      else if (this.sessionId === null) {
        // A server may announce configuration before session/new returns its
        // handle. Keep only a bounded set until that handle binds the session.
        pending.set(params.sessionId, params.update.configOptions);
        if (pending.size > 16) pending.delete(pending.keys().next().value);
      }
    },
    accept(response, fresh = false) {
      if (fresh) {
        if (typeof response?.sessionId !== "string" || !response.sessionId) throw new Error("Antigravity did not return a session handle.");
        this.sessionId = response.sessionId;
        this.options = pending.get(this.sessionId) ?? [];
        pending.clear();
      }
      if (Array.isArray(response?.configOptions)) this.options = response.configOptions;
    }
  };
}

async function setSelection(client, sessionId, configuration, kind, requested, isDefault, signal) {
  const selector = configOption(configuration.options, kind);
  const model = kind === "model";
  if (model && requested && !isGemini(requested)) throw new Error(`Antigravity supports only Gemini models (gemini-*). Cannot select '${requested}'.`);
  const option = model ? geminiModelOption(selector) : selector;
  if (!model && !requested) return;
  if (!option) {
    if (isDefault) return;
    throw new Error("Antigravity does not advertise a thinking level selector; leave this option unset to use its configured default.");
  }
  const values = configValues(option);
  let selected = values.find(value => value.value === requested);
  // Thinking labels may be title-cased while their IDs are opaque.
  if (!selected && !model) selected = values.find(value => String(value.name).toLowerCase() === String(requested).toLowerCase());
  if (!selected && (isDefault || !requested)) {
    if (!model || option.currentValue) return option.currentValue;
    selected = values[0];
    if (!selected) throw new Error("Antigravity did not advertise a Gemini model for this account.");
  }
  if (!selected) throw new Error(`Unsupported Antigravity ${model ? "model" : "thinking level"} '${requested}'. Available values: ${values.map(value => value.value).join(", ") || "none"}.`);
  if (option.currentValue === selected.value) return selected.value;
  await client.request("session/set_config_option", { sessionId, configId: option.id, value: selected.value }, { signal, onResponse: result => {
    if (!Array.isArray(result?.configOptions)) throw new Error("Antigravity did not return its updated session configuration.");
    if (!result.configOptions.some(value => value.id === option.id && value.currentValue === selected.value)) throw new Error("Antigravity did not acknowledge the requested session configuration.");
    configuration.accept(result);
  } });
  return selected.value;
}

export function parentBridgeToolKeys(toolName) {
  if (toolName === "ask_parent") return new Set([...Object.keys(ASK_PARENT.inputSchema.properties), "toolSummary"]);
  if (toolName === "forum_read") return new Set(["resource", "after", "thread", "limit", "toolSummary"]);
  if (toolName === "forum_post") return new Set(["kind", "body", "title", "thread", "reply_to", "label", "refs", "mentions", "toolSummary"]);
  const workspaceTool = WORKSPACE_READ_TOOLS.find(tool => tool.name === toolName);
  if (workspaceTool) return new Set([...Object.keys(workspaceTool.inputSchema.properties), "toolSummary"]);
  return null;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

function noEntries(value) {
  return value == null || (Array.isArray(value) && value.length === 0);
}

export function autoAllowedParentBridgeTool(call, bridge) {
  if (!bridge?.serverName || !call?.tool) return null;
  const tool = call.tool;
  const listed = [
    "ask_parent",
    ...(bridge.roundtable ? ["forum_read", "forum_post"] : []),
    ...(bridge.backend === "antigravity" ? WORKSPACE_READ_TOOL_NAMES : [])
  ];
  const toolName = typeof tool.name === "string"
    ? listed.find(name => tool.name === `mcp_${bridge.serverName}_${name}`)
    : null;
  if (!toolName || tool.kind !== "other") return null;
  if (!noEntries(tool.locations) || !noEntries(tool.content) || call.diffs?.length) return null;
  if (!isPlainObject(tool.rawInput) || !isDeepStrictEqual(tool.rawInput, tool.args)) return null;
  const allowedKeys = parentBridgeToolKeys(toolName);
  if (!Object.keys(tool.rawInput).every(key => allowedKeys.has(key))) return null;
  return toolName;
}

function parentBridgeServers(cwd, options) {
  const bridge = options.parentBridge;
  if (!bridge) return { serverName: null, backend: null, roundtable: false, servers: [] };
  const threadId = options.resumeThreadId ?? bridge.threadId;
  const jobId = options.jobId ?? bridge.jobId;
  if (!threadId && !jobId) throw new Error("Antigravity parent bridge requires a Fugato job or session handle.");
  const executionCwd = path.resolve(options.executionCwd ?? cwd);
  const serverName = `${PARENT_BRIDGE_SERVER}_${randomBytes(6).toString("hex")}`;
  const env = { [PARENT_BRIDGE_ENV.cwd]: bridge.cwd ?? cwd, CODEX_COMPANION_BRIDGE_BACKEND: "antigravity",
    [WORKSPACE_EXEC_CWD_ENV]: executionCwd,
    ...(jobId ? { [PARENT_BRIDGE_ENV.jobId]: jobId } : { [PARENT_BRIDGE_ENV.threadId]: threadId }),
    CODEX_COMPANION_HOME: resolveIsolatedCodexHome(), ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) };
  return { serverName, backend: "antigravity", roundtable: Boolean(bridge.roundtable), servers: [{ name: serverName, command: process.execPath,
    args: [fileURLToPath(new URL("../parent-bridge-mcp.mjs", import.meta.url))],
    env: Object.entries(env).map(([name, value]) => ({ name, value: String(value) })) }] };
}

export const GEMINI_WORKSPACE_GUIDANCE =
  "Read files with read_file, and use workspace_list, workspace_grep and workspace_git_read instead of shell commands for directory listing, code search and git inspection. These read-only tools stay inside the job execution directory and run without shell approval.";

function promptContent(options) {
  const prompt = options.prompt?.trim() || options.defaultPrompt?.trim();
  if (!prompt) throw new Error("A prompt is required for an Antigravity run.");
  const content = [];
  // ACP v1 has no portable developer-role or outputSchema field. Forward
  // Fugato's instructions as explicit task context; its existing report parser
  // validates the final response instead of claiming server-enforced output.
  const instructions = [options.developerInstructions, options.parentBridge ? GEMINI_WORKSPACE_GUIDANCE : null].filter(Boolean).join("\n\n");
  if (instructions) content.push({ type: "text", text: `[Fugato task instructions]\n${instructions}` });
  content.push({ type: "text", text: prompt });
  if (options.outputSchema) content.push({ type: "text", text: `Return the final answer as one JSON object matching this schema. Do not surround the object with prose or Markdown fences.\n${JSON.stringify(options.outputSchema)}` });
  return content;
}

function escapeApprovalControls(json) {
  // JSON quotes C0 controls. Also quote format controls (including bidi),
  // C1 controls and Unicode line separators so each field stays on one line.
  return json.replace(/[\p{Cf}\u007f-\u009f\u2028\u2029]/gu, char =>
    char.split("").map(unit => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""));
}

function inputCommand(input) {
  return [input?.CommandLine, input?.command, input].find(value => typeof value === "string" && value.trim());
}

function argumentStringRefs(input) {
  const refs = new Map();
  if (typeof input === "string") {
    refs.set(input, "Arguments");
  } else if (isPlainObject(input)) {
    for (const [key, value] of Object.entries(input)) {
      if (typeof value === "string" && !refs.has(value)) {
        const ref = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `Arguments.${key}` : `Arguments[${JSON.stringify(key)}]`;
        refs.set(value, ref);
      }
    }
  }
  return refs;
}

function displayOperationDetails(content, input) {
  if (!Array.isArray(content)) return content;
  const refs = argumentStringRefs(input);
  if (!refs.size) return content;
  return content.map(block => {
    if (!isPlainObject(block) || block.type !== "diff") return block;
    let changed = false;
    const next = { ...block };
    for (const field of ["oldText", "newText"]) {
      if (typeof block[field] === "string" && refs.has(block[field])) {
        next[field] = { sameAs: refs.get(block[field]) };
        changed = true;
      }
    }
    return changed ? next : block;
  });
}

function compactApprovalField(label, value, maxBytes = 256) {
  const encoded = escapeApprovalControls(JSON.stringify(value));
  if (Buffer.byteLength(encoded, "utf8") <= maxBytes) return `${label}: ${encoded}`;
  const text = String(value);
  let clipped = text.slice(0, Math.max(1, Math.floor(maxBytes / 2)));
  if (/[\uD800-\uDBFF]$/.test(clipped)) clipped = clipped.slice(0, -1);
  while (clipped.length > 1 && Buffer.byteLength(escapeApprovalControls(JSON.stringify(`${clipped}…`)), "utf8") > maxBytes) {
    clipped = clipped.slice(0, Math.floor(clipped.length / 2));
    if (/[\uD800-\uDBFF]$/.test(clipped)) clipped = clipped.slice(0, -1);
  }
  return `${label}: ${escapeApprovalControls(JSON.stringify(`${clipped}…`))}`;
}

function compactApprovalLocations(paths, maxBytes = 512) {
  if (!paths.length) return null;
  const full = escapeApprovalControls(JSON.stringify(paths));
  if (Buffer.byteLength(full, "utf8") <= maxBytes) return `Locations: ${full}`;
  const kept = [];
  for (const entry of paths) {
    const remaining = paths.length - kept.length - 1;
    const candidate = escapeApprovalControls(JSON.stringify([...kept, entry])) + (remaining > 0 ? ` (+${remaining} more)` : "");
    if (Buffer.byteLength(candidate, "utf8") > maxBytes) break;
    kept.push(entry);
  }
  if (!kept.length) return `Locations: (${paths.length} path${paths.length === 1 ? "" : "s"}; see exact operation file)`;
  const omitted = paths.length - kept.length;
  return `Locations: ${escapeApprovalControls(JSON.stringify(kept))}${omitted > 0 ? ` (+${omitted} more)` : ""}`;
}

function buildStagedApprovalCard(tool, artifact) {
  if (UNSAFE_ARTIFACT_PATH.test(artifact.path)) return null;
  const locations = [...new Set([
    ...(Array.isArray(tool.locations) ? tool.locations : []),
    ...toolDiffs(tool)
  ].map(entry => entry?.path).filter(value => typeof value === "string" && value))];
  const lines = [
    "Antigravity requests permission (staged; exceeds 16 KiB inline limit).",
    compactApprovalField("Tool call ID", tool.toolCallId, 160),
    ...(tool.name != null ? [compactApprovalField("Name", tool.name, 160)] : []),
    ...(tool.kind != null ? [compactApprovalField("Kind", tool.kind, 160)] : []),
    ...(locations.length ? [compactApprovalLocations(locations, 512)] : []),
    `Size: ${artifact.bytes} bytes`,
    `SHA-256: ${artifact.sha256}`,
    `Exact operation: ${artifact.path}`,
    "Read the exact operation file in full before answering.",
    "Allow this operation once?"
  ];
  const card = lines.join("\n");
  return Buffer.byteLength(card, "utf8") < MAX_STAGED_CARD_BYTES ? card : null;
}

function permissionReview(tool, staging = null) {
  if (typeof tool?.toolCallId !== "string" || !tool.toolCallId.trim()) return null;
  const input = tool.rawInput;
  const fields = [["Tool call ID", tool.toolCallId], ["Name", tool.name], ["Kind", tool.kind],
    ["Agent description", tool.title], ["Locations", tool.locations], ["Arguments", input], ["Operation details", tool.content]]
    .filter(([, value]) => value != null);
  const tooLarge = { code: "operation-too-large-to-display-exactly", message: "Antigravity's operation exceeds the approval display limit." };
  try {
    if (!isDeepStrictEqual(input, tool.args)) return changedOperation;
    // Permission requires executable text in the input. A title is descriptive.
    if ((tool.kind === "execute" || tool.name === "run_command") && !inputCommand(input)) {
      return { code: "missing-command-line", message: "Antigravity requested execution without a command line." };
    }
    const hasInput = typeof input === "string" ? Boolean(input.trim()) : input != null &&
      (typeof input !== "object" || Object.keys(input).length > 0);
    const hasDiff = toolDiffs(tool).some(diff => typeof diff.oldText === "string" || typeof diff.newText === "string");
    if (!hasInput && !hasDiff) return null;
    const displayFields = fields.map(([label, value]) =>
      label === "Operation details" ? [label, displayOperationDetails(value, input)] : [label, value]);
    const lines = ["Antigravity requests permission."];
    for (const [label, value] of displayFields) {
      lines.push(`${label}: ${escapeApprovalControls(JSON.stringify(value))}`);
    }
    lines.push("Allow this operation once?");
    const question = lines.join("\n");
    if (Buffer.byteLength(question, "utf8") <= MAX_APPROVAL_BYTES) return { question, fields: structuredClone(fields) };
    if (staging?.stage === false) return { fields: structuredClone(fields) };
    if (!staging?.workspaceRoot || !staging?.jobId) return tooLarge;
    let artifact;
    try {
      const dir = approvalArtifactDir(staging.workspaceRoot, staging.jobId, staging.env);
      if (UNSAFE_ARTIFACT_PATH.test(dir)) return tooLarge;
      artifact = stageApprovalArtifact(staging.workspaceRoot, staging.jobId, question, staging.env);
    } catch { return tooLarge; }
    const card = buildStagedApprovalCard(tool, artifact);
    if (card) return { question: card, fields: structuredClone(fields), artifact };
  } catch (error) {
    // A deeply nested JSON value can exceed the serializer's stack limit.
    if (!(error instanceof RangeError)) throw error;
  }
  return tooLarge;
}

const RUN_COMMAND_GRANT_KEYS = new Set([
  "CommandLine", "command", "Cwd", "cwd", "WaitMsBeforeAsync", "NotificationTimeoutSeconds", "toolSummary"
]);

function runCommandPrefix(call, executionCwd) {
  if (!call?.tool || !executionCwd) return null;
  const tool = call.tool;
  if (typeof tool.toolCallId !== "string" || !tool.toolCallId.trim()) return null;
  if (tool.name !== "run_command") return null;
  if (tool.kind != null && tool.kind !== "execute") return null;
  if (call.diffs?.length || toolDiffs(tool).length) return null;
  const input = tool.rawInput;
  if (!isPlainObject(input) || !isDeepStrictEqual(input, tool.args)) return null;
  if (!Object.keys(input).every(key => RUN_COMMAND_GRANT_KEYS.has(key))) return null;
  const commandLine = typeof input.CommandLine === "string" ? input.CommandLine
    : input.CommandLine === undefined && typeof input.command === "string" ? input.command : null;
  if (!commandLine) return null;
  if (typeof input.CommandLine === "string" && input.command !== undefined && input.command !== input.CommandLine) return null;
  if (input.Cwd !== undefined && input.cwd !== undefined && input.Cwd !== input.cwd) return null;
  let realExecCwd;
  try { realExecCwd = fs.realpathSync(path.resolve(executionCwd)); }
  catch { return null; }
  const rawCwd = input.Cwd ?? input.cwd;
  if (rawCwd !== undefined) {
    if (typeof rawCwd !== "string" || !rawCwd.trim()) return null;
    let realRawCwd;
    try { realRawCwd = fs.realpathSync(path.resolve(realExecCwd, rawCwd)); }
    catch { return null; }
    if (realRawCwd !== realExecCwd) return null;
  }
  const classified = classifyCommand(commandLine, { cwd: realExecCwd });
  return classified.eligible ? classified.prefix : null;
}

function normalizeApprovalResult(value) {
  if (value === "once") return { decision: "once" };
  if (value && typeof value === "object" && ["once", "job_grant", "deny"].includes(value.decision)) {
    const guidance = value.decision === "deny" && typeof value.guidance === "string" && value.guidance.trim()
      ? value.guidance.trim() : undefined;
    return { decision: value.decision, ...(guidance ? { guidance } : {}) };
  }
  return { decision: "deny" };
}

async function permissionDecision(options, params, binding, turnSignal, requestSignal, blockers, call, bridge, workspaceRoot = null, executionCwd = workspaceRoot, jobGrants = null) {
  const choices = Array.isArray(params.options) ? params.options : [];
  const allow = choices.find(value => value?.kind === "allow_once" && typeof value.optionId === "string");
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of [turnSignal, requestSignal]) signal?.addEventListener("abort", abort, { once: true });
  let onCancelled;
  try {
    if (turnSignal.aborted || requestSignal.aborted) {
      if (call) call.permission = "denied";
      return cancelledOutcome();
    }
    const autoAllowedTool = call && binding.turnId && allow ? autoAllowedParentBridgeTool(call, bridge) : null;
    if (autoAllowedTool) {
      if (call.permission !== "denied") call.permission = "approved";
      const message = `parent bridge tool auto-allowed: ${autoAllowedTool}`;
      report(options, message, "working", {
        activity: [{ type: "permissionAutoAllowed", lifecycle: "completed", status: "approved", tool: autoAllowedTool, text: message }]
      });
      return { outcome: { outcome: "selected", optionId: allow.optionId } };
    }
    const grantPrefix = call && binding.turnId && allow ? runCommandPrefix(call, executionCwd) : null;
    if (grantPrefix && jobGrants?.has(grantPrefix)) {
      if (call.permission !== "denied") call.permission = "approved";
      const message = `job grant auto-allowed: ${grantPrefix}`;
      report(options, message, "working", {
        activity: [{ type: "permissionAutoAllowed", lifecycle: "completed", status: "approved", tool: "run_command", prefix: grantPrefix, text: message }]
      });
      return { outcome: { outcome: "selected", optionId: allow.optionId } };
    }
    let answer = { decision: "deny" };
    const staging = workspaceRoot && options.jobId ? { workspaceRoot, jobId: options.jobId, env: options.env } : null;
    let review = call && binding.turnId && allow ? permissionReview(call.tool, staging) : null;
    if (review?.question && options.onApprovalRequest) {
      const request = { kind: "acp-permission", question: review.question,
        options: grantPrefix ? actionApprovalOptions(grantPrefix) : ACTION_APPROVAL_OPTIONS,
        binding: { ...binding }, signal: controller.signal, toolCall: call.tool };
      const rawAnswer = await Promise.race([
        Promise.resolve().then(() => options.onApprovalRequest(request)).catch(() => ({ decision: "deny" })),
        new Promise(resolve => { onCancelled = () => resolve({ decision: "deny" }); controller.signal.addEventListener("abort", onCancelled, { once: true }); })
      ]);
      answer = normalizeApprovalResult(rawAnswer);
      // Bind the answer to the displayed values and any staged artifact.
      if (!controller.signal.aborted && (!isDeepStrictEqual(permissionReview(call.tool, { stage: false })?.fields, review.fields)
          || (review.artifact && !verifyApprovalArtifact(review.artifact)))) {
        review = changedOperation;
        answer = { decision: "deny" };
      }
    }
    if (controller.signal.aborted) {
      if (call) call.permission = "denied";
      return cancelledOutcome();
    }
    if ((answer.decision === "once" || (answer.decision === "job_grant" && grantPrefix)) && allow) {
      if (answer.decision === "job_grant") jobGrants?.add(grantPrefix);
      if (call.permission !== "denied") call.permission = "approved";
      return { outcome: { outcome: "selected", optionId: allow.optionId } };
    }
    if (call) call.permission = "denied";
    blockers.push({ code: review?.code ?? "approval_denied", message: review?.message ?? "Antigravity tool permission was denied or could not be forwarded.",
      method: "session/request_permission", kind: "acp-permission",
      ...(!review?.code && answer.guidance ? { guidance: answer.guidance } : {}) });
    return denyPermission(choices);
  } finally {
    for (const signal of [turnSignal, requestSignal]) signal?.removeEventListener("abort", abort);
    if (onCancelled) controller.signal.removeEventListener("abort", onCancelled);
    controller.abort();
  }
}

function observeTool(tools, update) {
  const call = tools.get(update.toolCallId) ?? { tool: {}, diffs: [], permission: null };
  const tool = { ...call.tool, ...update };
  // agy sends args as a copy of rawInput. Either field in this frame takes
  // precedence over both cached copies. Keep conflicting copies for review.
  if (Object.hasOwn(update, "rawInput") || Object.hasOwn(update, "args")) {
    tool.rawInput = Object.hasOwn(update, "rawInput") ? update.rawInput : update.args;
    tool.args = Object.hasOwn(update, "args") ? update.args : update.rawInput;
  }
  const diffs = toolDiffs(update);
  if (diffs.length) call.diffs = diffs;
  else if (call.diffs.length && ["rawInput", "args", "locations"].some(field => !isDeepStrictEqual(tool[field], call.tool[field]))) {
    call.diffs = [];
    // A partial update can also inherit the previous proposal's diff blocks.
    if (Array.isArray(tool.content)) tool.content = tool.content.filter(block => block?.type !== "diff");
  }
  call.tool = tool;
  tools.set(update.toolCallId, call);
  return call;
}

function commandResult(tool) {
  const raw = tool.rawOutput;
  const output = typeof raw === "string" ? raw : raw?.stdout ?? raw?.text ?? null;
  const exitCode = raw?.exitCode ?? raw?.exit_code ?? null;
  const command = inputCommand(tool.rawInput) ?? (tool.kind === "execute" && typeof tool.title === "string" && tool.title.trim() ? tool.title : null);
  return { id: tool.toolCallId, type: "commandExecution", command,
    title: typeof tool.title === "string" ? tool.title : null,
    status: tool.status === "completed" ? "completed" : tool.status === "failed" ? "failed" : "inProgress",
    exitCode: Number.isInteger(exitCode) ? exitCode : null, aggregatedOutput: output, durationMs: null };
}

function failedPermissionCheck(tool) {
  if (tool.status !== "failed") return false;
  const content = Array.isArray(tool.content) ? tool.content.map(block => block?.content?.text) : [];
  return [tool.rawOutput, ...content].some(text => typeof text === "string" &&
    /^(?:permission check failed\b[\s\S]*?:\s*)?user denied permission to run command\b/i.test(text));
}

function promptUsage(raw) {
  const fields = { inputTokens: raw?.inputTokens, cachedInputTokens: raw?.cachedReadTokens,
    outputTokens: raw?.outputTokens, reasoningOutputTokens: raw?.thoughtTokens, totalTokens: raw?.totalTokens };
  const validCount = count => Number.isSafeInteger(count) && count >= 0;
  if (validCount(fields.inputTokens)) {
    for (const cached of [raw.cachedReadTokens, raw.cachedWriteTokens]) {
      if (validCount(cached)) fields.inputTokens += cached;
    }
  }
  const counts = Object.entries(fields).filter(([, count]) => validCount(count));
  return counts.length ? Object.fromEntries(counts) : null;
}

function acquireSessionAdmission(threadId) {
  const directory = path.join(resolveIsolatedCodexHome(), "duet", "antigravity-session-admission");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const release = tryAcquirePidLock(path.join(directory, `${createHash("sha256").update(threadId).digest("hex")}.lock`));
  if (!release) throw notStarted(new Error(`Antigravity session ${threadId} already has a Fugato run in progress.`));
  return release;
}

const fileChangeKinds = new Set(["edit", "delete", "move"]);
function toolDiffs(tool) {
  return Array.isArray(tool.content) ? tool.content.filter(value => value?.type === "diff" && typeof value.path === "string" && value.path) : [];
}
function changedPaths(tool, diffs = toolDiffs(tool)) {
  // Locations can include read dependencies. A diff identifies the changed
  // paths directly. Without one, only a file-changing kind attests to edits.
  const locations = fileChangeKinds.has(tool.kind) && Array.isArray(tool.locations) ? tool.locations : [];
  return [...new Set((diffs.length ? diffs : locations).map(value => value?.path).filter(value => typeof value === "string" && value))];
}

function toolActivityItem(tool, diffs) {
  const status = tool.status === "in_progress" || tool.status === "pending" ? "inProgress" : tool.status;
  if (tool.kind === "execute") {
    const command = commandResult(tool);
    if (command.command !== null) return command;
  }
  if (fileChangeKinds.has(tool.kind) || diffs.length) {
    return { type: "fileChange", id: tool.toolCallId, status, changes: changedPaths(tool, diffs).map(file => {
      const diff = diffs.find(value => value.path === file);
      return { path: file, kind: tool.kind === "delete" ? "delete" : diff?.oldText === null ? "add" : tool.kind === "edit" || diff ? "update" : "unknown",
        ...(diff?.oldText === null && typeof diff.newText === "string" ? { content: diff.newText } : {}) };
    }) };
  }
  return { type: "dynamicToolCall", id: tool.toolCallId, status, tool: tool.name ?? tool.title ?? tool.kind ?? "Antigravity tool" };
}

export async function listAntigravityModels(cwd, options = {}) {
  const executable = launchExecutable(cwd, options);
  const configuration = sessionConfiguration();
  const client = new AcpClient(executable, path.resolve(cwd), { onNotification: message => configuration.observe(message) });
  try {
    await initialize(client);
    await client.request("session/new", { cwd: path.resolve(cwd), mcpServers: [] }, { onResponse: response => configuration.accept(response, true) });
    const model = configOption(configuration.options, "model"), thinking = configOption(configuration.options, "thought_level");
    const supported = geminiModelOption(model);
    const models = configValues(supported);
    if (!models.length) throw new Error("Antigravity did not advertise a Gemini model for this account.");
    return { provider: "antigravity", data: models.map(option => ({ id: option.value, model: option.value,
      displayName: option.name ?? option.value, description: option.description ?? "", isDefault: option.value === model.currentValue,
      // Only the selected model's effort options have been observed. Changing
      // models can change this list, so avoid advertising invented support.
      supportedReasoningEfforts: option.value === model.currentValue ? configValues(thinking).map(value => ({ reasoningEffort: value.value, description: value.name ?? value.value })) : [],
      defaultReasoningEffort: option.value === model.currentValue ? thinking?.currentValue ?? null : null })),
      configOptions: configuration.options.map(option => option === model ? supported : option) };
  } catch (error) { throw authenticationError(error); }
  finally { await client.close(); }
}

export async function runAntigravityTurn(cwd, options = {}) {
  const steeringJobId = options.jobId ?? options.parentBridge?.jobId ?? null;
  const steeringCwd = options.parentBridge?.cwd ?? cwd;
  let unconsumedSteers = [];
  let steeringFinalizeError = null;
  let steeringFinalized = false;
  const finalizeSteering = async () => {
    if (steeringFinalized || !steeringJobId) return;
    steeringFinalized = true;
    try {
      unconsumedSteers = await finalizeUnconsumedGeminiNotes(steeringCwd, steeringJobId);
    } catch (error) {
      steeringFinalizeError = error instanceof Error ? error.message : String(error);
    }
  };
  let turnReturned = false;
  try {
  const executionCwd = path.resolve(options.executionCwd ?? cwd);
  const content = promptContent(options);
  if (options.sandbox && options.sandbox !== "danger-full-access") throw notStarted(new Error("Antigravity ACP does not implement Fugato's Codex sandbox modes. Select danger-full-access explicitly; Antigravity's own permission rules still apply."));
  if (options.signal?.aborted) throw notStarted(new Error("Antigravity task interrupted before startup."));
  const executable = launchExecutable(cwd, options);
  const reservation = await acquireConcurrency({ jobFile: options.jobId ? resolveJobFile(cwd, options.jobId) : null, signal: options.signal,
    onQueued: () => { if (options.jobId) updateJob(cwd, options.jobId, () => ({ status: "queued", phase: "queued (concurrency limit)" })); report(options, "Queued (concurrency limit).", "queued (concurrency limit)"); },
    onAdmitted: () => { if (options.jobId) updateJob(cwd, options.jobId, () => ({ status: "running", phase: "starting" })); } });
  let client, releaseAdmission, parentBridge = null, submitted = false, cleanupConfirmed = false;
  let threadId = options.resumeThreadId ?? null, turnId = null;
  const configuration = sessionConfiguration(threadId);
  let capture = false, finalMessage = "", messageId = null, toolSinceChunk = false, thought = "", acpUsage = null;
  let model, effort, usage;
  let turnEnded = false, stopReason = null, failure = null, promptPromise = null, cancellationTimer = null;
  let cancelRequested = false, resolveCancelTimeout;
  const cancellationTimeout = new Promise(resolve => { resolveCancelTimeout = resolve; });
  const turnAbort = new AbortController(), tools = new Map(), blockers = [], jobGrants = new Set();
  let unsupportedBlockers = 0;
  const activityStarts = new Map(), activityLifecycles = new Map(), activityDescriptors = new Map();
  // Named messages can resume until the turn ends. Keep pending messages
  // in last-chunk order so a resumed final report follows intervening prose.
  const messages = new Map();
  const publishMessage = text => {
    if (!text) return;
    const activity = agentMessageActivity(text, "antigravity");
    report(options, "Antigravity message captured.", "working", { activity });
  };
  const publishAnonymous = () => {
    if (typeof messageId === "symbol" && messages.size === 1) {
      publishMessage(messages.get(messageId));
      messages.delete(messageId);
    }
  };
  const persist = patch => { if (options.jobId) updateJob(cwd, options.jobId, () => patch); };
  const abort = () => {
    cancelRequested = true;
    turnAbort.abort();
    if (!submitted || !threadId || !client) return;
    try {
      client.cancelPermissionRequests(threadId);
      client.notify("session/cancel", { sessionId: threadId });
    } catch { /* Cleanup still runs if the pipe closed. */ }
    if (!cancellationTimer) cancellationTimer = setTimeout(() => resolveCancelTimeout({ cancelledWithoutAck: true }), options.cancelTimeoutMs ?? 2000);
  };
  try {
    if (threadId) {
      releaseAdmission = acquireSessionAdmission(threadId);
    }
    client = new AcpClient(executable, executionCwd, {
      timeoutMs: options.connectTimeoutMs ?? 30000,
      onRequest: (message, signal) => {
        if (message.method === "session/request_permission") {
          const params = message.params ?? {}, partial = params.toolCall;
          if (!capture) return denyPermission(params.options);
          // ACP permits ToolCallUpdate here, including only toolCallId. Merge
          // with this session's observed call so approval shows its real scope.
          const call = params.sessionId === threadId && typeof partial?.toolCallId === "string" ? observeTool(tools, partial) : null;
          return permissionDecision(options, params, { threadId, turnId }, turnAbort.signal, signal, blockers, call, parentBridge, cwd, executionCwd, jobGrants);
        }
        if (unsupportedBlockers < MAX_UNSUPPORTED_BLOCKERS) {
          const method = `unrecognized:${createHash("sha256").update(message.method).digest("hex").slice(0, 16)}`;
          blockers.push({ code: "approval_unsupported", message: "Antigravity requested an unsupported client method.", method });
          unsupportedBlockers++;
        }
        throw Object.assign(new Error("Method not found"), { rpcCode: -32601 });
      },
      onNotification: message => {
        configuration.observe(message);
        if (message.method !== "session/update" || message.params?.sessionId !== threadId) return;
        const update = message.params.update;
        if (!update || typeof update.sessionUpdate !== "string") return;
        if (!capture) return; // agy 1.5.15+ finishes history replay before the load reply.
        switch (update.sessionUpdate) {
          case "agent_message_chunk": {
            if (update.content?.type !== "text" || typeof update.content.text !== "string" || !update.content.text) break;
            const id = update.messageId ?? (toolSinceChunk || messageId == null ? Symbol() : messageId);
            if (id !== messageId) publishAnonymous();
            messageId = id;
            toolSinceChunk = false;
            finalMessage = (messages.get(id) ?? "") + update.content.text;
            messages.delete(id);
            messages.set(id, finalMessage);
            report(options, "Antigravity response received.", "working", { logTitle: "Antigravity message", logBody: update.content.text });
            break;
          }
          case "agent_thought_chunk":
            if (update.content?.type === "text" && typeof update.content.text === "string") thought += update.content.text;
            break;
          case "tool_call":
          case "tool_call_update":
            if (typeof update.toolCallId !== "string") break;
            {
            const { tool, diffs } = observeTool(tools, update);
            const lifecycle = ["completed", "failed", "cancelled"].includes(tool.status) ? "completed" : "started";
            if (activityLifecycles.get(tool.toolCallId) === lifecycle || activityLifecycles.get(tool.toolCallId) === "completed") break;
            activityLifecycles.set(tool.toolCallId, lifecycle);
            toolSinceChunk = true;
            publishAnonymous();
            let item = toolActivityItem(tool, diffs);
            const descriptor = activityDescriptors.get(tool.toolCallId);
            // Keep a metadata-only start paired with its completion even if
            // later updates add a command. The full result retains that data.
            if (descriptor?.type === "dynamicToolCall") item = { ...descriptor, status: item.status };
            activityDescriptors.set(tool.toolCallId, item);
            const activity = itemActivity(item, lifecycle, activityStarts, tool.toolCallId);
            report(options, "Antigravity tool activity recorded.", "working", {
              item: { type: item.type, summary: "Antigravity tool", lifecycle, callId: tool.toolCallId, title: snippet(tool.title ?? tool.name ?? tool.kind ?? "Tool", 160) }, activity
            });
            }
            break;
          case "plan": report(options, "Antigravity plan updated.", "planning", { activity: planActivity((Array.isArray(update.entries) ? update.entries : [])
            .map(entry => ({ step: entry.content, status: entry.status === "in_progress" ? "inProgress" : entry.status }))) }); break;
          case "usage_update": acpUsage = { used: update.used, size: update.size, ...(update.cost ? { cost: update.cost } : {}) }; break;
        }
      }
    });
    persist({ acpProcessPid: client.pid, acpProcessGroup: true, acpProcessExited: false });
    options.signal?.addEventListener("abort", abort, { once: true });
    const initialized = await initialize(client, options.signal);
    parentBridge = parentBridgeServers(cwd, options);
    const params = { cwd: executionCwd, mcpServers: parentBridge.servers };
    if (threadId) {
      if (initialized.agentCapabilities?.loadSession !== true) throw new Error("This Antigravity runtime does not support loading sessions; start a new task instead of continuing this one.");
      const version = initialized.agentInfo?.version;
      if (!supportsOrderedReplay(version)) throw new Error(`Antigravity continuation requires agy 1.5.15 or newer to finish history replay before a new turn. The server reported version ${version ?? "unknown"}.`);
      await client.request("session/load", { ...params, sessionId: threadId }, { signal: options.signal, onResponse: response => configuration.accept(response) });
    } else {
      await client.request("session/new", params, { signal: options.signal, onResponse: response => {
        configuration.accept(response, true);
        threadId = configuration.sessionId;
      } });
      // A fresh run must guard its session too: an explicit continuation can
      // arrive as soon as its first live handle is published.
      releaseAdmission = acquireSessionAdmission(threadId);
    }
    const selectedModel = await setSelection(client, threadId, configuration, "model", options.model, options.modelDefault, options.signal);
    await setSelection(client, threadId, configuration, "thought_level", options.effort, options.effortDefault, options.signal);
    model = configSelection(configuration.options, "model");
    effort = configSelection(configuration.options, "thought_level");
    if (!isGemini(model) || selectedModel !== model) throw new Error("Antigravity did not confirm the selected Gemini model before prompt submission.");
    if (options.signal?.aborted) throw new Error("Antigravity task interrupted before prompt submission.");
    turnId = `acp-${randomUUID()}`;
    persist({ threadId, turnId, selectedModel: model, selectedEffort: effort, turnSubmission: { at: new Date().toISOString(), transport: "acp-stdio", threadId } });
    reservation.submitted();
    submitted = true; capture = true;
    promptPromise = client.request("session/prompt", { sessionId: threadId, prompt: content }, { timeoutMs: 0 });
    // Both outcomes are wrapped immediately so a cancellation timeout cannot
    // leave a later transport rejection unhandled.
    const settled = promptPromise.then(result => ({ result }), error => ({ error }));
    report(options, `Antigravity session ready (${threadId}).`, "starting", { threadId, turnId });
    const outcome = await Promise.race([settled, cancellationTimeout]);
    if (outcome.cancelledWithoutAck) {
      failure = new Error("Antigravity did not acknowledge cancellation; its owned process was stopped.");
    } else if (outcome.error) {
      failure = authenticationError(outcome.error);
      turnEnded = outcome.error.code === "ACP_RPC_ERROR";
    } else {
      stopReason = outcome.result?.stopReason;
      usage = promptUsage(outcome.result?.usage);
      if (!["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"].includes(stopReason)) failure = new Error(`Antigravity returned an invalid stop reason: ${String(stopReason)}.`);
      else turnEnded = true;
      if (stopReason === "refusal") blockers.push({ code: "agent_refusal", message: "Antigravity refused to continue the task." });
      if (["max_tokens", "max_turn_requests"].includes(stopReason)) blockers.push({ code: "agent_limit", message: `Antigravity stopped because of ${stopReason}.` });
    }
  } catch (error) {
    failure = authenticationError(error);
    if (!submitted) throw notStarted(failure);
  } finally {
    capture = false; turnAbort.abort();
    for (const text of messages.values()) publishMessage(text);
    clearTimeout(cancellationTimer);
    options.signal?.removeEventListener("abort", abort);
    try {
      if (client) {
        const { exited } = await client.close();
        cleanupConfirmed = exited;
        if (exited) persist({ acpProcessExited: true });
      }
    } finally {
      releaseAdmission?.();
      // Unlike the shared Codex broker, each ACP process belongs to this run.
      // Confirmed process cleanup releases its slot even without a cancel ACK.
      if (!submitted || cleanupConfirmed) reservation.release();
    }
  }
  const fileChanges = [], commandExecutions = [];
  // Proposed diffs can accompany pending or denied operations. Only completed
  // tool events confirm edits; workspace snapshots detect any partial writes
  // from failed operations independently.
  for (const { tool, diffs, permission } of tools.values()) {
    if (tool.status === "completed" && (fileChangeKinds.has(tool.kind) || diffs.length)) {
      const otherContent = Array.isArray(tool.content) ? tool.content.filter(block => block?.type !== "diff") : [];
      fileChanges.push(diffs.length ? { ...tool, content: [...diffs, ...otherContent] } : tool);
    }
    if (tool.kind !== "execute" || permission === "denied") continue;
    if (permission !== "approved" && failedPermissionCheck(tool)) {
      blockers.push({ code: "approval_denied", message: "Antigravity denied permission to run the command.", method: "session/request_permission", kind: "acp-permission" });
    } else commandExecutions.push(commandResult(tool));
  }
  const touchedFiles = [...new Set(fileChanges.flatMap(tool => changedPaths(tool)))];
  await finalizeSteering();
  let steeringNotice = null;
  if (steeringFinalizeError) {
    steeringNotice = `Could not finalize Gemini steering inbox at turn end (${steeringFinalizeError}); queued steering messages may be unconsumed—inspect steering state before resending.`;
    blockers.push({ code: "steering_finalize_failed", message: steeringNotice });
  }
  const status = failure || ["cancelled", "max_tokens", "max_turn_requests"].includes(stopReason) ? 1 : 0;
  const turnStatus = stopReason === "cancelled" || cancelRequested ? "interrupted" : status ? "failed" : "completed";
  turnReturned = true;
  return { provider: "antigravity", status, threadId, turnId, finalMessage, reasoningSummary: thought ? [thought] : [],
    turn: { id: turnId, status: turnStatus, error: failure ? { message: failure.message } : null },
    turnStatus, turnEnded, stopReason, turnInterruptAttempted: cancelRequested && submitted,
    interruptionConfirmed: stopReason === "cancelled", acpProcessExited: cleanupConfirmed,
    sandbox: "danger-full-access", approvalPolicy: options.onApprovalRequest ? "antigravity-rules+parent-once" : "antigravity-rules+deny",
    model, effort, ...(usage ? { usage } : {}),
    ...(unconsumedSteers.length ? { unconsumedSteers } : {}),
    ...(steeringNotice ? { notice: steeringNotice } : {}),
    fileChanges, touchedFiles, commandExecutions,
    blockers, error: failure ? { message: failure.message } : null, stderr: client?.stderr ?? "", acpUsage };
  } finally {
    if (!turnReturned && steeringJobId) {
      await finalizeSteering();
      if (options.jobId && (unconsumedSteers.length || steeringFinalizeError)) {
        try {
          const errorNotice = steeringFinalizeError
            ? `Could not finalize Gemini steering inbox at turn end (${steeringFinalizeError}); queued steering messages may be unconsumed—inspect steering state before resending.`
            : null;
          updateJob(cwd, options.jobId, current => ({
            ...(unconsumedSteers.length ? { unconsumedSteers } : {}),
            ...(steeringFinalizeError ? {
              steeringFinalizeError,
              notice: [current.notice, errorNotice].filter(Boolean).join(" ")
            } : {})
          }));
        } catch { /* Job file may not exist in standalone unit tests. */ }
      }
    }
  }
}
