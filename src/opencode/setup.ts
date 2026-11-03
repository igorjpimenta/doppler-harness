// setup.ts — the entry. Hosts read it from the default export; the legacy
// server() in doppler.ts gives a v1 host the object-hook form of the same
// behavior. There is no config hook on this path: every injection the v1
// config hook made moves to the domain that owns it, best-effort, keeping the
// contract that a broken personal root degrades to "no doppler", never to
// "opencode will not boot".
import fs from "node:fs";
import path from "node:path";
import { paths, globalAgentsMd, hasEntries, overlaySkillRoots } from "../paths.ts";
import { enforce, hookFiles, runHook, compiledPermission } from "../policy.ts";
import { readAgents } from "../agents.ts";
import { discoverSkills } from "../skills.ts";


// Structural shape of the plugin context setup() receives, limited to what it calls.
// Declared locally so the bridge keeps zero runtime dependency on either SDK:
// Legacy v1 hosts read this module through server(), current hosts through
// setup(); both export from the same default object.
export interface EvaluateEvent {
  sessionID: string;
  agent?: string;
  action: string;
  resources: readonly string[];
  effect: "allow" | "deny" | "ask";
}
export interface SetupCtx {
  agent: { transform(cb: (editor: {
    list(): unknown[];
    get(id: string): unknown;
    add(info: Record<string, unknown>): void;
  }) => void): Promise<unknown> };
  permission: { hook(name: "evaluate", cb: (e: EvaluateEvent) => void): Promise<unknown> };
  skill: { transform(cb: (editor: {
    add(skill: Record<string, unknown>): void;
  }) => void): Promise<unknown> };
  session: { hook(name: "context", cb: (e: {
    sessionID: string;
    system: Array<{ type: string; text: string }>;
  }) => void): Promise<unknown> };
  tool: { hook(name: "execute.before", cb: (e: {
    tool: string;
    sessionID: string;
    input: unknown;
  }) => void): Promise<unknown> };
  event: { subscribe(opts?: { signal?: AbortSignal }): AsyncIterable<{ type: string; properties?: Record<string, unknown> }> };
}

// --- The entry: setup() ------------------------------------------------------
//
// setup() is the bridge: hosts read it from the default export, and the
// legacy server() further down gives a v1 host the object-hook form of the
// same behavior. There is no config hook on this path: every injection the
// v1 config hook made moves to the domain that owns it, best-effort, keeping
// the same contract — a broken personal root degrades to "no doppler", never
// to "opencode will not boot". Enforcement is unchanged: enforce() re-reads the
// hook directory per call, and the ask-prompt path (a hook's declared asks,
// which V1 compiled into config.permission) moves to the permission evaluate
// hook, where the host raises the prompt itself.

// Glob matcher for allowlist patterns: `*` and `?`, anchored. Patterns pass
// through verbatim from policy/allowlist.json, same as the config path.
export function globMatch(pattern: string, value: string): boolean {
  const rx =
    "^" +
    pattern
      .split("*")
      .map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\?/g, "."))
      .join(".*") +
    "$";
  try {
    return new RegExp(rx).test(value);
  } catch {
    return false;
  }
}

// allowlist → ordered effect triples. Order mirrors compiledPermission: tool
// allows first, then bash patterns allow → ask → declared-ask → deny last, so
// a deny outranks an overlapping ask under the host's last-match-wins rule.
// Both bash and shell actions are emitted: the host may spell the action
// either way.
export function permissionEffects(): Array<{ action: string; resource: string; effect: "allow" | "deny" | "ask" }> {
  const rules = compiledPermission();
  if (!rules) return [];
  const out: Array<{ action: string; resource: string; effect: "allow" | "deny" | "ask" }> = [];
  const effect = (v: unknown): v is "allow" | "deny" | "ask" => v === "allow" || v === "deny" || v === "ask";
  for (const [tool, rule] of Object.entries(rules)) {
    if (tool === "bash") continue;
    if (effect(rule)) out.push({ action: tool, resource: "*", effect: rule });
  }
  const bash = rules.bash;
  if (bash && typeof bash === "object") {
    for (const [pattern, eff] of Object.entries(bash as Record<string, unknown>)) {
      if (!effect(eff)) continue;
      out.push({ action: "bash", resource: pattern, effect: eff });
      out.push({ action: "shell", resource: pattern, effect: eff });
    }
  }
  return out;
}

export async function setup(ctx: SetupCtx): Promise<() => void> {
  try {
    const roots = [paths().skills, ...overlaySkillRoots()].filter(hasEntries);
    const skills = discoverSkills(roots);
    if (skills.length) {
      await ctx.skill.transform((editor) => {
        for (const skill of skills) editor.add(skill);
      });
    }

    // The root AGENTS.md is the personal root's standing instructions. Same
    // precedence rule as V1: the user's own global AGENTS.md wins; when there
    // is none, the root file is appended to every model request.
    const agentsMd = path.join(paths().home, "AGENTS.md");
    if (fs.existsSync(agentsMd) && !fs.existsSync(globalAgentsMd())) {
      const text = fs.readFileSync(agentsMd, "utf8");
      await ctx.session.hook("context", (e) => {
        e.system.push({ type: "text", text });
      });
    }

    for (const agent of readAgents()) {
      await ctx.agent.transform((editor) => {
        if (editor.get(agent.name)) return; // the user's own agent wins
        const c = (agent.config ?? {}) as Record<string, unknown>;
        const mode = c.mode === "primary" || c.mode === "all" ? c.mode : "subagent";
        editor.add({
          id: agent.name,
          name: agent.name,
          request: { settings: {}, headers: {}, body: {} },
          mode,
          hidden: false,
          permissions: [],
          ...(typeof agent.prompt === "string" ? { system: agent.prompt } : {}),
          ...(typeof c.description === "string" ? { description: c.description } : {}),
          ...(typeof c.color === "string" ? { color: c.color } : {}),
        });
      });
    }

    const effects = permissionEffects();
    if (effects.length) {
      await ctx.permission.hook("evaluate", (e) => {
        let match: "allow" | "deny" | "ask" | undefined;
        for (const r of effects) {
          const actionOk =
            r.action === e.action ||
            (r.action === "bash" && e.action === "shell") ||
            (r.action === "shell" && e.action === "bash");
          if (!actionOk) continue;
          if (globMatch(r.resource, e.resources[0] ?? "")) match = r.effect; // last match wins
        }
        if (match) e.effect = match;
      });
    }
  } catch {
    // best-effort: same contract as the V1 config hook
  }

  // Identical to V1: deny/ask from the policy hooks, re-read per call.
  await ctx.tool.hook("execute.before", (event) => {
    enforce({ tool: event.tool, sessionID: event.sessionID }, { args: event.input });
  });

  // session.created → the personal root's hook scripts, same payload as V1.
  const controller = new AbortController();
  void (async () => {
    for await (const ev of ctx.event.subscribe({ signal: controller.signal })) {
      if (ev.type !== "session.created") continue;
      const id = (ev.properties as { info?: { id?: string } } | undefined)?.info?.id;
      if (!id) continue;
      const payload = { session_id: id, event: "session.created" };
      for (const file of hookFiles()) runHook(path.join(paths().hooks, file), payload);
    }
  })().catch(() => {});
  return () => controller.abort();
}

