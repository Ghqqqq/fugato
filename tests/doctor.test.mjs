import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDir, initGitRepo, run, writeExecutable, requireLocalSockets, readyBroker } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { installFakeAntigravity } from "./fake-antigravity-fixture.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";
import { runDoctor, renderDoctorReport } from "../plugins/codex/scripts/lib/doctor.mjs";

const cli = new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url).pathname;

function snapshotTree(target) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (stat.isSymbolicLink()) return { type: "symlink", link: fs.readlinkSync(target) };
  if (stat.isDirectory()) {
    return {
      type: "dir",
      entries: fs.readdirSync(target).sort().map(name => [name, snapshotTree(path.join(target, name))])
    };
  }
  if (stat.isFile()) {
    return { type: "file", content: fs.readFileSync(target, "utf8") };
  }
  return { type: "other" };
}

function writeFakeAgy(binDir, { version = "1.5.16", versionOutput = null, hangVersion = false, extraStderr = "" } = {}) {
  const file = path.join(binDir, "agy");
  const out = versionOutput ?? `agy ${version}\n`;
  writeExecutable(file, `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes("--version")) {
  ${extraStderr ? `process.stderr.write(${JSON.stringify(extraStderr)});` : ""}
  ${hangVersion ? "setTimeout(() => {}, 60000);" : `process.stdout.write(${JSON.stringify(out)}); process.exit(0);`}
} else {
  process.exit(0);
}
`);
  return file;
}

function installFakeFugatoLive(claudeRoot, { version = "1.10.0", invalidManifest = false, disabled = false } = {}) {
  const pluginDir = path.join(claudeRoot, "plugins", "cache", "fugato", "fugato-live", version);
  fs.mkdirSync(path.join(pluginDir, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, ".claude-plugin", "plugin.json"),
    invalidManifest ? "{ broken json" : JSON.stringify({ name: "fugato-live", version }, null, 2)
  );
  fs.mkdirSync(path.join(claudeRoot, "plugins"), { recursive: true });
  fs.writeFileSync(
    path.join(claudeRoot, "plugins", "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { "fugato-live@fugato": [{ scope: "user", installPath: pluginDir, version }] } })
  );
  if (disabled) {
    fs.writeFileSync(path.join(claudeRoot, "settings.json"), JSON.stringify({ enabledPlugins: { "fugato-live@fugato": false } }));
  }
  return pluginDir;
}

function createFixture({ withCodex = true, withAgy = true, agyVersion = "1.5.16", withLive = true, withHome = true, codexBehavior = "review-ok" } = {}) {
  const root = makeTempDir("doctor-");
  const repo = path.join(root, "repo");
  const binDir = path.join(root, "bin");
  const agyBinDir = path.join(root, "agy-bin");
  const home = path.join(root, "home");
  const claudeRoot = path.join(home, ".claude");
  const isolated = path.join(root, "isolated");

  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(agyBinDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  initGitRepo(repo);

  if (withHome) fs.mkdirSync(isolated, { recursive: true });
  if (withCodex) installFakeCodex(binDir, codexBehavior);
  const agyPath = withAgy ? writeFakeAgy(agyBinDir, { version: agyVersion }) : null;
  if (withLive) installFakeFugatoLive(claudeRoot);

  const env = {
    ...buildEnv(binDir),
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: claudeRoot,
    CLAUDE_PLUGIN_DATA: path.join(root, "data"),
    CODEX_COMPANION_HOME: isolated,
    CODEX_HOME: path.join(home, ".codex"),
    CODEX_SQLITE_HOME: path.join(home, ".codex"),
    FUGATO_ANTIGRAVITY_BIN: agyPath ?? "",
    PATH: `${binDir}${path.delimiter}${path.dirname(process.execPath)}`
  };
  if (!withCodex) env.CODEX_COMPANION_BIN = path.join(root, "missing-codex");

  return { root, repo, binDir, agyBinDir, home, claudeRoot, isolated, env, agyPath };
}

function findCheck(report, id) {
  const found = report.checks.find(entry => entry.id === id);
  assert.ok(found, `Missing check '${id}'. Present: ${report.checks.map(entry => entry.id).join(", ")}`);
  return found;
}

function assertValidSchema(report) {
  assert.equal(typeof report.ok, "boolean");
  assert.ok(Array.isArray(report.checks) && report.checks.length >= 10);
  const ids = new Set();
  for (const entry of report.checks) {
    assert.deepEqual(Object.keys(entry).sort(), ["code", "fix", "id", "status", "summary"]);
    assert.equal(typeof entry.id, "string");
    assert.ok(entry.id.length > 0 && !ids.has(entry.id), `Duplicate or empty id: ${entry.id}`);
    ids.add(entry.id);
    assert.ok(["pass", "warn", "fail"].includes(entry.status), `Invalid status: ${entry.status}`);
    assert.equal(typeof entry.code, "string");
    assert.ok(entry.code.length > 0);
    assert.equal(typeof entry.summary, "string");
    assert.ok(entry.summary.length > 0);
    assert.ok(entry.fix === null || (typeof entry.fix === "string" && entry.fix.length > 0));
  }
  assert.equal(report.ok, report.checks.every(entry => entry.status !== "fail"));
}

test("doctor --offline --json completes in under 2s, matches schema, and leaves temp home unchanged", () => {
  const f = createFixture();
  const beforeIsolated = snapshotTree(f.isolated);
  const beforeHome = snapshotTree(f.home);

  const started = Date.now();
  const result = run(process.execPath, [cli, "doctor", "--offline", "--json"], { cwd: f.repo, env: f.env });
  const elapsedMs = Date.now() - started;

  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.ok(elapsedMs < 2000, `Expected doctor --offline --json < 2000ms, took ${elapsedMs}ms`);

  const report = JSON.parse(result.stdout);
  assertValidSchema(report);
  assert.equal(report.ok, true);
  assert.equal(findCheck(report, "codex.binary").status, "pass");
  assert.equal(findCheck(report, "codex.home").status, "pass");
  assert.equal(findCheck(report, "codex.auth").code, "codex_auth_skipped_offline");
  assert.equal(findCheck(report, "antigravity.binary").status, "pass");
  assert.equal(findCheck(report, "antigravity.auth").code, "antigravity_auth_skipped_offline");
  assert.equal(findCheck(report, "plugins.fugato_live").status, "pass");

  assert.deepEqual(snapshotTree(f.isolated), beforeIsolated, "isolated home must remain byte-for-byte unchanged");
  assert.deepEqual(snapshotTree(f.home), beforeHome, "user home must remain byte-for-byte unchanged");
  assert.equal(fs.existsSync(path.join(f.binDir, "fake-codex-state.json")), false, "offline doctor must never start codex app-server");

  // Compact table rendering (non-JSON) also exits 0 and leaves home unchanged.
  const table = run(process.execPath, [cli, "doctor", "--offline"], { cwd: f.repo, env: f.env });
  assert.equal(table.status, 0, table.stderr);
  assert.match(table.stdout, /Fugato Doctor: OK/);
  assert.match(table.stdout, /codex\.binary/);
  assert.deepEqual(snapshotTree(f.isolated), beforeIsolated);
});

test("doctor --offline leaves a missing isolated home uncreated (never mkdir)", () => {
  const f = createFixture({ withHome: false });
  assert.equal(fs.existsSync(f.isolated), false);

  const result = run(process.execPath, [cli, "doctor", "--offline", "--json"], { cwd: f.repo, env: f.env });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const report = JSON.parse(result.stdout);
  assertValidSchema(report);
  assert.equal(report.ok, true);
  const homeCheck = findCheck(report, "codex.home");
  assert.equal(homeCheck.status, "warn");
  assert.equal(homeCheck.code, "codex_home_missing");
  assert.match(homeCheck.fix, /fugato setup/);
  assert.equal(fs.existsSync(f.isolated), false, "doctor must never create missing isolated home");
});

test("online doctor spawns zero Codex app-server / ACP sessions and leaves temp home unchanged", () => {
  const f = createFixture({ withAgy: false });
  const fakeAcpDir = path.join(f.root, "fake-acp");
  const acp = installFakeAntigravity(fakeAcpDir, { version: "1.5.16" });
  f.env.FUGATO_ANTIGRAVITY_BIN = acp.binary;

  // Case 1: isolated home exists without auth.json.
  const beforeIsolated = snapshotTree(f.isolated);
  const beforeHome = snapshotTree(f.home);
  const absentRes = run(process.execPath, [cli, "doctor", "--json"], { cwd: f.repo, env: f.env });
  assert.equal(absentRes.status, 0, absentRes.stderr + absentRes.stdout);
  const absentReport = JSON.parse(absentRes.stdout);
  assertValidSchema(absentReport);
  assert.equal(findCheck(absentReport, "codex.auth").status, "warn");
  assert.equal(findCheck(absentReport, "codex.auth").code, "codex_auth_absent");
  assert.match(findCheck(absentReport, "codex.auth").summary, /not verified/i);
  assert.equal(findCheck(absentReport, "antigravity.binary").status, "pass");
  assert.match(findCheck(absentReport, "antigravity.binary").summary, /1\.5\.16/);
  const agyAuth = findCheck(absentReport, "antigravity.auth");
  assert.equal(agyAuth.status, "pass");
  assert.equal(agyAuth.code, "antigravity_acp_initialized");
  assert.match(agyAuth.summary, /Google login/);
  assert.match(agyAuth.summary, /not verified/i);
  assert.match(agyAuth.summary, /agy acp --login/);

  // Only ACP initialize was sent — never session/new or session/prompt.
  assert.deepEqual(acp.requests().map(req => req.method), ["initialize"]);
  assert.equal(fs.existsSync(path.join(f.binDir, "fake-codex-state.json")), false, "online doctor must never spawn codex app-server");
  assert.deepEqual(snapshotTree(f.isolated), beforeIsolated, "online doctor must not modify isolated home");
  assert.deepEqual(snapshotTree(f.home), beforeHome, "online doctor must not modify user home");

  // Case 2: auth.json present -> reported as present / not verified without reading contents.
  fs.writeFileSync(path.join(f.isolated, "auth.json"), JSON.stringify({ secret: "must-not-read-or-echo" }));
  const beforeWithAuth = snapshotTree(f.isolated);
  const presentRes = run(process.execPath, [cli, "doctor", "--json"], { cwd: f.repo, env: f.env });
  assert.equal(presentRes.status, 0, presentRes.stderr + presentRes.stdout);
  const presentReport = JSON.parse(presentRes.stdout);
  assert.equal(findCheck(presentReport, "codex.auth").status, "pass");
  assert.equal(findCheck(presentReport, "codex.auth").code, "codex_auth_present_unverified");
  assert.match(findCheck(presentReport, "codex.auth").summary, /present/i);
  assert.match(findCheck(presentReport, "codex.auth").summary, /not verified/i);
  assert.doesNotMatch(presentRes.stdout, /must-not-read-or-echo/);
  assert.deepEqual(snapshotTree(f.isolated), beforeWithAuth);
});

test("online doctor queries an already-running broker read-only when present", async t => {
  if (!await requireLocalSockets(t)) return;
  const f = createFixture();
  const broker = await readyBroker(f.repo, f.env);
  try {
    const beforeBrokerFile = fs.readFileSync(path.join(resolveStateDir(f.repo, f.env), "broker.json"), "utf8");
    const report = await runDoctor({ cwd: f.repo, offline: false, env: f.env });
    assertValidSchema(report);
    assert.equal(report.ok, true);
    assert.equal(findCheck(report, "runtime.broker").status, "pass");
    assert.equal(findCheck(report, "runtime.broker").code, "broker_ok");
    assert.equal(findCheck(report, "codex.auth").status, "pass");
    assert.equal(findCheck(report, "codex.auth").code, "codex_auth_ok");
    assert.equal(fs.readFileSync(path.join(resolveStateDir(f.repo, f.env), "broker.json"), "utf8"), beforeBrokerFile);
  } finally {
    broker.close();
  }
});

test("doctor detects and gives actionable fixes for missing agy, agy < 1.5.15, native-unavailable, missing/broken fugato-live, dead admission locks, stale broker socket/lock, and orphaned approval artifacts", () => {
  const f = createFixture({ withAgy: false, withLive: false });
  const duetDir = path.join(f.isolated, "duet");
  fs.mkdirSync(duetDir, { recursive: true });

  // 1. Active native-unavailable.json marker.
  const observedAt = new Date(Date.now() - 3600_000).toISOString();
  fs.writeFileSync(path.join(duetDir, "native-unavailable.json"), JSON.stringify({ at: observedAt, reason: "missing_turn_start" }));

  // 2. Dead-owner admission lock (use a guaranteed-dead PID from an exited child).
  const deadPid = run(process.execPath, ["-e", ""]).pid;
  const admissionLockDir = path.join(duetDir, "antigravity-session-admission", "sessionhash.lock");
  fs.mkdirSync(admissionLockDir, { recursive: true });
  fs.writeFileSync(path.join(admissionLockDir, `owner-${deadPid}-deadbeef`), "");

  // 3. Stale broker socket + stale broker spawn lock.
  const stateDir = resolveStateDir(f.repo, f.env);
  fs.mkdirSync(stateDir, { recursive: true });
  const staleSockPath = path.join(f.root, "stale-broker.sock");
  fs.writeFileSync(staleSockPath, "");
  fs.writeFileSync(path.join(stateDir, "broker.json"), JSON.stringify({
    pid: deadPid,
    endpoint: `unix:${staleSockPath}`
  }));
  const brokerLockDir = path.join(duetDir, "broker-spawn", `${path.basename(stateDir)}.lock`);
  fs.mkdirSync(brokerLockDir, { recursive: true });
  fs.writeFileSync(path.join(brokerLockDir, `owner-${deadPid}-deadcafe`), "");

  // 4. Orphaned staged approval artifact.
  const orphanApprovalDir = path.join(stateDir, "approvals", "task-orphan-1");
  fs.mkdirSync(orphanApprovalDir, { recursive: true });
  fs.writeFileSync(path.join(orphanApprovalDir, `${"a".repeat(64)}.txt`), "staged approval payload");

  const beforeIsolated = snapshotTree(f.isolated);
  const res = run(process.execPath, [cli, "doctor", "--offline", "--json"], { cwd: f.repo, env: f.env });
  // Warn-only still exits 0!
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const report = JSON.parse(res.stdout);
  assertValidSchema(report);
  assert.equal(report.ok, true);

  // Missing agy
  const missingAgy = findCheck(report, "antigravity.binary");
  assert.equal(missingAgy.status, "warn");
  assert.equal(missingAgy.code, "antigravity_binary_missing");
  assert.match(missingAgy.fix, /agy|FUGATO_ANTIGRAVITY_BIN/);
  assert.match(missingAgy.fix, /agy acp --login/);

  // Active native-unavailable.json
  const dispatch = findCheck(report, "dispatch.mode");
  assert.equal(dispatch.status, "warn");
  assert.equal(dispatch.code, "native_unavailable_active");
  assert.match(dispatch.summary, /expires/i);
  assert.match(dispatch.fix, /fugato setup --dispatch/);

  // Missing fugato-live
  const live = findCheck(report, "plugins.fugato_live");
  assert.equal(live.status, "warn");
  assert.equal(live.code, "fugato_live_missing");
  assert.match(live.fix, /fugato-live@fugato/);

  // Dead-owner admission lock
  const admission = findCheck(report, "state.admission_locks");
  assert.equal(admission.status, "warn");
  assert.equal(admission.code, "admission_locks_dead_owner");
  assert.match(admission.fix, /fugato cleanup/);

  // Stale broker socket and lock
  const broker = findCheck(report, "runtime.broker");
  assert.equal(broker.status, "warn");
  assert.equal(broker.code, "broker_stale_socket_and_lock");
  assert.match(broker.summary, /stale broker/i);
  assert.match(broker.fix, /fugato runtime status|broker/i);

  // Orphaned approval artifact
  const approvals = findCheck(report, "state.approval_artifacts");
  assert.equal(approvals.status, "warn");
  assert.equal(approvals.code, "approval_artifacts_orphaned");
  assert.match(approvals.summary, /1 file\(s\)/);
  assert.match(approvals.fix, /fugato cleanup/);

  assert.deepEqual(snapshotTree(f.isolated), beforeIsolated);

  // Separate check: stale broker lock alone (without broker.json).
  fs.rmSync(path.join(stateDir, "broker.json"));
  const lockOnlyRes = run(process.execPath, [cli, "doctor", "--offline", "--json"], { cwd: f.repo, env: f.env });
  assert.equal(lockOnlyRes.status, 0);
  const lockOnlyBroker = findCheck(JSON.parse(lockOnlyRes.stdout), "runtime.broker");
  assert.equal(lockOnlyBroker.status, "warn");
  assert.equal(lockOnlyBroker.code, "broker_stale_lock");
  assert.match(lockOnlyBroker.fix, /broker-spawn|grace/i);

  // Separate check: agy < 1.5.15.
  const oldAgy = writeFakeAgy(f.agyBinDir, { version: "1.5.14" });
  const oldAgyRes = run(process.execPath, [cli, "doctor", "--offline", "--json"], {
    cwd: f.repo,
    env: { ...f.env, FUGATO_ANTIGRAVITY_BIN: oldAgy }
  });
  assert.equal(oldAgyRes.status, 0);
  const oldAgyCheck = findCheck(JSON.parse(oldAgyRes.stdout), "antigravity.binary");
  assert.equal(oldAgyCheck.status, "warn");
  assert.equal(oldAgyCheck.code, "antigravity_version_too_old");
  assert.match(oldAgyCheck.summary, /continuation.*unavailable/i);
  assert.match(oldAgyCheck.fix, /1\.5\.15/);

  // Separate check: broken fugato-live manifest.
  installFakeFugatoLive(f.claudeRoot, { invalidManifest: true });
  const brokenLiveRes = run(process.execPath, [cli, "doctor", "--offline", "--json"], { cwd: f.repo, env: f.env });
  assert.equal(brokenLiveRes.status, 0);
  const brokenLive = findCheck(JSON.parse(brokenLiveRes.stdout), "plugins.fugato_live");
  assert.equal(brokenLive.status, "warn");
  assert.equal(brokenLive.code, "fugato_live_manifest_invalid");
  assert.match(brokenLive.fix, /fugato-live@fugato/);
});

test("doctor fails (exit 1) on permission_mapping=claude with Gemini roles, missing Codex binary, or symlinked isolated home", () => {
  // 1. permission_mapping=claude with active Gemini roles + default_sandbox != danger-full-access.
  const f1 = createFixture();
  fs.mkdirSync(path.join(f1.isolated, "duet"), { recursive: true });
  fs.writeFileSync(path.join(f1.isolated, "duet", "config.toml"), 'permission_mapping = "claude"\ndefault_sandbox = "read-only"\n');
  const r1 = run(process.execPath, [cli, "doctor", "--offline", "--json"], { cwd: f1.repo, env: f1.env });
  assert.equal(r1.status, 1, r1.stderr + r1.stdout);
  const report1 = JSON.parse(r1.stdout);
  assertValidSchema(report1);
  assert.equal(report1.ok, false);
  const pm = findCheck(report1, "config.permission_mapping");
  assert.equal(pm.status, "fail");
  assert.equal(pm.code, "permission_mapping_gemini_conflict");
  assert.match(pm.summary, /read|media|research|alt-design/);
  assert.match(pm.fix, /fugato setup --permission-mapping off/);
  const sb = findCheck(report1, "config.default_sandbox");
  assert.equal(sb.status, "warn");
  assert.equal(sb.code, "default_sandbox_gemini_conflict");
  assert.match(sb.fix, /danger-full-access/);

  // 1b. permission_mapping=claude with explicit Gemini roundtable seat (even without agy).
  const f1b = createFixture({ withAgy: false });
  fs.mkdirSync(path.join(f1b.isolated, "duet"), { recursive: true });
  fs.writeFileSync(
    path.join(f1b.isolated, "duet", "config.toml"),
    'permission_mapping = "claude"\n[roundtable.personas.critic]\nmodel = "gemini-4-neon"\n'
  );
  const r1b = run(process.execPath, [cli, "doctor", "--offline", "--json"], { cwd: f1b.repo, env: f1b.env });
  assert.equal(r1b.status, 1, r1b.stderr + r1b.stdout);
  const pmSeat = findCheck(JSON.parse(r1b.stdout), "config.permission_mapping");
  assert.equal(pmSeat.status, "fail");
  assert.equal(pmSeat.code, "permission_mapping_gemini_conflict");
  assert.match(pmSeat.summary, /critic/);
  assert.match(pmSeat.fix, /--permission-mapping off/);

  // 2. Missing Codex binary -> exit 1.
  const f2 = createFixture({ withCodex: false });
  const r2 = run(process.execPath, [cli, "doctor", "--offline", "--json"], { cwd: f2.repo, env: f2.env });
  assert.equal(r2.status, 1, r2.stderr + r2.stdout);
  const report2 = JSON.parse(r2.stdout);
  assertValidSchema(report2);
  assert.equal(report2.ok, false);
  assert.equal(findCheck(report2, "codex.binary").status, "fail");
  assert.ok(findCheck(report2, "codex.binary").fix);

  // 3. Symlinked isolated home -> exit 1.
  const f3 = createFixture({ withHome: false });
  const realTarget = path.join(f3.root, "real-target");
  fs.mkdirSync(realTarget, { recursive: true });
  fs.symlinkSync(realTarget, f3.isolated);
  const r3 = run(process.execPath, [cli, "doctor", "--offline", "--json"], { cwd: f3.repo, env: f3.env });
  assert.equal(r3.status, 1, r3.stderr + r3.stdout);
  const report3 = JSON.parse(r3.stdout);
  assertValidSchema(report3);
  assert.equal(report3.ok, false);
  const homeCheck = findCheck(report3, "codex.home");
  assert.equal(homeCheck.status, "fail");
  assert.equal(homeCheck.code, "codex_home_symlink");
  assert.match(homeCheck.fix, /symlink|non-symlink/i);
});

test("doctor enforces per-probe timeout on hanging probes without stalling", async () => {
  const f = createFixture({ withAgy: false });
  const fakeAcpDir = path.join(f.root, "hang-acp");
  const acp = installFakeAntigravity(fakeAcpDir, { behavior: "initialize-hang" });
  f.env.FUGATO_ANTIGRAVITY_BIN = acp.binary;

  const started = Date.now();
  const report = await runDoctor({ cwd: f.repo, offline: false, env: f.env, probeTimeoutMs: 300 });
  const elapsedMs = Date.now() - started;

  assertValidSchema(report);
  assert.ok(elapsedMs < 3000, `Expected bounded timeout, took ${elapsedMs}ms`);
  const auth = findCheck(report, "antigravity.auth");
  assert.equal(auth.status, "warn");
  assert.equal(auth.code, "antigravity_acp_timeout");
  assert.ok(auth.fix);
});

test("doctor never leaks tokens, cookies or secrets from env, config, auth files or stderr", () => {
  const f = createFixture({ withAgy: false });
  const secrets = [
    "sk-fake-env-secret-9876543210",
    "AIzaFakeGeminiSecret9876543210",
    "supersecretcookie9876543210",
    "eyJhbGciOiJIUzI1NiJ9.supersecretjwtpayload.sig9876543210",
    "sk-config-secret-9876543210",
    "sk-stderr-secret-9876543210"
  ];
  fs.writeFileSync(path.join(f.isolated, "auth.json"), JSON.stringify({ access_token: secrets[3], api_key: secrets[0] }));
  fs.writeFileSync(path.join(f.isolated, "config.toml"), `bearer_token = "${secrets[4]}"\n`);
  const noisyAgy = writeFakeAgy(f.agyBinDir, {
    version: "1.5.16",
    versionOutput: "",
    extraStderr: `failed with Authorization: Bearer ${secrets[5]}\n`
  });
  // Make noisyAgy exit 1 so stderr surfaces into the diagnostic path and gets redacted.
  writeExecutable(noisyAgy, `#!${process.execPath}
process.stderr.write("error: Authorization: Bearer ${secrets[5]} token=${secrets[0]} cookie=${secrets[2]}\\n");
process.exit(1);
`);

  const env = {
    ...f.env,
    FUGATO_ANTIGRAVITY_BIN: noisyAgy,
    OPENAI_API_KEY: secrets[0],
    GEMINI_API_KEY: secrets[1],
    FUGATO_TEST_COOKIE: `session=${secrets[2]}`
  };

  for (const args of [["doctor", "--offline", "--json"], ["doctor", "--offline"], ["doctor", "--json"]]) {
    const res = run(process.execPath, [cli, ...args], { cwd: f.repo, env });
    assert.equal(res.status, 0, res.stderr + res.stdout);
    const combined = `${res.stdout}\n${res.stderr}`;
    for (const secret of secrets) {
      assert.equal(combined.includes(secret), false, `Secret leaked in ${args.join(" ")}: ${secret}`);
    }
  }
});

test("doctor CLI rejects invalid flags/positionals without mutating state and supports --help and --args-stdin", () => {
  const f = createFixture();
  const before = snapshotTree(f.isolated);

  const help = run(process.execPath, [cli, "doctor", "--help"], { cwd: f.repo, env: f.env });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: fugato doctor/);

  const viaStdin = run(process.execPath, [cli, "doctor", "--args-stdin"], {
    cwd: f.repo,
    env: f.env,
    input: "--offline --json\n"
  });
  assert.equal(viaStdin.status, 0, viaStdin.stderr);
  assertValidSchema(JSON.parse(viaStdin.stdout));

  for (const args of [["doctor", "extra"], ["doctor", "--unknown"], ["doctor", "--cwd", path.join(f.root, "missing")]]) {
    const bad = run(process.execPath, [cli, ...args], { cwd: f.repo, env: f.env });
    assert.equal(bad.status, 1, args.join(" "));
  }
  assert.deepEqual(snapshotTree(f.isolated), before);

  // Verify renderDoctorReport handles empty/warn/fail cleanly.
  const rendered = renderDoctorReport({
    ok: false,
    checks: [{ id: "codex.binary", status: "fail", code: "codex_binary_missing", summary: "missing", fix: "install codex" }]
  });
  assert.match(rendered, /ISSUES FOUND/);
  assert.match(rendered, /Fix: install codex/);
});
