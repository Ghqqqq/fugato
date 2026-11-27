import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { buildWorkerReport, classifyWorkerOutcome, classifyBrowserBlocker, parseStructuredReport } from "../plugins/codex/scripts/lib/worker-report.mjs";
import { readyBroker } from "./helpers.mjs";
import { workerReportHarness } from "./fake-codex-fixture.mjs";
import { splitRawArgumentString } from "../plugins/codex/scripts/lib/args.mjs";
import { directReport } from "../plugins/codex/scripts/lib/job-runtime.mjs";
import { isC2Report } from "../plugins/codex/scripts/lib/report-delivery.mjs";

const {
  lifecycle, stateModule, fixture, storedFixtureJob, switchingFixture, directJson, checkDecisionReport
} = await workerReportHarness();

test("stale browser claims have a distinct blocker with the owning session ID", () => {
  const text = "Tab 123 is already part of browser session 00000000-0000-0000-0000-000000000001";
  const report = buildWorkerReport({ status: 0, rawOutput: text });
  assert.equal(report.status, "blocked");
  assert.deepEqual(report.browserBlocker, { kind: "stale_browser_tab_claim", tabId: "123", sessionId: "00000000-0000-0000-0000-000000000001" });
  assert.equal(report.blockers[0].code, "stale_browser_tab_claim");
  assert.equal(report.blockers[0].sessionId, "00000000-0000-0000-0000-000000000001");
  assert.equal(report.blockers[0].tabId, "123");
  assert.equal(buildWorkerReport({ status: 1, error: text }).browserBlocker.kind, "stale_browser_tab_claim");
  assert.equal(classifyBrowserBlocker("a tab is already part of another session"), null);
  assert.equal(classifyBrowserBlocker("Tab 123 is already part of browser session malformed"), null);
});

test("compact worker report is bounded, separates claims and preserves full output", () => {
  const f = fixture("verbose-task");
  const response = f.call("task", "--fresh", "--report", "--json", "investigate");
  assert.equal(response.status, 0, response.stderr);
  const report = JSON.parse(response.stdout);
  assert.equal(report.status, "completed");
  assert.ok(response.stdout.split("\n").length <= 60);
  assert.equal(fs.readFileSync(report.rawOutputFile, "utf8").split("\n").length, 300);
  assert.ok(JSON.parse(fs.readFileSync(report.resultFile)).rawOutput.includes("Finding 299"));
  const restored = f.call("result", report.jobId, "--report", "--json");
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(JSON.parse(restored.stdout).summary, fs.readFileSync(report.rawOutputFile, "utf8").trim().slice(0, 8000));
  const legacy = JSON.parse(f.call("result", report.jobId, "--json").stdout);
  assert.deepEqual(legacy.storedJob.report, report);
  assert.ok(legacy.storedJob.result.rawOutput.includes("Finding 299"));
  assert.equal(f.state().nextTurnId, 2);
});

test("a --report worker runs with the worker-report schema and the parent reads the declared report", () => {
  const f = fixture("review-ok");
  const response = f.call("task", "--report", "--json", "implement safely");
  assert.equal(response.status, 0, response.stderr);
  const report = JSON.parse(response.stdout);
  const schema = f.state().lastTurnStart.outputSchema;
  assert.deepEqual(Object.keys(schema.properties).sort(), ["assumptions", "blockers", "key_findings", "question", "status", "summary", "verification"]);
  assert.equal(schema.additionalProperties, false, "strict structured output requires a closed object");
  assert.deepEqual(schema.required.sort(), Object.keys(schema.properties).sort(), "strict structured output requires every property");
  assert.equal(report.status, "completed");
  assert.equal(report.reportFormat, "structured");
  assert.deepEqual(report.keyFindings, ["Fixture finding one", "Fixture finding two"]);
  assert.deepEqual(report.assumptions, ["Fixture assumption"]);
  assert.deepEqual(report.claimedVerification, ["fixture check: passed"]);
  // The summary is the prose the parent reads; the raw output file holds it, not the JSON envelope.
  assert.equal(fs.readFileSync(report.rawOutputFile, "utf8"), "Handled the requested task.\nTask prompt accepted.");
  const stored = JSON.parse(fs.readFileSync(report.resultFile, "utf8"));
  assert.equal(stored.rawOutput, "Handled the requested task.\nTask prompt accepted.");
  assert.equal(stored.structured.status, "completed");
  checkDecisionReport(f, f.call("wait", report.jobId, "--direct"), "completed", 0);
  // A task without --report (stop-gate hook, plain rescue) keeps prose output and no schema.
  const plain = f.call("task", "--json", "implement safely");
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(f.state().lastTurnStart.outputSchema, null);
  assert.equal(JSON.parse(plain.stdout).rawOutput, "Handled the requested task.\nTask prompt accepted.");
});

test("declared blockers override completed while failures and essential questions retain their outcomes", () => {
  for (const declaredStatus of ["blocked", "completed"]) {
    const f = fixture("structured-blocked", declaredStatus === "completed" ? { mutable: true } : undefined);
    if (declaredStatus === "completed") {
      const binary = path.join(f.dir, "codex");
      fs.writeFileSync(binary, fs.readFileSync(binary, "utf8").replace('status: "blocked", summary:', 'status: "completed", summary:'));
    }
    const response = f.call("task", "--direct", "install the dependency");
    assert.equal(response.status, 2, response.stderr);
    const report = directJson(response), details = directJson(f.call("result", report.jobId, "--details"));
    assert.equal(report.status, "blocked"); assert.equal(details.declaredStatus, declaredStatus);
    if (declaredStatus === "blocked") checkDecisionReport(f, response, "blocked", 2);
    assert.deepEqual(report.blockers, [{ code: "missing_dependency", message: "fixture-dep is not installed" }]);
    assert.equal(JSON.parse(f.call("status", report.jobId, "--json").stdout).job.status, "blocked");
    const payload = directJson(f.call("result", report.jobId, "--json")).storedJob.result;
    assert.equal(buildWorkerReport({ ...payload, status: 1 }).status, "failed");
    const essential = buildWorkerReport({ ...payload, structured: { ...payload.structured, status: declaredStatus, blockers: [], question: "Which branch?" } });
    assert.equal(essential.status, "needs_input"); assert.equal(essential.declaredStatus, declaredStatus);
    assert.equal(essential.question, "Which branch?");
    if (declaredStatus === "completed") {
      const saved = storedFixtureJob(f, report.jobId);
      const { declaredStatus: oldDeclaration, ...oldReport } = saved.report;
      storedFixtureJob(f, report.jobId, { status: "completed", report: { ...oldReport, status: "completed" } });
      for (const command of [["result", report.jobId], ["wait", report.jobId, "--direct"], ["result", report.jobId, "--details"]]) {
        const observed = f.call(...command);
        assert.equal(observed.status, 2); assert.equal(directJson(observed).status, "blocked", "older stored reports cannot claim completed with blockers");
      }
      assert.equal(directJson(f.call("result", report.jobId, "--details")).declaredStatus, "completed");
      const question = "Which branch should receive the legacy fix?";
      storedFixtureJob(f, report.jobId, { report: { ...oldReport, status: "completed", blockers: [] },
        result: { ...saved.result, structured: { ...saved.result.structured, blockers: [], question } } });
      for (const command of [["result", report.jobId], ["wait", report.jobId, "--direct"], ["result", report.jobId, "--details"]]) {
        const observed = f.call(...command), recovered = directJson(observed);
        assert.equal(observed.status, 2); assert.equal(recovered.status, "needs_input");
        assert.equal(typeof recovered.question === "string" ? recovered.question : recovered.question.text, question);
      }
    }
  }
});

test("parseStructuredReport accepts the schema object or a trailing json block and rejects prose", () => {
  const object = { status: "needs_input", summary: "Need the target branch.", key_findings: [], assumptions: ["x"], verification: [], blockers: [], question: "Which branch should receive the fix?" };
  const parsed = parseStructuredReport(JSON.stringify(object));
  assert.equal(parsed.status, "needs_input");
  assert.equal(parsed.question, "Which branch should receive the fix?");
  const fenced = parseStructuredReport(`Done.\n\n\`\`\`json\n${JSON.stringify({ ...object, status: "completed", question: null })}\n\`\`\``);
  assert.equal(fenced.status, "completed");
  assert.equal(fenced.question, null);
  assert.equal(parseStructuredReport("Implemented the fix. Tests passed."), null);
  assert.equal(parseStructuredReport(JSON.stringify({ status: "done", summary: "x" })), null, "unknown status is not a report");
  assert.equal(parseStructuredReport(JSON.stringify({ verdict: "approve", summary: "x" })), null);
  // Domain statuses and descriptions of blocked requests are report content,
  // not worker outcomes. Keep the schema-less interpretation unchanged.
  for (const [summary, proseStatus] of [
    ["Fixed the filter: orders with status: pending are now hidden. Tests pass.", "needs_input"],
    ['Done. The API now returns status="running" while the export is in progress.', "needs_input"],
    ["Blocked unauthorized requests and verified the regression tests passed.", "blocked"],
    ["Fixed the Debugger unattached warning; work remains in an unrelated backlog.", "blocked"]
  ]) {
    const f = fixture("review-ok", { mutable: true }), binary = path.join(f.dir, "codex");
    fs.writeFileSync(binary, fs.readFileSync(binary, "utf8").replace("summary: text,", `summary: ${JSON.stringify(summary)},`));
    const response = f.call("task", "--direct", "--quiet", "fixture");
    assert.equal(response.status, 0, response.stderr || response.stdout);
    const report = directJson(response);
    assert.equal(report.status, "completed");
    assert.equal(report.blockers?.length ?? 0, 0);
    assert.equal(directJson(f.call("result", report.jobId, "--details")).status, "completed");
    assert.equal(classifyWorkerOutcome(summary), proseStatus);
  }
  const completed = { ...parsed, status: "completed", summary: "Fixed the message that incorrectly said work remains.", question: null };
  assert.equal(buildWorkerReport({ status: 0, rawOutput: completed.summary, structured: completed }).status, "completed");
  assert.equal(classifyWorkerOutcome(completed.summary), "needs_input");
  // Declared completed with a plan-only summary is still needs_input; declared needs_input carries its question.
  const plan = "I'll start by inspecting the repository and then implement the change.";
  const over = buildWorkerReport({ status: 0, rawOutput: plan, structured: { ...parsed, status: "completed", summary: plan, question: null } });
  assert.equal(over.status, "needs_input");
  const asks = buildWorkerReport({ status: 0, rawOutput: object.summary, structured: parsed });
  assert.equal(asks.status, "needs_input");
  assert.equal(asks.question, "Which branch should receive the fix?");
  assert.equal(asks.blockers[0].code, "needs_input");
  // A captured runtime refusal outranks a declared completed.
  const captured = buildWorkerReport({ status: 0, rawOutput: "Done.", structured: { ...parsed, status: "completed", summary: "Done.", question: null }, blockers: [{ code: "computer_use_app_not_approved", app: "com.google.Chrome" }] });
  assert.equal(captured.status, "blocked");
  const runtimeError = buildWorkerReport({ status: 0, rawOutput: "Done.", structured: completed, error: "Debugger unattached" });
  assert.equal(runtimeError.status, "blocked");
  assert.equal(runtimeError.blockers[0].code, "browser_tab_debugger_unattached");
  // Declared blocked without entries names the summary.
  const bare = buildWorkerReport({ status: 0, rawOutput: "Blocked by the firewall.", structured: { ...parsed, status: "blocked", summary: "Blocked by the firewall.", question: null } });
  assert.deepEqual(bare.blockers, [{ code: "reported_blocked", message: "Blocked by the firewall." }]);
});

for (const behavior of ["question-only"]) test(`${behavior} is needs_input, not success`, () => {
  const f = fixture(behavior);
  const response = f.call("task", "--report", "--json", "implement safely");
  assert.equal(response.status, 2, response.stderr);
  const report = JSON.parse(response.stdout);
  assert.equal(report.status, "needs_input");
  assert.ok(report.question);
  assert.equal(JSON.parse(f.call("status", report.jobId, "--json").stdout).job.status, "needs_input");
  assert.equal(f.call("result", report.jobId, "--report", "--json").status, 2);
  assert.equal(f.state().nextTurnId, 2);
  checkDecisionReport(f, f.call("wait", report.jobId, "--direct"), "needs_input", 2);
});

test("question detection keeps delivered findings with an optional follow-up complete", () => {
  assert.equal(classifyWorkerOutcome("Implemented the fix. Tests passed. Would you like details?"), "completed");
  assert.equal(classifyWorkerOutcome("Status: needs_input\nWhich target?"), "needs_input");
  assert.equal(classifyWorkerOutcome("请确认要使用哪个数据库？"), "needs_input");
  assert.equal(classifyWorkerOutcome("Which files should be changed?"), "needs_input");
  assert.equal(classifyWorkerOutcome("Please confirm whether tests passed."), "needs_input");
  assert.equal(classifyWorkerOutcome("I will implement the changes once tests have passed."), "needs_input");
  assert.equal(classifyWorkerOutcome("", 1), "failed");
  const report = buildWorkerReport({ status: 0, rawOutput: "Fixed issue", touchedFiles: Array(40).fill("a.js"), commandExecutions: [{ command: "node --test", exitCode: 1, status: "failed" }] });
  assert.equal(report.touchedFiles.length + report.touchedFilesOmitted, 40);

});
test("runtime refusals and declared blocks retain typed blockers and their status precedence", () => {
  const rawOutput = [
    "**Blocked before native capture.** No new screenshots were taken.",
    "- `cua.getApp(\"Google Chrome\")` failed: `Computer Use was not approved to use Google Chrome`.",
    "| Tab | Session | Result |", "| --- | --- | --- |",
    "| `128187414` | `codex-readme-shots` | Could not close: `Debugger unattached`. May require manual closure. |",
    "The first tab failed inspection, rebinding, and close operations with `Debugger unattached`.",
    "Assumptions", "None beyond the above."
  ].join("\n");
  const report = buildWorkerReport({ status: 0, rawOutput, approvedComputerApps: ["com.google.Chrome"], touchedFiles: Array(40).fill("changed.js"), preExistingChanges: Array(30).fill("dirty.js"), commandExecutions: Array(10).fill({ command: "node --test", exitCode: 0, status: "completed" }), approvedBrowserOrigins: Array.from({ length: 10 }, (_, i) => `https://fixture${i}.example`) });
  assert.equal(report.status, "blocked");
  assert.deepEqual(report.approvedComputerApps, ["com.google.Chrome"]);
  assert.deepEqual(report.blockers.map(b => b.code), ["computer_use_app_not_approved", "browser_tab_debugger_unattached"]);
  assert.equal(report.blockers[0].app, "Google Chrome");
  assert.deepEqual([report.blockers[1].tabId, report.blockers[1].sessionId, report.blockers[1].closed], ["128187414", "codex-readme-shots", false]);
  assert.equal(report.blockersOmitted, 1, "the declared block is counted when the budget drops it");
  assert.ok(`${JSON.stringify(report, null, 2)}\n`.split("\n").length <= 60);
  const declared = buildWorkerReport({ status: 0, rawOutput: "Blocked: the review cannot proceed without the design file.\nDetails follow." });
  assert.equal(declared.status, "blocked");
  assert.deepEqual(declared.blockers, [{ code: "reported_blocked", message: "Blocked: the review cannot proceed without the design file." }]);
  assert.equal(buildWorkerReport({ status: 0, rawOutput: "Status: blocked\nWaiting on credentials." }).status, "blocked");
  // Captured runtime blockers make a turn blocked even when the final answer claims success.
  const captured = buildWorkerReport({ status: 0, rawOutput: "Done, screenshots attached.", blockers: [{ code: "computer_use_app_not_approved", app: "com.google.Chrome", message: "Computer Use elicitation for com.google.Chrome cancelled (no-flag)" }] });
  assert.equal(captured.status, "blocked");
  assert.equal(captured.blockers[0].app, "com.google.Chrome");
  assert.equal(classifyWorkerOutcome("Computer Use is blocked from using the app 'com.evil.App' by your organization's policy."), "blocked");
  assert.equal(classifyWorkerOutcome("Implemented the unblocking fix; tests passed."), "completed");
  assert.equal(buildWorkerReport({ status: 1, error: "Computer Use was not approved to use Google Chrome" }).status, "failed");

  const cyberMessage = "This content was flagged for possible cybersecurity risk. Fixture evidence.";
  const genericMessage = "Synthetic runtime failure evidence.";
  const classified = [
    ["cyberPolicy", "provider_refused"], ["usageLimitExceeded", "usage_limit"],
    ["sessionBudgetExceeded", "usage_limit"], ["contextWindowExceeded", "context_window_exceeded"], ["unauthorized", "auth_required"]
  ];
  const cases = [
    ...classified.map(([codexErrorInfo, code]) => ({ error: { message: genericMessage, codexErrorInfo }, code })),
    ...classified.map(([codexErrorInfo, code]) => ({ notification: { message: genericMessage, codexErrorInfo }, code })),
    { error: { message: cyberMessage }, code: "provider_refused" },
    { error: { message: cyberMessage, codexErrorInfo: null }, code: "provider_refused" },
    { error: { message: genericMessage }, notification: { message: "Earlier error evidence.", codexErrorInfo: "cyberPolicy" }, code: "provider_refused" },
    ...["other", "serverOverloaded", undefined, { httpConnectionFailed: { httpStatusCode: 503 } }].map(codexErrorInfo => ({ error: { message: genericMessage, codexErrorInfo }, code: "error" })),
    ...["other", "serverOverloaded"].map(codexErrorInfo => ({ error: { message: cyberMessage, codexErrorInfo }, code: "error" })),
    { error: { message: cyberMessage, codexErrorInfo: "other" }, notification: { message: genericMessage, codexErrorInfo: "cyberPolicy" }, code: "error" },
    { notification: { message: genericMessage, codexErrorInfo: "cyberPolicy" }, status: "completed", code: null }
  ];
  const f = switchingFixture();
  for (const [index, spec] of cases.entries()) {
    f.select(`turn-error:${JSON.stringify(spec)}`);
    // The direct owner path is covered for each exit class. Other inputs use
    // the foreground wrapper and the same stored compact/details projections.
    const direct = index === 0 || spec.code === null || spec === cases.find(item => item.code === "error");
    const response = f.call("task", "--fresh", ...(direct ? ["--direct"] : ["--report", "--json"]), "--sandbox", "read-only", "Check fixture outcome.");
    const compactResponse = f.call("result", directJson(response).jobId);
    const compact = directJson(compactResponse);
    const exit = spec.code === null ? 0 : spec.code === "error" ? 1 : 2;
    const status = spec.code === null ? "completed" : spec.code === "error" ? "failed" : "blocked";
    assert.equal(response.status, exit, JSON.stringify(spec));
    assert.equal(compactResponse.status, exit, JSON.stringify(spec));
    assert.equal(compact.status, status);
    assert.equal(compact.blockers?.[0]?.code ?? null, spec.code);
    const next = spec.code === null ? null : spec.code === "auth_required" ? ["fugato", "setup"]
      : ["context_window_exceeded", "provider_refused"].includes(spec.code) ? ["fugato", "task", "--fresh"]
      : ["fugato", "task", "--to", compact.worker];
    assert.deepEqual(compact.next === null ? null : splitRawArgumentString(compact.next), next);
    if (status === "blocked") {
      const recoveryCommand = "fugato status predecessor --json";
      const busy = { code: "thread_busy", recoveryCommand };
      const blocked = { ...compact, blockers: [...compact.blockers, busy] };
      assert.equal(directReport(blocked).next, recoveryCommand);
      assert.equal(directReport({ ...blocked, blockers: [{ ...busy, answerCommand: "fugato answer predecessor --question q" }, ...compact.blockers] }).next,
        "fugato answer predecessor --question q");
    }
    const { summary, ...envelope } = compact;
    assert.ok(Buffer.byteLength(JSON.stringify(envelope)) <= 2000);
    const detailsResponse = f.call("result", compact.jobId, "--details");
    const details = directJson(detailsResponse);
    assert.equal(detailsResponse.status, exit);
    assert.equal(details.status, status);
    assert.equal(details.exitCode, exit);
    const captured = JSON.parse(fs.readFileSync(details.resultFile, "utf8"));
    assert.equal(captured.status, spec.status === "completed" ? 0 : 1, "the runtime status stays separate from the report exit code");
    const info = spec.error?.codexErrorInfo ?? spec.notification?.codexErrorInfo;
    assert.equal(captured.codexErrorInfo ?? null, info && typeof info === "object" ? Object.keys(info)[0] : info ?? null);
    if (spec.code) assert.equal(captured.error, (spec.error ?? spec.notification).message);
    if (exit === 2) {
      assert.equal(details.error, captured.error);
      assert.ok(compact.blockers[0].message);
    }
    assert.equal(f.state().nextTurnId, index + 2, "classification must not replay the turn");
  }
  assert.equal(buildWorkerReport({ status: 1, rawOutput: cyberMessage, error: genericMessage }).status, "failed");
  assert.equal(buildWorkerReport({ status: 1, error: "A cybersecurity policy refusal." }).status, "failed");
});

test("compact report budgets origin grants and a stale claim without losing the session ID", () => {
  const report = buildWorkerReport({
    status: 0, rawOutput: "Tab 123 is already part of browser session 00000000-0000-0000-0000-000000000001\nAssumptions\nPending decision\nMore findings\nOther findings",
    touchedFiles: Array(40).fill("changed.js"), preExistingChanges: Array(30).fill("dirty.js"),
    commandExecutions: Array(10).fill({ command: "node --test", exitCode: 0, status: "completed" }),
    approvedBrowserOrigins: Array.from({ length: 10 }, (_, i) => `https://fixture${i}.example`)
  });
  assert.equal(report.approvedBrowserOriginsOmitted, 7);
  assert.equal(report.preExistingChangesOmitted, 27);
  assert.equal(report.touchedFiles.length + report.touchedFilesOmitted, 40);
  assert.equal(report.browserBlocker.sessionId, "00000000-0000-0000-0000-000000000001");
  assert.ok(`${JSON.stringify(report, null, 2)}\n`.split("\n").length <= 60);
});
