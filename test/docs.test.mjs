// The README is the only file a reader meets before they decide whether this is
// the tool they want, so a version in it is a promise about what they will get.
// That promise rots the moment a release ships and nobody remembers the number,
// and it fails silently: a stale pin reads exactly like a correct one, and the
// reader who copies it installs something other than what the docs described.
//
// So the README carries no version at all. `<version>` is the placeholder, and
// the releases page is named as the place the value comes from. This pins that
// as a test rather than a convention, because a convention is a comment and a
// comment rots exactly the way the pin did.
//
// This is deliberately blunt: no version-shaped literal anywhere in the README,
// not even an old one. An example that has to be exempt is an example that will
// be read as current, and the fix for that is a placeholder rather than an
// allowlist entry.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the README names no version, so it cannot name a stale one", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const offenders = readme
    .split("\n")
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /\d{4}\.\d+\.\d+/.test(line));

  assert.deepEqual(
    offenders,
    [],
    `README.md lines carrying a version; use <version> instead:\n${offenders
      .map(([n, line]) => `  ${n}: ${line.trim()}`)
      .join("\n")}`,
  );
});

test("the install commands in the README carry the flag npm needs", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const bare = readme
    .split("\n")
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /npm install -g (?!--install-links)github:/.test(line));

  assert.deepEqual(
    bare,
    [],
    `README.md git installs missing --install-links=true:\n${bare
      .map(([n, line]) => `  ${n}: ${line.trim()}`)
      .join("\n")}`,
  );
});