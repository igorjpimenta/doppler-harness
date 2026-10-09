# doppler-harness

One canonical config root serving many harnesses (OpenCode live) via native
mechanisms only — no symlinks, no maintained copies *of the config root*. The
package ships **no content**: the policy, the agents, the skills and the
permission rules all live in the personal root and are read in place, so
editing any of them takes effect in the running harness, with no re-install and
no restart.

## Commands

```
node bin/doppler.mjs install opencode     # scaffold personal root → register the bridge → verify
node bin/doppler.mjs update                # refresh the engine, re-register
node bin/doppler.mjs reload                # ask a running harness to re-read the root
node bin/doppler.mjs doctor                # is any of it actually working?
node bin/doppler.mjs uninstall opencode   # remove the bridge entry (personal root left alone)
node bin/doppler.mjs version

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
  package. It is the only file that knows OpenCode exists, and
  the only file typed against `@opencode-ai/plugin`.
- `bin/doppler.mjs` — the installer; the only entry point that touches harness
  config. `bin/jsonc.mjs` — the config splicer it uses.

The bridge is TypeScript, transpiled by Bun at plugin load. `bin/` is
JavaScript and cannot be otherwise: Node refuses to strip types for a file under
`node_modules`, so a TypeScript entry point cannot be `npm install`ed at all. The
bridge escapes that because OpenCode transpiles it with Bun, which has no such
restriction, and Node never loads it. Runtime imports stay `node:` builtins only;
`@opencode-ai/plugin` is imported for *types* and erased, so an OpenCode that
stopped shipping it could not break startup. Note that its published `Config`
type has no `skills` field at the version we target, though the harness reads
one — that single boundary is cast, and says so.

- `policy/*.example.*` — formats, instantiated to real filenames on first run.
  A reader that finds no policy file falls back silently, so the installer
  materialises these rather than leaving the examples in place.
- hooks, agents, skills — **not in the package at all.** They are the user's and
  live in the personal root; the bridge reads them at startup.

**The engine is never copied.** The registration points at the bridge inside the
package, so removing the package removes the engine. A copy under the personal
root is not an acceptable substitute for `node_modules` being repointed: it
outlives the package, and removal has to remove. The repointing risk is handled
by naming it instead — a repointed path fails `registered path resolves` and is
flagged as `registered path is inside node_modules`. `install` and `update` also
delete any engine file already sitting in the personal root, so a root written
by an earlier design is cleaned up rather than left able to keep enforcing.

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

### Live refresh

Hook bodies are exec'd per tool call, so they were always live. Everything else
the bridge delivers goes through the `config` hook, which OpenCode calls once per
instance and snapshots — so editing it used to mean a restart, which is the one
thing a live config root cannot ask of you.

The bridge therefore keeps a fingerprint of exactly the files that hook reads
(policy, agents, skills, the overlay roots, the instruction registration, and
hook *declarations* — not hook bodies, which are already live). A recursive
`fs.watch` on each of those roots asks for a comparison when something moves,
and the fingerprint decides what counts — so the event is a reason to look now
and never the reason a change applies. That split is measured, not assumed: Bun
1.3.14 delivers a watch event in ~11ms and coalesces hard (60 atomic saves in
9ms produced none, twice in three runs), while at editing cadence it delivered
all 30 of 30 across six runs. A design that trusted the event would have shipped
a policy that silently stopped applying after an editor's autosave. A 30s
comparison runs alongside as the backstop, which is also the whole mechanism
where a recursive watch is unavailable.

Every way a change can be held — the startup grace, the quiet window, a turn in
flight — schedules its own wake-up for the moment it expires. Without that, a
change arriving inside a window had nothing to release it and waited for the
backstop; measuring the real server turned up a 30s wait after a reload, which is
now pinned by a test.

The flush waits for an idle boundary, because a rebuild disposes the instance
and a dispose mid-turn kills the turn — a worse outcome than one stale rule.
`doppler reload` is the manual form of the same request, as a file in the root
rather than a call, because an external process cannot authenticate to a
desktop-app server and writing a credential to disk to work around that is a
worse trade. `DOPPLER_RELOAD=off` turns the automatic half off and leaves the
manual half working.

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
- Everything a `config` hook injects is snapshotted **once per instance**.
  `Config.state`, `Agent.state` and `Skill.state` are `InstanceState` caches
  keyed by directory, built on first touch; the hook itself is called once, when
  the plugin state is built. `Config.invalidate()` does not help — it clears the
  global *file* read cache, not the instance snapshot. So a running session
  cannot see an edit to a policy, agent, skill or instruction registration.
- **`POST /instance/dispose?directory=<dir>` is the refresh point.** It runs
  every registered disposer, which invalidates those caches, and the next
  request rebuilds them — config re-read from disk, the `config` hook re-run
  against it — in the same process. OpenCode does this to itself on
  `PATCH /config` and on `PATCH /global/config` when the write differs, and its
  TUI handles the resulting `server.instance.disposed` event by re-bootstrapping
  (`packages/tui/src/context/sync.tsx`), so it is a refresh the harness already
  survives. Verified against v1.18.32 by delivery: a pattern added to
  `allowlist.json` is absent from `GET /config` and present after a dispose.
  Costs: the instance's LSP and MCP restart, and in-memory "always allow"
  answers are dropped — so the bridge waits for an idle boundary.
- A desktop-app (and any password-set) server requires auth on that route.
  `PluginInput.serverUrl` plus `OPENCODE_SERVER_PASSWORD` /
  `OPENCODE_SERVER_USERNAME` are what the harness's own SDK client is built with,
  and are what the bridge reuses.
- A plugin **module** is cached by Bun for the life of the process
  (`PluginLoader.load` does a bare `import()` of the resolved entry, and its own
  comment notes Bun caches module resolution). A reload re-runs the factory
  function but does not re-read the file, so a change to the bridge itself needs
  a process restart. Everything the bridge *delivers* is unaffected by that.

## Conventions

- Commits: Angular convention **with scopes** — `feat(opencode):`,
  `fix(bridge):`, `chore(release):`, `docs(readme):`.
  - Versioning: CalVer `YYYY.M.D` in `package.json`; same-day re-releases append
    `-N`.
  - TypeScript for the bridge, built to `dist/doppler.js` by `npm run build`;
    `npm run prepare` builds on every install path. The `.ts` is the checked
    source and is never loaded; the `.js` is what runs, because plugins load
    under two runtimes — Bun in the TUI/CLI, Node in the desktop app's server —
    and Node refuses to strip types under `node_modules`. `erasableSyntaxOnly`
    is on, so no `enum`, no `namespace`, no parameter properties — those pass
    tsc and fail at runtime — and it also makes the build a pure type-erasure.
    `bin/` stays JavaScript for the same Node restriction. `noUncheckedIndexedAccess`
    is off on purpose: the splicer indexes character by character and the flag
    buries real errors under `string | undefined`.
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
