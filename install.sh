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
command -v node >/dev/null 2>&1 || die "Node.js 22.18+ is required (https://nodejs.org)"
# 22.18 is the first release that runs TypeScript without a flag. The installer
# is a .ts file shipped as-is, so below this it will not start at all — better to
# say so here than to fail with a syntax error on a type annotation.
NODE_OK="$(node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)' 2>/dev/null && echo yes || echo no)"
[ "$NODE_OK" = yes ] || die "Node.js 22.18+ required (the installer is TypeScript), found $(node -v 2>/dev/null || echo none)"

if [ -d "$DOPPLER_HOME/.git" ]; then
  say "updating existing root at $DOPPLER_HOME"
  git -C "$DOPPLER_HOME" pull --ff-only --quiet
elif [ -e "$DOPPLER_HOME" ]; then
  die "$DOPPLER_HOME exists and is not a git clone — move it aside or set DOPPLER_HOME"
else
  say "cloning doppler-harness → $DOPPLER_HOME"
  git clone --quiet --branch "$DOPPLER_BRANCH" "$DOPPLER_REPO" "$DOPPLER_HOME"
fi

say "installed: $(node "$DOPPLER_HOME/bin/doppler.ts" version)"

if [ "$#" -gt 0 ]; then
  exec node "$DOPPLER_HOME/bin/doppler.ts" "$@"
fi

cat <<'EOF'

Connect a harness (restart it afterwards):

  node ~/.doppler/bin/doppler.ts install opencode

Then write your first hook — nothing is enforced until you do. Copy
policy/hook.example.mjs into ~/.doppler/hooks/ and edit it.

Or install the CLI with npm, from git (the registry has no package yet):

  npm install -g github:igorjpimenta/doppler-harness#2026.9.29
  doppler install opencode

Docs: https://github.com/igorjpimenta/doppler-harness
EOF
