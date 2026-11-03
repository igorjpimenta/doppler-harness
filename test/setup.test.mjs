// setup.test.mjs — the entry half of the bridge: every injection the
// config hook made, registered through the domain that owns it, plus the
// enforcement path unchanged. Same isolation as bridge.test.mjs: DOPPLER_HOME
// and HOME/XDG are faked so no test can reach the real personal root.
//
// Run with `node --test test/`.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import dopplerDefault, { setup } from "../opencode/doppler.ts";

function rootWith({ policy = {}, skills = {}, globalAgentsMd = null, agentsMd = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "doppler-setup-"));
  fs.mkdirSync(path.join(home, "policy"), { recursive: true });
  for (const d of ["hooks", "agents", "skills", "plugins"]) {
    fs.mkdirSync(path.join(home, d), { recursive: true });
  }
  for (const [name, body] of Object.entries(skills)) {
    const dir = path.join(home, "skills", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), body);
  }
  for (const [name, body] of Object.entries(policy)) {
    fs.writeFileSync(path.join(home, "policy", name), body);
  }
  if (agentsMd !== null) fs.writeFileSync(path.join(home, "AGENTS.md"), agentsMd);
  const fakeProcessHome = fs.mkdtempSync(path.join(os.tmpdir(), "doppler-setup-user-"));
  if (globalAgentsMd !== null) {
    fs.mkdirSync(path.join(fakeProcessHome, ".config", "opencode"), { recursive: true });
    fs.writeFileSync(path.join(fakeProcessHome, ".config", "opencode", "AGENTS.md"), globalAgentsMd);
  }
  return { home, fakeProcessHome };
}

async function withRoot(spec, fn) {
  const { home, fakeProcessHome } = rootWith(spec);
  const prev = {
    DOPPLER_HOME: process.env.DOPPLER_HOME,
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };
  process.env.DOPPLER_HOME = home;
  process.env.HOME = fakeProcessHome;
  process.env.XDG_CONFIG_HOME = path.join(fakeProcessHome, ".config");
  try {
    return await fn(home);
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(fakeProcessHome, { recursive: true, force: true });
  }
}

// The host context, recorded: every registration lands in `captured`, every
// editor add in `added`. event.subscribe returns an iterator that ends on
// abort, so setup's void'd loop settles when cleanup runs.
function mockCtx() {
  const captured = { toolBefore: null, evaluate: null, context: null, eventSubscribed: false };
  const added = { agents: [], skills: [] };
  const existing = new Set();
  return {
    captured,
    added,
    existing,
    agent: {
      transform: async (cb) => cb({ list: () => [], get: (id) => (existing.has(id) ? { id } : undefined), add: (i) => added.agents.push(i) }),
    },
    permission: {
      hook: async (name, cb) => {
        if (name === "evaluate") captured.evaluate = cb;
      },
    },
    skill: {
      transform: async (cb) => cb({ add: (s) => added.skills.push(s) }),
    },
    session: {
      hook: async (name, cb) => {
        if (name === "context") captured.context = cb;
      },
    },
    tool: {
      hook: async (name, cb) => {
        if (name === "execute.before") captured.toolBefore = cb;
      },
    },
    event: {
      subscribe: ({ signal } = {}) => {
        captured.eventSubscribed = true;
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () =>
                new Promise((resolve) => {
                  signal?.addEventListener("abort", () => resolve({ done: true, value: undefined }));
                }),
              return: async () => ({ done: true, value: undefined }),
            };
          },
        };
      },
    },
  };
}

test("the default export leads with setup and keeps server as the legacy path", () => {
  assert.equal(dopplerDefault.id, "doppler");
  assert.equal(typeof dopplerDefault.server, "function");
  assert.equal(dopplerDefault.setup, setup);
});

test("setup registers enforcement and the event subscription, and cleanup aborts", async () => {
  await withRoot({}, async () => {
    const ctx = mockCtx();
    const cleanup = await setup(ctx);
    assert.equal(typeof ctx.captured.toolBefore, "function", "execute.before registered");
    assert.equal(ctx.captured.eventSubscribed, true, "event subscription opened");
    assert.equal(typeof cleanup, "function");
    cleanup(); // must not throw; aborts the subscription loop
  });
});

test("a deny hook still stops a tool call through the entry", async () => {
  const denyHook = `#!/usr/bin/env node
import fs from "node:fs";
const payload = JSON.parse(fs.readFileSync(0, "utf8"));
process.stdout.write(JSON.stringify({ decision: "deny", reason: "hook says deny" }));
`;
  await withRoot({ hooks: {} }, async (home) => {
    fs.writeFileSync(path.join(home, "hooks", "deny.mjs"), denyHook);
    const ctx = mockCtx();
    await setup(ctx);
    assert.throws(
      () => ctx.captured.toolBefore({ tool: "bash", sessionID: "ses_1", input: { command: "ls" } }),
      /hook says deny/
    );
  });
});

test("with no hooks, enforcement is silent", async () => {
  await withRoot({}, async () => {
    const ctx = mockCtx();
    await setup(ctx);
    ctx.captured.toolBefore({ tool: "bash", sessionID: "ses_1", input: { command: "ls" } }); // must not throw
  });
});

test("the evaluate hook applies allowlist effects with last-match-wins", async () => {
  const allowlist = JSON.stringify({
    tools: { allow: ["webfetch"] },
    ask: [{ pattern: "rm -rf *" }],
    deny: [{ pattern: "rm -rf /" }],
  });
  await withRoot({ policy: { "allowlist.json": allowlist } }, async () => {
    const ctx = mockCtx();
    await setup(ctx);
    assert.equal(typeof ctx.captured.evaluate, "function", "evaluate registered");

    // tool allow, no pattern
    let ev = { action: "webfetch", resources: ["https://x.test"], effect: "deny" };
    ctx.captured.evaluate(ev);
    assert.equal(ev.effect, "allow");

    // bash pattern: ask wins over the untouched default
    ev = { action: "bash", resources: ["rm -rf /tmp/x"], effect: "allow" };
    ctx.captured.evaluate(ev);
    assert.equal(ev.effect, "ask");

    // deny outranks the overlapping ask (last match wins)
    ev = { action: "shell", resources: ["rm -rf /"], effect: "allow" };
    ctx.captured.evaluate(ev);
    assert.equal(ev.effect, "deny");

    // no doppler rule: the host's own decision stands
    ev = { action: "bash", resources: ["ls -la"], effect: "ask" };
    ctx.captured.evaluate(ev);
    assert.equal(ev.effect, "ask");
  });
});

test("personal agents are added with system prompts", async () => {
  const agentMd = `---
description: Reviews diffs
mode: subagent
---
Review the diff carefully.
`;
  await withRoot({}, async (home) => {
    fs.writeFileSync(path.join(home, "agents", "reviewer.md"), agentMd);
    const ctx = mockCtx();
    await setup(ctx);
    assert.equal(ctx.added.agents.length, 1, "one personal agent added");
    const a = ctx.added.agents[0];
    assert.equal(a.id, "doppler-reviewer");
    assert.equal(a.name, "doppler-reviewer");
    assert.match(a.system, /Review the diff carefully/);
    assert.equal(a.description, "Reviews diffs");
    assert.equal(a.mode, "subagent");
    assert.deepEqual(a.permissions, []);
  });
});

test("the root AGENTS.md is appended to every request when the user has none", async () => {
  await withRoot({ agentsMd: "Personal standing instructions." }, async () => {
    const ctx = mockCtx();
    await setup(ctx);
    assert.equal(typeof ctx.captured.context, "function", "context hook registered");
    const system = [];
    ctx.captured.context({ sessionID: "ses_1", system });
    assert.equal(system.length, 1);
    assert.equal(system[0].text, "Personal standing instructions.");
  });
});

test("a global AGENTS.md suppresses the root's, same precedence as V1", async () => {
  await withRoot({ agentsMd: "root wins?", globalAgentsMd: "user wins." }, async () => {
    const ctx = mockCtx();
    await setup(ctx);
    assert.equal(ctx.captured.context, null, "no context hook when the user has global instructions");
  });
});

test("skills are discovered from their roots with frontmatter names", async () => {
  const skill = `---
name: review
description: Review the diff for correctness
---
Skill body.
`;
  await withRoot({ skills: { review: skill } }, async () => {
    const ctx = mockCtx();
    await setup(ctx);
    assert.equal(ctx.added.skills.length, 1);
    const s = ctx.added.skills[0];
    assert.equal(s.id, "review");
    assert.equal(s.name, "review");
    assert.equal(s.description, "Review the diff for correctness");
    assert.match(s.content, /Skill body\./);
    assert.ok(String(s.path).endsWith(path.join("review", "SKILL.md")));
  });
});
