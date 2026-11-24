import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { AcpClient } from "./acp-client.mjs";
import { itemActivity, planActivity, snippet } from "./activity.mjs";
import { binaryAvailable } from "./process.mjs";
import { resolveIsolatedCodexHome } from "./codex-home.mjs";
import { acquireConcurrency } from "./concurrency.mjs";
import { PARENT_BRIDGE_ENV, PARENT_BRIDGE_SERVER } from "./job-runtime.mjs";
import { resolveJobFile, tryAcquirePidLock, updateJob } from "./state.mjs";

const manifest = JSON.parse(fs.readFileSync(new URL("../../.claude-plugin/plugin.json", import.meta.url), "utf8"));
const LOGIN_HELP = "Run `agy acp --login` (or an interactive `agy` session) to sign in, then retry.";
const cancelledOutcome = () => ({ outcome: { outcome: "cancelled" } });
const notStarted = error => Object.assign(error, { turnStatus: "notStarted", turnEnded: true });
const binary = () => process.env.FUGATO_ANTIGRAVITY_BIN || "agy";

export function ensureAntigravityAvailable(cwd) {
  const command = binary();
  const probe = binaryAvailable(command, ["acp", "--help"], { cwd, timeoutMs: 10000 });
  if (!probe.available) throw notStarted(new Error(`Antigravity CLI with ACP support is unavailable (${probe.detail}). Install Antigravity CLI, check \`agy acp --help\`, or set FUGATO_ANTIGRAVITY_BIN to its executable path. ${LOGIN_HELP}`));
  return { ...probe, binary: command };
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
  }, { signal });
  if (result?.protocolVersion !== 1) throw new Error(`Antigravity negotiated unsupported ACP version ${result?.protocolVersion ?? "unknown"}; Fugato supports ACP v1.`);
  return result;
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

async function setSelection(client, sessionId, configuration, kind, requested, signal) {
  if (requested == null || requested === "") return;
  const option = configOption(configuration.options, kind);
  if (!option) throw new Error(`Antigravity does not advertise a ${kind === "model" ? "model" : "thinking level"} selector; leave this option unset to use its configured default.`);
  const values = configValues(option);
  const exact = values.find(value => value.value === requested);
  // Thinking display labels may be title-cased while IDs are opaque. Model
  // IDs always require an exact match; never guess a different billed model.
  const selected = exact ?? (kind === "thought_level" ? values.find(value => String(value.name).toLowerCase() === String(requested).toLowerCase()) : null);
  if (!selected) throw new Error(`Unsupported Antigravity ${kind === "model" ? "model" : "thinking level"} '${requested}'. Available values: ${values.map(value => value.value).join(", ") || "none"}.`);
  if (option.currentValue === selected.value) return;
  await client.request("session/set_config_option", { sessionId, configId: option.id, value: selected.value }, { signal, onResponse: result => {
    if (!Array.isArray(result?.configOptions)) throw new Error("Antigravity did not return its updated session configuration.");
    if (!result.configOptions.some(value => value.id === option.id && value.currentValue === selected.value)) throw new Error("Antigravity did not acknowledge the requested session configuration.");
    configuration.accept(result);
  } });
}

function parentBridgeServers(cwd, options) {
  const bridge = options.parentBridge;
  if (!bridge) return [];
  const threadId = options.resumeThreadId ?? bridge.threadId;
  const jobId = options.jobId ?? bridge.jobId;
  if (!threadId && !jobId) throw new Error("Antigravity parent bridge requires a Fugato job or session handle.");
  const env = { [PARENT_BRIDGE_ENV.cwd]: bridge.cwd ?? cwd,
    ...(threadId ? { [PARENT_BRIDGE_ENV.threadId]: threadId } : { [PARENT_BRIDGE_ENV.jobId]: jobId }),
    CODEX_COMPANION_HOME: resolveIsolatedCodexHome(), ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) };
  return [{ name: PARENT_BRIDGE_SERVER, command: process.execPath,
    args: [fileURLToPath(new URL("../parent-bridge-mcp.mjs", import.meta.url))],
    env: Object.entries(env).map(([name, value]) => ({ name, value: String(value) })) }];
}

function promptContent(options) {
  const prompt = options.prompt?.trim() || options.defaultPrompt?.trim();
  if (!prompt) throw new Error("A prompt is required for an Antigravity run.");
  const content = [];
  // ACP v1 has no portable developer-role or outputSchema field. Forward
  // Fugato's instructions as explicit task context; its existing report parser
  // validates the final response instead of claiming server-enforced output.
  if (options.developerInstructions) content.push({ type: "text", text: `[Fugato task instructions]\n${options.developerInstructions}` });
  content.push({ type: "text", text: prompt });
  if (options.outputSchema) content.push({ type: "text", text: `Return the final answer as one JSON object matching this schema. Do not surround the object with prose or Markdown fences.\n${JSON.stringify(options.outputSchema)}` });
  return content;
}

function describePermission(params) {
  const tool = params.toolCall ?? {};
  const parts = [`Antigravity requests permission for ${String(tool.name ?? tool.kind ?? "tool")} (${String(tool.toolCallId ?? "unknown")}).`];
  if (tool.title) parts.push(`Agent description: ${String(tool.title)}`);
  if (tool.locations?.length) parts.push(`Locations: ${tool.locations.map(location => location.path).filter(Boolean).join(", ")}`);
  if (tool.rawInput != null) parts.push(`Arguments: ${JSON.stringify(tool.rawInput)}`);
  if (tool.content?.length) parts.push(`Operation details: ${JSON.stringify(tool.content)}`);
  parts.push("Allow this operation once?");
  return parts.join("\n");
}

function permissionHasContext(tool) {
  if (!tool || typeof tool.toolCallId !== "string" || !tool.toolCallId) return false;
  const operation = typeof tool.name === "string" && tool.name.trim() ||
    ["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode"].includes(tool.kind);
  const input = tool.rawInput;
  const hasInput = typeof input === "string" ? Boolean(input.trim()) : input != null &&
    (typeof input !== "object" || Object.keys(input).length > 0);
  const hasLocation = Array.isArray(tool.locations) && tool.locations.some(value => typeof value?.path === "string" && value.path.trim());
  const hasContent = Array.isArray(tool.content) && tool.content.length > 0;
  // A bare ID or agent-authored title carries no reviewable operation scope.
  return Boolean(operation && (hasInput || hasLocation || hasContent));
}

async function permissionDecision(options, params, binding, turnSignal, requestSignal, blockers) {
  const choices = Array.isArray(params.options) ? params.options : [];
  const allow = choices.find(value => value?.kind === "allow_once" && typeof value.optionId === "string");
  const deny = choices.find(value => value?.kind === "reject_once" && typeof value.optionId === "string");
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of [turnSignal, requestSignal]) signal?.addEventListener("abort", abort, { once: true });
  let onCancelled;
  try {
    if (turnSignal.aborted || requestSignal.aborted) return cancelledOutcome();
    let answer = "deny";
    if (params.sessionId === binding.threadId && binding.turnId && allow && permissionHasContext(params.toolCall) && options.onApprovalRequest) {
      const request = { kind: "acp-permission", question: describePermission(params), options: ["Allow once", "Deny"],
        binding: { ...binding }, signal: controller.signal, toolCall: params.toolCall };
      answer = await Promise.race([
        Promise.resolve().then(() => options.onApprovalRequest(request)).catch(() => "deny"),
        new Promise(resolve => { onCancelled = () => resolve("deny"); controller.signal.addEventListener("abort", onCancelled, { once: true }); })
      ]);
    }
    if (controller.signal.aborted) return cancelledOutcome();
    if (answer === "once" && allow) return { outcome: { outcome: "selected", optionId: allow.optionId } };
    blockers.push({ code: "approval_denied", message: "Antigravity tool permission was denied or could not be forwarded.", method: "session/request_permission", kind: "acp-permission" });
    return deny ? { outcome: { outcome: "selected", optionId: deny.optionId } } : cancelledOutcome();
  } finally {
    for (const signal of [turnSignal, requestSignal]) signal?.removeEventListener("abort", abort);
    if (onCancelled) controller.signal.removeEventListener("abort", onCancelled);
    controller.abort();
  }
}

function mergeTool(previous, update) {
  return { ...previous, ...Object.fromEntries(Object.entries(update).filter(([, value]) => value != null)) };
}

function commandResult(tool) {
  const raw = tool.rawOutput;
  const output = typeof raw === "string" ? raw : raw?.stdout ?? raw?.text ?? null;
  const exitCode = raw?.exitCode ?? raw?.exit_code ?? null;
  const command = typeof tool.rawInput === "string" ? tool.rawInput : tool.rawInput?.command;
  return { id: tool.toolCallId, type: "commandExecution", command: typeof command === "string" && command.trim() ? command : null,
    title: typeof tool.title === "string" ? tool.title : null,
    status: tool.status === "completed" ? "completed" : tool.status === "failed" ? "failed" : "inProgress",
    exitCode: Number.isInteger(exitCode) ? exitCode : null, aggregatedOutput: output, durationMs: null };
}

function acquireSessionAdmission(threadId) {
  const directory = path.join(resolveIsolatedCodexHome(), "duet", "antigravity-session-admission");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const release = tryAcquirePidLock(path.join(directory, `${createHash("sha256").update(threadId).digest("hex")}.lock`));
  if (!release) throw notStarted(new Error(`Antigravity session ${threadId} already has a Fugato run in progress.`));
  return release;
}

function toolActivityItem(tool) {
  const status = tool.status === "in_progress" || tool.status === "pending" ? "inProgress" : tool.status;
  if (tool.kind === "execute") {
    const command = commandResult(tool);
    if (command.command !== null) return command;
  }
  const diffs = (Array.isArray(tool.content) ? tool.content : []).filter(value => value?.type === "diff" && typeof value.path === "string");
  if (["edit", "delete", "move"].includes(tool.kind) || diffs.length) {
    const paths = [...new Set([...diffs.map(value => value.path), ...(Array.isArray(tool.locations) ? tool.locations : []).map(value => value.path)].filter(value => typeof value === "string"))];
    return { type: "fileChange", id: tool.toolCallId, status, changes: paths.map(file => {
      const diff = diffs.find(value => value.path === file);
      return { path: file, kind: tool.kind === "delete" ? "delete" : diff?.oldText === null ? "add" : tool.kind === "edit" || diff ? "update" : "unknown",
        ...(diff?.oldText === null && typeof diff.newText === "string" ? { content: diff.newText } : {}) };
    }) };
  }
  // Titles remain tool descriptions. A title such as "Run the tests" cannot
  // become an observed shell command or imply an exit code.
  return { type: "dynamicToolCall", id: tool.toolCallId, status, tool: tool.name ?? tool.title ?? tool.kind ?? "Antigravity tool" };
}

export async function listAntigravityModels(cwd) {
  const availability = ensureAntigravityAvailable(cwd);
  const configuration = sessionConfiguration();
  const client = new AcpClient(availability.binary, path.resolve(cwd), { onNotification: message => configuration.observe(message) });
  try {
    await initialize(client);
    await client.request("session/new", { cwd: path.resolve(cwd), mcpServers: [] }, { onResponse: response => configuration.accept(response, true) });
    const model = configOption(configuration.options, "model"), thinking = configOption(configuration.options, "thought_level");
    if (!model) throw new Error("Antigravity did not advertise any model choices for this account.");
    return { provider: "antigravity", data: configValues(model).map(option => ({ id: option.value, model: option.value,
      displayName: option.name ?? option.value, description: option.description ?? "", isDefault: option.value === model.currentValue,
      // Only the selected model's effort options have been observed. Changing
      // models can change this list, so avoid advertising invented support.
      supportedReasoningEfforts: option.value === model.currentValue ? configValues(thinking).map(value => ({ reasoningEffort: value.value, description: value.name ?? value.value })) : [],
      defaultReasoningEffort: option.value === model.currentValue ? thinking?.currentValue ?? null : null })), configOptions: configuration.options };
  } catch (error) { throw authenticationError(error); }
  finally { await client.close(); }
}

export async function runAntigravityTurn(cwd, options = {}) {
  const executionCwd = path.resolve(options.executionCwd ?? cwd);
  const content = promptContent(options);
  if (options.sandbox && options.sandbox !== "danger-full-access") throw notStarted(new Error("Antigravity ACP does not implement Fugato's Codex sandbox modes. Select danger-full-access explicitly; Antigravity's own permission rules still apply."));
  if (options.signal?.aborted) throw notStarted(new Error("Antigravity task interrupted before startup."));
  const availability = ensureAntigravityAvailable(cwd);
  const reservation = await acquireConcurrency({ jobFile: options.jobId ? resolveJobFile(cwd, options.jobId) : null, signal: options.signal,
    onQueued: () => { if (options.jobId) updateJob(cwd, options.jobId, () => ({ status: "queued", phase: "queued (concurrency limit)" })); report(options, "Queued (concurrency limit).", "queued (concurrency limit)"); },
    onAdmitted: () => { if (options.jobId) updateJob(cwd, options.jobId, () => ({ status: "running", phase: "starting" })); } });
  let client, releaseAdmission, submitted = false, cleanupConfirmed = false;
  let threadId = options.resumeThreadId ?? null, turnId = null;
  const configuration = sessionConfiguration(threadId);
  let capture = false, finalMessage = "", messageId = null, resetMessage = false, thought = "", acpUsage = null;
  let turnEnded = false, stopReason = null, failure = null, promptPromise = null, cancellationTimer = null;
  let cancelRequested = false, resolveCancelTimeout;
  const cancellationTimeout = new Promise(resolve => { resolveCancelTimeout = resolve; });
  const turnAbort = new AbortController(), tools = new Map(), blockers = [];
  const activityStarts = new Map(), activityLifecycles = new Map(), activityDescriptors = new Map();
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
    client = new AcpClient(availability.binary, executionCwd, {
      timeoutMs: options.connectTimeoutMs ?? 30000,
      onRequest: (message, signal) => {
        if (message.method === "session/request_permission") {
          const params = message.params ?? {}, partial = params.toolCall;
          // ACP permits ToolCallUpdate here, including only toolCallId. Merge
          // with this session's observed call so approval shows its real scope.
          const toolCall = params.sessionId === threadId && typeof partial?.toolCallId === "string"
            ? mergeTool(tools.get(partial.toolCallId), partial) : partial;
          if (params.sessionId === threadId && typeof toolCall?.toolCallId === "string") tools.set(toolCall.toolCallId, toolCall);
          return permissionDecision(options, { ...params, toolCall }, { threadId, turnId }, turnAbort.signal, signal, blockers);
        }
        blockers.push({ code: "approval_unsupported", message: `Antigravity requested unsupported client method ${message.method}.`, method: message.method });
        throw Object.assign(new Error("Method not found"), { rpcCode: -32601 });
      },
      onNotification: message => {
        configuration.observe(message);
        if (message.method !== "session/update" || message.params?.sessionId !== threadId) return;
        const update = message.params.update;
        if (!update || typeof update.sessionUpdate !== "string") return;
        if (!capture) return; // session/load replays history before it replies.
        switch (update.sessionUpdate) {
          case "agent_message_chunk":
            if (update.content?.type !== "text" || typeof update.content.text !== "string") break;
            if (resetMessage || (update.messageId && messageId && update.messageId !== messageId)) finalMessage = "";
            resetMessage = false; messageId = update.messageId ?? messageId;
            finalMessage += update.content.text;
            report(options, "Antigravity response received.", "working", { logTitle: "Antigravity message", logBody: update.content.text });
            break;
          case "agent_thought_chunk":
            if (update.content?.type === "text" && typeof update.content.text === "string") thought += update.content.text;
            break;
          case "tool_call":
          case "tool_call_update":
            if (typeof update.toolCallId !== "string") break;
            {
            const tool = mergeTool(tools.get(update.toolCallId), update);
            tools.set(update.toolCallId, tool);
            if (update.sessionUpdate === "tool_call") resetMessage = true;
            const lifecycle = ["completed", "failed", "cancelled"].includes(tool.status) ? "completed" : "started";
            if (activityLifecycles.get(tool.toolCallId) === lifecycle || activityLifecycles.get(tool.toolCallId) === "completed") break;
            activityLifecycles.set(tool.toolCallId, lifecycle);
            let item = toolActivityItem(tool);
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
    const params = { cwd: executionCwd, mcpServers: parentBridgeServers(cwd, options) };
    if (threadId) {
      if (initialized.agentCapabilities?.loadSession !== true) throw new Error("This Antigravity runtime does not support loading sessions; start a new task instead of continuing this one.");
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
    await setSelection(client, threadId, configuration, "model", options.model, options.signal);
    await setSelection(client, threadId, configuration, "thought_level", options.effort, options.signal);
    if (options.signal?.aborted) throw new Error("Antigravity task interrupted before prompt submission.");
    turnId = `acp-${randomUUID()}`;
    persist({ threadId, turnId, turnSubmission: { at: new Date().toISOString(), transport: "acp-stdio", threadId } });
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
    clearTimeout(cancellationTimer);
    options.signal?.removeEventListener("abort", abort);
    try {
      if (client) await client.close();
      cleanupConfirmed = true;
      if (client) persist({ acpProcessExited: true });
    } finally {
      releaseAdmission?.();
      // Unlike the shared Codex broker, each ACP process belongs to this run.
      // Confirmed process cleanup releases its slot even without a cancel ACK.
      if (!submitted || cleanupConfirmed) reservation.release();
    }
  }
  const entries = [...tools.values()];
  // Proposed diffs can accompany pending or denied operations. Only completed
  // tool events confirm edits; workspace snapshots detect any partial writes
  // from failed operations independently.
  const fileChanges = entries.filter(tool => tool.status === "completed" && (["edit", "delete", "move"].includes(tool.kind) || tool.content?.some(value => value.type === "diff")));
  const touchedFiles = [...new Set(fileChanges.flatMap(tool => [
    ...(tool.locations ?? []).map(location => location.path),
    ...(tool.content ?? []).filter(value => value.type === "diff").map(value => value.path)
  ]).filter(value => typeof value === "string" && value))];
  const status = failure || ["cancelled", "max_tokens", "max_turn_requests"].includes(stopReason) ? 1 : 0;
  const turnStatus = stopReason === "cancelled" || cancelRequested ? "interrupted" : status ? "failed" : "completed";
  return { provider: "antigravity", status, threadId, turnId, finalMessage, reasoningSummary: thought ? [thought] : [],
    turn: { id: turnId, status: turnStatus, error: failure ? { message: failure.message } : null },
    turnStatus, turnEnded, stopReason, turnInterruptAttempted: cancelRequested && submitted,
    interruptionConfirmed: stopReason === "cancelled", acpProcessExited: cleanupConfirmed,
    sandbox: "danger-full-access", approvalPolicy: options.onApprovalRequest ? "antigravity-rules+parent-once" : "antigravity-rules+deny",
    model: configSelection(configuration.options, "model"), effort: configSelection(configuration.options, "thought_level"),
    fileChanges, touchedFiles, commandExecutions: entries.filter(tool => tool.kind === "execute").map(commandResult),
    blockers, error: failure ? { message: failure.message } : null, stderr: client?.stderr ?? "", acpUsage };
}
