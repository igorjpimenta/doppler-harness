#!/usr/bin/env node
// doppler — installer CLI for the doppler-harness package.
//
// One repo, many harnesses. Each `install <harness>` wires that harness to the
// personal root (DOPPLER_HOME, default ~/.doppler) using ONLY native
// mechanisms — no symlinks, no maintained copies of the root itself.
//
//   opencode  a `plugin` entry in the user's own config pointing at the
//             bridge that ships in this package. The bridge is read IN PLACE
//             and is the only file that knows OpenCode exists; it injects the
//             personal root's skills, agents and compiled permissions, and
//             execs the personal root's hooks on every tool call. Editing a
//             hook takes effect on the next opencode start — nothing to
//             re-install, because nothing was ever copied.
//
// The engine lives in the package and nowhere else. Uninstalling the package
// therefore stops everything it did: there is no second copy of the bridge
// left in the personal root to keep enforcing.
//
// Usage:
//   doppler install opencode
//   node ~/.doppler/bin/doppler.mjs install opencode
//   doppler update                # pull the personal root, then re-register
//   doppler uninstall opencode
//   doppler version
import fs from "node:fs";
import os from "node:os";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { insertElement, removeWhere, stringElements, topLevelValueSpan } from "./jsonc.mjs";

// PKG = where this CLI (and the engine payload) lives — dev checkout, global
// npm install, or the ~/.doppler root itself. HOME = the personal root every
// harness wires to (always a fixed absolute path).
const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = process.env.DOPPLER_HOME || path.join(os.homedir(), ".doppler");

// Read from the package this file is running inside, not from a copy found
// elsewhere: a second install on the same machine must not be able to answer
// for this one. Node resolves symlinks before import.meta.url is read, so a
// linked install reports its real target rather than the link.
let PKG_VERSION = "unknown";
try {
  PKG_VERSION = JSON.parse(fs.readFileSync(path.join(PKG, "package.json"), "utf8")).version;
} catch {
  // package.json unreadable: the version is a nicety, the checks are not
}

// The bridge is registered from the package, read in place. It is the only file
// that knows a harness exists, so it belongs to the engine and stays where the
// engine is installed — one file, one source of truth, nothing to refresh, and
// nothing left behind to keep running after the package is removed.
//
// That places the registration inside a directory npm owns and may repoint on
// any reinstall, which would leave the entry naming a path with nothing at it.
// The entry is reported broken rather than allowed to sit there: doctor names
// `registered path resolves` for the missing file and
// `registered path is inside node_modules` for the directory that can move, so
// the cause and the fix are both on screen.
//
// A copy under the personal root is never the answer. It would answer the same
// repointing risk, and it outlives the package: removal has to remove.
// The bridge ships as built JavaScript in dist/, not as the .ts source it is
// checked as. Both runtimes that load plugins have to load the same file: the
// TUI's Bun strips types anywhere, but the desktop app's server is Node, and
// Node refuses to strip types for a file under node_modules — which is where a
// package install lives. Verified as the reason the app silently loaded no
// engine while the TUI gated fine.
const BRIDGE = path.join(PKG, "dist", "doppler.js");
const STALE_BRIDGE = path.join(HOME, "opencode", "doppler.ts");

// The bridge's declared id (opencode/doppler.ts exports it as a PluginModule).
// OpenCode loads every registered plugin and does not dedup by id, so "doppler
// is the secondary option" is this installer's check, not the harness's: before
// registering, load each existing plugin and read its id. A same-id plugin
// that is not the bridge itself means the user wrote a replacement and theirs
// is the primary — the bridge stays dormant. A plugin that cannot be loaded is
// not a match: fail open and register anyway, because an unreadable plugin must
// not block the install.
const BRIDGE_ID = "doppler";
async function hasSameIdPlugin() {
  const p = ocConfigPath();
  const cfg = readConfig(p);
  const span = topLevelValueSpan(cfg, "plugin");
  if (!span) return false;
  for (const e of stringElements(cfg, span)) {
    try {
      const spec = JSON.parse(e);
      const url = Array.isArray(spec) ? spec[0] : spec;
      if (typeof url !== "string" || !url.startsWith("file://")) continue;
      // The bridge's own entry, at any path: registering clears a stale one and
      // refreshes a current one, so it is never the "user wrote a replacement"
      // case — only a same-id plugin at a path that is not the bridge's is.
      if (isDoppler(e)) continue;
      const mod = await import(url);
      if (mod.default?.id === BRIDGE_ID) return true;
    } catch {
      // unreadable plugin: not a match, keep going
    }
  }
  return false;
}

const OC_CONFIG_DIR = path.join(os.homedir(), ".config", "opencode");

function packageJson() {
  return JSON.parse(fs.readFileSync(path.join(PKG, "package.json"), "utf8"));
}

// First-run scaffold: the personal root belongs to the user, and nothing in
// this package is content. hooks/, agents/ and skills/ are created empty and
// stay that way — the user writes the hooks, and the bridge execs whatever it
// finds there. Only the policy *format* examples are seeded, because a format
// with no example is not a format.
//
// Idempotent by construction rather than by a marker file: every step below is
// "create if absent", so re-running is a no-op. A marker in the personal root
// would be installer state living in the user's directory, gating nothing that
// a directory-existence check does not already gate.
function scaffold() {
  let first = false;
  for (const d of ["hooks", "agents", "skills", "policy"]) {
    const p = path.join(HOME, d);
    if (!fs.existsSync(p)) first = true;
    fs.mkdirSync(p, { recursive: true });
  }
  // Every policy file here is an example, and each becomes its real name on
  // first run: the reader looks for the plain name, so an untouched example
  // means the policy is inert rather than absent. The hook example goes to
  // hooks/ instead, and keeps its `.example` suffix — a hook is only policy once
  // the user renames it, and the bridge skips `.example.mjs` so seeding one
  // cannot enforce rules nobody chose.
  for (const f of fs.readdirSync(path.join(PKG, "policy"))) {
    if (f.endsWith(".example.mjs")) {
      const dst = path.join(HOME, "hooks", f);
      if (!fs.existsSync(dst)) { fs.copyFileSync(path.join(PKG, "policy", f), dst); first = true; }
    } else if (f.endsWith(".example.json")) {
      const dst = path.join(HOME, "policy", f.replace(".example", ""));
      if (!fs.existsSync(dst)) { fs.copyFileSync(path.join(PKG, "policy", f), dst); first = true; }
    }
  }
  return first ? "scaffolded" : "existing";
}

// Where the bridge should point, written on every run: the personal root is
// machine state, and a plugin gets no access to this installer's environment,
// so the resolved path has to be readable from disk. Not user content, so it
// is regenerated rather than gated behind the first-run marker.
function writeRootManifest() {
  fs.writeFileSync(path.join(HOME, "opencode.json"), JSON.stringify({
    _comment: "Generated by doppler install. Machine state, not user content: the bridge reads the personal root path from here. Edit freely — it is rewritten on every install.",
    home: HOME,
  }, null, 2) + "\n");
}

// An install from the copy-based design left the engine inside the personal
// root, and possibly a .js sibling from the release before that. Neither is
// loaded — the registration points at the package — but both answer to the name
// someone would look for, so a run that registers removes them.
function removeStaleBridgeCopies() {
  let removed = 0;
  for (const p of [STALE_BRIDGE, STALE_BRIDGE.replace(/\.ts$/, ".js")]) {
    try { fs.unlinkSync(p); removed += 1; } catch {}
  }
  return removed;
}

// OpenCode reads opencode.json and opencode.jsonc; a user is as likely to have
// the commented one, so never create the other spelling next to it.
function ocConfigPath() {
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const p = path.join(OC_CONFIG_DIR, name);
    if (fs.existsSync(p)) return p;
  }
  return path.join(OC_CONFIG_DIR, "opencode.json");
}

function readConfig(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
  }
}

// The bridge is registered by absolute file URL and read in place — the whole
// point is that nothing is copied into ~/.config/opencode. Percent-encode via
// pathToFileURL: a personal root containing a space is a valid path and an
// unencoded URL simply fails to load.
const entry = () => JSON.stringify(pathToFileURL(BRIDGE).href);

// Every spelling the engine has ever been registered under is ours to clear:
// dist/doppler.js is current; opencode/doppler.ts was the pre-dist bridge, in the
// package or copied into the personal root by the design before that. An entry
// left behind under an old spelling would keep pointing at a file a newer
// install is free to stop shipping, so register() removes them all first.
const isDoppler = (literal) => /\/(dist|opencode)\/doppler\.(mjs|ts|js)"?$/.test(literal);

function register() {
  const p = ocConfigPath();
  const before = readConfig(p);
  // Clear any previous entry first: the personal root can move, and a stale
  // URL would load a bridge pointing at a root that no longer exists.
  const cleared = removeWhere(before, topLevelValueSpan(before, "plugin"), isDoppler);
  const after = insertElement(cleared, topLevelValueSpan(cleared, "plugin"), "plugin", entry());
  if (after === before) return { path: p, changed: false };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, after);
  return { path: p, changed: true };
}

function unregister() {
  const p = ocConfigPath();
  const before = readConfig(p);
  const span = topLevelValueSpan(before, "plugin");
  if (!span) return { path: p, changed: false };
  const after = removeWhere(before, span, isDoppler);
  if (after === before) return { path: p, changed: false };
  fs.writeFileSync(p, after);
  return { path: p, changed: true };
}

// Resolved lazily, and allowed to be absent: `doctor` and `version` have to work
// precisely when the install is broken, so a missing CLI cannot exit(1) before
// they get a chance to explain it.
let ocCache;
function opencodeCli() {
  if (ocCache !== undefined) return ocCache;
  // Existence is checked, not just presence on PATH: OPENCODE_BIN is routinely
  // set to a path that has since been uninstalled, and doctor has to be able to
  // say "the CLI is gone" rather than report a command that cannot run.
  const usable = (p) => typeof p === "string" && p.length > 0 && fs.existsSync(p);
  if (usable(process.env.OPENCODE_BIN)) return (ocCache = process.env.OPENCODE_BIN);
  try {
    const w = execSync("which opencode", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    if (usable(w)) return (ocCache = w);
  } catch {}
  const fallback = path.join(os.homedir(), ".opencode", "bin", "opencode");
  return (ocCache = usable(fallback) ? fallback : null);
}

const sh = (cmd) => execSync(cmd, { stdio: ["ignore", "pipe", "inherit"] }).toString().trim();

// Registering is not the same as working, and the difference is invisible: a
// config OpenCode refuses to parse means the bridge never loads and every hook
// is silently inert. That is the one failure mode worth failing loudly on.
function verify() {
  const oc = opencodeCli();
  if (!oc) {
    // Registration still happened and is still correct; what is unverified is
    // whether OpenCode will accept the file. Saying so is enough — failing here
    // would make a working install look broken on a machine without the harness.
    console.warn("OpenCode CLI not found, so the config was written but not verified.");
    console.warn("  Run `doppler doctor` once OpenCode is installed.");
    return;
  }
  try {
    sh(`${oc} debug config`);
    console.log(`bridge registered in ${ocConfigPath()} — config parses, hooks are live.`);
    console.log("restart opencode (config is read once at startup).");
  } catch (e) {
    console.warn(`${ocConfigPath()} did not parse: ${String(e.message).split("\n")[0]}`);
    console.warn("  OpenCode will ignore it, so no doppler hooks will run. Fix the file, then re-run.");
    process.exitCode = 1;
  }
}

async function installOpencode() {
  console.log(`personal root: ${scaffold()} (${HOME})`);
  const stale = removeStaleBridgeCopies();
  if (stale) console.log(`removed ${stale} stale engine cop${stale === 1 ? "y" : "ies"} from the personal root`);
  writeRootManifest();
  if (await hasSameIdPlugin()) {
    console.log(`a plugin with id '${BRIDGE_ID}' is already registered — doppler's bridge stays dormant.`);
    return;
  }
  const r = register();
  console.log(`${r.changed ? "registered" : "already registered"}: ${r.path} → ${entry()}`);
  verify();
}

function uninstallOpencode() {
  const r = unregister();
  console.log(`${r.changed ? "removed" : "not present"}: doppler bridge entry in ${r.path}`);
  console.log(`left in place: ${path.join(HOME, "hooks")} and ${path.join(HOME, "policy")} — your files.`);
  console.log(`delete ${HOME} to remove the personal root entirely.`);
}

async function update() {
  if (fs.existsSync(path.join(HOME, ".git"))) sh(`git -C ${HOME} pull --ff-only`);
  else console.log(`${HOME} is not a git clone — nothing to pull (npm delivery model).`);
  writeRootManifest();
  // The engine is read from the package, so there is nothing to refresh and
  // nothing to re-sync: the registered path and the file behind it cannot
  // disagree, because they are the same file. Re-registering only picks up a
  // package that has moved — unless a same-id plugin already holds the slot.
  removeStaleBridgeCopies();
  if (await hasSameIdPlugin()) {
    console.log(`a plugin with id '${BRIDGE_ID}' is already registered — doppler's bridge stays dormant.`);
    return;
  }
  register();
  console.log(`updated to ${packageJson().version}`);
  console.log("restart opencode to pick it up.");
}

// --- doctor ------------------------------------------------------------------

// Every check answers one question: is anything actually being enforced? Each
// line is a place where "installed" and "working" can silently disagree, which
// is why this exists rather than trusting the installer to have worked.
function doctor() {
  let broken = 0;
  const ok = (label, detail) => console.log(`  ok    ${label}${detail ? ` — ${detail}` : ""}`);
  const bad = (label, detail, fix) => {
    broken += 1;
    console.log(`  FAIL  ${label} — ${detail}`);
    if (fix) console.log(`        fix: ${fix}`);
  };
  const warn = (label, detail) => console.log(`  warn  ${label} — ${detail}`);

  console.log(`personal root\n  ${HOME}`);
  if (!fs.existsSync(HOME)) {
    bad("root exists", "not found", "doppler install opencode");
  } else {
    ok("root exists");
  }

  // This is a declaration, not a check, and it cannot be one. A `doppler` that is
  // missing, is a symlink to something deleted, or is a different program
  // answering to the name never reaches any line below — there is no output to
  // read and no exit code to trust. The last of those is the dangerous one: it
  // can print "everything is fine" and exit 0. So there is nothing here for a
  // user with the wrong CLI to have failed; the only useful move is for the
  // right one to say who it is on its way past, and leave the comparison to them.
  //
  // A git checkout reports its branch because that is the case that reads as
  // correct while being wrong: an install linked to a dev checkout serves
  // whatever is checked out, so it can answer for a version never released.
  // Deliberately not a failure — a checkout on a branch is a deliberate state,
  // and failing on it would teach people to ignore the line that helps them.
  const rel = (p) => p.replace(os.homedir(), "~");
  let vcs = "";
  try {
    // `git -C PKG` searches upward, so a package nested inside an unrelated repo
    // — node_modules under someone's home dotfiles, or under /opt/homebrew — would
    // otherwise report that repo's branch as if it were the package's. The package
    // is a checkout only if it is itself the repository root.
    const top = execSync(`git -C ${JSON.stringify(PKG)} rev-parse --show-toplevel`, {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();
    if (path.resolve(top) === PKG) {
      const branch = execSync(`git -C ${JSON.stringify(PKG)} rev-parse --abbrev-ref HEAD`, {
        stdio: ["ignore", "pipe", "ignore"],
      }).toString().trim();
      if (branch && branch !== "HEAD") vcs = ` on ${branch}`;
    }
  } catch {
    // not a checkout, or no git
  }
  ok("cli", `${rel(PKG)}${vcs} — ${PKG_VERSION}`);

  // The bridge is read in place from the package. A missing one means the
  // install is broken, not half-finished, and nothing will load.
  if (fs.existsSync(BRIDGE)) ok("bridge file", BRIDGE);
  else bad("bridge file", `missing at ${BRIDGE}`, "doppler install opencode");

  // The registration is the thing that can go stale without anything moving.
  // Read with the splicer rather than JSON.parse: a config carrying comments is
  // the normal case, and JSON.parse would fail on it and report "no entry" for
  // an install that is fine.
  const cfg = ocConfigPath();
  const entries = stringElements(readConfig(cfg), topLevelValueSpan(readConfig(cfg), "plugin"));
  const literal = entries.find((e) => isDoppler(e));
  let registered = null;
  if (literal) {
    try {
      registered = fileURLToPath(JSON.parse(literal));
    } catch {
      registered = null;
    }
  }

  if (registered) {
    if (registered === BRIDGE) ok("registered in opencode config", registered);
    else bad("registered path is stale", `points at ${registered}, not ${BRIDGE}`, "doppler install opencode");
    if (!fs.existsSync(registered)) {
      bad("registered path resolves", `no such file: ${registered}`, "doppler install opencode");
    } else {
      ok("registered path resolves");
    }
    // npm owns its global install directory and may repoint it on any
    // reinstall, which would leave this entry naming a path with nothing at it.
    // Naming that is the difference between a fixable report and one that blames
    // the wrong thing — the entry is present and syntactically fine either way.
    if (registered.includes(`${path.sep}node_modules${path.sep}`)) {
      warn("registered path is inside node_modules", "npm can repoint that on reinstall; re-run doppler install opencode if it goes missing");
    }
  } else {
    bad("registered in opencode config", `no doppler entry in ${cfg}`, "doppler install opencode");
  }

  // Does OpenCode actually load it? An entry in a file it ignores is
  // indistinguishable from a working install until something needs it. Compared
  // as a path, because OpenCode echoes the plugin list back as strings and the
  // file URL's percent-encoding is not ours to predict.
  const oc = opencodeCli();
  if (!oc) {
    bad("opencode CLI", "not found", "install it, or set OPENCODE_BIN");
  } else {
    try {
      const resolved = JSON.parse(execSync(`${oc} debug config`, { stdio: ["ignore", "pipe", "ignore"] }).toString());
      const loaded = (resolved.plugin ?? []).some((p) => {
        try {
          return path.resolve(fileURLToPath(String(p))) === registered;
        } catch {
          return false;
        }
      });
      if (loaded) ok("opencode loads the bridge");
      else bad("opencode loads the bridge", "the entry is not in the resolved config", "doppler install opencode");
    } catch (e) {
      bad("opencode loads the bridge", String(e.message).split("\n")[0], `fix ${cfg}, then re-run`);
    }
  }

  // No hooks is a legitimate state, not a failure — but it is the one where the
  // user believes something is enforced and nothing is, so it is named.
  const hooksDir = path.join(HOME, "hooks");
  let hooks = [];
  try {
    hooks = fs.readdirSync(hooksDir).filter((f) => f.endsWith(".mjs") && !f.endsWith(".example.mjs")).sort();
  } catch {}
  if (hooks.length) ok("hooks", `${hooks.length}: ${hooks.join(", ")}`);
  else warn("hooks", `none in ${hooksDir}, so nothing is enforced — see the README`);

  // A hook that declares the patterns it may ask about gets them compiled into the
  // harness's own permission prompt, so the ask reaches the user without the model
  // in the loop. A declaration that does not parse is a prompt the author believes
  // is in force and is not, which is the silent half-enforcement this exists to
  // name — and an ask that reaches the model instead is worth naming too, because
  // it is reported as a block rather than a prompt.
  const declared = [];
  const badDecls = [];
  for (const h of hooks) {
    const decl = path.join(hooksDir, h.replace(/\.mjs$/, ".ask.json"));
    let parsed = null;
    let present = false;
    try {
      parsed = JSON.parse(fs.readFileSync(decl, "utf8"));
      present = true;
    } catch (e) {
      if (e.code !== "ENOENT") badDecls.push(`${h.replace(/\.mjs$/, ".ask.json")}: ${String(e.message).slice(0, 40)}`);
    }
    if (!present) continue;
    const ask = parsed?.ask;
    if (!Array.isArray(ask)) {
      badDecls.push(`${h.replace(/\.mjs$/, ".ask.json")}: no "ask" array`);
      continue;
    }
    const good = ask.filter((p) => typeof p === "string" && p);
    if (good.length !== ask.length) badDecls.push(`${h.replace(/\.mjs$/, ".ask.json")}: non-string pattern`);
    if (!good.length) badDecls.push(`${h.replace(/\.mjs$/, ".ask.json")}: declares nothing`);
    else declared.push(`${h} → ${good.join(", ")}`);
    // A hook runs before the harness settles a call's permission, so a hook that
    // answers `ask` for a declared pattern blocks the call before the prompt can
    // be raised. The user is asked in a block message the model carries, which is
    // the thing the declaration exists to avoid — and it happens silently, so it
    // is named here.
    const body = fs.readFileSync(path.join(hooksDir, h), "utf8");
    if (good.length && /["']ask["']/.test(body)) {
      badDecls.push(
        `${h} declares patterns and also answers ask — its block preempts the prompt; answer deny only`,
      );
    }
  }
  if (declared.length) ok("declared asks", `${declared.length}: ${declared.join("; ")}`);
  for (const b of badDecls) warn("ask declaration", `${b} — no prompt will be raised for it`);

  // A policy file that does not compile is the same shape of problem: the
  // bridge reads it at startup and finds nothing.
  const allowlist = path.join(HOME, "policy", "allowlist.json");
  if (!fs.existsSync(allowlist)) {
    warn("permission policy", "no allowlist.json, so no permission rules are applied");
  } else {
    try {
      const rules = JSON.parse(fs.readFileSync(allowlist, "utf8"));
      const n = (rules.ask ?? []).length + (rules.allow ?? []).length;
      ok("permission policy", `${n} bash rules, ${(rules.tools?.allow ?? []).length} tool rules`);
    } catch (e) {
      bad("permission policy", `malformed: ${e.message.slice(0, 60)}`, `fix ${allowlist}`);
    }
  }

  console.log();
  if (broken) {
    console.log(`${broken} problem${broken === 1 ? "" : "s"} found. Nothing is being enforced until they are fixed.`);
    process.exitCode = 1;
  } else {
    console.log("All checks passed.");
  }
}

const cmd = process.argv[2] ?? "help";
const target = process.argv[3];
const USAGE = "usage: doppler <install|uninstall> opencode | update | doctor | version";
if (cmd === "install" && target === "opencode") await installOpencode();
else if (cmd === "uninstall" && target === "opencode") uninstallOpencode();
else if (cmd === "update") await update();
else if (cmd === "doctor") doctor();
else if (cmd === "version") console.log(packageJson().version);
else {
  console.log(USAGE);
  // A name we do not serve is the case worth answering properly: the usage line
  // alone reads as a typo, when the honest answer is that the harness is not
  // supported yet and the work is in one commit away.
  if (target && target !== "opencode") {
    console.log(`\nopencode is the only supported harness right now. ${target} is not wired.`);
    console.log("See AGENTS.md for what a new one needs — it is a bridge, not a fork.");
  }
  process.exit(cmd === "help" ? 0 : 1);
}
