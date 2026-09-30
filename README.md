# doppler-harness

**One config root for every coding agent you use.** Keep your skills, agents,
hooks, and permission policy in one place (`~/.doppler`) and connect a harness
to it with a single CLI command. Native mechanisms only: no symlinks, no
copies to keep in sync.

OpenCode is the first supported harness. The design is not OpenCode-specific —
the policy engine knows nothing about any harness — so adding the next one means
writing a bridge, not a second implementation.

## Quick start

Requirements: macOS or Linux, Node 18+, `git`, and OpenCode installed.

```bash
npm install -g github:igorjpimenta/doppler-harness#2026.9.29-1
doppler install opencode
```

Restart OpenCode, then write your first hook — nothing is enforced until you do.

The package is not on the npm registry yet, so install it from git. Pin the tag
or a commit; `main` will move. `install.sh` is the same thing as a plain clone:

```bash
curl -fsSL https://raw.githubusercontent.com/igorjpimenta/doppler-harness/main/install.sh | bash -s -- opencode
```

or clone by hand and call the script directly:

```bash
git clone https://github.com/igorjpimenta/doppler-harness ~/.doppler
node ~/.doppler/bin/doppler.mjs install opencode
```

**If something has gone quiet, run `doppler doctor`.** It checks each place
where "installed" and "working" can disagree — the bridge, the registration, and
whether OpenCode actually loaded it — and says which one is broken. A hook that
crashes, a policy that will not parse and a path that no longer exists are all
silent at runtime; doctor is where they are not.

## The CLI

```
doppler install opencode      # scaffold the personal root, register the bridge, verify
doppler update                # refresh the engine, re-register (and pull, under a clone install)
doppler doctor                # check that it is actually working
doppler uninstall opencode    # remove the bridge entry; your files stay
doppler version               # 2026.9.29-1
doppler                       # usage
```

Installed with npm the command is `doppler`. Installed by cloning, it is
`node ~/.doppler/bin/doppler.mjs` — the same program.

`install` is idempotent: re-running it refreshes the engine and the config entry
and never touches what you have written. It also repairs a registration left
pointing at an older location.

`install` and `uninstall` take `opencode` and nothing else — asking for a
harness that is not wired tells you so rather than printing usage and exiting.

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
- **Hooks** — *yours to write.* The bridge runs every `.mjs` in your root's
  `hooks/` on every tool call. A working example ships as
  `policy/hook.example.mjs`; nothing is enforced until you have one. See
  [Writing a hook](#writing-a-hook).
- **Permissions** — your `policy/allowlist.json` is compiled into OpenCode's own
  permission engine at startup, so asks are real OpenCode prompts with the
  harness's own UI, not a hook pretending to be one. Patterns are globs and are
  passed through verbatim, so a rule cannot be silently mistranslated into
  something that no longer matches.
- **Your OpenCode stays yours** — its private `agent/`, `skill/`, `command/`
  directories and everything else in your config keep working exactly as before.
  Doppler only ever *adds* to the config, and only ever appends a permission
  rule or a plugin entry; it never rewrites a value you set. Editing your
  `opencode.jsonc` comments is safe — the installer splices text rather than
  re-serialising the file.

## How it fits together

```
~/.doppler/                       everything here is yours
  hooks/*.mjs                     the policy, one file per rule
  policy/allowlist.json           permission rules, as data
  policy/guard-rules.json         extra rules, if a hook reads them
  policy/source-allowlist.json    trusted sources
  agents/*.md   skills/<n>/SKILL.md
  opencode.json                   generated: where the root is

package root
  opencode/doppler.ts             the ONLY file that knows OpenCode exists
  bin/doppler.mjs                 the installer
  policy/*.example.*              formats, seeded on first run
```

The package ships no content. `install` creates the directories, seeds the
policy *formats*, and registers the bridge; everything else is yours to write.
That is one rule with a reason: a policy you did not choose is not a policy, and
one that is silently overwritten on update is not yours either.

**The engine has no copy.** The registration points at the bridge where the
package is installed, and the personal root holds only your files. Uninstall the
package and the engine goes with it — there is no second copy left behind to keep
enforcing.

That does mean the registration sits in a directory npm owns, which npm may
repoint on any reinstall. When that happens the entry names a path with nothing
at it, and `doppler doctor` says so: `registered path resolves` fails, and a
warning flags that the entry is inside `node_modules`. One `doppler install
opencode` points it back at the package. An engine file left in your root by an
older install is removed the next time you install or update.

**Nothing is enforced until you write a hook.** A fresh install registers the
bridge, which delivers your skills, agents and permission rules, and warns once
that no hooks exist. That is the expected first run, not a broken one.

## Writing a hook

Copy `policy/hook.example.mjs` into `~/.doppler/hooks/`, rename it to whatever
you like, and edit. Every `.mjs` in that directory runs on every tool call, in
filename order, and each decides for itself whether it has an opinion.

```
in    {"session_id":"…","tool":"bash","args":{"command":"…"}}
out   {"decision":"deny"|"ask","reason":"…"}    (no output = no opinion)
```

`tool` and `args` are OpenCode's vocabulary — `bash`, `read`, `webfetch`, and
camel-case arg keys like `command` and `filePath`.

**Two tiers.** `deny` is for anything with a better alternative, and it is
final. `ask` is for judgment calls you should make. A pre-tool hook cannot
prompt, so the bridge reports an `ask` as a block whose message names a
`# bypass:` marker — honour it in your hook or that message is a lie, and the
model will retry a command that can never run.

**Exit 0 always**, including on internal errors. A hook that crashes has no
opinion, and that is what stops one bug from wedging every tool call in every
session. A non-zero exit is indistinguishable from a hook that is not installed.

Both properties are load-bearing enough that the bridge reports at startup
whether it found any hooks at all.

## FAQ

**Does it need a restart?** Yes. OpenCode reads its config once at startup, so
a new hook, agent or skill needs a restart to bind. Nothing else does.

**How do I change the policy?** Edit `~/.doppler/policy/allowlist.json` for
permission rules, or add a `.mjs` to `~/.doppler/hooks/` for anything else. Both
are seeded from the package's `policy/*.example.*` formats on first install and
are yours from then on.

**Why is a judgment call reported as a block rather than a prompt?** OpenCode's
plugin API cannot raise a permission prompt from a pre-tool hook — only allow or
block. So your hook's `ask` becomes a block whose message names the bypass, and
enforcing that bypass is your hook's job. The data-driven `ask` rules in
`allowlist.json` are unaffected: those compile into OpenCode's own permission
engine and prompt you for real.

**What does `uninstall` do?** Removes Doppler's `plugin` entry from your config
and tells you what it left alone. Your `hooks/` and `policy/` directories are
your files and are not touched; delete `~/.doppler` to remove everything.

**Is anything sent anywhere?** No. There is no network call in the installer or
the bridge.

## Development

Source of truth is a dev checkout; `~/.doppler` is installed from it and is
copied — never edit there. Conventions: Angular commits with scopes; CalVer
`YYYY.M.D` in `package.json`, with a `-N` suffix for a same-day re-release;
`main` receives code only via PRs.

```
npm test         # 64 tests: the splicer, agent parsing, bridge, installer
npm run typecheck
```

The bridge is TypeScript and is the only file typed against
`@opencode-ai/plugin`; OpenCode transpiles it with Bun at load. There is no build
step and no `dist/`, so there is nothing to go stale.

The installer and the config splicer are JavaScript, and that is not a
preference. Node refuses to strip types for files under `node_modules`, so a
TypeScript entry point cannot be `npm install`ed at all — the documented install
  path would fail on every machine. The bridge escapes this only because OpenCode
  transpiles it with Bun, which has no such restriction, and it is never handed to
  Node.

