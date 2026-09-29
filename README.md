# doppler-harness

**One config root for every coding agent you use.** Keep your skills, agents,
hooks, and permission policy in one place (`~/.doppler`) and connect a harness
to it with a single CLI command. Native mechanisms only: no symlinks, no
copies to keep in sync.

OpenCode is the first supported harness. The design is not OpenCode-specific —
the policy engine knows nothing about any harness — so adding the next one means
writing a bridge, not a second implementation.

## Quick start

Requirements: macOS or Linux, `git`, Node 18+, and OpenCode installed.

```bash
git clone https://github.com/igorjpimenta/doppler-harness ~/.doppler
node ~/.doppler/bin/doppler.mjs install opencode
```

Restart OpenCode — done.

The npm package is not published yet; `install.sh` does the clone for you:

```bash
curl -fsSL https://raw.githubusercontent.com/igorjpimenta/doppler-harness/main/install.sh | bash -s -- opencode
```

To update: `node ~/.doppler/bin/doppler.mjs update` (pulls, then re-registers).

## The CLI

```
node ~/.doppler/bin/doppler.mjs install opencode     # connect
node ~/.doppler/bin/doppler.mjs update                # pull the root, re-register
node ~/.doppler/bin/doppler.mjs uninstall opencode    # disconnect
node ~/.doppler/bin/doppler.mjs version
```

If the OpenCode CLI is not on your `PATH`, Doppler looks in `~/.opencode/bin`;
otherwise point at it:

```bash
export OPENCODE_BIN=/path/to/opencode
```

## What you get

- **Skills** — every `skills/` directory in your root is registered through
  OpenCode's own `skills.paths`, scanned in place for `**/SKILL.md`. No copy, no
  re-install when you edit one.
- **Agents** — `~/.doppler/agents/*.md`, read at startup and injected as
  `doppler-<name>` subagents. Namespaced so a personal agent can never shadow a
  built-in (`build`, `plan`, `explore`, `general`) or collide with your own
  agents in `~/.config/opencode/agent/`.
- **Hooks** — a tiered guard (dangerous operations blocked with an explanation,
  judgment calls flagged), unbypassable attribution blockers, and
  trusted-source governance that gates every plugin install behind your
  approval.
- **Permissions** — your `policy/allowlist.json` is compiled into OpenCode's own
  permission engine at startup, so asks are real OpenCode prompts with the
  harness's own UI, not a hook pretending to be one.
- **Your OpenCode stays yours** — its private `agent/`, `skill/`, `command/`
  directories and everything else in your config keep working exactly as before.
  Doppler only ever *adds* to the config, and only ever appends a permission
  rule or a plugin entry; it never rewrites a value you set. Editing your
  `opencode.jsonc` comments is safe — the installer splices text rather than
  re-serialising the file.

## How it fits together

```
~/.doppler/                  your content — yours to edit
  hooks/*.mjs                the policy engine, one implementation
  policy/*.json              the rules, as data
  agents/*.md  skills/<n>/SKILL.md

package root
  opencode/doppler.js        the ONLY file that knows OpenCode exists
  bin/doppler.mjs            the installer
```

OpenCode has no declarative hook registration, so a plugin is the only place a
shared policy engine can reach the tool loop. That is the whole reason the
bridge exists, and it is why it stays thin: it translates OpenCode's vocabulary
(tool names, event names, which CLI verbs add a source) and execs your hooks.
It holds no policy of its own and imports nothing — it is loaded by OpenCode's
own loader, not installed into your `node_modules`, so a dependency would fail
to resolve at startup.

Everything is read in place. Editing a hook takes effect the next time OpenCode
starts; there is no build step, no cache to invalidate, and no install to
re-run.

## FAQ

**Does it need a restart?** Yes. OpenCode reads its config once at startup, so
a new hook, agent or skill needs a restart to bind. Nothing else does.

**How do I change the policy?** Edit `~/.doppler/policy/allowlist.json` (ask/allow
rules) or `~/.doppler/policy/guard-rules.json` (extra deny/ask rules). Both are
yours after first install. The shipped examples are the starting point:
`policy/*.example.json` in the package.

**Why is a judgment call reported as a block?** `guard.mjs` has two tiers: DENY
for things with a better alternative, ASK for judgment calls where you should
decide. OpenCode's plugin API cannot raise a permission prompt from a pre-tool
hook — only allow or block — so the ASK tier is reported as a block whose
message names the bypass. Re-run with `# bypass: <reason>` prefixed to the
command, or set `DOPPLER_BYPASS_GUARDS=1` for the session. The data-driven ASK
rules in `allowlist.json` are unaffected: those are compiled into OpenCode's
own permission engine and do prompt you.

**What does `uninstall` do?** Removes Doppler's `plugin` entry from your config
and tells you what it left alone. Your `hooks/` and `policy/` directories are
your files and are not touched; delete `~/.doppler` to remove everything.

**Is anything sent anywhere?** No. There is no network call in the installer or
the bridge.

## Development

Source of truth is a dev checkout; `~/.doppler` is a clone — never edit there.
Conventions: Angular commits with scopes; CalVer `YYYY.M.D` in
`package.json`; `main` receives code only via PRs.

```
node --test test/     # the config splicer
node --check hooks/<file>.mjs
```
