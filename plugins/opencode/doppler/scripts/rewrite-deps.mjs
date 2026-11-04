// rewrite-deps.mjs — tsc with rootDir "../../.." emits a repo-root tree under
// dist/ (this package's files plus the core they import). Extract this
// package's subtree as the real dist, rewrite the core specifiers to the
// package name the published install resolves, and prune the rest: the core
// ships as @igorjpimenta/doppler-harness, not as compiled copies beside the
// bridge, so a core fix is a core release rather than a silent divergence.
import fs from "node:fs";
import path from "node:path";

const pkgRoot = path.join(import.meta.dirname, "..");
const dist = path.join(pkgRoot, "dist");
const tree = path.join(dist, "plugins", "opencode", "doppler");

if (!fs.existsSync(tree)) {
  console.error("rewrite-deps: expected tsc output at dist/plugins/opencode/doppler");
  process.exit(1);
}

const staged = path.join(pkgRoot, ".dist-staged");
fs.mkdirSync(staged, { recursive: true });
for (const name of fs.readdirSync(tree)) {
  const from = path.join(tree, name);
  const to = path.join(staged, name);
  if (name.endsWith(".js")) {
    const src = fs.readFileSync(from, "utf8");
    const out = src
      .replace(/(from\s+")\.\.\/\.\.\/\.\.\/src\//g, '$1@igorjpimenta/doppler-harness/')
      .replace(/(import\s*\(")\.\.\/\.\.\/\.\.\/src\//g, '$1@igorjpimenta/doppler-harness/');
    fs.writeFileSync(to, out);
  } else {
    fs.copyFileSync(from, to);
  }
}
fs.rmSync(dist, { recursive: true, force: true });
fs.renameSync(staged, dist);
console.log("rewrite-deps: dist is this package's files, core resolved by name");
