// doppler → OpenCode plugin loader. Engine-owned: read in place, never copied.
//
// It exists because OpenCode builds its plugin list before any plugin runs, so
// the bridge cannot register one from its config hook — the only ways in are the
// config file's `plugin` array and the plugin directories, neither of which the
// personal root can occupy without a copy. So this is the registered entry: one
// line in the user's config, pointing here, and it discovers the personal root's
// plugins at load time. New plugin files are live on the next restart with no
// re-install — the same "read in place" property everything else in the root has.
//
// It ships no plugin of its own. What it loads is the user's, in filename order,
// and what it does about a broken one is carry on: a personal root that has one
// bad plugin is a session that should still work, not one that refuses to start.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { Plugin, PluginInput } from "@opencode-ai/plugin";

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
// provider). Callbacks chain in registration order so an earlier plugin's
// mutation is visible to the next; objects merge with the later plugin winning
// per key. An unknown key is passed through untouched rather than dropped —
// this runs inside someone's session, and silently discarding a hook shape
// this version has never heard of is how a plugin "stops working" with no error.
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

// A plugin module is a function, or named function exports (docs: "exports one
// or more plugin functions"). Both are called with the same input; a PluginModule
// default export wins over a named one of the same name so `export default` is
// unambiguous.
function pluginFns(mod: Record<string, unknown>): Array<[string, Plugin]> {
  const out: Array<[string, Plugin]> = [];
  const seen = new Set<string>();
  if (typeof mod.default === "function") {
    out.push(["default", mod.default as Plugin]);
    seen.add("default");
  }
  for (const [name, value] of Object.entries(mod)) {
    if (name === "default" || typeof value !== "function") continue;
    out.push([name, value as Plugin]);
  }
  return out;
}

export const DopplerPluginLoader: Plugin = async (input: PluginInput) => {
  const home = personalRoot();
  const dir = path.join(home, "plugins");
  const files = rootPlugins(home);
  const loaded: Array<{ name: string; ok: boolean; error?: string }> = [];

  const hooks: Record<string, unknown> = {};
  const chains = new Map<string, Array<(arg: unknown) => Promise<unknown>>>();

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
        chain.push(value as (arg: unknown) => Promise<unknown>);
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
    try {
      const mod = (await import(pathToFileURL(full).href)) as Record<string, unknown>;
      const fns = pluginFns(mod);
      if (!fns.length) {
        loaded.push({ name: label, ok: false, error: "exports no plugin function" });
        continue;
      }
      for (const [name, fn] of fns) {
        const result = await fn(input);
        register(name === "default" ? label : `${label}:${name}`, result as Record<string, unknown>);
        loaded.push({ name: name === "default" ? label : `${label}:${name}`, ok: true });
      }
    } catch (err) {
      loaded.push({ name: label, ok: false, error: String((err as Error)?.message ?? err) });
    }
  }

  // Chain the callbacks after every plugin has registered, so ordering is the
  // filename order rather than the interleaving of import timing.
  for (const [key, chain] of chains) {
    hooks[key] = async (...args: unknown[]) => {
      let out = args[0];
      // Each hook receives what the previous one returned, the way OpenCode
      // threads its own hooks: the mutation target is the first argument and
      // its return value is what the next plugin sees.
      for (const fn of chain) {
        const next = await fn(out);
        if (next !== undefined) out = next;
      }
      return out;
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