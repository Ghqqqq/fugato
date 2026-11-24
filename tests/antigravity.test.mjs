import "./test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { installFakeAntigravity } from "./fake-antigravity-fixture.mjs";
import { ensureAntigravityAvailable, listAntigravityModels, runAntigravityTurn } from "../plugins/codex/scripts/lib/antigravity.mjs";

function fixture(t, behavior = "normal") {
  const directory = fs.mkdtempSync(path.join(process.env.CODEX_COMPANION_TEST_ROOT, "agy-"));
  const installed = installFakeAntigravity(directory, { behavior });
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

test("Antigravity parses fragmented UTF-8 ACP frames and captures only the final response", async t => {
  const fake = fixture(t, "fragmented"), progress = [];
  const result = await fake.run({ onProgress: value => progress.push(value), developerInstructions: "Follow the task instructions.", outputSchema: { type: "object" } });
  assert.equal(result.status, 0);
  assert.equal(result.turnEnded, true);
  assert.equal(result.turn.status, "completed");
  assert.equal(JSON.parse(result.finalMessage).summary, "Antigravity fixture answer.");
  assert.deepEqual(result.reasoningSummary, ["Fixture reasoning 中🙂."]);
  assert.deepEqual(result.touchedFiles, ["/fixture/result.txt"]);
  assert.equal(result.commandExecutions[0].command, "node --test");
  assert.equal(result.commandExecutions[0].exitCode, 0);
  assert.deepEqual(result.acpUsage, { used: 123, size: 1000000, cost: { amount: 0.03, currency: "USD" } });
  assert.equal(result.usage, undefined, "context occupancy must not be invented per-turn token usage");
  assert.equal(progress.some(value => value.threadId === result.threadId && value.turnId === result.turnId), true);
  const activity = progress.flatMap(value => value.activity ?? []);
  assert.equal(activity.find(value => value.type === "commandExecution" && value.lifecycle === "started").command, "node --test");
  assert.equal(activity.find(value => value.type === "commandExecution" && value.lifecycle === "completed").exitCode, 0);
  assert.equal(activity.find(value => value.type === "fileChange").path, "/fixture/result.txt");
  assert.equal(progress.find(value => value.item?.callId === "test-command").item.title, "Run fixture tests");
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
  assert.deepEqual(result.data.map(value => value.id), ["fixture-gemini", "fixture-gemini-fast"]);
  assert.equal(result.data[0].isDefault, true);
  assert.deepEqual(result.data[0].supportedReasoningEfforts.map(value => value.reasoningEffort), ["low", "high"]);
  assert.deepEqual(result.data[1].supportedReasoningEfforts, []);
  assert.equal(fake.requests().some(value => value.method === "session/prompt"), false);
});

test("Antigravity applies dynamic config IDs and refreshes thinking options after changing model", async t => {
  const fake = fixture(t);
  const result = await fake.run({ model: "fixture-gemini-fast", effort: "Medium" });
  assert.equal(result.model, "fixture-gemini-fast");
  assert.equal(result.effort, "medium");
  const settings = fake.requests().filter(value => value.method === "session/set_config_option").map(value => value.params);
  assert.deepEqual(settings, [
    { sessionId: result.threadId, configId: "selected-model", value: "fixture-gemini-fast" },
    { sessionId: result.threadId, configId: "reasoning-choice", value: "medium" }
  ]);
});

for (const [behavior, model, effort] of [
  ["config-after-new", "fixture-gemini-fast", "medium"],
  ["config-before-new", "fixture-gemini", "low"],
  ["config-before-new-only", "fixture-gemini-fast", "medium"]
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
    const result = await fake.run({ model: "fixture-gemini-fast", effort });
    assert.deepEqual([result.model, result.effort], ["fixture-gemini-fast", effort]);
    assert.equal(result.status, 0);
    const settings = fake.requests().filter(value => value.method === "session/set_config_option");
    assert.equal(settings.length, behavior === "config-after-model" ? 1 : 2);
  });
}

for (const [behavior, model, effort] of [["config-after-load", "fixture-gemini-fast", "medium"], ["config-before-load", "fixture-gemini", "low"]]) {
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
  await assert.rejects(fake.run({ model: "invented-model" }), error => error.turnStatus === "notStarted" && /Available values: fixture-gemini/.test(error.message));
  await assert.rejects(fake.run({ model: "fixture-gemini-fast", effort: "high" }), /Available values: low, medium/);
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
  const fake = fixture(t, "permission"), requests = [];
  const result = await fake.run({ onApprovalRequest: request => { requests.push(request); return "once"; } });
  assert.equal(result.status, 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].kind, "acp-permission");
  assert.deepEqual(requests[0].binding, { threadId: result.threadId, turnId: result.turnId });
  assert.match(requests[0].question, /\/fixture\/result.txt/);
  assert.deepEqual(fake.state().serverResponses[0].result, { outcome: { outcome: "selected", optionId: "allow-this" } });
  assert.deepEqual(result.blockers, []);
});

test("Antigravity id-only permission updates retain the observed operation and arguments", async t => {
  const fake = fixture(t, "permission-partial");
  let request;
  const result = await fake.run({ onApprovalRequest: value => { request = value; return "once"; } });
  assert.equal(result.status, 0);
  assert.equal(request.toolCall.kind, "edit");
  assert.deepEqual(request.toolCall.rawInput, { path: "/fixture/result.txt", content: "updated" });
  assert.match(request.question, /edit/);
  assert.match(request.question, /\/fixture\/result.txt/);
  assert.match(request.question, /updated/);
  assert.deepEqual(fake.state().serverResponses[0].result, { outcome: { outcome: "selected", optionId: "allow-this" } });
});

for (const behavior of ["permission", "foreign-permission", "only-always", "permission-unscoped"]) {
  test(`Antigravity fails closed for ${behavior} without a valid one-time grant`, async t => {
    const fake = fixture(t, behavior);
    let asked = false;
    const result = await fake.run({ ...(behavior === "permission" ? {} : { onApprovalRequest: () => { asked = true; return "once"; } }) });
    assert.equal(asked, false);
    assert.deepEqual(fake.state().serverResponses[0].result, { outcome: { outcome: "selected", optionId: "deny-this" } });
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

test("Antigravity tool descriptions do not become invented commands or successful exit codes", async t => {
  const fake = fixture(t, "metadata-only"), progress = [];
  const result = await fake.run({ onProgress: value => progress.push(value) });
  assert.equal(result.commandExecutions[0].command, null);
  assert.equal(result.commandExecutions[0].exitCode, null);
  assert.equal(result.commandExecutions[0].title, "Run fixture tests");
  const tools = progress.flatMap(value => value.activity ?? []).filter(value => value.type === "dynamicToolCall");
  assert.equal(tools.length, 2);
  assert.deepEqual(tools.map(value => value.callId), ["test-command", "test-command"]);
  assert.equal(tools[0].tool, "Run fixture tests");
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
  assert.throws(() => ensureAntigravityAvailable(fake.directory), /FUGATO_ANTIGRAVITY_BIN/);
});
