// Tests for the engine self-update (opencode/doppler.ts, opencode/loader.ts).
//
// The mechanism: a running harness never re-reads its plugin — a module is
// imported once and cached for the life of the process. So each entry checks
// whether the package on disk is newer than the code executing now, and if so
// executes a copy of the whole unit instead of itself.
//
// Two failure modes are worth pinning, because both are silent otherwise: an
// entry that carries its own copy of the mechanism instead of the shared one
// (the copies drift, and only one of them heals), and an update that adopts a
// broken build.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("both entries use the one shared implementation", () => {
  // The mechanism lives in one file, and the two entries import it rather than
  // carrying a copy each: a copy that missed a fix would be a different
  // mechanism on the bridge than on the loader, and the difference would only
  // show up as one of them not healing.
  const shared = fs.readFileSync(path.join(ROOT, "opencode", "engine-update.ts"), "utf8");
  assert.ok(shared.includes("export function stageEngineUpdate"), "the shared module has the mechanism");
  for (const file of ["doppler.ts", "loader.ts"]) {
    const s = fs.readFileSync(path.join(ROOT, "opencode", file), "utf8");
    assert.match(s, /from "\.\/engine-update\.ts"/, `${file} imports the shared module`);
    assert.equal(s.split("export function stageEngineUpdate").length - 1, 0, `${file} carries no copy of it`);
  }
});

test("the build ships the shared module and the entries import it by its .js name", () => {
  // What ships is what runs: the emitted JavaScript has to name the emitted
  // file, or the package loads on the machine and not on the user's.
  const dist = path.join(ROOT, "dist");
  if (!fs.existsSync(path.join(dist, "doppler.js"))) return; // not built yet
  assert.ok(fs.existsSync(path.join(dist, "engine-update.js")), "the shared module ships");
  for (const file of ["doppler.js", "loader.js"]) {
    const s = fs.readFileSync(path.join(dist, file), "utf8");
    assert.match(s, /from "\.\/engine-update\.js"/, `${file} imports the shipped module`);
  }
});

// A dist directory with the two entries and nothing else, so the hash covers
// exactly the unit that would be copied.
function distFixture(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doppler-engine-dist-"));
  fs.writeFileSync(path.join(dir, "doppler.js"), files.doppler ?? "export const DopplerHarness = async () => ({});\n");
  fs.writeFileSync(path.join(dir, "loader.js"), files.loader ?? "export const DopplerPluginLoader = async () => ({});\n");
  return dir;
}

function homeFixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "doppler-engine-home-"));
}

test("a copy is made when the package on disk is newer, and not when it is the same", async () => {
  const mod = await import("../opencode/doppler.ts");
  const home = homeFixture();
  const dist = distFixture();
  const selfUrl = new URL("../opencode/doppler.ts", import.meta.url).href;

  const loaded = mod.internals.engineLoadedHash(selfUrl);
  assert.ok(loaded, "the running source hashes");

  // The source directory is the "installed" package for a source-mode test.
  const same = mod.internals.engineUpdateAvailable(home, selfUrl, loaded);
  assert.equal(same, false, "the running build matches its own files");

  // A different package on disk reads as newer.
  process.env.DOPPLER_ENGINE_DIR = dist;
  try {
    assert.equal(mod.internals.engineUpdateAvailable(home, selfUrl, loaded), true, "a different build on disk is an update");

    const staged = mod.internals.stageEngineUpdate(home, selfUrl, "doppler.js", loaded);
    assert.ok(staged, "the update is staged");
    assert.ok(staged.includes(".engine-cache"), `staged under the cache: ${staged}`);
    assert.ok(fs.existsSync(staged.replace("file://", "")), "the staged copy exists");

    // The copy carries the whole unit, so a mixed pair can never run.
    const copyDir = path.dirname(staged.replace("file://", ""));
    assert.ok(fs.existsSync(path.join(copyDir, "loader.js")), "the loader travels with the bridge");
    assert.ok(fs.existsSync(path.join(copyDir, "source.json")), "and a sidecar naming where it came from");
  } finally {
    delete process.env.DOPPLER_ENGINE_DIR;
  }
});

test("a staged copy of the same build is never made", async () => {
  const mod = await import("../opencode/doppler.ts");
  const home = homeFixture();
  const selfUrl = new URL("../opencode/doppler.ts", import.meta.url).href;
  const loaded = mod.internals.engineLoadedHash(selfUrl);
  assert.equal(mod.internals.stageEngineUpdate(home, selfUrl, "doppler.js", loaded), null, "nothing to stage");
});

test("an unreadable package on disk reads as no update", async () => {
  const mod = await import("../opencode/doppler.ts");
  const home = homeFixture();
  const selfUrl = new URL("../opencode/doppler.ts", import.meta.url).href;
  const loaded = mod.internals.engineLoadedHash(selfUrl);
  process.env.DOPPLER_ENGINE_DIR = path.join(home, "does-not-exist");
  try {
    assert.equal(mod.internals.engineUpdateAvailable(home, selfUrl, loaded), false, "no package, no update");
  } finally {
    delete process.env.DOPPLER_ENGINE_DIR;
  }
});

test("a broken build on disk does not take down the session", async () => {
  // The update is executed, not trusted: a build that cannot even be imported
  // must leave the running one serving, because the whole point of the
  // mechanism is that a session survives an engine update.
  const loader = await import("../opencode/loader.ts");
  const home = homeFixture();
  fs.mkdirSync(path.join(home, "plugins"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "plugins", "mine.js"),
    "export const Mine = async () => ({ event: async () => {} });\n",
  );
  // The package on disk is the real build with its shared module broken: the
  // entries import it, so the copy cannot load.
  const dist = distFixture({
    loader: fs.readFileSync(path.join(ROOT, "dist", "loader.js"), "utf8"),
    doppler: fs.readFileSync(path.join(ROOT, "dist", "doppler.js"), "utf8"),
  });
  fs.writeFileSync(path.join(dist, "engine-update.js"), "this is not javascript (((\n");

  const previous = process.env.DOPPLER_ENGINE_DIR;
  const previousHome = process.env.DOPPLER_HOME;
  process.env.DOPPLER_ENGINE_DIR = dist;
  process.env.DOPPLER_HOME = home;
  try {
    const hooks = await loader.DopplerPluginLoader({ client: { app: { log: async () => {} } } });
    assert.ok(hooks, "the loader answered instead of throwing");
    const report = JSON.parse(fs.readFileSync(path.join(home, "plugins.loaded.json"), "utf8"));
    assert.equal(report.plugins[0].ok, true, "and the personal plugin still loaded");
  } finally {
    if (previous === undefined) delete process.env.DOPPLER_ENGINE_DIR;
    else process.env.DOPPLER_ENGINE_DIR = previous;
    if (previousHome === undefined) delete process.env.DOPPLER_HOME;
    else process.env.DOPPLER_HOME = previousHome;
  }
});
