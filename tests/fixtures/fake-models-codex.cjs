#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const dir = path.dirname(process.argv[1]);
const { behavior, models, calls, pidFile } = JSON.parse(
  fs.readFileSync(path.join(dir, "models-fixture-config.json"), "utf8")
);
fs.writeFileSync(pidFile, String(process.pid));
const send = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + "\n");
readline.createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  fs.appendFileSync(calls, JSON.stringify(message) + "\n");
  if (message.method === "initialize") return send(message.id, {});
  if (message.method !== "model/list") return;
  if (behavior === "hang") return;
  if (behavior === "error") {
    return process.stdout.write(
      JSON.stringify({ id: message.id, error: { code: -32601, message: "RUNTIME_SECRET" } }) + "\n"
    );
  }
  if (behavior === "malformed") return send(message.id, { data: "RUNTIME_SECRET" });
  const index = message.params.cursor === null ? 0 : 1;
  const offset = Number(message.params.cursor ?? 0);
  const chunk = behavior === "catalog"
    ? models
    : behavior === "paged"
      ? models.slice(offset, offset + 100)
      : index ? [models[2]] : [models[0], models[1]];
  const data = chunk.map(model => ({
    model: model.slug,
    id: "not-the-slug",
    displayName: model.display_name,
    description: model.description,
    hidden: model.visibility === "hide",
    defaultReasoningEffort: model.default_reasoning_level,
    supportedReasoningEfforts: model.supported_reasoning_levels.map(({ effort }) => ({ reasoningEffort: effort })),
    token: "RUNTIME_SECRET"
  }));
  const nextCursor = behavior === "catalog"
    ? null
    : behavior === "paged"
      ? (offset + 100 < models.length ? String(offset + 100) : null)
      : behavior === "loop" || index === 0 ? "second-page" : null;
  send(message.id, { data, nextCursor });
});
