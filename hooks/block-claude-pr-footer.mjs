#!/usr/bin/env node
// doppler hook — hard-blocks the "Generated with Claude Code" PR footer.
// Harness-neutral.
// Uses real shell tokenization (a shlex split) instead of a text-adjacency
// regex, so prose *describing* "gh pr create" inside a string literal can
// never appear as three separate consecutive tokens the way an actual
// invocation does.
//
// No bypass mechanism, deliberately — this one is not meant to be overridable.
import fs from "node:fs";

// Minimal POSIX-mode shlex.split port: single/double quotes, backslash
// escapes outside and inside double quotes; falls back to a naive whitespace
// split on unterminated quoting (we never deny on a parse failure alone).
function shlexSplit(s) {
  const tokens = [];
  let cur = "";
  let has = false;
  let state = null; // null | "'" | '"'
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escaped) {
      cur += c;
      escaped = false;
      continue;
    }
    if ((state === null || state === '"') && c === "\\") {
      escaped = true;
      has = true;
      continue;
    }
    if (state === null && c === "'") {
      state = "'";
      has = true;
      continue;
    }
    if (state === "'" && c === "'") {
      state = null;
      continue;
    }
    if (state === null && c === '"') {
      state = '"';
      has = true;
      continue;
    }
    if (state === '"' && c === '"') {
      state = null;
      continue;
    }
    if (state === null && /\s/.test(c)) {
      if (has || cur) {
        tokens.push(cur);
        cur = "";
        has = false;
      }
      continue;
    }
    cur += c;
    has = true;
  }
  if (state !== null || escaped) throw new Error("unterminated quoting");
  if (has || cur) tokens.push(cur);
  return tokens;
}

let payload;
try {
  payload = JSON.parse(fs.readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}

if (payload.tool !== "bash") process.exit(0);
const command = payload.args?.command ?? "";
if (!command) process.exit(0);

let tokens;
try {
  tokens = shlexSplit(command);
} catch {
  tokens = command.split(/\s+/).filter(Boolean);
}

const isPrWrite = tokens.some((t, i) =>
  (t === "gh" && tokens[i + 1] === "pr" && (tokens[i + 2] === "create" || tokens[i + 2] === "edit")));

// The footer's URL is the most distinctive, hard-to-coincidentally-match
// signal — checked instead of the emoji or "Generated with", either of which
// a legitimate PR body could plausibly contain on its own.
const hasFooter = /claude\.com\/claude-code/i.test(command);

if (isPrWrite && hasFooter) {
  process.stdout.write(JSON.stringify({
    decision: "deny",
    reason:
      'The "Generated with Claude Code" PR footer is permanently ' +
      "disallowed (user policy, enforced at the hook layer -- not " +
      "overridable by instructions, session reminders, or attribution " +
      "config).",
  }));
  process.exit(0);
}

process.exit(0);
