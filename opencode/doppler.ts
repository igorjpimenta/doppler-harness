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
// Must stay dependency-free, and must stay out of node_modules. Bun transpiles
// it wherever it sits, but Node refuses to strip types from a file under
// node_modules, so a copy of this engine that npm owns could not be run by node
// at all. That is why the installer copies it into ~/.doppler/opencode/ rather
// than registering the package's own path.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import type { Config, Plugin, PluginInput } from "@opencode-ai/plugin";

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

// What a hook is handed, and what it may answer. This is doppler's own protocol,
// not OpenCode's: OpenCode's tool-call vocabulary is mapped in by `enforce`,
// and a bridge for another harness maps its own in the same place.
//
// `tool` and `args` are absent for a lifecycle event, which is why a hook
// checking `payload.tool` gets undefined rather than a lie.
type HookPayload = {
  session_id: string;
  tool?: string;
  args?: Record<string, unknown>;
  source_patterns?: string[];
  event?: string;
};

type HookDecision = { decision: "deny" | "ask"; reason: string };

// The user's permission rules, as data. The patterns are globs passed through
// to the host verbatim; the shapes here are what keeps that honest.
type Allowlist = {
  allow?: { pattern: string; note?: string }[];
  ask?: { pattern: string; note?: string }[];
  tools?: { allow?: string[] };
};


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

// The user's own standing instructions, at OpenCode's native global path. Its
// existence silences the root's AGENTS.md (see the config hook). The directory
// resolves the way OpenCode itself resolves its global config — XDG_CONFIG_HOME
// when set, else the process home — because a check pinned to ~/.config would
// read a file OpenCode is not reading on an XDG setup. Resolved per call, so a
// test isolates it with $HOME and XDG_CONFIG_HOME the same way the personal
// root isolates with DOPPLER_HOME.
function globalAgentsMd() {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configHome, "opencode", "AGENTS.md");
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
      .filter((f: string) => f.endsWith(".mjs") && !f.endsWith(".example.mjs"))
      .sort();
  } catch {
    return [];
  }
}

// A hook that is missing, slow, or broken must not wedge every tool call. Any
// failure is "no opinion" and the tool proceeds: the same fail-open rule the
// hooks themselves follow.
function runHook(file: string, payload: HookPayload): HookDecision | null {
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

function enforce(input: { tool: string; sessionID: string }, output: { args?: unknown }) {
  const files = hookFiles();
  if (!files.length) return;
  const payload: HookPayload = {
    session_id: input.sessionID,
    tool: input.tool,
    args: (output.args ?? {}) as HookPayload["args"],
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
// Patterns a hook may ask about, declared beside it as `<hook>.ask.json`.
//
// A hook that answers `ask` cannot raise a prompt: it runs in tool.execute.before,
// which is after the harness has already settled the call's permission, so nothing
// the hook says can open a prompt afterwards. Left alone that leaves the model as
// the messenger — it has to be told to raise the question, and a model that never
// does is only stopped by refusing the command.
//
// Declaring the patterns moves the prompt back to the harness. Each one is
// compiled into config.permission as an ask, so the prompt is the harness's own,
// raised before the hook runs and invisible to the model; the hook still runs
// afterwards and keeps deny. The declaration is the hook's promise that it may
// ask about exactly these, so every match is prompted — the cost of taking the
// model out of the decision.
//
// `<hook>.ask.json` rather than an export: hooks are exec'd node scripts with no
// module surface, and a second small file keeps this out of the hook protocol.
function declaredAskPatterns(): string[] {
  const dir = paths().hooks;
  const out: string[] = [];
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const f of files) {
    if (!f.endsWith(".mjs") || f.endsWith(".example.mjs")) continue;
    const decl = f.replace(/\.mjs$/, ".ask.json");
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, decl), "utf8"));
    } catch {
      // No declaration is the common case and means this hook denies or has no
      // opinion, so nothing to ask. A malformed one is reported by doctor, which
      // is where a policy that reads as in force and is not belongs.
      continue;
    }
    const ask = (parsed as { ask?: unknown })?.ask;
    if (!Array.isArray(ask)) continue;
    for (const p of ask) if (typeof p === "string" && p) out.push(p);
  }
  return out;
}

function compiledPermission() {
  let rules: Allowlist;
  try {
    rules = JSON.parse(fs.readFileSync(path.join(paths().home, "policy", "allowlist.json"), "utf8"));
  } catch {
    rules = {};
  }
  const permission: Record<string, unknown> = {};

  for (const t of rules.tools?.allow ?? []) {
    if (typeof t === "string" && t) permission[t] = "allow";
  }

  // ask before allow, so on an overlap the ask is the one the user has to see:
  // a broad allow must not swallow a narrow ask.
  const bash: Record<string, string> = {};
  for (const r of rules.ask ?? []) {
    if (typeof r?.pattern !== "string" || !r.pattern) continue;
    bash[r.pattern] = "ask";
  }
  // A hook's declared asks join the same tier for the same reason: they are the
  // user being asked, so they have to reach the user as a prompt.
  for (const p of declaredAskPatterns()) bash[p] = "ask";
  for (const r of rules.allow ?? []) {
    if (typeof r?.pattern !== "string" || !r.pattern) continue;
    if (bash[r.pattern] === undefined) bash[r.pattern] = "allow";
  }
  if (Object.keys(bash).length) permission.bash = bash;

  return Object.keys(permission).length ? permission : null;
}

// OpenCode evaluates the LAST matching pattern, so doppler's rules are
// appended: a user who has globally allowed bash still gets doppler's asks.
// A string-valued tool rule becomes {"*": <string>} first, which preserves its
// meaning for every command and leaves doppler's entries after it.
function mergePermission(cfg: Record<string, unknown>, tool: string, rule: unknown) {
  const map = (cfg.permission && typeof cfg.permission === "object"
    ? cfg.permission
    : {}) as Record<string, unknown>;
  const current = map[tool];
  if (typeof rule === "string") {
    map[tool] = rule;
  } else if (rule) {
    const base = current && typeof current === "object" ? { ...(current as object) }
      : current !== undefined ? { "*": current }
        : {};
    map[tool] = { ...base, ...(rule as object) };
  }
  cfg.permission = map;
}

// A directory that exists and has something in it.
function hasEntries(dir: string) {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

function overlaySkillRoots() {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(paths().home, "overlay.json"), "utf8")) as { skillsRoots?: unknown };
    const roots = o.skillsRoots;
    return Array.isArray(roots) ? roots.filter((p: unknown): p is string => typeof p === "string") : [];
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

function parseToolList(raw: string) {
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  const names = inner.split(",").map((s: string) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  const allowed = new Set<string>();
  const aliases = TOOL_ALIASES as Record<string, string>;
  for (const n of names) allowed.add(aliases[n.toLowerCase()] ?? n.toLowerCase());
  if (!allowed.size) return null;
  const permission: Record<string, string> = {};
  for (const key of TOOL_KEYS) if (!allowed.has(key)) permission[key] = "deny";
  return permission;
}

function coerce(raw: string) {
  const v = raw.trim();
  if (/^"(.*)"$/.test(v) || /^'(.*)'$/.test(v)) return v.slice(1, -1);
  if (v === "true") return true;
  if (v === "false") return false;
  if (v !== "" && !Number.isNaN(Number(v))) return Number(v);
  return v;
}

function parseAgent(text: string) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  const [, frontmatter, body] = m;
  const config: Record<string, unknown> = {};
  let block: string | null = null;
  for (const line of frontmatter.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indented = /^\s/.test(line);
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1);
    if (indented) {
      if (block && key && AGENT_KEYS.has(block)) {
        ((config[block] ??= {}) as Record<string, unknown>)[key] = coerce(value);
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
    files = fs.readdirSync(paths().agents).filter((f: string) => f.endsWith(".md")).sort();
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

function report(message: string, level: "debug" | "info" | "warn" | "error", client?: PluginInput["client"]) {
  console.error(`doppler: ${message}`);
  client?.app?.log?.({ body: { service: "doppler-harness", level, message } }).catch?.(() => {});
}

// --- live refresh ------------------------------------------------------------
//
// Everything the config hook delivers — the permission map, the agents, the skill
// roots, the instruction registration — is read by OpenCode once per instance and
// snapshotted: Config.state holds the merged config, Agent.state and Skill.state
// each build from it once, and the config hook runs once when the plugin state is
// built. A running session therefore cannot see an edit to any of it, and the only
// way back is to rebuild the instance. Hook bodies are the exception and need
// nothing here: `enforce` re-reads the hooks directory and re-execs each script on
// every tool call, so they have always been live.
//
// The refresh point is instance disposal. POST /instance/dispose drops that
// directory's caches and the next request rebuilds them — config re-read from
// disk, this hook re-run against it — with no process restart. OpenCode does the
// same thing to itself when its own config changes (PATCH /config, and
// PATCH /global/config when the write differs), and its TUI handles the resulting
// `server.instance.disposed` event by re-bootstrapping, so this is a refresh the
// harness already knows how to survive. Verified against v1.18.32: an added
// allowlist pattern is absent from GET /config and present after a dispose.
//
// What it costs: LSP and MCP for the instance restart, and the in-memory "always
// allow" answers given in this session are dropped. Both are why the flush waits
// for an idle boundary instead of firing on the change — a dispose mid-turn kills
// the turn, which is a worse outcome than a stale rule for one command.
// A watcher makes the common case fast; the fingerprint is what makes it
// correct. Measured under Bun 1.3.14 / Node 26 on macOS: a recursive
// `fs.watch` delivers in ~11ms and reacts end-to-end in ~130ms once debounced,
// but it coalesces — 60 atomic saves in 9ms produced 0 events twice out of three
// runs, and delivery of a burst lagged by 400ms+. At editing cadence (250ms
// apart) it delivered every one of 30 saves in 6 runs. So an event is a reason to
// look now, never the reason a change counts: the fingerprint comparison is
// still what decides, and it converged on the final state of every burst across
// 6 rounds. A purely reactive design would have shipped a policy that silently
// stopped applying after an editor's autosave.
const RELOAD_DEBOUNCE_MS = 120;

// The safety net, not the mechanism: it only has to catch what the watcher
// missed, so it can be slow. It is also the whole mechanism where a recursive
// watch is unavailable — the event is an optimisation that can degrade to nothing.
const RELOAD_BACKSTOP_MS = 30_000;
const RELOAD_QUIET_MS = 1500;
const RELOAD_GRACE_MS = 5000;
const RELOAD_RETRY_MS = 30000;

// A turn that runs this long without a tool call and without a status change is
// not a turn the bridge is tracking any more — it is a wedged reloader, which is
// the failure mode this file exists to avoid. Ten minutes is far longer than any
// real step, so the escape cannot fire on a slow-but-live session.
const RELOAD_BUSY_ESCAPE_MS = 600_000;

// Touching this file in the personal root forces one reload even with automatic
// reloading off. It is how `doppler reload` reaches a running session without
// credentials: an external process cannot authenticate to the harness's own
// server (a desktop-app session always sets a password), and a credential written
// to disk to work around that is a worse trade than a file the user touches.
const RELOAD_SENTINEL = ".reload";

function reloadAutomatic() {
  const v = (process.env.DOPPLER_RELOAD ?? "").trim().toLowerCase();
  return !(v === "off" || v === "0" || v === "false" || v === "no");
}

// When the harness first asked for this bridge in this process, once. The
// startup grace exists because a first run scaffolds, installs and rewrites the
// personal root while the instance is still coming up — and every one of those
// writes is a change worth reloading for that nobody asked for. That is a
// property of the process starting, not of an instance: a reload rebuilds the
// instance minutes later with the churn long finished, and measuring grace from
// the instance would make the first edit after every reload wait out five
// seconds for nothing.
let processStart = 0;
function processStarted(): number {
  if (!processStart) processStart = Date.now();
  return processStart;
}

function stamp(file: string): string {
  try {
    const s = fs.statSync(file);
    return `${file}:${s.mtimeMs}:${s.size}`;
  } catch {
    // Absence is a state, not an error: a policy file that does not exist yet is
    // exactly as stale as one whose contents changed.
    return `${file}:absent`;
  }
}

function stampTree(dir: string, out: string[], depth = 0) {
  if (depth > 6) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) stampTree(p, out, depth + 1);
    else if (entry.isFile()) out.push(stamp(p));
  }
}

// What the running instance was built from. Deliberately not the whole root: a
// hook body is not in it, because editing one is already live and reloading for
// it would trade a working session for nothing.
function rootSnapshot(): string {
  const home = paths().home;
  const parts: string[] = [];
  for (const dir of ["policy", "agents", "skills"]) stampTree(path.join(home, dir), parts);
  // Overlay roots are read at config time too, so a change to one is as stale as a
  // change to the root's own skills.
  for (const root of overlaySkillRoots()) stampTree(root, parts);
  for (const file of ["overlay.json", "AGENTS.md"]) parts.push(stamp(path.join(home, file)));
  // hooks/ is not walked. Only its `.ask.json` siblings are, because those compile
  // into config.permission — which is snapshotted — rather than being exec'd per
  // tool call.
  try {
    for (const f of fs.readdirSync(path.join(home, "hooks")).sort()) {
      if (f.endsWith(".ask.json")) parts.push(stamp(path.join(home, "hooks", f)));
    }
  } catch {
    // no hooks directory yet
  }
  return parts.sort().join("\n");
}

// The sentinel is read rather than stat'd: two reloads asked for inside the same
// filesystem timestamp tick have to read as two, and a counter is what makes that
// true regardless of clock resolution.
function sentinelMark(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function disposeInstance(directory: string, serverUrl?: URL) {
  if (!serverUrl || !directory) return Promise.resolve(false);
  const url = new URL("/instance/dispose", serverUrl);
  url.searchParams.set("directory", directory);
  const headers: Record<string, string> = {};
  // The same credentials OpenCode hands its own SDK client at plugin load. A
  // server started with a password — every desktop-app session — answers 401
  // without them, and a reload that quietly fails is a policy that reads as
  // applied and is not.
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  if (password) {
    const user = process.env.OPENCODE_SERVER_USERNAME || "opencode";
    headers.Authorization = "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
  }
  return fetch(url, { method: "POST", headers })
    .then((res) => res.ok)
    .catch(() => false);
}

type Refresh = { activity: () => void; idle: () => void; stop: () => void };

// Timings are parameters rather than constants so a test can drive this at
// something other than real time — the behaviour under test is the comparison
// and the ordering, not the wait.
type Timing = { backstopMs?: number; debounceMs?: number; quietMs?: number; graceMs?: number };

// Started when the config hook runs, because that is the instant the instance's
// snapshot is taken: the fingerprint captured here is what "current" means for
// everything this session has already loaded.
function startRefresh(input: PluginInput, client?: PluginInput["client"], timing: Timing = {}): Refresh {
  const backstopMs = timing.backstopMs ?? RELOAD_BACKSTOP_MS;
  const debounceMs = timing.debounceMs ?? RELOAD_DEBOUNCE_MS;
  const quietMs = timing.quietMs ?? RELOAD_QUIET_MS;
  const graceMs = timing.graceMs ?? RELOAD_GRACE_MS;
  const started = processStarted();
  const home = paths().home;
  const sentinel = path.join(home, RELOAD_SENTINEL);
  const automatic = reloadAutomatic();
  let snapshot = rootSnapshot();
  let sentinelMarkValue = sentinelMark(sentinel);
  let busy = false;
  let lastActivity = started;
  let retryAfter = 0;
  let warned = false;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let recheck: ReturnType<typeof setTimeout> | undefined;

  // Wake up when a hold expires rather than when something else happens to
  // arrive. Parked short of the backstop on purpose: a pending change must never
  // be able to wait longer than the safety net's interval.
  function recheckAt(delay: number) {
    if (recheck) return;
    recheck = setTimeout(() => {
      recheck = undefined;
      void tick();
    }, Math.max(0, Math.min(delay, RELOAD_BACKSTOP_MS)));
    recheck.unref?.();
  }

  // Every path the fingerprint reads has to be watched, or a watched-root change
  // is what triggers the comparison and an unwatched one is invisible until the
  // backstop. The overlay roots are outside the personal root, so they are
  // watched separately.
  // Everything the fingerprint reads has to be watched, or a watched root is what
  // triggers the comparison and an unwatched one is invisible until the backstop.
  // One recursive watch on the personal root covers policy/, agents/, skills/ and
  // hooks/ — including directories created later — so the only extra targets are
  // the overlay roots, which live outside it.
  function watchTargets(): string[] {
    return [home, ...overlaySkillRoots()];
  }

  const tick = async () => {
    try {
      const now = Date.now();
      if (now < retryAfter) return;

      const mark = sentinelMark(sentinel);
      const forced = mark !== sentinelMarkValue;
      sentinelMarkValue = mark;

      // Not walked at all when automatic reloading is off: the fingerprint only
      // ever feeds the comparison, and with the comparison gone it is a walk of
      // the user's skills tree for nothing.
      const current = automatic ? rootSnapshot() : snapshot;
      if (!forced && current === snapshot) return;

      // The three ways a pending change can be held, and when it becomes legal.
      // Each holds it until its own clock runs out rather than until the next
      // thing happens to arrive: an edit made inside the grace window would
      // otherwise sit until the backstop, which is the difference between
      // "applied as soon as I stopped typing" and "applied half a minute later".
      const eligible = Math.max(
        started + graceMs,
        lastActivity + quietMs,
        busy ? lastActivity + RELOAD_BUSY_ESCAPE_MS : 0,
      );
      if (now < eligible) {
        recheckAt(eligible - now);
        return;
      }

      const ok = await disposeInstance(input.directory ?? "", input.serverUrl);
      if (ok) {
        // Adopt the fingerprint that was just pushed. A successful dispose takes
        // this instance — and this watcher — down, so this line only runs if it
        // did not, and repeating the same request on every poke against a harness
        // that ignored the first one is a worse failure than asking again by hand.
        snapshot = current;
        warned = false;
        return;
      }
      // Retrying as fast as events arrive against a server that cannot be
      // reached is how a failed reload turns into a busy loop, and it would bury
      // the one report that says what happened.
      retryAfter = now + RELOAD_RETRY_MS;
      if (!warned) {
        warned = true;
        report(
          `could not reach OpenCode to reload (${input.serverUrl ?? "no server URL"}); ` +
            "policy, agent and skill changes stay invisible to the running session until it can",
          "warn",
          client,
        );
      }
    } catch {
      // A comparison that throws must not become one that has stopped: whatever
      // asked for it will ask again.
    }
  };

  // The fast path. Coalesced into one comparison per burst, because a burst of
  // editor writes should cost one reload and not forty.
  const poke = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = undefined;
      void tick();
    }, debounceMs);
    debounce.unref?.();
  };

  const watchers: fs.FSWatcher[] = [];
  for (const target of watchTargets()) {
    try {
      const w = fs.watch(target, { recursive: true, persistent: false }, poke);
      // `error` on a watcher is not exceptional: a deleted or unmounted root
      // emits it, and an unhandled one would take the process down. Losing a
      // watcher costs latency, never correctness — the backstop still compares.
      w.on("error", () => {});
      watchers.push(w);
    } catch {
      // No recursive watch here (an exotic filesystem, or a path the OS will not
      // watch). The backstop is the mechanism in that case, not a fallback.
    }
  }

  const backstop = setInterval(tick, backstopMs);
  // Never the reason a process outlives its work — a one-shot `opencode run` has
  // nothing left to refresh once it exits.
  backstop.unref?.();

  return {
    activity() {
      busy = true;
      lastActivity = Date.now();
    },
    idle() {
      busy = false;
      lastActivity = Date.now();
      // An idle moment is the only chance a burst that landed mid-turn gets, and
      // the backstop can be half a minute away.
      poke();
    },
    stop() {
      clearInterval(backstop);
      if (debounce) clearTimeout(debounce);
      if (recheck) clearTimeout(recheck);
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          // already closed
        }
      }
    },
  };
}

export const DopplerHarness: Plugin = async (input) => {
  const { client } = input;
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

  // One watcher per plugin instance, started from the config hook because that is
  // when this instance's snapshot is taken. A reload disposes the instance, which
  // runs `dispose` below, which stops this one — the rebuilt instance starts its
  // own.
  let refresh: Refresh | undefined;

  return {
    config: async (cfg) => {
      // A throw here would be an OpenCode startup failure, so the whole hook is
      // best-effort: a broken personal root degrades to "no doppler", never to
      // "opencode will not boot".
        try {
          // The published Config type for the running harness version has no
          // `skills` field, though the harness reads it — verified by delivery, not
          // by the schema. So this one is cast rather than typed, and the reason is
          // recorded here instead of left as a mystery `as`.
          const host = cfg as Config & { skills?: { paths?: string[] } };
          // A root with nothing in it is a dead path in the config, and OpenCode
          // grants an external_directory allowance per registered root — so an
          // empty one is a cost with no benefit.
          const skills = [paths().skills, ...overlaySkillRoots()].filter(hasEntries);
        if (skills.length) {
          host.skills = host.skills && typeof host.skills === "object" ? host.skills : {};
          const existing = Array.isArray(host.skills.paths) ? host.skills.paths : [];
          host.skills.paths = [...new Set([...existing, ...skills])];
        }

        const permission = compiledPermission();
        if (permission) {
          for (const [tool, rule] of Object.entries(permission)) mergePermission(cfg, tool, rule);
        }

        // A root AGENTS.md is the personal root's standing instructions, and it
        // is registered like the skills above — read in place, deduped against
        // whatever the user already listed. It is a fallback, not an override:
        // the native global path (globalAgentsMd) is the user's own voice, and
        // a root file that applied alongside it would leave two standing
        // instructions with no visible precedence. So when the user has one,
        // the root's stays dormant — the same "the user's own wins" rule as
        // the agents below.
        const agentsMd = path.join(paths().home, "AGENTS.md");
        if (fs.existsSync(agentsMd) && !fs.existsSync(globalAgentsMd())) {
          const listed = Array.isArray(cfg.instructions) ? cfg.instructions : [];
          cfg.instructions = [...new Set([...listed, agentsMd])];
        }

        for (const agent of readAgents()) {
          cfg.agent = cfg.agent && typeof cfg.agent === "object" ? cfg.agent : {};
          if (cfg.agent[agent.name]) continue; // the user's own agent wins
          cfg.agent[agent.name] = { ...agent.config, prompt: agent.prompt };
        }
      } catch {
        // see above
      }
      // Outside the try on purpose: the config injection above is best-effort, but
      // a session that came up degraded is exactly the one whose policy is most
      // likely being edited, so the thing that makes the edit visible must not
      // depend on the edit being well-formed.
      if (!refresh) refresh = startRefresh(input, client);
    },

    "tool.execute.before": async (input, output) => {
      // A tool call is proof a turn is running, which is the one thing the reload
      // flush must not do through. Recorded before enforce so a denied call still
      // counts as activity.
      refresh?.activity();
      // Deliberately not wrapped: a deny or ask has to reach the model as a
      // thrown error, which is the only thing that stops the call.
      enforce(input, output);
    },

    event: async ({ event }) => {
      // Session state, not just session.created: the reload flush waits for an
      // idle boundary, and it has to be told where the boundaries are.
      if (event.type === "session.status") {
        const status = (event.properties as { status?: { type?: string } } | undefined)?.status?.type;
        if (status === "idle") refresh?.idle();
        else refresh?.activity();
        return;
      }
      // `session.idle` is the deprecated spelling of the above and still emitted
      // by some sessions; treating it as unknown would wedge the reloader on a
      // turn it can never see finish.
      if (event.type === "session.idle") {
        refresh?.idle();
        return;
      }

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

    dispose: async () => {
      // The instance is being torn down — either because a reload fired, or
      // because the process is ending. Either way the watcher has to stop here: it
      // would otherwise outlive the hooks object it belongs to and, on a reload,
      // race the rebuilt instance's own.
      refresh?.stop();
      refresh = undefined;
    },
  };
};

// The bridge declares its id so the installer can tell it from a plugin the
// user wrote to replace it: OpenCode loads every registered plugin and does not
// dedup by id, so "doppler is the secondary option" is doppler's own check, not
// the harness's. A same-id plugin already registered means the user's is the
// primary and this bridge stays dormant. The id is a stable contract — the
// installer matches on it, and a user replacing doppler names theirs the same.
export default { id: "doppler", server: DopplerHarness };

// The refresh internals, for the test suite. What counts as a change worth
// reloading for is a claim the bridge makes on the user's behalf — an edit that
// silently costs a session restart, or one that silently fails to — and the only
// place that can be asserted is from inside the module. Not part of the plugin
// contract: OpenCode reads the default export and nothing else.
export const internals = { rootSnapshot, startRefresh };
