// Release tags are calendar versions: "2026.10.16" is the stable of that day and
// "2026.10.16-beta.1" a pre-release of it. Every comparison here is numeric,
// because string order ranks "2026.10.9" above "2026.10.14" and would silently
// pin machines to October 9th forever.
//
// A bare "-N" is also accepted: that was this project's earlier spelling for a
// same-day re-release, and those tags are still in the wild and still pinnable.
// Both spellings mean the same thing here — a suffixed tag is a pre-release of
// its base — so they share one lane rather than each carrying their own rule.

export function parseTag(s) {
  const t = String(s).trim();
  const m = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-beta\.(\d{1,3}))?$/.exec(t);
  if (m) return { y: +m[1], m: +m[2], d: +m[3], n: m[4] ? +m[4] : 0 };
  const legacy = /^(\d{4})\.(\d{1,2})\.(\d{1,2})-(\d{1,3})$/.exec(t);
  if (!legacy) return null;
  return { y: +legacy[1], m: +legacy[2], d: +legacy[3], n: +legacy[4] };
}

// Total order over tags: within a date base, a suffixed tag precedes the stable
// it previews — "2026.10.16-beta.1" is what was rehearsed for "2026.10.16" —
// and higher -beta.N outranks lower. Semver sorts a prerelease below its base
// and GitHub's tag listing inherits that reading; here the two agree, because
// the flag and the version string now say the same thing.
//
// This orders the newest-installable walk only. The upgrade decision is
// isNewerRelease, which compares date bases alone.
export function newerTag(a, b) {
  const ka = [a.y, a.m, a.d, a.n === 0 ? Infinity : a.n];
  const kb = [b.y, b.m, b.d, b.n === 0 ? Infinity : b.n];
  for (let i = 0; i < 4; i++) {
    if (ka[i] !== kb[i]) return ka[i] > kb[i] ? 1 : -1;
  }
  return 0;
}

// An upgrade decision, not a comparison: only a stable of a strictly newer DATE
// BASE qualifies, with one exception that is an exception in the safe direction.
// A suffixed tag never auto-installs — a machine stays off pre-releases unless
// it pins one or passes --force — and a machine already ON a pre-release is
// promoted by the stable of the same day, which is the point of publishing the
// stable at all. Everything else compares date bases alone.
export function isNewerRelease(latest, installed) {
  const a = parseTag(latest);
  const b = installed == null ? null : parseTag(installed);
  if (!a || !b) return false;
  if (a.n > 0) return false;
  const sameBase = a.y === b.y && a.m === b.m && a.d === b.d;
  if (sameBase) return b.n > 0;
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
