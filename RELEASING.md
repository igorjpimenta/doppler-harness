# Releasing

CalVer, one tag per release, and a note per release. The tag is the contract —
`npm install -g --install-links=true github:igorjpimenta/doppler-harness#<tag>`
resolves to it — so the version has to be decided before the tag is cut, not
after.

## Version

`YYYY.M.D` in `package.json`, carrying **the merge date**. A PR that takes three
weeks still gets the day it landed, because the tag is cut on the merge commit
and that is the version anyone installs.

`YYYY.M.D` is a stable release and the only one the versionless install ever
serves. A second release on the same day appends `-beta.N`: `2026.10.16-beta.1`.
It is a pre-release — marked `--prerelease` on GitHub and published off the
`latest` dist-tag — and exists for same-day rebuilds only; a fix that ships
tomorrow gets tomorrow's date, because a version is a date plus a tiebreaker,
not an ordering.

The suffix says `beta` rather than a bare `-N` because the version string has to
carry its own meaning: a rebuild that reached a real machine and broke does not
belong beside the stable of the same day in a `git ls-remote` listing or an
`npm view`, where nobody reads a flag. Semver also reads a suffix as a prerelease
and files it *below* its base, which is why the bare form showed up on the tag
page as if it were the older release; naming the lane removes the ambiguity
instead of relying on the UI to resolve it.

A `-beta.N` that turns out sound becomes the plain `YYYY.M.D` it was rehearsing
— same date, no suffix, stable — and the tag that carried the beta keeps its
place in history for anyone who pinned it.

## Tag names and npm versions are not the same names

A tag is the contract for `github:…#<tag>` and for a release's asset URLs, so a
tag is never renamed. The npm version is chosen independently — it has to be a
name the registry has never seen. Those two rules collide exactly once, when a
`-N` tag is republished under the `-beta.N` spelling: the registry forbids
reusing a version it has ever held, including one that was unpublished, so the
number can never go back.

The releases published before the `-beta.N` lane existed therefore read as
follows. Every `-beta.N` below was published from the tag beside it, with the
version stamped in; the tombstones are versions the registry will never accept
again.

| git tag | npm version | on npm |
|---|---|---|
| `2026.9.29` | `2026.9.29-beta.1` | yes |
| `2026.9.29-1` · `-2` · `-3` | — | never: their bridge is TypeScript, which Node cannot run |
| `2026.10.5` | `2026.10.5-beta.1` | yes |
| `2026.10.7` | `2026.10.7-beta.1` | yes |
| `2026.10.8` | `2026.10.8-beta.1` | yes |
| `2026.10.11` · `2026.10.14` · `2026.10.16` | same | yes, `latest` |
| `2026.10.15` | `2026.10.15-beta.4` | yes |
| `2026.10.15-1` | `2026.10.15-beta.5` | yes |
| `2026.10.15-2` | `2026.10.15-beta.6` | yes — the build with the loader fix |
| — | `2026.10.15-beta.1` · `.2` · `.3` | no — tombstoned by the first naming attempt |

Check a name against both before publishing: `npm view <pkg> time` lists
tombstones that `npm view <pkg> versions` omits, and a tombstone is what makes
`npm publish` answer *Cannot publish over previously published version*.

## Order of operations

1. Merge the PR. `main` receives code only this way.
2. On `main`: bump `package.json`, update the version pins in `README.md` and
   `install.sh`, commit as `chore(release): <version> — <summary>`, push.
3. Tag the release commit — `git tag <version> -m "<version> — <summary>"` —
   and push the tag.
4. `gh release create <version>` with the title and notes below. For a `-beta.N`,
   add `--prerelease`: it renders the amber badge and keeps GitHub's `latest`
   marker on the newest stable, which is the same answer npm's dist-tag gives,
   so `releases/latest/download/…` and `npm i -g` cannot disagree about what
   "latest" means.
5. `npm pack`, then attach the tarball twice — once named for the version, once
   under the stable alias — and upload both:
   ```bash
   gh release upload <version> <pkg>-<version>.tgz
   cp <pkg>-<version>.tgz igorjpimenta-doppler-harness.tgz
   gh release upload <version> igorjpimenta-doppler-harness.tgz
   ```

   **Not optional.** The version-named asset is the flag-free, git-free install,
   and it is also what an install test has to exercise, since that is what the
   flag-free reader gets. The alias asset is what makes the versionless
   `releases/latest/download/igorjpimenta-doppler-harness.tgz` URL work — GitHub
   resolves that URL against the asset NAME, so an alias-less release silently
   keeps serving the previous release's tarball, and `doppler update` would then
   offer a stale engine as the newest one. A release without the alias is
   invisible to every default install.

   The git-URL install needs `--install-links=true` to work at all: npm defaults
   `install-links` to `false`, so a global install from a git URL leaves a
   package directory that is a symlink into npm's temporary cache pointing at a
   clone npm has already deleted — `doppler` then vanishes from `PATH`. It is
   npm's own default, unchanged across npm 8 through 11, and nothing in the
   package can set it (npm/cli#6984).

6. Publish to npm, from the tagged tree: `npm publish`. This is what makes
   `npm install -g @igorjpimenta/doppler-harness` mean "the newest release" with
   no version in the command — npm's `latest` dist-tag is the registry's answer
   to the question the alias asset answers on GitHub, and it is native rather
   than maintained by hand. Requires npm auth on the publishing machine
   (`npm whoami`; a token via `NPM_TOKEN` in `.npmrc` is the CI form). A version
   already on the registry cannot be replaced, so a broken publish is fixed by
   cutting the next release, never by re-publishing this one.

   The dist-tag follows the version's role, not the calendar: a plain dated
   release publishes to `latest` (`publishConfig.tag`), and a `-beta.N`
   publishes under `--tag beta`, so `@latest` keeps pointing at the newest
   *stable* release. That mirrors what `doppler update` already refuses to do on
   its own — it will not install a rebuild over its base automatically — and it
   keeps semver's "a suffix is a prerelease" reading from demoting the whole day
   to a beta.

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
npm install -g --install-links=true github:igorjpimenta/doppler-harness#<version>
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

Do not install-test from the git URL to check a release works. It builds a
different artifact from the one a flag-free reader gets, and omitting the flag
leaves a dangling link, so a test that appears to pass tells you nothing about
the published package. Install the asset you just uploaded.

Publish at the moment the tag ships. Backfilling releases afterwards makes the
releases page claim a dozen versions appeared on the day you got round to
writing them up, and a same-day re-release becomes indistinguishable from a
six-week-old one — which is the whole signal the version carries.