// clean-dist.mjs — a build starts from nothing: stale files from a previous
// layout would otherwise survive and collide with the flatten step.
import fs from "node:fs";
import path from "node:path";

fs.rmSync(path.join(import.meta.dirname, "..", "dist"), { recursive: true, force: true });
