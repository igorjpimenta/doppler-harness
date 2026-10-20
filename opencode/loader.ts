// doppler → OpenCode plugin loader. Engine-owned: read in place, never copied.
//
// It exists because OpenCode builds its plugin list before any plugin runs, so
// the bridge cannot register one from its config hook — the only ways in are the
// config file's `plugin` array and the plugin directories, neither of which the
// personal root can occupy without a copy. So this is the registered entry: one
// line in the user's config, pointing here, and it discovers the personal root's
// plugins at load time. New and edited plugin files are live on the next reload
// with no re-install — the same "read in place" property everything else in the
// root has. (A reload rebuilds the instance and re-runs this loader; the
// per-file stamp below is what makes that re-run execute the edited file
// instead of the ESM cache's copy of it.)
//
// It ships no plugin of its own. What it loads is the user's, in filename order,
// and what it does about a broken one is carry on: a personal root that has one
// bad plugin is a session that should still work, not one that refuses to start.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { Plugin, PluginInput } from "@opencode-ai/plugin";

import { engineLoadedHash, stageEngineUpdate } from "./engine-update.ts";

// Where the personal root is, resolved the same way the bridge resolves it:
// DOPPLER_HOME first (tests and alternate installs), else the pointer the
// installer writes, else the default home. Per call — the module is imported
// before anything can set the environment.
function personalRoot() {
  if (process.env.DOPPLER_HOME) return process.env.DOPPLER_HOME;
  try {
    const m = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), ".doppler", "opencode.json"), "utf8"),
    );
    if (typeof m?.home === "string" && m.home) return m.home;
  } catch {
    // fall through to the default
  }
  return path.join(os.homedir(), ".doppler");
}

// The plugins directory, when it has anything in it. An absent or empty root is
// not a condition to report: a user who keeps no plugins has nothing to hear
// about, and the loader must be a no-op for them.
const PLUGIN_EXT = new Set([".js", ".mjs", ".ts"]);

function rootPlugins(home: string) {
  const dir = path.join(home, "plugins");
  let names: string[];
  try {
    names = fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
  return names
    // Hidden files are state (a manifest, an editor's swap file), not plugins.
    .filter((n) => !n.startsWith("."))
    .filter((n) => PLUGIN_EXT.has(path.extname(n)))
    // A plugin's tests are not a plugin. Only a __tests__ directory would be
    // filtered here, so this is defensive: a flat __tests__.js would be a test.
    .filter((n) => !n.startsWith("__tests__"));
}

// OpenCode's Hooks is callbacks plus three object-shaped entries (tool, auth,
// provider). Callbacks run in registration order; every one receives the same
// (input, output) pair OpenCode itself would hand it, because that is the only
// calling convention output mutation works under — threading only the first
// argument through the chain silently drops `output`, which is how
// tool.execute.before hooks lose their `args` and chat.message hooks lose
// their `parts` with no error anywhere. Objects merge with the later plugin
// winning per key. An unknown key is passed through untouched rather than
// dropped — this runs inside someone's session, and silently discarding a hook
// shape this version has never heard of is how a plugin "stops working" with
// no error.
const CALLBACK_HOOKS = new Set([
  "event",
  "tool.execute.before",
  "tool.execute.after",
  "chat.message",
  "chat.params",
  "chat.headers",
  "command.execute.before",
  "shell.env",
  "permission.ask",
  "permission.replied",
  "experimental.chat.messages.transform",
  "experimental.chat.system.transform",
  "experimental.session.compacting",
  "experimental.compaction.autocontinue",
  "experimental.text.complete",
]);
const OBJECT_HOOKS = new Set(["tool", "auth", "provider"]);

// OpenCode accepts two module shapes, and a real plugin directory contains both:
// a bare plugin function (`export const P = async () => ({...})`, the shape the
// docs lead with) and a PluginModule object (`export default { id, server }`,
// which is what the SDK's PluginModule type is and what every plugin written
// against the current SDK exports). Only handling the first one loads a
// directory of working plugins as "exports no plugin function".
function asPlugin(value: unknown): Plugin | null {
  if (typeof value === "function") return value as Plugin;
  if (value && typeof value === "object" && typeof (value as { server?: unknown }).server === "function")
    return (value as { server: Plugin }).server;
  return null;
}

// Named exports, or a default that wins over the named one of the same name so
// `export default` is unambiguous.
function pluginFns(mod: Record<string, unknown>): Array<[string, Plugin]> {
  const out: Array<[string, Plugin]> = [];
  const dflt = asPlugin(mod.default);
  if (dflt) out.push(["default", dflt]);
  for (const [name, value] of Object.entries(mod)) {
    if (name === "default") continue;
    const fn = asPlugin(value);
    if (fn) out.push([name, fn]);
  }
  return out;
}

// What the last load saw, so a reload only re-imports what changed. A plugin
// module is imported once and cached for the life of the process — without a
// cache-busting key, an instance rebuild after `doppler reload` would re-run
// this loader against the same stale modules and the edit would stay invisible
// until a restart. The report already written for `doppler plugin status`
// carries the stamps, so the comparison needs no new state file.
type PluginReport = {
  home: string;
  plugins: Array<{ name: string; file?: string; ok: boolean; error?: string; stamp?: string }>;
  at: string;
};

// Keyed by filename, not entry name: one file can register several entries
// (`label` for its default export, `label:name` for named ones) and they share
// the file's stamp. Keying by entry name would re-import a named-export plugin
// on every load — correct output, but the module state the unchanged path is
// meant to preserve would never survive one.
function lastStamps(home: string): { known: Map<string, string>; hadReport: boolean } {
  try {
    const report = JSON.parse(fs.readFileSync(path.join(home, "plugins.loaded.json"), "utf8")) as PluginReport;
    const known = new Map<string, string>();
    for (const p of report.plugins ?? [])
      if (typeof p.stamp === "string" && typeof p.file === "string") known.set(p.file, p.stamp);
    return { known, hadReport: true };
  } catch {
    // No report yet: every file loads fresh, which is exactly what a first
    // load should do.
    return { known: new Map(), hadReport: false };
  }
}

// mtimeMs carries sub-millisecond precision on APFS; size rides along so a
// same-tick rewrite of identical length still reads as unchanged only when it
// really is byte-identical — which is precisely when re-importing is pointless.
function pluginStamp(full: string): string {
  try {
    const s = fs.statSync(full);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "absent";
  }
}

// The directory executed copies live in. Hidden and outside plugins/, so the
// loader's listing, the reload fingerprint and `doppler plugin status` never
// see it — only the filesystem watcher does, and a cache write matches nothing
// in the fingerprint so the tick it causes is a no-op.
function cacheDir(home: string): string {
  return path.join(home, ".loader-cache");
}

// A filesystem path is the one cache key every runtime honors. A `?v=` query
// busts Node's ESM cache and silently serves the stale module under Bun —
// which is what OpenCode's plugin runtime is — so the copy under a
// content-derived name is what makes a reload execute the edited file. The
// query was tried first (it passes the unit tests, which run under Node) and
// failed the live proof: the rebuilt instance re-ran the old code.
//
// Personal plugins are self-contained by construction — node builtins plus
// their own file — so executing a copy is executing the plugin. A plugin with
// relative imports would resolve them against the cache directory instead;
// none exists.
function cachedCopy(home: string, dir: string, file: string, label: string, stamp: string): string | null {
  const safe = `${label}-${stamp.replace(/[^a-zA-Z0-9]+/g, "_")}${path.extname(file)}`;
  const dest = path.join(cacheDir(home), safe);
  try {
    fs.mkdirSync(cacheDir(home), { recursive: true });
    fs.copyFileSync(path.join(dir, file), dest);
    // Read-back before import: the copy is imported milliseconds after it is
    // written, and a runtime that resolves the URL through a stale stat cache
    // reports the just-written file as missing. Reading it through the same
    // filesystem first is the barrier. Observed once live: the copy existed on
    // disk and its own import failed with ENOENT.
    fs.readFileSync(dest);
    return safe;
  } catch {
    // A cache that cannot be written is not a reason to fail the session.
    // Returning null falls back to the canonical URL below.
    return null;
  }
}

function pruneCache(home: string, keep: Set<string>): void {
  let names: string[];
  try {
    names = fs.readdirSync(cacheDir(home));
  } catch {
    return;
  }
  for (const n of names) {
    if (keep.has(n)) continue;
    try {
      fs.unlinkSync(path.join(cacheDir(home), n));
    } catch {
      // Already gone.
    }
  }
}

// Unchanged since the last load imports the canonical URL — the ESM cache hit,
// which keeps the module's state (in-flight moves, dedupe maps) alive across
// reloads that had nothing to do with it. Changed imports the executed copy,
// so the rebuilt instance runs the edited file. A first load with no report
// imports everything canonical: a fresh process has an empty module cache, so
// the copy would buy nothing and the stack traces stay pointed at the real
// files. Returns the cache filename when one was used, so the caller can prune
// around it.
function importTarget(
  home: string,
  dir: string,
  file: string,
  stamp: string,
  known: Map<string, string>,
  hadReport: boolean,
): { url: string; cached: string | null } {
  const full = path.join(dir, file);
  const label = `${file.replace(/\.[cm]?[jt]s$/, "")}`;
  if (hadReport && known.get(file) !== stamp) {
    const cached = cachedCopy(home, dir, file, label, stamp);
    if (cached) return { url: pathToFileURL(path.join(cacheDir(home), cached)).href, cached };
  }
  return { url: pathToFileURL(full).href, cached: null };
}


// The build this entry is executing, and the directory it was loaded from.
// Both are per-entry: the mechanism compares them against the package on disk
// and stages a copy when they differ.
const ENGINE_SELF_URL = import.meta.url;
const ENGINE_LOADED_HASH: string | null = engineLoadedHash(ENGINE_SELF_URL);

export const DopplerPluginLoader: Plugin = async (input: PluginInput) => {
  const home = personalRoot();
  // Self-update before anything else: if the package on disk is newer than this
  // module, execute the copy instead. A copy that fails to import falls back to
  // this one, so a broken build cannot take down the session it was meant to
  // refresh.
  const fresh = stageEngineUpdate(home, ENGINE_SELF_URL, "loader.js", ENGINE_LOADED_HASH);
  if (fresh) {
    try {
      const mod = (await import(fresh)) as unknown as { DopplerPluginLoader: Plugin };
      return mod.DopplerPluginLoader(input);
    } catch (err) {
      try {
        await input.client?.app?.log?.({
          body: {
            service: "doppler-plugin-loader",
            level: "warn",
            message: `engine update available but the new build failed to load (${String((err as Error)?.message ?? err)}); staying on the running build`,
          },
        });
      } catch {
        // logging is not the job
      }
    }
  }
  const dir = path.join(home, "plugins");
  const files = rootPlugins(home);
  const { known, hadReport } = lastStamps(home);
  const loaded: Array<{ name: string; file: string; ok: boolean; error?: string; stamp?: string }> = [];
  const keep = new Set<string>();

  const hooks: Record<string, unknown> = {};
  const chains = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>();

  const register = (name: string, h: Record<string, unknown> | undefined) => {
    if (!h || typeof h !== "object") return;
    for (const [key, value] of Object.entries(h)) {
      if (OBJECT_HOOKS.has(key)) {
        const target = (hooks[key] ??= {}) as Record<string, unknown>;
        Object.assign(target, value as Record<string, unknown>);
        continue;
      }
      if (typeof value !== "function") continue;
      if (CALLBACK_HOOKS.has(key)) {
        const chain = chains.get(key) ?? [];
        chain.push(value as (...args: unknown[]) => Promise<unknown>);
        chains.set(key, chain);
        continue;
      }
      // Unknown shape: keep it if nothing is there yet, and never overwrite a
      // known chain with an unknown value.
      if (hooks[key] === undefined) hooks[key] = value;
    }
  };

  for (const file of files) {
    const full = path.join(dir, file);
    const label = `${file.replace(/\.[cm]?[jt]s$/, "")}`;
    // Stamped before the import so the report describes the file that was
    // actually executed even if an edit lands mid-load.
    const stamp = pluginStamp(full);
    try {
      const target = importTarget(home, dir, file, stamp, known, hadReport);
      if (target.cached) keep.add(target.cached);
      let mod: Record<string, unknown>;
      try {
        mod = (await import(target.url)) as Record<string, unknown>;
      } catch (first) {
        if (!target.cached) throw first;
        // The copy exists on disk but the runtime could not see it — observed
        // once live as an ENOENT for a file that was provably there. One retry
        // through a fresh copy before giving up on the file.
        const retry = importTarget(home, dir, file, `${stamp}#retry`, known, hadReport);
        if (retry.cached) keep.add(retry.cached);
        mod = (await import(retry.url)) as Record<string, unknown>;
      }
      const fns = pluginFns(mod);
      if (!fns.length) {
        loaded.push({ name: label, file, ok: false, error: "exports no plugin function", stamp });
        continue;
      }
      for (const [name, fn] of fns) {
        const result = await fn(input);
        register(name === "default" ? label : `${label}:${name}`, result as Record<string, unknown>);
        loaded.push({ name: name === "default" ? label : `${label}:${name}`, file, ok: true, stamp });
      }
    } catch (err) {
      loaded.push({ name: label, file, ok: false, error: String((err as Error)?.message ?? err), stamp });
    }
  }

  // Copies left behind by earlier edits are pruned once every load has landed:
  // the set names exactly the files this load executed, so a crash between the
  // copy and the report cannot orphan a copy into the next load's decision.
  pruneCache(home, keep);

  // Chain the callbacks after every plugin has registered, so ordering is the
  // filename order rather than the interleaving of import timing. Every hook in
  // the chain receives the same arguments OpenCode passed this wrapper —
  // OpenCode fans its own plugin hooks out as fn(input, output) and reads the
  // mutation back off the shared output object, so a chain that threaded only
  // the first argument would silently drop every output mutation.
  for (const [key, chain] of chains) {
    hooks[key] = async (...args: unknown[]) => {
      for (const fn of chain) {
        await fn(...args);
      }
    };
  }

  // What actually loaded, written where `doppler plugin status` can read it.
  // A plugin that loads and silently does nothing is the failure this whole
  // mechanism exists to make visible, and a config file cannot answer it.
  const report = { home, plugins: loaded, at: new Date().toISOString() };
  try {
    fs.writeFileSync(path.join(home, "plugins.loaded.json"), `${JSON.stringify(report, null, 2)}\n`);
  } catch {
    // An unwritable root is not a reason to fail the session.
  }

  try {
    for (const p of loaded) {
      if (p.ok) input.client?.app?.log?.({
        body: { service: "doppler-plugin-loader", level: "debug", message: `loaded ${p.name}` },
      });
      else
        input.client?.app?.log?.({
          body: { service: "doppler-plugin-loader", level: "warn", message: `skipped ${p.name}: ${p.error}` },
        });
    }
  } catch {
    // logging is not the job
  }

  return hooks as never;
};

export default DopplerPluginLoader;