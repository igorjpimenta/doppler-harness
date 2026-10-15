// The update decision's pure half. The interesting cases are all about what
// must NOT happen: a same-day re-release ("-N") is a test build that is
// content-ahead of its plain release, so "upgrading" it to the release would
// delete engine files the registered config still points at; and string order
// ranks "2026.10.9" above "2026.10.14", which would pin machines to October 9th
// forever. Both are pinned here as tables, not as one happy path.
import assert from "node:assert/strict";
import test from "node:test";
import {
  isNewerRelease,
  newestInstallable,
  newerTag,
  parseTag,
  tagsFromLsRemote,
} from "../bin/update-core.mjs";

test("parseTag accepts release and re-release spellings, rejects everything else", () => {
  assert.deepEqual(parseTag("2026.10.15"), { y: 2026, m: 10, d: 15, n: 0 });
  assert.deepEqual(parseTag("2026.10.15-2"), { y: 2026, m: 10, d: 15, n: 2 });
  assert.equal(parseTag("v2026.10.15"), null);
  assert.equal(parseTag("2026-10-15"), null);
  assert.equal(parseTag("main"), null);
  assert.equal(parseTag("2026.10"), null);
});

test("tags order numerically, not lexically", () => {
  // Lexical order would rank "2026.10.9" above "2026.10.14".
  assert.equal(newerTag(parseTag("2026.10.14"), parseTag("2026.10.9")), 1);
  assert.equal(newerTag(parseTag("2026.9.29"), parseTag("2026.10.8")), -1);
  // The plain release outranks its own "-N" re-releases; higher N outranks lower.
  assert.equal(newerTag(parseTag("2026.10.14"), parseTag("2026.10.14-1")), 1);
  assert.equal(newerTag(parseTag("2026.10.14-2"), parseTag("2026.10.14-1")), 1);
  assert.equal(newerTag(parseTag("2026.10.14"), parseTag("2026.10.14")), 0);
});

test("the downgrade trap: a same-base re-release is never an upgrade", () => {
  // "2026.10.14-1" is a tarball test build carrying code the released
  // "2026.10.14" does not have (it predates the loader). Auto-"upgrading" it to
  // the release deletes dist/loader.js out from under the registered config.
  assert.equal(isNewerRelease("2026.10.14", "2026.10.14-1"), false);
  // The other direction is equally unsafe to automate.
  assert.equal(isNewerRelease("2026.10.14-2", "2026.10.14"), false);
  // A new date base is the only thing that qualifies.
  assert.equal(isNewerRelease("2026.10.15", "2026.10.14-1"), true);
  assert.equal(isNewerRelease("2026.10.15", "2026.10.15"), false);
  assert.equal(isNewerRelease("2026.10.14", "2026.10.15"), false);
  // An unparseable installed version (dev placeholder) is never auto-updated.
  assert.equal(isNewerRelease("2026.10.15", "unknown"), false);
  // An unparseable latest tag cannot be an upgrade.
  assert.equal(isNewerRelease("main", "2026.10.15"), false);
});

test("tagsFromLsRemote peels ref prefixes and annotated-tag suffixes", () => {
  const out = [
    "abc123\trefs/tags/2026.10.14",
    "def456\trefs/tags/2026.10.14^{}",
    "789\trefs/heads/main",
  ].join("\n");
  assert.deepEqual(tagsFromLsRemote(out), ["2026.10.14", "2026.10.14"]);
});

test("newestInstallable walks newest-first and skips tags without assets", async () => {
  const tags = ["2026.10.8", "2026.10.14", "2026.10.11", "not-a-tag"];
  const probed = [];
  const probe = (t) => {
    probed.push(t);
    return t === "2026.10.11"; // newest two have no tarball
  };
  assert.equal(await newestInstallable(tags, probe), "2026.10.11");
  assert.deepEqual(probed, ["2026.10.14", "2026.10.11"], "older tags are not probed after a hit");
});

test("newestInstallable returns null when no tag has an asset", async () => {
  const tags = ["2026.10.15", "2026.10.14"];
  const probe = () => false;
  assert.equal(await newestInstallable(tags, probe), null);
});
