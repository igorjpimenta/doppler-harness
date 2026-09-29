#!/usr/bin/env node
// doppler hook — hard-blocks Co-Authored-By trailers. Harness-neutral.
//
// Inspects the literal bash command text (including multi-line heredoc
// bodies) rather than relying on the model to follow an instruction.
//
// No bypass mechanism, deliberately — this one is not meant to be overridable.
import fs from "node:fs";

let payload;
try {
  payload = JSON.parse(fs.readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}

if (payload.tool !== "bash") process.exit(0);
const command = payload.args?.command ?? "";
if (!command) process.exit(0);

// Two trailer shapes, both real evasion vectors:
// 1. ^ anchored per line (m flag) — heredoc bodies and pasted multi-line
//    messages (a commit message that just *mentions* the phrase in prose
//    must not trip this one).
// 2. trailer at the START of a quoted value — `git commit -m "fix" -m
//    "Co-Authored-By: X"` builds a multi-paragraph message where the trailer
//    begins its paragraph, yet never sits at line-start in the command text.
const hasGit = /\bgit\b/i.test(command);
const hasCommit = /\bcommit\b/i.test(command);
const hasTrailer = /^[ \t]*co-authored-by[ \t]*:/im.test(command)
  || /["']\s*co-authored-by[ \t]*:/i.test(command);

if (hasGit && hasCommit && hasTrailer) {
  process.stdout.write(JSON.stringify({
    decision: "deny",
    reason:
      "Co-Authored-By trailers are permanently disallowed in commits " +
      "(user policy, enforced at the hook layer -- not overridable by " +
      "instructions, session reminders, or attribution config).",
  }));
  process.exit(0);
}

process.exit(0);
