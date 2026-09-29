# doppler-harness

One canonical config root serving many harnesses (OpenCode live) via native
mechanisms only — no symlinks, no maintained copies *of the config root*. The
policy engine is harness-agnostic by construction: nothing under `hooks/` or
`policy/` names a harness, and everything is read in place, so editing a hook
takes effect on the next harness start with no re-install.

## Commands

```
node bin/doppler.mjs install opencode     # scaffold personal root → register the bridge → verify
node bin/doppler.mjs update                # pull the personal root, re-register
node bin/doppler.mjs uninstall opencode   # remove the bridge entry (personal root left alone)
node bin/doppler.mjs version

node --test test/                          # the config splicer, agent parsing, hook decisions
node --check hooks/<file>.mjs
opencode debug config                      # verify discovery
opencode agent list | grep doppler-        # verify agents
```

## Architecture

What ships in the package is deliberately narrow: the policy engine, the bridge
that speaks one harness's dialect, and the rule formats. Content the user
authors — agents, personal skills, their own hook edits — is never in this repo.

- `hooks/` — the standard hook set, shipped as **generalist defaults** (guard,
  attribution blockers, permission policy, source-guard, session-init). The
  installer copies them into the personal root once, on first run; after that
  they are the user's files.
- `policy/` — policy data. `source-allowlist.json`: trusted source patterns.
  `allowlist.example.json` / `guard-rules.example.json`: rule formats,
  instantiated to real filenames on first run. A reader that finds no policy
  file falls back silently, so the installer materialises these rather than
  leaving the examples in place.
- `opencode/doppler.js` — the bridge. Engine-owned, read in place from the
  package, never copied. It is the only file that knows OpenCode exists.
- `bin/doppler.mjs` — the installer; the only entry point that touches harness
  config. `bin/jsonc.mjs` — the config splicer it uses.
- `agents/`, `skills/` — deliberately absent from the package. They are the
  user's and live in the personal root; the bridge reads them at startup.

Runtime state (session state) and machine-local wiring (`opencode.json` in the
personal root) live in `~/.doppler`, never in this repo.

### The hook protocol

Harness-neutral, and doppler's own rather than a copy of any harness's:

```
in    {"session_id":"…","tool":"bash","args":{"command":"…"}}
out   {"decision":"deny"|"ask","reason":"…"}     (no output = no opinion)
```

`tool` and `args` are OpenCode's vocabulary — lowercase tool names, camel-case
arg keys — and a bridge for another harness maps its names in. `source-guard.mjs`
additionally takes `source_patterns` in the payload for the same reason: which
CLI verbs add a source is dialect, and the hook carries the OpenCode set only as
a default for standalone use.

Exit 0 always, including on internal error: a broken hook has no opinion, so a
bug in the engine cannot wedge every tool call.

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
  `fix(hooks):`, `chore(release):`, `docs(readme):`.
- Versioning: CalVer `YYYY.M.D` in `package.json`; same-day re-releases append
  `-N`.
- `main` receives code only via PRs. Every remote action — push, PR creation,
  merge — requires explicit owner approval before running.

## Known tier difference

`guard.mjs` distinguishes DENY (a better alternative exists) from ASK (a
judgment call the owner should make). A pre-tool hook can only allow or block,
so the bridge reports ASK as a block whose message names the bypass. The
data-driven ASK rules in `allowlist.json` are unaffected — they compile into
`config.permission` and prompt for real. A harness with a permission-request
hook would recover the tier; OpenCode does not have one.
