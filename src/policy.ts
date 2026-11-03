// policy.ts — the hook protocol and the enforcement path: what a hook is
// handed, how it runs, and how policy/allowlist.json becomes host permission.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { NODE, paths } from "./paths.ts";


// What a hook is handed, and what it may answer. This is doppler's own protocol,
// not OpenCode's: OpenCode's tool-call vocabulary is mapped in by `enforce`,
// and a bridge for another harness maps its own in the same place.
//
// `tool` and `args` are absent for a lifecycle event, which is why a hook
// checking `payload.tool` gets undefined rather than a lie.
export type HookPayload = {
  session_id: string;
  tool?: string;
  args?: Record<string, unknown>;
  source_patterns?: string[];
  event?: string;
};

export type HookDecision = { decision: "deny" | "ask"; reason: string };

// The user's permission rules, as data. The patterns are globs passed through
// to the host verbatim; the shapes here are what keeps that honest.
export type Allowlist = {
  allow?: { pattern: string; note?: string }[];
  ask?: { pattern: string; note?: string }[];
  deny?: { pattern: string; note?: string }[];
  tools?: { allow?: string[] };
};


// The OpenCode CLI verbs that add a plugin source. Harness vocabulary, so it
// is supplied to the hook rather than guessed inside it.
export const SOURCE_PATTERNS = ["\\bopencode\\s+plugin\\b"];

// Every .mjs in the personal root's hooks/ is run for every tool call, in
// sorted order, and each decides for itself whether it has an opinion — the
// payload carries the tool name, so a hook that only cares about shell text can
// return nothing immediately. The alternative, a filename-per-concern table
// here, would put the engine's opinion about policy back into the engine.
export function hookFiles() {
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
export function runHook(file: string, payload: HookPayload): HookDecision | null {
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

export const ASK_NOTE =
  "\n\n[doppler] This is the ASK tier: a judgment call with no better " +
  "mechanical answer, so the user would normally get a prompt. A pre-tool " +
  "hook cannot raise one, so it is reported as a block instead. If the user " +
  "approves, re-run with the bypass marker — prefix the command with " +
  "`# bypass: <reason>`, or set DOPPLER_BYPASS_GUARDS=1 for the session.";

export function enforce(input: { tool: string; sessionID: string }, output: { args?: unknown }) {
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
export function declaredAskPatterns(): string[] {
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

export function compiledPermission() {
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

  // OpenCode evaluates the LAST matching pattern, so within the map the tiers
  // are emitted allow first and ask last: on an overlap — above all a broad
  // allow like "*" against a narrow ask — the ask has to be the later entry,
  // or the allow silently swallows it. The same holds for an identical pattern
  // listed in both tiers, which therefore resolves to the ask.
  const bash: Record<string, string> = {};
  for (const r of rules.allow ?? []) {
    if (typeof r?.pattern !== "string" || !r.pattern) continue;
    bash[r.pattern] = "allow";
  }
  for (const r of rules.ask ?? []) {
    if (typeof r?.pattern !== "string" || !r.pattern) continue;
    bash[r.pattern] = "ask";
  }
  // A hook's declared asks join the same tier for the same reason: they are the
  // user being asked, so they have to reach the user as a prompt.
  for (const p of declaredAskPatterns()) bash[p] = "ask";
  // Deny is emitted after every other tier, so it out-ranks them all: a command
  // that matches both an ask and a deny is blocked, not prompted. A deny here
  // is the host engine's own — enforced in auto-approve mode too, unlike a
  // hook deny, which only fires when the hook layer is on and can be bypassed.
  for (const r of rules.deny ?? []) {
    if (typeof r?.pattern !== "string" || !r.pattern) continue;
    bash[r.pattern] = "deny";
  }
  if (Object.keys(bash).length) permission.bash = bash;

  return Object.keys(permission).length ? permission : null;
}

// OpenCode evaluates the LAST matching pattern, so doppler's rules are
// appended: a user who has globally allowed bash still gets doppler's asks.
// A string-valued tool rule becomes {"*": <string>} first, which preserves its
// meaning for every command and leaves doppler's entries after it.
export function mergePermission(cfg: Record<string, unknown>, tool: string, rule: unknown) {
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

