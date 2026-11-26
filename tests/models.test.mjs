import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { linkStaticExecutable, makeTempDir, run } from "./helpers.mjs";
import { buildEnv } from "./fake-codex-fixture.mjs";
import { listModels, readModelCache } from "../plugins/codex/scripts/lib/models.mjs";
import { roleModelsSetup } from "../plugins/codex/scripts/lib/setup-config.mjs";

const plugin = new URL("../plugins/codex/", import.meta.url);
const launcher = new URL("bin/duet", plugin).pathname;
const fakeModelsCodex = fileURLToPath(new URL("./fixtures/fake-models-codex.cjs", import.meta.url));
const fetchedAt = "2026-10-31T00:00:00Z";
const models = [
  { slug: "fixture-routine", display_name: "Routine", description: "Fast workhorse", visibility: "list", priority: 2,
    supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }], default_reasoning_level: "low", context_window: 128000 },
  { slug: "fixture-strong", display_name: "Strong", description: "Most capable", visibility: "list", priority: 1,
    supported_reasoning_levels: [{ effort: "high" }, { effort: "xhigh" }], default_reasoning_level: "xhigh", context_window: 256000 },
  { slug: "fixture-hidden", display_name: "Hidden", description: "Preview", visibility: "hide", priority: 3,
    supported_reasoning_levels: [{ effort: "ultra" }], default_reasoning_level: "ultra", context_window: 512000 }
];

function fixture({ cache = true, runtime = null, runtimeModels = models } = {}) {
  const dir = makeTempDir("models-"), home = path.join(dir, "isolated");
  fs.mkdirSync(home);
  const env = { ...buildEnv(dir), CODEX_COMPANION_HOME: home, CLAUDE_PLUGIN_DATA: path.join(dir, "data"),
    CODEX_COMPANION_BIN: path.join(dir, runtime ? "codex" : "missing-codex"), CODEX_COMPANION_SESSION_ID: "models-test" };
  const cacheFile = path.join(home, "models_cache.json"), calls = path.join(dir, "calls.jsonl"), pidFile = path.join(dir, "pid");
  const writeCache = (entries = models) => fs.writeFileSync(cacheFile, JSON.stringify({ fetched_at: fetchedAt, identity: { token: "CACHE_SECRET" },
    client_version: "fixture", etag: "PRIVATE_ETAG", models: entries.map(model => ({ ...model, token: "MODEL_SECRET" })) }));
  if (cache) writeCache();
  if (runtime) {
    fs.writeFileSync(path.join(dir, "models-fixture-config.json"), JSON.stringify({
      behavior: runtime, models: runtimeModels, calls, pidFile
    }), "utf8");
    linkStaticExecutable(env.CODEX_COMPANION_BIN, fakeModelsCodex);
  }
  return { dir, home, env, cacheFile, writeCache, calls, pidFile,
    call: (...args) => run(process.execPath, [launcher, ...args], { env, cwd: dir }) };
}
function json(result) {
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.doesNotMatch(result.stdout + result.stderr, /CACHE_SECRET|MODEL_SECRET|RUNTIME_SECRET|PRIVATE_ETAG|identity|token/);
  return JSON.parse(result.stdout);
}
test("models CLI uses the sanitized cache, marks effective tiers and optionally includes hidden models", () => {
  const f = fixture();
  json(f.call("setup", "--default-model", "fixture-strong", "--default-effort", "high", "--ultra-routine-model", "fixture-routine", "--json"));
  const report = json(f.call("models", "--json"));
  assert.equal(report.source, "cache");
  assert.equal(report.fallbackReason, "unavailable");
  assert.deepEqual(report.models.map(model => model.slug), ["fixture-strong", "fixture-routine"]);
  assert.deepEqual(report.models.map(model => model.inUse), [["strong"], ["routine"]]);
  assert.deepEqual(report.models[0].efforts, ["high", "xhigh"]);
  assert.equal(report.models[0].contextWindow, 256000);
  assert.equal(report.tiers.strong.source, "saved");
  const human = f.call("models");
  assert.equal(human.status, 0, human.stderr);
  assert.doesNotMatch(human.stdout + human.stderr, /fixture-hidden|SECRET|identity|token/);
  assert.equal(json(f.call("models", "--all", "--json")).models[2].visibility, "hide");
  fs.rmSync(f.cacheFile);
  assert.equal(f.call("models", "--json").status, 1);
});

test("models prefers the paginated app-server catalog and closes its runtime", () => {
  const f = fixture({ runtime: "ok" }); f.writeCache([{ ...models[0], slug: "cache-only" }]);
  const report = json(f.call("models", "--all", "--json"));
  assert.equal(report.source, "app-server");
  assert.equal(Object.hasOwn(report, "fallbackReason"), false);
  assert.deepEqual(report.models.map(model => model.slug), models.map(model => model.slug));
  assert.equal(report.models[0].contextWindow, null);
  const calls = fs.readFileSync(f.calls, "utf8").trim().split("\n").map(JSON.parse).filter(call => call.method === "model/list");
  assert.deepEqual(calls.map(call => call.params.cursor), [null, "second-page"]);
  assert.ok(calls.every(call => call.params.includeHidden));
  assert.throws(() => process.kill(Number(fs.readFileSync(f.pidFile, "utf8")), 0), { code: "ESRCH" });
});

test("invalid pages, cursor loops, errors and a stalled app-server report fallbackReason and clean up", async () => {
  for (const [runtime, expectedReason, timeoutMs] of [
    ["malformed", "invalid", 3000],
    ["loop", "invalid", 3000],
    ["error", "unavailable", 3000],
    ["hang", "timeout", 800]
  ]) {
    const f = fixture({ runtime });
    const report = await listModels({ env: f.env, cwd: f.dir, timeoutMs });
    assert.equal(report.source, "cache", runtime);
    assert.equal(report.fallbackReason, expectedReason, runtime);
    assert.equal(report.models.length, 2);
    assert.doesNotMatch(JSON.stringify(report), /SECRET|identity|token/);
    if (fs.existsSync(f.pidFile)) assert.throws(() => process.kill(Number(fs.readFileSync(f.pidFile, "utf8")), 0), { code: "ESRCH" }, runtime);
  }
});

test("cache and API catalogs reject unsafe tokens and bound untrusted display fields", () => {
  const controls = "\u0000\n\u202e", invalid = ["fixture --sandbox danger-full-access", "../fixture", "x".repeat(101), null];
  const hostile = { ...models[0], slug: "fixture-safe", display_name: `display${controls}${"x".repeat(2048)}`,
    description: `description${controls}${"x".repeat(2048)}`, default_reasoning_level: `default${controls}${"x".repeat(2048)}`,
    supported_reasoning_levels: [{ effort: "ultra" }, { effort: "high\n" }, { effort: "x".repeat(65) }] };
  const entries = [hostile, { ...models[0], slug: " SPARK " }, ...invalid.map(slug => ({ ...models[0], slug }))];
  for (const runtime of [null, "catalog"]) {
    const f = fixture({ runtime, runtimeModels: entries });
    fs.writeFileSync(f.cacheFile, JSON.stringify({ fetched_at: "2026-10-31 (\nINJECTED\n)", models: entries }));
    const report = json(f.call("models", "--json"));
    assert.equal(report.source, runtime ? "app-server" : "cache", String(runtime));
    assert.equal(report.fallbackReason, runtime ? undefined : "unavailable", String(runtime));
    assert.deepEqual(report.models.map(model => model.slug), ["fixture-safe", "gpt-5.3-codex-spark"]);
    assert.equal(report.droppedInvalid, invalid.length);
    assert.equal(report.fetchedAt, new Date(report.fetchedAt).toISOString());
    for (const field of ["displayName", "description", "defaultEffort"]) {
      assert.ok(report.models[0][field].length <= 1024);
      assert.doesNotMatch(report.models[0][field], /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu);
    }
    assert.deepEqual(report.models[0].efforts, ["ultra"]);
    assert.doesNotMatch(JSON.stringify(report), /--sandbox|INJECTED/);
  }
});

test("catalog byte and entry caps reject oversized caches and paginated API totals", () => {
  const f = fixture(), body = JSON.stringify({ models: [models[0]] }), limit = 8 * 1024 * 1024;
  fs.writeFileSync(f.cacheFile, body + " ".repeat(limit - Buffer.byteLength(body)));
  assert.equal(readModelCache(f.env).models.length, 1);
  fs.appendFileSync(f.cacheFile, " ");
  assert.equal(readModelCache(f.env), null);
  const entries = Array.from({ length: 1001 }, (_, index) => ({ ...models[0], slug: `fixture-${index}` }));
  f.writeCache(entries);
  assert.equal(readModelCache(f.env), null);
  const atCap = fixture({ runtime: "paged", runtimeModels: entries.slice(0, 1000) });
  const atCapReport = json(atCap.call("models", "--all", "--json"));
  assert.equal(atCapReport.source, "app-server");
  assert.equal(atCapReport.models.length, 1000);
  assert.equal(Object.hasOwn(atCapReport, "fallbackReason"), false);
  const oversized = fixture({ runtime: "paged", runtimeModels: entries });
  const oversizedReport = json(oversized.call("models", "--json"));
  assert.equal(oversizedReport.source, "cache");
  assert.equal(oversizedReport.fallbackReason, "invalid");
});

test("models rejects invalid options and overlapping homes before runtime startup", async () => {
  const f = fixture({ runtime: "ok" });
  assert.equal(f.call("models", "--typo").status, 1);
  const env = { ...f.env, CODEX_COMPANION_HOME: f.env.CODEX_HOME };
  assert.equal(readModelCache(env), null);
  await assert.rejects(listModels({ env }), /must not overlap/);
  assert.equal(fs.existsSync(f.pidFile), false);
});

test("role setup validates Codex slugs against the isolated cache and accepts unverified Gemini slugs", () => {
  const f = fixture();
  const cached = { models, fetched_at: new Date().toISOString() };
  fs.writeFileSync(f.cacheFile, JSON.stringify(cached));
  const setup = (...models) => roleModelsSetup({ env: f.env, models, dryRun: true });
  assert.throws(() => setup("debug=absent"), /--role-model.*not listed in Codex's isolated model cache/);
  const preview = setup("debug=fixture-hidden:ultra", "review=gemini-custom");
  assert.deepEqual(preview.table.roles.find(row => row.id === "debug"), {
    id: "debug", backend: "codex", model: "fixture-hidden", effort: "ultra", source: "saved"
  });
  assert.equal(preview.warnings.length, 1);
  assert.match(preview.warnings[0], /gemini-custom.*Antigravity/);
  fs.writeFileSync(f.cacheFile, JSON.stringify({ ...cached, fetched_at: new Date(Date.now() - 48 * 3600000).toISOString() }));
  assert.ok(setup("debug=absent").warnings.some(warning => /48 hours old/.test(warning)));
  assert.equal(fs.existsSync(preview.file), false);
});
