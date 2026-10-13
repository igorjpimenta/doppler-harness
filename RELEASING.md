# Releasing

CalVer, one tag per release, and a note per release. The tag is the contract —
`npm install -g github:igorjpimenta/doppler-harness#<tag>` resolves to it — so
the version has to be decided before the tag is cut, not after.

## Version

`YYYY.M.D` in `package.json`, carrying **the merge date**. A PR that takes three
weeks still gets the day it landed, because the tag is cut on the merge commit
and that is the version anyone installs.

A second release on the same day appends `-1`, `-2`: `2026.10.11-1`. The suffix
exists for same-day re-releases only — a fix that ships tomorrow gets tomorrow's
date, because a version is a date plus a tiebreaker, not an ordering.

## Order of operations

1. Merge the PR. `main` receives code only this way.
2. On `main`: bump `package.json`, update the version pins in `README.md` and
   `install.sh`, commit as `chore(release): <version> — <summary>`, push.
3. Tag the release commit — `git tag <version> -m "<version> — <summary>"` —
   and push the tag.
4. `gh release create <version>` with the title and notes below.
5. `npm pack`, then attach the tarball as a release asset:
   `gh release upload <version> <pkg>-<version>.tgz`

   **Not optional.** The documented install is the release tarball, and installing
   from the git URL leaves a package directory that is a symlink into npm's
   temporary cache pointing at a clone npm has already deleted — `doppler` then
   vanishes from `PATH`. Verified on npm 11.19.0, and committing `dist/` to the
   repository does not prevent it: the link is npm's, not the package's. The
   asset is the install.

Test counts used to close the re-release notes. They were dropped: a consumer
cannot act on them, and the number rots the moment someone skips a test.

## Title

```
<version> — <summary>
```

Lower case, no trailing full stop, a full sentence where it reads like one.
`2026.10.11 — live refresh, so a policy edit needs no restart`.

The commit subject already carries the same string. Keep them identical — the
commit is what `git log` shows and the release is what the releases page shows,
and a reader should not have to translate between them.

## Notes

Four sections, in this order. Drop a section only when it is genuinely empty —
an absent section reads as "nothing to say here", which is different from "not
applicable".

### What changed

The behaviour, in the reader's terms. One line per thing they would notice.

### Why

The mechanism, and enough of the evidence that they can check it. Measurements
with their conditions: *"measured against a real server: 104–254ms"*, not
*"fast"*. If a claim is measured, say what it was measured against.

### How to upgrade

```
npm install -g github:igorjpimenta/doppler-harness#<version>
doppler install opencode
```

Plus whatever the release actually requires of them — here, that one restart
loads the bridge and nothing after it needs one. A release note that omits this
leaves the reader guessing whether they have to restart.

### What it costs

The price to the reader, in their terms: what stops working, what is forgotten,
what is slower than before. This is the section people read after they have
already upgraded, and the one a changelog almost never has. If a release is free,
say so in one line rather than leaving it out.

## Publishing

Do not install-test from the git URL to check a release works. On npm 11 it
leaves a dangling link, so a test that appears to pass tells you nothing about
the published artifact. Install the asset you just uploaded, which is what users
will get.

Publish at the moment the tag ships. Backfilling releases afterwards makes the
releases page claim a dozen versions appeared on the day you got round to
writing them up, and a same-day re-release becomes indistinguishable from a
six-week-old one — which is the whole signal the version carries.