#!/usr/bin/env node
// doppler hook — initialize per-session state and reap old state files.
// Harness-neutral.
//
// State lives in ~/.doppler/session-state; DOPPLER_STATE_DIR overrides it. The
// reaper keeps the directory bounded: state older than 7 days is deleted.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE_DIR = process.env.DOPPLER_STATE_DIR
  || path.join(os.homedir(), ".doppler", "session-state");

let payload = {};
try {
  payload = JSON.parse(fs.readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}

const sessionId = payload.session_id ?? "default";
fs.mkdirSync(STATE_DIR, { recursive: true });

const statePath = path.join(STATE_DIR, `${sessionId}.json`);
if (!fs.existsSync(statePath)) {
  fs.writeFileSync(statePath, JSON.stringify({
    session_id: sessionId,
    turn: 0,
    bash_log: [],
    read_log: [],
    started: Date.now() / 1000,
  }));
}

const cutoff = Date.now() / 1000 - 7 * 86400;
for (const f of fs.readdirSync(STATE_DIR)) {
  if (!f.endsWith(".json")) continue;
  try {
    const p = path.join(STATE_DIR, f);
    if (fs.statSync(p).mtimeMs / 1000 < cutoff) fs.unlinkSync(p);
  } catch {
    // best-effort reap
  }
}

process.exit(0);
