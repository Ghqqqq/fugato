import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir, writeExecutable } from "./helpers.mjs";
import { backendForModel, BUILTIN_ROLES, expandRole, HIGH_STAKES, ROLE_IDS, ROUTINE_ROLES, STRONG_ROLES } from "../plugins/codex/scripts/lib/roles.mjs";
import { effectiveRoleTable, readRoleOverrides, roleModelsSetup } from "../plugins/codex/scripts/lib/setup-config.mjs";

const codex = (model, effort) => ({ backend: "codex", model, effort });
const gemini = (effort, fallback) => ({ backend: "antigravity", model: "gemini-4-neon", effort, fallback });
const sol = "gpt-6.2-sol", astra = "gpt-6.2-astra", terra = "gpt-6.1-terra";
const expected = {
  scan: codex(sol, "low"), implement: codex(sol, "high"), investigate: codex(sol, "high"), review: codex(sol, "medium"),
  debug: codex(astra, "xhigh"), architect: codex(astra, "xhigh"), verify: codex(astra, "xhigh"), judge: codex(astra, "xhigh"),
  visual: codex(terra, "medium"), read: gemini("high", codex(sol, "high")), media: gemini("high", codex(terra, "medium")),
  research: gemini("high", codex(sol, "high")), "alt-design": gemini("xhigh", codex(astra, "xhigh"))
};
const fixed = { ...codex(astra, "xhigh"), source: "fixed" };
const rowsById = table => Object.fromEntries(table.roles.map(row => [row.id, row]));

test("the role table and its nested defaults are immutable", () => {
  assert.deepEqual(ROLE_IDS, Object.keys(expected));
  assert.deepEqual(ROUTINE_ROLES, ["scan", "implement", "investigate", "review"]);
  assert.deepEqual(STRONG_ROLES, ["debug", "architect", "verify", "judge"]);
  assert.deepEqual(BUILTIN_ROLES, expected);
  assert.deepEqual(HIGH_STAKES, codex(astra, "xhigh"));
  for (const part of [ROLE_IDS, ROUTINE_ROLES, STRONG_ROLES, HIGH_STAKES, BUILTIN_ROLES, ...Object.values(BUILTIN_ROLES)]) {
    assert.ok(Object.isFrozen(part));
    if (part.fallback) assert.ok(Object.isFrozen(part.fallback));
  }
  assert.equal(backendForModel("gemini-4-neon"), "antigravity");
  assert.equal(backendForModel("some-codex-model"), "codex");
});

test("role expansion honors per-field choices and checks the selected backend", () => {
  const table = { roles: Object.entries(expected).map(([id, value]) => ({ id, ...value })), highStakes: fixed };
  const expand = options => expandRole(table, options);
  const implement = { model: sol, effort: "high", role: "implement", highStakes: false };
  assert.deepEqual(expand({ role: "implement", backend: "codex" }), implement);
  assert.deepEqual(expand({ role: "implement", effort: "low" }), { ...implement, effort: "low" });
  assert.deepEqual(expand({ role: "implement", model: "alternate" }), { ...implement, model: "alternate" });
  assert.deepEqual(expand({ role: "read", backend: "antigravity" }), { model: "gemini-4-neon", effort: "high", role: "read", highStakes: false });
  assert.throws(() => expand({ role: "typo" }), error => error.message.includes("typo") && error.message.includes(ROLE_IDS.join(", ")));
  assert.throws(() => expand({ role: "read", backend: "codex" }), /role read runs on Gemini; dispatch fugato:gemini-native/);
  assert.throws(() => expand({ role: "debug", backend: "antigravity" }), /role debug has no Gemini row; dispatch fugato:codex-native/);
  assert.deepEqual(expand({ role: "read", highStakes: true }), { role: "read", model: astra, effort: "xhigh", highStakes: true });
  for (const override of [{ model: astra }, { effort: "xhigh" }]) {
    assert.throws(() => expand({ highStakes: true, ...override }), /--high-stakes fixes model and effort/);
  }
  assert.throws(() => expand({ highStakes: true, backend: "antigravity" }), /dispatch fugato:codex-native for --high-stakes/);
});

function fixture(t) {
  const dir = makeTempDir("roles-"), home = path.join(dir, "isolated"), env = { ...process.env, CODEX_COMPANION_HOME: home };
  const file = path.join(home, "duet", "config.toml"), agy = path.join(dir, "fixture-agy.exe");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const original = process.env.FUGATO_ANTIGRAVITY_BIN;
  process.env.FUGATO_ANTIGRAVITY_BIN = agy;
  t.after(() => {
    if (original === undefined) delete process.env.FUGATO_ANTIGRAVITY_BIN;
    else process.env.FUGATO_ANTIGRAVITY_BIN = original;
  });
  return { env, file, agy, table: () => effectiveRoleTable({ env, cwd: dir }) };
}

test("saved role values inherit missing fields from Codex legacy models and built-in efforts", t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, `ultraRoutineModel = "old-routine"
defaultModel = "old-strong"
defaultEffort = "max"
[roles.investigate]
effort = "low"
[roles.debug]
model = "new-debug"
[roles.high-stakes]
model = "unfixed"
effort = "low"
`);
  assert.deepEqual(readRoleOverrides(f.env), { investigate: { effort: "low" }, debug: { model: "new-debug" } });
  const table = f.table(), rows = rowsById(table);
  for (const id of ROUTINE_ROLES) assert.deepEqual(rows[id], { id, ...codex("old-routine", id === "investigate" ? "low" : expected[id].effort), source: id === "investigate" ? "saved" : "legacy" });
  for (const id of STRONG_ROLES) assert.deepEqual(rows[id], { id, ...codex(id === "debug" ? "new-debug" : "old-strong", "xhigh"), source: id === "debug" ? "saved" : "legacy" });
  assert.deepEqual(rows.visual, { id: "visual", ...expected.visual, source: "built-in" });
  assert.deepEqual(table.highStakes, fixed);
  fs.writeFileSync(f.file, 'ultraRoutineModel = "gemini-routine"\ndefaultModel = "gemini-strong"\n');
  const legacyGemini = rowsById(f.table());
  for (const id of [...ROUTINE_ROLES, ...STRONG_ROLES]) assert.deepEqual(legacyGemini[id], { id, ...expected[id], source: "built-in" });
});

test("Gemini rows follow executable availability and carry each role's own Codex fallback", t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, `[roles.implement]
model = "gemini-custom"
effort = "max"
[roles.media]
model = "gemini-other"
effort = "low"
[roles.read]
model = "custom-codex"
`);
  const absent = f.table(), off = rowsById(absent);
  assert.deepEqual(absent.gemini, { installed: false, executable: null });
  for (const id of ["implement", "media", "research", "alt-design"]) {
    assert.deepEqual(off[id], { id, ...(expected[id].fallback ?? expected[id]), source: "fallback" });
  }
  assert.deepEqual(off.read, { id: "read", ...codex("custom-codex", "high"), source: "saved" });
  writeExecutable(f.agy, "");
  process.env.FUGATO_ANTIGRAVITY_BIN = `.${path.sep}${path.basename(f.agy)}`;
  const present = f.table(), on = rowsById(present);
  assert.deepEqual(present.gemini, { installed: true, executable: f.agy });
  assert.deepEqual(on.implement, { id: "implement", backend: "antigravity", model: "gemini-custom", effort: "max", fallback: expected.implement, source: "saved" });
  assert.deepEqual(on.media, { id: "media", backend: "antigravity", model: "gemini-other", effort: "low", fallback: expected.media.fallback, source: "saved" });
  for (const id of ["research", "alt-design"]) assert.deepEqual(on[id], { id, ...expected[id], source: "built-in" });
  assert.deepEqual(on.read, off.read);
});

test("malformed and unreadable preferences leave valid fields and built-ins available", t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, `[roles.debug]
model = "../bad"
effort = "low"
[roles.review]
model = "custom-review"
effort = "nonsense"
[roles.scan]
model = "one"
model = "two"
`);
  assert.deepEqual(readRoleOverrides(f.env), { debug: { effort: "low" }, review: { model: "custom-review" } });
  const rows = rowsById(f.table());
  assert.equal(rows.debug.model, astra);
  assert.equal(rows.review.effort, "medium");
  assert.equal(rows.scan.source, "built-in");
  fs.writeFileSync(f.file, '[roles.review]\nmodel = "unterminated');
  assert.deepEqual(readRoleOverrides(f.env), {});
  assert.equal(rowsById(f.table()).review.model, sol);
  fs.rmSync(f.file);
  fs.mkdirSync(f.file);
  assert.deepEqual(readRoleOverrides(f.env), {});
  assert.deepEqual(f.table().highStakes, fixed);
});

test("role setup previews, saves and resets a batch while preserving unrelated preferences", t => {
  const f = fixture(t), initial = 'ultraRoutineModel = "legacy"\n# preserved\n';
  fs.writeFileSync(f.file, initial);
  const models = ["implement=spark:max", "visual=gemini-custom:high"];
  const preview = roleModelsSetup({ env: f.env, models, dryRun: true });
  assert.equal(preview.file, f.file);
  assert.deepEqual(preview.changedFiles, [f.file]);
  assert.deepEqual(preview.backups, []);
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)), ["config.toml"]);
  assert.equal(fs.readFileSync(f.file, "utf8"), initial);
  assert.deepEqual(rowsById(preview.table).implement, { id: "implement", ...codex("gpt-5.3-codex-spark", "max"), source: "saved" });
  assert.ok(preview.warnings.some(warning => /gemini-custom.*Antigravity/.test(warning)));
  const saved = roleModelsSetup({ env: f.env, models });
  assert.deepEqual(saved.table, preview.table);
  assert.deepEqual(f.table(), preview.table);
  assert.equal(fs.readFileSync(saved.backups[0], "utf8"), initial);
  assert.deepEqual(readRoleOverrides(f.env), { implement: { model: "gpt-5.3-codex-spark", effort: "max" }, visual: { model: "gemini-custom", effort: "high" } });
  assert.deepEqual(roleModelsSetup({ env: f.env, models }).changedFiles, []);
  const setup = (...models) => roleModelsSetup({ env: f.env, models });
  const before = fs.readFileSync(f.file, "utf8");
  for (const [bad, error] of [["high-stakes=default", /the high-stakes tuple is fixed at gpt-6.2-astra\/xhigh/],
    ["unknown=model", /--role-model.*ids: scan/], ["judge=other:bogus", /--role-model effort/],
    ["judge=gemini-invalid\/model", /valid Gemini model/], ["implement=other", /repeats implement/]]) {
    assert.throws(() => setup("implement=default", bad), error);
    assert.equal(fs.readFileSync(f.file, "utf8"), before);
  }
  const reset = setup("implement=default", "visual=default");
  assert.deepEqual(readRoleOverrides(f.env), {});
  assert.deepEqual(rowsById(reset.table).implement, { id: "implement", ...codex("legacy", "high"), source: "legacy" });
  assert.equal(fs.readFileSync(f.file, "utf8").startsWith(initial), true);
});
