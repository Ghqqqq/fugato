import "./test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { installFakeAntigravity } from "./fake-antigravity-fixture.mjs";
import { AcpClient } from "../plugins/codex/scripts/lib/acp-client.mjs";
import { upsertJob, readJobFile, resolveJobFile } from "../plugins/codex/scripts/lib/state.mjs";
import { formatActivity } from "../plugins/codex/scripts/lib/activity.mjs";
import { parseStructuredReport } from "../plugins/codex/scripts/lib/worker-report.mjs";
import { ensureAntigravityAvailable, listAntigravityModels, resolveAntigravityExecutable, runAntigravityTurn } from "../plugins/codex/scripts/lib/antigravity.mjs";

function fixture(t, options = "normal", version = "1.5.16") {
  const directory = fs.mkdtempSync(path.join(process.env.CODEX_COMPANION_TEST_ROOT, "agy-"));
  const installed = installFakeAntigravity(directory, typeof options === "string" ? { behavior: options, version } : options);
  const before = process.env.FUGATO_ANTIGRAVITY_BIN;
  process.env.FUGATO_ANTIGRAVITY_BIN = installed.binary;
  t.after(() => {
    if (before === undefined) delete process.env.FUGATO_ANTIGRAVITY_BIN;
    else process.env.FUGATO_ANTIGRAVITY_BIN = before;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { ...installed, directory, run: options => runAntigravityTurn(directory, { prompt: "Complete the fixture task.", sandbox: "danger-full-access", ...options }) };
}

const stopped = pid => {
  try { process.kill(pid, 0); return false; }
  catch (error) { if (error.code === "ESRCH") return true; throw error; }
};

const permissionRequest = toolCall => ({ method: "session/request_permission", params: { toolCall,
  options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] } });

function commandCall(toolCallId, command) {
  const rawInput = { CommandLine: command, WaitMsBeforeAsync: 5000, toolSummary: "List directory contents" };
  return { sessionUpdate: "tool_call", toolCallId, name: "run_command", kind: "execute", status: "pending", title: command, rawInput, args: rawInput };
}

test("a one-time permission answer applies only to the reviewed operation", async t => {
  const pending = commandCall("pending", "ls -la"), cached = commandCall("revised", "ls -la");
  const replacement = commandCall("revised", "ls docs").args;
  const requests = [
    { ...permissionRequest(pending), afterUpdates: [{ sessionUpdate: "tool_call_update", toolCallId: "pending", rawInput: replacement }] },
    { ...permissionRequest({ toolCallId: "revised", args: replacement }), beforeUpdates: [cached], afterUpdates: [
      { sessionUpdate: "tool_call_update", toolCallId: "revised", status: "in_progress", rawInput: Object.fromEntries(Object.entries(replacement).reverse()) }
    ] },
    permissionRequest({ ...commandCall("conflict", "ls -la"), args: replacement }),
    permissionRequest(commandCall("last", "pwd"))
  ];
  const fake = fixture(t, { serverRequests: requests, turnUpdates: [] });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const shown = new Map();
  const result = await fake.run({ signal: AbortSignal.timeout(10000), onApprovalRequest: async ({ question, toolCall }) => {
    shown.set(toolCall.toolCallId, question.split("\n").find(line => line.startsWith("Arguments: ")));
    if (["pending", "revised"].includes(toolCall.toolCallId)) await gate;
    if (toolCall.toolCallId === "last") release();
    return "once";
  } });
  assert.equal(shown.get("pending"), `Arguments: ${JSON.stringify(pending.rawInput)}`);
  assert.equal(shown.get("revised"), `Arguments: ${JSON.stringify(replacement)}`);
  assert.equal(shown.has("conflict"), false);
  const replies = Object.fromEntries(fake.state().serverResponses.map(reply => [reply.id, reply.result.outcome.optionId]));
  assert.deepEqual(replies, { 1: "deny", 2: "allow", 3: "deny", 4: "allow" });
  assert.deepEqual(result.blockers.map(blocker => blocker.code), Array(2).fill("operation-changed-before-approval"));
});

test("command checks exclude denied calls and agy's own unapproved permission failures", async t => {
  const denied = commandCall("denied", "ls -la"), approved = commandCall("approved", "ls docs");
  const rawOutput = 'permission check failed for unsandboxed "ls -la": user denied permission to run command:\nls -la';
  const failed = (id, output) => ({ sessionUpdate: "tool_call_update", toolCallId: id, status: "failed", rawOutput: output,
    content: [{ type: "content", content: { type: "text", text: output } }] });
  const fake = fixture(t, { serverRequests: [denied, approved, commandCall("denied-without-output", "pwd")].map(permissionRequest), turnUpdates: [
    failed("denied", rawOutput), commandCall("agy-denied", "ls -la"), failed("agy-denied", rawOutput),
    commandCall("filesystem-error", "ls private"), failed("filesystem-error", "ls: private: Permission denied"),
    failed("approved", rawOutput)
  ] });
  const result = await fake.run({ onApprovalRequest: ({ toolCall }) => toolCall.toolCallId === "approved" ? "once" : "deny" });
  assert.deepEqual(result.commandExecutions.map(command => command.id), ["approved", "filesystem-error"]);
  assert.deepEqual(result.blockers.map(blocker => blocker.code), Array(3).fill("approval_denied"));
});

test("Antigravity includes cache reads and writes in Fugato input token totals", async t => {
  const fake = fixture(t, { promptUsage: { inputTokens: 2068, cachedReadTokens: 7508, cachedWriteTokens: 12,
    outputTokens: 149, thoughtTokens: 149, totalTokens: 9737 } });
  assert.deepEqual((await fake.run()).usage,
    { inputTokens: 9588, cachedInputTokens: 7508, outputTokens: 149, reasoningOutputTokens: 149, totalTokens: 9737 });
});

test("Antigravity retains the latest edit diffs through a text-only completion", async t => {
  const first = { type: "diff", path: "/fixture/calc.py", oldText: "return a - b", newText: "return a + b" };
  const second = { type: "diff", path: "/fixture/test_calc.py", oldText: "pass", newText: "assert add(1, 2) == 3" };
  const rawInput = { Path: first.path, Target: first.oldText, Replacement: first.newText };
  const fake = fixture(t, { turnUpdates: [
    { sessionUpdate: "tool_call", toolCallId: "edit", name: "edit_file", kind: "edit", args: rawInput, rawInput, status: "pending",
      content: [first], locations: [{ path: first.path }, { path: "/fixture/input.txt" }] },
    { sessionUpdate: "tool_call_update", toolCallId: "edit", status: "in_progress", content: [second] },
    { sessionUpdate: "tool_call_update", toolCallId: "edit", status: "completed", content: [{ type: "content", content: { type: "text", text: "Updated." } }] }
  ] });
  const result = await fake.run();
  // Each diff-bearing update replaces the proposal, and the text result preserves it.
  assert.deepEqual(result.touchedFiles, [second.path]);
  assert.deepEqual(result.fileChanges[0].content.filter(block => block.type === "diff"), [second]);
});

test("a revised pending edit reports only the file presented for approval", async t => {
  const proposal = path => ({
    rawInput: { Path: path, Target: "before", Replacement: "after" }, locations: [{ path }],
    content: [{ type: "diff", path, oldText: "before", newText: "after" }]
  });
  const toolCallId = "edit";
  const fake = fixture(t, { serverRequests: [{ ...permissionRequest({ toolCallId }), beforeUpdates: [
    { sessionUpdate: "tool_call", toolCallId, name: "edit_file", kind: "edit", status: "pending", ...proposal("/fixture/a.txt") },
    { sessionUpdate: "tool_call_update", toolCallId, ...proposal("/fixture/b.txt") }
  ] }], turnUpdates: [{ sessionUpdate: "tool_call_update", toolCallId, status: "completed" }] });
  const activity = [];
  let question;
  const result = await fake.run({
    onApprovalRequest: request => { question = request.question; return "once"; },
    onProgress: event => activity.push(...(event.activity ?? []))
  });
  assert.match(question, /\/fixture\/b\.txt/);
  assert.doesNotMatch(question, /\/fixture\/a\.txt/);
  assert.deepEqual(result.touchedFiles, ["/fixture/b.txt"]);
  assert.deepEqual(activity.filter(item => item.type === "fileChange").map(item => item.path), ["/fixture/b.txt"]);
});

test("revised edits without diffs report the new locations from updates and permission requests", async t => {
  const target = path => ({ rawInput: { Path: path }, locations: [{ path }] });
  const proposal = (toolCallId, path) => ({ sessionUpdate: "tool_call", toolCallId, name: "edit_file", kind: "edit",
    status: "pending", ...target(path), content: [{ type: "diff", path, oldText: "before", newText: "after" }] });
  const completed = toolCallId => ({ sessionUpdate: "tool_call_update", toolCallId, status: "completed" });
  const review = { toolCallId: "review", ...target("/fixture/b.txt"), content: [{ type: "content", content: { type: "text", text: "Revised edit." } }] };
  const fake = fixture(t, { serverRequests: [{ ...permissionRequest(review), beforeUpdates: [proposal("review", "/fixture/a.txt")] }],
    turnUpdates: [completed("review"), proposal("edit", "/A"),
      { sessionUpdate: "tool_call_update", toolCallId: "edit", ...target("/B"), content: [] }, completed("edit")] });
  const activity = [];
  const result = await fake.run({ onApprovalRequest: () => "once", onProgress: event => activity.push(...(event.activity ?? [])) });
  assert.deepEqual(result.touchedFiles, ["/fixture/b.txt", "/B"]);
  assert.deepEqual(result.fileChanges.map(tool => tool.content), [review.content, []]);
  assert.deepEqual(activity.filter(item => item.type === "fileChange").map(item => item.path), ["/fixture/b.txt", "/B"]);
});

test("a tool status update separates anonymous progress from the final report", async t => {
  const chunk = text => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  const notice = "Waiting for the command.";
  const body = JSON.stringify({ status: "completed", summary: "Command finished." });
  const fake = fixture(t, { turnUpdates: [
    { ...commandCall("list", "ls"), status: "in_progress" }, chunk(notice),
    { sessionUpdate: "tool_call_update", toolCallId: "list", status: "completed" }, chunk(body)
  ] });
  const messages = [];
  const result = await fake.run({ onProgress: event => messages.push(...(event.activity ?? []).filter(item => item.type === "agentMessage")) });
  assert.equal(result.finalMessage, body);
  assert.equal(parseStructuredReport(result.finalMessage)?.summary, "Command finished.");
  assert.deepEqual(messages.map(item => item.body), [notice, "Command finished."]);
});

test("repeated tool statuses and late output preserve an anonymous report", async t => {
  const chunk = text => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  const status = value => ({ sessionUpdate: "tool_call_update", toolCallId: "active", status: value });
  const body = JSON.stringify({ status: "completed", summary: "Command finished." });
  const notice = "Waiting for the command.";
  const fake = fixture(t, { turnUpdates: [
    { ...commandCall("finished", "ls"), status: "completed" }, chunk(notice),
    status("in_progress"), chunk(body.slice(0, 12)),
    status("in_progress"), status("pending"), status("in_progress"), chunk(body.slice(12, 24)),
    { sessionUpdate: "tool_call_update", toolCallId: "finished", rawOutput: { exitCode: 0 } }, chunk(body.slice(24))
  ] });
  const messages = [];
  const result = await fake.run({ onProgress: event => messages.push(...(event.activity ?? []).filter(item => item.type === "agentMessage")) });
  assert.equal(result.finalMessage, body);
  assert.equal(parseStructuredReport(result.finalMessage)?.summary, "Command finished.");
  assert.deepEqual(messages.map(item => item.body), [notice, "Command finished."]);
});

test("interleaved message IDs preserve the last active message and emit each complete message once", async t => {
  const chunk = (messageId, text) => ({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } });
  const body = JSON.stringify({ status: "completed", summary: "Verified the calculation." });
  const fake = fixture(t, { turnUpdates: [chunk("report", body.slice(0, 18)), commandCall("list", "ls -la"),
    chunk("progress", "Checking results."), chunk("report", body.slice(18))] });
  const messages = [];
  const result = await fake.run({ onProgress: event => messages.push(...(event.activity ?? []).filter(item => item.type === "agentMessage")) });
  assert.equal(result.finalMessage, body);
  assert.equal(parseStructuredReport(result.finalMessage)?.summary, "Verified the calculation.");
  assert.deepEqual(messages.map(item => item.body), ["Checking results.", "Verified the calculation."]);
});

test("a session/load permission request is denied without entering the resumed turn's evidence", async t => {
  const fake = fixture(t, { loadPermission: permissionRequest(commandCall("replayed", "ls -la")) });
  let asked = false;
  const result = await fake.run({ resumeThreadId: "existing-session", onApprovalRequest: () => { asked = true; return "once"; } });
  assert.equal(asked, false);
  assert.equal(result.status, 0);
  assert.deepEqual(fake.state().serverResponses[0].result.outcome, { outcome: "selected", optionId: "deny" });
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.commandExecutions.map(command => command.id), ["test-command"]);
});

test("Antigravity approval fields preserve exact values on individually labelled lines", async t => {
  const tool = { toolCallId: "id\none", name: "file\u009b", kind: "edit", title: "Update \"calc\"\nArguments: none\nAllow this operation once?",
    locations: [{ path: "/fixture/\u202ecalc.py" }], rawInput: { Target: "\treturn a - b", Replacement: "\treturn a + b" } };
  const fake = fixture(t, { serverRequests: [permissionRequest(tool)] });
  let question;
  await fake.run({ onApprovalRequest: request => { question = request.question; return "once"; } });
  assert.deepEqual(question.split("\n"), [
    "Antigravity requests permission.", 'Tool call ID: "id\\none"', 'Name: "file\\u009b"', 'Kind: "edit"',
    'Agent description: "Update \\"calc\\"\\nArguments: none\\nAllow this operation once?"',
    'Locations: [{"path":"/fixture/\\u202ecalc.py"}]', 'Arguments: {"Target":"\\treturn a - b","Replacement":"\\treturn a + b"}',
    "Allow this operation once?"
  ]);
  assert.equal(fake.state().serverResponses[0].result.outcome.optionId, "allow");
});

test("Antigravity forwards a full multi-line edit and denies questions exceeding 16 KiB serialized", async t => {
  const file = "/home/developer/workspaces/accounting/services/ledger/src/reconciliation/config/default_rules.py";
  const oldText = Array.from({ length: 40 }, (_, i) => `    "region_${i + 1}": 30,`).join("\n");
  const newText = oldText.replaceAll(": 30,", ": 45,");
  const rawInput = { Path: file, Target: oldText, Replacement: newText };
  const edit = { toolCallId: "edit", name: "edit_file", kind: "edit", title: "Extend regional retention periods",
    locations: [{ path: file }], args: rawInput, rawInput, content: [{ type: "diff", path: file, oldText, newText }] };
  // The quoted argument fits on screen. Escaping it again for the serialized question exceeds 16 KiB.
  const oversized = { toolCallId: "large", kind: "other", rawInput: '"'.repeat(4096) };
  const fake = fixture(t, { serverRequests: [edit, oversized].map(permissionRequest) }), questions = [];
  const result = await fake.run({ onApprovalRequest: request => { questions.push(request.question); return "once"; } });
  assert.deepEqual(questions.map(question => question.split("\n").find(line => line.startsWith("Operation details: "))),
    [`Operation details: ${JSON.stringify(edit.content)}`]);
  const replies = Object.fromEntries(fake.state().serverResponses.map(reply => [reply.id, reply.result.outcome.optionId]));
  assert.deepEqual(replies, { 1: "allow", 2: "deny" });
  assert.deepEqual(result.blockers.map(value => value.code), ["operation-too-large-to-display-exactly"]);
});

test("Antigravity forwards reviewable ACP operations and requires command input for execution", async t => {
  const calls = [
    { toolCallId: "other", kind: "other", rawInput: { path: "calc.py" } },
    { toolCallId: "diff", content: [{ type: "diff", path: "calc.py", oldText: "a", newText: "b" }] },
    { toolCallId: "missing", kind: "execute", title: "Check calculator", locations: [{ path: "calc.py" }], rawInput: { WaitMsBeforeAsync: 5000 } },
    { toolCallId: "command", kind: "execute", rawInput: { CommandLine: "python3 test_calc.py" } },
    { toolCallId: "location-only", locations: [{ path: "calc.py" }] }
  ];
  const fake = fixture(t, { serverRequests: calls.map(permissionRequest) }), asked = [];
  const result = await fake.run({ onApprovalRequest: request => { asked.push(request.toolCall.toolCallId); return "once"; } });
  assert.deepEqual(asked, ["other", "diff", "command"]);
  const replies = Object.fromEntries(fake.state().serverResponses.map(value => [value.id, value.result.outcome.optionId]));
  assert.deepEqual(replies, { 1: "allow", 2: "allow", 3: "deny", 4: "allow", 5: "deny" });
  assert.match(result.blockers.find(value => value.code === "missing-command-line").message, /without a command line/);
});

test("Antigravity preserves identified report chunks across a tool call and publishes each message once", async t => {
  const chunk = (text, messageId) => ({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } });
  const tool = toolCallId => ({ sessionUpdate: "tool_call", toolCallId, kind: "read", status: "completed" });
  const body = JSON.stringify({ status: "completed", summary: "Verified the calculator." });
  const fake = fixture(t, { turnUpdates: [chunk("First message.", "first"), tool("read-1"), chunk("Anonymous message."),
    chunk(body.slice(0, 18), "report"), tool("read-2"), chunk(body.slice(18), "report")] });
  const activity = [];
  const result = await fake.run({ onProgress: event => activity.push(...(event.activity ?? [])) });
  assert.equal(result.finalMessage, body);
  assert.equal(parseStructuredReport(result.finalMessage)?.summary, "Verified the calculator.");
  assert.deepEqual(activity.filter(value => value.type === "agentMessage").map(value => value.body),
    ["First message.", "Anonymous message.", "Verified the calculator."]);
});

test("Antigravity uses reported diff paths and excludes location-only read inputs from edits", async t => {
  const edit = { sessionUpdate: "tool_call", toolCallId: "edit", kind: "edit", status: "completed",
    content: [{ type: "diff", path: "calc.py", oldText: "a", newText: "b" }], locations: [{ path: "calc.py" }, { path: "input.txt" }] };
  const source = { sessionUpdate: "tool_call", toolCallId: "source", kind: "read", status: "completed", locations: [{ path: "source.txt" }] };
  const fake = fixture(t, { turnUpdates: [edit, source] }), activity = [];
  const result = await fake.run({ onProgress: event => activity.push(...(event.activity ?? [])) });
  assert.deepEqual(result.touchedFiles, ["calc.py"]);
  assert.deepEqual(activity.filter(value => value.type === "fileChange").map(value => value.path), ["calc.py"]);
});

test("Antigravity bounds unsupported method diagnostics and replies to every request", async t => {
  const methods = Array.from({ length: 16 }, (_, index) => "private\n\u202e" + "m".repeat(100) + index);
  const fake = fixture(t, { serverRequests: methods.map(method => ({ method, params: {} })) });
  const result = await fake.run();
  assert.equal(result.blockers.length, 8);
  for (const blocker of result.blockers) {
    assert.equal(blocker.code, "approval_unsupported");
    assert.match(blocker.method, /^unrecognized:[0-9a-f]{16}$/);
    assert.doesNotMatch(blocker.message, /private|[\n\u202e]/);
    assert.ok(blocker.message.length < 100);
  }
  assert.equal(new Set(result.blockers.map(value => value.method)).size, 8);
  const replies = fake.state().serverResponses;
  assert.equal(replies.length, methods.length);
  assert.ok(replies.every(value => value.error.code === -32601));
});

test("Antigravity parses fragmented UTF-8 ACP frames and captures only the final response", async t => {
  const fake = fixture(t, "fragmented"), progress = [];
  const result = await fake.run({ onProgress: value => progress.push(value), developerInstructions: "Follow the task instructions.", outputSchema: { type: "object" } });
  assert.equal(result.status, 0);
  assert.equal(result.turnEnded, true);
  assert.equal(result.turn.status, "completed");
  assert.equal(JSON.parse(result.finalMessage).summary, "Antigravity fixture answer.");
  assert.deepEqual(result.reasoningSummary, ["Fixture reasoning 中🙂."]);
  assert.deepEqual(result.touchedFiles, ["/fixture/calc.py"]);
  assert.equal(result.commandExecutions[0].command, "python3 test_calc.py");
  assert.equal(result.commandExecutions[0].exitCode, 0);
  assert.deepEqual(result.acpUsage, { used: 123, size: 1000000, cost: { amount: 0.03, currency: "USD" } });
  assert.equal(progress.some(value => value.threadId === result.threadId && value.turnId === result.turnId), true);
  const activity = progress.flatMap(value => value.activity ?? []);
  const messages = activity.filter(value => value.type === "agentMessage");
  assert.deepEqual(messages.map(value => value.body), ["Starting fixture work.", "Antigravity fixture answer."]);
  assert.equal(formatActivity({ ...messages[0], seq: 1 }), "[1] Antigravity: Starting fixture work.");
  assert.equal(formatActivity({ type: "agentMessage", text: "Working.", seq: 2 }), "[2] Codex: Working.");
  assert.equal(activity.find(value => value.type === "commandExecution" && value.lifecycle === "started").command, "python3 test_calc.py");
  assert.equal(activity.find(value => value.type === "commandExecution" && value.lifecycle === "completed").exitCode, 0);
  assert.equal(activity.find(value => value.type === "fileChange").path, "/fixture/calc.py");
  assert.equal(progress.find(value => value.item?.callId === "test-command").item.title, "python3 test_calc.py");
  const initialize = fake.requests()[0];
  assert.equal(initialize.params.protocolVersion, 1);
  assert.equal(initialize.params.clientInfo.name, "fugato");
  assert.deepEqual(initialize.params.clientCapabilities, {});
  assert.deepEqual(fake.state().launches[0].args, ["acp"]);
  const prompt = fake.requests().find(value => value.method === "session/prompt").params;
  assert.equal(prompt.prompt.length, 3);
  assert.match(prompt.prompt[0].text, /Follow the task instructions/);
  assert.equal(prompt.outputSchema, undefined, "ACP has no portable outputSchema argument");
  assert.equal(stopped(fake.state().launches[0].pid), true);
});

test("Antigravity reads account model options and does not invent thinking support for unselected models", async t => {
  const fake = fixture(t);
  const result = await listAntigravityModels(fake.directory);
  assert.equal(result.provider, "antigravity");
  assert.deepEqual(result.data.map(value => value.id), ["gemini-4-neon", "gemini-4-carbon", "gemini-pro-orchestrator", "gemini-3.8-flash"]);
  assert.equal(result.data[0].isDefault, true);
  assert.deepEqual(result.data[0].supportedReasoningEfforts.map(value => value.reasoningEffort), ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(result.data[1].supportedReasoningEfforts, []);
  assert.equal(fake.requests().some(value => value.method === "session/prompt"), false);
});

test("Antigravity applies dynamic config IDs and refreshes thinking options after changing model", async t => {
  const fake = fixture(t, "dynamic-selectors");
  const result = await fake.run({ model: "gemini-3.8-flash", effort: "Medium" });
  assert.equal(result.model, "gemini-3.8-flash");
  assert.equal(result.effort, "medium");
  const settings = fake.requests().filter(value => value.method === "session/set_config_option").map(value => value.params);
  assert.deepEqual(settings, [
    { sessionId: result.threadId, configId: "selected-model", value: "gemini-3.8-flash" },
    { sessionId: result.threadId, configId: "reasoning-choice", value: "medium" }
  ]);
});

test("Antigravity persists the server's fallback model and thinking level before sending the prompt", async t => {
  const fake = fixture(t, { modelIds: ["gemini-4-carbon", "gemini-3.8-flash"], currentModel: "gemini-3.8-flash", currentEffort: "medium" });
  const jobId = "task-selection";
  upsertJob(fake.directory, { id: jobId, backend: "antigravity", workspaceRoot: fake.directory, status: "queued" });
  const request = AcpClient.prototype.request;
  let atPrompt;
  t.mock.method(AcpClient.prototype, "request", function(method, ...args) {
    if (method === "session/prompt") atPrompt = readJobFile(resolveJobFile(fake.directory, jobId));
    return request.call(this, method, ...args);
  });
  const result = await fake.run({ jobId, model: "gemini-4-neon", effort: "xhigh", modelDefault: true, effortDefault: true });
  assert.deepEqual([atPrompt.selectedModel, atPrompt.selectedEffort], ["gemini-3.8-flash", "medium"]);
  assert.equal(result.status, 0);
  assert.deepEqual([result.model, result.effort], [atPrompt.selectedModel, atPrompt.selectedEffort]);
});

for (const [behavior, model, effort] of [
  ["config-after-new", "gemini-3.8-flash", "medium"],
  ["config-before-new", "gemini-4-neon", "high"],
  ["config-before-new-only", "gemini-3.8-flash", "medium"]
]) {
  test(`Antigravity run and model discovery respect wire order for ${behavior}`, async t => {
    const fake = fixture(t, behavior);
    const result = await fake.run();
    assert.deepEqual([result.model, result.effort], [model, effort]);
    const catalog = await listAntigravityModels(fake.directory);
    const selected = catalog.data.find(value => value.isDefault);
    assert.deepEqual([selected.model, selected.defaultReasoningEffort], [model, effort]);
  });
}

for (const [behavior, effort] of [["config-after-model", "high"], ["config-before-model", "medium"]]) {
  test(`Antigravity chooses thinking from the latest configuration in ${behavior}`, async t => {
    const fake = fixture(t, behavior);
    const result = await fake.run({ model: "gemini-3.8-flash", effort });
    assert.deepEqual([result.model, result.effort], ["gemini-3.8-flash", effort]);
    assert.equal(result.status, 0);
    const settings = fake.requests().filter(value => value.method === "session/set_config_option");
    assert.equal(settings.length, behavior === "config-after-model" ? 1 : 2);
  });
}

for (const [behavior, model, effort] of [["config-after-load", "gemini-3.8-flash", "medium"], ["config-before-load", "gemini-4-neon", "high"]]) {
  test(`Antigravity session restoration respects ${behavior}`, async t => {
    const fake = fixture(t, behavior);
    const first = await fake.run();
    const result = await fake.run({ resumeThreadId: first.threadId });
    assert.deepEqual([result.model, result.effort], [model, effort]);
    assert.doesNotMatch(result.finalMessage, /OLD/);
  });
}

test("Antigravity rejects an unavailable model or incompatible thinking level before prompt submission", async t => {
  const fake = fixture(t);
  await assert.rejects(fake.run({ model: "gemini-invented" }), error => error.turnStatus === "notStarted" && /Available values: gemini-4-neon/.test(error.message));
  await assert.rejects(fake.run({ model: "gemini-3.8-flash", effort: "high" }), /Available values: low, medium/);
  assert.equal(fake.requests().some(value => value.method === "session/prompt"), false);
});

test("Antigravity continuation excludes replayed messages, thoughts and commands", async t => {
  const fake = fixture(t);
  const first = await fake.run();
  const next = await fake.run({ resumeThreadId: first.threadId,
    parentBridge: { cwd: fake.directory, threadId: first.threadId } });
  assert.equal(next.threadId, first.threadId);
  assert.notEqual(next.turnId, first.turnId);
  assert.doesNotMatch(next.finalMessage, /OLD/);
  assert.doesNotMatch(next.reasoningSummary.join(""), /OLD/);
  assert.equal(next.commandExecutions.length, 1);
  assert.equal(fake.requests().filter(value => value.method === "session/new").length, 1);
  const load = fake.requests().find(value => value.method === "session/load").params;
  assert.equal(load.mcpServers.length, 1);
  assert.equal(load.mcpServers[0].name, "duet_parent");
  assert.equal(load.mcpServers[0].env.find(value => value.name === "CODEX_COMPANION_BRIDGE_THREAD").value, first.threadId);
});

test("Antigravity permission replies use only the explicitly selected allow_once option", async t => {
  const fake = fixture(t, "mixed-permission"), requests = [];
  const result = await fake.run({ onApprovalRequest: request => { requests.push(request); return "once"; } });
  assert.equal(result.status, 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].kind, "acp-permission");
  assert.deepEqual(requests[0].binding, { threadId: result.threadId, turnId: result.turnId });
  assert.match(requests[0].question, /\/fixture\/calc\.py/);
  assert.equal(fake.state().serverResponses[0].id, "1");
  assert.deepEqual(fake.state().serverResponses[0].result, { outcome: { outcome: "selected", optionId: "allow" } });
  assert.deepEqual(result.blockers, []);
});

test("Antigravity id-only permission updates retain the observed operation and arguments", async t => {
  const fake = fixture(t, "permission-partial");
  let request;
  const result = await fake.run({ onApprovalRequest: value => { request = value; return "once"; } });
  assert.equal(result.status, 0);
  assert.equal(request.toolCall.kind, "edit");
  assert.deepEqual(request.toolCall.rawInput, { Path: "/fixture/calc.py", Target: "    return a - b", Replacement: "    return a + b" });
  assert.match(request.question, /edit/);
  assert.match(request.question, /\/fixture\/calc\.py/);
  assert.match(request.question, /return a \+ b/);
  assert.deepEqual(fake.state().serverResponses[0].result, { outcome: { outcome: "selected", optionId: "allow" } });
});

for (const behavior of ["permission", "foreign-permission", "only-always", "permission-unscoped"]) {
  test(`Antigravity fails closed for ${behavior} without a valid one-time grant`, async t => {
    const fake = fixture(t, behavior);
    let asked = false;
    const result = await fake.run({ ...(behavior === "permission" ? {} : { onApprovalRequest: () => { asked = true; return "once"; } }) });
    assert.equal(asked, false);
    assert.deepEqual(fake.state().serverResponses[0].result, { outcome: { outcome: "selected", optionId: "deny" } });
    assert.equal(result.blockers.some(value => value.code === "approval_denied"), true);
  });
}

test("Antigravity rejects unknown client RPCs instead of claiming unsupported filesystem access", async t => {
  const fake = fixture(t, "unknown-request");
  const result = await fake.run();
  assert.equal(fake.state().serverResponses[0].error.code, -32601);
  assert.equal(result.blockers[0].code, "approval_unsupported");
});

test("Antigravity cancels a turn through its session and records the actual acknowledgement", async t => {
  const fake = fixture(t, "hold"), controller = new AbortController();
  const result = await fake.run({ signal: controller.signal, onProgress: value => { if (value.turnId) controller.abort(); } });
  assert.equal(result.turnEnded, true);
  assert.equal(result.turn.status, "interrupted");
  assert.equal(result.turnInterruptAttempted, true);
  assert.equal(result.interruptionConfirmed, true);
  const cancel = fake.requests().find(value => value.method === "session/cancel");
  assert.equal(cancel.id, undefined);
  assert.deepEqual(cancel.params, { sessionId: result.threadId });
  assert.equal(result.acpProcessExited, true);
  assert.deepEqual(result.usage, { inputTokens: 9576, cachedInputTokens: 7508, outputTokens: 149, reasoningOutputTokens: 149, totalTokens: 9725 });
});

test("Antigravity reports token counts from the prompt response only", async t => {
  const result = await fixture(t).run();
  assert.deepEqual(result.usage, { inputTokens: 9565, cachedInputTokens: 0, outputTokens: 87, reasoningOutputTokens: 46, totalTokens: 9652 });
  await t.test("a turn with context occupancy alone", async t => {
    const result = await fixture(t, "no-usage").run();
    assert.equal(result.acpUsage.used, 123);
    assert.equal(Object.hasOwn(result, "usage"), false);
  });
});

test("Antigravity cancellation settles pending permissions even if the parent callback never answers", async t => {
  const fake = fixture(t, "permission-cancel"), controller = new AbortController();
  const result = await fake.run({ signal: controller.signal, onApprovalRequest: () => {
    setTimeout(() => controller.abort(), 10);
    return new Promise(() => {});
  } });
  assert.equal(result.interruptionConfirmed, true);
  assert.deepEqual(fake.state().serverResponses[0].result, { outcome: { outcome: "cancelled" } });
});

test("Antigravity forced cleanup does not invent an unreceived cancel acknowledgement", async t => {
  const fake = fixture(t, "ignore-cancel"), controller = new AbortController();
  const result = await fake.run({ signal: controller.signal, cancelTimeoutMs: 30,
    onProgress: value => { if (value.turnId) controller.abort(); } });
  assert.equal(result.interruptionConfirmed, false);
  assert.equal(result.turnEnded, false);
  assert.equal(result.acpProcessExited, true);
  assert.equal(result.status, 1);
  assert.equal(stopped(fake.state().launches[0].pid), true);
});

test("Antigravity never loads or replaces a continuation when loadSession is unsupported", async t => {
  const fake = fixture(t, "no-load");
  await assert.rejects(fake.run({ resumeThreadId: "existing-session" }), /does not support loading sessions/);
  assert.deepEqual(fake.requests().map(value => value.method), ["initialize"]);
});

test("Antigravity requires ordered history replay before loading an existing session", async t => {
  for (const version of [null, "1.5.9", "1.5.15-rc.1", "1.5.15"]) {
    await t.test(version ?? "missing version", async t => {
      const fake = fixture(t, "normal", version);
      const continuation = fake.run({ resumeThreadId: "existing-session" });
      if (version === "1.5.15") {
        assert.equal((await continuation).threadId, "existing-session");
        assert.deepEqual(fake.requests().map(value => value.method), ["initialize", "session/load", "session/prompt"]);
      } else {
        await assert.rejects(continuation, error => error.turnStatus === "notStarted" && /1\.5\.15.*history replay/.test(error.message));
        assert.deepEqual(fake.requests().map(value => value.method), ["initialize"]);
      }
    });
  }
});

for (const [behavior, pattern] of [["auth-required", /agy acp --login/], ["bad-version", /unsupported ACP version 2/], ["invalid-json", /invalid JSON/], ["initialize-hang", /initialize timed out/]]) {
  test(`Antigravity reports ${behavior} without interactive authentication or a surviving process`, async t => {
    const fake = fixture(t, behavior);
    await assert.rejects(fake.run({ connectTimeoutMs: behavior === "initialize-hang" ? 500 : 5000 }), error => error.turnStatus === "notStarted" && pattern.test(error.message));
    assert.equal(fake.requests().some(value => value.method === "authenticate"), false);
    assert.equal(fake.state().launches.every(value => stopped(value.pid)), true);
  });
}

test("Antigravity subprocess exit returns a failed run with no fake completion evidence", async t => {
  const fake = fixture(t, "exit");
  const result = await fake.run();
  assert.equal(result.status, 1);
  assert.equal(result.turnEnded, false);
  assert.match(result.error.message, /exit 7|closed stdout/);
  assert.equal(result.acpProcessExited, true);
});

test("Antigravity tool names alone do not become invented commands or successful exit codes", async t => {
  const fake = fixture(t, "metadata-only"), progress = [];
  const result = await fake.run({ onProgress: value => progress.push(value) });
  assert.equal(result.commandExecutions[0].command, null);
  assert.equal(result.commandExecutions[0].exitCode, null);
  assert.equal(result.commandExecutions[0].title, null);
  const tools = progress.flatMap(value => value.activity ?? []).filter(value => value.type === "dynamicToolCall");
  assert.equal(tools.length, 2);
  assert.deepEqual(tools.map(value => value.callId), ["test-command", "test-command"]);
  assert.equal(tools[0].tool, "run_command");
  assert.equal(progress.some(value => value.activity?.some(event => event.type === "commandExecution")), false);
});

test("Antigravity stdout EOF fails an outstanding prompt even while the process stays alive", async t => {
  const fake = fixture(t, "stdout-eof");
  const result = await fake.run();
  assert.equal(result.status, 1);
  assert.equal(result.turnEnded, false);
  assert.match(result.error.message, /closed stdout/);
  assert.equal(result.acpProcessExited, true);
});

test("Antigravity proposed diffs from a failed edit never become confirmed touched files", async t => {
  const fake = fixture(t, "failed-edit"), progress = [];
  const result = await fake.run({ onProgress: value => progress.push(value) });
  assert.deepEqual(result.touchedFiles, []);
  assert.deepEqual(result.fileChanges, []);
  assert.equal(progress.flatMap(value => value.activity ?? []).find(value => value.type === "fileChange").status, "failed");
});

test("Antigravity protects a fresh active session against a concurrent continuation", async t => {
  const fake = fixture(t, "hold"), controller = new AbortController();
  let resolveHandle;
  const handle = new Promise(resolve => { resolveHandle = resolve; });
  const first = fake.run({ signal: controller.signal, onProgress: value => { if (value.turnId) resolveHandle(value.threadId); } });
  t.after(() => controller.abort());
  const threadId = await handle;
  try {
    await assert.rejects(fake.run({ resumeThreadId: threadId }), /already has a Fugato run in progress/);
    assert.equal(fake.requests().filter(value => value.method === "session/load").length, 0);
  } finally { controller.abort(); }
  assert.equal((await first).interruptionConfirmed, true);
});

test("Antigravity availability errors explain the executable and login prerequisites", t => {
  const fake = fixture(t);
  process.env.FUGATO_ANTIGRAVITY_BIN = path.join(fake.directory, "missing-agy");
  assert.equal(resolveAntigravityExecutable(fake.directory), null);
  assert.throws(() => ensureAntigravityAvailable(fake.directory), /FUGATO_ANTIGRAVITY_BIN/);
});

test("Antigravity resolves explicit extensionless Windows paths in PATHEXT order", t => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform"), env = process.env;
  t.after(() => { Object.defineProperty(process, "platform", platform); process.env = env; });
  Object.defineProperty(process, "platform", { value: "win32" });
  process.env = { ...env, PATHEXT: ".BAT;.CMD;.EXE" };
  const cwd = "C:\\workspace", base = path.win32.join(cwd, "tools", "agy");
  t.mock.method(fs, "accessSync", file => {
    if (file !== base + ".CMD" && file !== base + ".EXE") throw new Error("File not found");
  });
  t.mock.method(fs, "statSync", () => ({ isFile: () => true }));
  for (const command of [".\\tools\\agy", base]) {
    process.env.FUGATO_ANTIGRAVITY_BIN = command;
    assert.equal(resolveAntigravityExecutable(cwd), base + ".CMD");
  }
});

test("Antigravity launches the executable checked in the requested subdirectory", async t => {
  const root = fixture(t);
  const requestCwd = path.join(root.directory, "package");
  const selected = installFakeAntigravity(requestCwd);
  process.env.FUGATO_ANTIGRAVITY_BIN = `./${path.basename(selected.binary)}`;
  const checked = ensureAntigravityAvailable(requestCwd);
  assert.equal(checked, selected.binary);
  assert.equal(resolveAntigravityExecutable(root.directory), root.binary);

  const runAndList = async options => {
    assert.equal((await root.run({ executionCwd: requestCwd, ...options })).status, 0);
    assert.equal((await listAntigravityModels(root.directory, options)).provider, "antigravity");
  };
  await runAndList({ requestCwd });
  process.env.FUGATO_ANTIGRAVITY_BIN = root.binary;
  await runAndList({ executable: checked });
  // argv[1] identifies the script launched by the shebang or Windows .cmd shim.
  assert.deepEqual(selected.state().launches.map(launch => launch.script), Array(4).fill(selected.script));
  assert.deepEqual(root.state().launches, []);
});
