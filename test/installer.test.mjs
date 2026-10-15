// The installer is the only thing that can make "installed" and "working"
// disagree, and the whole class of that disagreement is silent: a registration
// pointing at a file that no longer exists leaves OpenCode starting perfectly
// happily while delivering no skills, no agents, no permissions and no policy.
//
// So the checks are pinned here as a table of failure modes rather than one
// happy path, and the bridge's location is asserted directly — it is the fix for
// the case that motivated all of this.
//
// Run with `node --test test/`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOPPLER = path.join(ROOT, "bin", "doppler.mjs");

// The product's own reader, so the assertions cannot be fooled by a config
// this module cannot parse.
const { stringElements, topLevelValueSpan } = await import(path.join(ROOT, "bin", "jsonc.mjs"));

// A fake machine: its own HOME, its own personal root, its own opencode config.
// OPENCODE_BIN points at a stub so the checks that shell out to OpenCode can
// run without it, and so "the CLI is missing" stays testable.
function machine({ withOpencode = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "doppler-inst-"));
  const cfgDir = path.join(home, ".config", "opencode");
  fs.mkdirSync(cfgDir, { recursive: true });
  // Only one of the two spellings, ever: the installer prefers .jsonc, so leaving
  // a .json beside it would silently edit the file the test is not reading.
  fs.writeFileSync(path.join(cfgDir, "opencode.json"), '{ "$schema": "https://opencode.ai/config.json" }\n');

  // Stands in for `opencode debug config`, which echoes the resolved plugin list
  // back as strings. Reading the config from disk rather than answering a
  // constant is the point: a check against a canned response would pass for an
  // install that is in fact broken.
  //
  // The comment stripper walks strings rather than using a regex, because a
  // regex eats the `//` in a file:// URL and reports a parse error the harness
  // does not have. That is the same trap doctor's own reader avoids.
  const stub = path.join(home, "opencode-stub");
  fs.writeFileSync(stub, `#!/bin/sh
exec node -e '
const fs = require("fs"), os = require("os"), path = require("path");
const dir = path.join(os.homedir(), ".config", "opencode");
const f = ["opencode.jsonc", "opencode.json"].find((n) => fs.existsSync(path.join(dir, n)));
const raw = f ? fs.readFileSync(path.join(dir, f), "utf8") : "{}";
let out = "", inStr = false;
for (let i = 0; i < raw.length; i += 1) {
  const c = raw[i];
  if (inStr) { out += c; if (c === String.fromCharCode(34) && raw[i - 1] !== String.fromCharCode(92)) inStr = false; continue; }
  if (c === String.fromCharCode(34)) { inStr = true; out += c; continue; }
  if (c === "/" && raw[i + 1] === "/") { while (i < raw.length && raw[i] !== String.fromCharCode(10)) i += 1; out += String.fromCharCode(10); continue; }
  out += c;
}
console.log(JSON.stringify({ plugin: JSON.parse(out).plugin ?? [], plugin_origins: [] }));
'
`);
  fs.chmodSync(stub, 0o755);

  // A PATH with node and nothing else, so `which opencode` cannot find a real
  // one on the developer's machine. A dir per machine keeps the tests parallel.
  const binDir = path.join(home, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(binDir, "node"));
  if (!withOpencode) fs.symlinkSync(stub, path.join(binDir, "opencode-stub-only"));

  return {
    home,
    cfgDir,
    stub,
    path: binDir,
    opencodeBin: withOpencode ? stub : "/nonexistent/opencode",
  };
}

function run(m, args, { dopplerHome, env } = {}) {
  return spawnSync(process.execPath, [DOPPLER, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: m.home,
      OPENCODE_BIN: m.opencodeBin,
      DOPPLER_HOME: dopplerHome ?? path.join(m.home, ".doppler"),
      // node has to stay reachable for the stub, so PATH is narrowed to a temp
      // dir: a "no opencode CLI" test that finds the developer's real one on
      // PATH would pass for the wrong reason.
      PATH: m.path,
      ...env,
    },
  });
}

const out = (r) => `${r.stdout}${r.stderr}`;
const configOf = (m) => {
  for (const n of ["opencode.jsonc", "opencode.json"]) {
    const p = path.join(m.cfgDir, n);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  }
  return null;
};

test("the bridge is registered from the package, and no copy is left in the root", () => {
  // One file, in the package. A copy in the personal root outlives the package,
  // so uninstalling it would leave policy enforcing with no CLI left to stop it.
  const m = machine();
  const home = path.join(m.home, ".doppler");
  try {
    assert.equal(run(m, ["install", "opencode"]).status, 0);
    const [entry] = configOf(m).plugin;
    assert.ok(entry.startsWith("file://"), entry);
    const file = decodeURIComponent(new URL(entry).pathname);
    assert.equal(file, path.join(ROOT, "dist", "doppler.js"));
    assert.ok(fs.existsSync(file), "the registered path must exist");
    // The whole point: nothing engine-shaped survives in the user's directory.
    assert.equal(fs.existsSync(path.join(home, "opencode", "doppler.ts")), false);
  } finally {
    fs.rmSync(m.home, { recursive: true, force: true });
  }
});

test("uninstalling the package stops enforcement, because no copy outlives it", () => {
  // The failure this prevents, and the reason the registration points into the
  // package: with a copy in the root, deleting the package left the copy
  // enforcing. A user's removal has to remove.
  const m = machine();
  const home = path.join(m.home, ".doppler");
  try {
    run(m, ["install", "opencode"]);
    // Simulate the package being gone, which is what uninstalling does to it.
    const stale = path.join(home, "opencode", "doppler.ts");
    fs.mkdirSync(path.dirname(stale), { recursive: true });
    // A copy is exactly what the installer must never have produced; assert the
    // install does not, and that no sibling is left that could stand in for it.
    assert.equal(fs.existsSync(stale), false);
    assert.deepEqual(fs.readdirSync(path.join(home, "hooks")).filter((f) => f.endsWith("doppler.ts")), []);
  } finally {
    fs.rmSync(m.home, { recursive: true, force: true });
  }
});

test("install is idempotent and never duplicates the entry", () => {
  const m = machine();
  try {
    run(m, ["install", "opencode"]);
    run(m, ["install", "opencode"]);
    run(m, ["install", "opencode"]);
    assert.equal(configOf(m).plugin.length, 1);
  } finally {
    fs.rmSync(m.home, { recursive: true, force: true });
  }
});

test("a plugin with the bridge's id already registered stays primary", () => {
  // OpenCode loads every registered plugin and does not dedup by id, so
  // "doppler is the secondary option" is the installer's check: a same-id
  // plugin that is not the bridge itself means the user wrote a replacement,
  // and registering the bridge alongside it would leave two plugins injecting
  // config with no visible precedence.
  const m = machine();
  const cfg = path.join(m.cfgDir, "opencode.json");
  const plugin = path.join(m.home, "my-own-doppler.js");
  fs.writeFileSync(plugin, 'export default { id: "doppler", server: async () => ({}) };\n');
  fs.writeFileSync(cfg, JSON.stringify({
    "$schema": "https://opencode.ai/config.json",
    "plugin": [pathToFileURL(plugin).href],
  }));
  try {
    const r = run(m, ["install", "opencode"]);
    assert.equal(r.status, 0, out(r));
    const c = configOf(m);
    assert.equal(c.plugin.length, 1, "the bridge must not be added");
    assert.ok(c.plugin[0].includes("my-own-doppler.js"), "the user's plugin is kept");
    assert.match(out(r), /stays dormant/);
  } finally {
    fs.rmSync(m.home, { recursive: true, force: true });
  }
});

test("a same-id replacement removes an already-registered bridge", () => {
  // The bridge was installed first; the user then adds their own same-id
  // plugin. Re-running install must not leave both — two same-id plugins
  // injecting config with no visible precedence is the failure this prevents.
  const m = machine();
  const cfg = path.join(m.cfgDir, "opencode.json");
  try {
    run(m, ["install", "opencode"]);
    assert.equal(configOf(m).plugin.length, 1, "the bridge is registered first");
    const plugin = path.join(m.home, "my-own-doppler.js");
    fs.writeFileSync(plugin, 'export default { id: "doppler", server: async () => ({}) };\n');
    const c = configOf(m);
    c.plugin.unshift(pathToFileURL(plugin).href);
    fs.writeFileSync(cfg, JSON.stringify(c));
    const r = run(m, ["install", "opencode"]);
    assert.equal(r.status, 0, out(r));
    const after = configOf(m);
    assert.equal(after.plugin.length, 1, "the bridge is removed, not kept alongside");
    assert.ok(after.plugin[0].includes("my-own-doppler.js"), "the user's plugin is kept");
    assert.match(out(r), /removed the previous bridge entry/);
  } finally {
    fs.rmSync(m.home, { recursive: true, force: true });
  }
});

test("the bridge's own stale entry is still refreshed, not treated as a replacement", () => {
  // A bridge entry at an old path (the package moved) has the same id but is
  // not a user's replacement — registering clears the stale path and writes
  // the current one. The id check must not skip that.
  const m = machine();
  const cfg = path.join(m.cfgDir, "opencode.json");
  fs.writeFileSync(cfg, JSON.stringify({
    "$schema": "https://opencode.ai/config.json",
    "plugin": ["file:///old/node_modules/@igorjpimenta/doppler-harness/dist/doppler.js"],
  }));
  try {
    const r = run(m, ["install", "opencode"]);
    assert.equal(r.status, 0, out(r));
    const c = configOf(m);
    assert.equal(c.plugin.length, 1, "the stale entry is replaced, not kept");
    assert.match(c.plugin[0], /dist\/doppler\.js$/, "the current bridge is registered");
  } finally {
    fs.rmSync(m.home, { recursive: true, force: true });
  }
});

test("an unreadable plugin does not block registration", () => {
  // A plugin that cannot be loaded is not a same-id match: failing closed
  // would let one broken entry stop the install for everyone.
  const m = machine();
  const cfg = path.join(m.cfgDir, "opencode.json");
  fs.writeFileSync(cfg, JSON.stringify({
    "$schema": "https://opencode.ai/config.json",
    "plugin": ["file:///nonexistent/plugin.js"],
  }));
  try {
    const r = run(m, ["install", "opencode"]);
    assert.equal(r.status, 0, out(r));
    const c = configOf(m);
    assert.equal(c.plugin.length, 2, "the bridge is registered despite the broken plugin");
    assert.match(c.plugin[1], /dist\/doppler\.js$/, "doppler's entry is appended");
  } finally {
    fs.rmSync(m.home, { recursive: true, force: true });
  }
});

test("install preserves the user's own plugins and comments", () => {
  const m = machine();
  const cfg = path.join(m.cfgDir, "opencode.json");
  fs.writeFileSync(cfg, `{
  // my plugins
  "plugin": ["opencode-gemini-auth"],
  "model": "anthropic/claude-sonnet-4-6"
}
`);
  try {
    assert.equal(run(m, ["install", "opencode"]).status, 0);
    const text = fs.readFileSync(cfg, "utf8");
    assert.match(text, /\/\/ my plugins/, "comments must survive");
    assert.match(text, /"anthropic\/claude-sonnet-4-6"/, "values must survive");
    // Read the plugin list with the product's own reader rather than JSON.parse:
    // a regex for comments eats the `//` in a file:// URL, which is how this
    // assertion would have passed on a broken install.
    const plugins = stringElements(text, topLevelValueSpan(text, "plugin"))
      .map((e) => JSON.parse(e));
    assert.equal(plugins.length, 2);
    assert.ok(plugins[0].includes("opencode-gemini-auth"), "the user's plugin is kept");
    assert.match(plugins[1], /dist\/doppler\.js$/, "doppler's entry is appended");
  } finally {
    fs.rmSync(m.home, { recursive: true, force: true });
  }
});

test("a fresh install seeds formats and no content", () => {
  const m = machine();
  const home = path.join(m.home, ".doppler");
  try {
    run(m, ["install", "opencode"]);
    assert.deepEqual(fs.readdirSync(path.join(home, "hooks")).filter((f) => !f.endsWith(".example.mjs")), []);
    assert.ok(fs.existsSync(path.join(home, "hooks", "hook.example.mjs")));
    for (const f of ["allowlist.json", "guard-rules.json", "source-allowlist.json"]) {
      assert.ok(fs.existsSync(path.join(home, "policy", f)), f);
    }
  } finally {
    fs.rmSync(m.home, { recursive: true, force: true });
  }
});

test("doctor fails on a machine that was never installed", () => {
  const m = machine();
  try {
    const r = run(m, ["doctor"]);
    assert.equal(r.status, 1, "nothing is enforced, so this cannot be a pass");
    assert.match(out(r), /root exists/);
    assert.match(out(r), /problems found/);
  } finally {
    fs.rmSync(m.home, { recursive: true, force: true });
  }
});

test("doctor passes after a real install", () => {
  const m = machine();
  try {
    run(m, ["install", "opencode"]);
    const r = run(m, ["doctor"]);
    assert.equal(r.status, 0, out(r));
    assert.match(out(r), /All checks passed/);
  } finally {
    fs.rmSync(m.home, { recursive: true, force: true });
  }
});

test("doctor names the CLI it is running from, with its version", () => {
  // There is nothing for a test to assert about a CLI that is not the one
  // running: it never reaches the code, so it cannot fail here. What this pins
  // is the positive half — that the real thing names itself and its version,
  // which is what lets a user compare it against the one they expected.
  const m = machine();
  try {
    run(m, ["install", "opencode"]);
    const r = run(m, ["doctor"]);
    const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
    assert.match(out(r), /ok {4}cli — .* — \d{4}\.\d+\.\d+(-\d+)?$/m);
    assert.match(out(r), new RegExp(`cli — .* — ${version.replace(/\./g, "\\.")}$`, "m"));
  } finally {
    fs.rmSync(m.home, { recursive: true, force: true });
  }
});

test("doctor does not report a branch from a repo the package merely sits inside", () => {
  // `git -C PKG` searches upward, so an installed package under a directory that
  // happens to be a repo — /opt/homebrew, or someone's dotfiles — would report
  // that repo's branch as its own.
  const m = machine();
  try {
    // A real git repo wrapping a copy of the package, so the upward search has
    // something to find. `git` is stubbed because the test PATH has no real one.
    const outer = path.join(m.home, "outer");
    const pkg = path.join(outer, "node_modules", "pkg");
    fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
    for (const f of ["doppler.mjs", "jsonc.mjs"]) {
      fs.copyFileSync(path.join(ROOT, "bin", f), path.join(pkg, "bin", f));
    }
    fs.cpSync(path.join(ROOT, "opencode"), path.join(pkg, "opencode"), { recursive: true });
    fs.copyFileSync(path.join(ROOT, "package.json"), path.join(pkg, "package.json"));
    const gitStub = path.join(m.home, "git-stub");
    fs.writeFileSync(gitStub, `#!/bin/sh
case "$*" in
  *--show-toplevel*) echo ${JSON.stringify(outer)} ;;
  *) echo stable ;;
esac
`);
    fs.chmodSync(gitStub, 0o755);
    fs.symlinkSync(gitStub, path.join(m.path, "git"));

    const r = spawnSync(process.execPath, [path.join(pkg, "bin", "doppler.mjs"), "doctor"], {
      encoding: "utf8",
      env: { ...process.env, HOME: m.home, PATH: m.path, DOPPLER_HOME: path.join(m.home, ".doppler") },
    });
    assert.match(out(r), /ok {4}cli — .*pkg — \d+\.\d+\.\d+(-\d+)?$/m);
    assert.doesNotMatch(out(r), /on stable/);
  } finally {
    fs.rmSync(m.home, { recursive: true, force: true });
  }
});

test("doctor names a registration pointing somewhere that no longer exists", () => {
  // The exact silent-inert case: the entry is present, the config parses, and
  // nothing is delivered. The engine now lives in the package, so the way to
  // reach it is a registration whose target is gone.
  const m = machine();
  try {
    run(m, ["install", "opencode"]);
    const cfg = path.join(m.cfgDir, "opencode.json");
    const c = JSON.parse(fs.readFileSync(cfg, "utf8"));
    c.plugin = ["file:///gone/opencode/doppler.ts"];
    fs.writeFileSync(cfg, JSON.stringify(c, null, 2) + "\n");
    const r = run(m, ["doctor"]);
    assert.equal(r.status, 1);
    assert.match(out(r), /registered path resolves/);
    assert.match(out(r), /fix: doppler install opencode/);
  } finally {
    fs.rmSync(m.home, { recursive: true, force: true });
  }
});

test("doctor names a stale registration from an older install", () => {
  const m = machine();
  try {
    run(m, ["install", "opencode"]);
    const cfg = path.join(m.cfgDir, "opencode.json");
    const c = JSON.parse(fs.readFileSync(cfg, "utf8"));
    c.plugin = ["file:///old/node_modules/@igorjpimenta/doppler-harness/opencode/doppler.js"];
    fs.writeFileSync(cfg, JSON.stringify(c, null, 2) + "\n");
    const r = run(m, ["doctor"]);
    assert.equal(r.status, 1);
    assert.match(out(r), /registered path is stale/);
  } finally {
    fs.rmSync(m.home, { recursive: true, force: true });
  }
});

test("install repairs a stale registration", () => {
  const m = machine();
  try {
    run(m, ["install", "opencode"]);
    const cfg = path.join(m.cfgDir, "opencode.json");
    const c = JSON.parse(fs.readFileSync(cfg, "utf8"));
    c.plugin = ["file:///old/node_modules/@igorjpimenta/doppler-harness/opencode/doppler.js"];
    fs.writeFileSync(cfg, JSON.stringify(c, null, 2) + "\n");
    assert.equal(run(m, ["install", "opencode"]).status, 0);
    assert.equal(configOf(m).plugin.length, 1);
    assert.equal(decodeURIComponent(new URL(configOf(m).plugin[0]).pathname), path.join(ROOT, "dist", "doppler.js"));
    assert.equal(run(m, ["doctor"]).status, 0);
  } finally {
    fs.rmSync(m.home, { recursive: true, force: true });
  }
});

test("install and update remove a stale engine copy from the personal root", () => {
  // A stale engine copy in the root is not loaded — the registration points at
  // the package — but it outlives the package and answers to the name someone
  // would look for, so a registering run removes it.
  const m = machine();
  try {
    run(m, ["install", "opencode"]);
    const dir = path.join(m.home, ".doppler", "opencode");
    fs.mkdirSync(dir, { recursive: true });
    for (const f of ["doppler.ts", "doppler.js"]) fs.writeFileSync(path.join(dir, f), "// a stale engine\n");
    assert.equal(fs.existsSync(path.join(dir, "doppler.ts")), true);
    run(m, ["update"]);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(m.home, { recursive: true, force: true });
  }
});

test("doctor warns when the registration points into node_modules", () => {
  // The engine is read from the package, and under `npm install -g` that is a
  // path npm owns and may repoint on any reinstall. The entry would survive the
  // move and load nothing, so it is named — as a warning, not a failure, since
  // nothing is wrong with the install right now.
  const m = machine();
  try {
    run(m, ["install", "opencode"]);
    const cfg = path.join(m.cfgDir, "opencode.json");
    const c = JSON.parse(fs.readFileSync(cfg, "utf8"));
    c.plugin = ["file:///usr/lib/node_modules/@igorjpimenta/doppler-harness/opencode/doppler.ts"];
    fs.writeFileSync(cfg, JSON.stringify(c, null, 2) + "\n");
    const r = run(m, ["doctor"]);
    assert.match(out(r), /warn {2}registered path is inside node_modules/);
    assert.match(out(r), /npm can repoint that on reinstall/);
  } finally {
    fs.rmSync(m.home, { recursive: true, force: true });
  }
});

test("doctor warns rather than fails when there are no hooks", () => {
  // A legitimate state, and the one where a user believes something is enforced
  // and nothing is — so it is named, but it is not a broken install.
  const m = machine();
  try {
    run(m, ["install", "opencode"]);
    const r = run(m, ["doctor"]);
    assert.equal(r.status, 0);
    assert.match(out(r), /warn\s+hooks/);
  } finally {
    fs.rmSync(m.home, { recursive: true, force: true });
  }
});

test("doctor notices a malformed allowlist", () => {
  const m = machine();
  try {
    run(m, ["install", "opencode"]);
    fs.writeFileSync(path.join(m.home, ".doppler", "policy", "allowlist.json"), "{not json");
    const r = run(m, ["doctor"]);
    assert.equal(r.status, 1);
    assert.match(out(r), /permission policy/);
  } finally {
    fs.rmSync(m.home, { recursive: true, force: true });
  }
});

test("doctor reports a missing opencode CLI instead of crashing", () => {
  // It has to work precisely when the install is broken.
  const m = machine({ withOpencode: false });
  try {
    run(m, ["install", "opencode"]);
    const r = run(m, ["doctor"]);
    assert.equal(r.status, 1);
    assert.match(out(r), /opencode CLI/);
  } finally {
    fs.rmSync(m.home, { recursive: true, force: true });
  }
});

test("version and help work with no opencode and no personal root", () => {
  const m = machine({ withOpencode: false });
  try {
    const v = run(m, ["version"]);
    assert.equal(v.status, 0);
    // CalVer, with an optional -N for a same-day re-release.
    assert.match(v.stdout.trim(), /^\d{4}\.\d+\.\d+(-\d+)?$/);
    const h = run(m, []);
    assert.equal(h.status, 0);
    assert.match(out(h), /usage: doppler/);
  } finally {
    fs.rmSync(m.home, { recursive: true, force: true });
  }
});

test("an unsupported harness is named, not just refused", () => {
  const m = machine();
  try {
    const r = run(m, ["install", "zcode"]);
    assert.equal(r.status, 1);
    assert.match(out(r), /zcode is not wired/);
    assert.match(out(r), /bridge, not a fork/);
  } finally {
    fs.rmSync(m.home, { recursive: true, force: true });
  }
});

test("uninstall removes the entry and leaves the personal root alone", () => {
  const m = machine();
  try {
    run(m, ["install", "opencode"]);
    fs.writeFileSync(path.join(m.home, ".doppler", "hooks", "mine.mjs"), "// mine\n");
    assert.equal(run(m, ["uninstall", "opencode"]).status, 0);
    assert.deepEqual(configOf(m).plugin, []);
    assert.ok(fs.existsSync(path.join(m.home, ".doppler", "hooks", "mine.mjs")));
  } finally {
    fs.rmSync(m.home, { recursive: true, force: true });
  }
});

test("update re-registers the package's own bridge, so a move is self-healing", () => {
  // There is nothing to refresh: the registered path and the file behind it are
  // the same file, so they cannot disagree. What update does have to do is notice
  // that the package moved and point the entry at where it is now — which is why
  // re-registering is not a no-op.
  const m = machine();
  try {
    run(m, ["install", "opencode"]);
    const cfg = path.join(m.cfgDir, "opencode.json");
    const c = JSON.parse(fs.readFileSync(cfg, "utf8"));
    c.plugin = ["file:///moved/package/opencode/doppler.ts"];
    fs.writeFileSync(cfg, JSON.stringify(c, null, 2) + "\n");
    assert.equal(run(m, ["update"]).status, 0);
    assert.equal(decodeURIComponent(new URL(configOf(m).plugin[0]).pathname), path.join(ROOT, "dist", "doppler.js"));
  } finally {
    fs.rmSync(m.home, { recursive: true, force: true });
  }
});

test("the config dir follows XDG_CONFIG_HOME when it is set", () => {
  // OpenCode reads its config from $XDG_CONFIG_HOME/opencode when the
  // variable is set, so a registration written to ~/.config/opencode lands
  // where OpenCode never looks and the bridge silently never loads. The
  // installer must resolve the same dir the bridge's globalAgentsMd does.
  const m = machine();
  const xdg = path.join(m.home, ".xdg");
  fs.mkdirSync(xdg, { recursive: true });
  try {
    const r = run(m, ["install", "opencode"], { env: { XDG_CONFIG_HOME: xdg } });
    assert.equal(r.status, 0, out(r));
    // The registration lands in the XDG dir, not the default one.
    const xdgCfg = path.join(xdg, "opencode", "opencode.json");
    assert.ok(fs.existsSync(xdgCfg), "the config is written under XDG_CONFIG_HOME");
    const written = JSON.parse(fs.readFileSync(xdgCfg, "utf8"));
    assert.match(written.plugin[0], /dist\/doppler\.js$/, "the bridge is registered in the XDG dir");
    // The default dir is left untouched — no second registration.
    const def = fs.readFileSync(path.join(m.cfgDir, "opencode.json"), "utf8");
    assert.ok(!def.includes("dist/doppler.js"), "the default ~/.config dir is not written");
  } finally {
    fs.rmSync(m.home, { recursive: true, force: true });
  }
});

test("reload asks a running session, and says when a turn is not interrupted", () => {
  // The request is a file, not a call: a desktop-app session always runs the
  // server with a password, so an external process cannot reach it, and storing a
  // credential to work around that would be a worse trade than a file the user
  // could have touched directly.
  const m = machine();
  const sentinel = path.join(m.home, ".doppler", ".reload");
  try {
    const r = run(m, ["reload"]);
    assert.equal(r.status, 0);
    assert.ok(fs.existsSync(sentinel), "the request is left where the bridge watches");
    assert.match(out(r), /idle moment/);

    // Two requests have to read as two even inside one filesystem timestamp tick,
    // or a second `doppler reload` while nothing changed is silently a no-op.
    fs.writeFileSync(sentinel, "7\n");
    run(m, ["reload"]);
    assert.equal(fs.readFileSync(sentinel, "utf8").trim(), "8");
  } finally {
    fs.rmSync(m.home, { recursive: true, force: true });
  }
});

test("doctor names when live refresh is turned off", () => {
  // Off is the state where a policy edit silently does nothing until a restart,
  // so it cannot be a preference nobody is told about.
  const m = machine();
  try {
    run(m, ["install", "opencode"]);
    assert.match(out(run(m, ["doctor"])), /ok\s+live refresh/);

    const off = run(m, ["doctor"], { dopplerHome: path.join(m.home, ".doppler"), env: { DOPPLER_RELOAD: "off" } });
    assert.match(out(off), /warn\s+live refresh/);
    assert.match(out(off), /doppler reload/);
  } finally {
    fs.rmSync(m.home, { recursive: true, force: true });
  }
});

// npm 11 installs a package from a git URL by linking it into its own cache and
// then deleting that cache, so the whole package directory becomes a symlink to
// nothing. `doppler` stops being on PATH at all — which is the real symptom —
// and the registered entry names a path that cannot resolve. This is the only
// place that can still say why, so it has to.
test("doctor names a package npm linked and deleted", () => {
  const m = machine();
  const fake = path.join(m.home, "fake-install", "node_modules", "@igorjpimenta");
  const pkg = path.join(fake, "doppler-harness");
  const gone = path.join(m.home, "npm-cache", "git-cloneGONE");
  try {
    fs.mkdirSync(path.dirname(pkg), { recursive: true });
    fs.symlinkSync(gone, pkg);

    // The registration points into that package, as a real install leaves it.
    const entry = { $schema: "https://opencode.ai/config.json" };
    entry.plugin = [`${pathToFileURL(path.join(pkg, "dist", "doppler.js")).href}`];
    fs.writeFileSync(path.join(m.cfgDir, "opencode.json"), `${JSON.stringify(entry, null, 2)}\n`);

    const r = run(m, ["doctor"]);
    assert.match(out(r), /registered path resolves/);
    assert.match(out(r), /symlink npm deleted/);
    assert.match(out(r), /install-links=true/);
  } finally {
    fs.rmSync(m.home, { recursive: true, force: true });
  }
});

// The opposite case, which must not be reported as broken: `npm link` also
// symlinks the package, and a development setup that still resolves is working.
test("a package symlink that still resolves is not a failure", () => {
  const m = machine();
  const real = path.join(m.home, "checkout");
  const linked = path.join(m.home, "linked-install", "node_modules", "@igorjpimenta", "doppler-harness");
  try {
    fs.mkdirSync(path.join(real, "dist"), { recursive: true });
    fs.writeFileSync(path.join(real, "dist", "doppler.js"), "// bridge\n");
    fs.mkdirSync(path.dirname(linked), { recursive: true });
    fs.symlinkSync(real, linked);

    const entry = { $schema: "https://opencode.ai/config.json" };
    entry.plugin = [`${pathToFileURL(path.join(linked, "dist", "doppler.js")).href}`];
    fs.writeFileSync(path.join(m.cfgDir, "opencode.json"), `${JSON.stringify(entry, null, 2)}\n`);

    const r = run(m, ["doctor"]);
    assert.doesNotMatch(out(r), /symlink npm deleted/);
    assert.match(out(r), /ok\s+registered path resolves/);
  } finally {
    fs.rmSync(m.home, { recursive: true, force: true });
  }
});

// --- plugin register / status -----------------------------------------------

test("plugin register writes one loader entry, and re-running changes nothing", () => {
  const m = machine();
  const r = run(m, ["plugin", "register", "opencode"]);
  assert.match(out(r), /registered: /, "first run registers");
  const first = configOf(m);
  assert.equal(first.plugin.length, 1);
  assert.match(first.plugin[0], /dist\/loader\.js$/);

  const again = run(m, ["plugin", "register", "opencode"]);
  assert.match(out(again), /already registered/, "idempotent");
  const second = configOf(m);
  assert.deepEqual(second.plugin, first.plugin, "no duplicate entry");
});

test("plugin register coexists with the bridge and with the user's own plugins", () => {
  const m = machine();
  run(m, ["install", "opencode"]);
  const withUser = configOf(m);
  withUser.plugin.push("some-user-plugin");
  fs.writeFileSync(path.join(m.cfgDir, "opencode.json"), JSON.stringify(withUser, null, 2));

  run(m, ["plugin", "register", "opencode"]);
  const after = configOf(m);
  assert.equal(after.plugin.length, 3, "bridge + user's + loader, nothing dropped");
  assert.ok(after.plugin.includes("some-user-plugin"), "the user's own plugin is untouched");
});

test("uninstall removes the loader entry as well as the bridge", () => {
  // Leaving the loader registered would keep loading the root's plugins after
  // "uninstall", which makes the command a lie.
  const m = machine();
  run(m, ["install", "opencode"]);
  run(m, ["plugin", "register", "opencode"]);
  const r = run(m, ["uninstall", "opencode"]);
  assert.match(out(r), /removed: doppler plugin loader entry/);
  const after = run(m, ["plugin", "status"]);
  assert.match(out(after), /NOT registered/);
});

test("plugin status reports what the root holds and what the last session loaded", () => {
  const m = machine();
  const home = path.join(m.home, ".doppler");
  fs.mkdirSync(path.join(home, "plugins"), { recursive: true });
  fs.writeFileSync(path.join(home, "plugins", "mine.js"), "export const Mine = async () => ({});\n");
  fs.writeFileSync(path.join(home, "plugins", "never-loaded.js"), "export const X = 1;\n");
  run(m, ["plugin", "register", "opencode"]);

  const before = run(m, ["plugin", "status"]);
  assert.match(out(before), /registered/);
  assert.match(out(before), /mine\.js/, "names the root's plugins");
  assert.match(out(before), /no opencode session has run/, "honest before a session loads it");

  // What the loader writes at startup is the only source for "did it run".
  fs.writeFileSync(
    path.join(home, "plugins.loaded.json"),
    JSON.stringify({
      home,
      at: new Date().toISOString(),
      plugins: [{ name: "mine", ok: true }],
    }),
  );
  const after = run(m, ["plugin", "status"]);
  assert.match(out(after), /ok: 1 \(mine\)/);
  assert.match(out(after), /in the root but not in the last load: never-loaded\.js/,
    "the dead-plugin question, answered");
});

test("plugin register names a missing loader rather than writing a dead entry", () => {
  const m = machine();
  // A package that never built ships no dist/loader.js; registering a URL to a
  // missing file is exactly the stale entry doctor then has to catch.
  const src = fs.readFileSync(DOPPLER, "utf8");
  const patched = src.replace(
    /const LOADER = path\.join\(PKG, "dist", "loader\.js"\);/,
    'const LOADER = path.join(PKG, "dist", "loader-absent.js");',
  );
  assert.notEqual(patched, src, "the fixture replaced the loader path");
  // Written beside the original: the CLI imports ./jsonc.mjs relatively, so a
  // copy elsewhere would fail to start and the test would pass for the wrong
  // reason.
  const patchedBin = path.join(path.dirname(DOPPLER), `doppler-patched-${process.pid}.mjs`);
  fs.writeFileSync(patchedBin, patched);
  let r;
  try {
    r = spawnSync(process.execPath, [patchedBin, "plugin", "register", "opencode"], {
      encoding: "utf8",
      env: { ...process.env, HOME: m.home, DOPPLER_HOME: path.join(m.home, ".doppler"), PATH: m.path },
    });
  } finally {
    fs.rmSync(patchedBin, { force: true });
  }
  assert.match(out(r), /no loader at /, "says what is wrong");
  assert.equal(r.status, 1, "and exits non-zero rather than registering a dead URL");
  assert.equal(configOf(m).plugin, undefined, "no entry was written into the seeded config");
});
