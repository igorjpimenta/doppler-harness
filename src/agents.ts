// agents.ts — the personal root's agents: frontmatter parsing and discovery.
import fs from "node:fs";
import path from "node:path";
import { paths } from "./paths.ts";


export const AGENT_KEYS = new Set([
  "model", "variant", "temperature", "top_p", "description", "mode",
  "hidden", "color", "disable", "steps", "options", "permission", "tools",
]);

// Every tool an agent can be given or denied. A `tools: [A, B]` list is the
// other spelling of "only A and B", so it has to be resolved against this
// closed set — anything not named is denied.
export const TOOL_KEYS = [
  "bash", "edit", "write", "read", "grep", "glob", "list", "patch", "task",
  "todowrite", "todoread", "webfetch", "websearch", "question", "skill", "lsp",
];

// `tools: [Read, Bash, Grep, Glob]` names the tools an agent may use, and
// implies every other one is off. OpenCode's own `tools` field is deprecated and
// is what silently fails open here: a list is not the object shape it expects,
// so it is dropped on validation and the agent keeps ALL tools — an agent
// written read-only comes back with edit and write.
//
// So the list is translated into denies, which is the field the schema still
// recommends and which survives validation. Aliases are mapped because
// frontmatter conventionally uses the capitalised Claude-style names.
export const TOOL_ALIASES = {
  bash: "bash", shell: "bash",
  read: "read", view: "read",
  edit: "edit", multiedit: "edit",
  write: "write", create: "write",
  grep: "grep", search: "grep",
  glob: "glob", ls: "glob", list: "glob",
  patch: "patch",
  task: "task", agent: "task",
  todowrite: "todowrite", todoread: "todoread",
  webfetch: "webfetch", fetch: "webfetch",
  websearch: "websearch",
  question: "question",
  skill: "skill",
  lsp: "lsp",
};

export function parseToolList(raw: string) {
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  const names = inner.split(",").map((s: string) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  const allowed = new Set<string>();
  const aliases = TOOL_ALIASES as Record<string, string>;
  for (const n of names) allowed.add(aliases[n.toLowerCase()] ?? n.toLowerCase());
  if (!allowed.size) return null;
  const permission: Record<string, string> = {};
  for (const key of TOOL_KEYS) if (!allowed.has(key)) permission[key] = "deny";
  return permission;
}

export function coerce(raw: string) {
  const v = raw.trim();
  if (/^"(.*)"$/.test(v) || /^'(.*)'$/.test(v)) return v.slice(1, -1);
  if (v === "true") return true;
  if (v === "false") return false;
  if (v !== "" && !Number.isNaN(Number(v))) return Number(v);
  return v;
}

export function parseAgent(text: string) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  const [, frontmatter, body] = m;
  const config: Record<string, unknown> = {};
  let block: string | null = null;
  for (const line of frontmatter.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indented = /^\s/.test(line);
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1);
    if (indented) {
      if (block && key && AGENT_KEYS.has(block)) {
        ((config[block] ??= {}) as Record<string, unknown>)[key] = coerce(value);
      }
      continue;
    }
    block = key;
    if (!AGENT_KEYS.has(key) || value.trim() === "") continue;
    if (key === "permission") {
      config.permission = {};
      block = "permission";
    } else if (key === "tools") {
      // Never forwarded (see TOOL_ALIASES above), and an explicit permission:
      // block still wins for the tools the author spelled out.
      const derived = parseToolList(value);
      if (derived) {
        config.permission = { ...derived, ...(config.permission ?? {}) };
        block = null;
      }
      continue;
    } else {
      config[key] = coerce(value);
    }
  }
  return body.trim() ? { config, prompt: body.trim() } : null;
}

// Namespaced so a personal agent can never shadow a built-in (build, plan,
// explore, general) or collide with the user's own ~/.config/opencode agents.
export function readAgents() {
  let files;
  try {
    files = fs.readdirSync(paths().agents).filter((f: string) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }
  const agents = [];
  for (const file of files) {
    try {
      const parsed = parseAgent(fs.readFileSync(path.join(paths().agents, file), "utf8"));
      if (parsed) agents.push({ name: `doppler-${path.basename(file, ".md")}`, ...parsed });
    } catch {
      // one malformed agent must not cost the user the rest
    }
  }
  return agents;
}

