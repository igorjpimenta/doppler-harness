// A version in the README is a promise about what a reader will get, and it rots
// silently: a pin left at an older release reads exactly like a correct one.
// Deliberately blunt — no version-shaped literal at all, not even an old one —
// because an example that needs exempting is an example someone will read as
// current, and a placeholder beats an allowlist entry.
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