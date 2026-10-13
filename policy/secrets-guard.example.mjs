#!/usr/bin/env node
// Example doppler hook: a sensitive-path guardrail.
//
// Copy into `~/.doppler/hooks/` as `secrets-guard.mjs` — the `.example` suffix
// is what keeps it inert, because the bridge skips those, and a hook is only
// policy once you name it. Then edit the lists to match what your machine holds.
//
// Why it exists: `policy/allowlist.json` sets `external_directory: allow`, so
// any path outside the project root is reachable without a prompt. This is the
// compensating control — it reads every path-bearing tool call and denies the
// ones that land on credentials.
//
// Scope: DENY only. A pre-tool hook cannot prompt, and an ask arrives as a
// block anyway, so a guardrail that only asks trains the model to retry. Deny is
// the honest tier here.
//
// Bypass: `# bypass: <reason>` on the command, or DOPPLER_BYPASS_GUARDS=1.
// Reading your own SSH key is legitimate; the point is that it is your decision,
// not one an agent makes silently on your behalf.
//
// Protocol (doppler's own): JSON on stdin, a decision on stdout, exit 0 always.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();

// Whole directories. Matched as a path prefix after normalisation, so
// `~/.ssh/config` is caught by `~/.ssh` and `/tmp/x/../.ssh` by `~/.ssh`.
const DENY_DIRS = [
  "~/.ssh",
  "~/.gnupg",
  "~/.aws",
  "~/.kube",
  "~/.gcloud",
  "~/.azure",
  "~/.config/gcloud",
  "~/.docker",
  "~/.password-store",
  "~/Library/Keychains",
  "~/.local/share/keyrings",
];

// Individual files. Matched on basename anywhere in the tree, because a
// credential's location is not predictable but its name usually is.
const DENY_BASENAMES = [
  ".netrc",
  "_netrc",
  ".git-credentials",
  ".npmrc",
  ".pypirc",
  ".htpasswd",
  ".zsh_history",
  ".bash_history",
  ".python_history",
  "credentials",
  "credentials.json",
  "auth.json",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "cookies.sqlite",
  "login data",
  "cookies",
];

const DENY_SUFFIXES = [".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".asc", ".gpg"];

// `*.env` variants, but not the committed templates that are meant to be read.
const ENV_FILE = /^\.env(\..+)?$/;
const ENV_ALLOWED = /^\.env\.(example|sample|template|dist|defaults)$/i;

function expand(p) {
  if (p === "~") return HOME;
  if (p.startsWith("~/")) return path.join(HOME, p.slice(2));
  return p;
}

function deny(reason) {
  process.stdout.write(JSON.stringify({ decision: "deny", reason }));
  process.exit(0);
}

function noOpinion() {
  process.exit(0);
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// Strip glob metacharacters so `~/.ssh/*` normalises to the `~/.ssh` prefix
// that DENY_DIRS matches on. Anything exotic is left alone and simply fails to
// match, which is the safe direction: an unmatched glob prompts nothing here,
// but the harness still applies its own permission rules.
function stripGlob(p) {
  let out = "";
  for (const ch of p) {
    if ("*?[{".includes(ch)) break;
    out += ch;
  }
  return out.replace(/\/+$/, "") || "/";
}

function isDenied(rawPath) {
  if (!rawPath || typeof rawPath !== "string") return null;
  if (rawPath === "~" || rawPath === "~/") return "the whole home directory is not a file.";
  // `~/` is shorthand for an absolute path, not a category of its own. Denying
  // it outright would deny the user's own projects and configuration along with
  // `~/.ssh`, and a guardrail that fires on ordinary work teaches people to reach
  // for the bypass — after which it protects nothing. Expand it and judge it by
  // the same rules as any other path.
  const abs = rawPath.startsWith("~/") ? path.normalize(expand(rawPath)) : rawPath;
  if (!path.isAbsolute(abs)) return null; // relative: resolved against an unknown cwd

  const base = path.basename(abs);

  for (const dir of DENY_DIRS) {
    const d = path.normalize(expand(dir));
    if (abs === d || abs.startsWith(d + path.sep)) {
      return `\`${rawPath}\` is inside ${dir}, which holds credentials and key material.`;
    }
  }

  if (DENY_BASENAMES.includes(base.toLowerCase())) {
    return `\`${base}\` is a credential store, not source.`;
  }

  if (DENY_SUFFIXES.some((s) => base.toLowerCase().endsWith(s))) {
    return `\`${base}\` looks like key material (*${DENY_SUFFIXES.find((s) => base.toLowerCase().endsWith(s))}).`;
  }

  if (ENV_FILE.test(base) && !ENV_ALLOWED.test(base)) {
    return `\`${base}\` holds secrets. Commit a \`.env.example\` instead and read that.`;
  }

  return null;
}

// A recursive search is an oracle: `grep -r` and `rg` read every file under the
// root, so a `.env` or a private key is returned in a match line even though no
// credential path appears anywhere in the command. Path inspection cannot see
// that, so a search rooted at a directory that can hold secrets is denied
// outright rather than judged file-by-file.
const SEARCH_VERBS = /\b(grep|egrep|fgrep|rg|ag|ack|silversearcher|find|fd)\b/;
const RECURSIVE_FLAG = /(^|\s)(-\w*[rR]|--recursive|--hidden|--no-ignore)(\s|$|=)/;
// `rg`, `ag`, `ack`, `fd` and `find` walk the tree by default; `grep` needs an
// explicit recursive flag.
const IMPLICITLY_RECURSIVE = /\b(rg|ag|ack|silversearcher|fd|find)\b/;

// The personal root holds this hook, the policy, the agents and the skills — the
// user's own configuration, not a secret store. Recursing it is the ordinary way
// to find out what is in there, so it is exempt.
const PERSONAL_ROOT = process.env.DOPPLER_HOME || path.join(HOME, ".doppler");

function isSecretBearingRoot(p) {
  const abs = path.normalize(expand(p));
  if (isDenied(abs)) return true;
  if (abs === PERSONAL_ROOT || abs.startsWith(PERSONAL_ROOT + path.sep)) return false;
  if (abs === HOME) return true;
  if (abs === "/tmp" || abs.startsWith("/tmp/") || abs === "/private/tmp") return true;
  if (abs === "/etc" || abs.startsWith("/etc/")) return true;
  // A hidden directory sitting directly in the home directory is where
  // credentials conventionally live — `~/.ssh`, `~/.aws`, `~/.config`. One
  // further down is a project that chose to be hidden, and denying every path
  // beneath the home directory would make this unreadable rather than strict.
  const rel = abs.startsWith(HOME + path.sep) ? abs.slice(HOME.length + 1) : null;
  if (rel && !rel.includes(path.sep)) return rel.startsWith(".");
  return false;
}

function recursiveSearchReason(cmd) {
  if (!SEARCH_VERBS.test(cmd)) return null;
  const recursive = IMPLICITLY_RECURSIVE.test(cmd) || RECURSIVE_FLAG.test(cmd);
  if (!recursive) return null;

  for (const m of cmd.matchAll(/(?:^|\s)(~?\/[^\s'"();|&]*)/g)) {
    const root = m[1].replace(/\/+$/, "") || "/";
    if (isSecretBearingRoot(root)) {
      return (
        `Recursive search rooted at \`${root}\` would read every file beneath it, ` +
        "including credentials (.env, private keys, .netrc) that never appear in the " +
        "command text. Scope the search to a specific subdirectory, or read the files " +
        "you actually need by path — the read tool is checked against this guardrail."
      );
    }
  }
  return null;
}

// Every path-ish argument a tool might carry. An unrecognised tool returns an
// empty list and costs nothing.
function candidatePaths(tool, args) {
  const out = [];
  const push = (v) => {
    if (typeof v === "string" && v) out.push(v);
  };

  if (tool === "bash") {
    const cmd = args.command ?? "";
    if (process.env.DOPPLER_BYPASS_GUARDS === "1") noOpinion();
    if (/^\s*#\s*bypass:/mi.test(cmd)) noOpinion();
    const searchReason = recursiveSearchReason(cmd);
    if (searchReason) deny(searchReason);
    // Absolute paths and ~/ paths mentioned anywhere in the command.
    for (const m of cmd.matchAll(/(?:^|[\s'"(=])(~?\/[^\s'"();|&<>*]*)/g)) push(m[1]);
    return out;
  }

  if (tool === "read" || tool === "edit" || tool === "write" || tool === "patch") {
    push(args.filePath);
    push(args.path);
  }

  if (tool === "glob" || tool === "grep" || tool === "list" || tool === "search") {
    // `pattern` is a glob/regex, so only its leading literal path is meaningful.
    const raw = args.pattern ?? args.path ?? "";
    if (typeof raw === "string" && raw && (raw.startsWith("/") || raw.startsWith("~/"))) {
      push(stripGlob(raw));
    }
  }

  return out;
}

function main() {
  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    noOpinion();
  }

  const tool = payload.tool ?? "";
  const args = payload.args ?? {};

  for (const p of candidatePaths(tool, args)) {
    const reason = isDenied(p);
    if (reason) deny(reason);
  }

  noOpinion();
}

main();