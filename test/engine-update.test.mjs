// Tests for the engine self-update (opencode/doppler.ts, opencode/loader.ts).
//
// The mechanism: a running harness never re-reads its plugin — a module is
// imported once and cached for the life of the process. So each entry checks
// whether the package on disk is newer than the code executing now, and if so
// executes a copy of the whole unit instead of itself.
//
// Two failure modes are worth pinning, because both are silent otherwise: the
// two copies of the mechanism drifting apart (they are duplicated on purpose,
// and a shared module cannot be imported from source-mode tests), and an update
// that adopts a broken build.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The mirrored block, verbatim from each entry.
function mirroredBlock(file) {
  const s = fs.readFileSync(path.join(ROOT, "opencode", file), "utf8");
  const a = s.indexOf("// --- begin mirrored");
  const b = s.indexOf("// --- end mirrored");
  assert.ok(a >= 0 && b > a, `${file} has no mirrored block`);
  return s.slice(a, b);
}

test("the two copies of the mechanism are identical", () => {
  // They are duplicated on purpose: these entries load from dist/ but the test
  // suite imports them from source, where a shared module would not resolve
  // under Node's ESM loader. The duplication is only safe while a test asserts
  // it — otherwise a fix in one silently misses the other.
  assert.equal(
    mirroredBlock("doppler.ts"),
    mirroredBlock("loader.ts"),
    "doppler.ts and loader.ts must carry the same self-update block",
  );
});

test("the mirrored block is inside both entries' markers", () => {
  for (const file of ["doppler.ts", "loader.ts"]) {
    const s = fs.readFileSync(path.join(ROOT, "opencode", file), "utf8");
    assert.equal(s.split("// --- begin mirrored").length - 1, 1, `${file} has one begin marker`);
    assert.equal(s.split("// --- end mirrored").length - 1, 1, `${file} has one end marker`);
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
