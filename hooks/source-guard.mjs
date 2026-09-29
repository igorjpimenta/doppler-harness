#!/usr/bin/env node
// doppler hook — governed source-adding (openclaw install-guard pattern).
// Harness-neutral.
//
// Watches bash commands that add a plugin/source. Trusted sources
// (../policy/source-allowlist.json) pass through untouched; anything else
// returns "ask" with the reason, so the OWNER decides — same tier model as
// guard.mjs.
//
// The verbs that add a source are harness vocabulary, so a bridge for another
// harness overrides them by putting regex source strings in the payload's
// `source_patterns`. The default set below is the OpenCode CLI's. Without a
// match there is no opinion — this hook never guesses at a command it does
// not recognise.
//
// Stateless: no session state, no counters. Total function: any internal
// error → no opinion (fail-open; the default permission flow still applies).
//
// Kill switch: DOPPLER_DISABLE_POLICY=1.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolved relative to this hook so the policy travels with the personal root
// regardless of what that root is called. Absolute, and tilde-free: fs does
// not expand "~", so a literal "~" path here can never match anything.
const POLICY_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)), "..", "policy", "source-allowlist.json"
);

const DEFAULT_SOURCE_PATTERNS = [
  "\\bopencode\\s+plugin\\b",
];

// Read-only verbs never gate, whatever the patterns matched.
const READ_ONLY = /\bopencode\s+plugin\s+list\b/;


// Trusted entries may be written as "~/.doppler/" for portability; the source
// argument, by contrast, may be typed by hand with or without a tilde. Expand
// both sides, or a portable pattern silently never matches. Every "~/" is
// replaced rather than only a leading one, because the argument can arrive
// behind a subcommand and flags ("add --global ~/.doppler/…"), where a
// startsWith check would leave the tilde in place and never match.
function expandTilde(p) {
  return p.trim().split("~/").join(os.homedir() + path.sep);
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function noOpinion() {
  process.exit(0);
}

function ask(reason) {
  process.stdout.write(JSON.stringify({ decision: "ask", reason }));
  process.exit(0);
}

function loadTrusted() {
  try {
    return JSON.parse(fs.readFileSync(POLICY_PATH, "utf8")).trusted ?? [];
  } catch {
    return null; // no policy file → treat as "ask everything"
  }
}

// The source argument is everything after the subcommand — but the subcommand
// is optional, so strip it when present. Tilde expansion downstream depends on
// the "~" landing at the start of the string, so nothing may precede it.
function sourceArgs(cmd) {
  const m = cmd.match(/\bopencode\s+plugin\s+(?:add|install)?\s*(.*)$/s);
  return m ? m[1] : "";
}

function main() {
  if (process.env.DOPPLER_DISABLE_POLICY === "1") noOpinion();

  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    noOpinion();
  }

  if (payload.tool !== "bash") noOpinion();
  const cmd = (payload.args?.command || "").trim();
  if (READ_ONLY.test(cmd)) noOpinion();

  const patterns = Array.isArray(payload.source_patterns) && payload.source_patterns.length
    ? payload.source_patterns
    : DEFAULT_SOURCE_PATTERNS;

  let gated = false;
  for (const p of patterns) {
    try {
      if (new RegExp(p).test(cmd)) { gated = true; break; }
    } catch {
      // a broken bridge-supplied pattern is skipped, never crashes the guard
    }
  }
  if (!gated) noOpinion();

  const src = expandTilde(sourceArgs(cmd));
  const trusted = loadTrusted();
  if (trusted && trusted.some((pat) => src.includes(expandTilde(pat)))) noOpinion();

  const where = trusted
    ? `Trusted patterns live in policy/source-allowlist.json (add this source there if it should be frictionless).`
    : `No source allowlist found (policy/source-allowlist.json) — every source asks.`;
  ask(
    `Adding a new source requires approval (openclaw install-guard policy): ${src.trim().slice(0, 200) || "(no source argument found)"}. ` +
    `Approve only if you trust this origin — an installed source can ship skills, agents, hooks, and MCP servers that run in every future session. ` +
    where
  );
}

main();
