#!/usr/bin/env node
// doppler hook — permission policy compiler. Harness-neutral in, neutral out.
//
// OpenCode has a declarative permission engine, so this does NOT reimplement
// one. It compiles ../policy/allowlist.json into a permission map that a
// harness's own engine evaluates, which means the user gets the real prompt
// instead of a hook that fakes one. Run once at init by the bridge, not per
// tool call — hence a compiler rather than a per-call decider.
//
//   in   nothing — it reads ../policy/allowlist.json from disk
//   out  {"permission": {…}} to be merged into the harness's own config
//
// Patterns are GLOBS, passed through verbatim — never translated from regex.
// A lossy regex→glob conversion would fail open: an "ask" rule that silently
// stops matching is an unchecked command, and this repo does not ship a
// policy that can quietly stop applying. The guard hooks, which need the
// expressiveness, keep regexes in policy/guard-rules.json.
//
//   {"allow":[{"pattern":"…glob…","note":"…"}],
//    "ask":  [{"pattern":"…glob…","note":"…"}],
//    "tools":{"allow":["webfetch"]}}
//
//   - no match → no opinion; the harness's own default applies untouched
//   - a broken rule is skipped, never crashes the compiler
//   - the bridge appends these AFTER the user's own rules, because OpenCode
//     evaluates the LAST matching pattern — so a user who has globally
//     allowed bash still gets doppler's asks
//   - no catch-all is emitted: doppler widens nothing, it only narrows
//
// Kill switch: DOPPLER_DISABLE_POLICY=1 emits an empty map.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolved relative to this hook, so the policy travels with the personal
// root regardless of what that root is called.
const RULES_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)), "..", "policy", "allowlist.json"
);

function emit(permission) {
  process.stdout.write(JSON.stringify({ permission }));
  process.exit(0);
}

function loadRules() {
  return JSON.parse(fs.readFileSync(RULES_PATH, "utf8"));
}

function main() {
  if (process.env.DOPPLER_DISABLE_POLICY === "1") emit({});

  let rules;
  try {
    rules = loadRules();
  } catch {
    emit({}); // a missing or malformed allowlist must not silently allow everything
  }

  const permission = {};

  for (const t of rules.tools?.allow ?? []) {
    if (typeof t === "string" && t) permission[t] = "allow";
  }

  // ask before allow in insertion order: on an overlap the ask is the one the
  // user has to see (a broad allow must not swallow a narrow ask).
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

  emit(permission);
}

main();
