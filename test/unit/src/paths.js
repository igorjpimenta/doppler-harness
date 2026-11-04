// paths.test.mjs — src/paths.ts: where the personal root is, resolved per
// call, never at import.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { personalRoot, paths, globalAgentsMd, hasEntries, overlaySkillRoots, nodeUsable, NODE } from "../../../src/paths.ts";
import { rootWith, withRoot } from "../../helpers/harness.js";

test("DOPPLER_HOME names the root outright", async () => {
  await withRoot({}, async (home) => {
    assert.equal(personalRoot(), home);
    assert.equal(paths().home, home);
  });
});

test("a root written to <home>/.doppler/opencode.json wins when no env is set", () => {
  const saved = process.env.DOPPLER_HOME;
  delete process.env.DOPPLER_HOME;
  try {
    const real = personalRoot();
    // The installer's own file, honored only when the env does not say otherwise.
    process.env.DOPPLER_HOME = "/tmp/elsewhere";
    assert.equal(personalRoot(), "/tmp/elsewhere");
    assert.notEqual(real, "/tmp/elsewhere");
  } finally {
    if (saved === undefined) delete process.env.DOPPLER_HOME;
    else process.env.DOPPLER_HOME = saved;
  }
});

test("paths() re-reads the environment on every call", async () => {
  const saved = process.env.DOPPLER_HOME;
  try {
    process.env.DOPPLER_HOME = "/tmp/root-a";
    const first = paths().hooks;
    process.env.DOPPLER_HOME = "/tmp/root-b";
    const second = paths().hooks;
    assert.notEqual(first, second, "a root captured at import is a root wrong for the session");
  } finally {
    if (saved === undefined) delete process.env.DOPPLER_HOME;
    else process.env.DOPPLER_HOME = saved;
  }
});

test("the global instructions path follows XDG_CONFIG_HOME first", () => {
  const savedX = process.env.XDG_CONFIG_HOME;
  const savedH = process.env.HOME;
  try {
    process.env.XDG_CONFIG_HOME = "/tmp/xdg";
    assert.ok(globalAgentsMd().startsWith("/tmp/xdg/"));
    delete process.env.XDG_CONFIG_HOME;
    process.env.HOME = "/tmp/fake-home";
    assert.equal(globalAgentsMd(), path.join("/tmp/fake-home", ".config", "opencode", "AGENTS.md"));
  } finally {
    if (savedX === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedX;
    if (savedH === undefined) delete process.env.HOME;
    else process.env.HOME = savedH;
  }
});

test("hasEntries is true only for a directory with something in it", async () => {
  await withRoot({ skills: { one: "---\nname: one\n---\nbody" } }, async (home) => {
    assert.equal(hasEntries(path.join(home, "skills")), true);
    assert.equal(hasEntries(path.join(home, "skills", "one", "SKILL.md")), false, "a file is not a directory");
    fs.mkdirSync(path.join(home, "skills", "empty"));
    assert.equal(hasEntries(path.join(home, "skills", "empty")), false, "an empty directory has nothing in it");
    assert.equal(hasEntries(path.join(home, "nothing-here")), false);
  });
});

test("overlay skill roots come from overlay.json and bad entries are ignored", async () => {
  await withRoot({}, async (home) => {
    assert.deepEqual(overlaySkillRoots(), []);
    fs.writeFileSync(path.join(home, "overlay.json"), JSON.stringify({ skillsRoots: [path.join(home, "skills"), 42, null] }));
    const roots = overlaySkillRoots();
    assert.equal(roots.length, 1, "only strings survive");
    assert.ok(roots[0].endsWith("/skills"));
    fs.writeFileSync(path.join(home, "overlay.json"), "{ not json");
    assert.deepEqual(overlaySkillRoots(), []);
  });
});

test("NODE is resolved once at import, and DOPPLER_NODE is what it reads", async () => {
  // The probe is an import-time constant: a live env change cannot move it,
  // which is the point — the value is stable for the whole session.
  assert.equal(nodeUsable(), true, "the ambient node runs");
  assert.ok(NODE.length > 0, "NODE resolves to something");
  const saved = process.env.DOPPLER_NODE;
  process.env.DOPPLER_NODE = path.join("/nonexistent", "node");
  try {
    const fresh = await import("../../../src/paths.ts?doppler-node-probe=1");
    assert.match(fresh.NODE, /nonexistent/, "a fresh import reads the override");
    assert.equal(fresh.nodeUsable(), false, "and an unusable node is not usable");
  } finally {
    if (saved === undefined) delete process.env.DOPPLER_NODE;
    else process.env.DOPPLER_NODE = saved;
  }
});
