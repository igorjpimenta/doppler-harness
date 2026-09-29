# doppler-harness

One canonical config root serving many harnesses (OpenCode live) via native
mechanisms only — no symlinks, no maintained copies *of the config root*. The
package ships **no content**: the policy, the agents, the skills and the
permission rules all live in the personal root and are read in place, so
editing any of them takes effect on the next harness start with no re-install.

## Commands

```
node bin/doppler.ts install opencode     # scaffold personal root → register the bridge → verify
node bin/doppler.ts update                # refresh the engine, re-register
node bin/doppler.ts doctor                # is any of it actually working?
node bin/doppler.ts uninstall opencode   # remove the bridge entry (personal root left alone)
node bin/doppler.ts version

npm test                                    # the config splicer, agent parsing, bridge, installer
npm run typecheck
opencode debug config                      # verify discovery
opencode agent list | grep doppler-        # verify agents
```

## Architecture

One rule, and everything else follows from it: **the package contains no
content.** What ships is the bridge, the installer, and the rule *formats*.
A policy the user did not choose is not a policy, and one silently overwritten
on update is not theirs — so the first run seeds formats and stops there.

- `opencode/doppler.ts` — the bridge. Engine-owned, read in place from the
  package, never copied. It is the only file that knows OpenCode exists, and
  the only file typed against `@opencode-ai/plugin`.
- `bin/doppler.ts` — the installer; the only entry point that touches harness
  config. `bin/jsonc.ts` — the config splicer it uses.

The bridge is transpiled by Bun and the installer by Node's type stripping, so
both are `.ts` on disk with no build step. Runtime imports stay `node:` builtins
only; `@opencode-ai/plugin` is imported for *types* and erased, so an OpenCode
that stopped shipping it could not break startup. Note that its published
`Config` type has no `skills` field at the version we target, though the harness
reads one — that single boundary is cast, and says so.
- `policy/*.example.*` — formats, instantiated to real filenames on first run.
  A reader that finds no policy file falls back silently, so the installer
  materialises these rather than leaving the examples in place.
- hooks, agents, skills — **not in the package at all.** They are the user's and
  live in the personal root; the bridge reads them at startup.

The one copy the installer makes is the bridge itself, to
`~/.doppler/opencode/doppler.ts`. The path OpenCode is given must point at the
user's own directory, not at a `node_modules` npm can repoint on any reinstall:
such a registration survives the move and silently loads nothing, which is the
failure `doctor` exists to name. The copy is rewritten on every install and
update, so it cannot drift.

Runtime state (session state) and machine-local wiring (`opencode.json` in the
personal root) live in `~/.doppler`, never in this repo.

### Why doctor exists

Every way this can be installed but not working is silent: a registration
pointing at a file that is gone, a config OpenCode ignores, a hook that crashes,
an allowlist that will not parse. Each leaves the user's skills, agents,
permissions and policy undelivered with no error anywhere. `doctor` is the one
place each of those is named, and it must keep working when the install is
broken — which is why the OpenCode CLI is resolved lazily and a missing one is
reported rather than fatal.

### The hook protocol

Harness-neutral, and doppler's own rather than a copy of any harness's:

```
in    {"session_id":"…","tool":"bash","args":{"command":"…"}}
out   {"decision":"deny"|"ask","reason":"…"}     (no output = no opinion)
```

`tool` and `args` are OpenCode's vocabulary — lowercase tool names, camel-case
arg keys — and a bridge for another harness maps its names in. `source_patterns`
is in the payload for the same reason: which CLI verbs add a source is dialect,
so the bridge supplies its own set.

Every `.mjs` in the root's `hooks/` runs on every tool call, sorted by name, and
each decides for itself whether it has an opinion. The bridge has no table of
which hook handles which tool: that would put the engine's opinion about policy
back into the engine. `.example.mjs` is excluded — it is documentation.

Exit 0 always, including on internal error: a broken hook has no opinion, so a
bug in the engine cannot wedge every tool call. A non-zero exit is
indistinguishable from a hook that is not installed, so the bridge warns at
startup when it finds no hooks at all.

## OpenCode facts this design depends on

Prefer a native mechanism over a hook wherever one exists. Re-verify these
against the version you are targeting before relying on them — the commit
history of the initial import records how each was checked, and which of them
were checked by running rather than by reading.

- `plugin: ["file://<abs>"]` loads, and a plugin file needs no `package.json`
  beside it. `opencode plugin <module>` does **not** accept a file path — it
  runs a Bun install, so it is not a usable registration path.
- The `config` hook can inject `skills.paths` and `agent` entries, and both are
  picked up. `skills.paths` is the cleaner delivery mechanism of the two:
  skills are scanned in place, agents have to be read and re-injected because
  OpenCode has no `agents.roots`.
- `tool.execute.before` **throwing** blocks the call before it runs, and the
  model receives the message. This is the only reliable deny surface.
- `permission.ask` is declared in `@opencode-ai/plugin` but does **not** fire in
  a non-interactive run, where OpenCode auto-rejects instead. Do not build on
  it: asks go through `config.permission` so the harness runs its own prompt.
- `permission.*` is evaluated last-match-wins, so injected rules are appended
  after the user's own. Per-tool rules accept a string or `{pattern: action}`.
- The global config may be `opencode.json` **or** `opencode.jsonc`; both are
  read. Config is validated strictly — an unknown top-level key is a startup
  error, not a warning.

## Conventions

- Commits: Angular convention **with scopes** — `feat(opencode):`,
  `fix(bridge):`, `chore(release):`, `docs(readme):`.
- Versioning: CalVer `YYYY.M.D` in `package.json`; same-day re-releases append
  `-N`.
- TypeScript for the bridge only, and no build. `tsc --noEmit` is the check; the
  shipped file is what runs, types erased by Bun at load. `erasableSyntaxOnly`
  is on, so no `enum`, no `namespace`, no parameter properties — those pass tsc
  and fail at runtime, which is the whole failure mode here. `bin/` stays
  JavaScript because Node refuses to strip types under `node_modules`, so a
  TypeScript bin cannot be npm-installed at all. `noUncheckedIndexedAccess` is
  off on purpose: the splicer indexes character by character and the flag buries
  real errors under `string | undefined`.
- `main` receives code only via PRs. Every remote action — push, PR creation,
  merge — requires explicit owner approval before running.

## Known tier difference

A hook distinguishes DENY (a better alternative exists) from ASK (a judgment
call the owner should make). A pre-tool hook can only allow or block, so the
bridge reports ASK as a block whose message names the bypass, and honouring that
marker is the hook's job. The data-driven ASK rules in `allowlist.json` are
unaffected — they compile into `config.permission` and prompt for real. A
harness with a permission-request hook would recover the tier; OpenCode does not
have one.
