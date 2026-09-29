// doppler → OpenCode bridge. Engine-owned: read in place, never edited, never
// copied into ~/.config/opencode. The editable half is the personal root's
// hooks/ and policy/, which this only execs.
//
// It exists because OpenCode has no declarative hook registration: a plugin is
// the only place a shared policy engine can reach the tool loop. So the bridge
// owns nothing but harness vocabulary — tool names, event names, which
// OpenCode CLI verbs add a source — and delegates every decision to the hooks.
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

const HOME = personalRoot();
const HOOKS = path.join(HOME, "hooks");
const AGENTS = path.join(HOME, "agents");
const SKILLS = path.join(HOME, "skills");

// The OpenCode CLI verbs that add a plugin source. Harness vocabulary, so it
// is supplied here rather than guessed inside the hook; the hook still carries
// this same set as a default for standalone use.
const SOURCE_PATTERNS = ["\\bopencode\\s+plugin\\b"];

// Per-tool hook sets. The attribution blockers and the source guard only care
// about shell text; guard.mjs also rates the read tool. Anything else runs no
// hook at all rather than paying four spawns to be told "not my tool".
const UNBYPASSABLE = ["block-co-authored-by.mjs", "block-claude-pr-footer.mjs"];
const GUARDED = {
  bash: [...UNBYPASSABLE, "source-guard.mjs", "guard.mjs"],
  read: ["guard.mjs"],
};

// A hook that is missing, slow, or broken must not wedge every tool call. Any
// failure is "no opinion" and the tool proceeds: the same fail-open rule the
// hooks themselves follow.
function runHook(name, payload) {
  const file = path.join(HOOKS, name);
  if (!fs.existsSync(file)) return null;
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
  const hooks = GUARDED[input.tool];
  if (!hooks) return;
  const payload = {
    session_id: input.sessionID,
    tool: input.tool,
    args: output.args ?? {},
    source_patterns: SOURCE_PATTERNS,
  };
  for (const hook of hooks) {
    const decision = runHook(hook, payload);
    if (decision?.decision === "deny") throw new Error(decision.reason);
    if (decision?.decision === "ask") throw new Error(decision.reason + ASK_NOTE);
  }
}

// --- policy/allowlist.json → OpenCode's own permission engine ---------------

// policy.mjs is a compiler, not a per-call decider: it emits
// {permission:{…}} on stdout and nothing else, so it does not fit the
// {decision,reason} envelope the other hooks use. Read it the same way, but
// tolerate the empty-output case.
function compiledPermission() {
  const file = path.join(HOOKS, "policy.mjs");
  if (!fs.existsSync(file)) return null;
  let res;
  try {
    res = spawnSync(NODE, [file], { input: "{}", encoding: "utf8", timeout: 5000 });
  } catch {
    return null;
  }
  if (res.status !== 0 || !res.stdout) return null;
  try {
    const parsed = JSON.parse(res.stdout);
    return parsed?.permission && typeof parsed.permission === "object" ? parsed.permission : null;
  } catch {
    return null;
  }
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

function overlaySkillRoots() {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(HOME, "overlay.json"), "utf8"));
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
  "hidden", "color", "disable", "steps", "options", "permission",
]);

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
    files = fs.readdirSync(AGENTS).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }
  const agents = [];
  for (const file of files) {
    try {
      const parsed = parseAgent(fs.readFileSync(path.join(AGENTS, file), "utf8"));
      if (parsed) agents.push({ name: `doppler-${path.basename(file, ".md")}`, ...parsed });
    } catch {
      // one malformed agent must not cost the user the rest
    }
  }
  return agents;
}

export const DopplerHarness = async ({ client } = {}) => {
  // Fail-open means a broken runtime is indistinguishable from a permissive
  // one at runtime, so say so once, loudly, at the only moment we can still
  // tell the difference.
  if (!nodeUsable()) {
    const message = `doppler: cannot run node (${NODE}), so every policy hook is inert — ` +
      "install Node 18+ on PATH or set DOPPLER_NODE. Nothing is being enforced.";
    console.error(message);
    client?.app?.log?.({ body: { service: "doppler-harness", level: "error", message } }).catch?.(() => {});
  }

  return {
    config: async (cfg) => {
      // A throw here would be an OpenCode startup failure, so the whole hook is
      // best-effort: a broken personal root degrades to "no doppler", never to
      // "opencode will not boot".
      try {
        const skills = [SKILLS, ...overlaySkillRoots()].filter((p) => fs.existsSync(p));
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
      if (event.type !== "session.created") return;
      const id = event.properties?.info?.id;
      if (id) runHook("session-init.mjs", { session_id: id });
    },
  };
};

export default DopplerHarness;
