// Tests for the OpenCode 2 entry (opencode/doppler.ts → dist/v2/index.js).
//
// V2 replaced the returned-hooks object with per-domain registration, so what a
// V1 test can assert (a returned map of hooks) no longer exists. These tests
// drive setup() against a recording context and assert the four surfaces the
// port must keep: skills, permission rules, standing instructions, and the
// pre-tool hook that enforces policy.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const ENTRY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "v2",
  "index.js",
);

function rootWith({ allowlist, skills = {}, agentsMd, hooks = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "doppler-v2-"));
  for (const [name, body] of Object.entries(skills)) {
    const dir = path.join(home, "skills", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), body);
  }
  for (const [name, body] of Object.entries(hooks)) {
    fs.mkdirSync(path.join(home, "hooks"), { recursive: true });
    fs.writeFileSync(path.join(home, "hooks", name), body);
  }
  if (allowlist) {
    fs.mkdirSync(path.join(home, "policy"), { recursive: true });
    fs.writeFileSync(path.join(home, "policy", "allowlist.json"), JSON.stringify(allowlist));
  }
  if (agentsMd) fs.writeFileSync(path.join(home, "AGENTS.md"), agentsMd);

  // The global AGENTS.md silences the root's, so point XDG_CONFIG_HOME at an
  // empty directory for the same isolation the loader tests get from HOME.
  const configHome = path.join(home, "xdg");
  fs.mkdirSync(configHome, { recursive: true });

  const previous = {
    DOPPLER_HOME: process.env.DOPPLER_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };
  process.env.DOPPLER_HOME = home;
  process.env.XDG_CONFIG_HOME = configHome;
  return {
    home,
    cleanup() {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

function recordingContext() {
  const calls = { skills: [], permission: [], contexts: [], tools: [] };
  let subscribed = 0;
  const ctx = {
    skill: {
      async transform(callback) {
        callback({ list: () => [], get: () => undefined, add: (skill) => calls.skills.push(skill) });
        return { dispose() {} };
      },
      async reload() {},
    },
    permission: {
      async hook(_name, callback) {
        calls.permission.push(callback);
        return { dispose() {} };
      },
    },
    session: {
      async hook(_name, callback) {
        calls.contexts.push(callback);
        return { dispose() {} };
      },
    },
    tool: {
      async hook(_name, callback) {
        calls.tools.push(callback);
        return { dispose() {} };
      },
    },
    event: {
      subscribe() {
        subscribed += 1;
        return (async function* () {})();
      },
    },
  };
  return { ctx, calls, subscriptions: () => subscribed };
}

async function loadEntry() {
  return import(pathToFileURL(ENTRY).href);
}

test("the v2 directory entry keeps the id and both entrypoints", async () => {
  const mod = await loadEntry();
  assert.equal(mod.default.id, "doppler");
  assert.equal(typeof mod.default.setup, "function");
  assert.equal(typeof mod.default.server, "function");
});

test("skills in the personal root are registered with their frontmatter", async () => {
  const root = rootWith({
    skills: {
      review: "---\nname: Review\ndescription: Review the current changes\n---\nCheck correctness.\n",
    },
  });
  const { ctx, calls } = recordingContext();
  let cleanup;
  try {
    cleanup = await (await loadEntry()).default.setup(ctx);
  } finally {
    await cleanup?.();
    root.cleanup();
  }
  assert.equal(calls.skills.length, 1);
  assert.equal(calls.skills[0].id, "review");
  assert.equal(calls.skills[0].name, "Review");
  assert.equal(calls.skills[0].description, "Review the current changes");
  assert.match(calls.skills[0].content, /Check correctness/);
});

test("deny and ask rules reach the v2 permission hook, and allow does not widen", async () => {
  const root = rootWith({
    allowlist: {
      deny: [{ pattern: "*sudo *" }],
      ask: [{ pattern: "*git push*" }],
    },
  });
  const { ctx, calls } = recordingContext();
  let cleanup;
  try {
    cleanup = await (await loadEntry()).default.setup(ctx);
    assert.equal(calls.permission.length, 1);
    const evaluate = calls.permission[0];

    const denied = { action: "shell", resources: ["sudo rm -rf /"], effect: "allow" };
    evaluate(denied);
    assert.equal(denied.effect, "deny");

    const asked = { action: "shell", resources: ["git push origin main"], effect: "allow" };
    evaluate(asked);
    assert.equal(asked.effect, "ask");

    const untouched = { action: "shell", resources: ["ls -la"], effect: "allow" };
    evaluate(untouched);
    assert.equal(untouched.effect, "allow");
  } finally {
    await cleanup?.();
    root.cleanup();
  }
});

test("the root AGENTS.md is appended to the system parts exactly once", async () => {
  const root = rootWith({ agentsMd: "Always answer in Portuguese.\n" });
  const { ctx, calls } = recordingContext();
  let cleanup;
  try {
    cleanup = await (await loadEntry()).default.setup(ctx);
    assert.equal(calls.contexts.length, 1);
    const context = calls.contexts[0];

    const system = [];
    context({ system });
    context({ system });
    assert.equal(system.length, 1);
    assert.equal(system[0].type, "text");
    assert.match(system[0].text, /Portuguese/);
  } finally {
    await cleanup?.();
    root.cleanup();
  }
});

test("a deny from a policy hook stops the v2 tool call", async () => {
  const root = rootWith({
    hooks: {
      "deny.mjs": `import fs from "node:fs";
const payload = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
if (payload.tool === "bash") {
  process.stdout.write(JSON.stringify({ decision: "deny", reason: "no shell" }));
}
`,
    },
  });
  const { ctx, calls } = recordingContext();
  let cleanup;
  try {
    cleanup = await (await loadEntry()).default.setup(ctx);
    assert.equal(calls.tools.length, 1);
    const before = calls.tools[0];
    assert.throws(
      () => before({ tool: "bash", sessionID: "ses_test", input: { command: "ls" } }),
      /no shell/,
    );
    assert.doesNotThrow(() => before({ tool: "read", sessionID: "ses_test", input: {} }));
  } finally {
    await cleanup?.();
    root.cleanup();
  }
});

test("setup subscribes once and cleanup is idempotent enough to run", async () => {
  const root = rootWith();
  const { ctx, subscriptions } = recordingContext();
  const cleanup = await (await loadEntry()).default.setup(ctx);
  try {
    assert.equal(subscriptions(), 1);
    assert.equal(typeof cleanup, "function");
  } finally {
    await cleanup();
    root.cleanup();
  }
});
