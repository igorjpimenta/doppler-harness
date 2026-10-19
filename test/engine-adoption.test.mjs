// The engine self-update, as a running harness sees it.
//
// The unit tests cover the pieces; this covers the thing that only exists in a
// process: a module that is already loaded, whose package on disk changes
// underneath it, answering the next invocation with the new build.
//
// The shape is the harness's own: the entry's exported function is called
// again after an instance rebuild, and that call is where the adoption
// happens — the module itself stays cached for the life of the process.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// The loader with a marker appended: the marker is what makes the two builds
// distinguishable at runtime, and appending it changes the content hash, which
// is exactly what an npm update does.
function loaderWithMarker(installed, marker) {
  const body = fs.readFileSync(path.join(DIST, "loader.js"), "utf8");
  return body + `\nimport { appendFileSync } from "node:fs";\nappendFileSync(process.env.DOPPLER_MARKER_LOG, ${JSON.stringify(marker + "\\n")});\n`;
}

test("a running loader adopts the build that replaced it", async () => {
  const home = tempDir("doppler-adopt-home-");
  const installed = tempDir("doppler-adopt-dist-");
  const log = path.join(home, "markers.log");
  fs.writeFileSync(log, "");

  fs.writeFileSync(path.join(installed, "loader.js"), loaderWithMarker(installed, "v1"));
  fs.copyFileSync(path.join(DIST, "doppler.js"), path.join(installed, "doppler.js"));

  // The child is the harness: it imports the installed entry once, calls it,
  // waits for the package on disk to change, and calls it again.
  const script = path.join(home, "child.mjs");
  const ready = path.join(home, "ready");
  fs.writeFileSync(
    script,
    `
import fs from "node:fs";
const url = process.argv[2];
const mod = await import(url);
const client = { client: { app: { log: async () => {} } } };
await mod.DopplerPluginLoader(client);
fs.writeFileSync(process.argv[4], "ready\\n");
const installed = process.argv[3];
const deadline = Date.now() + 15000;
while (Date.now() < deadline) {
  if (fs.readFileSync(installed, "utf8").includes("MARKER_V2")) break;
  await new Promise((r) => setTimeout(r, 25));
}
await mod.DopplerPluginLoader(client);
`,
  );

  const child = spawn(
    process.execPath,
    [script, new URL(`file://${path.join(installed, "loader.js")}`).href, path.join(installed, "loader.js"), ready],
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

  // The update lands only once the running build has loaded: a package that
  // changed before the import is not an update, it is just the file that got
  // imported.
  await waitFor(() => fs.existsSync(ready), 15000);
  fs.writeFileSync(path.join(installed, "loader.js"), loaderWithMarker(installed, "v2") + "\n// MARKER_V2\n");

  const code = await exited;
  assert.equal(code, 0, stderr);

  // The second call must come from the new build, executed from the cache.
  const markers = fs.readFileSync(log, "utf8");
  assert.ok(markers.includes("v2"), `the new build ran: ${JSON.stringify(markers)}`);
  const cache = path.join(home, ".engine-cache");
  assert.ok(fs.existsSync(cache), `the adopted build lives in the cache: ${fs.readdirSync(home).join(", ")} | child: ${stderr}`);
});

// Poll for a condition, with an action that produces it: the child is waiting
// for the update, so the write has to happen while it waits.
async function waitFor(what, timeout) {
  const deadline = Date.now() + timeout;
  while (!what()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the child");
    await new Promise((r) => setTimeout(r, 25));
  }
}
