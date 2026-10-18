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
//             hook is live on the next tool call; editing a policy, agent or
//             skill makes the bridge ask OpenCode to rebuild the session's
//             config at the next idle moment. Nothing to re-install, because
//             nothing was ever copied.
//
// The engine lives in the package and nowhere else. Uninstalling the package
// therefore stops everything it did: there is no second copy of the bridge
// left in the personal root to keep enforcing.
//
// Usage:
//   doppler install opencode
//   node ~/.doppler/bin/doppler.mjs install opencode
//   doppler update                # refresh the engine to the latest release, re-register (and pull, under a clone install)
//   doppler reload                # ask a running opencode to re-read the root
//   doppler uninstall opencode
//   doppler version
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { execSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { insertElement, removeWhere, stringElements, topLevelValueSpan } from "./jsonc.mjs";
import { isNewerRelease, newestInstallable, newerTag, parseTag, tagsFromLsRemote } from "./update-core.mjs";

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
// package install lives.
const BRIDGE = path.join(PKG, "dist", "doppler.js");
const STALE_BRIDGE = path.join(HOME, "opencode", "doppler.ts");

// The plugin loader, same rule as the bridge: built JavaScript in this package,
// registered by absolute file URL, read in place, never copied into the root —
// removal has to remove, and a copy under the root would outlive the package.
// It is what makes the personal root's own plugins loadable at all: OpenCode
// builds its plugin list from the config file and the plugin directories before
// any plugin runs, so no plugin (the bridge included) can add to that list, and
// the root cannot occupy any of those locations without a copy.
const LOADER = path.join(PKG, "dist", "loader.js");
// What the loader wrote about the last session's load, so `doppler plugin
// status` can answer the question the config cannot: did anything actually run?
const PLUGIN_REPORT = path.join(HOME, "plugins.loaded.json");

// Same hash the bridge writes of itself at load (opencode/doppler.ts), so the two
// sides compare like for like. Truncated to 16 hex chars: the value only has to
// differ when the code differs, and a collision there is not a realistic failure.
const ENGINE_LOADED = path.join(HOME, "engine.loaded.json");

function pkgStamp(file) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 16);
  } catch {
    return "missing";
  }
}

// null means no record to compare — a fresh root, or a bridge too old to write
// one — and the caller has to distinguish that from a mismatch.
function engineLoadedStamp() {
  try {
    const j = JSON.parse(fs.readFileSync(ENGINE_LOADED, "utf8"));
    return j && typeof j.stamp === "string" ? { stamp: j.stamp, at: j.loadedAt, pid: j.pid } : null;
  } catch {
    return null;
  }
}

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

// Resolve the config dir the way OpenCode does — XDG_CONFIG_HOME when set,
// else the default. The bridge's globalAgentsMd resolves the same way; the
// installer must agree, or the registration lands where OpenCode never
// reads and the bridge silently never loads.
const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
const OC_CONFIG_DIR = path.join(configHome, "opencode");

// The file the bridge watches for a manual reload request. Read as a counter
// rather than a mtime so two requests in the same filesystem tick are still two.
const RELOAD_SENTINEL = path.join(HOME, ".reload");

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
  // update() runs before any install on a fresh machine, where the root does
  // not exist yet; writing the manifest is the first thing that would notice.
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(HOME, "opencode.json"), JSON.stringify({
    _comment: "Generated by doppler install. Machine state, not user content: the bridge reads the personal root path from here. Edit freely — it is rewritten on every install.",
    home: HOME,
  }, null, 2) + "\n");
}

// Neither spelling is loaded — the registration points at the package — but both
// answer to the name someone would look for, so a run that registers removes them.
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
// an entry left behind under an older spelling would keep pointing at a file a
// newer install is free to stop shipping, so register() removes them all first.
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

// --- plugins ---------------------------------------------------------------
//
// The root's plugins load through one registered entry that discovers them at
// startup, so registering is a single line that never has to change when the
// root gains or loses a plugin file. Same splice, same idempotency, same "only
// ever appends" rule as the bridge: every spelling of the loader entry is ours
// to clear before writing, so a root that moves cannot leave a stale URL behind.

const loaderEntry = () => JSON.stringify(pathToFileURL(LOADER).href);
const isLoader = (literal) => /\/dist\/loader\.js"?$/.test(literal);

function registerLoader() {
  const p = ocConfigPath();
  const before = readConfig(p);
  const cleared = removeWhere(before, topLevelValueSpan(before, "plugin"), isLoader);
  const after = insertElement(cleared, topLevelValueSpan(cleared, "plugin"), "plugin", loaderEntry());
  if (after === before) return { path: p, changed: false };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, after);
  return { path: p, changed: true };
}

// Files the loader would pick up: the same filter it applies, so `status`
// describes what will really load rather than what the directory happens to
// contain.
function rootPluginFiles() {
  const dir = path.join(HOME, "plugins");
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => !n.startsWith(".") && !n.startsWith("__tests__"))
      .filter((n) => [".js", ".mjs", ".ts"].includes(path.extname(n)))
      .sort();
  } catch {
    return [];
  }
}

async function pluginRegister() {
  if (!fs.existsSync(LOADER)) {
    console.log(`no loader at ${LOADER} — this package does not ship one.`);
    console.log("Run `npm run build` in a checkout, or install a released package.");
    process.exitCode = 1;
    return;
  }
  const r = registerLoader();
  const files = rootPluginFiles();
  console.log(`${r.changed ? "registered" : "already registered"}: ${r.path} → ${loaderEntry()}`);
  console.log(`root: ${HOME}`);
  console.log(`plugins in the root: ${files.length ? files.join(", ") : "(none yet)"}`);
  if (files.length) console.log("they load on the next opencode start — nothing to re-install when you add one.");
}

function pluginStatus() {
  const cfg = readConfig(ocConfigPath());
  const span = topLevelValueSpan(cfg, "plugin");
  const registered = span ? /\/dist\/loader\.js/.test(cfg.slice(span.start, span.end)) : false;

  console.log(`loader: ${registered ? "registered" : "NOT registered"} — ${LOADER}`);
  console.log(`  loader file: ${fs.existsSync(LOADER) ? "present" : "MISSING (package not built?)"}`);
  console.log(`  config: ${ocConfigPath()}`);

  const files = rootPluginFiles();
  console.log(`root: ${HOME}`);
  console.log(`  plugins/: ${files.length ? `${files.length} file(s)` : "(empty or absent)"}`);
  for (const f of files) console.log(`    - ${f}`);

  let report = null;
  try {
    report = JSON.parse(fs.readFileSync(PLUGIN_REPORT, "utf8"));
  } catch {
    // no session has loaded the loader yet
  }
  if (!report) {
    console.log("last load: no report — no opencode session has run with the loader registered.");
    return;
  }
  const at = report.at ? new Date(report.at).toLocaleString() : "unknown";
  console.log(`last load: ${at}`);
  const bad = (report.plugins ?? []).filter((p) => !p.ok);
  const good = (report.plugins ?? []).filter((p) => p.ok);
  console.log(`  ok: ${good.length}${good.length ? ` (${good.map((p) => p.name).join(", ")})` : ""}`);
  if (bad.length) {
    console.log(`  skipped: ${bad.length}`);
    for (const p of bad) console.log(`    - ${p.name}: ${p.error}`);
  }
  // The question this command exists for: a file in the root that never loaded.
  const named = new Set((report.plugins ?? []).map((p) => p.name));
  const orphans = files.filter((f) => !named.has(f.replace(/\.[cm]?[jt]s$/, "")));
  if (orphans.length) {
    console.log(`  in the root but not in the last load: ${orphans.join(", ")}`);
    console.log("    a plugin added after that session loads on the next start — if it is still missing then, it exports no plugin function.");
  }
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

// True when `dir` is a symlink whose target no longer exists. Only a broken one:
// `npm link` also symlinks a package, and a development setup that still
// resolves is working, however unusual it looks on disk.
function danglingPackage(dir) {
  let link;
  try {
    link = fs.readlinkSync(dir);
  } catch {
    return false; // not a symlink, or gone entirely
  }
  if (fs.existsSync(dir)) return false;
  return !fs.existsSync(path.resolve(path.dirname(dir), link));
}

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
    console.log("restart opencode once, to load the bridge it has just registered.");
    console.log("after that, editing your hooks, policy, agents or skills needs no restart.");
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
    // Not just "don't add" — a bridge already registered must be removed, or
    // two same-id plugins both inject config with no visible precedence. The
    // user's is the primary; doppler steps aside. Re-running install without
    // the replacement registers the bridge again.
    const r = unregister();
    console.log(`a plugin with id '${BRIDGE_ID}' is already registered — doppler's bridge stays dormant.${r.changed ? " (removed the previous bridge entry)" : ""}`);
    return;
  }
  const r = register();
  console.log(`${r.changed ? "registered" : "already registered"}: ${r.path} → ${entry()}`);
  verify();
}

// Asks every running OpenCode to rebuild its config from the personal root.
//
// It cannot call the harness directly: a desktop-app session always starts the
// server with a password, and the only credential available to a separate
// process would have to be written to disk to be usable. So the request is a file
// in the personal root and the bridge does the calling — which means touching it
// by hand does exactly the same thing, and nothing here is privileged.
function reload() {
  fs.mkdirSync(HOME, { recursive: true });
  let previous = 0;
  try {
    previous = Number(fs.readFileSync(RELOAD_SENTINEL, "utf8")) || 0;
  } catch {
    // no previous request
  }
  fs.writeFileSync(RELOAD_SENTINEL, `${previous + 1}\n`);
  console.log(`reload requested: ${RELOAD_SENTINEL}`);
  console.log("a running opencode applies it at its next idle moment — a turn in flight is never interrupted.");
  if (!fs.existsSync(BRIDGE)) {
    console.log(`note: no bridge at ${BRIDGE}, so nothing is registered to answer. Run doppler install opencode.`);
  }
}

function unregisterLoader() {
  const p = ocConfigPath();
  const before = readConfig(p);
  const span = topLevelValueSpan(before, "plugin");
  if (!span) return { path: p, changed: false };
  const after = removeWhere(before, span, isLoader);
  if (after === before) return { path: p, changed: false };
  fs.writeFileSync(p, after);
  return { path: p, changed: true };
}

function uninstallOpencode() {
  const r = unregister();
  console.log(`${r.changed ? "removed" : "not present"}: doppler bridge entry in ${r.path}`);
  // The loader is registered by the same installer into the same array, so
  // leaving it behind would keep loading the personal root's plugins after
  // "uninstall" — the one outcome that makes the command a lie.
  const l = unregisterLoader();
  console.log(`${l.changed ? "removed" : "not present"}: doppler plugin loader entry in ${l.path}`);
  console.log(`left in place: ${path.join(HOME, "hooks")} and ${path.join(HOME, "policy")} — your files.`);
  console.log(`delete ${HOME} to remove the personal root entirely.`);
}

// Where the engine comes from decides what "update" means. A personal root that
// is a git clone IS the engine (bin/ runs from it), so the pull is the engine
// update. A package install (release tarball or git URL, delivered by npm) is
// read in place at a fixed path, so the pull does nothing and the engine only
// moves when the package is replaced — which is what the rest of this command
// does: resolve the newest installable release, compare, self-install.
const REPO = process.env.DOPPLER_REPO || "https://github.com/igorjpimenta/doppler-harness.git";
const webBase = REPO
  .replace(/\.git$/, "")
  .replace(/^git\+/, "")
  .replace(/^git@github\.com:/, "https://github.com/");
const assetUrl = (tag) => `${webBase}/releases/download/${tag}/igorjpimenta-doppler-harness-${tag}.tgz`;

async function assetExists(url) {
  try {
    const r = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(15000) });
    return r.ok;
  } catch {
    return false;
  }
}

// The engine to update is the one that is registered, not the one this file
// runs from: a checkout running update has to report the installed engine's
// version, or it declares "up to date" because the checkout is current while
// the machine runs an older release. Unreadable falls back to the running
// package, which is the same file in the normal case.
function registeredEngine() {
  const cfg = readConfig(ocConfigPath());
  const span = topLevelValueSpan(cfg, "plugin");
  if (!span) return null;
  const literal = stringElements(cfg, span).find(isDoppler);
  if (!literal) return null; // never registered — registration is install's job, not update's
  try {
    const p = fileURLToPath(JSON.parse(literal));
    const version = JSON.parse(fs.readFileSync(path.resolve(p, "..", "..", "package.json"), "utf8")).version;
    return { path: p, version };
  } catch {
    // Registered but unreadable: the entry names an engine that is gone (npm
    // repointed or deleted its package directory). Repairable; no version.
    return { missing: true };
  }
}

async function update() {
  const pulled = fs.existsSync(path.join(HOME, ".git"));
  if (pulled) sh(`git -C ${HOME} pull --ff-only`);
  else console.log(`${HOME} is not a git clone — the root is yours, nothing to pull.`);
  writeRootManifest();
  removeStaleBridgeCopies();
  if (await hasSameIdPlugin()) {
    const r = unregister();
    console.log(`a plugin with id '${BRIDGE_ID}' is already registered — doppler's bridge stays dormant.${r.changed ? " (removed the previous bridge entry)" : ""}`);
    return;
  }
  // No unconditional re-register here: update repairs a vanished registration
  // (below), but writing the running package's own URL every time would let a
  // checkout repoint a machine's bridge at a working tree that can go away.

  const force = process.argv.includes("--force");
  // Anything after the verb that is not a flag is a pin: `doppler update
  // 2026.10.11`. Refused here rather than filtered at dispatch, so a typo
  // cannot silently turn into "update to latest".
  const pinned = process.argv.slice(3).find((a) => a !== "--force");
  const engine = registeredEngine();
  const installed = engine?.version ?? packageJson().version;
  // Repair, not re-register: an entry whose engine file is gone is ours to fix;
  // one that still resolves is left alone — writing the running package's own
  // URL would let a checkout repoint a machine's bridge at a working tree that
  // can go away.
  if (engine?.missing) {
    const r = register();
    if (r.changed) console.log(`re-registered: ${r.path} → ${entry()}`);
  }
  // A checkout is a deliberate state (doctor names its branch rather than fail
  // on it for the same reason): replacing it with a release would silently end
  // a development install. Only --force states that intent.
  if (!pulled && !force && !parseTag(installed)) {
    console.log(`engine at ${installed} is not a release build — updating would overwrite a checkout.`);
    console.log("if that is the intent, run it with --force.");
    return;
  }

  const probe = (t) => assetExists(assetUrl(t));
  let tag = null;
  if (pinned && !parseTag(pinned)) {
    console.log(`'${pinned}' is not a release tag (YYYY.M.D[-N]) — engine stays at ${installed}.`);
    return;
  }
  if (pinned) {
    if (!(await probe(pinned))) {
      console.log(`release ${pinned} has no tarball asset — nothing to install. Engine stays at ${installed}.`);
      return;
    }
    tag = pinned;
  } else {
    let tags;
    try {
      tags = tagsFromLsRemote(sh(`git ls-remote --tags --refs ${REPO}`));
    } catch (e) {
      console.log(`couldn't check for engine updates (${String(e.message).split("\n")[0]}) — engine stays at ${installed}.`);
      return;
    }
    if (!tags.length) {
      console.log(`no releases found at ${webBase} — engine stays at ${installed}.`);
      return;
    }
    tag = await newestInstallable(tags, probe);
    if (!tag) {
      const newest = tags.map((t) => parseTag(t)).filter(Boolean).sort(newerTag).pop();
      console.log(`release ${newest.y}.${newest.m}.${newest.d} is tagged but has no tarball yet — engine stays at ${installed}.`);
      return;
    }
  }

  if (!isNewerRelease(tag, installed) && !force) {
    console.log(`engine up to date (${installed}${parseTag(installed) && tag !== installed ? `; latest release is ${tag}` : ""}).`);
  } else {
    const url = assetUrl(tag);
    console.log(`installing engine ${installed} → ${tag}`);
    try {
      sh(`npm install -g ${url}`);
    } catch (e) {
      console.log(`npm install failed (${String(e.message).split("\n")[0]}). Install by hand:`);
      console.log(`  npm install -g ${url}`);
      return;
    }
    // npm may repoint the global package directory on reinstall, breaking a
    // path that resolved when update started. Same repair as above.
    if (engine && !engine.missing && !fs.existsSync(engine.path)) {
      const r = register();
      if (r.changed) console.log(`re-registered: ${r.path} → ${entry()}`);
    }
    console.log(`engine updated: ${installed} → ${tag}. restart opencode to pick it up.`);
    console.log("your own files do not need it — the bridge re-reads those on its own.");
  }

  // Releases before the loader shipped no dist/loader.js, so an engine that has
  // just updated onto the loader leaves a root whose plugins load nothing until
  // its one entry is spliced in. Registering it unasked would exceed what
  // "update" promises; naming the command is the whole hint.
  const cfgText = readConfig(ocConfigPath());
  const span = topLevelValueSpan(cfgText, "plugin");
  if ((!span || !stringElements(cfgText, span).some(isLoader)) && fs.existsSync(LOADER)) {
    console.log("note: this engine can load ~/.doppler/plugins/*.js — run `doppler plugin register opencode` to switch that on.");
  }
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

    // The build on disk is not the engine a running session is executing: a plugin
    // module is imported once and cached for the life of the process, so the file
    // says nothing about which build the harness loaded. Everything above and
    // below this check is about the files being correct; this one is about the
    // file being the one in use. The bridge records what it loaded, so the
    // comparison is a read of both sides rather than a guess about the other.
    const loadedStamp = engineLoadedStamp();
    if (loadedStamp == null) {
      // No record, no claim either: the harness has not loaded since the stamp
      // landed (a fresh root, or automatic reloading off on an older bridge), and
      // a warning with no way to act on it teaches the reader to ignore warnings.
      ok("engine build", `${pkgStamp(BRIDGE)} on disk; no running harness has recorded a load yet`);
    } else if (loadedStamp.stamp === "unknown") {
      warn("engine build", `the loaded bridge could not be fingerprinted — unknown which build ${BRIDGE} is`);
    } else if (loadedStamp.stamp !== pkgStamp(BRIDGE)) {
      bad(
        "engine build",
        `OpenCode loaded build ${loadedStamp.stamp} (${loadedStamp.at}) but ${rel(BRIDGE)} on disk is ${pkgStamp(BRIDGE)}`,
        "quit and reopen OpenCode — a running harness never re-reads its plugin",
      );
    } else {
      ok("engine build", `${loadedStamp.stamp} — on disk and in the running harness agree`);
    }

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
      // "no such file" is true and useless when the package directory is a
      // symlink npm pointed into its own cache and has since deleted — which is
      // what an install from a git URL becomes on npm 11. The command itself is
      // gone from PATH at that point, so this is the only place the cause can
      // still be named: it is reachable from a checkout or a clone, which is
      // where someone goes once the binary stops answering.
      if (danglingPackage(path.resolve(registered, "..", ".."))) {
bad(
        "registered path resolves",
        "the installed package is a symlink npm deleted — it was installed from a git URL",
        "reinstall with --install-links=true, or use the release tarball; see Quick start in README.md",
      );
      }
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
    //
    // `debug config` truncates its own output when stdout is a pipe — a full
    // document is ~114KB, and a pipe capture arrives cut mid-key at ~65KB,
    // deterministically and regardless of maxBuffer. Writing to a file is
    // complete, so the defect is in the CLI's pipe writes, not in who reads
    // them. A read like this one is therefore guaranteed to fail on a working
    // install, so the registration file is the primary evidence and the CLI
    // output is corroborating only when it parses.
    const oc = opencodeCli();
    if (!oc) {
      bad("opencode CLI", "not found", "install it, or set OPENCODE_BIN");
    } else {
      const fileEntries = stringElements(readConfig(cfg), topLevelValueSpan(readConfig(cfg), "plugin"))
        .some((e) => {
          try { return path.resolve(fileURLToPath(JSON.parse(e))) === registered; } catch { return false; }
        });
      const run = spawnSync(oc, ["debug", "config"], { encoding: "utf8", timeout: 30_000 });
      let cliLoaded = null;
      if (run.status === 0 && typeof run.stdout === "string") {
        try {
          cliLoaded = (JSON.parse(run.stdout).plugin ?? []).some((p) => {
            try { return path.resolve(fileURLToPath(String(p))) === registered; } catch { return false; }
          });
        } catch {
          cliLoaded = null;
        }
      }
      if (fileEntries) {
        if (cliLoaded === true) ok("opencode loads the bridge");
        else if (cliLoaded === false) bad("opencode loads the bridge", "the entry is not in the resolved config", "doppler install opencode");
        else ok("opencode loads the bridge", `entry present in ${rel(cfg)}`);
      } else {
        bad("opencode loads the bridge", `no doppler entry in ${cfg}`, "doppler install opencode");
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

  // Auto-reload is a behaviour, and a wrong one is invisible: a policy that reads
  // as applied while the session is still enforcing the previous version of it.
  // So which way it is set is a line here rather than something to discover.
  const reloadOff = ["off", "0", "false", "no"].includes((process.env.DOPPLER_RELOAD ?? "").trim().toLowerCase());
  if (reloadOff) {
    warn(
      "live refresh",
      "DOPPLER_RELOAD is off, so policy, agent and skill edits need opencode restarted — `doppler reload` still works",
    );
  } else {
    ok("live refresh", "policy, agent and skill edits apply without restarting opencode");
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
const USAGE = "usage: doppler <install|uninstall> opencode | update [<tag>|--force] | reload | doctor | version\n" +
  "       doppler plugin register opencode   # load the personal root's plugins/*.js\n" +
  "       doppler plugin status               # registered? loaded? skipped?";
if (cmd === "install" && target === "opencode") await installOpencode();
else if (cmd === "uninstall" && target === "opencode") uninstallOpencode();
else if (cmd === "update") await update();
else if (cmd === "reload") reload();
else if (cmd === "doctor") doctor();
else if (cmd === "plugin" && target === "register") await pluginRegister();
else if (cmd === "plugin" && target === "status") pluginStatus();
else if (cmd === "version") console.log(packageJson().version);
else {
  console.log(USAGE);
  // A name we do not serve is the case worth answering properly: the usage line
  // alone reads as a typo, when the honest answer is that the harness is not
  // supported yet and the work is in one commit away.
  if (cmd === "plugin") {
    console.log("\nverbs: register opencode · status");
  } else if (target && target !== "opencode") {
    console.log(`\nopencode is the only supported harness right now. ${target} is not wired.`);
    console.log("See AGENTS.md for what a new one needs — it is a bridge, not a fork.");
  }
  process.exit(cmd === "help" || cmd === "plugin" ? 0 : 1);
}
