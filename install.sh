#!/usr/bin/env bash
# doppler-harness installer — safe to pipe:
#   curl -fsSL https://raw.githubusercontent.com/igorjpimenta/doppler-harness/main/install.sh | bash
# or to run with a harness to connect immediately:
#   … | bash -s -- opencode
#
# No sudo. Everything lives in ~/.doppler. Idempotent: re-running updates.
set -euo pipefail

DOPPLER_HOME="${DOPPLER_HOME:-$HOME/.doppler}"
DOPPLER_REPO="${DOPPLER_REPO:-https://github.com/igorjpimenta/doppler-harness.git}"
DOPPLER_BRANCH="${DOPPLER_BRANCH:-main}"

say() { printf '\033[36m[doppler]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[doppler]\033[0m %s\n' "$*" >&2; exit 1; }

command -v git  >/dev/null 2>&1 || die "git is required (https://git-scm.com)"
command -v node >/dev/null 2>&1 || die "Node.js 18+ is required (https://nodejs.org)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node.js 18+ required, found $(node -v)"
if [ -d "$DOPPLER_HOME/.git" ]; then
  say "updating existing root at $DOPPLER_HOME"
  git -C "$DOPPLER_HOME" pull --ff-only --quiet
elif [ -e "$DOPPLER_HOME" ]; then
  die "$DOPPLER_HOME exists and is not a git clone — move it aside or set DOPPLER_HOME"
else
  say "cloning doppler-harness → $DOPPLER_HOME"
  git clone --quiet --branch "$DOPPLER_BRANCH" "$DOPPLER_REPO" "$DOPPLER_HOME"
fi

say "installed: $(node "$DOPPLER_HOME/bin/doppler.mjs" version)"

  # The verbs are `install`/`uninstall` <harness>, so a bare harness name is
  # expanded to `install <name>` rather than forwarded and rejected as unknown.
  case "${1:-}" in
    install|uninstall|update|doctor|version|"")
      exec node "$DOPPLER_HOME/bin/doppler.mjs" "$@"
      ;;
    *)
      exec node "$DOPPLER_HOME/bin/doppler.mjs" install "$@"
      ;;
  esac

cat <<'EOF'

Connect a harness (restart it afterwards):

  node ~/.doppler/bin/doppler.mjs install opencode

Then write your first hook — nothing is enforced until you do. Copy
policy/hook.example.mjs into ~/.doppler/hooks/ and edit it.

Or install the CLI with npm, from git (the registry has no package yet):

  npm install -g github:igorjpimenta/doppler-harness#2026.9.29
  doppler install opencode

Docs: https://github.com/igorjpimenta/doppler-harness
EOF
