// flatten-dist.mjs — the engine unit is ONE directory: engineUnitHash hashes
// every file in it and stageEngineUpdate copies it whole, so dist/ must stay
// flat. tsc mirrors src/ (rootDir "src"), which puts the host bridge in
// dist/opencode/ beside the core files in dist/. Move the host files up and
// rewrite their "../x.js" specifiers to "./x.js" — the only thing that
// changes when a file moves one level shallower.
import fs from "node:fs";
import path from "node:path";

const dist = path.join(import.meta.dirname, "..", "dist");
const hostDir = path.join(dist, "opencode");
if (!fs.existsSync(hostDir)) process.exit(0);

for (const name of fs.readdirSync(hostDir)) {
  const from = path.join(hostDir, name);
  const to = path.join(dist, name);
  if (fs.existsSync(to)) {
    console.error(`flatten-dist: ${name} would clobber an existing file`);
    process.exit(1);
  }
  if (name.endsWith(".js")) {
    const src = fs.readFileSync(from, "utf8");
    const flat = src
      .replace(/(from\s+")\.\.\/(?!\.\.\/)/g, '$1./')
      .replace(/(import\s*\(")\.\.\/(?!\.\.\/)/g, '$1./');
    fs.writeFileSync(to, flat);
    fs.unlinkSync(from);
  } else {
    fs.renameSync(from, to);
  }
}
fs.rmdirSync(hostDir);
console.log("flatten-dist: dist/opencode flattened into dist/");
