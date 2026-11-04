// skills.test.mjs — src/skills.ts: discovery for the personal root's skills.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { discoverSkills } from "../../../src/skills.ts";
import { rootWith, withRoot } from "../../helpers/harness.js";

const SKILL = "---\nname: review\ndescription: Review the diff\n---\nSkill body.\n";

test("a SKILL.md directory becomes a skill record with its frontmatter", async () => {
  await withRoot({ skills: { review: SKILL } }, async (home) => {
    const found = discoverSkills([path.join(home, "skills")]);
    assert.equal(found.length, 1);
    const s = found[0];
    assert.equal(s.id, "review");
    assert.equal(s.name, "review");
    assert.equal(s.description, "Review the diff");
    assert.match(s.content, /Skill body\./);
    assert.ok(String(s.path).endsWith(path.join("review", "SKILL.md")));
  });
});

test("a directory without frontmatter falls back to its own name", async () => {
  await withRoot({ skills: { plain: "# Just a heading\nbody" } }, async (home) => {
    const [s] = discoverSkills([path.join(home, "skills")]);
    assert.equal(s.id, "plain");
    assert.equal(s.name, "plain");
    assert.equal(s.description, "");
  });
});

test("entries without a SKILL.md are not skills, and files are not directories", async () => {
  await withRoot({ skills: { real: SKILL } }, async (home) => {
    const root = path.join(home, "skills");
    fs.mkdirSync(path.join(root, "hollow"));
    fs.writeFileSync(path.join(root, "loose.md"), "# not a directory");
    const found = discoverSkills([root]);
    assert.deepEqual(found.map((s) => s.id), ["real"]);
  });
});

test("a missing root discovers nothing rather than throwing", () => {
  assert.deepEqual(discoverSkills(["/no/such/root"]), []);
  assert.deepEqual(discoverSkills([]), []);
});
