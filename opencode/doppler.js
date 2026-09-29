// doppler → OpenCode bridge. Engine-owned: read in place, never edited, never
// copied into ~/.config/opencode. The personal root holds everything else —
// the hooks it execs, the policy it compiles — and this package ships none of
// it.
//
// It exists because OpenCode has no declarative hook registration: a plugin is
// the only place a policy can reach the tool loop. So the bridge owns nothing
// but harness vocabulary — tool names, event names, which OpenCode CLI verbs add
// a source — and delegates every decision to the user's hooks.
//
// Must stay dependency-free. It is imported by OpenCode's own loader, not
// installed into the config directory's node_modules, so anything not built
// into Bun fails to resolve at startup.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

// The hooks are standalone node scripts, so exec them with node — NOT with
// process.execPath. Under Bun, which is what OpenCode's plugin runtime is,
// process.execPath is the opencode binary itself: spawning it would launch a
// second harness instead of the hook, every hook would exit non-zero, and every
// one of them fails open. That is a policy engine that reports success and
// enforces nothing, so node is resolved by name and its usability is checked
// once at startup rather than trusted.
const NODE = (() => {
  if (process.env.DOPPLER_NODE) return process.env.DOPPLER_NODE;
  try {
    return execFileSync("which", ["node"], { encoding: "utf8" }).trim() || "node";
  } catch {
    // no `which` (or nothing on PATH): only trust execPath if it really is node
    return /(^|\/)node[0-9.]*$/.test(process.execPath) ? process.execPath : "node";
  }
})();

function nodeUsable() {
  try {
    return spawnSync(NODE, ["--version"]).status === 0;
  } catch {
    return false;
  }
}


// The personal root is a fixed absolute path, but a plugin gets no access to
// the installer's environment, so the installer writes the resolved location
// into <home>/opencode.json and this reads it back.
function personalRoot() {
  if (process.env.DOPPLER_HOME) return process.env.DOPPLER_HOME;
  try {
    const m = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".doppler", "opencode.json"), "utf8"));
    if (typeof m?.home === "string" && m.home) return m.home;
  } catch {
    // fall through to the default
  }
  return path.join(os.homedir(), ".doppler");
}

// Resolved per call, not once at import. OpenCode loads this module before
// anything can set the environment, and a root captured at import time is a root
// that is wrong for the rest of the session — which for a policy engine means
// reading another directory's rules.
function paths() {
  const home = personalRoot();
  return {
    home,
    hooks: path.join(home, "hooks"),
    agents: path.join(home, "agents"),
    skills: path.join(home, "skills"),
  };
}

// The OpenCode CLI verbs that add a plugin source. Harness vocabulary, so it
// is supplied to the hook rather than guessed inside it.
const SOURCE_PATTERNS = ["\\bopencode\\s+plugin\\b"];

// Every .mjs in the personal root's hooks/ is run for every tool call, in
// sorted order, and each decides for itself whether it has an opinion — the
// payload carries the tool name, so a hook that only cares about shell text can
// return nothing immediately. The alternative, a filename-per-concern table
// here, would put the engine's opinion about policy back into the engine.
function hookFiles() {
  try {
    return fs.readdirSync(paths().hooks)
      // `.example.mjs` is seeded as documentation, matching the policy/ naming:
      // running it would enforce the example's rules, which the user never chose.
      .filter((f) => f.endsWith(".mjs") && !f.endsWith(".example.mjs"))
      .sort();
  } catch {
    return [];
  }
}

// A hook that is missing, slow, or broken must not wedge every tool call. Any
// failure is "no opinion" and the tool proceeds: the same fail-open rule the
// hooks themselves follow.
function runHook(file, payload) {
  let res;
  try {
    res = spawnSync(NODE, [file], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout: 5000,
    });
  } catch {
    return null;
  }
  if (res.status !== 0 || !res.stdout) return null;
  try {
    const decision = JSON.parse(res.stdout);
    return typeof decision?.decision === "string" ? decision : null;
  } catch {
    return null;
  }
}

const ASK_NOTE =
  "\n\n[doppler] This is the ASK tier: a judgment call with no better " +
  "mechanical answer, so the user would normally get a prompt. A pre-tool " +
  "hook cannot raise one, so it is reported as a block instead. If the user " +
  "approves, re-run with the bypass marker — prefix the command with " +
  "`# bypass: <reason>`, or set DOPPLER_BYPASS_GUARDS=1 for the session.";

function enforce(input, output) {
  const files = hookFiles();
  if (!files.length) return;
  const payload = {
    session_id: input.sessionID,
    tool: input.tool,
    args: output.args ?? {},
    source_patterns: SOURCE_PATTERNS,
  };
  for (const file of files) {
    const decision = runHook(path.join(paths().hooks, file), payload);
    if (decision?.decision === "deny") throw new Error(decision.reason);
    if (decision?.decision === "ask") throw new Error(decision.reason + ASK_NOTE);
  }
}

// --- policy/allowlist.json → OpenCode's own permission engine ---------------

// Patterns are globs, passed through verbatim — never translated from regex.
// A lossy regex→glob conversion fails open: an "ask" rule that silently stops
// matching is an unchecked command, and a policy that quietly stops applying is
// worse than no policy. A user who needs regexes wants a hook, not this map.
//
// A missing or malformed allowlist yields an empty map rather than an
// exception, and no catch-all is ever emitted: doppler widens nothing, so an
// unmatched command keeps the host's own default instead of inheriting
// something doppler chose.
function compiledPermission() {
  let rules;
  try {
    rules = JSON.parse(fs.readFileSync(path.join(paths().home, "policy", "allowlist.json"), "utf8"));
  } catch {
    return null;
  }
  const permission = {};

  for (const t of rules.tools?.allow ?? []) {
    if (typeof t === "string" && t) permission[t] = "allow";
  }

  // ask before allow, so on an overlap the ask is the one the user has to see:
  // a broad allow must not swallow a narrow ask.
  const bash = {};
  for (const r of rules.ask ?? []) {
    if (typeof r?.pattern !== "string" || !r.pattern) continue;
    bash[r.pattern] = "ask";
  }
  for (const r of rules.allow ?? []) {
    if (typeof r?.pattern !== "string" || !r.pattern) continue;
    if (bash[r.pattern] === undefined) bash[r.pattern] = "allow";
  }
  if (Object.keys(bash).length) permission.bash = bash;

  return permission;
}

// OpenCode evaluates the LAST matching pattern, so doppler's rules are
// appended: a user who has globally allowed bash still gets doppler's asks.
// A string-valued tool rule becomes {"*": <string>} first, which preserves its
// meaning for every command and leaves doppler's entries after it.
function mergePermission(cfg, tool, rule) {
  cfg.permission = cfg.permission && typeof cfg.permission === "object" ? cfg.permission : {};
  const current = cfg.permission[tool];
  if (rule && typeof rule === "string") {
    cfg.permission[tool] = rule;
    return;
  }
  const base = current && typeof current === "object" ? { ...current }
    : current ? { "*": current }
      : {};
  cfg.permission[tool] = { ...base, ...rule };
}

// A directory that exists and has something in it.
function hasEntries(dir) {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

function overlaySkillRoots() {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(paths().home, "overlay.json"), "utf8"));
    return Array.isArray(o.skillsRoots) ? o.skillsRoots.filter((p) => typeof p === "string") : [];
  } catch {
    return [];
  }
}

// Frontmatter is a flat key/value map, optionally with a two-level
// `permission:` block. Only keys the AgentConfig schema knows are forwarded:
// this object is validated by OpenCode at startup, and an unrecognised key
// would be a hard ConfigInvalidError rather than a no-op.
const AGENT_KEYS = new Set([
  "model", "variant", "temperature", "top_p", "description", "mode",
  "hidden", "color", "disable", "steps", "options", "permission", "tools",
]);

// Every tool an agent can be given or denied. A `tools: [A, B]` list is the
// other spelling of "only A and B", so it has to be resolved against this
// closed set — anything not named is denied.
const TOOL_KEYS = [
  "bash", "edit", "write", "read", "grep", "glob", "list", "patch", "task",
  "todowrite", "todoread", "webfetch", "websearch", "question", "skill", "lsp",
];

// `tools: [Read, Bash, Grep, Glob]` names the tools an agent may use, and
// implies every other one is off. OpenCode's own `tools` field is deprecated and
// is what silently fails open here: a list is not the object shape it expects,
// so it is dropped on validation and the agent keeps ALL tools — an agent
// written read-only comes back with edit and write.
//
// So the list is translated into denies, which is the field the schema still
// recommends and which survives validation. Aliases are mapped because
// frontmatter conventionally uses the capitalised Claude-style names.
const TOOL_ALIASES = {
  bash: "bash", shell: "bash",
  read: "read", view: "read",
  edit: "edit", multiedit: "edit",
  write: "write", create: "write",
  grep: "grep", search: "grep",
  glob: "glob", ls: "glob", list: "glob",
  patch: "patch",
  task: "task", agent: "task",
  todowrite: "todowrite", todoread: "todoread",
  webfetch: "webfetch", fetch: "webfetch",
  websearch: "websearch",
  question: "question",
  skill: "skill",
  lsp: "lsp",
};

function parseToolList(raw) {
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  const names = inner.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  const allowed = new Set();
  for (const n of names) allowed.add(TOOL_ALIASES[n.toLowerCase()] ?? n.toLowerCase());
  if (!allowed.size) return null;
  const permission = {};
  for (const key of TOOL_KEYS) if (!allowed.has(key)) permission[key] = "deny";
  return permission;
}

function coerce(raw) {
  const v = raw.trim();
  if (/^"(.*)"$/.test(v) || /^'(.*)'$/.test(v)) return v.slice(1, -1);
  if (v === "true") return true;
  if (v === "false") return false;
  if (v !== "" && !Number.isNaN(Number(v))) return Number(v);
  return v;
}

function parseAgent(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  const [, frontmatter, body] = m;
  const config = {};
  let block = null;
  for (const line of frontmatter.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indented = /^\s/.test(line);
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1);
    if (indented) {
      if (block && key && AGENT_KEYS.has(block)) {
        (config[block] ??= {})[key] = coerce(value);
      }
      continue;
    }
    block = key;
    if (!AGENT_KEYS.has(key) || value.trim() === "") continue;
    if (key === "permission") {
      config.permission = {};
      block = "permission";
    } else if (key === "tools") {
      // Never forwarded (see TOOL_ALIASES above), and an explicit permission:
      // block still wins for the tools the author spelled out.
      const derived = parseToolList(value);
      if (derived) {
        config.permission = { ...derived, ...(config.permission ?? {}) };
        block = null;
      }
      continue;
    } else {
      config[key] = coerce(value);
    }
  }
  return body.trim() ? { config, prompt: body.trim() } : null;
}

// Namespaced so a personal agent can never shadow a built-in (build, plan,
// explore, general) or collide with the user's own ~/.config/opencode agents.
function readAgents() {
  let files;
  try {
    files = fs.readdirSync(paths().agents).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }
  const agents = [];
  for (const file of files) {
    try {
      const parsed = parseAgent(fs.readFileSync(path.join(paths().agents, file), "utf8"));
      if (parsed) agents.push({ name: `doppler-${path.basename(file, ".md")}`, ...parsed });
    } catch {
      // one malformed agent must not cost the user the rest
    }
  }
  return agents;
}

function report(message, level, client) {
  console.error(`doppler: ${message}`);
  client?.app?.log?.({ body: { service: "doppler-harness", level, message } }).catch?.(() => {});
}

export const DopplerHarness = async ({ client } = {}) => {
  // Fail-open means a broken runtime is indistinguishable from a permissive one
  // at runtime, so say so once, at the only moment the difference is visible.
  if (!nodeUsable()) {
    report(
      `cannot run node (${NODE}), so every policy hook is inert — install ` +
      "Node 18+ on PATH or set DOPPLER_NODE. Nothing is being enforced.",
      "error", client,
    );
  } else if (hookFiles().length === 0) {
    // No hooks is a legitimate state — this package ships no policy, the root
    // supplies it — but it is indistinguishable from a typo, and a silently
    // inert policy engine is the one outcome nobody can see. So say which it is.
    report(
      `no hooks in ${paths().hooks}, so nothing is being enforced. Expected if ` +
      "you have not written any; see the README for the protocol.",
      "warn", client,
    );
  }

  return {
    config: async (cfg) => {
      // A throw here would be an OpenCode startup failure, so the whole hook is
      // best-effort: a broken personal root degrades to "no doppler", never to
      // "opencode will not boot".
      try {
        // A root with nothing in it is a dead path in the config, and OpenCode
        // grants an external_directory allowance per registered root — so an
        // empty one is a cost with no benefit.
        const skills = [paths().skills, ...overlaySkillRoots()].filter(hasEntries);
        if (skills.length) {
          cfg.skills = cfg.skills && typeof cfg.skills === "object" ? cfg.skills : {};
          const existing = Array.isArray(cfg.skills.paths) ? cfg.skills.paths : [];
          cfg.skills.paths = [...new Set([...existing, ...skills])];
        }

        const permission = compiledPermission();
        if (permission) {
          for (const [tool, rule] of Object.entries(permission)) mergePermission(cfg, tool, rule);
        }

        for (const agent of readAgents()) {
          cfg.agent = cfg.agent && typeof cfg.agent === "object" ? cfg.agent : {};
          if (cfg.agent[agent.name]) continue; // the user's own agent wins
          cfg.agent[agent.name] = { ...agent.config, prompt: agent.prompt };
        }
      } catch {
        // see above
      }
    },

    "tool.execute.before": async (input, output) => {
      // Deliberately not wrapped: a deny or ask has to reach the model as a
      // thrown error, which is the only thing that stops the call.
      enforce(input, output);
    },

    event: async ({ event }) => {
      // A session-start hook, if the user wrote one, is a hook like any other
      // and is told what it is for here. It gets the same payload shape, so one
      // hook can serve both roles if it wants.
      if (event.type !== "session.created") return;
      const id = event.properties?.info?.id;
      if (!id) return;
      const payload = { session_id: id, event: "session.created" };
      for (const file of hookFiles()) {
        runHook(path.join(paths().hooks, file), payload);
      }
    },
  };
};

export default DopplerHarness;
