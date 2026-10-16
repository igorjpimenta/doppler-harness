// Release tags are calendar versions ("2026.10.15", with an optional "-N" for a
// same-day re-release). Every comparison here is numeric, because string order
// ranks "2026.10.9" above "2026.10.14" and would silently pin machines to
// October 9th forever.

export function parseTag(s) {
  const m = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-(\d{1,3}))?$/.exec(String(s).trim());
  if (!m) return null;
  return { y: +m[1], m: +m[2], d: +m[3], n: m[4] ? +m[4] : 0 };
}

// Total order over tags: within a date base, higher -N is later — "2026.10.15-2"
// is the third release of that day, not an earlier draft of it. This orders the
// newest-installable walk only; the upgrade decision is isNewerRelease, which
// compares date bases alone.
export function newerTag(a, b) {
  const ka = [a.y, a.m, a.d, a.n];
  const kb = [b.y, b.m, b.d, b.n];
  for (let i = 0; i < 4; i++) {
    if (ka[i] !== kb[i]) return ka[i] > kb[i] ? 1 : -1;
  }
  return 0;
}

// An upgrade decision, not a comparison: only a strictly newer DATE base
// qualifies. A "-N" tag never auto-installs over its own plain release and
// vice versa — "2026.10.14-1" is a test build that is content-AHEAD of
// "2026.10.14" (it carries code the release does not), so "upgrading" it to the
// release would delete files the registered config still points at. Same for a
// release over a same-base "-N": neither direction is safe to automate, and
// --force is the explicit way through.
export function isNewerRelease(latest, installed) {
  const a = parseTag(latest);
  const b = installed == null ? null : parseTag(installed);
  if (!a) return false;
  if (!b) return false;
  return a.y * 10000 + a.m * 100 + a.d > b.y * 10000 + b.m * 100 + b.d;
}

// `git ls-remote --tags` lines to tag names: peels the ref prefix and the "^{}"
// peeled-tag suffix so annotated tags count once, not twice.
export function tagsFromLsRemote(out) {
  const tags = [];
  for (const line of String(out).split("\n")) {
    const ref = line.split("\t")[1];
    if (!ref || !ref.startsWith("refs/tags/")) continue;
    tags.push(ref.slice("refs/tags/".length).replace(/\^\{\}$/, ""));
  }
  return tags;
}

// Newest installable release: walk tags newest-first and take the first whose
// asset actually exists. A tag without a release tarball is real but not
// installable, and skipping it silently is what makes "tagged, release pending"
// the honest report instead of a failed install.
export async function newestInstallable(tags, probe) {
  const parsed = tags.map((t) => ({ t, p: parseTag(t) })).filter((x) => x.p);
  parsed.sort((a, b) => -newerTag(a.p, b.p));
  for (const { t } of parsed) {
    if (await probe(t)) return t;
  }
  return null;
}
