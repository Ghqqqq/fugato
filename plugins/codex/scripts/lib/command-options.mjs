// Public parser definitions are also the permission hook's source of option
// names and types. Internal values are companion-only; other policy exclusions
// belong in the hook.
export const FRESH_ROLE_ERROR = "role flags apply to a fresh dispatch; follow-ups keep the recorded model and effort (use --model/--effort to change them)";
export const NON_FRESH_ROLE_FLAGS = ["to", "thread", "resume", "resume-last", "continue", "fork", "roundtable", "persona"];
export const COMMAND_ALIASES = { C: "cwd" };
export const COMMAND_OPTIONS = {
  // Host-hook only; the permission hook's public verb allowlist excludes it.
  "reserve-name": { valueOptions: [], internalValueOptions: ["session-cwd", "preferred"], booleanOptions: [] },
  task: {
    valueOptions: ["backend", "model", "effort", "role", "cwd", "name", "prompt-file", "thread", "to", "continue", "run", "source", "sandbox", "lease-sec", "question-timeout-sec", "owner", "timeout-sec", "feed-limit", "max-minutes", "max-tokens", "roundtable", "persona"],
    // Companion-only values: the permission hook does not auto-approve these.
    internalValueOptions: ["session-cwd", "dispatch-nonce", "tool-use-id", "agent-name"],
    repeatableOptions: ["approve-browser-origin", "approve-computer-app"],
    booleanOptions: ["high-stakes", "json", "report", "write", "resume-last", "resume", "fresh", "fork", "background", "detached", "follow", "direct", "quiet", "fast", "normal", "no-claude-md"],
    uniqueOptions: ["role", "high-stakes"],
    bareOptions: ["high-stakes"],
    aliasMap: { m: "model" }
  },
  roundtable: {
    valueOptions: ["intensity", "roles", "run", "cwd", "title", "label", "selects", "unreviewed"],
    repeatableOptions: ["persona-model"],
    uniqueOptions: ["high-stakes"],
    bareOptions: ["high-stakes"],
    booleanOptions: ["json", "high-stakes"]
  },
  forum: {
    valueOptions: ["after", "thread", "limit", "resource", "kind", "reply-to", "title", "label", "member", "upto", "selects", "unreviewed"],
    repeatableOptions: ["ref", "mention"],
    booleanOptions: ["json"]
  },
  answer: {
    valueOptions: ["cwd", "question", "owner", "timeout-sec"],
    internalValueOptions: ["tool-use-id"],
    booleanOptions: ["json", "direct", "quiet"]
  },
  wait: {
    valueOptions: ["cwd", "timeout-sec", "min-interval-sec", "owner", "after-question", "feed-limit"],
    internalValueOptions: ["tool-use-id"],
    booleanOptions: ["json", "report", "direct", "quiet", "details"]
  },
  result: {
    valueOptions: ["cwd", "thread"],
    booleanOptions: ["json", "report", "details"]
  },
  status: {
    valueOptions: ["cwd", "thread", "timeout-ms", "poll-interval-ms", "owner"],
    internalValueOptions: ["dispatch-nonce"],
    booleanOptions: ["json", "all", "wait"]
  },
  runtime: { valueOptions: ["cwd"], booleanOptions: ["json"] },
  cancel: { valueOptions: ["cwd"], booleanOptions: ["json", "all"] },
  doctor: { valueOptions: ["cwd"], booleanOptions: ["json", "offline"] }
};

// The fugato launcher implies direct mode for these verbs.
export const DIRECT_OPTION_CONFLICTS = {
  task: ["follow", "detached", "background", "json", "feed-limit", "min-interval-sec"],
  answer: ["json"],
  wait: ["json", "feed-limit", "min-interval-sec"]
};
