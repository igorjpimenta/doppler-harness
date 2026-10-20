// doppler engine self-update. Engine-owned, dependency-free (node builtins
// only): it is imported by both registered entries, and a copy has to execute
// without its siblings around — every file the copy needs travels with it.
//
// A running harness never re-reads its plugin: a module is imported once and
// cached for the life of the process. Personal plugins escape that through the
// loader, which re-imports a changed file under a content-derived copy. The
// engine itself gets the same treatment — each entry asks here whether the
// package on disk is newer than the code executing now, and if so executes a
// copy instead of itself.
//
// The copy is a whole unit, not a file: the bridge and the loader version
// together, so a mixed pair can never run. A query string would be the obvious
// key and does not work — Bun, which is what OpenCode's plugin runtime is,
// normalizes it away and serves the stale module. A filesystem path is the one
// cache key every runtime honors.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// How long a superseded generation may linger. Time-based, not reference-
// counted: a deleted generation is harmless — its module is already evaluated
// — and age needs no cross-instance bookkeeping to be safe.
const ENGINE_CACHE_TTL_MS = 60 * 60 * 1000;

// Hidden, so the root snapshot never sees a copy (which would read as a change
// and reload for itself). Pruned on adoption, never walked.
export function engineCacheDir(home: string): string {
  return path.join(home, ".engine-cache");
}

// Content hash of every executable file in the directory: dotfiles and the
// sidecar are not code and must not count, or a copy could never compare equal
// to the unit it was made from and every check would re-adopt forever.
export function engineUnitHash(dir: string): string | null {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => !n.startsWith(".") && n !== "source.json").sort();
  } catch {
    return null;
  }
  if (!names.length) return null;
  try {
    const h = crypto.createHash("sha256");
    for (const n of names) {
      h.update(n);
      h.update(fs.readFileSync(path.join(dir, n)));
    }
    return h.digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

// The build an entry is executing, as a content hash. Captured once, at import:
// re-reading your own files would always agree with the disk for an original
// (same files), which is exactly the case that must read as stale after an
// update.
export function engineLoadedHash(selfUrl: string): string | null {
  try {
    return engineUnitHash(path.dirname(fileURLToPath(selfUrl)));
  } catch {
    return null;
  }
}

function readEngineSidecar(dir: string): string | null {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dir, "source.json"), "utf8")) as unknown;
    if (v && typeof v === "object" && typeof (v as { dist?: unknown }).dist === "string") {
      const dist = (v as { dist: string }).dist;
      if (fs.statSync(dist).isDirectory()) return dist;
    }
    return null;
  } catch {
    return null;
  }
}

// Where the package on disk lives, as this copy sees it. A first-load module
// answers its own directory; a copy answers the sidecar its adoption wrote
// beside it. DOPPLER_ENGINE_DIR overrides both, and exists for tests the way
// DOPPLER_HOME does. Null means unresolvable — and unresolvable means serve
// as-is, never refuse to run over a question about where an update would come
// from.
export function engineDistDir(home: string, selfUrl: string): string | null {
  if (process.env.DOPPLER_ENGINE_DIR) {
    try {
      if (fs.statSync(process.env.DOPPLER_ENGINE_DIR).isDirectory()) return process.env.DOPPLER_ENGINE_DIR;
    } catch {
      return null;
    }
    return null;
  }
  let selfDir: string;
  try {
    selfDir = path.dirname(fileURLToPath(selfUrl));
  } catch {
    return null;
  }
  if (path.dirname(selfDir) === engineCacheDir(home)) return readEngineSidecar(selfDir);
  return selfDir;
}

// True when the package on disk is newer than the executing copy. Pure
// observation — no copying, no importing — so the reload tick can ask it on
// every pass and only dispose when the answer changes.
export function engineUpdateAvailable(home: string, selfUrl: string, loadedHash: string | null): boolean {
  const dist = engineDistDir(home, selfUrl);
  if (!dist) return false;
  const theirs = engineUnitHash(dist);
  if (!loadedHash || !theirs) return false;
  return loadedHash !== theirs;
}

// Copy the on-disk unit into the cache and hand back the copy's URL for the
// caller's own filename. The caller imports it and delegates — or, if the
// import throws, keeps serving the running build and says so loudly. A copy
// that fails to write is not a failure either: null means serve as-is, and the
// next invocation asks again.
export function stageEngineUpdate(
  home: string,
  selfUrl: string,
  fileName: string,
  loadedHash: string | null,
): string | null {
  const dist = engineDistDir(home, selfUrl);
  if (!dist) return null;
  const theirs = engineUnitHash(dist);
  if (!loadedHash || !theirs || loadedHash === theirs) return null;
  const dest = path.join(engineCacheDir(home), theirs);
  try {
    fs.mkdirSync(dest, { recursive: true });
    for (const n of fs.readdirSync(dist)) {
      if (n.startsWith(".") || n === "source.json") continue;
      const src = path.join(dist, n);
      if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(dest, n));
    }
    fs.writeFileSync(path.join(dest, "source.json"), JSON.stringify({ dist, hash: theirs }) + "\n");
    // The read-back is the barrier: the copy is imported milliseconds after it
    // is written, and a runtime that resolves the URL through a stale stat
    // cache reports the just-written file as missing.
    fs.readFileSync(path.join(dest, fileName));
  } catch {
    return null;
  }
  pruneEngineCache(home, theirs);
  try {
    return pathToFileURL(path.join(dest, fileName)).href;
  } catch {
    return null;
  }
}

export function pruneEngineCache(home: string, keep: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(engineCacheDir(home));
  } catch {
    return;
  }
  const now = Date.now();
  for (const n of names) {
    if (n === keep) continue;
    const full = path.join(engineCacheDir(home), n);
    try {
      if (now - fs.statSync(full).mtimeMs < ENGINE_CACHE_TTL_MS) continue;
      fs.rmSync(full, { recursive: true, force: true });
    } catch {
      // A generation in use is already evaluated; a failed prune retries next time.
    }
  }
}
