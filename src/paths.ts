// paths.ts — where the personal root is, and what lives in it. Resolved per
// call, never at import: a root captured at load time is wrong for the rest of
// the session, which for a policy engine means reading another directory's
// rules.
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
export const NODE = (() => {
  if (process.env.DOPPLER_NODE) return process.env.DOPPLER_NODE;
  try {
    return execFileSync("which", ["node"], { encoding: "utf8" }).trim() || "node";
  } catch {
    // no `which` (or nothing on PATH): only trust execPath if it really is node
    return /(^|\/)node[0-9.]*$/.test(process.execPath) ? process.execPath : "node";
  }
})();

export function nodeUsable() {
  try {
    return spawnSync(NODE, ["--version"]).status === 0;
  } catch {
    return false;
  }
}

// The personal root is a fixed absolute path, but a plugin gets no access to
// the installer's environment, so the installer writes the resolved location
// into <home>/opencode.json and this reads it back.
export function personalRoot() {
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
export function paths() {
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
export function globalAgentsMd() {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configHome, "opencode", "AGENTS.md");
}

// A directory that exists and has something in it.
export function hasEntries(dir: string) {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

export function overlaySkillRoots() {
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
