import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { BUILTIN_ROLES, ROLE_IDS, HIGH_STAKES, backendForModel } from "../plugins/codex/scripts/lib/roles.mjs";
import { BUILTIN_WORKER_DEFAULTS, MODE_NAMES } from "../plugins/codex/scripts/lib/ultra-codex-mode.mjs";
import { ANTIGRAVITY_DEFAULT_MODEL } from "../plugins/codex/scripts/lib/antigravity.mjs";
import { normalizeRequestedModel } from "../plugins/codex/scripts/lib/setup-config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => fs.readFileSync(path.join(ROOT, rel), "utf8");

function walkFiles(relDir, exts) {
  const out = [];
  const visit = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (exts.some(ext => entry.name.endsWith(ext))) out.push(path.relative(ROOT, full));
    }
  };
  visit(path.join(ROOT, relDir));
  return out.sort();
}

function setupFlagsFromCode() {
  const src = read("plugins/codex/scripts/codex-companion.mjs");
  const match = src.match(/async function handleSetup\(argv\)\s*\{[\s\S]*?parseCommandInput\(argv,\s*(\{[\s\S]*?\})\);/);
  assert.ok(match, "Could not locate handleSetup option lists in codex-companion.mjs");
  const block = match[1];
  const flags = [];
  for (const key of ["valueOptions", "repeatableOptions", "booleanOptions"]) {
    const listMatch = block.match(new RegExp(`${key}\\s*:\\s*\\[([\\s\\S]*?)\\]`));
    assert.ok(listMatch, `Missing ${key} in handleSetup`);
    for (const item of listMatch[1].matchAll(/"([^"]+)"/g)) flags.push(item[1]);
  }
  assert.ok(flags.length >= 30, `Expected >=30 setup flags, got ${flags.length}`);
  return [...new Set(flags)].sort();
}

test("every fugato setup flag in code appears in setup.md argument-hint and docs/commands.md", () => {
  const flags = setupFlagsFromCode();
  const setupMd = read("plugins/codex/commands/setup.md");
  const hintMatch = setupMd.match(/^argument-hint:\s*(.+)$/m);
  assert.ok(hintMatch, "setup.md missing argument-hint");
  const hint = hintMatch[1];

  const commandsDoc = read("docs/commands.md");
  const start = commandsDoc.indexOf("### `/fugato:setup`");
  assert.ok(start >= 0, "docs/commands.md missing ### `/fugato:setup` section");
  const rest = commandsDoc.slice(start + 1);
  const nextHeading = rest.search(/^### /m);
  const setupSection = nextHeading < 0 ? commandsDoc.slice(start) : commandsDoc.slice(start, start + 1 + nextHeading);

  const hasFlag = (text, flag) => new RegExp(`--${flag}(?![A-Za-z0-9-])`).test(text);
  const missingHint = flags.filter(flag => !hasFlag(hint, flag));
  const missingDoc = flags.filter(flag => !hasFlag(setupSection, flag));
  assert.deepEqual(missingHint, [], `Flags missing from setup.md argument-hint: ${missingHint.join(", ")}`);
  assert.deepEqual(missingDoc, [], `Flags missing from docs/commands.md /fugato:setup: ${missingDoc.join(", ")}`);
});

test("every --default-mode value accepted by code appears in setup.md", () => {
  const expected = ["off", ...MODE_NAMES];
  const setupMd = read("plugins/codex/commands/setup.md");
  const hint = setupMd.match(/^argument-hint:\s*(.+)$/m)?.[1] ?? "";
  const modeMatch = hint.match(/--default-mode\s+([a-z|]+)/);
  assert.ok(modeMatch, "setup.md argument-hint missing --default-mode value list");
  assert.deepEqual(modeMatch[1].split("|").sort(), [...expected].sort());
});

function parseRoleTable(relPath, hasBackendCol) {
  const rows = new Map();
  for (const line of read(relPath).split("\n")) {
    const match = line.match(/^\|\s*`([^`]+)`\s*\|(.+)\|$/);
    if (!match) continue;
    const id = match[1];
    if (!ROLE_IDS.includes(id) && !/^[a-z-]+$/.test(id)) continue;
    const cells = match[2].split("|").map(cell => cell.trim());
    const tupleCol = hasBackendCol ? cells[2] : cells[1];
    const fallbackCol = hasBackendCol ? cells[3] : cells[2];
    const tupleMatch = tupleCol?.match(/^`([^`]+)`\s*\/\s*`([^`]+)`$/);
    if (!tupleMatch) continue;
    const fallbackMatch = fallbackCol?.match(/^`([^`]+)`\s*\/\s*`([^`]+)`$/);
    rows.set(id, {
      backend: hasBackendCol ? cells[1] : null,
      model: tupleMatch[1],
      effort: tupleMatch[2],
      fallback: fallbackMatch ? { model: fallbackMatch[1], effort: fallbackMatch[2] } : null
    });
  }
  return rows;
}

test("built-in role table in lib/roles.mjs matches models skill, core protocol and docs/ultra-codex.md", () => {
  for (const [relPath, hasBackendCol] of [
    ["plugins/codex/skills/models/SKILL.md", false],
    ["plugins/codex/prompts/protocol/core.md", true],
    ["docs/ultra-codex.md", false]
  ]) {
    const table = parseRoleTable(relPath, hasBackendCol);
    assert.deepEqual([...table.keys()].sort(), [...ROLE_IDS].sort(), `Role IDs drifted in ${relPath}`);
    for (const id of ROLE_IDS) {
      const code = BUILTIN_ROLES[id], doc = table.get(id);
      assert.equal(doc.model, code.model, `${relPath} role ${id} model`);
      assert.equal(doc.effort, code.effort, `${relPath} role ${id} effort`);
      if (hasBackendCol) assert.equal(doc.backend, code.backend === "antigravity" ? "Gemini" : "Codex", `${relPath} role ${id} backend`);
      const expectedFallback = code.fallback ? { model: code.fallback.model, effort: code.fallback.effort } : null;
      assert.deepEqual(doc.fallback, expectedFallback, `${relPath} role ${id} fallback`);
    }
    const text = read(relPath);
    assert.ok(text.includes(`\`${HIGH_STAKES.model}\` / \`${HIGH_STAKES.effort}\``), `${relPath} missing high-stakes tuple`);
  }
});


// Short explicit allowlist for cited non-table model identifiers.
const MODEL_SLUG_ALLOWLIST = new Set([
  // Illustrative smaller-model override in /fugato:rescue and config.toml examples (docs/commands.md, docs/configuration.md).
  "gpt-5.4-mini",
  // Existing internal skill name retained without renaming (plugins/codex/skills/gpt-5-4-prompting/SKILL.md).
  "gpt-5-4-prompting"
]);

test("model slugs cited in docs, commands, skills, prompts and agents are all known", () => {
  const known = new Set([
    ...Object.values(BUILTIN_ROLES).flatMap(row => [row.model, row.fallback?.model].filter(Boolean)),
    HIGH_STAKES.model,
    BUILTIN_WORKER_DEFAULTS.model,
    BUILTIN_WORKER_DEFAULTS.routineModel,
    ANTIGRAVITY_DEFAULT_MODEL,
    normalizeRequestedModel("spark"),
    ...MODEL_SLUG_ALLOWLIST
  ]);
  const slugPattern = /\b(?:gpt-[0-9][A-Za-z0-9._-]*|gemini-[0-9][A-Za-z0-9._-]*|o[134]-[A-Za-z0-9._-]+|codex-[0-9][A-Za-z0-9._-]*)\b/g;
  const files = [
    ...walkFiles("docs", [".md", ".mjs", ".js", ".py", ".sh", ".json"]),
    ...walkFiles("plugins/codex/commands", [".md"]),
    ...walkFiles("plugins/codex/skills", [".md"]),
    ...walkFiles("plugins/codex/prompts", [".md"]),
    ...walkFiles("plugins/codex/agents", [".md"])
  ];
  const unknown = [];
  for (const rel of files) {
    const text = read(rel);
    for (const match of text.matchAll(slugPattern)) {
      const slug = match[0];
      const acceptedGemini = /^gemini-[0-9][A-Za-z0-9._-]*$/.test(slug) && backendForModel(slug) === "antigravity";
      if (!known.has(slug) && !acceptedGemini) unknown.push(`${rel}: ${slug}`);
    }
  }
  assert.deepEqual(unknown, [], `Unknown model slugs:\n${unknown.join("\n")}`);
});

const slugifyHeading = text => text.toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");

test("no doc, command, skill, prompt or agent references removed protocol path or legacy journal show", () => {
  const files = [
    ...walkFiles("docs", [".md"]),
    ...walkFiles("plugins/codex/commands", [".md"]),
    ...walkFiles("plugins/codex/skills", [".md"]),
    ...walkFiles("plugins/codex/prompts", [".md"]),
    ...walkFiles("plugins/codex/agents", [".md"])
  ];
  const badProtocol = [], badJournal = [], brokenLinks = [];
  for (const rel of files) {
    const text = read(rel);
    if (text.includes("ultra-codex-protocol.md")) badProtocol.push(rel);
    if (/node\s+["']?\$CODEX_COMPANION["']?\s+journal\s+show/.test(text)) badJournal.push(rel);
    for (const match of text.matchAll(/\]\(([^)]*prompts\/protocol\/[^)#]+\.md)(#[^)]+)?\)/g)) {
      const target = path.resolve(path.dirname(path.join(ROOT, rel)), match[1]);
      if (!fs.existsSync(target)) { brokenLinks.push(`${rel} -> ${match[1]}`); continue; }
      if (match[2]) {
        const anchor = match[2].slice(1);
        const headings = [...fs.readFileSync(target, "utf8").matchAll(/^#{1,6}\s+(.+)$/gm)].map(h => slugifyHeading(h[1]));
        if (!headings.includes(anchor)) brokenLinks.push(`${rel} -> ${match[1]}#${anchor}`);
      }
    }
  }
  assert.deepEqual(badProtocol, [], `Stale ultra-codex-protocol.md references: ${badProtocol.join(", ")}`);
  assert.deepEqual(badJournal, [], `Legacy node "$CODEX_COMPANION" journal show references: ${badJournal.join(", ")}`);
  assert.deepEqual(brokenLinks, [], `Broken protocol links: ${brokenLinks.join(", ")}`);
});

test("documented Gemini capabilities stay aligned in native-agent, protocol core, agents and package.json", () => {
  const nativeAgent = read("plugins/codex/hooks/native-agent.mjs");
  const ready = nativeAgent.match(/^const READY = (.+);$/m)?.[1] ?? "";
  const guide = nativeAgent.match(/^const NATIVE_GUIDE = (.+);$/m)?.[1] ?? "";
  assert.ok(ready.includes("fugato:gemini-native"), "READY must mention fugato:gemini-native");
  assert.ok(guide.includes("fugato:gemini-native"), "NATIVE_GUIDE must mention fugato:gemini-native");

  const core = read("plugins/codex/prompts/protocol/core.md");
  assert.equal(core.includes("persistent Codex personas"), false, "Roundtable line must cover Codex or Gemini personas");
  assert.ok(core.includes("acp-permission") && core.includes("Answer <questionId>") && core.includes("Allow once"));

  const agentFiles = walkFiles("plugins/codex/agents", [".md"]);
  assert.ok(agentFiles.includes("plugins/codex/agents/gemini-native.md"), "agents scan must include gemini-native.md");
  const staleAgents = [], brokenAgentLinks = [];
  for (const rel of agentFiles) {
    const text = read(rel);
    if (/denies\s+questions\s+over\s+the\s+16\s+KiB/i.test(text)) staleAgents.push(rel);
    for (const match of text.matchAll(/\]\((?!https?:\/\/)([^)#]+\.md)(#[^)]+)?\)/g)) {
      const target = path.resolve(path.dirname(path.join(ROOT, rel)), match[1]);
      if (!fs.existsSync(target)) { brokenAgentLinks.push(`${rel} -> ${match[1]}`); continue; }
      if (match[2]) {
        const anchor = match[2].slice(1);
        const headings = [...fs.readFileSync(target, "utf8").matchAll(/^#{1,6}\s+(.+)$/gm)].map(h => slugifyHeading(h[1]));
        if (!headings.includes(anchor)) brokenAgentLinks.push(`${rel} -> ${match[1]}#${anchor}`);
      }
    }
  }
  assert.deepEqual(staleAgents, [], `Stale 16 KiB denial text in agent docs: ${staleAgents.join(", ")}`);
  assert.deepEqual(brokenAgentLinks, [], `Broken relative doc links in agent docs: ${brokenAgentLinks.join(", ")}`);

  const geminiAgent = read("plugins/codex/agents/gemini-native.md");
  assert.ok(geminiAgent.includes("16 KiB") && geminiAgent.includes("staged") && geminiAgent.includes("Exact operation") && geminiAgent.includes("operation-too-large-to-display-exactly"),
    "gemini-native.md must describe staged >16 KiB approvals");

  const pkg = JSON.parse(read("package.json"));
  assert.match(pkg.description, /Codex/i);
  assert.match(pkg.description, /Gemini/i);
});
