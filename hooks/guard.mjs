#!/usr/bin/env node
// doppler hook — dispatch policy. Harness-neutral.
//
// Protocol (doppler's own, not any harness's): a JSON object on stdin, a
// decision object on stdout, exit 0 always. Bindings to a concrete harness
// live in that harness's bridge, never here, so this file is the single
// implementation every harness shares.
//
//   in   {"session_id":"…","tool":"bash","args":{"command":"…"}}
//   out  {"decision":"deny"|"ask","reason":"…"}   (no output = no opinion)
//
// `tool` and `args` are OpenCode's vocabulary — lowercase tool names, camel
// case arg keys. A bridge for another harness maps its names in.
//
// Two tiers:
//   ASK  — judgment calls with no better alternative: the destructive git
//          operations (push --force, reset --hard, checkout --, restore,
//          clean -f). Sometimes intentional; the owner decides each time,
//          in any permission mode.
//   DENY — everything where a better way exists: tool redirects (cat→read,
//          sed -i→edit), restructure redirects (find -delete, find -exec,
//          embedded rm -rf), workflow nudges (sleep>30), and the search/read
//          rate-limits. Deny-and-teach; asking would be noise.
// The attribution blockers (separate hooks) remain hard-deny, unbypassable.
//
// Bypass: prefix the bash command with `# bypass:` OR set env
// DOPPLER_BYPASS_GUARDS=1.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STATE_DIR = process.env.DOPPLER_STATE_DIR
  || path.join(os.homedir(), ".doppler", "session-state");

const MAX_SEARCH_PER_WINDOW = 5;
const SEARCH_WINDOW_TURNS = 10;
const MAX_DISTINCT_READS = 8;
// Must stay strictly greater than MAX_DISTINCT_READS: each read advances `turn`
// by 1, so `distinct` can never exceed READ_WINDOW_TURNS. Equal values make the
// deny branch mathematically unreachable.
const READ_WINDOW_TURNS = 16;

const SEARCH_VERBS = new Set(["grep", "rg", "find", "fd", "ag", "ack"]);

const GIT_DESTRUCTIVE = [
  [/^\s*git\s+push\b.*\s(--force|-f\b)(?!-with-lease)/,
    "`git push --force` rewrites remote history and destroys commits on the " +
    "remote. Use `--force-with-lease` if you must force-push (it aborts when " +
    "the remote has moved)."],
  [/^\s*git\s+reset\b.*\s--hard\b/,
    "`git reset --hard` permanently discards all uncommitted changes in the " +
    "working tree and index. Stash first if you need them: `git stash`."],
  [/^\s*git\s+checkout\b.*\s--\s+\S/,
    "`git checkout -- <path>` permanently discards local changes to tracked " +
    "files. Use `git diff <path>` to review what would be lost, or `git stash` " +
    "to preserve it."],
  [/^\s*git\s+restore\b(?!.*--staged).*(\.|[^\s-]\S*)/,
    "`git restore <path>` permanently discards working-tree changes. " +
    "`git restore --staged` (unstage only) is allowed."],
  [/^\s*git\s+clean\b.*-[a-zA-Z]*f/,
    "`git clean -f` permanently deletes untracked files. " +
    "Run `git clean -n` first to preview what would be removed."],
];

const EMBEDDED_DESTRUCTIVE = [
  [/\brm\s+-[a-zA-Z]*[rf][a-zA-Z]*\s/, "`rm -r`/`rm -f` embedded in command"],
  [/\bdd\b.*\bof=(?!\/dev\/null\b)/, "`dd of=<path>` (destructive disk write) embedded in command"],
];


// Data-driven extra deny/ask rules (policy/guard-rules.json, machine-local;
// engine ships guard-rules.example.json). Shape: {rules:[{decision:"ask"|"deny",pattern:"regex",message:"..."}]}
function loadExtraRules() {
  try {
    const p = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "policy", "guard-rules.json");
    return JSON.parse(fs.readFileSync(p, "utf8")).rules ?? [];
  } catch { return []; }
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function statePath(id) {
  return path.join(STATE_DIR, `${id}.json`);
}

function loadState(id) {
  try {
    return JSON.parse(fs.readFileSync(statePath(id), "utf8"));
  } catch {
    return {
      session_id: id,
      turn: 0,
      bash_log: [],
      read_log: [],
      denied_count: 0,
      asked_count: 0,
      started: Date.now() / 1000,
    };
  }
}

function saveState(state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(statePath(state.session_id), JSON.stringify(state));
  } catch {
    // state is an optimization; never fail the hook over it
  }
}

function decide(state, decision, reason) {
  if (state) {
    if (decision === "ask") state.asked_count = (state.asked_count || 0) + 1;
    else state.denied_count = (state.denied_count || 0) + 1;
    saveState(state);
  }
  process.stdout.write(JSON.stringify({ decision, reason }));
  process.exit(0);
}

function deny(state, reason) {
  decide(state, "deny", reason);
}

function ask(state, reason) {
  decide(state, "ask", reason);
}

function allow() {
  process.exit(0);
}

function hasShellComposition(cmd) {
  return ["|", ">", "<", ";", "&&", "||", "`", "$("].some((t) => cmd.includes(t));
}

async function main() {
  if (process.env.DOPPLER_BYPASS_GUARDS === "1") {
    allow();
  }

  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    allow();
  }

  const tool = payload.tool ?? "";
  const args = payload.args ?? {};
  const sessionId = payload.session_id ?? "default";

  const state = loadState(sessionId);
  state.turn = (state.turn ?? 0) + 1;
  const turn = state.turn;

  if (tool === "bash") {
    const cmd = (args.command || "").trim();
    const firstLine = cmd.split("\n", 1)[0].trim();

    if (firstLine.startsWith("# bypass:") || cmd.startsWith("# bypass:")) {
      saveState(state);
      allow();
    }

    // DENY: bypass flag + cat/head — the bypass env does not make shell the
    // right tool for reading files.
    const mBypassRead = firstLine.match(/^DOPPLER_BYPASS_GUARDS=1\s+(cat|head)\s+/);
    if (mBypassRead) {
      deny(state,
        `\`BYPASS_GUARDS=1 ${mBypassRead[1]}\` is not permitted — prefixing with ` +
        `the bypass flag does not make \`${mBypassRead[1]}\` the right tool for reading files. ` +
        `Use the read tool instead: read({filePath: '<path>'}). ` +
        `It caches content efficiently and supports offset/limit for large files. ` +
        `Only use \`# bypass: <reason>\` when you genuinely need shell semantics ` +
        `(e.g. piping output into another command).`);
    }

    // DENY: plain cat/head/tail — redirect to the read tool.
    if (!hasShellComposition(firstLine)) {
      const m = firstLine.match(/^(cat|head|tail|less|more|bat)\s+(\S+)\s*$/);
      if (m) {
        const [, verb, p] = m;
        deny(state,
          `Anti-pattern: \`${verb} ${p}\`. Use the read tool instead — ` +
          `it caches content efficiently and supports offset/limit for large files. ` +
          `Replace with: read({filePath: '${p}'}). ` +
          `If you genuinely need shell semantics (piping into something), ` +
          `prefix the command with \`# bypass: <reason>\`.`);
      }
    }

    // DENY: restructure redirect — list first, mutate explicitly.
    if (/\bfind\b.*\s-delete\b/.test(cmd)) {
      deny(state,
        "`find ... -delete` is destructive and not permitted via allowlisted `find`. " +
        "Use the read tool to identify files, then call `rm` (which stays prompted).");
    }
    if (/\bfind\b.*\s-exec\s+(rm|mv|chmod|chown|cp)\b/.test(cmd)) {
      deny(state,
        "`find ... -exec <mutating-cmd>` bypasses per-file review. " +
        "List the matches first (without -exec), then run the mutating step explicitly.");
    }

    // DENY: tool redirect — the edit tool is the right way.
    if (/^sed\b.*\s-i(\b|\s|'|")/.test(cmd)) {
      deny(state,
        "`sed -i` mutates files in place and is not permitted via allowlisted `sed`. " +
        "Use the edit tool for targeted edits, or output to a new file and `mv` explicitly.");
    }
    if (/^awk\b.*-i\s+inplace\b/.test(cmd)) {
      deny(state,
        "`awk -i inplace` mutates files and is not permitted. " +
        "Use the edit tool for targeted edits, or write to a new file.");
    }

    // DENY: skill redirect — metacommands escape -readonly.
    if (/\bsqlite3\b/.test(cmd) && /\.(shell|system)\b/.test(cmd)) {
      deny(state,
        "`sqlite3 .shell` / `.system` execute arbitrary shell commands even " +
        "with `-readonly` — the flag only guards SQL writes, not metacommands. " +
        "Prefer a dedicated read-only query tool over raw sqlite3.");
    }

    // DENY: restructure redirect — run the destructive step explicitly.
    // Composition-only: these patterns target allowlist evasion via
    // $(), ;, && chaining. A standalone force-removal command is not an
    // evasion vector — it reaches the user through the default
    // permission flow instead.
    if (hasShellComposition(cmd)) for (const [pattern, label] of EMBEDDED_DESTRUCTIVE) {
      if (pattern.test(cmd)) {
        deny(state,
          `Blocked: ${label} detected. Destructive sub-commands inside ` +
          "shell composition (`$()`, `;`, `&&`) are not permitted via " +
          "allowlisted prefixes. Run the destructive step explicitly so " +
          "it can be reviewed on its own.");
      }
    }

    // ASK: destructive git — the judgment-call tier. Line-by-line so commit
    // message text in heredocs can't false-positive.
    for (const line of cmd.split("\n")) {
      for (const [pattern, message] of GIT_DESTRUCTIVE) {
        if (pattern.test(line)) ask(state, message);
      }
    }

    for (const r of loadExtraRules()) {
      try {
        if (!new RegExp(r.pattern).test(cmd)) continue;
        const reason = r.message || `blocked by guard rule: ${r.pattern}`;
        if (r.decision === "deny") deny(state, reason);
        else ask(state, reason);
      } catch {}
    }

    // DENY: workflow nudge.
    const mSleep = firstLine.match(/^sleep\s+(\d+)/);
    if (mSleep && Number(mSleep[1]) > 30) {
      deny(state,
        `\`sleep ${mSleep[1]}\` is a long blocking wait. Either: ` +
        "(a) run it in the background and poll for completion, or " +
        "(b) do the work that was waiting on it now.");
    }

    // DENY: exploration redirect.
    const firstWord = firstLine ? firstLine.split(/\s+/)[0] : "";
    if (SEARCH_VERBS.has(firstWord)) {
      state.bash_log.push({ turn, verb: firstWord });
      const recent = state.bash_log.filter((e) => turn - e.turn < SEARCH_WINDOW_TURNS);
      state.bash_log = recent.slice(-20);
      if (recent.length > MAX_SEARCH_PER_WINDOW) {
        const verbsUsed = [...new Set(recent.map((e) => e.verb))].sort();
        deny(state,
          `${recent.length} search commands (${verbsUsed.join(", ")}) in the last ` +
          `${SEARCH_WINDOW_TURNS} turns — that's exploration, not execution. ` +
          "Dispatch to the explore subagent so the search results don't accumulate " +
          "in this session's cache prefix:\n" +
          "  task({subagent_type: 'explore', " +
          "description: '<short>', prompt: '<what to find, with breadth: quick|medium|very thorough>'})");
      }
    }

    saveState(state);
    allow();
  }

  if (tool === "read") {
    const p = args.filePath || "";
    state.read_log.push({ turn, path: p });
    const recent = state.read_log.filter((e) => turn - e.turn < READ_WINDOW_TURNS);
    state.read_log = recent.slice(-30);
    const distinct = new Set(recent.map((e) => e.path)).size;
    if (distinct > MAX_DISTINCT_READS) {
      deny(state,
        `${distinct} distinct files read in the last ${READ_WINDOW_TURNS} turns — ` +
        "this looks like codebase exploration. Dispatch to the explore subagent so " +
        "the file contents stay out of the main context:\n" +
        "  task({subagent_type: 'explore', " +
        "description: '<short>', prompt: '<what to find or audit>'})\n" +
        "If you genuinely need to read these files yourself (e.g. you're about to " +
        "edit them), set DOPPLER_BYPASS_GUARDS=1 for the session.");
    }
  }

  saveState(state);
  allow();
}

main();
