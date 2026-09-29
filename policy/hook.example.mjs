#!/usr/bin/env node
// Example doppler hook. Copy into ~/.doppler/hooks/ and edit freely — the
// bridge runs every .mjs in that directory on every tool call.
//
// Protocol: a JSON object on stdin, a decision on stdout, exit 0 always.
//
//   in   {"session_id":"…","tool":"bash","args":{"command":"…"}}
//   out  {"decision":"deny"|"ask","reason":"…"}     (no output = no opinion)
//
// `tool` and `args` are OpenCode's vocabulary — lowercase tool names, camel-case
// arg keys. Return nothing for a tool you have no opinion about; that costs
// nothing and keeps the logic honest.
//
// The tier model: DENY is for anything with a better alternative, and it is
// final. ASK is for judgment calls the owner should make. A pre-tool hook cannot
// prompt, so the bridge reports an ask as a block whose message names the
// `# bypass:` marker — honour it here or that message is a lie and the model
// retries a command that can never run.
//
// Exit 0 on every path, including internal errors. A hook that crashes has no
// opinion, and that is the property that stops one bug from wedging every tool
// call in every session.
import fs from "node:fs";

let payload;
try {
  payload = JSON.parse(fs.readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}

// Examples, both on the bash tool. Drop in what you actually want to govern.
if (payload.tool === "bash") {
  const command = payload.args?.command ?? "";

  if (/\bcurl\b[^\n]*\s(-X|--request)\s+(POST|PUT|PATCH|DELETE)\b/.test(command)) {
    process.stdout.write(JSON.stringify({
      decision: "deny",
      reason:
        "Write-method curl is denied. Use the dedicated API client for " +
        "state-changing calls, or narrow the request to a read-only verb.",
    }));
    process.exit(0);
  }

  if (/\bnpm\s+publish\b/.test(command)) {
    process.stdout.write(JSON.stringify({
      decision: "ask",
      reason:
        "Publishing is a one-way door — the version cannot be reused. " +
        "Confirm the registry and the version with the user first.",
    }));
    process.exit(0);
  }
}

// No output means no opinion: the tool proceeds.
process.exit(0);
