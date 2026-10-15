// The update command's CLI behaviour on a fake machine. Both cases here are
// the no-network ones: an unreachable repo and a repo whose tags carry no
// tarballs. They pin the two outcomes that must degrade gracefully — the engine
// stays exactly as it is, the command exits 0, and the registration the rest of
// the machine depends on is untouched.
import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOPPLER = path.join(ROOT, "bin", "doppler.mjs");
const { stringElements, topLevelValueSpan } = await import(path.join(ROOT, "bin", "jsonc.mjs"));
import { fileURLToPath } from "node:url";

// A fake machine: its own HOME and config, an opencode stub that answers an
// empty plugin list (the same answer the installer tests rely on), and a PATH
// narrowed to nothing real.
function machine() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "doppler-update-"));
  const cfgDir = path.join(home, ".config", "opencode");
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, "opencode.json"), '{ "$schema": "https://opencode.ai/config.json" }\n');
  const stub = path.join(home, "opencode-stub");
  fs.writeFileSync(stub, "#!/bin/sh\nconsole.log('{\"plugin\": []}')\n");
  fs.chmodSync(stub, 0o755);
  const binDir = path.join(home, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(binDir, "node"));
  // git too: the update check shells out to `git ls-remote`, and a PATH without
  // it would fail the check for the wrong reason in every test.
  fs.symlinkSync(execSync("which git").toString().trim(), path.join(binDir, "git"));
  return { home, cfgDir, stub, path: binDir };
}

function run(m, args, env = {}) {
  return spawnSync(process.execPath, [DOPPLER, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: m.home, OPENCODE_BIN: m.stub, DOPPLER_HOME: path.join(m.home, ".doppler"), PATH: m.path, ...env },
  });
}

function registeredEntries(m) {
  const cfg = fs.readFileSync(path.join(m.cfgDir, "opencode.json"), "utf8");
  const span = topLevelValueSpan(cfg, "plugin");
  return span ? stringElements(cfg, span) : [];
}

test("an unreachable repo degrades to a note, exit 0, registration intact", () => {
  const m = machine();
  const r = run(m, ["update"], { DOPPLER_REPO: "file:///nonexistent-doppler-fixture" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /couldn't check for engine updates/);
  assert.match(r.stdout, /engine stays at/);
  assert.equal(registeredEntries(m).length, 0, "update never manufactures a registration — install owns that");
});

test("a tag without a tarball is reported, not installed", () => {
  // A real git fixture, because the point is that ls-remote SUCCEEDS and the
  // asset probe is what fails: "tagged but has no tarball yet" is only honest
  // when the tag list genuinely came from the repo.
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "doppler-tags-"));
  execSync("git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init && git tag 2099.1.1", { cwd: fixture, stdio: "ignore" });
  const m = machine();
  const r = run(m, ["update"], { DOPPLER_REPO: `file://${fixture}` });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /2099\.1\.1 is tagged but has no tarball yet/);
  assert.match(r.stdout, /engine stays at/);
});

test("a malformed pin is refused without touching the engine", () => {
  const m = machine();
  const r = run(m, ["update", "not-a-tag"], { DOPPLER_REPO: "file:///nonexistent-doppler-fixture" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /is not a release tag/);
});
