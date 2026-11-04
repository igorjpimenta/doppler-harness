// link-self.mjs — the published packages resolve each other through
// node_modules; in this repo nothing installs them, so postinstall links both
// names into node_modules under @igorjpimenta. Recreated on every install, so
// a pruned link is never stale. The bridge's built output imports the core by
// package name, and the CLI resolves the bridge package the same way.
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const scope = path.join(root, "node_modules", "@igorjpimenta");
const links = [
  ["doppler-harness", root],
  ["doppler-opencode", path.join(root, "plugins", "opencode", "doppler")],
];
fs.mkdirSync(scope, { recursive: true });
for (const [name, target] of links) {
  const link = path.join(scope, name);
  try {
    fs.lstatSync(link);
    fs.rmSync(link, { recursive: true, force: true });
  } catch {
    // absent is the common case
  }
  fs.symlinkSync(target, link, "dir");
  console.log(`link-self: node_modules/@igorjpimenta/${name} -> ${path.relative(root, target) || "."}`);
}
