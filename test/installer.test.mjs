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
import { fileURLToPath } from "node:url";

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

function run(m, args, { dopplerHome } = {}) {
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

test("the bridge is registered from the personal root, never from node_modules", () => {
  // The failure this prevents: under `npm install -g` the package lives in a
  // node_modules path npm owns and may repoint, and a config entry pointing
  // there survives the move and silently loads nothing.
  const m = machine();
  const home = path.join(m.home, ".doppler");
  try {
    assert.equal(run(m, ["install", "opencode"]).status, 0);
    const [entry] = configOf(m).plugin;
    assert.ok(entry.startsWith("file://"), entry);
    const file = decodeURIComponent(new URL(entry).pathname);
    assert.equal(file, path.join(home, "opencode", "doppler.ts"));
    assert.ok(fs.existsSync(file), "the registered path must exist");
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
    assert.match(plugins[1], /doppler\.ts$/, "doppler's entry is appended");
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

test("doctor names a registration pointing somewhere that no longer exists", () => {
  // The exact silent-inert case: the entry is present, the config parses, and
  // nothing is delivered.
  const m = machine();
  try {
    run(m, ["install", "opencode"]);
    fs.rmSync(path.join(m.home, ".doppler", "opencode", "doppler.ts"));
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
    assert.match(configOf(m).plugin[0], /\.doppler\/opencode\/doppler\.ts$/);
    assert.equal(run(m, ["doctor"]).status, 0);
  } finally {
    fs.rmSync(m.home, { recursive: true, force: true });
  }
});

test("install leaves exactly one engine in the root", () => {
  const m = machine();
  try {
    run(m, ["install", "opencode"]);
    // A sibling that is not the registered engine is a hazard whatever put it
    // there: it answers to the same name and nothing loads it.
    const old = path.join(m.home, ".doppler", "opencode", "doppler.js");
    fs.writeFileSync(old, "// a stale engine\n");
    assert.equal(fs.existsSync(old), true);
    run(m, ["update"]);
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(path.join(m.home, ".doppler", "opencode", "doppler.ts")), true);
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

test("update refreshes the bridge from the package", () => {
  // Otherwise a package upgrade needs a second manual step, and "I updated the
  // CLI and nothing changed" has no explanation.
  const m = machine();
  const home = path.join(m.home, ".doppler");
  try {
    run(m, ["install", "opencode"]);
    const bridge = path.join(home, "opencode", "doppler.ts");
    fs.writeFileSync(bridge, "// stale engine\n");
    assert.equal(run(m, ["update"]).status, 0);
    assert.notEqual(fs.readFileSync(bridge, "utf8"), "// stale engine\n");
    assert.equal(fs.readFileSync(bridge).equals(fs.readFileSync(path.join(ROOT, "opencode", "doppler.ts"))), true);
  } finally {
    fs.rmSync(m.home, { recursive: true, force: true });
  }
});
