import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { boundCommandOutput } from "../plugins/codex/scripts/lib/command-output.mjs";
import { installFakeAntigravity } from "./fake-antigravity-fixture.mjs";
import { lifecycleHarness } from "./fake-codex-fixture.mjs";

test("the private job and the result artifact retain both ends of a 5 MiB command", async () => {
  const { fixture, json, resolveStateDir } = await lifecycleHarness();
  const f = fixture();
  const stdout = "HEAD\n" + "🔬".repeat(5 * 1024 * 1024 / 4) + "\nTAIL";
  const fake = installFakeAntigravity(f.dir, { turnUpdates: [
    { sessionUpdate: "tool_call", toolCallId: "tests", name: "run_command", kind: "execute",
      rawInput: { CommandLine: "npm test" }, status: "completed", rawOutput: { stdout, exitCode: 0 } },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Completed the tests." } },
  ] });
  f.env.FUGATO_ANTIGRAVITY_BIN = fake.binary;
  const report = json(f.call("task", "--direct", "--quiet", "--backend", "antigravity", "Run the tests."));
  assert.equal(report.status, "completed");
  const file = path.join(resolveStateDir(f.repo, f.env), "jobs", `${report.jobId}.json`);
  const job = JSON.parse(fs.readFileSync(file));
  for (const record of [file, job.resultFile]) assert.ok(fs.statSync(record).size < 64 * 1024);
  const [entry] = job.result.commandExecutions;
  assert.deepEqual(JSON.parse(fs.readFileSync(job.resultFile)).commandExecutions, [entry]);
  const output = entry.aggregatedOutput;
  assert.ok(Buffer.byteLength(output) <= 16 * 1024);
  const match = /^(HEAD\n🔬+)\[… (\d+) bytes omitted …\](🔬+\nTAIL)$/u.exec(output);
  assert.ok(match, "preserves whole characters from both ends");
  assert.equal(Number(match[2]), Buffer.byteLength(stdout) - Buffer.byteLength(match[1] + match[3]));
});

test("a turn caps total command output including markers and keeps every command outcome", () => {
  const commands = Array.from({ length: 40 }, (_, index) => ({
    command: `check ${index}`, exitCode: index % 2, status: "completed", durationMs: index,
    aggregatedOutput: "x".repeat(30 * 1024),
  }));
  const stored = boundCommandOutput(commands);
  assert.equal(stored.length, commands.length);
  assert.ok(stored.reduce((sum, entry) => sum + Buffer.byteLength(entry.aggregatedOutput), 0) <= 256 * 1024);
  for (const [index, { aggregatedOutput, ...outcome }] of stored.entries()) {
    assert.ok(Buffer.byteLength(aggregatedOutput) <= 16 * 1024);
    const { aggregatedOutput: original, ...expected } = commands[index];
    assert.deepEqual(outcome, expected);
    assert.ok(original.length > aggregatedOutput.length);
  }
  assert.equal(stored.at(-1).aggregatedOutput, "[… 30720 bytes omitted …]");

  const crowded = boundCommandOutput(Array(12000).fill(commands[0]));
  assert.ok(crowded.reduce((sum, entry) => sum + Buffer.byteLength(entry.aggregatedOutput ?? ""), 0) <= 256 * 1024);
  assert.deepEqual(crowded.at(-1), { command: "check 0", exitCode: 0, status: "completed",
    durationMs: 0, aggregatedOutputOmittedBytes: 30720 });
});

test("command output within budget is unchanged byte for byte", () => {
  const commands = [{ command: "test", aggregatedOutput: "é\r\n🧪\u0000\t " },
    { aggregatedOutput: "x".repeat(16 * 1024) }, { aggregatedOutput: "" }, { aggregatedOutput: null },
    { aggregatedOutput: ["one", "two"] }, {}];
  assert.equal(JSON.stringify(boundCommandOutput(commands)), JSON.stringify(commands));
});
