// The engine self-update under Bun — the runtime OpenCode's plugin loader
// actually uses.
//
// The mechanism exists because Bun caches a plugin module for the life of the
// process: a query-string cache key does not survive it (it normalizes the
// query away and serves the stale module), which is why the update is
// executed from a copy at a filesystem path. A mechanism proven only under
// Node would be proven on the wrong runtime.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");

function bunPath() {
  const found = spawnSync("which", ["bun"], { encoding: "utf8" });
  const p = found.stdout.trim();
  return p && fs.existsSync(p) ? p : null;
}

const BUN = bunPath();

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// The real entry, with a marker appended so the two builds are tellable apart
// at runtime — and so the second build has different content, which is what
// makes it an update.
function entryWithMarker(entry, marker) {
  const body = fs.readFileSync(path.join(DIST, entry), "utf8");
  return `${body}\nimport { appendFileSync } from "node:fs";\nappendFileSync(process.env.DOPPLER_MARKER_LOG, ${JSON.stringify(marker + "\\n")});\n`;
}

// The harness shape: import the installed entry once, call it, wait for the
// package to change underneath the process, call it again.
const CHILD = `
import fs from "node:fs";
const [url, installed, ready, entry] = process.argv.slice(2);
const mod = await import(url);
const client = { client: { app: { log: async () => {} } }, session: {}, tui: {} };
await mod[entry](client);
fs.writeFileSync(ready, "ready\\n");
const deadline = Date.now() + 15000;
while (Date.now() < deadline) {
  if (fs.readFileSync(installed, "utf8").includes("MARKER_V2")) break;
  await new Promise((r) => setTimeout(r, 25));
}
await mod[entry](client);
`;

async function adoptionUnder(runtime, entry, exportName) {
  const home = tempDir("doppler-bun-home-");
  const installed = tempDir("doppler-bun-dist-");
  const log = path.join(home, "markers.log");
  const ready = path.join(home, "ready");
  fs.writeFileSync(log, "");

  fs.writeFileSync(path.join(installed, "loader.js"), entryWithMarker("loader.js", "v1"));
  fs.writeFileSync(path.join(installed, "doppler.js"), entryWithMarker("doppler.js", "v1"));
  // The package is the whole dist: the entries import the shared module, and a
  // copy of a unit missing one of its files is not a unit.
  fs.copyFileSync(path.join(DIST, "engine-update.js"), path.join(installed, "engine-update.js"));

  const script = path.join(home, "child.mjs");
  fs.writeFileSync(script, CHILD);

  const child = spawn(
    runtime,
    [script, `file://${path.join(installed, entry)}`, path.join(installed, entry), ready, exportName],
    {
      env: {
        ...process.env,
        DOPPLER_HOME: home,
        DOPPLER_MARKER_LOG: log,
        DOPPLER_ENGINE_DIR: installed,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += String(c)));
  const exited = new Promise((resolve) => child.on("close", resolve));

  // The update lands only after the running build has loaded: a package that
  // changed before the import is not an update, it is the file that got
  // imported.
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(ready)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for the child: ${stderr}`);
    await new Promise((r) => setTimeout(r, 25));
  }
  fs.writeFileSync(path.join(installed, entry), entryWithMarker(entry, "v2") + "\n// MARKER_V2\n");

  const code = await exited;
  assert.equal(code, 0, stderr);
  const markers = fs.readFileSync(log, "utf8");
  assert.ok(markers.includes("v2"), `the new build ran: ${JSON.stringify(markers)}`);
  assert.ok(fs.existsSync(path.join(home, ".engine-cache")), "the adopted build lives in the cache");
}

test("bun adopts the build that replaced the loader", { skip: BUN ? false : "bun is not installed" }, async () => {
  await adoptionUnder(BUN, "loader.js", "DopplerPluginLoader");
});

test("bun adopts the build that replaced the bridge", { skip: BUN ? false : "bun is not installed" }, async () => {
  await adoptionUnder(BUN, "doppler.js", "DopplerHarness");
});
