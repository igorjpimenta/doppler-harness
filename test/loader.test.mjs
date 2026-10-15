// Tests for the plugin loader (opencode/loader.ts).
//
// The loader's whole job is to do at startup what no plugin can do for itself:
// find the personal root's plugins and run them. Its contract has three failure
// modes worth pinning, because all three are silent otherwise: a plugin that is
// in the root but never loads, a plugin that throws taking the session with it,
// and two plugins whose hooks silently overwrite each other. Run with `node --test`.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const LOADER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "loader.js");

// A personal root holding exactly the plugins a test names. DOPPLER_HOME is the
// resolver's first choice, so no test can reach the real root.
function rootWith(plugins = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "doppler-loader-"));
  const dir = path.join(home, "plugins");
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(plugins)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  const previous = process.env.DOPPLER_HOME;
  process.env.DOPPLER_HOME = home;
  return {
    home,
    dir,
    cleanup() {
      if (previous === undefined) delete process.env.DOPPLER_HOME;
      else process.env.DOPPLER_HOME = previous;
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

async function loadHooks() {
  const mod = await import(pathToFileURL(LOADER).href);
  return mod.DopplerPluginLoader({ client: { app: { log: async () => {} } } });
}

// An event hook that records into a file the test can read back, because the
// composed hooks' return value threading is the thing under test.
const RECORDER = (file, tag) => `
export const Recorder = async () => ({
  event: async ({ event }) => {
    if (event.type !== "test.ping") return;
    const fs = await import("node:fs");
    fs.appendFileSync(${JSON.stringify(file)}, ${JSON.stringify(tag)} + "\\n");
  },
});
`;

test("a plugin in the root is loaded and its event hook fires", async () => {
  const r = rootWith();
  const seen = path.join(r.home, "seen.log");
  fs.writeFileSync(path.join(r.dir, "recorder.js"), RECORDER(seen, "fired"));

  const hooks = await loadHooks();
  await hooks.event({ event: { type: "test.ping" } });
  assert.equal(fs.readFileSync(seen, "utf8").trim(), "fired", "root plugin's hook ran");
  r.cleanup();
});

test("a default export is loaded, and a file with no plugin function is reported", async () => {
  const r = rootWith();
  fs.writeFileSync(path.join(r.dir, "mod.js"), "export default async () => ({ event: async () => {} });\n");
  fs.writeFileSync(path.join(r.dir, "plain.js"), "export const notAFunction = 42;\n");

  const hooks = await loadHooks();
  assert.equal(typeof hooks.event, "function", "the default export registered a hook");

  const report = JSON.parse(fs.readFileSync(path.join(r.home, "plugins.loaded.json"), "utf8"));
  const bad = report.plugins.filter((p) => !p.ok);
  assert.equal(bad.length, 1, "the non-plugin file is reported, not silently ignored");
  assert.match(bad[0].error, /exports no plugin function/);
  r.cleanup();
});

test("a plugin that throws is skipped; the others still load", async () => {
  const r = rootWith();
  fs.writeFileSync(path.join(r.dir, "boom.js"), "throw new Error('kaboom');\n");
  const seen = path.join(r.home, "seen.log");
  fs.writeFileSync(path.join(r.dir, "recorder.js"), RECORDER(seen, "still-ran"));

  const hooks = await loadHooks();
  await hooks.event({ event: { type: "test.ping" } });
  assert.equal(fs.readFileSync(seen, "utf8").trim(), "still-ran", "one bad plugin cannot stop the session");
  const report = JSON.parse(fs.readFileSync(path.join(r.home, "plugins.loaded.json"), "utf8"));
  assert.ok(report.plugins.some((p) => !p.ok && /kaboom/.test(p.error)), "the failure is recorded, not swallowed");
  r.cleanup();
});

test("two plugins' event hooks both run, in filename order", async () => {
  const r = rootWith();
  const seen = path.join(r.home, "seen.log");
  fs.writeFileSync(path.join(r.dir, "a-first.js"), RECORDER(seen, "a"));
  fs.writeFileSync(path.join(r.dir, "b-second.js"), RECORDER(seen, "b"));

  const hooks = await loadHooks();
  await hooks.event({ event: { type: "test.ping" } });
  assert.equal(fs.readFileSync(seen, "utf8").trim().split("\n").join(","), "a,b", "both ran, ordered by filename");
  r.cleanup();
});

test("hidden files and __tests__ are not loaded", async () => {
  const r = rootWith();
  fs.writeFileSync(path.join(r.dir, ".swap.js"), "throw new Error('hidden must not load');\n");
  fs.writeFileSync(path.join(r.dir, "__tests__.js"), "throw new Error('tests must not load');\n");
  fs.mkdirSync(path.join(r.dir, "__tests__"));
  fs.writeFileSync(path.join(r.dir, "__tests__", "helper.js"), "throw new Error('nested must not load');\n");

  const hooks = await loadHooks();
  const report = JSON.parse(fs.readFileSync(path.join(r.home, "plugins.loaded.json"), "utf8"));
  assert.deepEqual(report.plugins, [], "nothing in a test or hidden file is loaded");
  // No plugin registers, so the loader composes no hook at all. Calling one here
  // would be asserting the opposite of what the test is named for.
  assert.deepEqual(hooks, {}, "a hidden or test file contributes no hook to call");
  r.cleanup();
});

test("an absent or empty plugins dir is a no-op, not an error", async () => {
  const r = rootWith();
  const hooks = await loadHooks();
  assert.deepEqual(hooks, {}, "no plugins, no hooks, no throw");
  r.cleanup();
});

test("object-shaped hooks merge instead of overwriting", async () => {
  const r = rootWith();
  fs.writeFileSync(
    path.join(r.dir, "tools.js"),
    `export const Tools = async () => ({ tool: { alpha: { description: "a" }, beta: { description: "b" } } });\n`,
  );
  fs.writeFileSync(
    path.join(r.dir, "tools2.js"),
    `export const Tools2 = async () => ({ tool: { beta: { description: "b2" }, gamma: { description: "c" } } });\n`,
  );
  const hooks = await loadHooks();
  assert.equal(hooks.tool.alpha.description, "a", "first plugin's tool survived");
  assert.equal(hooks.tool.beta.description, "b2", "later plugin wins the shared key");
  assert.equal(hooks.tool.gamma.description, "c", "later plugin's own tool is added");
  r.cleanup();
});
test("a PluginModule object export is loaded, not just a bare function", async () => {
  // Every plugin written against the current SDK exports `default { id, server }`,
  // which is not a function. Accepting only the bare-function shape makes a real
  // root report every one of its plugins as "exports no plugin function".
  const r = rootWith();
  const seen = path.join(r.home, "seen.log");
  fs.writeFileSync(
    path.join(r.dir, "module.js"),
    `export default {
  id: "module-shaped",
  server: async () => ({
    event: async ({ event }) => {
      if (event.type !== "test.ping") return;
      const fs = await import("node:fs");
      fs.appendFileSync(${JSON.stringify(seen)}, "module-shaped\\n");
    },
  }),
};
`,
  );

  const hooks = await loadHooks();
  await hooks.event({ event: { type: "test.ping" } });
  assert.equal(fs.readFileSync(seen, "utf8").trim(), "module-shaped", "the object export's hooks run");
  const report = JSON.parse(fs.readFileSync(path.join(r.home, "plugins.loaded.json"), "utf8"));
  assert.equal(report.plugins[0].ok, true, "and it is reported as loaded, not skipped");
  r.cleanup();
});
