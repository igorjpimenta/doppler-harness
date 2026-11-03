// skills.ts — discovery for the personal root's skills: one SKILL.md per
// directory, frontmatter name/description. Harness-agnostic; the host maps
// these records into its own skill shape.
import fs from "node:fs";
import path from "node:path";

// <root>/<skill>/SKILL.md with a frontmatter name/description — the same
// layout the skills guide documents for discovery.
export function discoverSkills(roots: string[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const root of roots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const file = path.join(root, e.name, "SKILL.md");
      let content: string;
      try {
        content = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      let name = e.name;
      let description = "";
      const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
      if (fm) {
        for (const line of fm[1].split(/\r?\n/)) {
          const kv = /^(name|description):\s*(.*)$/.exec(line);
          if (!kv) continue;
          const v = kv[2].trim().replace(/^["']|["']$/g, "");
          if (kv[1] === "name" && v) name = v;
          if (kv[1] === "description" && v) description = v;
        }
      }
      out.push({ id: e.name, name, description, path: file, content });
    }
  }
  return out;
}
