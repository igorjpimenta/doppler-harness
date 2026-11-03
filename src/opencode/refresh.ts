// refresh.ts — the live-refresh machinery: snapshot the personal root, notice
// a change, and dispose the instance so the next request rebuilds from disk.
// Legacy (v1 hosts): the current entry relies on the host's own config watching
// instead, and does not start this watcher.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginInput } from "@opencode-ai/plugin";
import { paths, overlaySkillRoots } from "../paths.ts";
import { report } from "../report.ts";
import { engineDistDir, engineUpdateAvailable } from "../engine-update.ts";


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
// correct. A recursive `fs.watch` reactives end-to-end in the low hundreds of
// milliseconds once debounced, but it coalesces under a burst, so an event is a
// reason to look now and never the reason a change counts: the fingerprint
// comparison is still what decides, and it converges on the final state of a
// burst. A purely reactive design would have shipped a policy that silently
// stopped applying after an editor's autosave.
export const RELOAD_DEBOUNCE_MS = 120;

// The safety net, not the mechanism: it only has to catch what the watcher
// missed, so it can be slow. It is also the whole mechanism where a recursive
// watch is unavailable — the event is an optimisation that can degrade to nothing.
export const RELOAD_BACKSTOP_MS = 30_000;
export const RELOAD_QUIET_MS = 1500;
export const RELOAD_GRACE_MS = 5000;
export const RELOAD_RETRY_MS = 30000;

// A turn that runs this long without a tool call and without a status change is
// not a turn the bridge is tracking any more — it is a wedged reloader, which is
// the failure mode this file exists to avoid. Ten minutes is far longer than any
// real step, so the escape cannot fire on a slow-but-live session.
export const RELOAD_BUSY_ESCAPE_MS = 600_000;

// Touching this file in the personal root forces one reload even with automatic
// reloading off. It is how `doppler reload` reaches a running session without
// credentials: an external process cannot authenticate to the harness's own
// server (a desktop-app session always sets a password), and a credential written
// to disk to work around that is a worse trade than a file the user touches.
export const RELOAD_SENTINEL = ".reload";

// Where the bridge records what it loaded, so `doppler doctor` can tell the file
// on disk from the code a running harness is executing.
//
// A plugin module is imported once and cached for the life of the process, so
// nothing else can answer that: reading the file reports the build, not the
// engine. `doctor` reporting green against a build the session never loaded is
// the failure this closes — every other check in it is about the file being
// correct, and this one is about the file being the one in use.
export const ENGINE_LOADED = "engine.loaded.json";

// Content hash, not mtime+size: a rebuild that reproduces identical output is not
// a change, and a same-length edit is. The value is deliberately coarse — it only
// has to differ when the executed code does.
//
// The file is the one the build came from, not the one executing: a self-updating
// copy runs from .engine-cache/, and its own bytes hash differently from the
// installed file it was made from. Hashing the source keeps the value
// comparable with what the installer computes for the installed file.
export function engineStamp(): string {
  try {
    const dist = engineDistDir(paths().home, import.meta.url);
    const file = dist ? path.join(dist, "doppler.js") : fileURLToPath(import.meta.url);
    return crypto
      .createHash("sha256")
      .update(fs.readFileSync(file))
      .digest("hex")
      .slice(0, 16);
  } catch {
    return "unknown";
  }
}

// Written on load, before any check runs. A failure here is not worth reporting:
// the stamp exists for `doctor` to read, and a root that cannot be written to is
// already reported by every other line.
export function recordEngineLoad() {
  try {
    fs.writeFileSync(
      path.join(paths().home, ENGINE_LOADED),
      JSON.stringify({
        stamp: engineStamp(),
        pid: process.pid,
        loadedAt: new Date().toISOString(),
        // A running build that knows how to replace itself says so, so `doctor`
        // and `update` can stop telling it to restart for what it applies alone.
        selfUpdate: true,
      }) + "\n",
    );
  } catch {
    // no opinion
  }
}

export function reloadAutomatic() {
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
export function processStarted(): number {
  if (!processStart) processStart = Date.now();
  return processStart;
}

export function stamp(file: string): string {
  try {
    const s = fs.statSync(file);
    return `${file}:${s.mtimeMs}:${s.size}`;
  } catch {
    // Absence is a state, not an error: a policy file that does not exist yet is
    // exactly as stale as one whose contents changed.
    return `${file}:absent`;
  }
}

export function stampTree(dir: string, out: string[], depth = 0) {
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
export function rootSnapshot(): string {
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
  // plugins/ IS walked, unlike hooks/. A hook body is exec'd per tool call and
  // therefore already live, but a plugin module is imported once and cached for
  // the life of the process — the loader re-imports a plugin whose stamp changed
  // (src/opencode/loader.ts), so a plugin edit has to read as a change here or the
  // rebuilt instance would keep running the cached copy. Only the files the
  // loader would load count, so a test edit does not cost a reload. The filter
  // duplicates the loader's rather than importing it: tests import this file
  // from source, where ./loader.js does not resolve, and the dist layout is a
  // build artifact rather than a contract.
  try {
    for (const f of fs.readdirSync(path.join(home, "plugins")).sort()) {
      if (f.startsWith(".") || f.startsWith("__tests__")) continue;
      if (![".js", ".mjs", ".ts"].includes(path.extname(f))) continue;
      parts.push(stamp(path.join(home, "plugins", f)));
    }
  } catch {
    // no plugins directory yet
  }
  return parts.sort().join("\n");
}

// The sentinel is read rather than stat'd: two reloads asked for inside the same
// filesystem timestamp tick have to read as two, and a counter is what makes that
// true regardless of clock resolution.
export function sentinelMark(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

export function disposeInstance(directory: string, serverUrl?: URL) {
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

export type Refresh = { activity: () => void; idle: () => void; stop: () => void };

// Timings are parameters rather than constants so a test can drive this at
// something other than real time — the behaviour under test is the comparison
// and the ordering, not the wait.
export type Timing = { backstopMs?: number; debounceMs?: number; quietMs?: number; graceMs?: number };

// Started when the config hook runs, because that is the instant the instance's
// snapshot is taken: the fingerprint captured here is what "current" means for
// everything this session has already loaded.
export function startRefresh(
  input: PluginInput,
  client?: PluginInput["client"],
  timing: Timing = {},
  entry?: { selfUrl: string; loadedHash: string | null },
): Refresh {
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
      // An engine update rides the same dispose: the rebuild re-invokes this
      // hook, and the check inside adopts the new build before anything runs.
      const engineStale = automatic && engineUpdateAvailable(home, entry?.selfUrl ?? "", entry?.loadedHash ?? null);
      if (!forced && current === snapshot && !engineStale) return;

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
            "policy, agent, skill and plugin changes stay invisible to the running session until it can",
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


