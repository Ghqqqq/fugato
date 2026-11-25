import fs from "node:fs";
import path from "node:path";

// A real stdio peer exercises framing, bidirectional requests and process
// ownership without installing agy or touching the user's Google credentials.
export function installFakeAntigravity(directory, options = {}) {
  const { behavior = "normal", version = "1.5.16", serverRequests = [], mcpPermissionRequests = [], turnUpdates = null, loadPermission, promptUsage,
    modelIds, currentModel, currentEffort, sessionGate, promptGate } = typeof options === "string" ? { behavior: options } : options;
  fs.mkdirSync(directory, { recursive: true });
  const statePath = path.join(directory, "antigravity-state.json");
  const script = path.join(directory, "fake-agy.mjs");
  fs.writeFileSync(statePath, JSON.stringify({ requests: [], serverResponses: [], sessions: [], launches: [], nextSession: 1 }));
  const config = { statePath, behavior, version, serverRequests, mcpPermissionRequests, turnUpdates, loadPermission, promptUsage, modelIds, currentModel, currentEffort, sessionGate, promptGate };
  fs.writeFileSync(script, `#!${process.execPath}\nconst { statePath, behavior, version, serverRequests, mcpPermissionRequests, turnUpdates, loadPermission, promptUsage, modelIds, currentModel, currentEffort, sessionGate, promptGate } = ${JSON.stringify(config)};\n` + String.raw`
import fs from "node:fs";
import readline from "node:readline";
const read = () => JSON.parse(fs.readFileSync(statePath, "utf8"));
const save = change => {
  const value = read(); change(value);
  const temp = statePath + "." + process.pid + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(value)); fs.renameSync(temp, statePath);
};
save(value => value.launches.push({ pid: process.pid, script: process.argv[1], args: process.argv.slice(2) }));
if (process.argv.includes("--version") || process.argv.includes("--help")) {
  process.stdout.write("Antigravity fixture ACP v1\n"); process.exit(0);
}
if (behavior === "no-acp") { process.stderr.write("Unknown subcommand: acp\n"); process.exit(1); }
let output = Promise.resolve();
function send(message) {
  const buffer = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  output = output.then(async () => {
    const unicode = buffer.indexOf(Buffer.from("中"));
    const cuts = behavior === "fragmented" ? [1, 12, Math.floor(buffer.length / 2), ...(unicode < 0 ? [] : [unicode + 1, unicode + 2]), buffer.length - 1, buffer.length] : [buffer.length];
    let start = 0;
    for (const end of [...new Set(cuts.filter(value => value > 0 && value <= buffer.length))].sort((a,b) => a-b)) {
      await new Promise(resolve => process.stdout.write(buffer.subarray(start, end), resolve)); start = end;
    }
  });
}
function sendBatch(messages) {
  const frame = messages.map(message => JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n").join("");
  output = output.then(() => new Promise(resolve => process.stdout.write(frame, resolve)));
}
const geminiModels = [
  { value: "gemini-4-neon", name: "Gemini 4 Neon" }, { value: "gemini-4-carbon", name: "Gemini 4 Carbon" },
  { value: "gemini-pro-orchestrator", name: "Orchestrator (Carbon)" }, { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" }
];
const otherModels = [{ value: "claude-opus-5-5", name: "Claude Opus 5.5" },
  { value: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" }, { value: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" }];
const available = (behavior === "no-gemini" ? otherModels : [...geminiModels, ...otherModels]).filter(model => !modelIds || modelIds.includes(model.value));
const modelId = behavior === "dynamic-selectors" ? "selected-model" : "model";
const thoughtId = behavior === "dynamic-selectors" ? "reasoning-choice" : "thought_level";
let sessionId = null, model = currentModel ?? (["non-gemini-default", "no-gemini"].includes(behavior) ? otherModels[0].value : geminiModels[0].value);
let thought = currentEffort ?? "high", promptRequest = null, thinkingOverride = null;
let scriptedReplies = 0, mcpServers = [], activeMcpCalls = new Map();
let pendingLoad = null;
const configs = () => [
  { id: modelId, category: "model", name: "Model", type: "select", currentValue: model,
    options: behavior === "dynamic-selectors" ? [{ group: "models", name: "Models", options: available }] : available },
  { id: thoughtId, category: "thought_level", name: "Thinking Level", type: "select", currentValue: thought,
    options: (thinkingOverride ?? (model === "gemini-3.8-flash" ? ["low", "medium"] : ["low", "medium", "high", "xhigh"])).map(value => ({ value, name: value[0].toUpperCase() + value.slice(1) })) },
  { id: "mode", category: "mode", name: "Mode", type: "select", currentValue: "default",
    options: ["default", "accept-edits", "auto", "plan"].map(value => ({ value, name: value })) }
];
const update = (data, id = sessionId) => send({ method: "session/update", params: { sessionId: id, update: data } });
const configNotification = () => ({ method: "session/update", params: { sessionId, update: { sessionUpdate: "config_option_update", configOptions: configs() } } });
function sessionReply(id, loaded = false) {
  if (sessionGate && !fs.existsSync(sessionGate)) { setTimeout(() => sessionReply(id, loaded), 10); return; }
  const suffix = loaded ? "load" : "new";
  const response = { id, result: { ...(loaded ? {} : { sessionId }), configOptions: configs() } };
  if (["config-after-" + suffix, "config-before-" + suffix, "config-before-new-only"].includes(behavior)) {
    model = "gemini-3.8-flash"; thought = "medium";
    const notification = configNotification();
    if (behavior === "config-before-new-only") delete response.result.configOptions;
    else if (behavior === "config-before-" + suffix) { model = "gemini-4-neon"; thought = "high"; }
    sendBatch(behavior === "config-after-" + suffix ? [response, notification] : [notification, response]);
  } else send(response);
}
function editCall(toolCallId) {
  const rawInput = { Path: "/fixture/calc.py", Target: "    return a - b", Replacement: "    return a + b" };
  return { toolCallId, name: "edit_file", title: "Correct the calculation", kind: "edit", args: rawInput, rawInput,
    locations: [{ path: rawInput.Path }], content: [{ type: "diff", path: rawInput.Path, oldText: rawInput.Target, newText: rawInput.Replacement }] };
}
function finish(stopReason = "end_turn") {
  if (!promptRequest) return;
  if (stopReason === "end_turn" && promptGate && !fs.existsSync(promptGate)) { setTimeout(() => finish(), 10); return; }
  if (stopReason === "end_turn" && turnUpdates) {
    for (const frame of turnUpdates) update(frame);
  } else if (stopReason === "end_turn") {
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Starting fixture work." } });
    update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Fixture reasoning 中🙂." } });
    const rawInput = { CommandLine: "python3 test_calc.py", WaitMsBeforeAsync: 5000, toolSummary: "Run calculator tests" };
    if (behavior === "command-precedence") {
      for (const [id, input, title] of [["legacy", { command: "pwd" }, "Current directory"], ["string", "ls -a", "List files"], ["title", {}, "ls -l"]]) {
        update({ sessionUpdate: "tool_call", toolCallId: id, name: "run_command", kind: "execute", status: "completed", rawInput: input, title });
      }
      rawInput.command = "legacy value";
    }
    update({ sessionUpdate: "tool_call", toolCallId: "test-command", name: "run_command", kind: "execute", status: "in_progress",
      ...(behavior === "metadata-only" ? {} : { title: behavior === "command-precedence" ? "Run calculator tests" : rawInput.CommandLine, args: rawInput, rawInput }) });
    update({ sessionUpdate: "tool_call_update", toolCallId: "test-command", status: "completed", ...(behavior === "metadata-only" ? {} : { rawOutput: { exitCode: 0, stdout: "fixture tests passed" } }) });
    update({ sessionUpdate: "tool_call", ...editCall("test-edit"), status: behavior === "failed-edit" ? "pending" : "completed" });
    if (behavior === "failed-edit") update({ sessionUpdate: "tool_call_update", toolCallId: "test-edit", status: "failed" });
    update({ sessionUpdate: "usage_update", used: 123, size: 1000000, cost: { amount: 0.03, currency: "USD" } });
    const body = JSON.stringify({ status: "completed", summary: "Antigravity fixture answer.", key_findings: ["Fixture finding"], assumptions: [], verification: ["fixture check: passed"], blockers: [], question: null });
    update({ sessionUpdate: "agent_message_chunk", messageId: "answer", content: { type: "text", text: body.slice(0, 40) } });
    update({ sessionUpdate: "agent_message_chunk", messageId: "answer", content: { type: "text", text: body.slice(40) } });
  }
  const request = promptRequest; promptRequest = null;
  const usage = stopReason === "cancelled"
    ? { inputTokens: 2068, outputTokens: 149, cachedReadTokens: 7508, cachedWriteTokens: 0, thoughtTokens: 149, totalTokens: 9725 }
    : { inputTokens: 9565, outputTokens: 87, cachedReadTokens: 0, cachedWriteTokens: 0, thoughtTokens: 46, totalTokens: 9652 };
  send({ id: request.id, result: { stopReason, ...(behavior === "no-usage" ? {} : { usage: promptUsage ?? usage }) } });
}
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", line => {
  const message = JSON.parse(line);
  if (!message.method) {
    save(value => value.serverResponses.push(message));
    if (message.id === "load-permission") { sessionReply(pendingLoad, true); return; }
    if (activeMcpCalls.has(message.id)) {
      const call = activeMcpCalls.get(message.id);
      activeMcpCalls.delete(message.id);
      const approved = message.result?.outcome?.outcome === "selected" && message.result.outcome.optionId === "allow";
      update({ ...call, sessionUpdate: "tool_call_update", status: approved ? "in_progress" : "failed" });
      if (approved) update({ ...call, sessionUpdate: "tool_call_update", status: "completed" });
      if (++scriptedReplies === mcpPermissionRequests.length) finish();
      return;
    }
    if (serverRequests.length) {
      if (++scriptedReplies === serverRequests.length) finish();
    } else if (message.id === "1" && behavior !== "permission-cancel") finish();
    return;
  }
  save(value => value.requests.push(message));
  switch (message.method) {
    case "initialize":
      if (behavior === "initialize-hang") break;
      if (behavior === "invalid-json") { process.stdout.write("this is not JSON\n"); break; }
      send({ id: message.id, result: { protocolVersion: behavior === "bad-version" ? 2 : 1,
        agentInfo: { name: "Antigravity ACP Server", ...(version == null ? {} : { version }) },
        agentCapabilities: { loadSession: behavior !== "no-load" }, authMethods: [{ id: "oauth-personal", name: "Google login" }] } });
      break;
    case "session/new": {
      if (behavior === "auth-required") { send({ id: message.id, error: { code: -32000, message: "Authentication required" } }); break; }
      mcpServers = Array.isArray(message.params?.mcpServers) ? message.params.mcpServers : [];
      save(value => { sessionId = "agy-session-" + value.nextSession++; value.sessions.push({ sessionId, cwd: message.params.cwd }); });
      sessionReply(message.id);
      break;
    }
    case "session/load":
      sessionId = message.params.sessionId;
      mcpServers = Array.isArray(message.params?.mcpServers) ? message.params.mcpServers : [];
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OLD REPLAY MUST BE EXCLUDED" } });
      update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "OLD REASONING" } });
      update({ sessionUpdate: "tool_call", toolCallId: "old-command", name: "run_command", kind: "execute", title: "false", status: "completed", rawInput: { CommandLine: "false" }, args: { CommandLine: "false" } });
      if (loadPermission) {
        pendingLoad = message.id;
        send({ id: "load-permission", method: loadPermission.method, params: { sessionId, ...loadPermission.params } });
      } else sessionReply(message.id, true);
      break;
    case "session/set_config_option": {
      const current = configs().find(value => value.id === message.params.configId);
      const values = current?.options.flatMap(value => value.options ?? [value]).map(value => value.value) ?? [];
      if (!values.includes(message.params.value)) { send({ id: message.id, error: { code: -32602, message: "Invalid config value" } }); break; }
      if (message.params.configId === modelId) { model = message.params.value; thought = "low"; }
      else thought = message.params.value;
      const response = { id: message.id, result: { configOptions: configs() } };
      if (message.params.configId === modelId && ["config-after-model", "config-before-model"].includes(behavior)) {
        thinkingOverride = ["low", "high"]; thought = "high";
        const notification = configNotification();
        if (behavior === "config-before-model") { thinkingOverride = null; thought = "low"; }
        sendBatch(behavior === "config-after-model" ? [response, notification] : [notification, response]);
      } else send(response);
      break;
    }
    case "session/prompt":
      promptRequest = message;
      if (mcpPermissionRequests.length) {
        const serverName = mcpServers[0]?.name ?? "duet_parent";
        mcpPermissionRequests.forEach((entry, index) => {
          const reqId = String(index + 1);
          const name = entry.name ?? ("mcp_" + (entry.server ?? serverName) + "_" + entry.tool + (entry.nameSuffix ?? ""));
          const rawInput = Object.hasOwn(entry, "rawInput") ? entry.rawInput : { toolSummary: "Run " + (entry.tool ?? name) };
          const args = Object.hasOwn(entry, "args") ? entry.args : rawInput;
          const toolCallId = entry.toolCallId ?? ("call_mcp_" + (index + 1));
          const base = {
            toolCallId, name, args, kind: entry.kind ?? "other", title: entry.title ?? ("Run " + name), rawInput,
            ...(entry.locations !== undefined ? { locations: entry.locations } : {}),
            ...(entry.content !== undefined ? { content: entry.content } : {})
          };
          const options = entry.options ?? [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" }
          ];
          activeMcpCalls.set(reqId, base);
          update({ sessionUpdate: "tool_call", ...base, status: "in_progress" });
          update({ sessionUpdate: "tool_call_update", ...base, status: "pending" });
          send({ id: reqId, method: "session/request_permission", params: { sessionId, toolCall: { sessionUpdate: "tool_call", ...base, status: "pending" }, options } });
        });
        break;
      }
      if (serverRequests.length) {
        serverRequests.forEach(({ method, params, beforeUpdates = [], afterUpdates = [] }, index) => {
          for (const frame of beforeUpdates) update(frame);
          send({ id: String(index + 1), method, params: { sessionId, ...params } });
          for (const frame of afterUpdates) update(frame);
        });
        break;
      }
      if (behavior === "exit") { process.exit(7); break; }
      if (behavior === "stdout-eof") { output.then(() => process.stdout.end()); break; }
      if (["hold", "ignore-cancel"].includes(behavior)) break;
      if (["permission", "mixed-permission", "permission-cancel", "foreign-permission", "only-always", "permission-partial", "permission-unscoped"].includes(behavior)) {
        const toolCall = { sessionUpdate: "tool_call", ...editCall("edit-1"), status: "pending" };
        if (behavior === "permission-partial") update(toolCall);
        const options = [];
        if (["mixed-permission", "only-always"].includes(behavior)) options.push({ optionId: "trust-forever", name: "Always allow", kind: "allow_always" });
        if (behavior !== "only-always") options.push({ optionId: "allow", name: "Allow", kind: "allow_once" });
        options.push({ optionId: "deny", name: "Deny", kind: "reject_once" });
        send({ id: "1", method: "session/request_permission", params: { sessionId: behavior === "foreign-permission" ? "unrelated-session" : sessionId,
          toolCall: ["permission-partial", "permission-unscoped"].includes(behavior) ? { toolCallId: "edit-1" } : toolCall,
          options } });
        break;
      }
      if (behavior === "unknown-request") { send({ id: "1", method: "fs/write_text_file", params: { sessionId, path: "/outside", content: "denied" } }); break; }
      if (behavior === "foreign-session") update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "FOREIGN MESSAGE" } }, "other-session");
      finish(); break;
    case "session/cancel":
      if (behavior !== "ignore-cancel") finish("cancelled");
      break;
    default:
      if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: "Method not found" } });
  }
});
input.on("close", () => { output.finally(() => process.exit(0)); });
process.stdout.on("error", () => process.exit(0));
`, { mode: 0o755 });
  let binary = script;
  if (process.platform === "win32") {
    binary = path.join(directory, "agy.cmd");
    fs.writeFileSync(binary, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  }
  const state = () => JSON.parse(fs.readFileSync(statePath, "utf8"));
  return { binary, script, statePath, state, requests: () => state().requests };
}
