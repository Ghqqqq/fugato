import "./test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { AcpClient } from "../plugins/codex/scripts/lib/acp-client.mjs";

function peer(t, script, options = {}) {
  const cwd = fs.mkdtempSync(path.join(process.env.CODEX_COMPANION_TEST_ROOT, "acp-"));
  // AcpClient invokes the executable with the single argument "acp".
  fs.writeFileSync(path.join(cwd, "acp"), `
    const fs = require("node:fs");
    const input = require("node:readline").createInterface({ input: process.stdin });
    const receive = handler => input.on("line", line => handler(JSON.parse(line)));
    const send = (message, done) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n", done);
    ${script}
  `);
  const client = new AcpClient(process.execPath, cwd, { timeoutMs: 3000, ...options });
  t.after(async () => {
    await client.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  return { client, cwd };
}

test("leader exit drains a buffered response and settles pending requests with inherited stdout", async t => {
  const { client } = peer(t, `
    receive(({ id, method }) => {
      if (method !== "last") return;
      require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 2000)"],
        { stdio: ["ignore", "inherit", "ignore"] }).unref();
      send({ id, result: "final frame" }, () => process.exit(7));
    });
  `);
  let exitTime;
  client.child.stdout.pause();
  client.child.once("exit", () => {
    exitTime = performance.now();
    client.child.stdout.resume();
  });
  const pending = assert.rejects(client.request("unanswered", {}), { code: "ACP_TRANSPORT_CLOSED" });
  assert.equal(await client.request("last", {}), "final frame");
  await pending;
  assert.ok(performance.now() - exitTime < 1000, "a descendant holding stdout must not delay failure until EOF");
  assert.deepEqual(await client.close(), { exited: true, error: null });
});

test("close allows a child to save on EOF and escalates when a child stays alive", async t => {
  const cooperative = peer(t, `
    process.on("SIGTERM", () => process.exit(31));
    input.on("close", () => setTimeout(() => fs.writeFileSync("saved", "on EOF"), 150));
    receive(({ id }) => send({ id, result: "ready" }));
  `);
  await cooperative.client.request("ready", {});
  assert.deepEqual(await cooperative.client.close(), { exited: true, error: null });
  assert.equal(fs.readFileSync(path.join(cooperative.cwd, "saved"), "utf8"), "on EOF");
  assert.equal(cooperative.client.child.exitCode, 0);

  const stubborn = peer(t, `
    input.on("close", () => fs.writeFileSync("eof", ""));
    process.on("SIGTERM", () => fs.writeFileSync("term", ""));
    setInterval(() => {}, 60000);
    receive(({ id }) => send({ id, result: "ready" }));
  `, { exitGraceMs: 100 });
  await stubborn.client.request("ready", {});
  const start = performance.now();
  assert.deepEqual(await stubborn.client.close(), { exited: true, error: null });
  assert.ok(performance.now() - start < 2000, "the configured grace period bounds shutdown");
  assert.ok(fs.existsSync(path.join(stubborn.cwd, "eof")));
  if (process.platform !== "win32") {
    assert.ok(fs.existsSync(path.join(stubborn.cwd, "term")));
    assert.equal(stubborn.client.child.signalCode, "SIGKILL");
  }
});

test("close reports an unconfirmed exit without replacing a completed result", async t => {
  const { client } = peer(t, 'receive(({ id }) => send({ id, result: "complete" }));', { exitGraceMs: 10 });
  const result = await client.request("turn", {});
  // Withhold exit notifications from this one ChildProcess until cleanup has
  // returned. The fixture still exits normally and the test ledger is updated.
  const child = client.child, emit = child.emit, withheld = [];
  child.emit = function (event, ...args) {
    if (event === "exit" || event === "close") { withheld.push([event, ...args]); return false; }
    return emit.call(this, event, ...args);
  };
  try {
    const closing = client.close();
    assert.equal(client.close(), closing);
    const { exited, error } = await closing;
    assert.equal(exited, false);
    assert.ok(error instanceof Error);
    assert.equal(error.code, "ACP_CLEANUP_FAILED");
    assert.equal(result, "complete");
  } finally {
    child.emit = emit;
    for (const args of withheld) child.emit(...args);
  }
});

test("a response with a null id leaves later requests usable", async t => {
  const { client } = peer(t, `
    receive(({ id, method }) => {
      if (method === "first") send({ id: null, error: { code: -32700, message: "Parse error" } });
      send({ id, result: method });
    });
  `);
  assert.equal(await client.request("first", {}), "first");
  assert.equal(await client.request("next", {}), "next");
});

test("$/cancel_request aborts only the server request with the matching id", async t => {
  const signals = new Map();
  const { client } = peer(t, `
    receive(({ id }) => {
      for (const requestId of [1, "1"]) send({ id: requestId, method: "session/request_permission" });
      send({ method: "$/cancel_request", params: { requestId: "unknown" } });
      send({ method: "$/cancel_request", params: { requestId: "1" } });
      send({ id, result: "sent" });
    });
  `, { onRequest: ({ id }, signal) => {
    signals.set(id, signal);
    return new Promise(() => {});
  } });
  await client.request("start", {});
  assert.equal(signals.get("1").aborted, true);
  assert.equal(signals.get(1).aborted, false);
});

test("a multi-MiB frame in small chunks scans each character for newline once", async t => {
  const size = 4 * 1024 * 1024;
  const { client } = peer(t, `
    receive(async ({ id }) => {
      const frame = JSON.stringify({ jsonrpc: "2.0", id, result: "x".repeat(${size}) }) + "\\n";
      for (let i = 0; i < frame.length; i += 1024) {
        if (!process.stdout.write(frame.slice(i, i + 1024))) await require("node:events").once(process.stdout, "drain");
      }
    });
  `);
  const read = client.read.bind(client), indexOf = String.prototype.indexOf;
  let scans = 0, scanned = 0;
  function countScan(needle, start = 0) {
    const end = indexOf.call(this, needle, start);
    if (needle === "\n") {
      scans++;
      scanned += (end < 0 ? this.length : end + 1) - start;
    }
    return end;
  }
  client.read = chunk => {
    String.prototype.indexOf = countScan;
    try { read(chunk); }
    finally { String.prototype.indexOf = indexOf; }
  };
  const response = await client.request("large", {});
  assert.equal(response.length, size);
  assert.ok(scans > 1, "the frame spanned multiple reads");
  assert.equal(scanned, JSON.stringify({ jsonrpc: "2.0", id: 1, result: response }).length + 1);
});
