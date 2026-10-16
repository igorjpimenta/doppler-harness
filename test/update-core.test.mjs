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

test("parseTag accepts stable, -beta.N, and the legacy bare -N", () => {
  assert.deepEqual(parseTag("2026.10.15"), { y: 2026, m: 10, d: 15, n: 0 });
  assert.deepEqual(parseTag("2026.10.15-beta.2"), { y: 2026, m: 10, d: 15, n: 2 });
  // The old same-day spelling stays parseable: those tags are still pinnable.
  assert.deepEqual(parseTag("2026.10.15-1"), { y: 2026, m: 10, d: 15, n: 1 });
  assert.equal(parseTag("v2026.10.15"), null);
  assert.equal(parseTag("2026-10-15"), null);
  assert.equal(parseTag("main"), null);
  assert.equal(parseTag("2026.10"), null);
  // A suffix without its lane marker is not a version this project publishes.
  assert.equal(parseTag("2026.10.15-beta"), null);
});

test("tags order numerically, and a pre-release precedes the stable it previews", () => {
  // Lexical order would rank "2026.10.9" above "2026.10.14".
  assert.equal(newerTag(parseTag("2026.10.14"), parseTag("2026.10.9")), 1);
  assert.equal(newerTag(parseTag("2026.9.29"), parseTag("2026.10.8")), -1);
  // The stable outranks every pre-release of its own day, and higher -beta.N
  // outranks lower — the same shape semver gives, now that the version string
  // and the release flag agree about what a suffix means.
  assert.equal(newerTag(parseTag("2026.10.14"), parseTag("2026.10.14-beta.1")), 1);
  assert.equal(newerTag(parseTag("2026.10.14-beta.2"), parseTag("2026.10.14-beta.1")), 1);
  assert.equal(newerTag(parseTag("2026.10.14"), parseTag("2026.10.14")), 0);
});

test("the upgrade decision: stables only, with promotion off a pre-release", () => {
  // A pre-release never auto-installs — not over a stable, not over an older
  // day. Pin it or pass --force.
  assert.equal(isNewerRelease("2026.10.17-beta.1", "2026.10.16"), false);
  assert.equal(isNewerRelease("2026.10.14-beta.1", "2026.10.14"), false);
  assert.equal(isNewerRelease("2026.10.15-2", "2026.10.15"), false);
  // A newer day's stable is the only automatic upgrade.
  assert.equal(isNewerRelease("2026.10.15", "2026.10.14"), true);
  assert.equal(isNewerRelease("2026.10.15", "2026.10.14-1"), true);
  assert.equal(isNewerRelease("2026.10.15", "2026.10.15"), false);
  assert.equal(isNewerRelease("2026.10.14", "2026.10.15"), false);
  // Already on a pre-release of the day: its stable is an upgrade, which is what
  // publishing the stable is for.
  assert.equal(isNewerRelease("2026.10.15", "2026.10.15-beta.1"), true);
  assert.equal(isNewerRelease("2026.10.15-beta.2", "2026.10.15-beta.1"), false);
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
