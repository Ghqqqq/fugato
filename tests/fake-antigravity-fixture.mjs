import fs from "node:fs";
import path from "node:path";

// A real stdio peer exercises framing, bidirectional requests and process
// ownership without installing agy or touching the user's Google credentials.
export function installFakeAntigravity(directory, options = {}) {
  const { behavior = "normal" } = typeof options === "string" ? { behavior: options } : options;
  fs.mkdirSync(directory, { recursive: true });
  const statePath = path.join(directory, "antigravity-state.json");
  const script = path.join(directory, "fake-agy.mjs");
  fs.writeFileSync(statePath, JSON.stringify({ requests: [], serverResponses: [], sessions: [], launches: [], nextSession: 1 }));
  fs.writeFileSync(script, `#!${process.execPath}\nconst statePath = ${JSON.stringify(statePath)};\nconst behavior = ${JSON.stringify(behavior)};\n` + String.raw`
import fs from "node:fs";
import readline from "node:readline";
const read = () => JSON.parse(fs.readFileSync(statePath, "utf8"));
const save = change => {
  const value = read(); change(value);
  const temp = statePath + "." + process.pid + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(value)); fs.renameSync(temp, statePath);
};
if (process.argv.includes("--version") || process.argv.includes("--help")) {
  process.stdout.write("Antigravity fixture ACP v1\n"); process.exit(0);
}
save(value => value.launches.push({ pid: process.pid, args: process.argv.slice(2) }));
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
let sessionId = null, model = "fixture-gemini", thought = "low", promptRequest = null, thinkingOverride = null;
const configs = () => [
  { id: "selected-model", category: "model", name: "Model", type: "select", currentValue: model,
    options: [{ group: "google", name: "Google", options: [{ value: "fixture-gemini", name: "Fixture Gemini" }, { value: "fixture-gemini-fast", name: "Fixture Gemini Fast" }] }] },
  { id: "reasoning-choice", category: "thought_level", name: "Thinking level", type: "select", currentValue: thought,
    options: (thinkingOverride ?? (model === "fixture-gemini-fast" ? ["low", "medium"] : ["low", "high"])).map(value => ({ value, name: value[0].toUpperCase() + value.slice(1) })) }
];
const update = (data, id = sessionId) => send({ method: "session/update", params: { sessionId: id, update: data } });
const configNotification = () => ({ method: "session/update", params: { sessionId, update: { sessionUpdate: "config_option_update", configOptions: configs() } } });
function sessionReply(id, loaded = false) {
  const suffix = loaded ? "load" : "new";
  const response = { id, result: { ...(loaded ? {} : { sessionId }), configOptions: configs() } };
  if (["config-after-" + suffix, "config-before-" + suffix, "config-before-new-only"].includes(behavior)) {
    model = "fixture-gemini-fast"; thought = "medium";
    const notification = configNotification();
    if (behavior === "config-before-new-only") delete response.result.configOptions;
    else if (behavior === "config-before-" + suffix) { model = "fixture-gemini"; thought = "low"; }
    sendBatch(behavior === "config-after-" + suffix ? [response, notification] : [notification, response]);
  } else send(response);
}
function finish(stopReason = "end_turn") {
  if (!promptRequest) return;
  if (stopReason === "end_turn") {
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Starting fixture work." } });
    update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Fixture reasoning 中🙂." } });
    update({ sessionUpdate: "tool_call", toolCallId: "test-command", title: "Run fixture tests", kind: "execute", status: "in_progress", ...(behavior === "metadata-only" ? {} : { rawInput: { command: "node --test" } }) });
    update({ sessionUpdate: "tool_call_update", toolCallId: "test-command", status: "completed", ...(behavior === "metadata-only" ? {} : { rawOutput: { exitCode: 0, stdout: "fixture tests passed" } }) });
    update({ sessionUpdate: "tool_call", toolCallId: "test-edit", title: "Update fixture file", kind: "edit", status: behavior === "failed-edit" ? "pending" : "completed", content: [{ type: "diff", path: "/fixture/result.txt", oldText: "before", newText: "after" }] });
    if (behavior === "failed-edit") update({ sessionUpdate: "tool_call_update", toolCallId: "test-edit", status: "failed" });
    update({ sessionUpdate: "usage_update", used: 123, size: 1000000, cost: { amount: 0.03, currency: "USD" } });
    const body = JSON.stringify({ status: "completed", summary: "Antigravity fixture answer.", key_findings: ["Fixture finding"], assumptions: [], verification: ["fixture check: passed"], blockers: [], question: null });
    update({ sessionUpdate: "agent_message_chunk", messageId: "answer", content: { type: "text", text: body.slice(0, 40) } });
    update({ sessionUpdate: "agent_message_chunk", messageId: "answer", content: { type: "text", text: body.slice(40) } });
  }
  const request = promptRequest; promptRequest = null;
  send({ id: request.id, result: { stopReason } });
}
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", line => {
  const message = JSON.parse(line);
  if (!message.method) {
    save(value => value.serverResponses.push(message));
    if (message.id === "permission-1" && behavior !== "permission-cancel") finish();
    if (message.id === "unsupported-1") finish();
    return;
  }
  save(value => value.requests.push(message));
  switch (message.method) {
    case "initialize":
      if (behavior === "initialize-hang") break;
      if (behavior === "invalid-json") { process.stdout.write("this is not JSON\n"); break; }
      send({ id: message.id, result: { protocolVersion: behavior === "bad-version" ? 2 : 1,
        agentInfo: { name: "Antigravity ACP Server", version: "fixture" },
        agentCapabilities: { loadSession: behavior !== "no-load" }, authMethods: [{ id: "oauth-personal", name: "Google login" }] } });
      break;
    case "session/new": {
      if (behavior === "auth-required") { send({ id: message.id, error: { code: -32000, message: "Authentication required" } }); break; }
      save(value => { sessionId = "agy-session-" + value.nextSession++; value.sessions.push({ sessionId, cwd: message.params.cwd }); });
      sessionReply(message.id);
      break;
    }
    case "session/load":
      sessionId = message.params.sessionId;
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OLD REPLAY MUST BE EXCLUDED" } });
      update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "OLD REASONING" } });
      update({ sessionUpdate: "tool_call", toolCallId: "old-command", kind: "execute", title: "Old command", status: "completed", rawInput: { command: "false" } });
      sessionReply(message.id, true);
      break;
    case "session/set_config_option": {
      const current = configs().find(value => value.id === message.params.configId);
      const values = current?.options.flatMap(value => value.options ?? [value]).map(value => value.value) ?? [];
      if (!values.includes(message.params.value)) { send({ id: message.id, error: { code: -32602, message: "Invalid config value" } }); break; }
      if (message.params.configId === "selected-model") { model = message.params.value; thought = "low"; }
      else thought = message.params.value;
      const response = { id: message.id, result: { configOptions: configs() } };
      if (message.params.configId === "selected-model" && ["config-after-model", "config-before-model"].includes(behavior)) {
        thinkingOverride = ["low", "high"]; thought = "high";
        const notification = configNotification();
        if (behavior === "config-before-model") { thinkingOverride = null; thought = "low"; }
        sendBatch(behavior === "config-after-model" ? [response, notification] : [notification, response]);
      } else send(response);
      break;
    }
    case "session/prompt":
      promptRequest = message;
      if (behavior === "exit") { process.exit(7); break; }
      if (behavior === "stdout-eof") { output.then(() => process.stdout.end()); break; }
      if (["hold", "ignore-cancel"].includes(behavior)) break;
      if (["permission", "permission-cancel", "foreign-permission", "only-always", "permission-partial", "permission-unscoped"].includes(behavior)) {
        const toolCall = { toolCallId: "edit-1", title: "Edit result", kind: "edit", locations: [{ path: "/fixture/result.txt" }], rawInput: { path: "/fixture/result.txt", content: "updated" } };
        if (behavior === "permission-partial") update({ sessionUpdate: "tool_call", ...toolCall, status: "pending" });
        send({ id: "permission-1", method: "session/request_permission", params: { sessionId: behavior === "foreign-permission" ? "unrelated-session" : sessionId,
          toolCall: ["permission-partial", "permission-unscoped"].includes(behavior) ? { toolCallId: "edit-1" } : toolCall,
          options: [{ optionId: "trust-forever", name: "Always allow", kind: "allow_always" },
            ...(behavior === "only-always" ? [] : [{ optionId: "allow-this", name: "Allow once", kind: "allow_once" }]),
            { optionId: "deny-this", name: "Deny", kind: "reject_once" }] } });
        break;
      }
      if (behavior === "unknown-request") { send({ id: "unsupported-1", method: "fs/write_text_file", params: { sessionId, path: "/outside", content: "denied" } }); break; }
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
  return { binary, statePath, state, requests: () => state().requests };
}
